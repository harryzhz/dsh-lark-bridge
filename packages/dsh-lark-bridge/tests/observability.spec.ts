import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { dispatchLarkApiRequest } from '../src/http-api.js'
import { ObservabilityService } from '../src/observability-service.js'
import { P2P_CHAT_FILTER_VALUE } from '../src/storage/observability-repo.js'
import { LarkBridgeStore } from '../src/store.js'

const tempDirs: string[] = []

function makeTempDir(prefix = 'lark-obs-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('ObservabilityRepo, ObservabilityService & HTTP endpoints', () => {
  it('records idempotent token usage, aggregates across windows/bot/chat/p2p, and calculates percentiles & deltas', async () => {
    const baseDir = makeTempDir()
    const dataDir = join(baseDir, 'lark-bridge')
    mkdirSync(dataDir, { recursive: true })
    const store = new LarkBridgeStore(dataDir)
    const nowMs = Date.UTC(2026, 10, 25, 14, 30, 0)

    store.upsertBot({
      id: 'bot-alpha',
      name: 'Alpha Bot',
      larkAppId: 'cli_alpha',
      larkAppSecret: 'sec_alpha',
      defaultWorkingDir: '/Users/demo/alpha',
      agentPreset: 'codex',
      model: 'gpt-5.4',
    })
    store.upsertBot({
      id: 'bot-beta',
      name: 'Beta Bot',
      larkAppId: 'cli_beta',
      larkAppSecret: 'sec_beta',
      defaultWorkingDir: '/Users/demo/beta',
      agentPreset: 'claude',
      model: 'claude-sonnet',
    })
    store.upsertGroup({
      botId: 'bot-alpha',
      chatId: 'oc_group_a',
      chatName: 'Engineering Room',
      enabled: true,
    })

    // Idempotent insert test (same id must only count once)
    const stepEvent = {
      id: 'step:sess-1:10',
      timestampMs: nowMs - 2 * 3_600_000,
      recordKind: 'llm_step' as const,
      botId: 'bot-alpha',
      chatId: 'oc_group_a',
      chatType: 'group' as const,
      sessionId: 'sess-1',
      trigger: 'mention',
      agentPreset: 'codex',
      provider: 'openai',
      model: 'gpt-5.4',
      outcome: 'completed',
      inputTokens: 1000,
      cacheReadTokens: 3000,
      cacheWriteTokens: 0,
      outputTokens: 500,
      reasoningTokens: 120,
      toolCalls: 2,
    }
    expect(store.recordUsageEvent(stepEvent)).toBe(true)
    expect(store.recordUsageEvent(stepEvent)).toBe(false)

    // Previous window step for delta calculation (8 days ago for 7d window)
    store.recordUsageEvent({
      ...stepEvent,
      id: 'step:sess-prev:1',
      timestampMs: nowMs - 8 * 24 * 3_600_000,
      sessionId: 'sess-prev',
      inputTokens: 1000,
      cacheReadTokens: 1000,
      outputTokens: 250,
    })

    // Group turn replies with latencies
    store.recordMetric({
      botId: 'bot-alpha',
      chatId: 'oc_group_a',
      chatType: 'group',
      sessionId: 'sess-1',
      trigger: 'mention',
      kind: 'inbound',
      now: nowMs - 2 * 3_600_000,
    })
    store.recordMetric({
      botId: 'bot-alpha',
      chatId: 'oc_group_a',
      chatType: 'group',
      sessionId: 'sess-1',
      trigger: 'mention',
      kind: 'replied',
      latencyMs: 1200,
      now: nowMs - 2 * 3_600_000,
    })
    store.recordMetric({
      botId: 'bot-alpha',
      chatId: 'oc_group_a',
      chatType: 'group',
      sessionId: 'sess-1',
      trigger: 'mention',
      kind: 'replied',
      latencyMs: 15000,
      now: nowMs - 3_600_000,
    })
    store.recordMetric({
      botId: 'bot-alpha',
      chatId: 'oc_group_a',
      chatType: 'group',
      sessionId: 'sess-1',
      trigger: 'mention',
      kind: 'error',
      errorCode: 'timeout',
      now: nowMs - 1_800_000,
    })

    // P2P traffic on bot-beta
    store.recordUsageEvent({
      id: 'step:sess-p2p:3',
      timestampMs: nowMs - 3_600_000,
      recordKind: 'llm_step',
      botId: 'bot-beta',
      chatId: 'oc_p2p_1',
      chatType: 'p2p',
      sessionId: 'sess-p2p',
      trigger: 'p2p',
      agentPreset: 'claude',
      provider: 'anthropic',
      model: 'claude-sonnet',
      outcome: 'completed',
      inputTokens: 400,
      cacheReadTokens: 600,
      outputTokens: 200,
    })

    // Seed canonical sibling DSH directories to verify storage breakdown
    mkdirSync(join(baseDir, 'sessions', 'ws-demo'), { recursive: true })
    writeFileSync(join(baseDir, 'sessions', 'ws-demo', 'log.bin'), Buffer.alloc(4096))
    mkdirSync(join(baseDir, 'attachments'), { recursive: true })
    writeFileSync(join(baseDir, 'attachments', 'img.bin'), Buffer.alloc(2048))

    const fakeCtx = { get: () => undefined } as unknown as Context
    const svc = new ObservabilityService({
      ctx: fakeCtx,
      dataDir,
      store,
      startedAtMs: nowMs - 3_600_000,
      enableBackgroundTimers: false,
      listBotStatuses: () => [
        {
          botId: 'bot-alpha',
          name: 'Alpha Bot',
          larkAppId: 'cli_alpha',
          enabled: true,
          connected: true,
          activeBindings: 1,
        },
        {
          botId: 'bot-beta',
          name: 'Beta Bot',
          larkAppId: 'cli_beta',
          enabled: true,
          connected: false,
          activeBindings: 0,
        },
      ],
      getTransportDiagnostics: (id) =>
        id === 'bot-alpha'
          ? { ackP50Ms: 42, ackP95Ms: 118, ackSamples: 12, sdkErrors: [] }
          : undefined,
      listSplitBrainAlerts: () => [],
      getLifecycleStatus: () => ({
        phase: 'running',
        draining: false,
        drained: true,
        activeTurns: [],
        activeTriageCount: 0,
        activeRemindersCount: 0,
        activeDreamingCount: 0,
        totalInFlight: 0,
        persistedPendingTurns: 0,
        pid: process.pid,
        startedAtMs: nowMs - 3_600_000,
      }),
      getConcurrencyStats: () => ({ activeActors: 1, queuedTurns: 0 }),
      getDiagnosticAlerts: () => [],
      getConfiguredScheduleCount: () => 2,
    })

    const allPayload = await svc.getPayload({ window: '7d', nowMs })
    expect(allPayload.series).toHaveLength(28)
    // Total tokens = 4500 (alpha) + 1200 (beta) = 5700; prev = 2250 -> +153.3%
    expect(allPayload.product.tokens.total).toBe(5700)
    expect(allPayload.product.tokens.cacheRead).toBe(3600)
    expect(allPayload.product.tokens.cacheHitRate).toBe(72)
    expect(allPayload.product.tokens.deltaPct).toBe(153.3)
    expect(allPayload.product.models).toHaveLength(2)
    expect(allPayload.product.models[0]?.agents).toEqual(['codex'])
    expect(allPayload.product.agents).toHaveLength(2)
    expect(allPayload.product.agents[0]?.agentKey).toBe('codex')
    expect(allPayload.product.agents[0]?.totalTokens).toBe(4500)
    expect(allPayload.product.agents[0]?.models[0]?.model).toBe('gpt-5.4')
    expect(allPayload.product.agents[1]?.agentKey).toBe('claude')
    expect(allPayload.product.chatRanking[0]?.cacheReadTokens).toBe(3000)
    expect(allPayload.product.chatRanking[0]?.topModels?.[0]?.model).toBe('gpt-5.4')
    expect(allPayload.product.botRanking[0]?.inputTokens).toBe(1000)
    expect(allPayload.product.botRanking[0]?.topModels?.[0]?.model).toBe('gpt-5.4')
    expect(allPayload.technical.latency.samples).toBe(2)
    expect(allPayload.technical.latency.p50Ms).toBe(1200)
    expect(allPayload.technical.latency.p95Ms).toBe(15000)
    expect(allPayload.technical.sla.totalErrors).toBe(1)
    expect(allPayload.technical.sla.successRate).toBe(66.7)
    expect(allPayload.technical.connections.onlineBots).toBe(1)
    expect(allPayload.technical.connections.avgAckP50Ms).toBe(42)
    expect(allPayload.technical.storage.dshBytes).toBeGreaterThanOrEqual(6144)
    expect(
      allPayload.technical.storage.categories.every((c) => !c.pathLabel.includes(baseDir)),
    ).toBe(true)

    // Filter by bot-alpha only
    const alphaOnly = await svc.getPayload({ window: '24h', botId: 'bot-alpha', nowMs })
    expect(alphaOnly.series).toHaveLength(24)
    expect(alphaOnly.product.tokens.total).toBe(4500)
    expect(alphaOnly.product.models).toHaveLength(1)

    // Filter by P2P only
    const p2pOnly = await svc.getPayload({
      window: '7d',
      chatId: P2P_CHAT_FILTER_VALUE,
      nowMs,
    })
    expect(p2pOnly.product.tokens.total).toBe(1200)
    expect(p2pOnly.product.models[0]?.model).toBe('claude-sonnet')

    store.close()
  })

  it('captures live session/event tokens and backfills historical persisted sessions without double-counting', async () => {
    const dataDir = makeTempDir('lark-obs-live-')
    const store = new LarkBridgeStore(dataDir)
    const nowMs = Date.now()

    store.upsertBot({
      id: 'bot-live',
      name: 'Live Bot',
      larkAppId: 'cli_live',
      larkAppSecret: 'sec_live',
      defaultWorkingDir: '/Users/demo/live',
      agentPreset: 'codex',
      model: 'gpt-5.4',
    })
    store.upsertBinding({
      routeKey: 'bot-live:oc_room:main',
      sessionId: 'sess-live-1',
      botId: 'bot-live',
      larkAppId: 'cli_live',
      chatType: 'group',
      chatId: 'oc_room',
      chatName: 'Live Room',
      workspaceName: 'live',
      agentPreset: 'codex',
      model: 'gpt-5.4',
      workingDir: '/Users/demo/live',
      trigger: 'mention',
      createdAtMs: nowMs - 60_000,
      lastActivityMs: nowMs - 10_000,
    })
    store.upsertManagedSession({
      sessionId: 'sess-hist-1',
      botId: 'bot-live',
      chatId: 'oc_room',
      trigger: 'mention',
      createdAtMs: nowMs - 3_600_000,
      lastActivityMs: nowMs - 3_500_000,
    })

    let sessionEventListener: ((session: Session, event: SessionEvent) => void) | undefined
    const persistedEvents: Record<string, SessionEvent[]> = {
      'sess-hist-1': [
        {
          type: 'request/header',
          seq: 1 as never,
          time: nowMs - 3_550_000,
          data: { header: { config: { provider: 'deepseek', model: 'deepseek-reasoner' } } },
        } as unknown as SessionEvent,
        {
          type: 'assistant/message',
          seq: 2 as never,
          time: nowMs - 3_540_000,
          data: {
            turn: 1,
            step: 1,
            message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', input: {} }] },
            stream: [],
            usage: {
              inputTokens: 800,
              outputTokens: 300,
              cacheReadTokens: 2200,
              reasoningTokens: 150,
            },
          },
        } as unknown as SessionEvent,
        {
          type: 'tool/result',
          seq: 3 as never,
          time: nowMs - 3_530_000,
          data: { isError: true, name: 'bash' },
        } as unknown as SessionEvent,
      ],
      'sess-live-1': [
        {
          type: 'assistant/message',
          seq: 5 as never,
          time: nowMs - 5_000,
          data: {
            turn: 1,
            step: 1,
            message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
            stream: [],
            usage: { inputTokens: 500, outputTokens: 100, cacheReadTokens: 1000 },
          },
        } as unknown as SessionEvent,
      ],
    }

    const fakePersistence = {
      open: async (id: string) => ({
        read: async (offset = 0, len = 300) => ({
          events: (persistedEvents[id] ?? []).slice(offset, offset + len),
        }),
        close: async () => {},
      }),
    }

    const fakeCtx = {
      on: (name: string, fn: (session: Session, event: SessionEvent) => void) => {
        if (name === 'session/event') sessionEventListener = fn
        return () => {
          sessionEventListener = undefined
        }
      },
      get: (name: string) => (name === 'sessionPersistence' ? fakePersistence : undefined),
    } as unknown as Context

    const svc = new ObservabilityService({
      ctx: fakeCtx,
      dataDir,
      store,
      startedAtMs: nowMs - 60_000,
      enableBackgroundTimers: false,
      listBotStatuses: () => [],
      getTransportDiagnostics: () => undefined,
      listSplitBrainAlerts: () => [],
      getLifecycleStatus: () => ({
        phase: 'running',
        draining: false,
        drained: true,
        activeTurns: [],
        activeTriageCount: 0,
        activeRemindersCount: 0,
        activeDreamingCount: 0,
        totalInFlight: 0,
        persistedPendingTurns: 0,
        pid: process.pid,
        startedAtMs: nowMs - 60_000,
      }),
      getConcurrencyStats: () => ({ activeActors: 0, queuedTurns: 0 }),
      getDiagnosticAlerts: () => [],
      getConfiguredScheduleCount: () => 0,
    })

    const dispose = svc.install()

    // Live events on sess-live-1
    const liveSession = { id: 'sess-live-1' } as unknown as Session
    sessionEventListener?.(liveSession, {
      type: 'request/header',
      seq: 4 as never,
      time: nowMs - 6_000,
      data: { header: { config: { provider: 'openai', model: 'gpt-5.4' } } },
    } as unknown as SessionEvent)
    sessionEventListener?.(liveSession, persistedEvents['sess-live-1']![0]!)

    // Triage recorded directly with usage
    svc.recordTriageEvaluation({
      botId: 'bot-live',
      chatId: 'oc_room',
      triageSessionId: 'triage-1',
      action: 'quick_reply',
      provider: 'deepseek',
      model: 'deepseek-chat',
      durationMs: 420,
      usage: { inputTokens: 200, outputTokens: 50, cacheReadTokens: 100 },
      timestampMs: nowMs - 4_000,
    })

    // Run backfill twice: must pick up sess-hist-1 once and NOT double-count sess-live-1
    await svc.triggerBackfill()
    await svc.triggerBackfill()

    const payload = await svc.getPayload({ window: '24h', nowMs })
    // hist (3300) + live (1600) + triage (350) = 5250
    expect(payload.product.tokens.total).toBe(5250)
    expect(payload.product.traffic.toolCalls).toBe(1)
    expect(payload.product.traffic.toolErrors).toBe(1)
    expect(payload.product.triage.total).toBe(1)
    expect(payload.product.triage.quickReply).toBe(1)
    expect(payload.product.triage.deflectRate).toBe(100)
    expect(payload.backfill.completed).toBe(true)

    // Verify HTTP API routing, API timing capture, DB perf telemetry, and fail-closed checkpoint auth
    const fakeManager = {
      store,
      getObservability: (opts: Record<string, unknown>) => svc.getPayload(opts),
      recordApiTiming: (route: string, ms: number) => svc.recordApiTiming(route, ms),
    }

    // Default window is 24h when omitted
    const defaultWindowRes = await dispatchLarkApiRequest(fakeCtx, fakeManager as never, {
      method: 'GET',
      path: '/api/lark-bridge/observability',
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(defaultWindowRes.status).toBe(200)
    expect((defaultWindowRes.payload as { window: string }).window).toBe('24h')

    const obsRes = await dispatchLarkApiRequest(fakeCtx, fakeManager as never, {
      method: 'GET',
      path: '/api/lark-bridge/observability?window=24h',
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(obsRes.status).toBe(200)
    const obsPayload = obsRes.payload as {
      product: { tokens: { total: number } }
      technical: {
        database: {
          totalQueries: number
          sampleCount: number
          p50Ms: number
          p95Ms: number
          slowQueries: Array<{ fingerprint: string; count: number }>
          apiRoutes: Array<{ route: string; count: number }>
        }
      }
    }
    expect(obsPayload.product.tokens.total).toBe(5250)
    expect(obsPayload.technical.database.totalQueries).toBeGreaterThan(0)
    expect(obsPayload.technical.database.sampleCount).toBeGreaterThan(0)
    expect(obsPayload.technical.database.slowQueries.length).toBeGreaterThan(0)
    expect(
      obsPayload.technical.database.apiRoutes.some((r) => r.route === 'GET /observability'),
    ).toBe(true)

    // Verify O(1) session ownership lookups & cached integrity check
    expect(store.hasDreamSession('sess-live-1')).toBe(false)
    expect(store.getBindingBySessionId('sess-live-1')?.botId).toBe('bot-live')
    expect(store.findReminderOriginBySessionId('sess-live-1')).toBeUndefined()
    const check1 = store.runIntegrityCheck()
    const check2 = store.runIntegrityCheck()
    expect(check1.ok).toBe(true)
    expect(check2.ok).toBe(true)

    const cliCheckpointRes = await dispatchLarkApiRequest(fakeCtx, fakeManager as never, {
      method: 'POST',
      path: '/api/lark-bridge/observability/checkpoint',
      isCliAuthenticated: true,
      principalKind: 'owner',
    })
    expect(cliCheckpointRes.status).toBe(403)

    const ownerCheckpointRes = await dispatchLarkApiRequest(fakeCtx, fakeManager as never, {
      method: 'POST',
      path: '/api/lark-bridge/observability/checkpoint',
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(ownerCheckpointRes.status).toBe(200)
    expect((ownerCheckpointRes.payload as { ok: boolean }).ok).toBe(true)

    dispose()
    store.close()
  })

  it('captures concrete external-agent model from message.source/model.selection, repairs historical empty models, and never fabricates "<agent> (default)"', async () => {
    const dataDir = makeTempDir('lark-obs-model-repair-')
    const store = new LarkBridgeStore(dataDir)
    const nowMs = Date.now()

    store.upsertBot({
      id: 'bot-ext',
      name: 'Ext Bot',
      larkAppId: 'cli_ext',
      larkAppSecret: 'sec_ext',
      defaultWorkingDir: '/Users/demo/ext',
      agentPreset: 'agy',
    })
    store.upsertGroup({
      botId: 'bot-ext',
      chatId: 'oc_alert',
      chatName: 'Alert Room',
      enabled: true,
    })

    // Simulate a reminder session with no explicit binding.model (only managed_sessions)
    store.upsertManagedSession({
      sessionId: 'sess-rem-live',
      botId: 'bot-ext',
      chatId: 'oc_alert',
      trigger: 'reminder',
      createdAtMs: nowMs - 30_000,
      lastActivityMs: nowMs - 10_000,
    })

    // Pre-seed legacy rows: one reminder session with empty model & provider + high watermark,
    // and one legacy row of same model with empty provider to verify model deduplication.
    store.recordUsageEvent({
      id: 'step:sess-rem-old:8',
      timestampMs: nowMs - 120_000,
      recordKind: 'llm_step',
      botId: 'bot-ext',
      chatId: 'oc_alert',
      chatType: 'group',
      sessionId: 'sess-rem-old',
      trigger: 'reminder',
      agentPreset: 'codex',
      provider: '',
      model: '',
      outcome: 'completed',
      inputTokens: 1200,
      cacheReadTokens: 800,
      outputTokens: 100,
    })
    store.observabilityRepo.setSessionWatermark('sess-rem-old', 99, nowMs - 120_000)

    store.recordUsageEvent({
      id: 'step:sess-legacy-merge:3',
      timestampMs: nowMs - 110_000,
      recordKind: 'llm_step',
      botId: 'bot-ext',
      chatId: 'oc_alert',
      chatType: 'group',
      sessionId: 'sess-legacy-merge',
      trigger: 'mention',
      agentPreset: 'codex',
      provider: '',
      model: 'gpt-6.1-sol',
      outcome: 'completed',
      inputTokens: 500,
      cacheReadTokens: 500,
      outputTokens: 50,
    })
    store.observabilityRepo.setSessionWatermark('sess-legacy-merge', 99, nowMs - 110_000)

    // Tool-error marker row with 0 tokens should not pollute model or agent breakdown
    store.recordUsageEvent({
      id: 'toolerr:sess-rem-old:9',
      timestampMs: nowMs - 119_000,
      recordKind: 'llm_step',
      botId: 'bot-ext',
      chatId: 'oc_alert',
      chatType: 'group',
      sessionId: 'sess-rem-old',
      trigger: 'reminder',
      agentPreset: 'codex',
      provider: '',
      model: '',
      outcome: 'completed',
      errorCode: 'tool_error',
      toolErrors: 1,
    })

    // Orphaned session whose log no longer exists and has empty model must NEVER become "agy (default)"
    store.recordUsageEvent({
      id: 'step:sess-deleted:1',
      timestampMs: nowMs - 100_000,
      recordKind: 'llm_step',
      botId: 'bot-ext',
      chatId: 'oc_alert',
      chatType: 'group',
      sessionId: 'sess-deleted',
      trigger: 'mention',
      agentPreset: 'agy',
      provider: '',
      model: '',
      outcome: 'completed',
      inputTokens: 100,
      outputTokens: 20,
    })

    const persistedSessions: Record<
      string,
      { header?: { agentPreset?: string }; events: SessionEvent[] }
    > = {
      'sess-rem-old': {
        header: { agentPreset: 'codex' },
        events: [
          {
            type: 'model/selection',
            seq: 5 as never,
            time: nowMs - 125_000,
            data: { provider: 'codex-cli', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' },
          } as unknown as SessionEvent,
          {
            type: 'assistant/message',
            seq: 8 as never,
            time: nowMs - 120_000,
            data: {
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'done' }],
                source: { kind: 'model', provider: 'codex-cli', model: 'gpt-6.1-sol' },
              },
              usage: { inputTokens: 1200, cacheReadTokens: 800, outputTokens: 100 },
            },
          } as unknown as SessionEvent,
        ],
      },
    }

    let sessionEventListener: ((session: Session, event: SessionEvent) => void) | undefined
    const fakePersistence = {
      open: async (id: string) => {
        const entry = persistedSessions[id]
        if (!entry) throw new Error('ENOENT')
        return {
          header: entry.header ?? {},
          read: async (offset = 0, len = 300) => ({
            events: entry.events.slice(offset, offset + len),
          }),
          close: async () => {},
        }
      },
    }

    const fakeCtx = {
      on: (name: string, fn: (session: Session, event: SessionEvent) => void) => {
        if (name === 'session/event') sessionEventListener = fn
        return () => {
          sessionEventListener = undefined
        }
      },
      get: (name: string) => (name === 'sessionPersistence' ? fakePersistence : undefined),
    } as unknown as Context

    const svc = new ObservabilityService({
      ctx: fakeCtx,
      dataDir,
      store,
      startedAtMs: nowMs - 60_000,
      enableBackgroundTimers: false,
      listBotStatuses: () => [],
      getTransportDiagnostics: () => undefined,
      listSplitBrainAlerts: () => [],
      getLifecycleStatus: () => ({
        phase: 'running',
        draining: false,
        drained: true,
        activeTurns: [],
        activeTriageCount: 0,
        activeRemindersCount: 0,
        activeDreamingCount: 0,
        totalInFlight: 0,
        persistedPendingTurns: 0,
        pid: process.pid,
        startedAtMs: nowMs - 60_000,
      }),
      getConcurrencyStats: () => ({ activeActors: 0, queuedTurns: 0 }),
      getDiagnosticAlerts: () => [],
      getConfiguredScheduleCount: () => 0,
    })

    const dispose = svc.install()

    // Live external-agent session emitting model/selection + assistant/message.source (no request/header!)
    const liveSession = {
      id: 'sess-rem-live',
      header: { agentPreset: 'agy' },
    } as unknown as Session
    sessionEventListener?.(liveSession, {
      type: 'model/selection',
      seq: 3 as never,
      time: nowMs - 20_000,
      data: { provider: 'agy-cli', model: 'gemini-4-carbon' },
    } as unknown as SessionEvent)
    sessionEventListener?.(liveSession, {
      type: 'assistant/message',
      seq: 4 as never,
      time: nowMs - 15_000,
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'checked' }],
          source: { kind: 'model', provider: 'agy-cli', model: 'gemini-4-carbon' },
        },
        usage: { inputTokens: 2000, cacheReadTokens: 3000, outputTokens: 200 },
      },
    } as unknown as SessionEvent)

    // Triage evaluation for Agent dimension check
    svc.recordTriageEvaluation({
      botId: 'bot-ext',
      chatId: 'oc_alert',
      triageSessionId: 'triage-ext-1',
      action: 'silent',
      provider: 'native-prov',
      model: 'deepseek-v4.1-flash',
      durationMs: 220,
      usage: { inputTokens: 300, outputTokens: 20 },
      timestampMs: nowMs - 5_000,
    })

    await svc.triggerBackfill()

    const payload = await svc.getPayload({ window: '24h', nowMs })
    // Never fabricate "<agent> (default)"
    expect(payload.product.models.some((m) => m.model.includes('(default)'))).toBe(false)

    // Repaired sess-rem-old (2100) merged with sess-legacy-merge (1050) under single gpt-6.1-sol row = 3150
    const sol = payload.product.models.find((m) => m.model === 'gpt-6.1-sol')
    expect(sol).toBeDefined()
    expect(sol?.totalTokens).toBe(3150)
    expect(sol?.steps).toBe(2)
    expect(sol?.agents).toEqual(['codex'])

    // Live reminder captured exact gemini-4-carbon from message.source
    const carbon = payload.product.models.find((m) => m.model === 'gemini-4-carbon')
    expect(carbon).toBeDefined()
    expect(carbon?.totalTokens).toBe(5200)
    expect(carbon?.provider).toBe('agy-cli')
    expect(carbon?.agents).toEqual(['agy'])

    // Orphaned empty model stays empty string (never "agy (default)")
    const unattributed = payload.product.models.find((m) => m.model === '')
    expect(unattributed?.totalTokens).toBe(120)

    // Agent dimension aggregates cleanly across agy, codex, and triage
    const agyAgent = payload.product.agents.find((a) => a.agentKey === 'agy')
    const codexAgent = payload.product.agents.find((a) => a.agentKey === 'codex')
    const triageAgent = payload.product.agents.find((a) => a.agentKey === '__triage__')
    expect(agyAgent?.totalTokens).toBe(5320)
    expect(agyAgent?.models.map((m) => m.model)).toEqual(['gemini-4-carbon'])
    expect(codexAgent?.totalTokens).toBe(3150)
    expect(codexAgent?.steps).toBe(2)
    expect(codexAgent?.models.map((m) => m.model)).toEqual(['gpt-6.1-sol'])
    expect(triageAgent?.kind).toBe('triage')
    expect(triageAgent?.totalTokens).toBe(320)
    expect(triageAgent?.models.map((m) => m.model)).toEqual(['deepseek-v4.1-flash'])

    dispose()
    store.close()
  })
})
