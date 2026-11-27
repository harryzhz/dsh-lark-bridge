import { describe, expect, it } from 'vitest'
import {
  COT_MAX_TEXT_CHARS,
  COT_TEXT_CHUNK_CHARS,
  LarkBotConfigSchema,
  LarkGroupConfigSchema,
  buildCotFinishEvents,
  buildCotPrologueEvents,
  buildCotReasoningMessageEvents,
  buildCotToolCallEvents,
  buildCotToolResultEvents,
  buildGroupKey,
  decideLarkRouting,
  extractCotToolSubject,
  formatCotToolTitle,
  isCotAlreadyTerminalResponse,
  parseSlashCommand,
  resolveCotPlacement,
  resolveCotResultLanguage,
  resolveCotToolMeta,
  resolveEffectiveCotConfig,
  splitCotTextChunks,
  type InboundLarkMessage,
} from '../src/index.js'

function createBot(overrides: Record<string, unknown> = {}) {
  return LarkBotConfigSchema.parse({
    id: 'cot-bot',
    name: 'CoT-Bot',
    larkAppId: 'cli_cot_demo',
    larkAppSecret: 'sec_demo',
    agentPreset: 'codex',
    defaultWorkingDir: '~',
    groupAccessMode: 'all_joined',
    ...overrides,
  })
}

function createMessage(partial: Partial<InboundLarkMessage> = {}): InboundLarkMessage {
  return {
    botId: 'cot-bot',
    larkAppId: 'cli_cot_demo',
    botOpenId: 'ou_bot_demo',
    messageId: 'om_msg_1',
    chatId: 'oc_chat_1',
    chatType: 'group',
    msgType: 'text',
    senderOpenId: 'ou_user_1',
    senderType: 'user',
    text: '@_user_1 排查构建失败原因',
    rawContent: '{"text":"@_user_1 排查构建失败原因"}',
    mentions: [{ key: '@_user_1', openId: 'ou_bot_demo', name: 'CoT-Bot' }],
    imageKeys: [],
    createTimeMs: Date.now(),
    ...partial,
  }
}

