import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DREAMING_SCOPES,
  DEFAULT_LISTENER_TEMPLATES,
  LarkBotConfigSchema,
  LarkGroupConfigSchema,
  LarkReminderItemSchema,
  MessageDeduplicator,
  REMINDER_SILENT_SENTINEL,
  buildGroupKey,
  buildLarkPostPayload,
  buildReminderConfirmCard,
  buildReminderNoticeCard,
  buildReplyCard,
  composeDreamExecutionPrompt,
  composeLarkContextReminder,
  composeProactiveSessionReminder,
  composeReminderTriggerPrompt,
  composeRoleReminder,
  composeScheduleContextReminder,
  composeSystemReminder,
  composeTurnPrompt,
  decideLarkRouting,
  expandWorkingDir,
  extractPureUserIntent,
  extractReminderTriggerOutput,
  formatMarkdownForLarkCard,
  formatMarkdownForLarkPost,
  generateDefaultBotIconPng,
  hasInjectedPromptMarkup,
  leafDirectoryName,
  parseLarkMessageContent,
  renderQrSvgDataUrl,
  resolveEffectiveCardBot,
  resolveEffectiveReactionEmoji,
  resolveEffectiveWorkspaceName,
  type InboundLarkMessage,
} from '../src/index.js'

function createBot(overrides: Record<string, unknown> = {}) {
  return LarkBotConfigSchema.parse({
    id: 'dsh-bot',
    name: 'DSH-Bot',
    larkAppId: 'cli_dsh_app',
    larkAppSecret: 'sec_123',
    agentPreset: 'codex',
    model: 'gpt-6.1-sol',
    reasoningEffort: 'xhigh',
    defaultWorkingDir: '~',
    allowedUsers: ['ou_owner'],
    allowedUserProfiles: [{ openId: 'ou_owner', name: 'Alex Chen', email: 'alex@example.com' }],
    signature: 'DSH 智能协作签名',
    role: {
      enabled: true,
      name: '研发主力助手',
      systemPrompt: '保持结论先行、严谨简洁。',
    },
    substituteMode: {
      enabled: true,
      targets: [{ openId: 'ou_owner', name: 'Alex Chen', email: 'alex@example.com' }],
      disclosure: 'none',
      activeThreadFollowup: true,
    },
    ...overrides,
  })
}

function createMessage(partial: Partial<InboundLarkMessage> = {}): InboundLarkMessage {
  return {
    botId: 'dsh-bot',
    larkAppId: 'cli_dsh_app',
    botOpenId: 'ou_bot',
    messageId: 'om_1',
    chatId: 'oc_team_dev',
    chatType: 'group',
    msgType: 'text',
    senderOpenId: 'ou_colleague',
    senderType: 'user',
    text: 'hello',
    rawContent: '{"text":"hello"}',
    mentions: [],
    imageKeys: [],
    createTimeMs: Date.now(),
    ...partial,
  }
}

