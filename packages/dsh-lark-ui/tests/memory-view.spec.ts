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
  countMemoriesByHistoryStatus,
  countMemoriesByType,
  filterMemoryEntries,
  MEMORY_HISTORY_FILTERS,
  MEMORY_TYPE_FILTERS,
  partitionActiveMemories,
  resolveMemoryScopeLabel,
} from '../src/views/MemoryView.js'
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

describe('MemoryView helpers & memory API transport', () => {
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
    }),
    makeEntry({
      id: 'mem-2',
      botId: 'bot-a',
      type: 'user',
      scope: 'chat',
      scopeId: 'oc_dev',
      title: '群内回复结论先行',
      content: '先给核心结论与数字，再补充推导细节。',
      tags: ['style'],
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
    }),
    makeEntry({
      id: 'mem-4',
      botId: 'bot-b',
      type: 'reference',
      scope: 'chat',
      scopeId: 'oc_ops',
      title: '值班手册与看板入口',
      content: '参考 https://ops.example.com/runbook 排查超时告警。',
      tags: ['runbook'],
      pinned: true,
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

  it('resolves human-readable scope labels for bot, synced group, unknown chat, and workspace', () => {
    expect(resolveMemoryScopeLabel(entries[0]!, groups).label).toBe('全局')
    expect(resolveMemoryScopeLabel(entries[1]!, groups)).toEqual({
      label: '群聊 · 研发协作群',
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
      fullTitle: '/Users/demo/repo-alpha',
    })
  })

  it('computes accurate counts for active types and history statuses', () => {
    const active = entries.filter((e) => e.status === 'active')
    const history = entries.filter((e) => e.status !== 'active')
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
    expect(MEMORY_TYPE_FILTERS.map((f) => f.label)).toEqual(['全部', '纠偏', '偏好', '决策', '参考'])
    expect(MEMORY_HISTORY_FILTERS.map((f) => f.label)).toEqual(['全部', '已纠偏', '已归档'])
  })

  it('filters entries by bot scope, pane, semantic type, history status, and rich search fields', () => {
    expect(
      filterMemoryEntries({
        entries,
        botId: '',
        pane: 'active',
        typeFilter: 'all',
        historyFilter: 'all',
        query: '',
        bots,
        groups,
      }).map((e) => e.id),
    ).toEqual(['mem-1', 'mem-2', 'mem-3', 'mem-4'])

    expect(
      filterMemoryEntries({
        entries,
        botId: 'bot-a',
        pane: 'active',
        typeFilter: 'user',
        historyFilter: 'all',
        query: '',
        bots,
        groups,
      }).map((e) => e.id),
    ).toEqual(['mem-2'])

    // Matches resolved Chinese group name & tags & workspace leaf
    expect(
      filterMemoryEntries({
        entries,
        botId: '',
        pane: 'active',
        typeFilter: 'all',
        historyFilter: 'all',
        query: '研发协作群',
        bots,
        groups,
      }).map((e) => e.id),
    ).toEqual(['mem-2'])

    expect(
      filterMemoryEntries({
        entries,
        botId: '',
        pane: 'active',
        typeFilter: 'all',
        historyFilter: 'all',
        query: 'repo-alpha',
        bots,
        groups,
      }).map((e) => e.id),
    ).toEqual(['mem-3'])

    expect(
      filterMemoryEntries({
        entries,
        botId: '',
        pane: 'active',
        typeFilter: 'all',
        historyFilter: 'all',
        query: 'runbook',
        bots,
        groups,
      }).map((e) => e.id),
    ).toEqual(['mem-4'])

    // History pane filters by superseded/archived and matches supersedeReason
    expect(
      filterMemoryEntries({
        entries,
        botId: '',
        pane: 'history',
        typeFilter: 'all',
        historyFilter: 'superseded',
        query: 'sqlite',
        bots,
        groups,
      }).map((e) => e.id),
    ).toEqual(['mem-5'])

    expect(
      filterMemoryEntries({
        entries,
        botId: 'bot-b',
        pane: 'history',
        typeFilter: 'all',
        historyFilter: 'archived',
        query: '',
        bots,
        groups,
      }).map((e) => e.id),
    ).toEqual(['mem-6'])
  })

  it('partitions active memories cleanly into pinned core memories and regular memories', () => {
    const active = entries.filter((e) => e.status === 'active')
    const { pinned, normal } = partitionActiveMemories(active)
    expect(pinned.map((e) => e.id)).toEqual(['mem-1', 'mem-4'])
    expect(normal.map((e) => e.id)).toEqual(['mem-2', 'mem-3'])
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
})