describe('Feishu native CoT protocol helpers', () => {
  it('extracts concise subjects from valid JSON, truncated JSON, argv arrays, and apply_patch', () => {
    expect(extractCotToolSubject(JSON.stringify({ command: 'pnpm test --run' })).display).toBe(
      'pnpm test --run',
    )
    expect(
      extractCotToolSubject(JSON.stringify({ cmd: ['bash', '-lc', 'pnpm test --run'] })).display,
    ).toBe('pnpm test --run')
    expect(
      extractCotToolSubject(JSON.stringify({ cmd: ['git', 'status', '-sb'] })).display,
    ).toBe('git status -sb')
    expect(
      extractCotToolSubject(JSON.stringify({ path: 'packages/lark-core/src/cot.ts' })).display,
    ).toBe('packages/lark-core/src/cot.ts')
    expect(
      extractCotToolSubject('{"pattern":"resolveCotPlacement","path":"packages/').display,
    ).toBe('resolveCotPlacement')
    expect(
      extractCotToolSubject(
        '*** Begin Patch\n*** Update File: packages/lark-core/src/router.ts\n@@\n+ok',
      ).display,
    ).toBe('packages/lark-core/src/router.ts')
  })

  it('maps tool names to Feishu icons, readable labels, and whitelisted result languages', () => {
    expect(resolveCotToolMeta('bash')).toEqual({ icon: 'bash', label: '执行命令' })
    expect(resolveCotToolMeta('read_file')).toEqual({ icon: 'read', label: '读取文件' })
    expect(resolveCotToolMeta('apply_patch')).toEqual({ icon: 'write', label: '编辑文件' })
    expect(resolveCotToolMeta('grep_search')).toEqual({ icon: 'search', label: '检索信息' })
    expect(resolveCotToolMeta('subagent_task')).toEqual({ icon: 'task', label: '执行任务' })
    expect(resolveCotToolMeta('mcp__github__list_prs')).toEqual({
      icon: 'default',
      label: 'mcp__github__list_prs',
    })

    expect(formatCotToolTitle('bash', 'pnpm build')).toBe('执行命令 · pnpm build')
    expect(resolveCotResultLanguage('bash', undefined)).toBe('bash')
    expect(resolveCotResultLanguage('read_file', 'src/index.ts')).toBe('typescript')
    expect(resolveCotResultLanguage('read_file', 'config/settings.yaml')).toBe('yaml')
    expect(resolveCotResultLanguage('read_file', 'data/raw.unknownext')).toBeUndefined()
  })

  it('chunks long reasoning text and builds AG-UI prologue, tool, result, and finish events', () => {
    const oversized = 'A'.repeat(COT_MAX_TEXT_CHARS + 500)
    const chunks = splitCotTextChunks(oversized)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]!.length).toBe(COT_TEXT_CHUNK_CHARS)
    expect(chunks.join('').length).toBe(COT_MAX_TEXT_CHARS)

    const prologue = buildCotPrologueEvents('thread-1', 'run-1', 'r-1', 1000)
    expect(prologue.map((e) => e.event_type)).toEqual(['RUN_STARTED', 'REASONING_START'])

    const reasoning = buildCotReasoningMessageEvents('r-1', '先检查目录', 1001)
    expect(reasoning.map((e) => e.event_type)).toEqual([
      'REASONING_MESSAGE_START',
      'REASONING_MESSAGE_CONTENT',
      'REASONING_MESSAGE_END',
    ])

    const toolCall = buildCotToolCallEvents({
      toolCallId: 'call-1',
      toolName: 'bash',
      args: JSON.stringify({ command: 'pnpm test' }),
      parentMessageId: 'r-1',
      timestamp: 1002,
    })
    expect(toolCall.resultLanguage).toBe('bash')
    expect(toolCall.events.map((e) => e.event_type)).toEqual([
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
    ])
    const startPayload = JSON.parse(toolCall.events[0]!.content) as Record<string, unknown>
    expect(startPayload.title).toBe('执行命令 · pnpm test')
    expect(startPayload.parentMessageId).toBe('r-1')

    // When includeResult=false, emit minimal completion marker instead of leaking output payload
    const suppressedResult = buildCotToolResultEvents({
      toolCallId: 'call-1',
      result: 'sensitive output',
      includeResult: false,
      isError: false,
    })
    expect(suppressedResult).toHaveLength(1)
    const suppressedOuter = JSON.parse(suppressedResult[0]!.content) as { content: string }
    expect(JSON.parse(suppressedOuter.content)).toEqual({ type: 'text', text: '已完成' })

    const codeResult = buildCotToolResultEvents({
      toolCallId: 'call-1',
      result: 'ok 42 tests',
      includeResult: true,
      isError: false,
      language: 'bash',
    })
    expect(codeResult).toHaveLength(1)
    expect(codeResult[0]!.event_type).toBe('TOOL_CALL_RESULT')
    const resultOuter = JSON.parse(codeResult[0]!.content) as { content: string }
    expect(JSON.parse(resultOuter.content)).toEqual({
      type: 'code',
      language: 'bash',
      code: 'ok 42 tests',
    })

    const finishDone = buildCotFinishEvents({
      threadId: 'thread-1',
      runId: 'run-1',
      lastReasoningId: 'r-1',
      status: 'done',
      timestamp: 1005,
    })
    expect(finishDone.map((e) => e.event_type)).toEqual(['REASONING_END', 'RUN_FINISHED'])

    // Interrupted finish appends notice + REASONING_END (explicit complete endpoint closes as error)
    const finishInterrupted = buildCotFinishEvents({
      threadId: 'thread-1',
      runId: 'run-1',
      lastReasoningId: 'r-1',
      status: 'interrupted',
      interruptedNotice: '执行超时',
      timestamp: 1006,
    })
    expect(finishInterrupted.map((e) => e.event_type)).toEqual([
      'REASONING_MESSAGE_START',
      'REASONING_MESSAGE_CONTENT',
      'REASONING_MESSAGE_END',
      'REASONING_END',
    ])
  })

  it('resolves CoT bubble placement across P2P, group reply, new-topic, and existing threads', () => {
    expect(
      resolveCotPlacement({ chatType: 'p2p', replyMode: 'reply', messageId: 'om_p2p_1' }),
    ).toEqual({})

    expect(
      resolveCotPlacement({ chatType: 'group', replyMode: 'reply', messageId: 'om_grp_1' }),
    ).toEqual({ originMessageId: 'om_grp_1' })

    expect(
      resolveCotPlacement({ chatType: 'group', replyMode: 'new-topic', messageId: 'om_grp_1' }),
    ).toEqual({ originMessageId: 'om_grp_1', replyInThread: true })

    expect(
      resolveCotPlacement({
        chatType: 'group',
        replyMode: 'reply',
        messageId: 'om_reply_2',
        rootId: 'om_root_1',
        threadId: 'omt_topic_1',
      }),
    ).toEqual({ originMessageId: 'om_root_1', replyInThread: true })

    // Guard against non-om_ IDs (Feishu API rejects non-om_ origin_message_id)
    expect(
      resolveCotPlacement({ chatType: 'group', replyMode: 'new-topic', messageId: 'synthetic_1' }),
    ).toEqual({})
  })

  it('detects Feishu already-terminal CoT responses', () => {
    expect(isCotAlreadyTerminalResponse({ code: 230099, msg: 'COT already in terminal state' })).toBe(
      true,
    )
    expect(isCotAlreadyTerminalResponse({ code: 230001, msg: 'COT already in terminal state.' })).toBe(
      true,
    )
    expect(isCotAlreadyTerminalResponse({ code: 99991663, msg: 'invalid token' })).toBe(false)
  })
})

