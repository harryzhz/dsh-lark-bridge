import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BOT_ROUTER_CONFIG,
  DEFAULT_GROUP_ROUTER_CONFIG,
  DEFAULT_TRIAGE_SYSTEM_PROMPT,
  LarkBotConfigSchema,
  LarkGroupConfigSchema,
  TRIAGE_PROMPT_VARIABLES,
  buildRouteKey,
  buildTriageSystemPrompt,
  buildTriageSystemPromptVars,
  buildTriageUserMessage,
  composeCoalescedUserText,
  composeRouterHandoffReminder,
  decideLarkRouting,
  parseTriageVerdict,
  renderTriageSystemPrompt,
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

describe('Smart triage config, per-group overrides & protocol', () => {
  it('applies formal defaults, migrates legacy experimental.router & routerMode, and resolves full per-group overrides', () => {
    const defaultBot = makeBot({ experimental: { dreaming: { enabled: false } } })
    expect(defaultBot.router).toEqual(DEFAULT_BOT_ROUTER_CONFIG)

    // Seamless migration from earlier experimental.router placement + legacy customPrompt
    const migratedBot = makeBot({
      experimental: {
        dreaming: { enabled: false },
        router: {
          enabled: true,
          provider: 'deepseek',
          model: 'deepseek-chat',
          scope: 'all_group',
          timeoutMs: 3500,
          customPrompt: '旧版补充规则',
        },
      },
    })
    expect(migratedBot.router.enabled).toBe(true)
    expect(migratedBot.router.provider).toBe('deepseek')
    expect(migratedBot.router.model).toBe('deepseek-chat')
    expect(migratedBot.router.scope).toBe('all_group')
    expect(migratedBot.router.timeoutMs).toBe(3500)
    expect(migratedBot.router.systemPrompt).toContain(DEFAULT_TRIAGE_SYSTEM_PROMPT)
    expect(migratedBot.router.systemPrompt).toContain('旧版补充规则')

    const bot = makeBot({
      router: {
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        scope: 'passive_only',
        timeoutMs: 3500,
        systemPrompt: '你是 {{bot_name}}，群聊 {{chat_name}}。{{active_session_rule}}',
        recentMessageCount: 10,
        contextTtlMinutes: 45,
        includeLastReply: false,
        coalesceQueuedMessages: true,
      },
    })

    const inheritedGroup = LarkGroupConfigSchema.parse({
      key: 'bot-triage:oc_team',
      botId: 'bot-triage',
      chatId: 'oc_team',
    })
    expect(inheritedGroup.router).toEqual(DEFAULT_GROUP_ROUTER_CONFIG)

    const effDefault = resolveEffectiveRouterConfig(bot, inheritedGroup)
    expect(effDefault.source).toBe('bot')
    expect(effDefault.enabled).toBe(true)
    expect(effDefault.scope).toBe('passive_only')
    expect(effDefault.systemPrompt).toBe('你是 {{bot_name}}，群聊 {{chat_name}}。{{active_session_rule}}')
    expect(effDefault.recentMessageCount).toBe(10)
    expect(effDefault.contextTtlMinutes).toBe(45)
    expect(effDefault.includeLastReply).toBe(false)
    expect(effDefault.coalesceQueuedMessages).toBe(true)
    expect(effDefault.bypass).toEqual({ senderTypes: ['bot'], msgTypes: [], keywords: [] })

    // Full per-group override (model, scope, bypass, timeout, coalescing, systemPrompt & context params)
    const customGroup = LarkGroupConfigSchema.parse({
      key: 'bot-triage:oc_custom',
      botId: 'bot-triage',
      chatId: 'oc_custom',
      router: {
        mode: 'override',
        provider: 'arkcli-agent-plan',
        model: 'doubao-seed-2.1-lite',
        scope: 'all_group',
        bypass: {
          senderTypes: [],
          msgTypes: ['interactive'],
          keywords: [' P0 ', 'CRITICAL', 'P0', '  '],
        },
        timeoutMs: 5000,
        systemPrompt: '本群仅处理告警与发布 {{trigger_guide}}',
        recentMessageCount: 12,
        contextTtlMinutes: 60,
        includeLastReply: true,
        coalesceQueuedMessages: false,
      },
    })
    const effCustom = resolveEffectiveRouterConfig(bot, customGroup)
    expect(effCustom).toEqual({
      source: 'group',
      enabled: true,
      provider: 'arkcli-agent-plan',
      model: 'doubao-seed-2.1-lite',
      scope: 'all_group',
      bypass: {
        senderTypes: [],
        msgTypes: ['interactive'],
        keywords: ['P0', 'CRITICAL'],
      },
      timeoutMs: 5000,
      systemPrompt: '本群仅处理告警与发布 {{trigger_guide}}',
      recentMessageCount: 12,
      contextTtlMinutes: 60,
      includeLastReply: true,
      coalesceQueuedMessages: false,
    })

    // Group override leaving provider/model blank inherits Bot router model; explicit fields keep schema defaults
    const partialOverrideGroup = LarkGroupConfigSchema.parse({
      key: 'bot-triage:oc_partial',
      botId: 'bot-triage',
      chatId: 'oc_partial',
      router: { mode: 'override', scope: 'all_group' },
    })
    const effPartial = resolveEffectiveRouterConfig(bot, partialOverrideGroup)
    expect(effPartial.provider).toBe('deepseek')
    expect(effPartial.model).toBe('deepseek-chat')
    expect(effPartial.scope).toBe('all_group')
    expect(effPartial.recentMessageCount).toBe(6)
    expect(effPartial.contextTtlMinutes).toBe(30)
    expect(effPartial.includeLastReply).toBe(true)

    // Legacy group customPrompt migration
    const legacyPromptGroup = LarkGroupConfigSchema.parse({
      key: 'bot-triage:oc_legacy_prompt',
      botId: 'bot-triage',
      chatId: 'oc_legacy_prompt',
      router: { mode: 'override', customPrompt: '群级旧补充规则' },
    })
    expect(legacyPromptGroup.router.systemPrompt).toContain(DEFAULT_TRIAGE_SYSTEM_PROMPT)
    expect(legacyPromptGroup.router.systemPrompt).toContain('群级旧补充规则')

    // Legacy group routerMode migration
    const migratedGroup = LarkGroupConfigSchema.parse({
      key: 'bot-triage:oc_legacy',
      botId: 'bot-triage',
      chatId: 'oc_legacy',
      routerMode: 'all_group',
    })
    expect(migratedGroup.router.mode).toBe('override')
    expect(migratedGroup.router.scope).toBe('all_group')

    const disabledGroup = LarkGroupConfigSchema.parse({
      key: 'bot-triage:oc_off',
      botId: 'bot-triage',
      chatId: 'oc_off',
      router: { mode: 'off' },
    })
    const effOff = resolveEffectiveRouterConfig(bot, disabledGroup)
    expect(effOff.source).toBe('group')
    expect(effOff.enabled).toBe(false)
    expect(effOff.coalesceQueuedMessages).toBe(false)

    // Group can enable smart triage even when Bot default is off
    const offBot = makeBot({ router: { enabled: false } })
    expect(resolveEffectiveRouterConfig(offBot, customGroup).enabled).toBe(true)
  })

  it('enforces passive_only, active_thread_only, and all_group scope boundaries and excludes p2p', () => {
    const passiveCfg = {
      source: 'bot' as const,
      ...DEFAULT_BOT_ROUTER_CONFIG,
      enabled: true,
      scope: 'passive_only' as const,
    }
    const activeThreadOnlyCfg = {
      source: 'bot' as const,
      ...DEFAULT_BOT_ROUTER_CONFIG,
      enabled: true,
      scope: 'active_thread_only' as const,
    }
    const allGroupCfg = {
      source: 'bot' as const,
      ...DEFAULT_BOT_ROUTER_CONFIG,
      enabled: true,
      scope: 'all_group' as const,
    }

    expect(shouldRunTriage(makeDecision({ trigger: 'p2p' }), allGroupCfg)).toBe(false)
    expect(shouldRunTriage(makeDecision({ trigger: 'mention' }), passiveCfg)).toBe(false)
    expect(shouldRunTriage(makeDecision({ trigger: 'substitute' }), passiveCfg)).toBe(false)
    expect(shouldRunTriage(makeDecision({ trigger: 'listener' }), passiveCfg)).toBe(true)
    expect(shouldRunTriage(makeDecision({ trigger: 'active-thread' }), passiveCfg)).toBe(true)

    expect(shouldRunTriage(makeDecision({ trigger: 'p2p' }), activeThreadOnlyCfg)).toBe(false)
    expect(shouldRunTriage(makeDecision({ trigger: 'mention' }), activeThreadOnlyCfg)).toBe(false)
    expect(shouldRunTriage(makeDecision({ trigger: 'substitute' }), activeThreadOnlyCfg)).toBe(false)
    expect(shouldRunTriage(makeDecision({ trigger: 'listener' }), activeThreadOnlyCfg)).toBe(false)
    expect(shouldRunTriage(makeDecision({ trigger: 'active-thread' }), activeThreadOnlyCfg)).toBe(
      true,
    )

    expect(shouldRunTriage(makeDecision({ trigger: 'mention' }), allGroupCfg)).toBe(true)
    expect(shouldRunTriage(makeDecision({ trigger: 'substitute' }), allGroupCfg)).toBe(true)
  })

  it('bypasses triage for built-in rich media and declarative bypass rules (senderTypes / msgTypes / keywords)', () => {
    const emptyBypass = { senderTypes: [], msgTypes: [], keywords: [] }
    expect(
      shouldFastBypassTriage(
        makeMsg({ imageKeys: ['img_1'] }),
        makeDecision({ trigger: 'mention' }),
        emptyBypass,
      ).bypass,
    ).toBe(true)
    expect(
      shouldFastBypassTriage(
        makeMsg({ msgType: 'file' }),
        makeDecision({ trigger: 'listener' }),
        emptyBypass,
      ).bypass,
    ).toBe(true)
    expect(
      shouldFastBypassTriage(
        makeMsg({ msgType: 'media' }),
        makeDecision({ trigger: 'mention' }),
        emptyBypass,
      ).bypass,
    ).toBe(true)
    expect(
      shouldFastBypassTriage(
        makeMsg({ msgType: 'merge_forward' }),
        makeDecision({ trigger: 'mention' }),
        emptyBypass,
      ).bypass,
    ).toBe(true)
    // Long text and fenced code blocks are NO LONGER bypassed
    expect(
      shouldFastBypassTriage(
        makeMsg(),
        makeDecision({ trigger: 'mention', userText: '看下报错：\n```ts\nthrow new Error()\n```' }),
        DEFAULT_BOT_ROUTER_CONFIG.bypass,
      ).bypass,
    ).toBe(false)
    expect(
      shouldFastBypassTriage(
        makeMsg({ msgType: 'text' }),
        makeDecision({ trigger: 'mention', userText: 'A'.repeat(2500) }),
        DEFAULT_BOT_ROUTER_CONFIG.bypass,
      ).bypass,
    ).toBe(false)
    expect(
      shouldFastBypassTriage(
        makeMsg({ msgType: 'interactive', senderType: 'user' }),
        makeDecision({ trigger: 'listener', userText: 'A'.repeat(1200) }),
        DEFAULT_BOT_ROUTER_CONFIG.bypass,
      ).bypass,
    ).toBe(false)

    // Default bypass: senderTypes=['bot'] routes bot/app alerts directly to main runtime
    const botHit = shouldFastBypassTriage(
      makeMsg({ senderType: 'bot', msgType: 'interactive' }),
      makeDecision({ trigger: 'listener', userText: '[P1] API 延迟飙升' }),
      DEFAULT_BOT_ROUTER_CONFIG.bypass,
    )
    expect(botHit.bypass).toBe(true)
    expect(botHit.reason).toContain('应用/机器人')

    // Clearing senderTypes lets bot messages go through triage
    expect(
      shouldFastBypassTriage(
        makeMsg({ senderType: 'bot', msgType: 'text' }),
        makeDecision({ trigger: 'listener', userText: '日常构建完成' }),
        emptyBypass,
      ).bypass,
    ).toBe(false)

    // msgTypes bypass
    const cardHit = shouldFastBypassTriage(
      makeMsg({ senderType: 'user', msgType: 'interactive' }),
      makeDecision({ trigger: 'listener', userText: '卡片通知' }),
      { senderTypes: [], msgTypes: ['interactive'], keywords: [] },
    )
    expect(cardHit.bypass).toBe(true)
    expect(cardHit.reason).toContain('interactive')

    // Case-insensitive keyword bypass
    const kwHit = shouldFastBypassTriage(
      makeMsg({ senderType: 'user', msgType: 'text' }),
      makeDecision({ trigger: 'listener', userText: '线上 critical 接口超时了' }),
      { senderTypes: [], msgTypes: [], keywords: ['P0', 'CRITICAL'] },
    )
    expect(kwHit.bypass).toBe(true)
    expect(kwHit.reason).toContain('CRITICAL')

    expect(
      shouldFastBypassTriage(
        makeMsg({ senderType: 'user', msgType: 'text' }),
        makeDecision({ trigger: 'listener', userText: '中午吃啥' }),
        { senderTypes: [], msgTypes: [], keywords: ['P0', 'CRITICAL'] },
      ).bypass,
    ).toBe(false)
  })

  it('renders customizable System Prompt {{variables}}, preserves unknown placeholders, and falls back to default when empty', () => {
    expect(TRIAGE_PROMPT_VARIABLES.map((v) => v.key)).toEqual([
      'bot_name',
      'bot_role',
      'chat_name',
      'trigger',
      'trigger_guide',
      'active_session_rule',
      'listener_name',
      'listener_prompt',
    ])

    const vars = buildTriageSystemPromptVars({
      botName: 'TriageBot',
      botRoleName: '值班架构师',
      botRoleSummary: '专注稳定性与发布护航，不遗漏关键告警',
      chatName: '稳定性告警群',
      hasActiveWorker: true,
      trigger: 'listener',
      listenerName: '核心告警监听',
      listenerPrompt: '仅在 P0/P1 故障时介入，P3 提醒静默',
    })

    const custom = renderTriageSystemPrompt(
      'Bot={{bot_name}} Chat={{ chat_name }} Trigger={{trigger}} Rule={{listener_name}}\n\n{{listener_prompt}}\n\n{{bot_role}}\n\n{{active_session_rule}}\n\n{{trigger_guide}}\n\n保留={{unknown_var}}',
      vars,
    )
    expect(custom).toContain('Bot=TriageBot Chat=稳定性告警群 Trigger=群主动监听 Rule=核心告警监听')
    expect(custom).toContain('<listener_rule>\n仅在 P0/P1 故障时介入，P3 提醒静默\n</listener_rule>')
    expect(custom).toContain('值班架构师')
    expect(custom).toContain('has_active_session=true')
    expect(custom).toContain('触发信号：群主动监听（旁听）')
    expect(custom).toContain('保留={{unknown_var}}')

    // Empty template falls back to DEFAULT_TRIAGE_SYSTEM_PROMPT and collapses blank lines from empty vars
    const fallbackVars = buildTriageSystemPromptVars({
      botName: 'TriageBot',
      hasActiveWorker: false,
      trigger: 'mention',
    })
    const renderedDefault = renderTriageSystemPrompt('   ', fallbackVars)
    expect(renderedDefault).toContain('「TriageBot」')
    expect(renderedDefault).toContain('has_active_session=false')
    expect(renderedDefault).not.toMatch(/\n{3,}/)
  })

  it('parses tool calls and JSON fallback, enforces 2-state invariant for active sessions, and fails open on malformed output', () => {
    // 1. Structured tool call
    const v1 = parseTriageVerdict({
      toolCalls: [{ name: 'route_message', arguments: '{"action":"silent","reason":"纯确认语"}' }],
      hasActiveWorker: false,
    })
    expect(v1).toEqual({ action: 'silent', reason: '纯确认语' })

    // 2. Active session forbids quick_reply -> upgrades to handoff
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
    expect(v2.reason).toContain('已有活跃会话')

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

  it('builds untruncated UserMessage with configurable recentMessageCount & includeLastReply, plus handoff & coalesced prompts', () => {
    const sys = buildTriageSystemPrompt({
      botName: 'TriageBot',
      hasActiveWorker: true,
      trigger: 'active-thread',
      systemPromptTemplate: `${DEFAULT_TRIAGE_SYSTEM_PROMPT}\n\n涉及发布必须移交`,
    })
    expect(sys).toContain('has_active_session=true')
    expect(sys).toContain('禁止使用 `quick_reply`')
    expect(sys).toContain('涉及发布必须移交')

    const longIncoming = `超长日志正文-${'X'.repeat(4000)}-TAIL_MARKER`
    const longLastReply = `上一轮完整回复-${'Y'.repeat(1200)}-LAST_REPLY_END`
    const longHistory = `历史长消息-${'Z'.repeat(1000)}-HISTORY_END`

    const user = buildTriageUserMessage({
      botName: 'TriageBot',
      chatName: '研发群',
      trigger: 'active-thread',
      senderName: 'Alex',
      senderType: 'user',
      userText: longIncoming,
      hasActiveWorker: true,
      workerBusy: false,
      lastWorkerReply: longLastReply,
      recentMessages: [
        { role: 'user', senderName: 'Sam', text: '较早消息 1', timestampMs: 1 },
        { role: 'worker', text: '主回复 2', timestampMs: 2 },
        { role: 'user', senderName: 'Alex', text: longHistory, timestampMs: 3 },
      ],
      recentMessageCount: 2,
      includeLastReply: true,
    })
    expect(user).toContain('has_active_session=true')
    expect(user).toContain('session_busy=false')
    expect(user).toContain('<last_reply>')
    expect(user).toContain('LAST_REPLY_END')
    expect(user).toContain('HISTORY_END')
    expect(user).toContain('TAIL_MARKER')
    expect(user).toContain('- [智能体] 主回复 2')
    expect(user).not.toContain('较早消息 1')

    // Disable recent context and last reply via config
    const strippedUser = buildTriageUserMessage({
      botName: 'TriageBot',
      chatName: '研发群',
      trigger: 'active-thread',
      senderName: 'Alex',
      senderType: 'user',
      userText: '短回复',
      hasActiveWorker: true,
      lastWorkerReply: longLastReply,
      recentMessages: [{ role: 'user', senderName: 'Alex', text: '历史', timestampMs: 1 }],
      recentMessageCount: 0,
      includeLastReply: false,
    })
    expect(strippedUser).not.toContain('<last_reply>')
    expect(strippedUser).not.toContain('<recent_context>')
    expect(strippedUser).toContain('<incoming_message>\n短回复\n</incoming_message>')

    const handoff = composeRouterHandoffReminder([
      { senderName: 'Alex', userText: '在吗', routerReply: '在的，有什么需要帮忙？', timestampMs: 1 },
    ])
    expect(handoff).toContain('<triage_handoff_context>')
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
