import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BOT_ROUTER_CONFIG,
  LarkBotConfigSchema,
  LarkGroupConfigSchema,
  buildRouteKey,
  buildTriageSystemPrompt,
  buildTriageUserMessage,
  composeCoalescedUserText,
  composeRouterHandoffReminder,
  decideLarkRouting,
  parseTriageVerdict,
  resolveEffectiveRouterConfig,
  shouldFastBypassTriage,
  shouldRunTriage,
  type AgentRoutingDecision,
  type InboundLarkMessage,
  type LarkBotConfig,
} from '../src/index.js'

function makeBot(overrides: Record<string, unknown> = {}): LarkBotConfig {
  return LarkBotConfigSchema.parse({
    id: 'bot-triage',
    name: 'TriageBot',
    larkAppId: 'cli_triage',
    larkAppSecret: 'sec_triage',
    defaultWorkingDir: '/Users/demo/project',
    ...overrides,
  })
}

function makeMsg(overrides: Partial<InboundLarkMessage> = {}): InboundLarkMessage {
  return {
    botId: 'bot-triage',
    larkAppId: 'cli_triage',
    botOpenId: 'ou_bot',
    messageId: 'om_msg_1',
    chatId: 'oc_team',
    chatType: 'group',
    msgType: 'text',
    senderOpenId: 'ou_alex',
    senderType: 'user',
    text: '收到',
    rawContent: '{"text":"收到"}',
    mentions: [],
    imageKeys: [],
    createTimeMs: 1_700_000_000_000,
    ...overrides,
  }
}

function makeDecision(overrides: Partial<AgentRoutingDecision> = {}): AgentRoutingDecision {
  return {
    action: 'agent',
    trigger: 'listener',
    routeKey: 'cli_triage:oc_team:om_msg_1',
    workingDir: '/Users/demo/project',
    workspaceName: 'project',
    agentPreset: 'codex',
    sessionMode: 'thread',
    replyMode: 'new-topic',
    useCard: true,
    sendIntermediateMessages: false,
    allowSilentEmptyReply: true,
    autoCloseAfterCompletion: false,
    turnReminders: [],
    userText: '收到',
    promptText: '<user_message>\n收到\n</user_message>',
    ...overrides,
  }
}