describe('CoT toggle resolution, routing propagation, and /cot slash command parsing', () => {
  it('resolves bot defaults and group overrides cleanly', () => {
    const defaultBot = createBot()
    expect(defaultBot.cotEnabled).toBe(false)
    expect(defaultBot.cotToolResultEnabled).toBe(true)
    expect(resolveEffectiveCotConfig(defaultBot)).toEqual({
      enabled: false,
      toolResultEnabled: true,
      source: 'bot',
    })

    const enabledBot = createBot({ cotEnabled: true, cotToolResultEnabled: false })
    expect(resolveEffectiveCotConfig(enabledBot)).toEqual({
      enabled: true,
      toolResultEnabled: false,
      source: 'bot',
    })

    const groupOverrideOff = LarkGroupConfigSchema.parse({
      key: buildGroupKey('cot-bot', 'oc_chat_1'),
      botId: 'cot-bot',
      chatId: 'oc_chat_1',
      cotEnabled: 'off',
      cotToolResultEnabled: 'on',
    })
    expect(resolveEffectiveCotConfig(enabledBot, groupOverrideOff)).toEqual({
      enabled: false,
      toolResultEnabled: true,
      source: 'group',
    })

    const groupOverrideOn = LarkGroupConfigSchema.parse({
      key: buildGroupKey('cot-bot', 'oc_chat_2'),
      botId: 'cot-bot',
      chatId: 'oc_chat_2',
      cotEnabled: 'on',
      cotToolResultEnabled: 'inherit',
    })
    expect(resolveEffectiveCotConfig(defaultBot, groupOverrideOn)).toEqual({
      enabled: true,
      toolResultEnabled: true,
      source: 'group',
    })
  })

  it('propagates CoT flags to interactive decisions and suppresses CoT on silent listener turns', () => {
    const bot = createBot({ cotEnabled: true, cotToolResultEnabled: true })
    const group = LarkGroupConfigSchema.parse({
      key: buildGroupKey('cot-bot', 'oc_chat_1'),
      botId: 'cot-bot',
      chatId: 'oc_chat_1',
      enabled: true,
      cotEnabled: 'inherit',
      cotToolResultEnabled: 'off',
      listener: {
        enabled: true,
        name: '巡检监听',
        prompt: '监控告警',
        allowSilentEmptyReply: true,
      },
    })

    const runtime = {
      groupConfig: group,
      hasActiveSessionForRoute: () => false,
    }

    // Mention turn inherits bot cotEnabled=true and group cotToolResultEnabled=off,
    // and suppresses longTurnProgressNotice whenever CoT is active.
    const mentionDecision = decideLarkRouting(bot, createMessage(), runtime)
    expect(mentionDecision.action).toBe('agent')
    if (mentionDecision.action === 'agent') {
      expect(mentionDecision.cotEnabled).toBe(true)
      expect(mentionDecision.cotToolResultEnabled).toBe(false)
      expect(mentionDecision.longTurnProgressNotice).toBe(false)
    }

    // Group-level CoT override=on disables longTurnProgressNotice even if bot default CoT is off
    const botCotOff = createBot({ cotEnabled: false, longTurnProgressNotice: true })
    const groupCotOn = LarkGroupConfigSchema.parse({
      key: buildGroupKey('cot-bot', 'oc_chat_on'),
      botId: 'cot-bot',
      chatId: 'oc_chat_on',
      enabled: true,
      cotEnabled: 'on',
    })
    const overrideOnDecision = decideLarkRouting(
      botCotOff,
      createMessage({ chatId: 'oc_chat_on' }),
      { groupConfig: groupCotOn, hasActiveSessionForRoute: () => false },
    )
    expect(overrideOnDecision.action).toBe('agent')
    if (overrideOnDecision.action === 'agent') {
      expect(overrideOnDecision.cotEnabled).toBe(true)
      expect(overrideOnDecision.longTurnProgressNotice).toBe(false)
    }

    // Passive listener with allowSilentEmptyReply suppresses CoT so silent turns never leak a bubble
    const listenerDecision = decideLarkRouting(
      bot,
      createMessage({ text: '系统告警：延迟飙升', mentions: [] }),
      runtime,
    )
    expect(listenerDecision.action).toBe('agent')
    if (listenerDecision.action === 'agent') {
      expect(listenerDecision.allowSilentEmptyReply).toBe(true)
      expect(listenerDecision.cotEnabled).toBe(false)
    }
  })

  it('parses /cot slash commands across P2P and group mentions', () => {
    expect(parseSlashCommand('/cot on')).toEqual({ name: 'cot', args: 'on' })
    expect(parseSlashCommand('/cot status')).toEqual({ name: 'cot', args: 'status' })
    expect(parseSlashCommand('/cot inherit')).toEqual({ name: 'cot', args: 'inherit' })
    expect(parseSlashCommand('/cot')).toEqual({ name: 'cot', args: '' })
  })
})
