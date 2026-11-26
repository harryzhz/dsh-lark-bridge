import type { MemoryType } from '../types.js'
import {
  computeGraphNeighborhood,
  type MemoryGraphData,
  type MemoryGraphEdge,
  type MemoryGraphGroupKey,
  type MemoryGraphNode,
  type MemoryGraphSettings,
} from './memory-graph-model.js'

export type RgbTuple = readonly [number, number, number]

export interface GraphThemePalette {
  readonly isDark: boolean
  readonly canvasBg: RgbTuple
  readonly accent: RgbTuple
  readonly tagNode: RgbTuple
  readonly labelPrimary: RgbTuple
  readonly labelSecondary: RgbTuple
  readonly labelTertiary: RgbTuple
  readonly fontFamily: string
  readonly types: Readonly<Record<MemoryType, RgbTuple>>
}

export interface GraphSimNode {
  readonly id: string
  readonly node: MemoryGraphNode
  readonly degree: number
  readonly baseRadius: number
  readonly phase: number
  x: number
  y: number
  vx: number
  vy: number
  visAlpha: number
  labelAlpha: number
  scaleAnim: number
  glowAnim: number
}

export interface GraphCamera {
  x: number
  y: number
  scale: number
  tx: number
  ty: number
  tScale: number
}

export interface GraphSpark {
  readonly edge: MemoryGraphEdge
  readonly reverse: boolean
  readonly speed: number
  readonly active: boolean
  t: number
}

export interface GraphBirthRing {
  readonly id: string
  readonly duration: number
  age: number
}

export interface GraphViewport {
  readonly width: number
  readonly height: number
  readonly dpr: number
}

export interface GraphRenderContext {
  readonly ctx: CanvasRenderingContext2D
  readonly viewport: GraphViewport
  readonly palette: GraphThemePalette
  readonly camera: GraphCamera
  readonly settings: MemoryGraphSettings
  readonly simNodes: ReadonlyMap<string, GraphSimNode>
  readonly graph: MemoryGraphData
  readonly selectedId: string | null
  readonly hoveredId: string | null
  readonly groupFilter: MemoryGraphGroupKey | null
  readonly searchMatches: ReadonlySet<string> | null
  readonly draggingNodeId: string | null
  readonly sparks: readonly GraphSpark[]
  readonly birthRings: readonly GraphBirthRing[]
  readonly revealedIds: ReadonlySet<string> | null
  readonly time: number
  readonly dt: number
  readonly reducedMotion: boolean
}

