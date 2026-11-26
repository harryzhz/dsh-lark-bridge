import type { BotRecord, GroupView, MemoryEntry, MemoryType } from '../types.js'
import { matchesMemorySearch, MEMORY_TYPE_ORDER } from './memory-model.js'

export type MemoryViewMode = 'graph' | 'columns'

export type MemoryGraphNodeKind = 'memory' | 'tag'
export type MemoryGraphGroupKey = MemoryType | 'tag'
export type MemoryGraphEdgeKind = 'supersede' | 'tag' | 'semantic'

export interface MemoryGraphNode {
  readonly id: string
  readonly nodeKind: MemoryGraphNodeKind
  readonly group: MemoryGraphGroupKey
  readonly label: string
  readonly createdAtMs: number
  readonly entry?: MemoryEntry
  readonly tag?: string
  readonly memberCount?: number
}

export interface MemoryGraphEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly kind: MemoryGraphEdgeKind
  readonly directed: boolean
  readonly weight: number
  readonly reason: string
}

export interface MemoryGraphData {
  readonly nodes: readonly MemoryGraphNode[]
  readonly edges: readonly MemoryGraphEdge[]
  readonly memoryCount: number
  readonly tagHubCount: number
  readonly groupCounts: Readonly<Record<MemoryGraphGroupKey, number>>
}

export interface MemoryGraphSettings {
  readonly showTags: boolean
  readonly showHistory: boolean
  readonly showSemantic: boolean
  readonly pinnedOnly: boolean
  readonly showArrows: boolean
  readonly showPulses: boolean
  readonly textFadeThreshold: number
  readonly nodeScale: number
  readonly lineThickness: number
  readonly centerForce: number
  readonly repelForce: number
  readonly linkDist: number
}

export const DEFAULT_MEMORY_GRAPH_SETTINGS: MemoryGraphSettings = {
  showTags: true,
  showHistory: true,
  showSemantic: true,
  pinnedOnly: false,
  showArrows: true,
  showPulses: true,
  textFadeThreshold: 0.85,
  nodeScale: 1,
  lineThickness: 1,
  centerForce: 0.5,
  repelForce: 1,
  linkDist: 118,
}

export interface MemoryGraphNeighborhood {
  readonly hop1Nodes: ReadonlySet<string>
  readonly hop1Edges: ReadonlySet<string>
  readonly hop2Nodes: ReadonlySet<string>
  readonly hop2Edges: ReadonlySet<string>
}

export interface MemoryLinkedItem {
  readonly entry: MemoryEntry
  readonly relationLabel: string
  readonly kind: MemoryGraphEdgeKind
}

const LEXICAL_STOP_WORDS = new Set([
  '的',
  '了',
  '和',
  '与',
  '在',
  '为',
  '是',
  '不',
  '有',
  '及',
  '或',
  '按',
  '对',
  '将',
  '由',
  '至',
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'all',
  'use',
  'non',
  'via',
])

export function resolveMemoryViewMode(raw?: string | null): MemoryViewMode {
  return raw === 'columns' ? 'columns' : 'graph'
}

export function extractLexicalTerms(entry: Pick<MemoryEntry, 'title' | 'content'>): Map<string, number> {
  const text = `${entry.title} ${entry.title} ${entry.content}`.toLowerCase()
  const terms = new Map<string, number>()
  const add = (token: string, weight: number) => {
    if (token.length < 2 || LEXICAL_STOP_WORDS.has(token)) return
    terms.set(token, (terms.get(token) ?? 0) + weight)
  }

  for (const latin of text.match(/[a-z][a-z0-9_-]{2,}/g) ?? []) {
    add(latin, 1.5)
  }
  for (const cjkRun of text.match(/[\u4e00-\u9fa5]{2,}/g) ?? []) {
    for (let i = 0; i < cjkRun.length - 1; i++) {
      add(cjkRun.slice(i, i + 2), 1)
    }
  }
  return terms
}

