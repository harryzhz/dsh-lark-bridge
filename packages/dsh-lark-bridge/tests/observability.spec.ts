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

    // Verify HTTP API routing and fail-closed checkpoint auth
    const fakeManager = {
      store,
      getObservability: (opts: Record<string, unknown>) => svc.getPayload(opts),
    }

    const obsRes = await dispatchLarkApiRequest(fakeCtx, fakeManager as never, {
      method: 'GET',
      path: '/api/lark-bridge/observability?window=24h',
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(obsRes.status).toBe(200)
    expect((obsRes.payload as { product: { tokens: { total: number } } }).product.tokens.total).toBe(
      5250,
    )

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
})
