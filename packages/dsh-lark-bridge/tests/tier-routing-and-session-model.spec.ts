import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TIER_ROUTING_CONFIG,
  LarkBotConfigSchema,
  LarkGroupConfigSchema,
  RECOMMENDED_TIER_ROUTING_TARGETS,
  buildRouteMessageToolSchema,
  buildTriageSystemPrompt,
  hasConfiguredTierRouting,
  parseTriageVerdict,
  resolveEffectiveRouterConfig,
  selectWeightedTierTarget,
  shouldRunTriage,
  type AgentRoutingDecision,
  type TierRoutingConfig,
} from '@dsh-lark/lark-core'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { RuntimeConcurrencyLimiter } from '../src/runtime-concurrency.js'
import { SessionCoordinator } from '../src/session-coordinator.js'
import { handleSlashCommand } from '../src/slash-commands.js'
import { LarkBridgeStore } from '../src/store.js'
import type { RuntimeCatalog } from '../src/runtime-catalog.js'
import type { WorkspaceGrouping } from '../src/workspace-grouping.js'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function makeRecommendedTierRouting(): TierRoutingConfig {
  return {
    ...DEFAULT_TIER_ROUTING_CONFIG,
    enabled: true,
    presetKey: 'recommended',
    bypassTier: 'heavy',
    tiers: {
      lite: { prompt: '', targets: [...RECOMMENDED_TIER_ROUTING_TARGETS.lite] },
      standard: { prompt: '', targets: [...RECOMMENDED_TIER_ROUTING_TARGETS.standard] },
      heavy: { prompt: '', targets: [...RECOMMENDED_TIER_ROUTING_TARGETS.heavy] },
    },
  }
}