function makeEdgeKey(source: string, target: string, kind: MemoryGraphEdgeKind, directed: boolean): string {
  if (directed) return `${kind}:${source}->${target}`
  return source < target ? `${kind}:${source}--${target}` : `${kind}:${target}--${source}`
}

function appendTagHubsOrDirectEdges(
  entries: readonly MemoryEntry[],
  showTags: boolean,
  nodes: MemoryGraphNode[],
  pushEdge: (edge: Omit<MemoryGraphEdge, 'id'>) => void,
): number {
  if (showTags) {
    const tagMembers = new Map<string, MemoryEntry[]>()
    for (const entry of entries) {
      for (const raw of entry.tags) {
        const tag = raw.trim().toLowerCase()
        if (!tag) continue
        const list = tagMembers.get(tag)
        if (list) list.push(entry)
        else tagMembers.set(tag, [entry])
      }
    }
    let hubCount = 0
    for (const [tag, members] of tagMembers.entries()) {
      if (members.length < 2) continue
      const tagId = `tag:${tag}`
      const earliestMs = Math.min(...members.map((m) => m.createdAtMs))
      nodes.push({
        id: tagId,
        nodeKind: 'tag',
        group: 'tag',
        label: `#${tag}`,
        createdAtMs: earliestMs,
        tag,
        memberCount: members.length,
      })
      hubCount += 1
      for (const m of members) {
        pushEdge({
          source: m.id,
          target: tagId,
          kind: 'tag',
          directed: false,
          weight: 0.72,
          reason: `归属标签 #${tag}`,
        })
      }
    }
    return hubCount
  }

  const pairs: Array<{ a: string; b: string; shared: string[] }> = []
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]!
      const b = entries[j]!
      if (a.supersededBy === b.id || b.supersededBy === a.id) continue
      const setA = new Set(a.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))
      const shared = b.tags
        .map((t) => t.trim().toLowerCase())
        .filter((t, idx, arr) => Boolean(t) && setA.has(t) && arr.indexOf(t) === idx)
      if (shared.length > 0) pairs.push({ a: a.id, b: b.id, shared })
    }
  }
  pairs.sort((x, y) => y.shared.length - x.shared.length)
  const degree = new Map<string, number>()
  for (const p of pairs) {
    if ((degree.get(p.a) ?? 0) >= 3 || (degree.get(p.b) ?? 0) >= 3) continue
    pushEdge({
      source: p.a,
      target: p.b,
      kind: 'tag',
      directed: false,
      weight: Math.min(0.9, 0.35 + p.shared.length * 0.2),
      reason: `共享标签 ${p.shared.slice(0, 3).map((t) => `#${t}`).join(' ')}`,
    })
    degree.set(p.a, (degree.get(p.a) ?? 0) + 1)
    degree.set(p.b, (degree.get(p.b) ?? 0) + 1)
  }
  return 0
}

