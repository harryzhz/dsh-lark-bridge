import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-session')>()
  return {
    ...actual,
    appendPluginRecord: vi.fn(),
  }
})

import { DreamingService } from '../src/dreaming-service.js'
import { MemoryService } from '../src/memory-service.js'
import { ObservabilityService } from '../src/observability-service.js'
import { RuntimeCatalog } from '../src/runtime-catalog.js'
import { LarkBridgeStore } from '../src/store.js'
import type { WorkspaceGrouping } from '../src/workspace-grouping.js'

const tempDirs: string[] = []

function makeTempDir(prefix = 'lark-listener-obs-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('Listener rules observability & Auto-Dream weekly rule reflection', () => {
  it('aggregates per-rule hits, replies, triage/worker silence, latencies, histograms, tokens, legacy rows, and 0-hit rules', () => {
    const dataDir = makeTempDir()
    const store = new LarkBridgeStore(dataDir)
    const nowMs = Date.UTC(2026, 10, 28, 12, 0, 0)

    store.upsertBot({
      id: 'bot-ops',
      name: 'OpsBot',
      enabled: true,
      larkAppId: 'app-demo-ops',
      larkAppSecret: 'sec_ops',
      defaultWorkingDir: '/tmp/demo-ops',
    })
    store.upsertGroup({
      botId: 'bot-ops',
      chatId: 'chat-alert',
      chatName: '线上告警群',
      enabled: true,
      listener: {
        enabled: true,
        templateKey: 'alert',
        name: '告警排查',
        prompt: '排查线上告警',
      },
    })
    store.upsertGroup({
      botId: 'bot-ops',
      chatId: 'chat-dormant',
      chatName: '低频发布群',
      enabled: true,
      listener: {
        enabled: true,
        templateKey: 'change',
        name: '变更观察',
        prompt: '观察变更',
      },
    })

    // 1. Worker reply (4.2s) + associated llm_step tokens
    store.recordMetric({
      botId: 'bot-ops',
      chatId: 'chat-alert',
      chatType: 'group',
      sessionId: 'sess-alert-1',
      trigger: 'listener',
      listenerName: '告警排查',
      kind: 'replied',
      latencyMs: 4_200,
      queueWaitMs: 200,
      execMs: 4_000,
      now: nowMs - 2 * 3_600_000,
    })
    store.recordUsageEvent({
      id: 'step:sess-alert-1:1',
      timestampMs: nowMs - 2 * 3_600_000,
      recordKind: 'llm_step',
      botId: 'bot-ops',
      chatId: 'chat-alert',
      chatType: 'group',
      sessionId: 'sess-alert-1',
      trigger: 'listener',
      model: 'gpt-5.4',
      outcome: 'completed',
      inputTokens: 1_200,
      outputTokens: 300,
      totalTokens: 1_500,
    })

    // 2. Triage quick_reply attributed to the listener rule (1.1s)
    store.recordMetric({
      botId: 'bot-ops',
      chatId: 'chat-alert',
      chatType: 'group',
      sessionId: 'triage-alert-quick',
      trigger: 'triage',
      listenerName: '告警排查',
      kind: 'replied',
      latencyMs: 1_100,
      queueWaitMs: 0,
      execMs: 1_100,
      now: nowMs - 90 * 60_000,
    })

    // 3. Triage silent skip (850ms) + triage tokens (must not double-count hit)
    store.recordUsageEvent({
      id: 'triage:triage-alert-sil',
      timestampMs: nowMs - 60 * 60_000,
      recordKind: 'triage',
      botId: 'bot-ops',
      chatId: 'chat-alert',
      chatType: 'group',
      sessionId: 'triage-alert-sil',
      trigger: 'triage',
      listenerName: '告警排查',
      outcome: 'silent',
      latencyMs: 850,
      inputTokens: 400,
      outputTokens: 50,
      totalTokens: 450,
    })
    store.recordMetric({
      botId: 'bot-ops',
      chatId: 'chat-alert',
      chatType: 'group',
      sessionId: 'triage-alert-sil',
      trigger: 'listener',
      listenerName: '告警排查',
      silenceSource: 'triage',
      kind: 'silent_skip',
      latencyMs: 850,
      queueWaitMs: 0,
      execMs: 850,
      now: nowMs - 60 * 60_000,
    })

    // 4. Worker silent skip (12.5s) + legacy row without listener_name / silence_source
    store.recordMetric({
      botId: 'bot-ops',
      chatId: 'chat-alert',
      chatType: 'group',
      sessionId: 'sess-alert-sil',
      trigger: 'listener',
      listenerName: '告警排查',
      silenceSource: 'control',
      kind: 'silent_skip',
      latencyMs: 12_500,
      queueWaitMs: 0,
      execMs: 12_500,
      now: nowMs - 40 * 60_000,
    })
    store.recordUsageEvent({
      id: 'legacy:alert-sil:1',
      timestampMs: nowMs - 30 * 60_000,
      recordKind: 'turn',
      botId: 'bot-ops',
      chatId: 'chat-alert',
      chatType: 'group',
      sessionId: 'triage-legacy-9',
      trigger: 'listener',
      outcome: 'silent_skip',
      latencyMs: 650,
    })

    // 5. Delegation observer rule
    store.recordMetric({
      botId: 'bot-ops',
      chatId: 'chat-alert',
      chatType: 'group',
      sessionId: 'sess-del-1',
      trigger: 'listener',
      listenerName: '委派事项跟进',
      silenceSource: 'delegation',
      kind: 'silent_skip',
      latencyMs: 2_300,
      now: nowMs - 20 * 60_000,
    })

    // 6. Previous week hit for week-over-week comparison
    store.recordMetric({
      botId: 'bot-ops',
      chatId: 'chat-alert',
      chatType: 'group',
      sessionId: 'sess-prev-week',
      trigger: 'listener',
      listenerName: '告警排查',
      kind: 'replied',
      latencyMs: 3_000,
      now: nowMs - 9 * 24 * 3_600_000,
    })

    const agg = store.queryObservabilityAggregate({ window: '24h', nowMs })
    expect(agg.listeners.configuredRules).toBe(2)
    expect(agg.listeners.activeRules).toBe(2)
    expect(agg.listeners.totalHits).toBe(6)
    expect(agg.listeners.totalReplied).toBe(2)
    expect(agg.listeners.totalSilentSkipped).toBe(4)
    expect(agg.listeners.totalTriageSilent).toBe(2) // explicit triage + legacy triage-*
    expect(agg.listeners.totalWorkerSilent).toBe(2) // control + delegation
    expect(agg.listeners.totalTokens).toBe(1_950)
    expect(agg.listeners.latencySamples).toBe(6)
    expect(agg.listeners.latencyHistogram.reduce((s, b) => s + b.count, 0)).toBe(6)

    const alertRule = agg.listeners.rules.find((r) => r.ruleName === '告警排查')
    expect(alertRule).toBeDefined()
    expect(alertRule!.hits).toBe(5)
    expect(alertRule!.replied).toBe(2)
    expect(alertRule!.silentSkipped).toBe(3)
    expect(alertRule!.triageSilent).toBe(2)
    expect(alertRule!.workerSilent).toBe(1)
    expect(alertRule!.silentRate).toBe(60)
    expect(alertRule!.repliedAvgLatencyMs).toBe(2_650)
    expect(alertRule!.silentAvgLatencyMs).toBe(4_667)
    expect(alertRule!.totalTokens).toBe(1_950)

    const delegationRule = agg.listeners.rules.find((r) => r.ruleName === '委派事项跟进')
    expect(delegationRule).toBeDefined()
    expect(delegationRule!.kind).toBe('delegation')
    expect(delegationRule!.silentSkipped).toBe(1)

    const dormantRule = agg.listeners.rules.find((r) => r.ruleName === '变更观察')
    expect(dormantRule).toBeDefined()
    expect(dormantRule!.hits).toBe(0)
    expect(dormantRule!.enabled).toBe(true)

    const weekly = store.queryWeeklyListenerComparison('bot-ops', nowMs)
    expect(weekly.current.totalHits).toBe(6)
    expect(weekly.previous.totalHits).toBe(1)
  })

  it('runs weekly listener rule reflection in Auto-Dream on a 7-day cadence and surfaces latestReflection in Observability', async () => {
    const baseDir = makeTempDir('lark-dream-reflection-')
    const dataDir = join(baseDir, 'lark-bridge')
    const workDir = join(baseDir, 'workspace')
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(workDir, { recursive: true })

    const store = new LarkBridgeStore(dataDir)
    const memory = new MemoryService(dataDir, store)

    store.upsertBot({
      id: 'bot-reflect',
      name: 'ReflectBot',
      enabled: true,
      larkAppId: 'app-demo-reflect',
      larkAppSecret: 'sec_reflect',
      defaultWorkingDir: workDir,
      experimental: {
        dreaming: {
          enabled: true,
          scheduleTime: '03:00',
          minNewSessions: 2,
          deepConsolidation: true,
          weeklyRuleReflection: true,
        },
        proactive: {
          remindersEnabled: false,
          reminderCreationMode: 'silent',
          autoCodeEnabled: false,
          branchPrefix: 'agent/',
        },
      },
    })
    store.upsertGroup({
      botId: 'bot-reflect',
      chatId: 'chat-noisy',
      chatName: '告警播报群',
      enabled: true,
      listener: {
        enabled: true,
        templateKey: 'alert',
        name: '告警排查',
        prompt: '排查告警',
        debounceSeconds: 3,
      },
    })

    const day1 = new Date(2026, 10, 28, 3, 5, 0)
    for (let i = 0; i < 6; i += 1) {
      store.recordMetric({
        botId: 'bot-reflect',
        chatId: 'chat-noisy',
        chatType: 'group',
        sessionId: `sess-noisy-${i}`,
        trigger: 'listener',
        listenerName: '告警排查',
        silenceSource: 'sentinel',
        kind: 'silent_skip',
        latencyMs: 11_000,
        now: day1.getTime() - (i + 1) * 3_600_000,
      })
    }

    const receivedPrompts: string[] = []
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      get: vi.fn(() => undefined),
      agents: {
        create: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
          agent: { session: { id: sessionId } as unknown as Session },
          dispose: vi.fn(async () => {}),
        })),
      },
      sessions: { get: vi.fn(() => undefined) },
    } as unknown as Context

    const runtimes = {
      resolveAgentLaunch: vi.fn(async () => ({
        provider: 'demo',
        model: 'demo-model',
        mountPreset: vi.fn(async () => {}),
      })),
    } as unknown as RuntimeCatalog

    const workspaces = {
      attachSession: vi.fn(async () => {}),
      archiveSession: vi.fn(async () => {}),
    } as unknown as WorkspaceGrouping

    const dreaming = new DreamingService({
      ctx,
      dataDir,
      store,
      memory,
      runtimes,
      workspaces,
      runTurn: vi.fn(async (_agent, content) => {
        const text = content.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
        receivedPrompts.push(text)
        if (text.includes('stage="deep_consolidate"')) {
          return '规则反思：告警排查（告警播报群）近 7 天运行时静默 6/6（100%），建议开启群智能分流并将防抖提高至 10s。'
        }
        return '无新增长期记忆。'
      }),
    })

    // Run 1 (quiet scheduled night, 0 new sessions, but weekly reflection is due!):
    // skips empty Stage 1 and executes Stage 2 weekly rule reflection directly.
    const state1 = await dreaming.runForBot('bot-reflect', { force: false, now: day1 })
    expect(state1.status).toBe('succeeded')
    expect(state1.lastRuleReflectionDateKey).toBe('2026-11-28')
    expect(state1.proactiveStats?.ruleReflectionRan).toBe(true)
    expect(state1.proactiveStats?.rulesEvaluated).toBe(1)
    expect(state1.proactiveStats?.ruleSuggestionsCount).toBe(1)
    expect(state1.proactiveStats?.ruleReflectionSummary).toContain('告警排查')
    expect(receivedPrompts).toHaveLength(1)
    expect(receivedPrompts[0]).toContain('weekly_rule_reflection="true"')
    expect(receivedPrompts[0]).toContain('listener-rules-weekly.md')

    const reportPath = join(dataDir, 'dreaming', 'bot-reflect', 'listener-rules-weekly.md')
    expect(existsSync(reportPath)).toBe(true)
    const reportText = readFileSync(reportPath, 'utf8')
    expect(reportText).toContain('Weekly Listener Rule Effectiveness Audit')
    expect(reportText).toContain('Auto-Dream 反思与调优建议')
    expect(reportText).toContain('运行时空跑静默偏高')

    const journalPath = join(dataDir, 'dreaming', 'bot-reflect', 'DREAMS.md')
    expect(readFileSync(journalPath, 'utf8')).toContain('周度监听规则反思：评估 1 条规则')

    // Run 2 (2 days later, still 0 new sessions): within 7-day window -> skipped!
    const day3 = new Date(day1.getTime() + 2 * 24 * 3_600_000)
    const state2 = await dreaming.runForBot('bot-reflect', { force: false, now: day3 })
    expect(state2.status).toBe('skipped')
    expect(receivedPrompts).toHaveLength(1)

    // Run 3 (8 days later): 7-day cadence elapsed -> weekly rule reflection runs again!
    const day9 = new Date(day1.getTime() + 8 * 24 * 3_600_000)
    const state3 = await dreaming.runForBot('bot-reflect', { force: false, now: day9 })
    expect(state3.status).toBe('succeeded')
    expect(state3.proactiveStats?.ruleReflectionRan).toBe(true)
    expect(receivedPrompts).toHaveLength(2)

    // ObservabilityService exposes latestReflection under product.listeners
    const obs = new ObservabilityService({
      ctx,
      dataDir,
      store,
      listBotStatuses: () => [],
      getTransportDiagnostics: () => undefined,
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
        startedAtMs: day1.getTime(),
      }),
      getConcurrencyStats: () => ({ activeActors: 0, queuedTurns: 0 }),
      getConfiguredScheduleCount: () => 0,
      listSplitBrainAlerts: () => [],
      getDiagnosticAlerts: () => [],
    })
    const payload = await obs.getPayload({ window: '7d', botId: 'bot-reflect', nowMs: day9.getTime() })
    expect(payload.product.listeners.latestReflection).toBeDefined()
    expect(payload.product.listeners.latestReflection?.botId).toBe('bot-reflect')
    expect(payload.product.listeners.latestReflection?.evaluatedRules).toBe(1)
    expect(payload.product.listeners.latestReflection?.summary).toContain('告警排查')
    expect(payload.product.listeners.latestReflection?.sessionId).toBe(state3.lastSessionId)
  })
})
