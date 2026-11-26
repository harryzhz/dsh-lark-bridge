import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconPlayOutlineRegular,
  IconPlusOutlineRegular,
  IconSettingsOutlineRegular,
  Switch,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { BotRecord, GroupView, MemoryEntry } from '../types.js'
import {
  buildSimNodes,
  fitGraphCamera,
  focusGraphNode,
  hitTestGraphNode,
  readGraphThemePalette,
  renderGraphFrame,
  screenToWorld,
  stepGraphPhysics,
  type GraphBirthRing,
  type GraphCamera,
  type GraphSimNode,
  type GraphSpark,
  type GraphThemePalette,
  type GraphViewport,
} from './memory-graph-engine.js'
import {
  buildMemoryGraph,
  collectMemoryLinkedItems,
  DEFAULT_MEMORY_GRAPH_SETTINGS,
  GRAPH_GROUP_ORDER,
  matchGraphSearch,
  type MemoryGraphData,
  type MemoryGraphGroupKey,
  type MemoryGraphSettings,
  type MemoryLinkedItem,
} from './memory-graph-model.js'
import { MEMORY_TYPE_META } from './memory-model.js'

const DRAWER_WIDTH_PX = 440

function FitViewportIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" aria-hidden="true">
      <path d="M2.5 5.5V3a.5.5 0 0 1 .5-.5h2.5M10.5 2.5H13a.5.5 0 0 1 .5.5v2.5M13.5 10.5V13a.5.5 0 0 1-.5.5h-2.5M5.5 13.5H3a.5.5 0 0 1-.5-.5v-2.5" />
    </svg>
  )
}

interface GraphSettingsPanelProps {
  readonly settings: MemoryGraphSettings
  readonly onUpdateSettings: (patch: Partial<MemoryGraphSettings>, reheat?: boolean) => void
  readonly groupCounts: Readonly<Record<MemoryGraphGroupKey, number>>
  readonly groupFilter: MemoryGraphGroupKey | null
  readonly onToggleGroup: (group: MemoryGraphGroupKey) => void
}

