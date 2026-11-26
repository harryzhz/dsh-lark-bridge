import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const stub = () => null
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === '__esModule') return true
        if (prop === 'then' || typeof prop === 'symbol') return undefined
        return stub
      },
      has: (_target, prop) => typeof prop === 'string' && prop !== 'then',
      getOwnPropertyDescriptor: (_target, prop) =>
        typeof prop === 'string' && prop !== 'then'
          ? { configurable: true, enumerable: true, value: stub }
          : undefined,
    },
  )
})

import { bridgeApi, configureBridgeTransport } from '../src/api.js'
import {
  buildMemoryGraph,
  buildMemoryHierarchy,
  collectMemoryLinkedItems,
  collectTopMemoryTags,
  computeGraphNeighborhood,
  countMemoriesByHistoryStatus,
  countMemoriesByType,
  DEFAULT_MEMORY_GRAPH_SETTINGS,
  filterAndSortMemories,
  findSupersededPredecessors,
  isSameMemoryNav,
  matchGraphSearch,
  MEMORY_HISTORY_FILTERS,
  MEMORY_SORT_OPTIONS,
  MEMORY_TYPE_META,
  MEMORY_TYPE_ORDER,
  resolveMemoryScopeLabel,
  resolveMemoryViewMode,
  resolveNavHeading,
  summarizeMemoryExcerpt,
} from '../src/views/MemoryView.js'
import { buildSimNodes, stepGraphPhysics } from '../src/views/memory-graph-engine.js'
import type { MemoryEntry } from '../src/types.js'

function makeEntry(overrides: Partial<MemoryEntry> & Pick<MemoryEntry, 'id' | 'title'>): MemoryEntry {
  return {
    botId: 'bot-a',
    scope: 'bot',
    scopeId: '',
    type: 'feedback',
    content: '默认记忆正文内容',
    tags: [],
    confidence: 'high',
    pinned: false,
    status: 'active',
    createdAtMs: 1000,
    updatedAtMs: 1500,
    lastVerifiedAtMs: 2000,
    recallCount: 0,
    ...overrides,
  }
}

