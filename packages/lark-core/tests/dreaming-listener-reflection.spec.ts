import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BOT_DREAMING_CONFIG,
  composeDreamDeepConsolidationPrompt,
  diagnoseListenerRuleWeekly,
  renderListenerRuleWeeklyReport,
  type ListenerRuleWeeklyMetric,
} from '../src/index.js'

function makeRule(overrides: Partial<ListenerRuleWeeklyMetric> = {}): ListenerRuleWeeklyMetric {
  return {
    key: 'bot-1:chat-demo-1:告警排查',
    chatId: 'chat-demo-1',
    chatName: '线上值班群',
    ruleName: '告警排查',
    kind: 'group',
    enabled: true,
    hits: 10,
    replied: 6,
    silentSkipped: 4,
    triageSilent: 3,
    workerSilent: 1,
    errors: 0,
    replyRate: 60,
    silentRate: 40,
    totalTokens: 12_000,
    avgLatencyMs: 4_200,
    p50LatencyMs: 3_500,
    p95LatencyMs: 9_800,
    repliedAvgLatencyMs: 5_400,
    silentAvgLatencyMs: 1_200,
    latencySamples: 10,
    config: {
      scope: 'top_level',
      mentionFilter: 'exclude_peer',
      debounceSeconds: 5,
      allowSilentEmptyReply: true,
      sessionMode: 'thread',
      replyMode: 'new-topic',
      includeKeywords: [],
      excludeKeywords: [],
      routerEnabled: true,
    },
    ...overrides,
  }
}

describe('listener rule weekly reflection helpers', () => {
  it('diagnoses high worker silence, excessive silence, high latency, high error rate, and dormant rules', () => {
    const diagnoses = diagnoseListenerRuleWeekly([
      makeRule(),
      makeRule({
        key: 'bot-1:chat-demo-2:项目讨论',
        chatId: 'chat-demo-2',
        chatName: '产品研发群',
        ruleName: '项目讨论',
        hits: 12,
        replied: 2,
        silentSkipped: 10,
        triageSilent: 1,
        workerSilent: 9,
        silentRate: 83.3,
        silentAvgLatencyMs: 11_500,
        config: {
          scope: 'all',
          mentionFilter: 'all',
          debounceSeconds: 3,
          allowSilentEmptyReply: true,
          sessionMode: 'thread',
          replyMode: 'reply',
          includeKeywords: [],
          excludeKeywords: [],
          routerEnabled: false,
        },
      }),
      makeRule({
        key: 'bot-1:chat-demo-3:变更观察',
        chatId: 'chat-demo-3',
        chatName: '发布群',
        ruleName: '变更观察',
        hits: 20,
        replied: 2,
        silentSkipped: 18,
        triageSilent: 17,
        workerSilent: 1,
        silentRate: 90,
        silentAvgLatencyMs: 900,
        p95LatencyMs: 42_000,
        avgLatencyMs: 18_000,
        errors: 4,
      }),
      makeRule({
        key: 'bot-1:chat-demo-4:巡检提醒',
        chatId: 'chat-demo-4',
        chatName: '静默群',
        ruleName: '巡检提醒',
        hits: 0,
        replied: 0,
        silentSkipped: 0,
        triageSilent: 0,
        workerSilent: 0,
        silentRate: 0,
        latencySamples: 0,
        config: {
          scope: 'top_level',
          mentionFilter: 'exclude_all',
          debounceSeconds: 5,
          allowSilentEmptyReply: true,
          sessionMode: 'thread',
          replyMode: 'new-topic',
          includeKeywords: ['P0'],
          excludeKeywords: [],
          routerEnabled: true,
        },
      }),
    ])

    const kinds = diagnoses.map((d) => `${d.ruleName}:${d.kind}`)
    expect(kinds).toContain('项目讨论:high_worker_silent')
    expect(kinds).toContain('变更观察:excessive_silence')
    expect(kinds).toContain('变更观察:high_latency')
    expect(kinds).toContain('变更观察:high_error_rate')
    expect(kinds).toContain('巡检提醒:dormant_rule')
    expect(kinds.some((k) => k.startsWith('告警排查:'))).toBe(false)
  })

  it('renders a structured weekly markdown report with week-over-week delta and config snapshot', () => {
    const nowMs = Date.UTC(2026, 10, 28, 3, 0, 0)
    const { markdown, diagnoses } = renderListenerRuleWeeklyReport({
      botId: 'bot-1',
      botName: 'OpsBot',
      nowMs,
      fromMs: nowMs - 7 * 86_400_000,
      toMs: nowMs,
      totalHits: 25,
      totalReplied: 5,
      totalSilentSkipped: 20,
      totalTriageSilent: 4,
      totalWorkerSilent: 16,
      totalErrors: 0,
      silentRate: 80,
      p50LatencyMs: 4_500,
      p95LatencyMs: 16_000,
      totalTokens: 54_200,
      prevHits: 18,
      prevSilentRate: 62,
      rules: [
        makeRule({
          hits: 25,
          replied: 5,
          silentSkipped: 20,
          triageSilent: 4,
          workerSilent: 16,
          silentRate: 80,
          silentAvgLatencyMs: 9_600,
        }),
      ],
    })

    expect(diagnoses).toHaveLength(1)
    expect(markdown).toContain('Weekly Listener Rule Effectiveness Audit')
    expect(markdown).toContain('命中较上周 +7（上周 18）')
    expect(markdown).toContain('静默率 +18pp')
    expect(markdown).toContain('规则当前配置快照')
    expect(markdown).toContain('运行时空跑静默偏高')
  })

  it('composes Stage 2 prompt for combined audit and rule-reflection-only mode with config safety guardrail', () => {
    const combined = composeDreamDeepConsolidationPrompt({
      botId: 'bot-1',
      botName: 'OpsBot',
      workingDir: '/tmp/workspace',
      currentDateIso: '2026-11-28',
      memoryMarkdownPath: '/tmp/data/memory/bot-1/MEMORY.md',
      memoryAuditPath: '/tmp/data/dreaming/bot-1/memory-audit.md',
      activeMemoryCount: 6,
      listenerRuleReportPath: '/tmp/data/dreaming/bot-1/listener-rules-weekly.md',
      listenerRulesEvaluated: 3,
      listenerRuleDiagnosesCount: 2,
      config: DEFAULT_BOT_DREAMING_CONFIG,
    })

    expect(combined).toContain('weekly_rule_reflection="true"')
    expect(combined).toContain('listener-rules-weekly.md')
    expect(combined).toContain('严禁擅自修改群聊配置或关闭监听开关')
    expect(combined).toContain('规则反思：')

    const reflectionOnly = composeDreamDeepConsolidationPrompt({
      botId: 'bot-1',
      botName: 'OpsBot',
      workingDir: '/tmp/workspace',
      currentDateIso: '2026-11-28',
      activeMemoryCount: 0,
      listenerRuleReportPath: '/tmp/data/dreaming/bot-1/listener-rules-weekly.md',
      listenerRulesEvaluated: 2,
      listenerRuleDiagnosesCount: 1,
      config: DEFAULT_BOT_DREAMING_CONFIG,
    })

    expect(reflectionOnly).toContain('周度主动监听规则效果反思与调优建议')
    expect(reflectionOnly).not.toContain('代码库真值验真')
    expect(reflectionOnly).toContain('listener-rules-weekly.md')
  })
})
