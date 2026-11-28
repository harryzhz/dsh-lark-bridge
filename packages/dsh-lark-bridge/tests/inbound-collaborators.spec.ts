import { describe, expect, it, vi } from 'vitest'
import { InboundPayloadHydrator } from '../src/inbound/payload-hydrator.js'
import { TurnReplyDelivery } from '../src/inbound/reply-delivery.js'
import {
  TurnRoutingCoordinator,
  applyPinnedBindingRuntime,
} from '../src/inbound/routing-coordinator.js'
import {
  TurnStateRegistry,
  createDisabledAbortError,
  createRecalledAbortError,
  type InboundPipelineHost,
  type QueuedWorkerTurnItem,
} from '../src/inbound/turn-state-registry.js'
import { InboundMediaCache } from '../src/media-intake.js'
import type { AgentDecision } from '../src/session-coordinator.js'
import type { LarkSessionBinding } from '../src/types.js'

function makeMinimalHost(): InboundPipelineHost {
  return {
    ctx: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as InboundPipelineHost['ctx'],
    store: {
      getBot: vi.fn(() => undefined),
      getGroup: vi.fn(() => undefined),
      getBinding: vi.fn(() => undefined),
      upsertPendingTurn: vi.fn(),
      deletePendingTurn: vi.fn(),
      listPendingTurns: vi.fn(() => []),
      recordEvent: vi.fn(),
      recordMetric: vi.fn(),
    } as unknown as InboundPipelineHost['store'],
    runtimes: {
      list: vi.fn(async () => []),
    } as unknown as InboundPipelineHost['runtimes'],
    connections: {
      getTransport: vi.fn(() => undefined),
      isActiveTransport: vi.fn(() => true),
      listBotStatuses: vi.fn(() => []),
    } as unknown as InboundPipelineHost['connections'],
    sessions: {} as unknown as InboundPipelineHost['sessions'],
    titleGuard: { ensureCleanSessionTitle: vi.fn() } as unknown as InboundPipelineHost['titleGuard'],
    shutdownSignal: new AbortController().signal,
    isDisposed: () => false,
    sessionWebUrl: (sid) => `http://127.0.0.1/sessions/${sid}`,
  }
}

function makeDecision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    action: 'agent',
    trigger: 'mention',
    routeKey: 'cli_test:oc_1:om_1',
    workingDir: '/Users/demo/project',
    workspaceName: 'Demo',
    agentPreset: 'codex',
    sessionMode: 'thread',
    replyMode: 'new-topic',
    useCard: true,
    cotEnabled: false,
    cotToolResultEnabled: true,
    sendIntermediateMessages: false,
    allowSilentEmptyReply: false,
    autoCloseAfterCompletion: false,
    turnReminders: [],
    userText: 'hello',
    promptText: 'hello',
    ...overrides,
  }
}