function rgba(rgb: RgbTuple, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, alpha))
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${clamped.toFixed(3)})`
}

function parseCssColor(container: HTMLElement, cssExpr: string, fallback: RgbTuple): RgbTuple {
  if (typeof document === 'undefined') return fallback
  const probe = document.createElement('span')
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.style.pointerEvents = 'none'
  probe.style.color = cssExpr
  container.appendChild(probe)
  const resolved = getComputedStyle(probe).color
  probe.remove()
  const match = resolved.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (!match) return fallback
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Resolves all Canvas2D colors dynamically from active `--dsw-*` design tokens.
 * Detects dark vs light surface luminance automatically with zero hardcoded theme hex colors.
 */
export function readGraphThemePalette(container: HTMLElement): GraphThemePalette {
  const cs = getComputedStyle(container)
  const bg = parseCssColor(container, 'var(--dsw-alias-bg-base)', [255, 255, 255])
  const luminance = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]
  const isDark = luminance < 128
  const labelPrimary = parseCssColor(container, 'var(--dsw-alias-label-primary)', isDark ? [232, 236, 244] : [20, 23, 31])
  const labelSecondary = parseCssColor(container, 'var(--dsw-alias-label-secondary)', isDark ? [154, 163, 178] : [75, 85, 99])
  const labelTertiary = parseCssColor(container, 'var(--dsw-alias-label-tertiary)', isDark ? [100, 110, 130] : [140, 149, 166])
  const doneColor = parseCssColor(container, 'var(--dsw-alias-state-done-primary)', [124, 92, 255])
  const businessColor = parseCssColor(container, 'var(--dsw-alias-state-business-primary)', [59, 102, 245])
  const warnColor = parseCssColor(container, 'var(--dsw-alias-state-warn-primary)', [217, 119, 6])
  const successColor = parseCssColor(container, 'var(--dsw-alias-state-success-primary)', [22, 163, 74])

  return {
    isDark,
    canvasBg: bg,
    accent: doneColor,
    tagNode: labelTertiary,
    labelPrimary,
    labelSecondary,
    labelTertiary,
    fontFamily: cs.fontFamily || 'sans-serif',
    types: {
      feedback: warnColor,
      user: businessColor,
      project: successColor,
      reference: doneColor,
    },
  }
}

export function buildSimNodes(
  graph: MemoryGraphData,
  previous?: ReadonlyMap<string, GraphSimNode>,
): Map<string, GraphSimNode> {
  const degreeMap = new Map<string, number>()
  for (const edge of graph.edges) {
    degreeMap.set(edge.source, (degreeMap.get(edge.source) ?? 0) + 1)
    degreeMap.set(edge.target, (degreeMap.get(edge.target) ?? 0) + 1)
  }

  const next = new Map<string, GraphSimNode>()
  const total = Math.max(1, graph.nodes.length)

  graph.nodes.forEach((node, idx) => {
    const prev = previous?.get(node.id)
    const degree = degreeMap.get(node.id) ?? 0
    const isTag = node.nodeKind === 'tag'
    const isHist = !isTag && node.entry?.status !== 'active'
    const isPinned = !isTag && Boolean(node.entry?.pinned && node.entry.status === 'active')
    const recallCount = node.entry?.recallCount ?? 0

    const baseRadius = isTag
      ? Math.min(6.2, 3.3 + Math.sqrt(degree) * 0.95)
      : isHist
        ? 3.8
        : Math.min(9.5, 4.4 + Math.sqrt(degree) * 1.15 + (isPinned ? 1.8 : 0) + Math.log1p(recallCount) * 0.42)

    const golden = idx * 2.399963229728653
    const radius = 36 + Math.sqrt(idx / total) * 250

    next.set(node.id, {
      id: node.id,
      node,
      degree,
      baseRadius,
      phase: prev ? prev.phase : idx * 1.618,
      x: prev ? prev.x : Math.cos(golden) * radius * 1.24,
      y: prev ? prev.y : Math.sin(golden) * radius * 0.9,
      vx: prev ? prev.vx * 0.15 : 0,
      vy: prev ? prev.vy * 0.15 : 0,
      visAlpha: prev ? prev.visAlpha : 1,
      labelAlpha: prev ? prev.labelAlpha : 0.7,
      scaleAnim: prev ? prev.scaleAnim : 1,
      glowAnim: prev ? prev.glowAnim : 0,
    })
  })

  return next
}

export function stepGraphPhysics(input: {
  readonly simNodes: ReadonlyMap<string, GraphSimNode>
  readonly edges: readonly MemoryGraphEdge[]
  readonly settings: MemoryGraphSettings
  readonly alpha: number
  readonly draggingNodeId: string | null
  readonly warmup: boolean
}): void {
  const nodes = Array.from(input.simNodes.values())
  const count = nodes.length
  if (count === 0) return

  const alpha = input.warmup ? 0.85 : Math.max(0.025, input.alpha)
  const repelK = 4600 * input.settings.repelForce
  const centerK = 0.014 * input.settings.centerForce
  const linkIdeal = input.settings.linkDist

  for (let i = 0; i < count; i++) {
    const a = nodes[i]!
    for (let j = i + 1; j < count; j++) {
      const b = nodes[j]!
      const dx = b.x - a.x
      const dy = b.y - a.y
      const distSq = dx * dx + dy * dy + 16
      const dist = Math.sqrt(distSq)
      const hubBoost = (a.degree >= 4 ? 1.2 : 1) * (b.degree >= 4 ? 1.2 : 1)
      const force = ((repelK * hubBoost) / distSq) * alpha
      const fx = (dx / dist) * force * 1.12
      const fy = (dy / dist) * force * 0.94
      if (input.draggingNodeId !== a.id) {
        a.vx -= fx
        a.vy -= fy
      }
      if (input.draggingNodeId !== b.id) {
        b.vx += fx
        b.vy += fy
      }
    }
  }

  for (const edge of input.edges) {
    const a = input.simNodes.get(edge.source)
    const b = input.simNodes.get(edge.target)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.sqrt(dx * dx + dy * dy) || 1
    const targetDist =
      edge.kind === 'supersede'
        ? linkIdeal * 0.62
        : edge.kind === 'tag'
          ? linkIdeal * 0.84
          : linkIdeal * 1.18
    const stiffness = (edge.kind === 'supersede' ? 0.06 : edge.kind === 'tag' ? 0.038 : 0.018) * alpha
    const force = (dist - targetDist) * stiffness
    const fx = (dx / dist) * force
    const fy = (dy / dist) * force
    if (input.draggingNodeId !== a.id) {
      a.vx += fx
      a.vy += fy
    }
    if (input.draggingNodeId !== b.id) {
      b.vx -= fx
      b.vy -= fy
    }
  }

  const damp = input.warmup ? 0.78 : 0.82
  const maxV = input.warmup ? 22 : 14
  for (const n of nodes) {
    if (input.draggingNodeId === n.id) {
      n.vx = 0
      n.vy = 0
      continue
    }
    n.vx -= n.x * centerK * 0.72 * alpha
    n.vy -= n.y * centerK * 1.18 * alpha
    n.vx *= damp
    n.vy *= damp
    const speed = Math.hypot(n.vx, n.vy)
    if (speed > maxV) {
      n.vx = (n.vx / speed) * maxV
      n.vy = (n.vy / speed) * maxV
    }
    n.x += n.vx
    n.y += n.vy
  }
}

export function worldToScreen(
  wx: number,
  wy: number,
  camera: GraphCamera,
  viewport: GraphViewport,
): { x: number; y: number } {
  return {
    x: (wx - camera.x) * camera.scale + viewport.width * 0.5,
    y: (wy - camera.y) * camera.scale + viewport.height * 0.5,
  }
}

export function screenToWorld(
  sx: number,
  sy: number,
  camera: GraphCamera,
  viewport: GraphViewport,
): { x: number; y: number } {
  return {
    x: (sx - viewport.width * 0.5) / camera.scale + camera.x,
    y: (sy - viewport.height * 0.5) / camera.scale + camera.y,
  }
}

export function fitGraphCamera(
  simNodes: ReadonlyMap<string, GraphSimNode>,
  camera: GraphCamera,
  viewport: GraphViewport,
  drawerWidth: number,
  immediate = false,
): void {
  const nodes = Array.from(simNodes.values())
  if (nodes.length === 0) return
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x - 65)
    maxX = Math.max(maxX, n.x + 65)
    minY = Math.min(minY, n.y - 45)
    maxY = Math.max(maxY, n.y + 45)
  }
  const availW = Math.max(260, viewport.width - drawerWidth - 96)
  const availH = Math.max(240, viewport.height - 90)
  const scale = Math.min(1.28, Math.max(0.45, Math.min(availW / (maxX - minX), availH / (maxY - minY))))
  camera.tScale = scale
  camera.tx = (minX + maxX) * 0.5 + (drawerWidth * 0.5) / scale
  camera.ty = (minY + maxY) * 0.5
  if (immediate) {
    camera.x = camera.tx
    camera.y = camera.ty
    camera.scale = camera.tScale
  }
}

export function focusGraphNode(
  node: GraphSimNode,
  camera: GraphCamera,
  drawerWidth: number,
): void {
  const targetScale = Math.max(1.08, Math.min(1.42, camera.tScale))
  camera.tScale = targetScale
  camera.tx = node.x + (drawerWidth * 0.48) / targetScale
  camera.ty = node.y
}

export function hitTestGraphNode(
  sx: number,
  sy: number,
  simNodes: ReadonlyMap<string, GraphSimNode>,
  camera: GraphCamera,
  viewport: GraphViewport,
  nodeScale: number,
): GraphSimNode | null {
  let best: GraphSimNode | null = null
  let bestDist = Infinity
  for (const n of simNodes.values()) {
    if (n.visAlpha < 0.08) continue
    const sp = worldToScreen(n.x, n.y, camera, viewport)
    const dist = Math.hypot(sx - sp.x, sy - sp.y)
    const hitR = Math.max(12, n.baseRadius * nodeScale * camera.scale + 7)
    if (dist <= hitR && dist < bestDist) {
      best = n
      bestDist = dist
    }
  }
  return best
}

function truncateNodeLabel(text: string, maxLen: number): string {
  const clean = text.replace(/（[^）]*）/g, '').trim()
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean
}

function updateNodeAnimations(
  rc: GraphRenderContext,
  focusId: string | null,
  focusNb: ReturnType<typeof computeGraphNeighborhood> | null,
): Map<string, { x: number; y: number }> {
  const coords = new Map<string, { x: number; y: number }>()
  const lerpRate = rc.reducedMotion ? 1 : Math.min(1, rc.dt * 11)

  for (const n of rc.simNodes.values()) {
    const hiddenByTimelapse = rc.revealedIds !== null && !rc.revealedIds.has(n.id)
    const isFocus = n.id === focusId
    const isNb = focusNb ? focusNb.hop1Nodes.has(n.id) : false
    const isHop2 = focusNb ? focusNb.hop2Nodes.has(n.id) : false
    const isGroupDim = rc.groupFilter !== null && n.node.group !== rc.groupFilter
    const isSearchDim = rc.searchMatches !== null && !rc.searchMatches.has(n.id)
    const isHist = n.node.nodeKind === 'memory' && n.node.entry?.status !== 'active'

    let targetVis = hiddenByTimelapse ? 0 : 1
    if (!hiddenByTimelapse) {
      if (isGroupDim || isSearchDim) targetVis = 0.1
      else if (focusId) targetVis = isFocus || isNb ? 1 : isHop2 ? 0.62 : 0.1
      else if (isHist) targetVis = 0.45
    }

    let targetLabel = 0
    if (!hiddenByTimelapse && targetVis > 0.25) {
      if (isFocus) targetLabel = 1
      else if (isNb) targetLabel = 0.94
      else if (isHop2) targetLabel = 0.68
      else if (rc.searchMatches?.has(n.id)) targetLabel = 0.96
      else {
        const importance =
          n.node.nodeKind === 'tag'
            ? 0.25 + n.degree * 0.08
            : (n.node.entry?.pinned ? 0.5 : 0) + n.degree * 0.085
        const signal = rc.camera.scale + importance - rc.settings.textFadeThreshold
        targetLabel = Math.max(0, Math.min(0.88, signal * 1.45))
        if (isHist && rc.camera.scale < 1.15) targetLabel = 0
      }
    }

    const targetScale = isFocus ? 1.32 : isNb && focusId ? 1.08 : 1
    n.visAlpha += (targetVis - n.visAlpha) * lerpRate
    n.labelAlpha += (targetLabel - n.labelAlpha) * lerpRate
    n.scaleAnim += (targetScale - n.scaleAnim) * lerpRate
    n.glowAnim = Math.max(0, n.glowAnim - rc.dt * 1.2)

    const drift = rc.reducedMotion || rc.draggingNodeId === n.id ? 0 : 0.42
    coords.set(
      n.id,
      worldToScreen(
        n.x + Math.cos(rc.time * 0.45 + n.phase) * drift,
        n.y + Math.sin(rc.time * 0.38 + n.phase) * drift,
        rc.camera,
        rc.viewport,
      ),
    )
  }
  return coords
}

function drawEdgesAndSparks(
  rc: GraphRenderContext,
  coords: ReadonlyMap<string, { x: number; y: number }>,
  focusId: string | null,
  focusNb: ReturnType<typeof computeGraphNeighborhood> | null,
): void {
  const { ctx, palette: pal, settings } = rc
  const baseLineW = 0.85 * settings.lineThickness
  const zoomScale = Math.max(0.72, Math.min(1.28, rc.camera.scale))

  for (const edge of rc.graph.edges) {
    const a = rc.simNodes.get(edge.source)
    const b = rc.simNodes.get(edge.target)
    if (!a || !b) continue
    const pairVis = Math.min(a.visAlpha, b.visAlpha)
    if (pairVis < 0.02) continue

    const pa = coords.get(edge.source)!
    const pb = coords.get(edge.target)!
    const isLit = focusNb ? focusNb.hop1Edges.has(edge.id) : false
    const isHop2Edge = focusNb ? focusNb.hop2Edges.has(edge.id) : false

    ctx.save()
    if (isLit) {
      const edgeCol = edge.kind === 'supersede' ? pal.types.feedback : pal.accent
      ctx.strokeStyle = rgba(edgeCol, pal.isDark ? 0.76 : 0.68)
      ctx.lineWidth = Math.max(1.15, baseLineW * 1.45)
    } else if (isHop2Edge) {
      ctx.strokeStyle = rgba(pal.accent, pal.isDark ? 0.24 : 0.22)
      ctx.lineWidth = baseLineW
    } else {
      const idleAlpha = focusId
        ? 0.035
        : edge.kind === 'supersede'
          ? pal.isDark
            ? 0.34
            : 0.32
          : edge.kind === 'semantic'
            ? pal.isDark
              ? 0.1
              : 0.09
            : pal.isDark
              ? 0.145
              : 0.135
      const baseCol = edge.kind === 'supersede' ? pal.types.feedback : pal.labelPrimary
      ctx.strokeStyle = rgba(baseCol, idleAlpha * pairVis)
      ctx.lineWidth = baseLineW
    }

    if (edge.kind === 'semantic' && !isLit) ctx.setLineDash([2.5, 3.5])
    ctx.beginPath()
    ctx.moveTo(pa.x, pa.y)
    ctx.lineTo(pb.x, pb.y)
    ctx.stroke()

    if (edge.directed && settings.showArrows && (isLit || !focusId)) {
      const dx = pb.x - pa.x
      const dy = pb.y - pa.y
      const len = Math.hypot(dx, dy) || 1
      const rB = b.baseRadius * settings.nodeScale * b.scaleAnim * zoomScale
      const tipX = pb.x - (dx / len) * (rB + 5)
      const tipY = pb.y - (dy / len) * (rB + 5)
      const ang = Math.atan2(dy, dx)
      const sz = isLit ? 5.5 : 4.2
      ctx.setLineDash([])
      ctx.fillStyle = rgba(pal.types.feedback, isLit ? 0.9 : 0.45 * pairVis)
      ctx.beginPath()
      ctx.moveTo(tipX, tipY)
      ctx.lineTo(tipX - sz * Math.cos(ang - 0.48), tipY - sz * Math.sin(ang - 0.48))
      ctx.lineTo(tipX - sz * Math.cos(ang + 0.48), tipY - sz * Math.sin(ang + 0.48))
      ctx.closePath()
      ctx.fill()
    }
    ctx.restore()
  }

  if (!settings.showPulses || rc.reducedMotion) return
  for (const s of rc.sparks) {
    if (s.t < 0 || s.t > 1) continue
    const a = rc.simNodes.get(s.edge.source)
    const b = rc.simNodes.get(s.edge.target)
    if (!a || !b || Math.min(a.visAlpha, b.visAlpha) < 0.15) continue
    if (focusId && focusNb && !focusNb.hop1Edges.has(s.edge.id)) continue

    const pa = coords.get(s.edge.source)!
    const pb = coords.get(s.edge.target)!
    const u = s.reverse ? 1 - s.t : s.t
    const uTail = s.reverse ? Math.min(1, u + 0.12) : Math.max(0, u - 0.12)
    const hx = pa.x + (pb.x - pa.x) * u
    const hy = pa.y + (pb.y - pa.y) * u
    const tx = pa.x + (pb.x - pa.x) * uTail
    const ty = pa.y + (pb.y - pa.y) * uTail
    const col = s.edge.kind === 'supersede' ? pal.types.feedback : pal.accent
    const fade = Math.sin(s.t * Math.PI) * (s.active ? 0.92 : 0.55)

    const grad = ctx.createLinearGradient(tx, ty, hx, hy)
    grad.addColorStop(0, rgba(col, 0))
    grad.addColorStop(1, rgba(col, fade))
    ctx.strokeStyle = grad
    ctx.lineWidth = s.active ? 1.6 : 1.15
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(tx, ty)
    ctx.lineTo(hx, hy)
    ctx.stroke()

    ctx.fillStyle = pal.isDark ? rgba(pal.labelPrimary, fade) : rgba(col, fade)
    ctx.beginPath()
    ctx.arc(hx, hy, s.active ? 1.9 : 1.4, 0, Math.PI * 2)
    ctx.fill()
  }
}

function drawGraphNodes(
  rc: GraphRenderContext,
  coords: ReadonlyMap<string, { x: number; y: number }>,
): void {
  const { ctx, palette: pal, settings } = rc
  const zoomScale = Math.max(0.72, Math.min(1.28, rc.camera.scale))

  for (const r of rc.birthRings) {
    const sp = coords.get(r.id)
    const n = rc.simNodes.get(r.id)
    if (!sp || !n) continue
    const k = r.age / r.duration
    const rad = (n.baseRadius + 24 * (1 - Math.pow(1 - k, 3))) * rc.camera.scale
    ctx.strokeStyle = rgba(pal.accent, (1 - k) * 0.45)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(sp.x, sp.y, rad, 0, Math.PI * 2)
    ctx.stroke()
  }

  for (const n of rc.simNodes.values()) {
    if (n.visAlpha < 0.02) continue
    const sp = coords.get(n.id)!
    const r = n.baseRadius * settings.nodeScale * n.scaleAnim * zoomScale
    const isSelected = n.id === rc.selectedId
    const isHovered = n.id === rc.hoveredId
    const isTag = n.node.nodeKind === 'tag'
    const isHist = !isTag && n.node.entry?.status !== 'active'
    const isPinned = !isTag && Boolean(n.node.entry?.pinned && !isHist)
    const color = isTag ? pal.tagNode : pal.types[n.node.entry!.type]

    ctx.save()
    ctx.globalAlpha = n.visAlpha

    if (isHovered || isSelected || n.glowAnim > 0.05) {
      const strength = isSelected || isHovered ? 0.24 : n.glowAnim * 0.22
      const haloR = r * 2.5
      const halo = ctx.createRadialGradient(sp.x, sp.y, r * 0.5, sp.x, sp.y, haloR)
      halo.addColorStop(0, rgba(isHovered || isSelected ? pal.accent : color, strength))
      halo.addColorStop(1, rgba(color, 0))
      ctx.fillStyle = halo
      ctx.beginPath()
      ctx.arc(sp.x, sp.y, haloR, 0, Math.PI * 2)
      ctx.fill()
    }

    if (isTag) {
      ctx.fillStyle = rgba(pal.canvasBg, 0.92)
      ctx.beginPath()
      ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = isHovered || isSelected ? rgba(pal.accent, 0.95) : rgba(pal.tagNode, pal.isDark ? 0.78 : 0.72)
      ctx.lineWidth = isHovered || isSelected ? 1.6 : 1.2
      ctx.stroke()
      ctx.fillStyle = isHovered || isSelected ? rgba(pal.accent, 0.9) : rgba(pal.tagNode, 0.65)
      ctx.beginPath()
      ctx.arc(sp.x, sp.y, r * 0.34, 0, Math.PI * 2)
      ctx.fill()
    } else if (isHist) {
      ctx.fillStyle = rgba(pal.canvasBg, 0.9)
      ctx.beginPath()
      ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = rgba(color, 0.75)
      ctx.lineWidth = 1.2
      ctx.setLineDash([2, 2])
      ctx.stroke()
      ctx.setLineDash([])
    } else {
      ctx.fillStyle = isHovered ? rgba(pal.accent, 1) : rgba(color, 0.95)
      ctx.beginPath()
      ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2)
      ctx.fill()
      if (isPinned) {
        ctx.strokeStyle = rgba(color, pal.isDark ? 0.52 : 0.45)
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(sp.x, sp.y, r + 3.2, 0, Math.PI * 2)
        ctx.stroke()
      }
    }

    if (isSelected) {
      ctx.strokeStyle = rgba(pal.accent, 0.92)
      ctx.lineWidth = 1.6
      ctx.beginPath()
      ctx.arc(sp.x, sp.y, r + (isPinned ? 6.2 : 4.2), 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.restore()
  }
}

function drawGraphLabels(
  rc: GraphRenderContext,
  coords: ReadonlyMap<string, { x: number; y: number }>,
): void {
  const { ctx, palette: pal, settings, viewport } = rc
  const zoomScale = Math.max(0.72, Math.min(1.28, rc.camera.scale))
  const placed: Array<{ x1: number; y1: number; x2: number; y2: number; owner: string }> = []
  for (const nd of rc.simNodes.values()) {
    if (nd.visAlpha < 0.35) continue
    const p = coords.get(nd.id)!
    const nr = nd.baseRadius * settings.nodeScale * zoomScale + 3
    placed.push({ x1: p.x - nr, y1: p.y - nr, x2: p.x + nr, y2: p.y + nr, owner: nd.id })
  }

  const labelList = Array.from(rc.simNodes.values())
    .filter((n) => n.labelAlpha > 0.04)
    .sort((a, b) => {
      const pa = (a.id === rc.hoveredId ? 2000 : 0) + (a.id === rc.selectedId ? 1500 : 0) + a.labelAlpha * 100 + a.degree * 10
      const pb = (b.id === rc.hoveredId ? 2000 : 0) + (b.id === rc.selectedId ? 1500 : 0) + b.labelAlpha * 100 + b.degree * 10
      return pb - pa
    })

  for (const n of labelList) {
    const sp = coords.get(n.id)!
    const isFocus = n.id === rc.hoveredId || n.id === rc.selectedId
    const isTag = n.node.nodeKind === 'tag'
    const r = n.baseRadius * settings.nodeScale * n.scaleAnim * zoomScale
    const text = isTag ? n.node.label : truncateNodeLabel(n.node.label, isFocus ? 28 : 15)
    const fontSize = isFocus ? 12.5 : isTag ? 11 : 11.5
    ctx.font = `${isFocus ? 600 : isTag ? 500 : 400} ${fontSize}px ${pal.fontFamily}`
    const tw = ctx.measureText(text).width
    const rawTx = sp.x
    const tx = isFocus
      ? Math.max(tw * 0.5 + 12, Math.min(viewport.width - tw * 0.5 - 12, rawTx))
      : rawTx
    const ty = sp.y + r + 12

    if (tx + tw * 0.5 < 0 || tx - tw * 0.5 > viewport.width || ty < 0 || ty > viewport.height) continue

    const rect = { x1: tx - tw * 0.5 - 5, y1: ty - 7, x2: tx + tw * 0.5 + 5, y2: ty + 7, owner: n.id }
    if (!isFocus) {
      const collides = placed.some(
        (p) => p.owner !== n.id && !(rect.x2 < p.x1 || rect.x1 > p.x2 || rect.y2 < p.y1 || rect.y1 > p.y2),
      )
      if (collides) continue
    }
    placed.push(rect)

    ctx.save()
    ctx.globalAlpha = n.labelAlpha
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineWidth = 3.2
    ctx.lineJoin = 'round'
    ctx.strokeStyle = rgba(pal.canvasBg, 0.88)
    ctx.strokeText(text, tx, ty)
    ctx.fillStyle = isFocus
      ? rgba(pal.labelPrimary, 1)
      : isTag
        ? rgba(pal.labelTertiary, 0.92)
        : rgba(pal.labelSecondary, 0.95)
    ctx.fillText(text, tx, ty)
    ctx.restore()
  }
}

export function renderGraphFrame(rc: GraphRenderContext): void {
  const { ctx, viewport, camera, dt, reducedMotion } = rc
  const camLerp = reducedMotion ? 1 : Math.min(1, dt * 8.5)
  camera.x += (camera.tx - camera.x) * camLerp
  camera.y += (camera.ty - camera.y) * camLerp
  camera.scale += (camera.tScale - camera.scale) * camLerp

  const focusId = rc.hoveredId ?? rc.selectedId
  const focusNb = focusId ? computeGraphNeighborhood(focusId, rc.graph.nodes, rc.graph.edges) : null
  const coords = updateNodeAnimations(rc, focusId, focusNb)

  ctx.save()
  ctx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0)
  ctx.clearRect(0, 0, viewport.width, viewport.height)
  drawEdgesAndSparks(rc, coords, focusId, focusNb)
  drawGraphNodes(rc, coords)
  drawGraphLabels(rc, coords)
  ctx.restore()
}