function GraphSettingsPanel({
  settings,
  onUpdateSettings,
  groupCounts,
  groupFilter,
  onToggleGroup,
}: GraphSettingsPanelProps) {
  const [openSec, setOpenSec] = useState({ filters: true, groups: true, display: true, forces: false })
  const toggleSec = (key: keyof typeof openSec) => setOpenSec((prev) => ({ ...prev, [key]: !prev[key] }))

  return (
    <div className="fb-mem-graph-panel" role="region" aria-label="图谱设置">
      <div className="fb-mem-graph-acc">
        <button type="button" className="fb-mem-graph-acc-head" aria-expanded={openSec.filters} onClick={() => toggleSec('filters')}>
          <span>筛选</span>
          {openSec.filters ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />}
        </button>
        {openSec.filters && (
          <div className="fb-mem-graph-acc-body">
            <div className="fb-mem-graph-toggle-row">
              <span>标签枢纽 (#tag)</span>
              <Switch label="显示标签枢纽" checked={settings.showTags} onChange={(showTags) => onUpdateSettings({ showTags }, true)} />
            </div>
            <div className="fb-mem-graph-toggle-row">
              <span>历史演进 (已纠偏)</span>
              <Switch label="显示历史演进" checked={settings.showHistory} onChange={(showHistory) => onUpdateSettings({ showHistory }, true)} />
            </div>
            <div className="fb-mem-graph-toggle-row">
              <span>语义共词连线</span>
              <Switch label="显示语义共词连线" checked={settings.showSemantic} onChange={(showSemantic) => onUpdateSettings({ showSemantic }, true)} />
            </div>
            <div className="fb-mem-graph-toggle-row">
              <span>仅看核心置顶</span>
              <Switch label="仅看核心置顶" checked={settings.pinnedOnly} onChange={(pinnedOnly) => onUpdateSettings({ pinnedOnly }, true)} />
            </div>
          </div>
        )}
      </div>

      <div className="fb-mem-graph-acc">
        <button type="button" className="fb-mem-graph-acc-head" aria-expanded={openSec.groups} onClick={() => toggleSec('groups')}>
          <span>分组</span>
          {openSec.groups ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />}
        </button>
        {openSec.groups && (
          <div className="fb-mem-graph-acc-body">
            {GRAPH_GROUP_ORDER.map((group) => {
              const label = group === 'tag' ? '标签枢纽' : MEMORY_TYPE_META[group].label
              const active = groupFilter === group
              return (
                <button
                  key={group}
                  type="button"
                  className="fb-mem-graph-group-row"
                  aria-pressed={active}
                  onClick={() => onToggleGroup(group)}
                >
                  <span className="fb-mem-graph-group-left">
                    {group === 'tag' ? (
                      <span className="fb-mem-graph-tag-dot" aria-hidden="true" />
                    ) : (
                      <span className="fb-mem-type-dot" data-type={group} aria-hidden="true" />
                    )}
                    <span>{label}</span>
                  </span>
                  <span className="fb-num">{groupCounts[group]}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className="fb-mem-graph-acc">
        <button type="button" className="fb-mem-graph-acc-head" aria-expanded={openSec.display} onClick={() => toggleSec('display')}>
          <span>显示</span>
          {openSec.display ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />}
        </button>
        {openSec.display && (
          <div className="fb-mem-graph-acc-body">
            <div className="fb-mem-graph-toggle-row">
              <span>演进方向箭头</span>
              <Switch label="显示演进方向箭头" checked={settings.showArrows} onChange={(showArrows) => onUpdateSettings({ showArrows })} />
            </div>
            <div className="fb-mem-graph-toggle-row">
              <span>突触微光脉冲</span>
              <Switch label="显示突触微光脉冲" checked={settings.showPulses} onChange={(showPulses) => onUpdateSettings({ showPulses })} />
            </div>
            <label className="fb-mem-graph-slider">
              <div className="fb-mem-graph-slider-head">
                <span>文字淡出阈值</span>
                <span className="fb-num">{settings.textFadeThreshold.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min="0.4"
                max="1.6"
                step="0.05"
                value={settings.textFadeThreshold}
                onChange={(e) => onUpdateSettings({ textFadeThreshold: Number(e.target.value) })}
              />
            </label>
            <label className="fb-mem-graph-slider">
              <div className="fb-mem-graph-slider-head">
                <span>节点尺寸</span>
                <span className="fb-num">{settings.nodeScale.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min="0.7"
                max="1.5"
                step="0.05"
                value={settings.nodeScale}
                onChange={(e) => onUpdateSettings({ nodeScale: Number(e.target.value) })}
              />
            </label>
            <label className="fb-mem-graph-slider">
              <div className="fb-mem-graph-slider-head">
                <span>连线粗细</span>
                <span className="fb-num">{settings.lineThickness.toFixed(1)}</span>
              </div>
              <input
                type="range"
                min="0.5"
                max="2.0"
                step="0.1"
                value={settings.lineThickness}
                onChange={(e) => onUpdateSettings({ lineThickness: Number(e.target.value) })}
              />
            </label>
          </div>
        )}
      </div>

      <div className="fb-mem-graph-acc">
        <button type="button" className="fb-mem-graph-acc-head" aria-expanded={openSec.forces} onClick={() => toggleSec('forces')}>
          <span>力场</span>
          {openSec.forces ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />}
        </button>
        {openSec.forces && (
          <div className="fb-mem-graph-acc-body">
            <label className="fb-mem-graph-slider">
              <div className="fb-mem-graph-slider-head">
                <span>向心力</span>
                <span className="fb-num">{settings.centerForce.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min="0.15"
                max="1.2"
                step="0.05"
                value={settings.centerForce}
                onChange={(e) => onUpdateSettings({ centerForce: Number(e.target.value) }, true)}
              />
            </label>
            <label className="fb-mem-graph-slider">
              <div className="fb-mem-graph-slider-head">
                <span>排斥力</span>
                <span className="fb-num">{settings.repelForce.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min="0.4"
                max="2.0"
                step="0.05"
                value={settings.repelForce}
                onChange={(e) => onUpdateSettings({ repelForce: Number(e.target.value) }, true)}
              />
            </label>
            <label className="fb-mem-graph-slider">
              <div className="fb-mem-graph-slider-head">
                <span>连线距离</span>
                <span className="fb-num">{Math.round(settings.linkDist)}</span>
              </div>
              <input
                type="range"
                min="65"
                max="200"
                step="5"
                value={settings.linkDist}
                onChange={(e) => onUpdateSettings({ linkDist: Number(e.target.value) }, true)}
              />
            </label>
          </div>
        )}
      </div>
    </div>
  )
}

export interface MemoryGraphViewProps {
  readonly entries: readonly MemoryEntry[]
  readonly botsById: ReadonlyMap<string, BotRecord>
  readonly groups: readonly GroupView[]
  readonly query: string
  readonly selectedEntryId: string | null
  readonly loading: boolean
  readonly onSelectEntryId: (id: string | null) => void
  readonly onCreate: () => void
  readonly renderDrawerReader: (entry: MemoryEntry, linkedItems: readonly MemoryLinkedItem[]) => ReactNode
}

export function MemoryGraphView({
  entries,
  botsById,
  groups,
  query,
  selectedEntryId,
  loading,
  onSelectEntryId,
  onCreate,
  renderDrawerReader,
}: MemoryGraphViewProps) {
  const [settings, setSettings] = useState<MemoryGraphSettings>(DEFAULT_MEMORY_GRAPH_SETTINGS)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [groupFilter, setGroupFilter] = useState<MemoryGraphGroupKey | null>(null)
  const [focusedTagId, setFocusedTagId] = useState<string | null>(null)
  const [cursorMode, setCursorMode] = useState<'idle' | 'hover' | 'drag'>('idle')
  const [timelapseUi, setTimelapseUi] = useState<{ active: boolean; current: number; total: number }>({
    active: false,
    current: 0,
    total: 0,
  })

  const stageRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const simNodesRef = useRef<Map<string, GraphSimNode>>(new Map())
  const cameraRef = useRef<GraphCamera>({ x: 0, y: 0, scale: 1, tx: 0, ty: 0, tScale: 1 })
  const viewportRef = useRef<GraphViewport>({ width: 960, height: 560, dpr: 1 })
  const paletteRef = useRef<GraphThemePalette | null>(null)
  const hoveredIdRef = useRef<string | null>(null)
  const alphaRef = useRef(1)
  const timeRef = useRef(0)
  const sparksRef = useRef<GraphSpark[]>([])
  const birthRingsRef = useRef<GraphBirthRing[]>([])
  const dragRef = useRef<{
    active: boolean
    mode: 'node' | 'pan' | null
    nodeId: string | null
    startX: number
    startY: number
    camStartX: number
    camStartY: number
    moved: boolean
  }>({ active: false, mode: null, nodeId: null, startX: 0, startY: 0, camStartX: 0, camStartY: 0, moved: false })
  const timelapseRef = useRef<{
    active: boolean
    progress: number
    order: string[]
    revealed: Set<string>
    lastIdx: number
  }>({ active: false, progress: 1, order: [], revealed: new Set(), lastIdx: -1 })

  const graph: MemoryGraphData = useMemo(
    () =>
      buildMemoryGraph(entries, {
        showTags: settings.showTags,
        showHistory: settings.showHistory,
        showSemantic: settings.showSemantic,
        pinnedOnly: settings.pinnedOnly,
      }),
    [entries, settings.showTags, settings.showHistory, settings.showSemantic, settings.pinnedOnly],
  )

  const searchMatches = useMemo(
    () => matchGraphSearch(graph.nodes, query, botsById, groups),
    [graph.nodes, query, botsById, groups],
  )

  const activeSelectedId = selectedEntryId ?? focusedTagId
  const selectedEntry = useMemo(
    () => (selectedEntryId ? graph.nodes.find((n) => n.id === selectedEntryId)?.entry ?? null : null),
    [graph.nodes, selectedEntryId],
  )
  const drawerOpen = Boolean(selectedEntry)

  const linkedItems = useMemo(
    () => (selectedEntry ? collectMemoryLinkedItems(selectedEntry.id, graph.nodes, graph.edges) : []),
    [selectedEntry, graph.nodes, graph.edges],
  )

  // Live mutable ref mirror so the 60fps RAF loop stays decoupled from React re-renders
  const liveRef = useRef({
    graph,
    settings,
    selectedId: activeSelectedId,
    groupFilter,
    searchMatches,
    drawerOpen,
  })
  liveRef.current = {
    graph,
    settings,
    selectedId: activeSelectedId,
    groupFilter,
    searchMatches,
    drawerOpen,
  }

  const fireSparksFrom = useCallback((nodeId: string, speed = 1.45) => {
    const { settings: curSettings, graph: curGraph } = liveRef.current
    if (!curSettings.showPulses) return
    const edges = curGraph.edges.filter((e) => e.source === nodeId || e.target === nodeId)
    edges.forEach((edge, idx) => {
      sparksRef.current.push({
        edge,
        reverse: edge.target === nodeId,
        t: -(idx * 0.03),
        speed: speed + (idx % 3) * 0.08,
        active: true,
      })
    })
  }, [])

  const handleFitCamera = useCallback((immediate = false) => {
    const drawerW = liveRef.current.drawerOpen ? DRAWER_WIDTH_PX : 0
    fitGraphCamera(simNodesRef.current, cameraRef.current, viewportRef.current, drawerW, immediate)
  }, [])

  const updateSettings = useCallback((patch: Partial<MemoryGraphSettings>, reheat = false) => {
    setSettings((prev) => ({ ...prev, ...patch }))
    if (reheat) alphaRef.current = Math.max(alphaRef.current, 0.72)
  }, [])

  const stopTimelapse = useCallback(() => {
    timelapseRef.current.active = false
    timelapseRef.current.progress = 1
    setTimelapseUi({ active: false, current: 0, total: 0 })
  }, [])

  const toggleTimelapse = useCallback(() => {
    if (timelapseRef.current.active) {
      stopTimelapse()
      return
    }
    const ordered = Array.from(simNodesRef.current.values())
      .sort((a, b) => a.node.createdAtMs - b.node.createdAtMs)
      .map((n) => n.id)
    if (ordered.length === 0) return
    timelapseRef.current = {
      active: true,
      progress: 0,
      order: ordered,
      revealed: new Set(),
      lastIdx: -1,
    }
    onSelectEntryId(null)
    setFocusedTagId(null)
    setTimelapseUi({ active: true, current: 0, total: ordered.length })
  }, [onSelectEntryId, stopTimelapse])

  // Rebuild simulation nodes smoothly when graph topology changes
  const hadNodesRef = useRef(false)
  useEffect(() => {
    const nextSim = buildSimNodes(graph, simNodesRef.current)
    simNodesRef.current = nextSim
    alphaRef.current = 1
    for (let i = 0; i < 150; i++) {
      stepGraphPhysics({
        simNodes: nextSim,
        edges: graph.edges,
        settings: liveRef.current.settings,
        alpha: 0.85,
        draggingNodeId: null,
        warmup: true,
      })
    }
    const isInitial = !hadNodesRef.current && nextSim.size > 0
    hadNodesRef.current = nextSim.size > 0
    if (isInitial) {
      handleFitCamera(true)
    } else if (nextSim.size > 0 && !liveRef.current.selectedId) {
      handleFitCamera(false)
    }
  }, [graph, handleFitCamera])

  // Smooth camera glide when selected memory changes
  useEffect(() => {
    if (!selectedEntryId) return
    setFocusedTagId(null)
    const node = simNodesRef.current.get(selectedEntryId)
    if (!node) return
    focusGraphNode(node, cameraRef.current, DRAWER_WIDTH_PX)
    fireSparksFrom(selectedEntryId, 1.55)
  }, [selectedEntryId, fireSparksFrom])

  // Observe container resize & live theme token switches
  useEffect(() => {
    const stage = stageRef.current
    const canvas = canvasRef.current
    if (!stage || !canvas) return

    const syncViewport = () => {
      const rect = stage.getBoundingClientRect()
      if (rect.width < 10 || rect.height < 10) return
      const dpr = window.devicePixelRatio || 1
      viewportRef.current = { width: rect.width, height: rect.height, dpr }
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
    }
    const syncPalette = () => {
      paletteRef.current = readGraphThemePalette(stage)
    }

    syncViewport()
    syncPalette()
    handleFitCamera(true)

    const ro = new ResizeObserver(syncViewport)
    ro.observe(stage)

    const mo = new MutationObserver(syncPalette)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    if (document.body) {
      mo.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    }
    const mql = window.matchMedia?.('(prefers-color-scheme: dark)')
    mql?.addEventListener?.('change', syncPalette)

    return () => {
      ro.disconnect()
      mo.disconnect()
      mql?.removeEventListener?.('change', syncPalette)
    }
  }, [handleFitCamera])

  // Main 60fps simulation & render loop
  useEffect(() => {
    let rafId = 0
    let lastTs = performance.now()
    const reducedMotion = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)

    const tick = (ts: number) => {
      const dt = Math.min(0.05, Math.max(0.004, (ts - lastTs) / 1000))
      lastTs = ts
      timeRef.current += dt

      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      const palette = paletteRef.current
      const cur = liveRef.current

      if (ctx && palette && cur.graph.nodes.length > 0) {
        if (!dragRef.current.active) {
          alphaRef.current = Math.max(0.025, alphaRef.current * 0.985)
        }
        stepGraphPhysics({
          simNodes: simNodesRef.current,
          edges: cur.graph.edges,
          settings: cur.settings,
          alpha: alphaRef.current,
          draggingNodeId: dragRef.current.nodeId,
          warmup: false,
        })

        const tl = timelapseRef.current
        if (tl.active) {
          tl.progress = Math.min(1, tl.progress + dt * 0.16)
          const target = Math.floor(tl.progress * tl.order.length)
          if (target > tl.lastIdx + 1) {
            for (let i = tl.lastIdx + 1; i < target; i++) {
              const id = tl.order[i]!
              tl.revealed.add(id)
              const sim = simNodesRef.current.get(id)
              if (sim) {
                sim.glowAnim = 1
                birthRingsRef.current.push({ id, age: 0, duration: 0.7 })
                fireSparksFrom(id, 1.8)
              }
            }
            tl.lastIdx = target - 1
            setTimelapseUi({ active: true, current: Math.min(tl.order.length, target), total: tl.order.length })
          }
          if (tl.progress >= 1) {
            tl.active = false
            window.setTimeout(() => {
              if (!timelapseRef.current.active) setTimelapseUi({ active: false, current: 0, total: 0 })
            }, 900)
          }
        }

        if (
          cur.settings.showPulses &&
          !reducedMotion &&
          !tl.active &&
          cur.graph.edges.length > 0 &&
          sparksRef.current.length < 7 &&
          Math.random() < dt * 2.1
        ) {
          const edge = cur.graph.edges[Math.floor(Math.random() * cur.graph.edges.length)]!
          sparksRef.current.push({
            edge,
            reverse: !edge.directed && Math.random() > 0.5,
            t: 0,
            speed: 0.55 + Math.random() * 0.3,
            active: false,
          })
        }

        for (let i = sparksRef.current.length - 1; i >= 0; i--) {
          const s = sparksRef.current[i]!
          s.t += dt * s.speed
          if (s.t >= 1) {
            const destId = s.reverse ? s.edge.source : s.edge.target
            const dest = simNodesRef.current.get(destId)
            if (dest && s.active) dest.glowAnim = Math.max(dest.glowAnim, 0.7)
            sparksRef.current.splice(i, 1)
          }
        }
        for (let i = birthRingsRef.current.length - 1; i >= 0; i--) {
          const br = birthRingsRef.current[i]!
          br.age += dt
          if (br.age >= br.duration) birthRingsRef.current.splice(i, 1)
        }

        renderGraphFrame({
          ctx,
          viewport: viewportRef.current,
          palette,
          camera: cameraRef.current,
          settings: cur.settings,
          simNodes: simNodesRef.current,
          graph: cur.graph,
          selectedId: cur.selectedId,
          hoveredId: hoveredIdRef.current,
          groupFilter: cur.groupFilter,
          searchMatches: cur.searchMatches,
          draggingNodeId: dragRef.current.nodeId,
          sparks: sparksRef.current,
          birthRings: birthRingsRef.current,
          revealedIds: tl.active ? tl.revealed : null,
          time: timeRef.current,
          dt,
          reducedMotion,
        })
      }

      rafId = window.requestAnimationFrame(tick)
    }

    rafId = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(rafId)
  }, [fireSparksFrom])

  // Wheel zoom (non-passive listener on canvas) + keyboard Esc/F shortcuts
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const sx = ev.clientX - rect.left
      const sy = ev.clientY - rect.top
      const cam = cameraRef.current
      const vp = viewportRef.current
      const before = screenToWorld(sx, sy, cam, vp)
      const factor = ev.deltaY < 0 ? 1.12 : 0.89
      const nextScale = Math.min(2.8, Math.max(0.35, cam.tScale * factor))
      cam.tScale = nextScale
      cam.tx = before.x - (sx - vp.width * 0.5) / nextScale
      cam.ty = before.y - (sy - vp.height * 0.5) / nextScale
    }
    const onKeyDown = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      if (ev.key === 'Escape') {
        if (settingsOpen) setSettingsOpen(false)
        else if (liveRef.current.selectedId) {
          onSelectEntryId(null)
          setFocusedTagId(null)
          handleFitCamera(false)
        }
      } else if (ev.key === 'f' || ev.key === 'F') {
        handleFitCamera(false)
      }
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKeyDown)
    return () => {
      canvas.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [handleFitCamera, onSelectEntryId, settingsOpen])

  const handlePointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const sx = ev.clientX - rect.left
    const sy = ev.clientY - rect.top
    const hit = hitTestGraphNode(sx, sy, simNodesRef.current, cameraRef.current, viewportRef.current, settings.nodeScale)
    dragRef.current = {
      active: true,
      mode: hit ? 'node' : 'pan',
      nodeId: hit ? hit.id : null,
      startX: sx,
      startY: sy,
      camStartX: cameraRef.current.tx,
      camStartY: cameraRef.current.ty,
      moved: false,
    }
    setCursorMode('drag')
    canvas.setPointerCapture(ev.pointerId)
  }

  const handlePointerMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const sx = ev.clientX - rect.left
    const sy = ev.clientY - rect.top
    const drag = dragRef.current

    if (drag.active) {
      const dx = sx - drag.startX
      const dy = sy - drag.startY
      if (Math.hypot(dx, dy) > 4) drag.moved = true
      if (drag.mode === 'node' && drag.nodeId) {
        const w = screenToWorld(sx, sy, cameraRef.current, viewportRef.current)
        const n = simNodesRef.current.get(drag.nodeId)
        if (n) {
          n.x = w.x
          n.y = w.y
          alphaRef.current = Math.max(alphaRef.current, 0.55)
        }
      } else {
        cameraRef.current.tx = drag.camStartX - dx / cameraRef.current.scale
        cameraRef.current.ty = drag.camStartY - dy / cameraRef.current.scale
      }
      return
    }

    const hit = hitTestGraphNode(sx, sy, simNodesRef.current, cameraRef.current, viewportRef.current, settings.nodeScale)
    const nextHover = hit ? hit.id : null
    if (nextHover !== hoveredIdRef.current) {
      hoveredIdRef.current = nextHover
      if (nextHover) fireSparksFrom(nextHover, 1.35)
    }
    setCursorMode(nextHover ? 'hover' : 'idle')
  }

  const handlePointerUp = () => {
    const { moved, nodeId } = dragRef.current
    dragRef.current = { active: false, mode: null, nodeId: null, startX: 0, startY: 0, camStartX: 0, camStartY: 0, moved: false }
    setCursorMode(hoveredIdRef.current ? 'hover' : 'idle')
    if (moved) return
    if (nodeId) {
      const sim = simNodesRef.current.get(nodeId)
      if (sim?.node.nodeKind === 'memory') {
        setFocusedTagId(null)
        onSelectEntryId(nodeId)
      } else if (sim?.node.nodeKind === 'tag') {
        onSelectEntryId(null)
        setFocusedTagId((prev) => (prev === nodeId ? null : nodeId))
        fireSparksFrom(nodeId, 1.45)
      }
    } else if (selectedEntryId || focusedTagId) {
      onSelectEntryId(null)
      setFocusedTagId(null)
      handleFitCamera(false)
    }
  }

  const handlePointerLeave = () => {
    hoveredIdRef.current = null
    if (!dragRef.current.active) setCursorMode('idle')
  }

  const isEmpty = !loading && graph.nodes.length === 0
  const timelapsePct = timelapseUi.total > 0 ? Math.round((timelapseUi.current / timelapseUi.total) * 100) : 0

  return (
    <section
      ref={stageRef}
      className="fb-mem-graph-stage"
      data-drawer={drawerOpen ? '' : undefined}
      aria-label="记忆关系图谱"
    >
      <canvas
        ref={canvasRef}
        className="fb-mem-graph-canvas"
        data-cursor={cursorMode}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
      />

      {loading && entries.length === 0 ? (
        <div className="fb-mem-graph-empty">加载记忆图谱中…</div>
      ) : isEmpty ? (
        <div className="fb-mem-graph-empty">
          {entries.length > 0 ? (
            <div className="fb-empty-stack">
              <div>当前筛选条件下暂无记忆节点</div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setGroupFilter(null)
                  setSettings(DEFAULT_MEMORY_GRAPH_SETTINGS)
                }}
              >
                重置图谱筛选
              </Button>
            </div>
          ) : (
            <div className="fb-empty-stack">
              <div>对话中的纠偏、偏好与项目决策沉淀后会在此处形成关联图谱</div>
              <Button size="sm" variant="outline" icon={<IconPlusOutlineRegular size={14} />} onClick={onCreate}>
                新增记忆
              </Button>
            </div>
          )}
        </div>
      ) : null}

      <div className="fb-mem-graph-controls">
        <div className="fb-mem-graph-iconbar">
          <button
            type="button"
            className="fb-mem-graph-iconbtn"
            aria-label="演进生长回放"
            aria-pressed={timelapseUi.active}
            title="演进生长回放"
            disabled={graph.nodes.length === 0}
            onClick={toggleTimelapse}
          >
            <IconPlayOutlineRegular size={13} />
          </button>
          <button
            type="button"
            className="fb-mem-graph-iconbtn"
            aria-label="居中适配图谱"
            title="居中适配 (F)"
            disabled={graph.nodes.length === 0}
            onClick={() => handleFitCamera(false)}
          >
            <FitViewportIcon />
          </button>
          <button
            type="button"
            className="fb-mem-graph-iconbtn"
            aria-label="图谱设置"
            aria-expanded={settingsOpen}
            aria-pressed={settingsOpen}
            title="图谱设置（筛选 · 分组 · 显示 · 力场）"
            onClick={() => setSettingsOpen((v) => !v)}
          >
            <IconSettingsOutlineRegular size={14} />
          </button>
        </div>

        {settingsOpen && (
          <GraphSettingsPanel
            settings={settings}
            onUpdateSettings={updateSettings}
            groupCounts={graph.groupCounts}
            groupFilter={groupFilter}
            onToggleGroup={(group) => setGroupFilter((prev) => (prev === group ? null : group))}
          />
        )}
      </div>

      {graph.nodes.length > 0 && (
        <div className="fb-mem-graph-stat fb-num">
          <span>
            {graph.memoryCount} 条记忆
            {graph.tagHubCount > 0 ? ` · ${graph.tagHubCount} 标签枢纽` : ''}
            {` · ${graph.edges.length} 条关联`}
          </span>
          {timelapseUi.active && (
            <div className="fb-mem-graph-tl">
              <span>
                记忆演化 {timelapseUi.current} / {timelapseUi.total}
              </span>
              <div className="fb-mem-graph-tl-track">
                <div className="fb-mem-graph-tl-fill" style={{ width: `${timelapsePct}%` }} />
              </div>
            </div>
          )}
        </div>
      )}

      <aside className="fb-mem-graph-drawer" data-open={drawerOpen ? '' : undefined} aria-label="记忆详情抽屉">
        {selectedEntry ? renderDrawerReader(selectedEntry, linkedItems) : null}
      </aside>
    </section>
  )
}