describe('MemoryView three-column helpers & memory API transport', () => {
  const bots = [
    { id: 'bot-a', name: '研发助手' },
    { id: 'bot-b', name: '值班助手' },
  ]
  const groups = [
    { botId: 'bot-a', chatId: 'oc_dev', chatName: '研发协作群' },
    { botId: 'bot-b', chatId: 'oc_ops', chatName: '线上告警群' },
  ]

  const entries: MemoryEntry[] = [
    makeEntry({
      id: 'mem-1',
      botId: 'bot-a',
      type: 'feedback',
      scope: 'bot',
      title: '发布前先观察 P95 指标',
      content: '灰度阶段持续观察 10 分钟无异常再放量。',
      tags: ['release', 'ops'],
      pinned: true,
      recallCount: 4,
      lastVerifiedAtMs: 3000,
    }),
    makeEntry({
      id: 'mem-2',
      botId: 'bot-a',
      type: 'user',
      scope: 'chat',
      scopeId: 'oc_dev',
      title: '群内回复结论先行',
      content: '- 先给核心结论与数字\n- 再补充 `推导细节` 与 **验证结果**',
      tags: ['style', 'ops'],
      recallCount: 9,
      lastVerifiedAtMs: 5000,
    }),
    makeEntry({
      id: 'mem-3',
      botId: 'bot-a',
      type: 'project',
      scope: 'workspace',
      scopeId: '/Users/demo/repo-alpha',
      title: '采用双时态纠偏策略',
      content: '推翻旧结论时保留 superseded 审计链。',
      tags: ['memory'],
      recallCount: 2,
      lastVerifiedAtMs: 4000,
    }),
    makeEntry({
      id: 'mem-4',
      botId: 'bot-b',
      type: 'reference',
      scope: 'chat',
      scopeId: 'oc_ops',
      title: '值班手册与看板入口',
      content: '参考 https://ops.example.com/runbook 排查超时告警。',
      tags: ['runbook', 'ops'],
      pinned: true,
      recallCount: 15,
      lastVerifiedAtMs: 2500,
    }),
    makeEntry({
      id: 'mem-5',
      botId: 'bot-a',
      type: 'project',
      scope: 'bot',
      title: '旧架构单文件存储方案',
      content: '早期以 JSON 文件作为主存储。',
      status: 'superseded',
      supersededBy: 'mem-3',
      supersededAtMs: 3800,
      supersedeReason: '2026-11-20 已迁移至 SQLite WAL',
    }),
    makeEntry({
      id: 'mem-6',
      botId: 'bot-b',
      type: 'reference',
      scope: 'bot',
      title: '已下线测试集群入口',
      content: '旧测试环境已回收。',
      status: 'archived',
      supersedeReason: '控制台手动归档',
    }),
  ]

  it('resolves human-readable scope labels with 全局记忆 at root', () => {
    expect(resolveMemoryScopeLabel(entries[0]!, groups)).toEqual({
      label: '全局记忆',
      shortLabel: '全局记忆',
      fullTitle: '智能体全局（该智能体所有群聊与私聊可见）',
    })
    expect(resolveMemoryScopeLabel(entries[1]!, groups)).toEqual({
      label: '群聊 · 研发协作群',
      shortLabel: '研发协作群',
      fullTitle: '研发协作群 (oc_dev)',
    })
    expect(
      resolveMemoryScopeLabel(
        makeEntry({ id: 'mem-x', botId: 'bot-a', scope: 'chat', scopeId: 'oc_unknown', title: 't' }),
        groups,
      ).label,
    ).toBe('群聊 · oc_unknown')
    expect(resolveMemoryScopeLabel(entries[2]!, groups)).toEqual({
      label: '工作区 · repo-alpha',
      shortLabel: 'repo-alpha',
      fullTitle: '/Users/demo/repo-alpha',
    })
  })

  it('builds scope hierarchy with global count, workspaces, and chats sorted deterministically', () => {
    const active = entries.filter((e) => e.status === 'active')
    const hierarchy = buildMemoryHierarchy(active, groups)
    expect(hierarchy).toEqual({
      globalCount: 1,
      workspaceTotal: 1,
      workspaces: [{ scopeId: '/Users/demo/repo-alpha', label: 'repo-alpha', fullTitle: '/Users/demo/repo-alpha', count: 1 }],
      chatTotal: 2,
      chats: [
        { scopeId: 'oc_ops', label: '线上告警群', fullTitle: '线上告警群 (oc_ops)', count: 1 },
        { scopeId: 'oc_dev', label: '研发协作群', fullTitle: '研发协作群 (oc_dev)', count: 1 },
      ],
    })
  })

  it('computes category counts, history counts, and top tags', () => {
    const active = entries.filter((e) => e.status === 'active')
    const history = entries.filter((e) => e.status !== 'active')
    expect(MEMORY_TYPE_ORDER).toEqual(['feedback', 'user', 'project', 'reference'])
    expect(MEMORY_TYPE_ORDER.map((t) => MEMORY_TYPE_META[t].label)).toEqual([
      '纠偏与规范',
      '用户偏好',
      '项目决策',
      '外部参考',
    ])
    expect(countMemoriesByType(active)).toEqual({
      feedback: 1,
      user: 1,
      project: 1,
      reference: 1,
    })
    expect(countMemoriesByHistoryStatus(history)).toEqual({
      superseded: 1,
      archived: 1,
    })
    expect(MEMORY_HISTORY_FILTERS.map((f) => f.label)).toEqual(['全部', '已纠偏', '已归档'])
    expect(MEMORY_SORT_OPTIONS.map((o) => o.label)).toEqual(['按优先级', '按最近核验', '按召回次数'])
    expect(collectTopMemoryTags(active, 3)).toEqual([
      { tag: 'ops', count: 3 },
      { tag: 'memory', count: 1 },
      { tag: 'release', count: 1 },
    ])
  })

  it('filters by nav node (all, pinned, type, scope, tag, history), search query, and sort modes', () => {
    // Priority sort: pinned feedback (mem-1) -> pinned reference (mem-4) -> user (mem-2) -> project (mem-3)
    expect(
      filterAndSortMemories({
        entries,
        botId: '',
        nav: { kind: 'all' },
        historyFilter: 'all',
        query: '',
        sortBy: 'priority',
        bots,
        groups,
      }).map((e) => e.id),
    ).toEqual(['mem-1', 'mem-4', 'mem-2', 'mem-3'])

    // Recent sort: mem-2 (5000) -> mem-3 (4000) -> mem-1 (3000) -> mem-4 (2500)
    expect(
      filterAndSortMemories({
        entries,
        botId: '',
        nav: { kind: 'all' },
        historyFilter: 'all',
        query: '',
        sortBy: 'recent',
        bots,
        groups,
      }).map((e) => e.id),
    ).toEqual(['mem-2', 'mem-3', 'mem-1', 'mem-4'])

    // Recall sort: mem-4 (15) -> mem-2 (9) -> mem-1 (4) -> mem-3 (2)
    expect(
      filterAndSortMemories({
        entries,
        botId: '',
        nav: { kind: 'all' },
        historyFilter: 'all',
        query: '',
        sortBy: 'recall',
        bots,
        groups,
      }).map((e) => e.id),
    ).toEqual(['mem-4', 'mem-2', 'mem-1', 'mem-3'])

    // Pinned view
    expect(
      filterAndSortMemories({
        entries,
        botId: '',
        nav: { kind: 'pinned' },
        historyFilter: 'all',
        query: '',
        sortBy: 'priority',
        bots,
        groups,
      }).map((e) => e.id),
    ).toEqual(['mem-1', 'mem-4'])

    // Category view scoped to bot-a
    expect(
      filterAndSortMemories({
        entries,
        botId: 'bot-a',
        nav: { kind: 'type', type: 'user' },
        historyFilter: 'all',
        query: '',
        sortBy: 'priority',
        bots,
        groups,
      }).map((e) => e.id),
    ).toEqual(['mem-2'])

    // Scope hierarchy view: global / workspace leaf / chat leaf
    expect(
      filterAndSortMemories({
        entries,
        botId: '',
        nav: { kind: 'scope', scope: 'bot' },
        historyFilter: 'all',
        query: '',
        sortBy: 'priority',
        bots,
        groups,
      }).map((e) => e.id),
    ).toEqual(['mem-1'])

    expect(
      filterAndSortMemories({
        entries,
        botId: '',
        nav: { kind: 'scope', scope: 'workspace', scopeId: '/Users/demo/repo-alpha' },
        historyFilter: 'all',
        query: '',
        sortBy: 'priority',
        bots,
        groups,
      }).map((e) => e.id),
    ).toEqual(['mem-3'])

    expect(
      filterAndSortMemories({
        entries,
        botId: '',
        nav: { kind: 'scope', scope: 'chat', scopeId: 'oc_dev' },
        historyFilter: 'all',
        query: '',
        sortBy: 'priority',
        bots,
        groups,
      }).map((e) => e.id),
    ).toEqual(['mem-2'])

    // Tag view + search query
    expect(
      filterAndSortMemories({
        entries,
        botId: '',
        nav: { kind: 'tag', tag: 'ops' },
        historyFilter: 'all',
        query: '研发协作群',
        sortBy: 'priority',
        bots,
        groups,
      }).map((e) => e.id),
    ).toEqual(['mem-2'])

    // History view with sub-status & supersedeReason search
    expect(
      filterAndSortMemories({
        entries,
        botId: '',
        nav: { kind: 'history' },
        historyFilter: 'superseded',
        query: 'sqlite',
        sortBy: 'recent',
        bots,
        groups,
      }).map((e) => e.id),
    ).toEqual(['mem-5'])

    expect(
      filterAndSortMemories({
        entries,
        botId: 'bot-b',
        nav: { kind: 'history' },
        historyFilter: 'archived',
        query: '',
        sortBy: 'recent',
        bots,
        groups,
      }).map((e) => e.id),
    ).toEqual(['mem-6'])
  })

  it('resolves nav headings, nav equality, clean excerpts, and superseded predecessors', () => {
    expect(resolveNavHeading({ kind: 'all' }, groups)).toBe('全部有效')
    expect(resolveNavHeading({ kind: 'scope', scope: 'bot' }, groups)).toBe('全局记忆')
    expect(resolveNavHeading({ kind: 'scope', scope: 'workspace', scopeId: '/Users/demo/repo-alpha' }, groups)).toBe(
      '工作区 · repo-alpha',
    )
    expect(resolveNavHeading({ kind: 'scope', scope: 'chat', scopeId: 'oc_dev' }, groups)).toBe('群聊 · 研发协作群')
    expect(resolveNavHeading({ kind: 'tag', tag: 'ops' }, groups)).toBe('#ops')

    expect(isSameMemoryNav({ kind: 'tag', tag: 'OPS' }, { kind: 'tag', tag: 'ops' })).toBe(true)
    expect(
      isSameMemoryNav(
        { kind: 'scope', scope: 'chat', scopeId: 'oc_dev' },
        { kind: 'scope', scope: 'chat' },
      ),
    ).toBe(false)

    expect(summarizeMemoryExcerpt(entries[1]!.content)).toBe('先给核心结论与数字 再补充 推导细节 与 验证结果')
    expect(findSupersededPredecessors('mem-3', entries).map((e) => e.id)).toEqual(['mem-5'])
  })

  it('supports bot-less memory listing and supersede RPC calls via bridgeApi', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = []
    const rpc = {
      call: vi.fn(async (_channel: string, _endpoint: string, payload: unknown) => {
        const req = payload as { method: string; path: string; body?: unknown }
        calls.push(req)
        if (req.path.includes('/supersede')) {
          return {
            ok: true as const,
            value: {
              ok: true,
              oldEntry: entries[4],
              replacementEntry: entries[2],
            },
          }
        }
        return { ok: true as const, value: { ok: true, entries: [] } }
      }),
    }
    configureBridgeTransport(rpc)
    try {
      await bridgeApi.memories({ status: 'all', limit: 500 })
      await bridgeApi.memories({ botId: 'bot-a', status: 'active' })
      await bridgeApi.supersedeMemory('mem-5', {
        reason: '新结论替代旧方案',
        title: '采用 SQLite WAL',
        content: '统一存储于 lark-bridge.db。',
      })
    } finally {
      configureBridgeTransport(undefined, rpc)
    }

    expect(calls[0]).toEqual({ method: 'GET', path: '/memory?status=all&limit=500' })
    expect(calls[1]).toEqual({ method: 'GET', path: '/memory?botId=bot-a&status=active' })
    expect(calls[2]).toEqual({
      method: 'POST',
      path: '/memory/mem-5/supersede',
      body: {
        reason: '新结论替代旧方案',
        title: '采用 SQLite WAL',
        content: '统一存储于 lark-bridge.db。',
      },
    })
  })

  it('defaults to graph view mode and builds bipartite Obsidian-style memory graph with supersede, tag hubs, and semantic links', () => {
    expect(resolveMemoryViewMode()).toBe('graph')
    expect(resolveMemoryViewMode('unknown')).toBe('graph')
    expect(resolveMemoryViewMode('columns')).toBe('columns')

    const graphEntries: MemoryEntry[] = [
      ...entries,
      makeEntry({
        id: 'mem-7',
        botId: 'bot-a',
        type: 'reference',
        title: '热更新灰度指标检查流程',
        content: '发布灰度阶段持续观察 P95 指标与错误率 10 分钟无异常再放量。',
        tags: [],
        createdAtMs: 3200,
      }),
    ]

    const graph = buildMemoryGraph(graphEntries, DEFAULT_MEMORY_GRAPH_SETTINGS)
    expect(graph.memoryCount).toBe(7)
    // Only tags shared by >= 2 entries become hub nodes ("ops" is shared by mem-1, mem-2, mem-4)
    expect(graph.tagHubCount).toBe(1)
    expect(graph.nodes.some((n) => n.id === 'tag:ops' && n.nodeKind === 'tag')).toBe(true)
    expect(graph.nodes.some((n) => n.id === 'tag:release')).toBe(false)

    // Explicit directed supersede edge from mem-5 -> mem-3
    const supersedeEdge = graph.edges.find((e) => e.kind === 'supersede')
    expect(supersedeEdge).toMatchObject({
      source: 'mem-5',
      target: 'mem-3',
      directed: true,
    })

    // Untagged mem-7 connects to mem-1 via lexical TF-IDF semantic similarity
    expect(
      graph.edges.some(
        (e) =>
          e.kind === 'semantic' &&
          ((e.source === 'mem-1' && e.target === 'mem-7') || (e.source === 'mem-7' && e.target === 'mem-1')),
      ),
    ).toBe(true)

    // Neighborhood of mem-1 includes 1-hop tag:ops + mem-7 and 2-hop sibling memories mem-2, mem-4 via tag:ops
    const nb = computeGraphNeighborhood('mem-1', graph.nodes, graph.edges)
    expect(nb.hop1Nodes.has('tag:ops')).toBe(true)
    expect(nb.hop1Nodes.has('mem-7')).toBe(true)
    expect(nb.hop2Nodes.has('mem-2')).toBe(true)
    expect(nb.hop2Nodes.has('mem-4')).toBe(true)
    expect(nb.hop2Nodes.has('mem-6')).toBe(false)

    // Search matches both tag hub nodes and memory nodes
    const botsById = new Map(bots.map((b) => [b.id, b]))
    expect(matchGraphSearch(graph.nodes, '', botsById, groups)).toBeNull()
    const tagSearch = matchGraphSearch(graph.nodes, '#ops', botsById, groups)
    expect(tagSearch?.has('tag:ops')).toBe(true)
    expect(tagSearch?.has('mem-1')).toBe(false)
    const keywordSearch = matchGraphSearch(graph.nodes, 'ops', botsById, groups)
    expect(keywordSearch?.has('tag:ops')).toBe(true)
    expect(keywordSearch?.has('mem-1')).toBe(true)

    // Linked items for drawer list direct semantic/supersede links first, then shared-tag siblings
    const linked = collectMemoryLinkedItems('mem-1', graph.nodes, graph.edges)
    expect(linked[0]?.entry.id).toBe('mem-7')
    expect(linked[0]?.kind).toBe('semantic')
    expect(linked.slice(1).map((item) => item.entry.id).sort()).toEqual(['mem-2', 'mem-4'])

    // Disabling tag hubs falls back to direct shared-tag edges; disabling history hides superseded/archived
    const directGraph = buildMemoryGraph(graphEntries, {
      showTags: false,
      showHistory: false,
      showSemantic: false,
      pinnedOnly: false,
    })
    expect(directGraph.tagHubCount).toBe(0)
    expect(directGraph.memoryCount).toBe(5)
    expect(directGraph.edges.some((e) => e.kind === 'tag')).toBe(true)
    expect(directGraph.edges.some((e) => e.kind === 'supersede')).toBe(false)

    // Pinned-only filter keeps only active pinned memories
    const pinnedGraph = buildMemoryGraph(graphEntries, {
      ...DEFAULT_MEMORY_GRAPH_SETTINGS,
      pinnedOnly: true,
    })
    expect(pinnedGraph.memoryCount).toBe(2)

    // Physics simulation stays finite and deterministic on empty & populated graphs
    const emptySim = buildSimNodes(buildMemoryGraph([], DEFAULT_MEMORY_GRAPH_SETTINGS))
    stepGraphPhysics({
      simNodes: emptySim,
      edges: [],
      settings: DEFAULT_MEMORY_GRAPH_SETTINGS,
      alpha: 0.85,
      draggingNodeId: null,
      warmup: true,
    })
    expect(emptySim.size).toBe(0)

    const sim = buildSimNodes(graph)
    for (let i = 0; i < 30; i++) {
      stepGraphPhysics({
        simNodes: sim,
        edges: graph.edges,
        settings: DEFAULT_MEMORY_GRAPH_SETTINGS,
        alpha: 0.85,
        draggingNodeId: null,
        warmup: true,
      })
    }
    for (const node of sim.values()) {
      expect(Number.isFinite(node.x)).toBe(true)
      expect(Number.isFinite(node.y)).toBe(true)
    }
  })
})