describe('Router/Worker triage config, scope resolution & protocol', () => {
  it('applies backward-compatible defaults and group-level overrides cleanly', () => {
    const legacyBot = makeBot({ experimental: { dreaming: { enabled: false } } })
    expect(legacyBot.experimental.router).toEqual(DEFAULT_BOT_ROUTER_CONFIG)

    const bot = makeBot({
      experimental: {
        router: {
          enabled: true,
          provider: 'deepseek',
          model: 'deepseek-chat',
          scope: 'passive_only',
          timeoutMs: 3500,
          coalesceQueuedMessages: true,
        },
      },
    })

    const inheritedGroup = LarkGroupConfigSchema.parse({
      key: 'bot-triage:oc_team',
      botId: 'bot-triage',
      chatId: 'oc_team',
    })
    expect(inheritedGroup.routerMode).toBe('inherit')

    const effDefault = resolveEffectiveRouterConfig(bot, inheritedGroup)
    expect(effDefault.enabled).toBe(true)
    expect(effDefault.scope).toBe('passive_only')
    expect(effDefault.coalesceQueuedMessages).toBe(true)

    const allGroup = LarkGroupConfigSchema.parse({
      key: 'bot-triage:oc_all',
      botId: 'bot-triage',
      chatId: 'oc_all',
      routerMode: 'all_group',
    })
    expect(resolveEffectiveRouterConfig(bot, allGroup).scope).toBe('all_group')

    const disabledGroup = LarkGroupConfigSchema.parse({
      key: 'bot-triage:oc_off',
      botId: 'bot-triage',
      chatId: 'oc_off',
      routerMode: 'off',
    })
    const effOff = resolveEffectiveRouterConfig(bot, disabledGroup)
    expect(effOff.enabled).toBe(false)
    expect(effOff.coalesceQueuedMessages).toBe(false)
  })

  it('enforces passive_only vs all_group scope boundaries and excludes p2p', () => {
    const passiveCfg = {
      ...DEFAULT_BOT_ROUTER_CONFIG,
      enabled: true,
      scope: 'passive_only' as const,
    }
    const allGroupCfg = {
      ...DEFAULT_BOT_ROUTER_CONFIG,
      enabled: true,
      scope: 'all_group' as const,
    }

    expect(shouldRunTriage(makeDecision({ trigger: 'p2p' }), allGroupCfg)).toBe(false)
    expect(shouldRunTriage(makeDecision({ trigger: 'mention' }), passiveCfg)).toBe(false)
    expect(shouldRunTriage(makeDecision({ trigger: 'substitute' }), passiveCfg)).toBe(false)
    expect(shouldRunTriage(makeDecision({ trigger: 'listener' }), passiveCfg)).toBe(true)
    expect(shouldRunTriage(makeDecision({ trigger: 'active-thread' }), passiveCfg)).toBe(true)

    expect(shouldRunTriage(makeDecision({ trigger: 'mention' }), allGroupCfg)).toBe(true)
    expect(shouldRunTriage(makeDecision({ trigger: 'substitute' }), allGroupCfg)).toBe(true)
  })

  it('bypasses triage for images, files, and long/code non-listener payloads while keeping listener cards triaged', () => {
    expect(
      shouldFastBypassTriage(makeMsg({ imageKeys: ['img_1'] }), makeDecision({ trigger: 'mention' })).bypass,
    ).toBe(true)
    expect(
      shouldFastBypassTriage(makeMsg({ msgType: 'file' }), makeDecision({ trigger: 'listener' })).bypass,
    ).toBe(true)
    expect(
      shouldFastBypassTriage(
        makeMsg(),
        makeDecision({ trigger: 'mention', userText: '看下报错：\n```ts\nthrow new Error()\n```' }),
      ).bypass,
    ).toBe(true)
    expect(
      shouldFastBypassTriage(
        makeMsg({ msgType: 'interactive' }),
        makeDecision({ trigger: 'listener', userText: 'A'.repeat(1200) }),
      ).bypass,
    ).toBe(false)
  })

  it('parses tool calls and JSON fallback, enforces 2-state invariant for active workers, and fails open on malformed output', () => {
    // 1. Structured tool call
    const v1 = parseTriageVerdict({
      toolCalls: [{ name: 'route_message', arguments: '{"action":"silent","reason":"纯确认语"}' }],
      hasActiveWorker: false,
    })
    expect(v1).toEqual({ action: 'silent', reason: '纯确认语' })

    // 2. Active worker forbids quick_reply -> upgrades to handoff
    const v2 = parseTriageVerdict({
      toolCalls: [
        {
          name: 'route_message',
          arguments: '{"action":"quick_reply","reason":"礼貌回应","reply_text":"好的明白"}',
        },
      ],
      hasActiveWorker: true,
    })
    expect(v2.action).toBe('handoff')
    expect(v2.reason).toContain('已有活跃 Worker')

    // 3. JSON fallback when model does not emit a tool call
    const v3 = parseTriageVerdict({
      text: '```json\n{"action":"quick_reply","reason":"打招呼","reply_text":"你好，有什么需要帮忙？"}\n```',
      hasActiveWorker: false,
    })
    expect(v3).toEqual({
      action: 'quick_reply',
      reason: '打招呼',
      replyText: '你好，有什么需要帮忙？',
    })

    // 4. Empty quick_reply text or garbage -> Fail-Open to handoff
    expect(
      parseTriageVerdict({
        text: '{"action":"quick_reply","reason":"空回复"}',
        hasActiveWorker: false,
      }),
    ).toMatchObject({ action: 'handoff', fallback: true })

    expect(
      parseTriageVerdict({
        text: 'sorry I cannot decide',
        hasActiveWorker: false,
      }),
    ).toMatchObject({ action: 'handoff', fallback: true })
  })

  it('renders active-worker context, handoff context, and coalesced batch prompts cleanly', () => {
    const sys = buildTriageSystemPrompt({
      botName: 'TriageBot',
      hasActiveWorker: true,
      trigger: 'active-thread',
      customPrompt: '涉及发布必须移交',
    })
    expect(sys).toContain('has_active_worker=true')
    expect(sys).toContain('禁止使用 `quick_reply`')
    expect(sys).toContain('涉及发布必须移交')

    const user = buildTriageUserMessage({
      botName: 'TriageBot',
      chatName: '研发群',
      trigger: 'active-thread',
      senderName: 'Alex',
      senderType: 'user',
      userText: '好的，按方案 B 改',
      hasActiveWorker: true,
      workerBusy: false,
      lastWorkerReplyExcerpt: '确认一下：你要按方案 A 还是方案 B 修改？',
      recentMessages: [{ role: 'user', senderName: 'Alex', text: '登录偶发超时', timestampMs: 1 }],
    })
    expect(user).toContain('<last_worker_reply>')
    expect(user).toContain('方案 B')
    expect(user).toContain('<recent_context>')

    const handoff = composeRouterHandoffReminder([
      { senderName: 'Alex', userText: '在吗', routerReply: '在的，有什么需要帮忙？', timestampMs: 1 },
    ])
    expect(handoff).toContain('<router_handoff_context>')
    expect(handoff).toContain('在吗')

    const batch = composeCoalescedUserText([
      { messageId: 'om_2', senderName: 'Alex', text: '补充报错接口 /v1/login', timestampMs: 1 },
      { messageId: 'om_3', senderName: 'Sam', text: '还有 timeout=5000ms', timestampMs: 2 },
    ])
    expect(batch).toContain('以下 2 条消息')
    expect(batch).toContain('[1] Alex (message_id="om_2"): 补充报错接口 /v1/login')
    expect(batch).toContain('[2] Sam (message_id="om_3"): 还有 timeout=5000ms')
  })

  it('routes active-thread followups on ephemeral router quick-reply threads without a Worker binding', () => {
    const bot = makeBot({ mentionTriggerMode: 'mention_and_active_thread' })
    const routeKey = buildRouteKey('cli_triage', 'oc_team', 'om_root_1')
    const msg = makeMsg({
      messageId: 'om_follow_2',
      rootId: 'om_root_1',
      threadId: 'omt_topic_1',
      text: '帮我查下登录超时代码',
    })

    const decision = decideLarkRouting(bot, msg, {
      hasActiveSessionForRoute: () => false,
      hasEphemeralRouterThread: (key) => key === routeKey,
      getRouteTrigger: (key) => (key === routeKey ? 'mention' : undefined),
      hasRouteReplied: () => true,
    })

    expect(decision.action).toBe('agent')
    if (decision.action === 'agent') {
      expect(decision.trigger).toBe('active-thread')
      expect(decision.routeKey).toBe(routeKey)
      expect(decision.sessionMode).toBe('thread')
    }
  })
})