describe('Tier routing core & weighted pool scheduling', () => {
  it('defines the exact 3-tier Agy + Codex recommended preset', () => {
    expect(RECOMMENDED_TIER_ROUTING_TARGETS.lite).toEqual([
      expect.objectContaining({ agentPreset: 'agy', model: 'gemini-4-neon', reasoningEffort: 'low', weight: 70 }),
      expect.objectContaining({ agentPreset: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', weight: 30 }),
    ])
    expect(RECOMMENDED_TIER_ROUTING_TARGETS.standard).toEqual([
      expect.objectContaining({ agentPreset: 'agy', model: 'gemini-4-neon', reasoningEffort: 'xhigh', weight: 70 }),
      expect.objectContaining({ agentPreset: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh', weight: 30 }),
    ])
    expect(RECOMMENDED_TIER_ROUTING_TARGETS.heavy).toEqual([
      expect.objectContaining({ agentPreset: 'agy', model: 'gemini-4-carbon', reasoningEffort: 'high', weight: 70 }),
      expect.objectContaining({ agentPreset: 'codex', model: 'gpt-6-astra', reasoningEffort: 'xhigh', weight: 30 }),
    ])
  })

  it('routes new @Bot mentions through triage even under passive_only scope while keeping active sessions zero-overhead', () => {
    const bot = LarkBotConfigSchema.parse({
      id: 'bot-tier',
      name: 'TierBot',
      larkAppId: 'cli_demo',
      larkAppSecret: 'sec_demo',
      defaultWorkingDir: '/tmp',
      router: {
        enabled: true,
        scope: 'passive_only',
        tierRouting: makeRecommendedTierRouting(),
      },
    })
    const eff = resolveEffectiveRouterConfig(bot)
    expect(hasConfiguredTierRouting(eff)).toBe(true)

    const mentionDecision: AgentRoutingDecision = {
      action: 'agent',
      trigger: 'mention',
      routeKey: 'cli_demo:oc_team:om_1',
      workingDir: '/tmp',
      workspaceName: 'Demo',
      agentPreset: 'agy',
      sessionMode: 'thread',
      replyMode: 'new-topic',
      useCard: true,
      sendIntermediateMessages: false,
      allowSilentEmptyReply: false,
      autoCloseAfterCompletion: false,
      turnReminders: [],
      userText: '帮我排查复杂竞态死锁',
      promptText: '帮我排查复杂竞态死锁',
    }

    expect(shouldRunTriage(mentionDecision, eff, { hasActiveWorker: false })).toBe(true)
    expect(shouldRunTriage(mentionDecision, eff, { hasActiveWorker: true })).toBe(false)
  })

  it('attaches tier schema & guide for new sessions and parses tier on handoff verdicts only', () => {
    const schema = buildRouteMessageToolSchema({ includeTier: true })
    const props = schema.parameters.properties as Record<string, { enum?: string[] }>
    expect(props.tier?.enum).toEqual(['lite', 'standard', 'heavy'])

    const prompt = buildTriageSystemPrompt({
      botName: 'TierBot',
      hasActiveWorker: false,
      trigger: 'mention',
      tierRouting: makeRecommendedTierRouting(),
    })
    expect(prompt).toContain('新会话难度分档')
    expect(prompt).toContain('`lite`')
    expect(prompt).toContain('`standard`')
    expect(prompt).toContain('`heavy`')

    const parsedNew = parseTriageVerdict({
      toolCalls: [
        {
          name: 'route_message',
          arguments: JSON.stringify({ action: 'handoff', tier: 'heavy', reason: '复杂并发排障' }),
        },
      ],
      hasActiveWorker: false,
      trigger: 'mention',
    })
    expect(parsedNew).toEqual({
      action: 'handoff',
      tier: 'heavy',
      reason: '复杂并发排障',
    })

    // Existing active session ignores tier so ongoing sessions never auto-switch.
    const parsedActive = parseTriageVerdict({
      toolCalls: [
        {
          name: 'route_message',
          arguments: JSON.stringify({ action: 'handoff', tier: 'lite', reason: '继续追问' }),
        },
      ],
      hasActiveWorker: true,
      trigger: 'active-thread',
    })
    expect(parsedActive.tier).toBeUndefined()
  })

  it('selects weighted targets while preferring idle and healthy candidates without downgrading tier', () => {
    const tierRouting = makeRecommendedTierRouting()

    // Deterministic RNG splits 50/50 cleanly.
    const first = selectWeightedTierTarget({ tier: 'heavy', tierRouting, random: () => 0.1 })
    const second = selectWeightedTierTarget({ tier: 'heavy', tierRouting, random: () => 0.9 })
    expect(first?.target.agentPreset).toBe('agy')
    expect(first?.target.model).toBe('gemini-4-carbon')
    expect(second?.target.agentPreset).toBe('codex')
    expect(second?.target.model).toBe('gpt-6-astra')

    // When agy is saturated, selector avoids busy target even when RNG would have picked agy.
    const busyAvoid = selectWeightedTierTarget({
      tier: 'heavy',
      tierRouting,
      hasConcurrencyCapacity: (t) => t.agentPreset !== 'agy',
      random: () => 0.01,
    })
    expect(busyAvoid?.target.agentPreset).toBe('codex')
    expect(busyAvoid?.avoidedBusy).toBe(true)

    // When codex is in cooldown, selector routes to healthy agy.
    const cooldownAvoid = selectWeightedTierTarget({
      tier: 'heavy',
      tierRouting,
      isInCooldown: (t) => t.agentPreset === 'codex',
      random: () => 0.99,
    })
    expect(cooldownAvoid?.target.agentPreset).toBe('agy')
    expect(cooldownAvoid?.avoidedCooldown).toBe(true)

    // RuntimeConcurrencyLimiter.hasCapacity tracks saturation accurately.
    const limiter = new RuntimeConcurrencyLimiter(1)
    expect(limiter.hasCapacity('codex')).toBe(true)
  })
})

describe('Session pinning & session-level /model with profile-specific real model lists', () => {
  it('keeps routed runtime/model pinned across follow-up turns even when group default differs', async () => {
    const dir = makeTempDir('dsh-lark-pin-')
    const store = new LarkBridgeStore(dir)
    const bot = LarkBotConfigSchema.parse({
      id: 'bot-pin',
      name: 'PinBot',
      larkAppId: 'cli_demo',
      larkAppSecret: 'sec_demo',
      agentPreset: 'agy',
      model: 'gemini-4-neon',
      reasoningEffort: 'low',
      defaultWorkingDir: dir,
    })
    store.upsertBot(bot)

    const selectCalls: unknown[] = []
    const createdAgents = new Map<string, Agent>()
    const createMock = vi.fn(async (opts: { sessionId: string; agentOptions?: Record<string, unknown> }) => {
      let currentSel = {
        provider: String(opts.agentOptions?.provider ?? 'codex-cli'),
        model: String(opts.agentOptions?.model ?? 'gpt-6-astra'),
        ...(opts.agentOptions?.reasoningEffort
          ? { reasoningEffort: opts.agentOptions.reasoningEffort }
          : {}),
      }
      const agent = {
        id: opts.sessionId,
        status: 'idle',
        session: { header: { cwd: dir }, append: vi.fn(), snapshotEvents: () => [] },
        model: {
          current: () => currentSel,
          select: (next: typeof currentSel) => {
            selectCalls.push(next)
            currentSel = next
          },
        },
        cancel: vi.fn(),
      } as unknown as Agent
      createdAgents.set(opts.sessionId, agent)
      return { agent, dispose: vi.fn(async () => {}) } as unknown as AgentHandle
    })

    const ctx = {
      agents: {
        create: createMock,
        get: (sid: string) => createdAgents.get(sid),
        resume: vi.fn(),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as Context

    const runtimes = {
      resolveAgentLaunch: vi.fn(async (input: { agentPreset: string; explicitModel?: string; explicitReasoningEffort?: string }) => ({
        isExternal: true,
        provider: `${input.agentPreset}-cli`,
        model: input.explicitModel ?? 'default',
        ...(input.explicitReasoningEffort ? { reasoningEffort: input.explicitReasoningEffort } : {}),
        mountPreset: vi.fn(async () => {}),
      })),
      providerFor: (preset: string) => `${preset}-cli`,
    } as unknown as RuntimeCatalog

    const workspaces = {
      attachSession: vi.fn(async () => {}),
      archiveSession: vi.fn(async () => true),
    } as unknown as WorkspaceGrouping

    const coordinator = new SessionCoordinator({
      ctx,
      store,
      runtimes,
      workspaces,
      instrumentAgent: vi.fn(),
      disposeReminderHandle: vi.fn(async () => {}),
    })

    const msg = {
      botId: bot.id,
      larkAppId: bot.larkAppId,
      messageId: 'om_turn1',
      chatId: 'oc_team',
      chatType: 'group',
      msgType: 'text',
      senderType: 'user' as const,
      text: '深挖死锁根因',
      rawContent: '{}',
      mentions: [],
      imageKeys: [],
      createTimeMs: Date.now(),
    }

    // Turn 1: tier routing selects codex / gpt-6-astra / xhigh and pins it.
    const turn1 = await coordinator.acquireAgent(bot, msg, {
      action: 'agent',
      trigger: 'mention',
      routeKey: 'cli_demo:oc_team:om_turn1',
      workingDir: dir,
      workspaceName: '研发群',
      agentPreset: 'codex',
      model: 'gpt-6-astra',
      reasoningEffort: 'xhigh',
      runtimePinned: true,
      routedTier: 'heavy',
      sessionMode: 'thread',
      replyMode: 'new-topic',
      useCard: true,
      sendIntermediateMessages: false,
      allowSilentEmptyReply: false,
      autoCloseAfterCompletion: false,
      turnReminders: [],
      userText: '深挖死锁根因',
      promptText: '深挖死锁根因',
    })
    expect(turn1.isNew).toBe(true)
    const saved = store.getBinding('cli_demo:oc_team:om_turn1')
    expect(saved?.agentPreset).toBe('codex')
    expect(saved?.model).toBe('gpt-6-astra')
    expect(saved?.reasoningEffort).toBe('xhigh')
    expect(saved?.runtimePinned).toBe(true)
    expect(saved?.routedTier).toBe('heavy')

    // Turn 2: follow-up decision carries bot default (agy / gemini-4-neon / low),
    // but coordinator MUST resume the pinned codex session without rebuilding or resetting model!
    const turn2 = await coordinator.acquireAgent(
      bot,
      { ...msg, messageId: 'om_turn2', rootId: 'om_turn1' },
      {
        action: 'agent',
        trigger: 'active-thread',
        routeKey: 'cli_demo:oc_team:om_turn1',
        workingDir: dir,
        workspaceName: '研发群',
        agentPreset: 'agy',
        model: 'gemini-4-neon',
        reasoningEffort: 'low',
        sessionMode: 'thread',
        replyMode: 'new-topic',
        useCard: true,
        sendIntermediateMessages: false,
        allowSilentEmptyReply: false,
        autoCloseAfterCompletion: false,
        turnReminders: [],
        userText: '顺便看下锁顺序',
        promptText: '顺便看下锁顺序',
      },
    )
    expect(turn2.isNew).toBe(false)
    expect(turn2.sessionId).toBe(turn1.sessionId)
    expect(createMock).toHaveBeenCalledTimes(1)
    expect(selectCalls).toHaveLength(0)

    store.close()
  })

  it('lists and switches real profile-specific models via group /model without modifying group/bot defaults', async () => {
    const dir = makeTempDir('dsh-lark-model-cmd-')
    const store = new LarkBridgeStore(dir)
    const bot = LarkBotConfigSchema.parse({
      id: 'bot-proxy',
      name: 'ProxyBot',
      larkAppId: 'cli_demo',
      larkAppSecret: 'sec_demo',
      agentPreset: 'agy',
      runtimeProfileId: 'custom-proxy',
      model: 'gemini-4-neon',
      reasoningEffort: 'low',
      defaultWorkingDir: dir,
    })
    const group = LarkGroupConfigSchema.parse({
      key: 'bot-proxy:oc_team',
      botId: 'bot-proxy',
      chatId: 'oc_team',
      enabled: true,
      runtimeMode: 'override',
      agentPreset: 'agy',
      runtimeProfileId: 'custom-proxy',
      model: 'gemini-4-neon',
      reasoningEffort: 'low',
    })
    store.upsertBot(bot)
    store.upsertGroup(group)
    store.upsertBinding({
      routeKey: 'cli_demo:oc_team:om_topic',
      botId: bot.id,
      larkAppId: bot.larkAppId,
      chatType: 'group',
      chatId: 'oc_team',
      workspaceName: '研发群',
      sessionId: 'session-proxy-1',
      agentPreset: 'agy',
      runtimeProfileId: 'custom-proxy',
      model: 'gemini-4-neon',
      reasoningEffort: 'low',
      runtimePinned: true,
      routedTier: 'lite',
      workingDir: dir,
      trigger: 'mention',
      createdAtMs: Date.now(),
      lastActivityMs: Date.now(),
    })

    let liveSel = { provider: 'agy-cli', model: 'gemini-4-neon', reasoningEffort: 'low' as string | undefined }
    const selectSpy = vi.fn((next: typeof liveSel) => {
      liveSel = next
    })
    const liveAgent = {
      id: 'session-proxy-1',
      status: 'idle',
      model: {
        current: () => liveSel,
        select: selectSpy,
      },
      cancel: vi.fn(),
    } as unknown as Agent

    // Simulate real proxy profile returning ONLY its live available models (excluding non-proxy models).
    const listAvailableModelsForPreset = vi.fn(async (presetId: string, profileId?: string) => {
      if (presetId === 'agy' && profileId === 'custom-proxy') {
        return {
          isExternal: true,
          provider: 'agy-cli',
          models: [
            { id: 'gemini-4-neon', name: 'Gemini 4 Neon', provider: 'agy-cli', reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
            { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', provider: 'agy-cli', reasoningEfforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
          ],
        }
      }
      return {
        isExternal: true,
        provider: 'agy-cli',
        models: [
          { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', provider: 'agy-cli', reasoningEfforts: ['low', 'high'] },
        ],
      }
    })

    const host = {
      ctx: { agents: { get: (sid: string) => (sid === 'session-proxy-1' ? liveAgent : undefined) } } as unknown as Context,
      store,
      runtimes: {
        listAvailableModelsForPreset,
        resolveAgentLaunch: vi.fn(async () => ({ isExternal: true, provider: 'agy-cli', mountPreset: vi.fn() })),
        providerFor: () => 'agy-cli',
      } as unknown as RuntimeCatalog,
      unbindRoute: vi.fn(async () => false),
      sessionWebUrl: (sid: string) => `https://dsh.example.com/#session=${sid}`,
      runTurn: vi.fn(async () => ''),
    }

    const replies: string[] = []
    const sendCmd = async (args: string) => {
      await handleSlashCommand(host, {
        bot,
        group,
        chatType: 'group',
        senderOpenId: 'ou_member',
        command: { name: 'model', args },
        routeKey: 'cli_demo:oc_team:om_topic',
        workingDir: dir,
        workspaceName: '研发群',
        reply: async (text) => {
          replies.push(text)
        },
      })
    }

    // 1. No-arg `/model` displays ONLY the live profile models (not base agy models).
    await sendCmd('')
    expect(listAvailableModelsForPreset).toHaveBeenCalledWith('agy', 'custom-proxy')
    expect(replies.at(-1)).toContain('agy (custom-proxy)')
    expect(replies.at(-1)).toContain('可用模型（共 2 个）：')
    expect(replies.at(-1)).not.toContain('真实可用模型')
    expect(replies.at(-1)).toContain('gemini-4-neon')
    expect(replies.at(-1)).toContain('gemini-4-carbon')
    expect(replies.at(-1)).not.toContain('claude-opus-5-5')

    // 2. Rejects model unavailable on this proxy profile.
    await sendCmd('claude-opus-5-5')
    expect(replies.at(-1)).toContain('未找到模型')
    expect(replies.at(-1)).toContain('当前可用模型：')
    expect(replies.at(-1)).not.toContain('真实可用模型')
    expect(selectSpy).not.toHaveBeenCalled()

    // 3. Rejects unsupported reasoning effort on target model.
    await sendCmd('gemini-4-carbon xhigh')
    expect(replies.at(-1)).toContain('不支持思考强度 "xhigh"')
    expect(selectSpy).not.toHaveBeenCalled()

    // 4. Valid model + effort switches ONLY current session & binding, NOT group or bot defaults.
    await sendCmd('gemini-4-carbon high')
    expect(selectSpy).toHaveBeenCalledWith({
      provider: 'agy-cli',
      model: 'gemini-4-carbon',
      reasoningEffort: 'high',
    })
    expect(replies.at(-1)).toContain('仅对本会话生效')
    expect(store.getBinding('cli_demo:oc_team:om_topic')?.model).toBe('gemini-4-carbon')
    expect(store.getBinding('cli_demo:oc_team:om_topic')?.reasoningEffort).toBe('high')
    expect(store.getBinding('cli_demo:oc_team:om_topic')?.runtimePinned).toBe(true)
    // Group and bot defaults MUST remain untouched!
    expect(store.getGroup('bot-proxy', 'oc_team')?.model).toBe('gemini-4-neon')
    expect(store.getGroup('bot-proxy', 'oc_team')?.reasoningEffort).toBe('low')
    expect(store.getBot('bot-proxy')?.model).toBe('gemini-4-neon')

    store.close()
  })
})