describe('Workspace name, ~ expansion, card images & <system_reminder> composition', () => {
  it('expands ~ workingDir, defaults bot & group workspaceName to leaf directory name, and embeds images in cards', () => {
    expect(expandWorkingDir('~')).toBe(homedir())
    expect(expandWorkingDir('~/workspace/demo')).toBe(join(homedir(), 'workspace', 'demo'))
    expect(leafDirectoryName('~/workspace/demo')).toBe('demo')

    const bot = createBot()
    expect(resolveEffectiveWorkspaceName(bot)).toBe(leafDirectoryName('~'))
    expect(bot.allowedUserProfiles).toHaveLength(1)

    const migratedBot = createBot({ workspaceGroupName: '历史工作区' })
    expect(migratedBot.workspaceName).toBe('历史工作区')
    expect(resolveEffectiveWorkspaceName(migratedBot)).toBe('历史工作区')

    const group = LarkGroupConfigSchema.parse({
      key: buildGroupKey('dsh-bot', 'oc_group_1'),
      botId: 'dsh-bot',
      chatId: 'oc_group_1',
      chatName: '订单研发群',
      workspaceName: '核心研发工作区',
    })
    expect(resolveEffectiveWorkspaceName(migratedBot, group)).toBe('核心研发工作区')

    const groupInheritingBotDir = LarkGroupConfigSchema.parse({
      key: buildGroupKey('dsh-bot', 'oc_group_2'),
      botId: 'dsh-bot',
      chatId: 'oc_group_2',
      chatName: '订单研发群',
    })
    expect(resolveEffectiveWorkspaceName(bot, groupInheritingBotDir)).toBe(leafDirectoryName('~'))
    expect(resolveEffectiveWorkspaceName(migratedBot, groupInheritingBotDir)).toBe('历史工作区')

    const groupCustomDir = LarkGroupConfigSchema.parse({
      key: buildGroupKey('dsh-bot', 'oc_group_3'),
      botId: 'dsh-bot',
      chatId: 'oc_group_3',
      chatName: '订单研发群',
      workingDir: '~/workspace/order-service',
    })
    expect(resolveEffectiveWorkspaceName(bot, groupCustomDir)).toBe('order-service')
    expect(resolveEffectiveWorkspaceName(migratedBot, groupCustomDir)).toBe('order-service')

    const card = buildReplyCard({
      markdown: '趋势如下：\n\n![趋势图](img:0)\n\n结论正常。',
      bot,
      modelLabel: 'codex · gpt-6.1-sol',
      sessionUrl: 'http://192.168.1.10:3880/#session=s1',
      images: [{ imgKey: 'img_v3_demo', alt: '趋势图' }],
    })
    const rawCard = JSON.stringify(card)
    expect(rawCard).toContain('DSH 智能协作签名')
    expect(rawCard).toContain('img_v3_demo')
  })

  it('composes two-level <system_reminder> blocks with clean tags and zero ~/.dsh boilerplate', () => {
    const bot = createBot()
    const baseRole = composeRoleReminder(bot)
    expect(baseRole).toContain('<role name="研发主力助手">')
    expect(baseRole).not.toContain('lark_role')
    expect(baseRole).toContain('保持结论先行')

    const ctxReminder = composeLarkContextReminder({
      bot,
      botOpenId: 'ou_bot',
      msg: createMessage({
        parentId: 'om_quoted_99',
        mentions: [{ key: '@_user_2', openId: 'ou_peer', name: 'Sam' }],
      }),
      chatName: '核心研发群',
      senderName: 'Taylor',
    })
    expect(ctxReminder).toContain('<lark_context ')
    expect(ctxReminder).toContain('quoted_message_id="om_quoted_99"')
    expect(ctxReminder).toContain('Sam(open_id="ou_peer")')
    expect(ctxReminder).toContain('lark-bridge')
    expect(ctxReminder).not.toContain('回复投递：')
    expect(ctxReminder).not.toContain('.dsh')

    const compactCtx = composeLarkContextReminder({
      bot,
      botOpenId: 'ou_bot',
      msg: createMessage(),
      includeFullGuide: false,
    })
    expect(compactCtx).toMatch(/^<lark_context\b[^>]*\/>$/)

    const schedSection = composeScheduleContextReminder({
      scheduleId: 'schedule-1',
      title: '每日巡检',
      enabled: true,
      deliveryMode: 'chat',
      notifyOn: 'non_empty',
      targets: [
        {
          botId: 'dsh-bot',
          botName: 'DSH-Bot',
          larkAppId: 'cli_dsh_app',
          botOpenId: 'ou_bot',
          chatId: 'oc_team_dev',
          chatName: '核心研发群',
        },
      ],
    })
    const schedWrapped = composeSystemReminder([schedSection])!
    expect(schedWrapped).toContain('<system_reminder>\n<schedule schedule_id="schedule-1"')
    expect(schedWrapped).not.toContain('lark_schedule')
    expect(schedWrapped).toContain('智能体「DSH-Bot」')
    expect(schedWrapped).not.toContain('群成员：')
    expect(schedWrapped).toContain('lark-bridge members --bot <botId> --chat <chatId> --query <姓名>')
    expect(schedWrapped).not.toContain('.dsh')
    expect(schedWrapped).not.toContain('本自动化任务已绑定飞书通知投递')

    const aggregated = composeTurnPrompt([baseRole!, ctxReminder], '请检查配置')
    expect(aggregated.match(/<system_reminder>/g)).toHaveLength(1)
    expect(aggregated).toContain('<role name="研发主力助手">')
    expect(aggregated).toContain('<lark_context ')
    expect(aggregated).toContain('<user_message>\n请检查配置\n</user_message>')
  })
})

