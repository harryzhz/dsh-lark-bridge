import { describe, expect, it } from 'vitest'
import {
  LarkBotConfigSchema,
  LarkGroupConfigSchema,
  buildGroupKey,
  decideLarkRouting,
  resolveEffectiveAgentRuntime,
  type InboundLarkMessage,
} from '../src/index.js'

function makeBot(overrides: Record<string, unknown> = {}) {
  return LarkBotConfigSchema.parse({
    id: 'bot-profile-test',
    name: 'ProfileBot',
    larkAppId: 'cli_profile_test',
    larkAppSecret: 'sec_demo',
    agentPreset: 'agy',
    runtimeProfileId: 'demo-proxy',
    model: 'gemini-4-carbon',
    reasoningEffort: 'medium',
    defaultWorkingDir: '~',
    allowedUsers: ['ou_owner'],
    substituteMode: {
      enabled: true,
      targets: [{ openId: 'ou_owner', name: 'Owner' }],
      disclosure: 'none',
      activeThreadFollowup: true,
    },
    ...overrides,
  })
}

function makeMsg(overrides: Partial<InboundLarkMessage> = {}): InboundLarkMessage {
  return {
    botId: 'bot-profile-test',
    larkAppId: 'cli_profile_test',
    botOpenId: 'ou_bot',
    messageId: 'om_1',
    chatId: 'oc_group_1',
    chatType: 'group',
    msgType: 'text',
    senderOpenId: 'ou_member',
    senderType: 'user',
    text: 'hello',
    rawContent: '{"text":"hello"}',
    mentions: [],
    imageKeys: [],
    createTimeMs: Date.now(),
    ...overrides,
  }
}

describe('runtimeProfileId inheritance and routing propagation', () => {
  it('inherits bot runtimeProfileId by default and overrides cleanly per group', () => {
    const bot = makeBot()
    expect(resolveEffectiveAgentRuntime(bot)).toEqual({
      agentPreset: 'agy',
      runtimeProfileId: 'demo-proxy',
      model: 'gemini-4-carbon',
      reasoningEffort: 'medium',
      source: 'bot',
    })

    const inheritGroup = LarkGroupConfigSchema.parse({
      key: buildGroupKey(bot.id, 'oc_inherit'),
      botId: bot.id,
      chatId: 'oc_inherit',
      runtimeMode: 'inherit',
    })
    expect(resolveEffectiveAgentRuntime(bot, inheritGroup)).toEqual({
      agentPreset: 'agy',
      runtimeProfileId: 'demo-proxy',
      model: 'gemini-4-carbon',
      reasoningEffort: 'medium',
      source: 'bot',
    })

    const overrideProfileGroup = LarkGroupConfigSchema.parse({
      key: buildGroupKey(bot.id, 'oc_override'),
      botId: bot.id,
      chatId: 'oc_override',
      runtimeMode: 'override',
      agentPreset: 'codex',
      runtimeProfileId: 'personal',
      model: 'gpt-6.1-sol',
    })
    expect(resolveEffectiveAgentRuntime(bot, overrideProfileGroup)).toEqual({
      agentPreset: 'codex',
      runtimeProfileId: 'personal',
      model: 'gpt-6.1-sol',
      source: 'group',
    })

    const legacyProfileGroup = LarkGroupConfigSchema.parse({
      key: buildGroupKey(bot.id, 'oc_legacy'),
      botId: bot.id,
      chatId: 'oc_legacy',
      runtimeProfileId: 'work',
    })
    expect(legacyProfileGroup.runtimeMode).toBe('override')
    expect(resolveEffectiveAgentRuntime(bot, legacyProfileGroup)).toEqual({
      agentPreset: 'agy',
      runtimeProfileId: 'work',
      source: 'group',
    })
  })

  it('propagates runtimeProfileId across all agent routing triggers', () => {
    const bot = makeBot()
    const baseRuntime = {
      hasActiveSessionForRoute: () => false,
    }

    // 1. P2P
    const p2p = decideLarkRouting(
      bot,
      makeMsg({ chatType: 'p2p', senderOpenId: 'ou_owner', text: 'hi' }),
      baseRuntime,
    )
    expect(p2p.action).toBe('agent')
    if (p2p.action === 'agent') expect(p2p.runtimeProfileId).toBe('demo-proxy')

    // 2. Group @mention
    const mention = decideLarkRouting(
      bot,
      makeMsg({
        text: '@_user_1 check',
        mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'ProfileBot' }],
      }),
      baseRuntime,
    )
    expect(mention.action).toBe('agent')
    if (mention.action === 'agent') expect(mention.runtimeProfileId).toBe('demo-proxy')

    // 3. Active thread follow-up
    const thread = decideLarkRouting(
      bot,
      makeMsg({ rootId: 'om_root', threadId: 'omt_1', text: 'follow up' }),
      { hasActiveSessionForRoute: () => true },
    )
    expect(thread.action).toBe('agent')
    if (thread.action === 'agent') expect(thread.runtimeProfileId).toBe('demo-proxy')

    // 4. Substitute trigger
    const substitute = decideLarkRouting(
      bot,
      makeMsg({
        text: '@_user_1 help',
        mentions: [{ key: '@_user_1', openId: 'ou_owner', name: 'Owner' }],
      }),
      baseRuntime,
    )
    expect(substitute.action).toBe('agent')
    if (substitute.action === 'agent') {
      expect(substitute.trigger).toBe('substitute')
      expect(substitute.runtimeProfileId).toBe('demo-proxy')
    }

    // 5. Passive listener trigger with group override
    const listenerGroup = LarkGroupConfigSchema.parse({
      key: buildGroupKey(bot.id, 'oc_group_1'),
      botId: bot.id,
      chatId: 'oc_group_1',
      enabled: true,
      runtimeMode: 'override',
      agentPreset: 'codex',
      runtimeProfileId: 'personal',
      listener: {
        enabled: true,
        prompt: 'check alert',
      },
    })
    const listener = decideLarkRouting(bot, makeMsg({ text: 'alert' }), {
      groupConfig: listenerGroup,
      hasActiveSessionForRoute: () => false,
    })
    expect(listener.action).toBe('agent')
    if (listener.action === 'agent') {
      expect(listener.trigger).toBe('listener')
      expect(listener.agentPreset).toBe('codex')
      expect(listener.runtimeProfileId).toBe('personal')
    }
  })
})
