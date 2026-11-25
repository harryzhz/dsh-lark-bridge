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
  SILENT_REPLY_SENTINEL,
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
  formatReminderOutputWithMentions,
  generateDefaultBotIconPng,
  hasInjectedPromptMarkup,
  hasVisibleText,
  isSilentReplySentinel,
  leafDirectoryName,
  normalizeReplyText,
  parseLarkMessageContent,
  renderQrSvgDataUrl,
  resolveEffectiveCardBot,
  resolveEffectiveGuestReadOnly,
  resolveEffectiveReactionEmoji,
  resolveEffectiveWorkspaceName,
  trimInvisibleText,
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

    const mentionCtx = composeLarkContextReminder({
      bot,
      botOpenId: 'ou_bot',
      msg: createMessage(),
      trigger: 'mention',
      allowSilentEmptyReply: false,
      includeFullGuide: false,
    })
    expect(mentionCtx).toContain('trigger="mention"')
    expect(mentionCtx).toContain('本轮禁止静默')
    expect(mentionCtx).toContain('简短礼貌说明职责边界并拒答')

    const listenerCtx = composeLarkContextReminder({
      bot,
      botOpenId: 'ou_bot',
      msg: createMessage(),
      trigger: 'listener',
      allowSilentEmptyReply: true,
      includeFullGuide: false,
    })
    expect(listenerCtx).toContain('trigger="listener"')
    expect(listenerCtx).not.toContain('本轮禁止静默')

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
          '静默约定：判断无需回复时，仅输出 `<no_reply/>` 或完全不输出正文（禁止输出空格、零宽字符或解释性拒答）。',
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
      delegationFollowupEnabled: false,
      quietHoursEnabled: false,
      quietHoursStart: '00:00',
      quietHoursEnd: '08:00',
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
    expect(dreamPrompt).toContain('lark-bridge memory upsert')
    expect(dreamPrompt).toContain('lark-bridge memory supersede')
    expect(dreamPrompt).toContain('lark-bridge memory forget')
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
    expect(proactiveReminder).toContain('变更止损复查')
    expect(proactiveReminder).toContain('建后发确认卡待确认')
    expect(proactiveReminder).not.toContain('--urgency high')
    expect(proactiveReminder).toContain(`${workDir}/.worktrees/`)
    expect(proactiveReminder).toContain('--worktree <path> --branch <branch> [--pr <url>]')
    expect(proactiveReminder).not.toContain('--worktree-path')
    expect(proactiveReminder).not.toContain('.local/')
    expect(proactiveReminder!.length).toBeLessThan(600)

    const quietHoursReminder = composeProactiveSessionReminder({
      botId: bot.id,
      workingDir: workDir,
      config: {
        ...bot.experimental.proactive,
        reminderCreationMode: 'silent',
        quietHoursEnabled: true,
        quietHoursStart: '23:00',
        quietHoursEnd: '09:00',
        autoCodeEnabled: false,
      },
    })
    expect(quietHoursReminder).toContain('<proactive reminders="silent" auto_code="off">')
    expect(quietHoursReminder).toContain('免打扰 23:00–09:00')
    expect(quietHoursReminder).toContain('--urgency high')
    expect(quietHoursReminder).not.toContain('lark-bridge worktree')

    const autoCodeOnlyReminder = composeProactiveSessionReminder({
      botId: bot.id,
      workingDir: workDir,
      config: {
        ...bot.experimental.proactive,
        remindersEnabled: false,
        autoCodeEnabled: true,
      },
    })
    expect(autoCodeOnlyReminder).toContain('<proactive reminders="off" auto_code="on">')
    expect(autoCodeOnlyReminder).toContain(`${workDir}/.worktrees/`)
    expect(autoCodeOnlyReminder).not.toContain('lark-bridge reminder create')

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
    expect(triggerPrompt).toContain('- 主负责人（必 @）：Alex Chen(open_id="ou_owner")')
    expect(triggerPrompt).not.toContain('- 群成员：')
    expect(triggerPrompt).toContain('lark-bridge members --query <姓名>')
    expect(triggerPrompt).toContain('群聊提醒严禁无 @ 群发')
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
    expect(noticeCardStr).toContain('Alex Chen')

    // Delegation reminder prompt, proactive directive & mention/cc delivery formatting
    const delegationProactive = composeProactiveSessionReminder({
      botId: bot.id,
      workingDir: workDir,
      config: {
        ...bot.experimental.proactive,
        remindersEnabled: true,
        delegationFollowupEnabled: true,
        quietHoursEnabled: true,
        quietHoursStart: '00:00',
        quietHoursEnd: '08:00',
      },
    })
    expect(delegationProactive).toContain('delegation="on"')
    expect(delegationProactive).toContain('--kind delegation')
    expect(delegationProactive).toContain('紧急故障 10m')
    expect(delegationProactive).toContain('免打扰 00:00–08:00')

    const delegationItem = LarkReminderItemSchema.parse({
      ...item,
      id: 'rem-del-1',
      kind: 'delegation',
      mentions: [{ openId: 'ou_bob', name: 'Bob' }],
      ccMentions: [{ openId: 'ou_alex', name: 'Alex' }],
    })
    const delegationTrigger = composeReminderTriggerPrompt({
      item: delegationItem,
      currentLocalTimeStr: '2026-11-22 17:00',
    })
    expect(delegationTrigger).toContain('kind="delegation"')
    expect(delegationTrigger).toContain('- 主负责人（必 @）：Bob(open_id="ou_bob")')
    expect(delegationTrigger).toContain('- 抄送关注（cc）：Alex(open_id="ou_alex")')
    expect(delegationTrigger).toContain('lark-bridge history --thread none --limit 20')
    expect(delegationTrigger).toContain('尚未给出最终结果')

    expect(
      formatReminderOutputWithMentions({
        chatType: 'group',
        markdown: '登录超时排查暂未看到进展，方便确认下当前状态吗？',
        mentions: [{ openId: 'ou_bob', name: 'Bob' }],
        ccMentions: [
          { openId: 'ou_bob', name: 'Bob' },
          { openId: 'ou_alex', name: 'Alex' },
        ],
      }),
    ).toBe(
      '<at id="ou_bob">Bob</at>\n\n登录超时排查暂未看到进展，方便确认下当前状态吗？\n\ncc <at id="ou_alex">Alex</at>',
    )

    expect(
      formatReminderOutputWithMentions({
        chatType: 'group',
        markdown: '<at id="ou_bob">Bob</at> 麻烦同步下 PR 进展（cc <at id="ou_alex">Alex</at>）',
        mentions: [{ openId: 'ou_bob', name: 'Bob' }],
        ccMentions: [{ openId: 'ou_alex', name: 'Alex' }],
      }),
    ).toBe('<at id="ou_bob">Bob</at> 麻烦同步下 PR 进展（cc <at id="ou_alex">Alex</at>）')

    expect(
      formatReminderOutputWithMentions({
        chatType: 'p2p',
        markdown: '私聊提醒内容',
        mentions: [{ openId: 'ou_bob', name: 'Bob' }],
        ccMentions: [{ openId: 'ou_alex', name: 'Alex' }],
      }),
    ).toBe('私聊提醒内容')
  })

  it('routes A @ B peer delegation messages silently when bot delegationFollowupEnabled is on, without affecting disabled/self/all/bare mentions', () => {
    const bot = createBot({
      experimental: {
        dreaming: { enabled: false },
        proactive: {
          remindersEnabled: true,
          delegationFollowupEnabled: true,
          reminderCreationMode: 'silent',
        },
      },
    })
    const offBot = createBot({
      experimental: {
        dreaming: { enabled: false },
        proactive: {
          remindersEnabled: true,
          delegationFollowupEnabled: false,
          reminderCreationMode: 'silent',
        },
      },
    })

    const peerDelegationMsg = createMessage({
      messageId: 'om_del_1',
      senderOpenId: 'ou_alex',
      text: '@_user_1 帮我看下这个 PR 能不能合入',
      mentions: [{ key: '@_user_1', openId: 'ou_bob', name: 'Bob' }],
    })

    // Disabled bot ignores peer mentions when no group listener is configured
    expect(
      decideLarkRouting(offBot, peerDelegationMsg, { hasActiveSessionForRoute: () => false }),
    ).toEqual({ action: 'ignore', reason: 'no_matching_rule' })

    // Enabled bot routes A @ B to Branch 6 silent-only delegation observer (no reaction, no chat reply)
    const d1 = decideLarkRouting(bot, peerDelegationMsg, { hasActiveSessionForRoute: () => false })
    expect(d1.action).toBe('agent')
    if (d1.action === 'agent') {
      expect(d1.trigger).toBe('listener')
      expect(d1.sessionMode).toBe('per_message')
      expect(d1.replyMode).toBe('new-topic')
      expect(d1.silentOnly).toBe(true)
      expect(d1.delegationFollowup).toBe(true)
      expect(d1.receivedReactionEmoji).toBeUndefined()
      expect(d1.listenerName).toBe('委派事项跟进')
      expect(d1.promptText).toContain('<delegation_followup mode="silent_only"')
    }

    // Self-mention, @all, bare @B without text, and bot sender do NOT trigger Branch 6
    const selfMsg = createMessage({
      senderOpenId: 'ou_alex',
      text: '@_user_1 记个笔记',
      mentions: [{ key: '@_user_1', openId: 'ou_alex', name: 'Alex' }],
    })
    expect(decideLarkRouting(bot, selfMsg, { hasActiveSessionForRoute: () => false }).action).toBe('ignore')

    const allMsg = createMessage({
      senderOpenId: 'ou_alex',
      text: '@_all 大家下午三点开会',
      mentions: [{ key: '@_all', openId: 'all', name: '所有人' }],
    })
    expect(decideLarkRouting(bot, allMsg, { hasActiveSessionForRoute: () => false }).action).toBe('ignore')

    const bareMsg = createMessage({
      senderOpenId: 'ou_alex',
      text: '@_user_1',
      mentions: [{ key: '@_user_1', openId: 'ou_bob', name: 'Bob' }],
    })
    expect(decideLarkRouting(bot, bareMsg, { hasActiveSessionForRoute: () => false }).action).toBe('ignore')

    // Group with top_level listener: reply-level A @ B misses listener -> cleanly falls through to Branch 6!
    const topLevelGroup = LarkGroupConfigSchema.parse({
      key: `${bot.id}:oc_team_dev`,
      botId: bot.id,
      chatId: 'oc_team_dev',
      enabled: true,
      listener: {
        enabled: true,
        name: '告警排查',
        prompt: '仅响应告警',
        scope: 'top_level',
      },
    })
    const replyDelegationMsg = createMessage({
      messageId: 'om_del_reply',
      rootId: 'om_alert_root',
      parentId: 'om_alert_root',
      senderOpenId: 'ou_alex',
      text: '@_user_1 这个限流告警麻烦看下',
      mentions: [{ key: '@_user_1', openId: 'ou_bob', name: 'Bob' }],
    })
    const dReply = decideLarkRouting(bot, replyDelegationMsg, {
      groupConfig: topLevelGroup,
      hasActiveSessionForRoute: () => false,
    })
    expect(dReply.action).toBe('agent')
    if (dReply.action === 'agent') {
      expect(dReply.silentOnly).toBe(true)
      expect(dReply.delegationFollowup).toBe(true)
      expect(dReply.promptText).toContain('<delegation_followup mode="silent_only"')
    }

    // Group with matched listener: appends assist delegation guidance without forcing silentOnly
    const dMatchedListener = decideLarkRouting(bot, peerDelegationMsg, {
      groupConfig: topLevelGroup,
      hasActiveSessionForRoute: () => false,
    })
    expect(dMatchedListener.action).toBe('agent')
    if (dMatchedListener.action === 'agent') {
      expect(dMatchedListener.silentOnly).toBeUndefined()
      expect(dMatchedListener.delegationFollowup).toBe(true)
      expect(dMatchedListener.promptText).toContain('<delegation_followup mode="assist"')
    }
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

  it('guards listener threads from premature active-thread hijacking and preserves silent reply semantics after replying', () => {
    const bot = createBot({ mentionTriggerMode: 'mention_and_active_thread' })
    const dailyGroup = LarkGroupConfigSchema.parse({
      key: 'dsh-bot:oc_daily',
      botId: 'dsh-bot',
      chatId: 'oc_daily',
      enabled: true,
      listener: {
        enabled: true,
        name: '工作日常',
        prompt: '明确 @其他成员 时必须输出空文本保持静默。',
        scope: 'all',
        replyMode: 'reply',
        sessionMode: 'thread',
        allowSilentEmptyReply: true,
        autoCloseAfterCompletion: false,
        excludeKeywords: ['@'],
      },
    })
    const topLevelGroup = LarkGroupConfigSchema.parse({
      key: 'dsh-bot:oc_alert',
      botId: 'dsh-bot',
      chatId: 'oc_alert',
      enabled: true,
      listener: {
        enabled: true,
        name: '告警排查',
        prompt: '仅在告警时排查，其他静默。',
        scope: 'top_level',
        replyMode: 'new-topic',
        sessionMode: 'thread',
        allowSilentEmptyReply: true,
        autoCloseAfterCompletion: false,
      },
    })

    const quotedPeerMention = createMessage({
      chatId: 'oc_daily',
      messageId: 'om_reply_2',
      rootId: 'om_root_1',
      parentId: 'om_root_1',
      text: '@_user_2 空降',
      mentions: [{ key: '@_user_2', openId: 'ou_peer', name: 'Sam' }],
    })

    // 1. Before bot has replied in a listener thread, follow-up must NOT bypass listener filters via active-thread
    expect(
      decideLarkRouting(bot, quotedPeerMention, {
        groupConfig: dailyGroup,
        hasActiveSessionForRoute: () => true,
        getRouteTrigger: () => 'listener',
        hasRouteReplied: () => false,
      }),
    ).toEqual({ action: 'ignore', reason: 'listener_keyword_excluded' })

    // 2. Non-excluded follow-up before first reply still falls through to listener (preserving allowSilentEmptyReply & replyMode)
    const quotedPlain = createMessage({
      chatId: 'oc_daily',
      messageId: 'om_reply_3',
      rootId: 'om_root_1',
      parentId: 'om_root_1',
      text: '我也注意到人变多了',
      mentions: [],
    })
    expect(
      decideLarkRouting(bot, quotedPlain, {
        groupConfig: dailyGroup,
        hasActiveSessionForRoute: () => true,
        getRouteTrigger: () => 'listener',
        hasRouteReplied: () => false,
      }),
    ).toMatchObject({
      action: 'agent',
      trigger: 'listener',
      replyMode: 'reply',
      allowSilentEmptyReply: true,
    })

    // 3. For top_level listener before first reply, thread follow-up is ignored as listener_not_top_level
    expect(
      decideLarkRouting(
        bot,
        createMessage({
          chatId: 'oc_alert',
          messageId: 'om_alert_reply',
          rootId: 'om_alert_root',
          parentId: 'om_alert_root',
          text: '这条回复在机器人还没发言前出现',
        }),
        {
          groupConfig: topLevelGroup,
          hasActiveSessionForRoute: () => true,
          getRouteTrigger: () => 'listener',
          hasRouteReplied: () => false,
        },
      ),
    ).toEqual({ action: 'ignore', reason: 'listener_not_top_level' })

    // 4. Once bot HAS replied in a listener thread, active-thread followup activates while inheriting allowSilentEmptyReply & replyMode
    expect(
      decideLarkRouting(bot, quotedPlain, {
        groupConfig: dailyGroup,
        hasActiveSessionForRoute: () => true,
        getRouteTrigger: () => 'listener',
        hasRouteReplied: () => true,
      }),
    ).toMatchObject({
      action: 'agent',
      trigger: 'active-thread',
      replyMode: 'reply',
      allowSilentEmptyReply: true,
    })

    // Inside an explicit Lark topic (threadId set), active-thread stays in-topic ('new-topic') and keeps silent capability
    expect(
      decideLarkRouting(
        bot,
        createMessage({
          chatId: 'oc_alert',
          messageId: 'om_alert_followup',
          rootId: 'om_alert_root',
          threadId: 'omt_alert_1',
          text: '再查一下近 1 小时慢日志',
        }),
        {
          groupConfig: topLevelGroup,
          hasActiveSessionForRoute: () => true,
          getRouteTrigger: () => 'listener',
          hasRouteReplied: () => true,
        },
      ),
    ).toMatchObject({
      action: 'agent',
      trigger: 'active-thread',
      replyMode: 'new-topic',
      allowSilentEmptyReply: true,
    })

    // 5. Explicit allowSilentEmptyReply=false on listener is respected in active-thread
    const nonSilentGroup = LarkGroupConfigSchema.parse({
      ...dailyGroup,
      listener: { ...dailyGroup.listener, allowSilentEmptyReply: false },
    })
    expect(
      decideLarkRouting(bot, quotedPlain, {
        groupConfig: nonSilentGroup,
        hasActiveSessionForRoute: () => true,
        getRouteTrigger: () => 'listener',
        hasRouteReplied: () => true,
      }),
    ).toMatchObject({
      action: 'agent',
      trigger: 'active-thread',
      allowSilentEmptyReply: false,
    })

    // 6. Regular mention-originated active thread remains non-silent with new-topic replyMode
    expect(
      decideLarkRouting(bot, quotedPlain, {
        groupConfig: dailyGroup,
        hasActiveSessionForRoute: () => true,
        getRouteTrigger: () => 'mention',
        hasRouteReplied: () => true,
      }),
    ).toMatchObject({
      action: 'agent',
      trigger: 'active-thread',
      replyMode: 'new-topic',
      allowSilentEmptyReply: false,
    })
  })

  it('keeps replies inside existing Feishu topics (threadId set) and falls back to threadId route matching', () => {
    const bot = createBot({
      groupReplyMode: 'chat',
      groupSessionMode: 'thread',
      mentionTriggerMode: 'mention_and_active_thread',
    })
    const chatReplyGroup = LarkGroupConfigSchema.parse({
      key: 'dsh-bot:oc_in_topic',
      botId: 'dsh-bot',
      chatId: 'oc_in_topic',
      enabled: true,
      replyMode: 'chat',
      sessionMode: 'thread',
      listener: {
        enabled: true,
        name: '工作日常',
        prompt: '必要时回复',
        scope: 'all',
        replyMode: 'chat',
        sessionMode: 'thread',
      },
    })

    // 1. Top-level message (no threadId) still honors configured replyMode='chat'
    expect(
      decideLarkRouting(
        bot,
        createMessage({
          chatId: 'oc_in_topic',
          messageId: 'om_top_1',
          text: '@_bot_1 顶层提问',
          mentions: [{ key: '@_bot_1', openId: 'ou_bot', name: 'DSH-Bot' }],
        }),
        { groupConfig: chatReplyGroup, hasActiveSessionForRoute: () => false },
      ),
    ).toMatchObject({ action: 'agent', trigger: 'mention', replyMode: 'chat' })

    // 2. Inside an existing Feishu topic (threadId set), @bot, command, substitute, and listener all stay in-topic ('new-topic')
    const inTopicMention = decideLarkRouting(
      bot,
      createMessage({
        chatId: 'oc_in_topic',
        messageId: 'om_t_msg_1',
        rootId: 'om_t_root',
        threadId: 'omt_topic_1',
        text: '@_bot_1 话题内提问',
        mentions: [{ key: '@_bot_1', openId: 'ou_bot', name: 'DSH-Bot' }],
      }),
      { groupConfig: chatReplyGroup, hasActiveSessionForRoute: () => false },
    )
    expect(inTopicMention).toMatchObject({ action: 'agent', trigger: 'mention', replyMode: 'new-topic' })

    const inTopicCmd = decideLarkRouting(
      bot,
      createMessage({
        chatId: 'oc_in_topic',
        messageId: 'om_t_cmd',
        rootId: 'om_t_root',
        threadId: 'omt_topic_1',
        text: '@_bot_1 /status',
        mentions: [{ key: '@_bot_1', openId: 'ou_bot', name: 'DSH-Bot' }],
      }),
      { groupConfig: chatReplyGroup, hasActiveSessionForRoute: () => false },
    )
    expect(inTopicCmd).toMatchObject({ action: 'command', replyMode: 'new-topic' })

    const inTopicSub = decideLarkRouting(
      bot,
      createMessage({
        chatId: 'oc_in_topic',
        messageId: 'om_t_sub',
        rootId: 'om_t_root',
        threadId: 'omt_topic_1',
        text: '@_user_1 这个方案怎么看',
        mentions: [{ key: '@_user_1', openId: 'ou_owner', name: 'Alex Chen' }],
      }),
      { groupConfig: chatReplyGroup, hasActiveSessionForRoute: () => false },
    )
    expect(inTopicSub).toMatchObject({ action: 'agent', trigger: 'substitute', replyMode: 'new-topic' })

    const inTopicListener = decideLarkRouting(
      bot,
      createMessage({
        chatId: 'oc_in_topic',
        messageId: 'om_t_list',
        rootId: 'om_t_root',
        threadId: 'omt_topic_1',
        text: '有人看下构建日志吗',
      }),
      { groupConfig: chatReplyGroup, hasActiveSessionForRoute: () => false },
    )
    expect(inTopicListener).toMatchObject({ action: 'agent', trigger: 'listener', replyMode: 'new-topic' })

    // 3. When only threadId (omt_*) matches an active session, active-thread resolves via threadId fallback
    const threadIdKey = 'cli_dsh_app:oc_in_topic:omt_topic_1'
    const fallbackFollowup = decideLarkRouting(
      bot,
      createMessage({
        chatId: 'oc_in_topic',
        messageId: 'om_t_follow',
        rootId: 'om_new_root',
        threadId: 'omt_topic_1',
        text: '帮我继续查下',
      }),
      {
        groupConfig: chatReplyGroup,
        hasActiveSessionForRoute: (k) => k === threadIdKey,
        getRouteTrigger: (k) => (k === threadIdKey ? 'mention' : undefined),
        hasRouteReplied: () => true,
      },
    )
    expect(fallbackFollowup).toMatchObject({
      action: 'agent',
      trigger: 'active-thread',
      routeKey: threadIdKey,
      replyMode: 'new-topic',
    })
  })

  it('resolves guest read-only visibility across bot/group overrides and migrates adminUserProfiles', () => {
    const bot = createBot({
      adminUserProfiles: [{ openId: 'ou_admin_1', name: 'Alex Chen' }],
      dshSessionLinkInCard: true,
      sessionLinkGuestReadOnly: true,
    })
    expect(bot.adminUsers).toEqual(['ou_admin_1'])
    expect(resolveEffectiveGuestReadOnly(bot)).toBe(true)

    // Explicit empty adminUsers must not be overwritten by stale adminUserProfiles
    const clearedBot = createBot({
      adminUsers: [],
      adminUserProfiles: [{ openId: 'ou_admin_1', name: 'Alex Chen' }],
    })
    expect(clearedBot.adminUsers).toEqual([])

    const groupInherit = LarkGroupConfigSchema.parse({
      key: buildGroupKey('dsh-bot', 'oc_guest_1'),
      botId: 'dsh-bot',
      chatId: 'oc_guest_1',
    })
    expect(resolveEffectiveGuestReadOnly(bot, groupInherit)).toBe(true)

    const groupOff = LarkGroupConfigSchema.parse({
      key: buildGroupKey('dsh-bot', 'oc_guest_2'),
      botId: 'dsh-bot',
      chatId: 'oc_guest_2',
      sessionLinkGuestReadOnly: 'off',
    })
    expect(resolveEffectiveGuestReadOnly(bot, groupOff)).toBe(false)

    const groupLinkOff = LarkGroupConfigSchema.parse({
      key: buildGroupKey('dsh-bot', 'oc_guest_3'),
      botId: 'dsh-bot',
      chatId: 'oc_guest_3',
      dshSessionLinkInCard: 'off',
      sessionLinkGuestReadOnly: 'on',
    })
    expect(resolveEffectiveGuestReadOnly(bot, groupLinkOff)).toBe(false)

    const botGuestOff = createBot({ dshSessionLinkInCard: true, sessionLinkGuestReadOnly: false })
    expect(resolveEffectiveGuestReadOnly(botGuestOff)).toBe(false)
    const groupOn = LarkGroupConfigSchema.parse({
      key: buildGroupKey('dsh-bot', 'oc_guest_4'),
      botId: 'dsh-bot',
      chatId: 'oc_guest_4',
      sessionLinkGuestReadOnly: 'on',
    })
    expect(resolveEffectiveGuestReadOnly(botGuestOff, groupOn)).toBe(true)
  })

  it('strips invisible zero-width characters, honors silent sentinels, respects groupReplyMode on non-topic active-thread, and supports persistent deduplication', () => {
    // 1. Invisible characters & silent sentinels
    expect(hasVisibleText('')).toBe(false)
    expect(hasVisibleText('   \n\t  ')).toBe(false)
    expect(hasVisibleText('\u200b')).toBe(false)
    expect(hasVisibleText('\u200b\u200c\u200d\uFEFF\u2060\u3164\u2800')).toBe(false)
    expect(trimInvisibleText('\u200b  你好\u200b\uFEFF ')).toBe('你好')
    // Preserves interior ZWJ inside compound emoji
    expect(trimInvisibleText('\u200b👨‍👩‍👧‍👦\u200b')).toBe('👨‍👩‍👧‍👦')

    expect(isSilentReplySentinel('')).toBe(false)
    expect(isSilentReplySentinel('\u200b')).toBe(false)
    expect(isSilentReplySentinel(SILENT_REPLY_SENTINEL)).toBe(true)
    expect(isSilentReplySentinel(` \u200b\`${SILENT_REPLY_SENTINEL}\`\u200b `)).toBe(true)
    expect(isSilentReplySentinel(REMINDER_SILENT_SENTINEL)).toBe(true)
    expect(isSilentReplySentinel('请使用 `<no_reply/>` 表示静默')).toBe(false)

    expect(normalizeReplyText('\u200b', { allowSilentSentinel: true })).toBe('')
    expect(normalizeReplyText(SILENT_REPLY_SENTINEL, { allowSilentSentinel: true })).toBe('')
    expect(normalizeReplyText(` \u200b\`${SILENT_REPLY_SENTINEL}\`\u200b `, { allowSilentSentinel: true })).toBe('')
    expect(normalizeReplyText(REMINDER_SILENT_SENTINEL, { allowSilentSentinel: true })).toBe('')
    expect(normalizeReplyText('请使用 `<no_reply/>` 表示静默', { allowSilentSentinel: true })).toBe(
      '请使用 `<no_reply/>` 表示静默',
    )
    expect(normalizeReplyText(SILENT_REPLY_SENTINEL, { allowSilentSentinel: false })).toBe(SILENT_REPLY_SENTINEL)
    expect(extractReminderTriggerOutput('\u200b')).toBeUndefined()
    expect(extractReminderTriggerOutput('<no_reply/>')).toBeUndefined()
    expect(formatMarkdownForLarkPost('\u200b\n\u200c')).toBe('')
    expect(formatMarkdownForLarkCard('\u200b')).toBe('')

    const emptyCard = buildReplyCard({ markdown: '\u200b', bot: createBot() }) as {
      body: { elements: Array<{ content?: string }> }
    }
    expect(emptyCard.body.elements[0]?.content).toBe('(空回复)')

    // 2. Non-topic active-thread (quoted reply without threadId) honors groupReplyMode instead of forcing new-topic
    const replyBot = createBot({
      groupReplyMode: 'reply',
      groupSessionMode: 'thread',
      mentionTriggerMode: 'mention_and_active_thread',
    })
    const quotedGroup = LarkGroupConfigSchema.parse({
      key: 'dsh-bot:oc_quoted',
      botId: 'dsh-bot',
      chatId: 'oc_quoted',
      enabled: true,
      replyMode: 'reply',
      sessionMode: 'thread',
    })
    const quotedFollowup = decideLarkRouting(
      replyBot,
      createMessage({
        chatId: 'oc_quoted',
        messageId: 'om_q2',
        rootId: 'om_q1',
        parentId: 'om_q1',
        text: '能展开说下吗',
      }),
      {
        groupConfig: quotedGroup,
        hasActiveSessionForRoute: () => true,
        getRouteTrigger: () => 'mention',
        hasRouteReplied: () => true,
      },
    )
    expect(quotedFollowup).toMatchObject({
      action: 'agent',
      trigger: 'active-thread',
      replyMode: 'reply',
    })

    // 3. MessageDeduplicator hydrate / exportEntries persists seen IDs across restarts and prunes expired items
    const dedup1 = new MessageDeduplicator(60_000, 3)
    expect(dedup1.claim('cli:m1', 10_000)).toBe(true)
    expect(dedup1.claim('cli:m2', 20_000)).toBe(true)
    expect(dedup1.claim('cli:m3', 30_000)).toBe(true)
    expect(dedup1.claim('cli:m4', 40_000)).toBe(true) // evicts m1

    const exported = dedup1.exportEntries(50_000)
    expect(exported.map((e) => e.key)).toEqual(['cli:m2', 'cli:m3', 'cli:m4'])

    const dedup2 = new MessageDeduplicator(60_000, 3)
    dedup2.hydrate(exported, 85_000) // m2 (age 65s) expired, m3/m4 survive
    expect(dedup2.claim('cli:m2', 85_000)).toBe(true)
    expect(dedup2.claim('cli:m3', 85_000)).toBe(false)
    expect(dedup2.claim('cli:m4', 85_000)).toBe(false)
  })

  it('ignores peer bot replies and bare @other mentions in mention-originated active threads while preserving bot-enabled listener threads', () => {
    const bot = createBot({
      groupReplyMode: 'new-topic',
      groupSessionMode: 'thread',
      mentionTriggerMode: 'mention_and_active_thread',
    })
    const group = LarkGroupConfigSchema.parse({
      key: 'dsh-bot:oc_multi_bot',
      botId: 'dsh-bot',
      chatId: 'oc_multi_bot',
      enabled: true,
    })

    // 1. Bare @PeerBot poke without body text must not wake up this bot's active thread
    expect(
      decideLarkRouting(
        bot,
        createMessage({
          chatId: 'oc_multi_bot',
          messageId: 'om_poke_peer',
          rootId: 'om_root_1',
          threadId: 'omt_topic_1',
          senderOpenId: 'ou_member_1',
          senderType: 'user',
          text: '@_user_1',
          mentions: [{ key: '@_user_1', openId: 'ou_peer_bot', name: 'PeerBot' }],
        }),
        {
          groupConfig: group,
          hasActiveSessionForRoute: () => true,
          getRouteTrigger: () => 'mention',
          hasRouteReplied: () => true,
        },
      ),
    ).toEqual({ action: 'ignore', reason: 'no_matching_rule' })

    // 2. Peer bot reply card inside a mention-originated active thread must be ignored (no multi-bot ping-pong)
    expect(
      decideLarkRouting(
        bot,
        createMessage({
          chatId: 'oc_multi_bot',
          messageId: 'om_peer_bot_reply',
          rootId: 'om_root_1',
          threadId: 'omt_topic_1',
          senderOpenId: 'ou_peer_bot',
          senderType: 'bot',
          msgType: 'interactive',
          text: '请升级至最新版本客户端，以查看内容',
        }),
        {
          groupConfig: group,
          hasActiveSessionForRoute: () => true,
          getRouteTrigger: () => 'mention',
          hasRouteReplied: () => true,
        },
      ),
    ).toEqual({ action: 'ignore', reason: 'no_matching_rule' })

    // 3. Human follow-up referencing a colleague WITH substantive text still continues active-thread
    expect(
      decideLarkRouting(
        bot,
        createMessage({
          chatId: 'oc_multi_bot',
          messageId: 'om_human_with_ref',
          rootId: 'om_root_1',
          threadId: 'omt_topic_1',
          senderOpenId: 'ou_member_1',
          senderType: 'user',
          text: '按 @_user_1 说的超时改成 5s',
          mentions: [{ key: '@_user_1', openId: 'ou_colleague', name: 'Sam' }],
        }),
        {
          groupConfig: group,
          hasActiveSessionForRoute: () => true,
          getRouteTrigger: () => 'mention',
          hasRouteReplied: () => true,
        },
      ),
    ).toMatchObject({
      action: 'agent',
      trigger: 'active-thread',
      userText: '按 @Sam 说的超时改成 5s',
    })

    // 4. Bot-enabled alert listener thread still accepts follow-up updates from the alert bot
    const alertGroup = LarkGroupConfigSchema.parse({
      key: 'dsh-bot:oc_alert_thread',
      botId: 'dsh-bot',
      chatId: 'oc_alert_thread',
      enabled: true,
      listener: {
        enabled: true,
        name: '告警跟进',
        prompt: '跟进告警恢复状态',
        senderTypes: ['user', 'bot'],
      },
    })
    expect(
      decideLarkRouting(
        bot,
        createMessage({
          chatId: 'oc_alert_thread',
          messageId: 'om_alert_resolved',
          rootId: 'om_alert_root',
          threadId: 'omt_alert_1',
          senderOpenId: 'ou_alert_bot',
          senderType: 'bot',
          msgType: 'interactive',
          text: '[RESOLVED] 核心接口错误率已恢复正常',
        }),
        {
          groupConfig: alertGroup,
          hasActiveSessionForRoute: () => true,
          getRouteTrigger: () => 'listener',
          hasRouteReplied: () => true,
        },
      ),
    ).toMatchObject({
      action: 'agent',
      trigger: 'active-thread',
      allowSilentEmptyReply: true,
    })

    // 5. Peer bot reply & bare @PeerBot poke inside a mention-originated active thread must NOT fall through
    //    to a `scope: 'all'` passive listener (even when that listener allows bot senders)
    const botWithSub = createBot({
      groupSessionMode: 'thread',
      mentionTriggerMode: 'mention_and_active_thread',
      substituteMode: {
        enabled: true,
        targets: [{ openId: 'ou_owner', name: 'Alex Chen' }],
      },
    })
    const allScopeListenerGroup = LarkGroupConfigSchema.parse({
      key: 'dsh-bot:oc_all_listener',
      botId: 'dsh-bot',
      chatId: 'oc_all_listener',
      enabled: true,
      listener: {
        enabled: true,
        name: '全量旁听',
        prompt: '必要时介入',
        scope: 'all',
        senderTypes: ['user', 'bot'],
      },
    })
    expect(
      decideLarkRouting(
        botWithSub,
        createMessage({
          chatId: 'oc_all_listener',
          messageId: 'om_peer_bot_card_in_mention_thread',
          rootId: 'om_root_1',
          threadId: 'omt_topic_1',
          senderOpenId: 'ou_peer_bot',
          senderType: 'bot',
          msgType: 'interactive',
          text: '请升级至最新版本客户端，以查看内容',
        }),
        {
          groupConfig: allScopeListenerGroup,
          hasActiveSessionForRoute: () => true,
          getRouteTrigger: () => 'mention',
          hasRouteReplied: () => true,
        },
      ),
    ).toEqual({ action: 'ignore', reason: 'no_matching_rule' })

    expect(
      decideLarkRouting(
        botWithSub,
        createMessage({
          chatId: 'oc_all_listener',
          messageId: 'om_bare_peer_poke_in_listener_group',
          rootId: 'om_root_1',
          threadId: 'omt_topic_1',
          senderOpenId: 'ou_member_1',
          senderType: 'user',
          text: '@_user_1',
          mentions: [{ key: '@_user_1', openId: 'ou_peer_bot', name: 'PeerBot' }],
        }),
        {
          groupConfig: allScopeListenerGroup,
          hasActiveSessionForRoute: () => true,
          getRouteTrigger: () => 'mention',
          hasRouteReplied: () => true,
        },
      ),
    ).toEqual({ action: 'ignore', reason: 'no_matching_rule' })

    // 6. Bare @SubstituteTarget poke in an active thread still routes to substitute mode
    expect(
      decideLarkRouting(
        botWithSub,
        createMessage({
          chatId: 'oc_all_listener',
          messageId: 'om_bare_sub_poke',
          rootId: 'om_root_1',
          threadId: 'omt_topic_1',
          senderOpenId: 'ou_member_1',
          senderType: 'user',
          text: '@_user_1',
          mentions: [{ key: '@_user_1', openId: 'ou_owner', name: 'Alex Chen' }],
        }),
        {
          groupConfig: allScopeListenerGroup,
          hasActiveSessionForRoute: () => true,
          getRouteTrigger: () => 'mention',
          hasRouteReplied: () => true,
        },
      ),
    ).toMatchObject({
      action: 'agent',
      trigger: 'substitute',
    })

    // 7. Standalone Feishu sticker parses cleanly as `[表情包]` and is ignored zero-cost in unmentioned active threads
    const parsedSticker = parseLarkMessageContent('sticker', '{"file_key":"v2_demo_sticker"}')
    expect(parsedSticker).toEqual({ text: '[表情包]', imageKeys: [] })
    expect(parseLarkMessageContent('sticker', '')).toEqual({ text: '[表情包]', imageKeys: [] })

    expect(
      decideLarkRouting(
        botWithSub,
        createMessage({
          chatId: 'oc_all_listener',
          messageId: 'om_sticker_in_thread',
          rootId: 'om_root_1',
          threadId: 'omt_topic_1',
          senderOpenId: 'ou_member_1',
          senderType: 'user',
          msgType: 'sticker',
          text: parsedSticker.text,
          rawContent: '{"file_key":"v2_demo_sticker"}',
        }),
        {
          groupConfig: allScopeListenerGroup,
          hasActiveSessionForRoute: () => true,
          getRouteTrigger: () => 'mention',
          hasRouteReplied: () => true,
        },
      ),
    ).toEqual({ action: 'ignore', reason: 'no_matching_rule' })

    // P2P sticker from an allowed user still reaches agent with readable `[表情包]` instead of raw JSON
    expect(
      decideLarkRouting(
        botWithSub,
        createMessage({
          chatId: 'oc_p2p_1',
          chatType: 'p2p',
          messageId: 'om_sticker_p2p',
          senderOpenId: 'ou_owner',
          senderType: 'user',
          msgType: 'sticker',
          text: parsedSticker.text,
          rawContent: '{"file_key":"v2_demo_sticker"}',
        }),
        { hasActiveSessionForRoute: () => false },
      ),
    ).toMatchObject({
      action: 'agent',
      trigger: 'p2p',
      userText: '[表情包]',
    })
  })

  it('isolates main-stream quote forks under new-topic and refuses matching roots already bound to a native thread', () => {
    const bot = createBot({
      groupReplyMode: 'new-topic',
      groupSessionMode: 'thread',
      mentionTriggerMode: 'mention_and_active_thread',
    })
    const rootKey = 'cli_dsh_app:oc_team_dev:om_root_0'

    // 1. Two main-stream quote replies off an ephemeral quick-reply root spawn isolated routeKeys
    //    while carrying ephemeralHandoffRouteKey so both inherit the quick-reply context.
    const forkA = decideLarkRouting(
      bot,
      createMessage({
        messageId: 'om_fork_a',
        rootId: 'om_root_0',
        parentId: 'om_quick_1',
        text: '@_bot_1 分支 A',
        mentions: [{ key: '@_bot_1', openId: 'ou_bot', name: 'DSH-Bot' }],
      }),
      {
        hasActiveSessionForRoute: () => false,
        hasEphemeralRouterThread: (k) => k === rootKey,
      },
    )
    const forkB = decideLarkRouting(
      bot,
      createMessage({
        messageId: 'om_fork_b',
        rootId: 'om_root_0',
        parentId: 'om_quick_1',
        text: '@_bot_1 分支 B',
        mentions: [{ key: '@_bot_1', openId: 'ou_bot', name: 'DSH-Bot' }],
      }),
      {
        hasActiveSessionForRoute: () => false,
        hasEphemeralRouterThread: (k) => k === rootKey,
      },
    )
    expect(forkA).toMatchObject({
      action: 'agent',
      trigger: 'mention',
      routeKey: 'cli_dsh_app:oc_team_dev:om_fork_a',
      ephemeralHandoffRouteKey: rootKey,
    })
    expect(forkB).toMatchObject({
      action: 'agent',
      trigger: 'mention',
      routeKey: 'cli_dsh_app:oc_team_dev:om_fork_b',
      ephemeralHandoffRouteKey: rootKey,
    })

    // 2. When rootKey is already bound to a native thread (`isRouteBoundToNativeThread = true`),
    //    a main-stream quote (no threadId) never hijacks it (neither via @mention nor active-thread).
    const mentionOffPromoted = decideLarkRouting(
      bot,
      createMessage({
        messageId: 'om_fork_c',
        rootId: 'om_root_0',
        parentId: 'om_quick_1',
        text: '@_bot_1 分支 C',
        mentions: [{ key: '@_bot_1', openId: 'ou_bot', name: 'DSH-Bot' }],
      }),
      {
        hasActiveSessionForRoute: (k) => k === rootKey,
        isRouteBoundToNativeThread: (k) => k === rootKey,
      },
    )
    expect(mentionOffPromoted).toMatchObject({
      action: 'agent',
      trigger: 'mention',
      routeKey: 'cli_dsh_app:oc_team_dev:om_fork_c',
    })

    const unmentionedOffPromoted = decideLarkRouting(
      bot,
      createMessage({
        messageId: 'om_unmentioned_c',
        rootId: 'om_root_0',
        parentId: 'om_quick_1',
        text: '顺口说一句',
        mentions: [],
      }),
      {
        hasActiveSessionForRoute: (k) => k === rootKey,
        isRouteBoundToNativeThread: (k) => k === rootKey,
        getRouteTrigger: () => 'mention',
        hasRouteReplied: () => true,
      },
    )
    expect(unmentionedOffPromoted).toEqual({ action: 'ignore', reason: 'no_matching_rule' })

    // 3. Unpromoted main-stream worker binding (isRouteBoundToNativeThread = false) still matches
    //    rootKey so Scenario 8 quote-chain-to-topic promotion continues the existing session.
    const unpromotedUpgrade = decideLarkRouting(
      bot,
      createMessage({
        messageId: 'om_upgrade_1',
        rootId: 'om_root_0',
        parentId: 'om_reply_1',
        text: '@_bot_1 升级成话题',
        mentions: [{ key: '@_bot_1', openId: 'ou_bot', name: 'DSH-Bot' }],
      }),
      {
        hasActiveSessionForRoute: (k) => k === rootKey,
        isRouteBoundToNativeThread: () => false,
      },
    )
    expect(unpromotedUpgrade).toMatchObject({
      action: 'agent',
      trigger: 'mention',
      routeKey: rootKey,
    })
  })
})