function appendSemanticBridges(
  entries: readonly MemoryEntry[],
  pushEdge: (edge: Omit<MemoryGraphEdge, 'id'>) => void,
): void {
  if (entries.length < 2) return
  const rawTerms = entries.map(extractLexicalTerms)
  const df = new Map<string, number>()
  for (const tm of rawTerms) {
    for (const term of tm.keys()) df.set(term, (df.get(term) ?? 0) + 1)
  }
  const maxDf = Math.max(4, entries.length * 0.55)
  const vectors = rawTerms.map((tm) => {
    const vec = new Map<string, number>()
    let normSq = 0
    for (const [term, tf] of tm.entries()) {
      const docFreq = df.get(term) ?? 1
      if (docFreq < 2 || docFreq > maxDf) continue
      const score = tf * (Math.log((entries.length + 1) / (docFreq + 0.5)) + 0.3)
      vec.set(term, score)
      normSq += score * score
    }
    return { vec, norm: Math.sqrt(normSq) || 1 }
  })

  const candidates: Array<{ a: string; b: string; cos: number; top: string[] }> = []
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]!
      const b = entries[j]!
      if (a.supersededBy === b.id || b.supersededBy === a.id) continue
      const va = vectors[i]!
      const vb = vectors[j]!
      let dot = 0
      const terms: Array<[string, number]> = []
      const [small, big] = va.vec.size <= vb.vec.size ? [va.vec, vb.vec] : [vb.vec, va.vec]
      for (const [term, val] of small.entries()) {
        const other = big.get(term)
        if (other !== undefined) {
          const prod = val * other
          dot += prod
          terms.push([term, prod])
        }
      }
      const cos = dot / (va.norm * vb.norm)
      if (cos >= 0.24) {
        terms.sort((x, y) => y[1] - x[1])
        candidates.push({ a: a.id, b: b.id, cos, top: terms.slice(0, 3).map((x) => x[0]) })
      }
    }
  }

  candidates.sort((x, y) => y.cos - x.cos)
  const semDegree = new Map<string, number>()
  for (const c of candidates) {
    if ((semDegree.get(c.a) ?? 0) >= 2 || (semDegree.get(c.b) ?? 0) >= 2) continue
    pushEdge({
      source: c.a,
      target: c.b,
      kind: 'semantic',
      directed: false,
      weight: Math.min(0.85, 0.35 + c.cos),
      reason: `语义关联 · ${c.top.join(' / ')}`,
    })
    semDegree.set(c.a, (semDegree.get(c.a) ?? 0) + 1)
    semDegree.set(c.b, (semDegree.get(c.b) ?? 0) + 1)
  }
}

export function buildMemoryGraph(
  entries: readonly MemoryEntry[],
  options: Pick<MemoryGraphSettings, 'showTags' | 'showHistory' | 'showSemantic' | 'pinnedOnly'>,
): MemoryGraphData {
  const filtered = entries.filter((entry) => {
    if (!options.showHistory && entry.status !== 'active') return false
    if (options.pinnedOnly && !(entry.status === 'active' && entry.pinned)) return false
    return true
  })
  const byId = new Map(filtered.map((e) => [e.id, e]))
  const nodes: MemoryGraphNode[] = []
  const edges: MemoryGraphEdge[] = []
  const edgeKeys = new Set<string>()
  const groupCounts: Record<MemoryGraphGroupKey, number> = {
    feedback: 0,
    user: 0,
    project: 0,
    reference: 0,
    tag: 0,
  }

  const pushEdge = (edge: Omit<MemoryGraphEdge, 'id'>) => {
    const id = makeEdgeKey(edge.source, edge.target, edge.kind, edge.directed)
    if (edgeKeys.has(id)) return
    edgeKeys.add(id)
    edges.push({ ...edge, id })
  }

  for (const entry of filtered) {
    nodes.push({
      id: entry.id,
      nodeKind: 'memory',
      group: entry.type,
      label: entry.title,
      createdAtMs: entry.createdAtMs,
      entry,
    })
    groupCounts[entry.type] += 1
  }

  for (const entry of filtered) {
    if (entry.supersededBy && byId.has(entry.supersededBy)) {
      pushEdge({
        source: entry.id,
        target: entry.supersededBy,
        kind: 'supersede',
        directed: true,
        weight: 1,
        reason: entry.supersedeReason || '双时态纠偏演进',
      })
    }
  }

  const tagHubCount = appendTagHubsOrDirectEdges(filtered, options.showTags, nodes, pushEdge)
  groupCounts.tag = tagHubCount

  if (options.showSemantic) {
    appendSemanticBridges(filtered, pushEdge)
  }

  return {
    nodes,
    edges,
    memoryCount: filtered.length,
    tagHubCount,
    groupCounts,
  }
}