describe('InboundPipeline extracted collaborators', () => {
  it('TurnStateRegistry.createBatchCancelBinding aborts on disable immediately but requires all members recalled for recall abort', () => {
    const host = makeMinimalHost()
    const registry = new TurnStateRegistry(host)
    const c1 = new AbortController()
    const c2 = new AbortController()
    const baseMsg = (id: string) =>
      ({
        messageId: id,
        chatId: 'oc_1',
        chatType: 'group',
        senderType: 'user',
        msgType: 'text',
        text: 'hi',
        mentions: [],
        imageKeys: [],
        createTimeMs: Date.now(),
      }) as QueuedWorkerTurnItem['msg']
    const items: QueuedWorkerTurnItem[] = [
      {
        msg: baseMsg('om_1'),
        decision: makeDecision(),
        activeTurn: registry.registerActiveTurn({
          traceId: 'tr_1',
          botId: 'bot_1',
          chatId: 'oc_1',
          messageId: 'om_1',
          routeKey: 'cli_test:oc_1:om_1',
          replyMode: 'new-topic',
          trigger: 'mention',
          allowSilentEmptyReply: false,
          startedAtMs: Date.now(),
          transport: {} as never,
          cancelController: c1,
          intermediateSentCount: 0,
          recoveryAttempts: 0,
          gracefulRecoveryAttempts: 0,
        }),
        cancelController: c1,
        mediaCache: new InboundMediaCache(),
        traceId: 'tr_1',
      },
      {
        msg: baseMsg('om_2'),
        decision: makeDecision(),
        activeTurn: registry.registerActiveTurn({
          traceId: 'tr_2',
          botId: 'bot_1',
          chatId: 'oc_1',
          messageId: 'om_2',
          routeKey: 'cli_test:oc_1:om_1',
          replyMode: 'new-topic',
          trigger: 'mention',
          allowSilentEmptyReply: false,
          startedAtMs: Date.now(),
          transport: {} as never,
          cancelController: c2,
          intermediateSentCount: 0,
          recoveryAttempts: 0,
          gracefulRecoveryAttempts: 0,
        }),
        cancelController: c2,
        mediaCache: new InboundMediaCache(),
        traceId: 'tr_2',
      },
    ]

    const linked = registry.createBatchCancelBinding('bot_1', () => items)
    // Recalling only 1 of 2 items does NOT abort the batch.
    items[0]!.activeTurn.cancelledByRecall = true
    c1.abort(createRecalledAbortError())
    expect(linked.signal.aborted).toBe(false)

    // Recalling the second item aborts the whole batch.
    items[1]!.activeTurn.cancelledByRecall = true
    c2.abort(createRecalledAbortError())
    expect(linked.signal.aborted).toBe(true)
    linked.dispose()

    // Disable abort fires immediately even on a single item.
    const c3 = new AbortController()
    items[0]!.activeTurn.cancelledByRecall = false
    const linked2 = registry.createBatchCancelBinding('bot_1', () => [
      { ...items[0]!, cancelController: c3 },
      items[1]!,
    ])
    c3.abort(createDisabledAbortError('group'))
    expect(linked2.signal.aborted).toBe(true)
    linked2.dispose()
  })

  it('InboundPayloadHydrator tracks sent Feishu message IDs in memory for quote dedup', () => {
    const host = makeMinimalHost()
    const hydrator = new InboundPayloadHydrator(host)
    hydrator.recordSentLarkMessage('sess_1', undefined, 'om_reply_1')
    const ids = hydrator.collectInjectedMessageIds('sess_1')
    expect(ids.has('om_reply_1')).toBe(true)
  })

  it('TurnRoutingCoordinator expires tier target cooldowns deterministically and applies pinned binding runtime', () => {
    const host = makeMinimalHost()
    const registry = new TurnStateRegistry(host)
    const hydrator = new InboundPayloadHydrator(host)
    const delivery = new TurnReplyDelivery(host, registry, hydrator)
    const routing = new TurnRoutingCoordinator(host, registry, hydrator, delivery)

    const t0 = 1_000_000
    routing.markTierTargetCooldown('codex', 'prof-fast', 'gpt-5', t0)
    expect(
      routing.isTierTargetInCooldown(
        { agentPreset: 'codex', runtimeProfileId: 'prof-fast', model: 'gpt-5', weight: 1 },
        t0 + 10_000,
      ),
    ).toBe(true)
    expect(
      routing.isTierTargetInCooldown(
        { agentPreset: 'codex', runtimeProfileId: 'prof-fast', model: 'gpt-5', weight: 1 },
        t0 + 60_001,
      ),
    ).toBe(false)

    const decision = makeDecision()
    const binding: LarkSessionBinding = {
      routeKey: 'cli_test:oc_1:omt_promoted',
      botId: 'bot_1',
      chatId: 'oc_1',
      chatType: 'group',
      sessionId: 'sess_1',
      workingDir: '/Users/demo/project',
      agentPreset: 'agy',
      runtimeProfileId: 'prof-pro',
      model: 'gemini-pro',
      reasoningEffort: 'high',
      runtimePinned: true,
      routedTier: 'deep',
      trigger: 'mention',
      createdAt: t0,
      updatedAt: t0,
    }
    const pinned = applyPinnedBindingRuntime(decision, 'cli_test:oc_1:omt_promoted', binding)
    expect(pinned.routeKey).toBe('cli_test:oc_1:omt_promoted')
    expect(pinned.agentPreset).toBe('agy')
    expect(pinned.runtimeProfileId).toBe('prof-pro')
    expect(pinned.model).toBe('gemini-pro')
    expect(pinned.reasoningEffort).toBe('high')
    expect(pinned.runtimePinned).toBe(true)
    expect(pinned.routedTier).toBe('deep')
  })
})