describe('decideLarkRouting, <user_message> format, memberOverrides & title intent extraction', () => {
  it('formats listener prompts using two-level <system_reminder><listener> and defaults group workspaceName to leaf directory name', () => {
    const bot = createBot()
    const group = LarkGroupConfigSchema.parse({
      key: 'dsh-bot:oc_team_dev',
      botId: 'dsh-bot',
      chatId: 'oc_team_dev',
      chatName: '技术架构群',
      listener: {
        enabled: true,
        name: '智能技术旁听',
        prompt: '你只监听技术相关的消息，其他消息保持静默',
      },
    })

    const decision = decideLarkRouting(bot, createMessage({ text: 'hello' }), {
      groupConfig: group,
      hasActiveSessionForRoute: () => false,
    })
    expect(decision.action).toBe('agent')
    if (decision.action === 'agent') {
      expect(decision.workingDir).toBe(homedir())
      expect(decision.workspaceName).toBe(leafDirectoryName('~'))
      expect(decision.promptText).toBe(
        [
          '<system_reminder>',
          '<listener name="智能技术旁听" chat_id="oc_team_dev" sender_type="user" msg_type="text">',
          '你只监听技术相关的消息，其他消息保持静默',
          '</listener>',
          '</system_reminder>',
          '',
          '<user_message>',
          'hello',
          '</user_message>',
        ].join('\n'),
      )
      expect(extractPureUserIntent(decision.promptText)).toBe('hello')
      expect(hasInjectedPromptMarkup(decision.promptText)).toBe(true)
      expect(hasInjectedPromptMarkup('<listener name="智能技术旁听">')).toBe(true)
      expect(hasInjectedPromptMarkup('hello')).toBe(false)
    }
  })

  it('honors per-member / per-bot listener switch overrides', () => {
    const bot = createBot()
    const group = LarkGroupConfigSchema.parse({
      key: 'dsh-bot:oc_alert',
      botId: 'dsh-bot',
      chatId: 'oc_alert',
      listener: {
        enabled: true,
        templateKey: 'project',
        name: '项目讨论',
        prompt: '排查技术问题',
        senderTypes: ['user'],
        memberOverrides: {
          ou_muted_user: false,
          ou_helper_bot: true,
        },
      },
    })

    const mutedUser = decideLarkRouting(
      bot,
      createMessage({ chatId: 'oc_alert', senderOpenId: 'ou_muted_user', senderType: 'user', text: '报错了' }),
      { groupConfig: group, hasActiveSessionForRoute: () => false },
    )
    expect(mutedUser).toEqual({ action: 'ignore', reason: 'listener_member_disabled' })

    const enabledBot = decideLarkRouting(
      bot,
      createMessage({ chatId: 'oc_alert', senderOpenId: 'ou_helper_bot', senderType: 'bot', text: '接口超时排查' }),
      { groupConfig: group, hasActiveSessionForRoute: () => false },
    )
    expect(enabledBot.action).toBe('agent')
  })

  it('provides the 4 redesigned listener templates and triggers substituteMode with <system_reminder>', () => {
    expect(DEFAULT_LISTENER_TEMPLATES.map((t) => [t.key, t.label])).toEqual([
      ['daily', '工作日常'],
      ['project', '项目讨论'],
      ['alert', '告警排查'],
      ['change', '变更观察'],
    ])
    expect(DEFAULT_LISTENER_TEMPLATES.find((t) => t.key === 'alert')?.prompt).toContain('确认并屏蔽 1 小时')

    const bot = createBot()
    const decision = decideLarkRouting(
      bot,
      createMessage({
        text: '@_user_1 请看下这个方案',
        mentions: [{ key: '@_user_1', openId: 'ou_owner', name: 'Alex Chen' }],
      }),
      { hasActiveSessionForRoute: () => false },
    )
    expect(decision.action).toBe('agent')
    if (decision.action === 'agent') {
      expect(decision.trigger).toBe('substitute')
      expect(decision.promptText).toContain('<substitute target="Alex Chen"')
      expect(decision.promptText).not.toContain('lark_substitute')
      expect(decision.promptText).toContain('<user_message>\n@Alex Chen 请看下这个方案\n</user_message>')
      expect(extractPureUserIntent(decision.promptText)).toBe('@Alex Chen 请看下这个方案')
    }
  })

  it('prioritizes group-level Agent runtime overrides and cleanly inherits bot runtime otherwise', () => {
    const bot = createBot({
      agentPreset: 'codex',
      model: 'gpt-6.1-sol',
      reasoningEffort: 'xhigh',
    })

    // 1. Default group inherits bot runtime, model, and reasoningEffort
    const inheritedGroup = LarkGroupConfigSchema.parse({
      key: 'dsh-bot:oc_inherit',
      botId: 'dsh-bot',
      chatId: 'oc_inherit',
    })
    expect(inheritedGroup.runtimeMode).toBe('inherit')
    const inheritDecision = decideLarkRouting(
      bot,
      createMessage({
        chatId: 'oc_inherit',
        text: '@_bot_1 check status',
        mentions: [{ key: '@_bot_1', openId: 'ou_bot', name: 'DSH-Bot' }],
      }),
      { groupConfig: inheritedGroup, hasActiveSessionForRoute: () => false },
    )
    expect(inheritDecision).toMatchObject({
      action: 'agent',
      agentPreset: 'codex',
      model: 'gpt-6.1-sol',
      reasoningEffort: 'xhigh',
    })

    // 2. Group overrides to a different runtime (Antigravity) -> must NOT leak bot's Codex model or xhigh effort
    const crossEngineGroup = LarkGroupConfigSchema.parse({
      key: 'dsh-bot:oc_agy',
      botId: 'dsh-bot',
      chatId: 'oc_agy',
      runtimeMode: 'override',
      agentPreset: 'agy',
      model: 'gemini-4-neon-high',
      reasoningEffort: '',
    })
    const crossDecision = decideLarkRouting(
      bot,
      createMessage({
        chatId: 'oc_agy',
        text: '@_bot_1 analyze architecture',
        mentions: [{ key: '@_bot_1', openId: 'ou_bot', name: 'DSH-Bot' }],
      }),
      { groupConfig: crossEngineGroup, hasActiveSessionForRoute: () => false },
    )
    expect(crossDecision.action).toBe('agent')
    if (crossDecision.action === 'agent') {
      expect(crossDecision.agentPreset).toBe('agy')
      expect(crossDecision.model).toBe('gemini-4-neon-high')
      expect(crossDecision.reasoningEffort).toBeUndefined()
    }

    // 3. Legacy stored group with agentPreset/model without runtimeMode auto-migrates to override
    const legacyGroup = LarkGroupConfigSchema.parse({
      key: 'dsh-bot:oc_legacy',
      botId: 'dsh-bot',
      chatId: 'oc_legacy',
      agentPreset: 'codex',
      model: 'gpt-6.2-sol',
      reasoningEffort: 'medium',
    })
    expect(legacyGroup.runtimeMode).toBe('override')
    const legacyDecision = decideLarkRouting(
      bot,
      createMessage({
        chatId: 'oc_legacy',
        text: '@_bot_1 review diff',
        mentions: [{ key: '@_bot_1', openId: 'ou_bot', name: 'DSH-Bot' }],
      }),
      { groupConfig: legacyGroup, hasActiveSessionForRoute: () => false },
    )
    expect(legacyDecision).toMatchObject({
      action: 'agent',
      agentPreset: 'codex',
      model: 'gpt-6.2-sol',
      reasoningEffort: 'medium',
    })
  })

  it('renders QR SVG data URI, generates valid 512x512 PNG icon, and parses post content', () => {
    const svgUri = renderQrSvgDataUrl('https://open.feishu.cn')
    expect(svgUri.startsWith('data:image/svg+xml;utf8,')).toBe(true)

    const png = generateDefaultBotIconPng()
    expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true)
    expect(png.readUInt32BE(16)).toBe(512)
    expect(png.readUInt32BE(20)).toBe(512)

    const dedup = new MessageDeduplicator(1000, 10)
    expect(dedup.claim('m1', 100)).toBe(true)
    expect(dedup.claim('m1', 500)).toBe(false)

    const parsed = parseLarkMessageContent(
      'post',
      JSON.stringify({
        zh_cn: {
          title: '状态通报',
          content: [[{ tag: 'text', text: '延迟升高' }, { tag: 'img', image_key: 'img_v3_1' }]],
        },
      }),
    )
    expect(parsed.text).toContain('状态通报')
    expect(parsed.imageKeys).toEqual(['img_v3_1'])

    // Post message with empty user_name `<at>` node or `<at user_id=...></at>` md text still routes to slash command `/status`
    const parsedEmptyAtPost = parseLarkMessageContent(
      'post',
      JSON.stringify({
        zh_cn: {
          content: [[{ tag: 'at', user_id: 'ou_bot', user_name: '' }, { tag: 'text', text: ' /status' }]],
        },
      }),
    )
    expect(parsedEmptyAtPost.text).toBe('/status')

    const bot = createBot()
    const slashFromPost = decideLarkRouting(
      bot,
      createMessage({
        msgType: 'post',
        text: parsedEmptyAtPost.text,
        mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'DSH-Bot' }],
      }),
      { hasActiveSessionForRoute: () => false },
    )
    expect(slashFromPost).toMatchObject({
      action: 'command',
      command: { name: 'status', args: '' },
    })

    const parsedInlineMdAtPost = parseLarkMessageContent(
      'post',
      JSON.stringify({
        zh_cn: {
          content: [[{ tag: 'md', text: '<at user_id="ou_bot"></at> /status' }]],
        },
      }),
    )
    const slashFromInlineMdPost = decideLarkRouting(
      bot,
      createMessage({
        msgType: 'post',
        text: parsedInlineMdAtPost.text,
        mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'DSH-Bot' }],
      }),
      { hasActiveSessionForRoute: () => false },
    )
    expect(slashFromInlineMdPost).toMatchObject({
      action: 'command',
      command: { name: 'status', args: '' },
    })
  })

  it('resolves sendIntermediateMessages from bot default and per-group inherit/on/off overrides', () => {
    const botOff = createBot({ sendIntermediateMessages: false })
    const botOn = createBot({ sendIntermediateMessages: true })

    const inheritGroup = LarkGroupConfigSchema.parse({
      key: 'dsh-bot:oc_inherit_im',
      botId: 'dsh-bot',
      chatId: 'oc_inherit_im',
    })
    const onGroup = LarkGroupConfigSchema.parse({
      key: 'dsh-bot:oc_on_im',
      botId: 'dsh-bot',
      chatId: 'oc_on_im',
      intermediateMessages: 'on',
    })
    const offGroup = LarkGroupConfigSchema.parse({
      key: 'dsh-bot:oc_off_im',
      botId: 'dsh-bot',
      chatId: 'oc_off_im',
      intermediateMessages: 'off',
    })

    const msg = createMessage({
      text: '@_bot_1 check',
      mentions: [{ key: '@_bot_1', openId: 'ou_bot', name: 'DSH-Bot' }],
    })

    expect(
      decideLarkRouting(botOff, msg, { groupConfig: inheritGroup, hasActiveSessionForRoute: () => false }),
    ).toMatchObject({ action: 'agent', sendIntermediateMessages: false })
    expect(
      decideLarkRouting(botOff, msg, { groupConfig: onGroup, hasActiveSessionForRoute: () => false }),
    ).toMatchObject({ action: 'agent', sendIntermediateMessages: true })
    expect(
      decideLarkRouting(botOn, msg, { groupConfig: inheritGroup, hasActiveSessionForRoute: () => false }),
    ).toMatchObject({ action: 'agent', sendIntermediateMessages: true })
    expect(
      decideLarkRouting(botOn, msg, { groupConfig: offGroup, hasActiveSessionForRoute: () => false }),
    ).toMatchObject({ action: 'agent', sendIntermediateMessages: false })
  })

  it('resolves mentionTriggerMode from bot default and per-group inherit/override policies', () => {
    const botActiveThread = createBot({ mentionTriggerMode: 'mention_and_active_thread' })
    const botMentionOnly = createBot({ mentionTriggerMode: 'mention_only' })

    const inheritGroup = LarkGroupConfigSchema.parse({
      key: 'dsh-bot:oc_trigger_inherit',
      botId: 'dsh-bot',
      chatId: 'oc_trigger_inherit',
    })
    const groupMentionOnly = LarkGroupConfigSchema.parse({
      key: 'dsh-bot:oc_trigger_mention_only',
      botId: 'dsh-bot',
      chatId: 'oc_trigger_mention_only',
      mentionTriggerMode: 'mention_only',
    })
    const groupActiveThread = LarkGroupConfigSchema.parse({
      key: 'dsh-bot:oc_trigger_active_thread',
      botId: 'dsh-bot',
      chatId: 'oc_trigger_active_thread',
      mentionTriggerMode: 'mention_and_active_thread',
    })

    const threadFollowup = createMessage({
      chatId: 'oc_trigger_inherit',
      rootId: 'om_root_1',
      threadId: 'omt_thread_1',
      text: '继续追问一下这个报错',
      mentions: [],
    })

    // 1. Inherit bot=mention_and_active_thread -> triggers active-thread
    expect(
      decideLarkRouting(botActiveThread, threadFollowup, {
        groupConfig: inheritGroup,
        hasActiveSessionForRoute: () => true,
      }),
    ).toMatchObject({ action: 'agent', trigger: 'active-thread' })

    // 2. Group overrides to mention_only while bot=mention_and_active_thread -> ignores un-mentioned thread reply
    expect(
      decideLarkRouting(
        botActiveThread,
        { ...threadFollowup, chatId: 'oc_trigger_mention_only' },
        {
          groupConfig: groupMentionOnly,
          hasActiveSessionForRoute: () => true,
        },
      ),
    ).toEqual({ action: 'ignore', reason: 'no_matching_rule' })

    // 3. Group overrides to mention_and_active_thread while bot=mention_only -> triggers active-thread
    expect(
      decideLarkRouting(
        botMentionOnly,
        { ...threadFollowup, chatId: 'oc_trigger_active_thread' },
        {
          groupConfig: groupActiveThread,
          hasActiveSessionForRoute: () => true,
        },
      ),
    ).toMatchObject({ action: 'agent', trigger: 'active-thread' })
  })

  it('resolves group-level message, reaction, and card footer overrides while isolating P2P', () => {
    const bot = createBot({
      receivedReactionEmoji: 'OnIt',
      useInteractiveCard: true,
      dshSessionLinkInCard: true,
      replyFooterEnabled: true,
      replyFooterModel: true,
      replyFooterSignature: true,
      signature: '智能体默认签名',
    })

    // 1. Default inherit group preserves bot reaction and card footer settings
    const inheritGroup = LarkGroupConfigSchema.parse({
      key: 'dsh-bot:oc_msg_inherit',
      botId: 'dsh-bot',
      chatId: 'oc_msg_inherit',
      idleCloseMinutes: null,
    })
    expect(inheritGroup.idleCloseMinutes).toBeUndefined()
    expect(resolveEffectiveReactionEmoji(bot, inheritGroup)).toBe('OnIt')
    const inheritedCard = buildReplyCard({
      markdown: '测试卡片',
      bot: resolveEffectiveCardBot(bot, inheritGroup),
      modelLabel: 'Codex · GPT-6.1-Sol',
      sessionUrl: 'http://192.168.1.10:3880/#session=s1',
    })
    const inheritedJson = JSON.stringify(inheritedCard)
    expect(inheritedJson).toContain('智能体默认签名')
    expect(inheritedJson).toContain('Codex · GPT-6.1-Sol')
    expect(inheritedJson).toContain('在 DSH 接管会话')

    // 2. Group overrides reaction and card footer (custom signature + hide link/model)
    const customGroup = LarkGroupConfigSchema.parse({
      key: 'dsh-bot:oc_msg_custom',
      botId: 'dsh-bot',
      chatId: 'oc_msg_custom',
      receivedReactionEmoji: 'THUMBSUP',
      replyFormat: 'card',
      dshSessionLinkInCard: 'off',
      replyFooterModel: 'off',
      signatureMode: 'custom',
      signature: '本群专属页脚签名',
    })
    const mentionDecision = decideLarkRouting(
      bot,
      createMessage({
        chatId: 'oc_msg_custom',
        text: '@_bot_1 请查看状态',
        mentions: [{ key: '@_bot_1', openId: 'ou_bot', name: 'DSH-Bot' }],
      }),
      { groupConfig: customGroup, hasActiveSessionForRoute: () => false },
    )
    expect(mentionDecision).toMatchObject({
      action: 'agent',
      receivedReactionEmoji: 'THUMBSUP',
      useCard: true,
    })

    const customCard = buildReplyCard({
      markdown: '测试本群卡片',
      bot: resolveEffectiveCardBot(bot, customGroup),
      modelLabel: 'Codex · GPT-6.1-Sol',
      sessionUrl: 'http://192.168.1.10:3880/#session=s1',
    })
    const customJson = JSON.stringify(customCard)
    expect(customJson).toContain('本群专属页脚签名')
    expect(customJson).not.toContain('智能体默认签名')
    expect(customJson).not.toContain('Codex · GPT-6.1-Sol')
    expect(customJson).not.toContain('在 DSH 接管会话')

    // 3. Group suppresses reaction ('NONE') and signature ('off')
    const quietGroup = LarkGroupConfigSchema.parse({
      key: 'dsh-bot:oc_msg_quiet',
      botId: 'dsh-bot',
      chatId: 'oc_msg_quiet',
      receivedReactionEmoji: 'NONE',
      signatureMode: 'off',
      replyFooterModel: 'on',
    })
    const quietDecision = decideLarkRouting(
      bot,
      createMessage({
        chatId: 'oc_msg_quiet',
        text: '@_bot_1 安静检查',
        mentions: [{ key: '@_bot_1', openId: 'ou_bot', name: 'DSH-Bot' }],
      }),
      { groupConfig: quietGroup, hasActiveSessionForRoute: () => false },
    )
    expect(quietDecision.action).toBe('agent')
    if (quietDecision.action === 'agent') {
      expect(quietDecision.receivedReactionEmoji).toBeUndefined()
    }
    const quietCardJson = JSON.stringify(
      buildReplyCard({
        markdown: '无签名卡片',
        bot: resolveEffectiveCardBot(bot, quietGroup),
        modelLabel: 'Codex · GPT-6.1-Sol',
      }),
    )
    expect(quietCardJson).not.toContain('智能体默认签名')
    expect(quietCardJson).toContain('Codex · GPT-6.1-Sol')
  })

  it('distinguishes substitute disclosure modes and honors activeThreadFollowup', () => {
    const msg = createMessage({
      text: '@_user_1 请看下接口超时原因',
      mentions: [{ key: '@_user_1', openId: 'ou_owner', name: 'Alex Chen' }],
    })

    for (const disclosure of ['none', 'subtle', 'explicit'] as const) {
      const bot = createBot({
        substituteMode: {
          enabled: true,
          targets: [{ openId: 'ou_owner', name: 'Alex Chen' }],
          disclosure,
          activeThreadFollowup: disclosure !== 'none',
        },
      })
      const decision = decideLarkRouting(bot, msg, { hasActiveSessionForRoute: () => false })
      expect(decision.action).toBe('agent')
      if (decision.action === 'agent') {
        expect(decision.promptText).toContain(`disclosure="${disclosure}"`)
        expect(decision.autoCloseAfterCompletion).toBe(disclosure === 'none')
      }
    }

    // Even when mentionTriggerMode is 'mention_only', an active substitute thread continues when activeThreadFollowup=true
    const followupBot = createBot({
      mentionTriggerMode: 'mention_only',
      substituteMode: {
        enabled: true,
        targets: [{ openId: 'ou_owner', name: 'Alex Chen' }],
        disclosure: 'explicit',
        activeThreadFollowup: true,
      },
    })
    const followupDecision = decideLarkRouting(
      followupBot,
      createMessage({ rootId: 'om_sub_root', text: '再补充一下日志链路' }),
      {
        hasActiveSessionForRoute: () => true,
        getRouteTrigger: () => 'substitute',
      },
    )
    expect(followupDecision).toMatchObject({ action: 'agent', trigger: 'active-thread' })
  })

  it('builds runtime-agnostic Dreaming prompts with editable scopes and decoupled Proactive reminder/worktree protocols', () => {
    const workDir = '/Users/demo/workspace/core-service'
    const defaultBot = createBot({ defaultWorkingDir: workDir })
    expect(defaultBot.experimental.dreaming.scopes).toEqual([...DEFAULT_DREAMING_SCOPES])
    expect(defaultBot.experimental.proactive).toEqual({
      remindersEnabled: false,
      reminderCreationMode: 'silent',
      autoCodeEnabled: false,
      branchPrefix: 'agent/',
    })

    // Legacy boolean flags cleanly migrate to atomic scopes without runtime-specific fields
    const migrated = createBot({
      experimental: {
        dreaming: {
          enabled: true,
          scheduleTime: '2:05',
          extractPreferences: true,
          extractDomainKnowledge: false,
          extractOpenLoops: false,
        },
      },
    })
    expect(migrated.experimental.dreaming.scheduleTime).toBe('02:05')
    expect(migrated.experimental.dreaming.scopes).toEqual(['个人偏好', '协作约定'])

    // Custom scopes + decoupled proactive config
    const bot = createBot({
      defaultWorkingDir: workDir,
      experimental: {
        dreaming: {
          enabled: true,
          scheduleTime: '02:00',
          minNewSessions: 2,
          scopes: ['个人偏好', '核心链路发布红线', '未完成待办'],
          cleanupAndCorrect: true,
        },
        proactive: {
          remindersEnabled: true,
          reminderCreationMode: 'confirm',
          autoCodeEnabled: true,
          branchPrefix: 'fix/',
        },
      },
    })

    const dreamPrompt = composeDreamExecutionPrompt({
      botId: bot.id,
      botName: bot.name,
      workingDir: workDir,
      currentDateIso: '2026-11-22',
      transcriptDigestPath: '/Users/demo/.dsh/lark-bridge/dreaming/dsh-bot/recent-transcripts.md',
      sessionCount: 4,
      config: bot.experimental.dreaming,
      proactive: bot.experimental.proactive,
    })
    expect(dreamPrompt).not.toMatch(/Claude/i)
    expect(dreamPrompt).not.toContain('.local/')
    expect(dreamPrompt).toContain('<system_reminder>\n<dream_job ')
    expect(dreamPrompt).not.toContain('lark_dream_job')
    expect(dreamPrompt).toContain('核心链路发布红线')
    expect(dreamPrompt).toContain('直接调用并维护你自身内置的长期记忆（Memory）机制')
    expect(dreamPrompt).toContain(`${workDir}/.worktrees/`)
    expect(dreamPrompt).toContain('lark-bridge reminder create')

    // Session-level proactive reminder injection
    expect(
      composeProactiveSessionReminder({
        botId: bot.id,
        workingDir: workDir,
        config: defaultBot.experimental.proactive,
      }),
    ).toBeUndefined()

    const proactiveReminder = composeProactiveSessionReminder({
      botId: bot.id,
      workingDir: workDir,
      config: bot.experimental.proactive,
    })
    expect(proactiveReminder).toContain('<proactive reminders="confirm" auto_code="on">')
    expect(proactiveReminder).not.toContain('lark_proactive')
    expect(proactiveReminder).toContain('变更与止损后复查')
    expect(proactiveReminder).toContain(`${workDir}/.worktrees/`)
    expect(proactiveReminder).toContain('--worktree <path> --branch <branch> [--pr <url>]')
    expect(proactiveReminder).not.toContain('--worktree-path')
    expect(proactiveReminder).not.toContain('.local/')

    // One-shot reminder trigger prompt & cards
    const item = LarkReminderItemSchema.parse({
      id: 'rem-1',
      title: '核查下午发版是否完成',
      prompt: '检查群消息与最新部署记录，未执行则提醒负责人',
      reason: '开发群约定今日 16:00 发版',
      scheduledAt: '2026-11-22T09:00:00.000Z',
      status: 'pending_confirm',
      origin: {
        botId: 'dsh-bot',
        botName: 'DSH-Bot',
        larkAppId: 'cli_dsh_app',
        chatType: 'group',
        chatId: 'oc_team_dev',
        chatName: '核心研发群',
        replyToMessageId: 'om_root_1',
        deliveryMode: 'thread',
      },
      mentions: [{ openId: 'ou_owner', name: 'Alex Chen' }],
      worktree: {
        worktreePath: `${workDir}/.worktrees/fix-timeout`,
        branch: 'fix/fix-timeout',
      },
      createdAtMs: 1000,
      updatedAtMs: 1000,
    })

    const manySiblings = Array.from({ length: 12 }, (_, idx) => ({
      id: `rem-sib-${idx + 1}`,
      title: `同源事项 ${idx + 1}`,
      scheduledAt: `2026-11-22 18:${String(idx).padStart(2, '0')}`,
    }))
    const triggerPrompt = composeReminderTriggerPrompt({
      item,
      currentLocalTimeStr: '2026-11-22 17:00',
      siblingActiveReminders: manySiblings,
    })
    expect(triggerPrompt).toContain('<system_reminder>\n<reminder_trigger reminder_id="rem-1"')
    expect(triggerPrompt).not.toContain('lark_reminder_trigger')
    expect(triggerPrompt).toContain('bot_id="dsh-bot"')
    expect(triggerPrompt).toContain('- 关注人员：Alex Chen(open_id="ou_owner")')
    expect(triggerPrompt).not.toContain('- 群成员：')
    expect(triggerPrompt).toContain('lark-bridge members --query <姓名>')
    expect(triggerPrompt).toContain('rem-sib-10「同源事项 10」')
    expect(triggerPrompt).not.toContain('rem-sib-11')
    expect(triggerPrompt).toContain('另有 2 条待触发')
    expect(triggerPrompt).toContain(REMINDER_SILENT_SENTINEL)
    expect(triggerPrompt).toContain('fix/fix-timeout')

    const p2pTriggerPrompt = composeReminderTriggerPrompt({
      item: {
        ...item,
        id: 'rem-p2p',
        mentions: [],
        origin: {
          botId: 'dsh-bot',
          botName: 'DSH-Bot',
          larkAppId: 'cli_dsh_app',
          chatType: 'p2p',
          deliveryMode: 'p2p',
          userOpenId: 'ou_owner',
          userName: 'Alex Chen',
        },
      },
      currentLocalTimeStr: '2026-11-22 17:00',
    })
    expect(p2pTriggerPrompt).not.toContain('lark-bridge members')
    expect(p2pTriggerPrompt).not.toContain('- 群成员：')

    expect(extractReminderTriggerOutput(REMINDER_SILENT_SENTINEL)).toBeUndefined()
    expect(extractReminderTriggerOutput('   ')).toBeUndefined()
    expect(extractReminderTriggerOutput('发版尚未执行，请 @Alex Chen 确认')).toContain('发版尚未执行')

    const confirmCardStr = JSON.stringify(
      buildReminderConfirmCard(item, '2026-11-22 17:00'),
    )
    expect(confirmCardStr).toContain('lark_reminder_confirm')
    expect(confirmCardStr).toContain('approve')
    expect(confirmCardStr).toContain('reject')

    const noticeCardStr = JSON.stringify(
      buildReminderNoticeCard(item, '2026-11-22 17:00'),
    )
    expect(noticeCardStr).toContain('lark_reminder_cancel')
  })

  it('converts Markdown into Lark post (`tag: md`) and Card 2.0 markdown while fixing malformed bold & preserving code/URLs', () => {
    const rawAlertReply = [
      '# 告警排查报告',
      '高概率原因是 **订单异步消费中的任务汇总锁争用**。',
      '',
      '监控平台确认请求和状态回读均超时，确认结果不明；**1 小时屏蔽未执行**。',
      '',
      '- **止损方式**：暂缓本批异步任务新增及批量重试，先执行**“确认并屏蔽”**操作。',
      '- **根本原因**：等待 **3200 毫秒**后返回 `503001 / failed to acquire lock`；入口为 `worker.go:142 -> lock.go:58`。[查看证据](https://status.example.com/trace/a__b__c)。',
      '- [ ] 待核查具体持锁者与 __核心配置__',
      '  * 嵌套子项 1',
      '- **后续行动**：补齐监控。<at id="ou_owner">Alex Chen</at> **目前未确认恢复。 **',
      '',
      '```python',
      'def __init__(self, **kwargs):',
      '    pass',
      '```',
    ].join('\n')

    const postPayload = buildLarkPostPayload(rawAlertReply) as {
      zh_cn: { content: Array<Array<{ tag: string; text: string }>> }
    }
    const postMd = postPayload.zh_cn.content[0]![0]!
    expect(postMd.tag).toBe('md')
    expect(postMd.text).toContain('#### 告警排查报告')
    expect(postMd.text).toContain('**目前未确认恢复。**')
    expect(postMd.text).not.toContain('**目前未确认恢复。 **')
    expect(postMd.text).toContain('先执行 **“确认并屏蔽”** 操作')
    expect(postMd.text).toContain('**核心配置**')
    expect(postMd.text).toContain('https://status.example.com/trace/a__b__c')
    expect(postMd.text).toContain('- ☐ 待核查具体持锁者')
    expect(postMd.text).toContain('\n    - 嵌套子项 1')
    expect(postMd.text).toContain('<at user_id="ou_owner">Alex Chen</at>')
    expect(postMd.text).toContain('def __init__(self, **kwargs):')

    // Inbound parser also reads `post` with `tag: "md"` cleanly
    const parsedPost = parseLarkMessageContent('post', JSON.stringify(postPayload))
    expect(parsedPost.text).toContain('订单异步消费中的任务汇总锁争用')

    // Card formatting normalizes `<at user_id=...>` -> `<at id=...>` and repairs malformed bold
    const cardMd = formatMarkdownForLarkCard(
      '请 <at user_id="ou_owner">Alex</at> 核实：**目前未确认恢复。 **',
    )
    expect(cardMd).toBe('请 <at id="ou_owner">Alex</at> 核实：**目前未确认恢复。**')
    expect(formatMarkdownForLarkPost('**A** 和 **B**')).toBe('**A** 和 **B**')
  })
})