export function computeGraphNeighborhood(
  centerId: string,
  nodes: readonly MemoryGraphNode[],
  edges: readonly MemoryGraphEdge[],
): MemoryGraphNeighborhood {
  const nodesById = new Map(nodes.map((n) => [n.id, n]))
  const adj = new Map<string, Array<{ other: string; edgeId: string }>>()
  for (const edge of edges) {
    const srcList = adj.get(edge.source)
    if (srcList) srcList.push({ other: edge.target, edgeId: edge.id })
    else adj.set(edge.source, [{ other: edge.target, edgeId: edge.id }])
    const dstList = adj.get(edge.target)
    if (dstList) dstList.push({ other: edge.source, edgeId: edge.id })
    else adj.set(edge.target, [{ other: edge.source, edgeId: edge.id }])
  }

  const hop1Nodes = new Set<string>([centerId])
  const hop1Edges = new Set<string>()
  const hop2Nodes = new Set<string>()
  const hop2Edges = new Set<string>()

  for (const item of adj.get(centerId) ?? []) {
    hop1Nodes.add(item.other)
    hop1Edges.add(item.edgeId)
  }

  const center = nodesById.get(centerId)
  if (center?.nodeKind === 'memory') {
    for (const nbId of hop1Nodes) {
      if (nbId === centerId) continue
      const nb = nodesById.get(nbId)
      if (!nb || nb.nodeKind !== 'tag') continue
      for (const item of adj.get(nbId) ?? []) {
        if (hop1Nodes.has(item.other)) continue
        hop2Nodes.add(item.other)
        hop2Edges.add(item.edgeId)
      }
    }
  }

  return { hop1Nodes, hop1Edges, hop2Nodes, hop2Edges }
}

export function matchGraphSearch(
  nodes: readonly MemoryGraphNode[],
  rawQuery: string,
  botsById: ReadonlyMap<string, Pick<BotRecord, 'id' | 'name'>>,
  groups: readonly Pick<GroupView, 'botId' | 'chatId' | 'chatName'>[],
): Set<string> | null {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return null
  const tagNeedle = q.startsWith('#') ? q.slice(1) : q
  const matched = new Set<string>()
  for (const node of nodes) {
    if (node.nodeKind === 'tag') {
      if (tagNeedle && node.tag?.toLowerCase().includes(tagNeedle)) matched.add(node.id)
    } else if (node.entry && matchesMemorySearch(node.entry, q, botsById, groups)) {
      matched.add(node.id)
    }
  }
  return matched
}

export function collectMemoryLinkedItems(
  entryId: string,
  nodes: readonly MemoryGraphNode[],
  edges: readonly MemoryGraphEdge[],
): MemoryLinkedItem[] {
  const nodesById = new Map(nodes.map((n) => [n.id, n]))
  const direct: MemoryLinkedItem[] = []
  const seen = new Set<string>([entryId])
  const connectedTagIds: string[] = []

  for (const edge of edges) {
    if (edge.source !== entryId && edge.target !== entryId) continue
    const otherId = edge.source === entryId ? edge.target : edge.source
    const other = nodesById.get(otherId)
    if (!other) continue
    if (other.nodeKind === 'tag') {
      connectedTagIds.push(other.id)
      continue
    }
    if (!other.entry || seen.has(other.id)) continue
    seen.add(other.id)
    const relationLabel =
      edge.kind === 'supersede'
        ? edge.source === entryId
          ? '被替代 →'
          : '← 替代旧版'
        : edge.kind === 'tag'
          ? edge.reason.replace(/^共享标签\s*/, '')
          : '语义关联'
    direct.push({ entry: other.entry, relationLabel, kind: edge.kind })
  }

  const siblings: MemoryLinkedItem[] = []
  for (const tagId of connectedTagIds) {
    const tagLabel = nodesById.get(tagId)?.label ?? ''
    for (const edge of edges) {
      const sibId = edge.source === tagId ? edge.target : edge.target === tagId ? edge.source : null
      if (!sibId || seen.has(sibId)) continue
      const sib = nodesById.get(sibId)
      if (!sib?.entry) continue
      seen.add(sibId)
      siblings.push({ entry: sib.entry, relationLabel: tagLabel, kind: 'tag' })
    }
  }

  const order: Record<MemoryGraphEdgeKind, number> = { supersede: 0, semantic: 1, tag: 2 }
  direct.sort((a, b) => order[a.kind] - order[b.kind])
  return [...direct, ...siblings.slice(0, 8)]
}

export const GRAPH_GROUP_ORDER: readonly MemoryGraphGroupKey[] = [...MEMORY_TYPE_ORDER, 'tag']
