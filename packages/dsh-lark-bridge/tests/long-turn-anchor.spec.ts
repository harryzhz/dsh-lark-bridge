import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  LarkBotConfigSchema,
  LarkGroupConfigSchema,
  type InboundLarkMessage,
  type LarkBotTransport,
  type SendLarkReplyInput,
} from '@dsh-lark/lark-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LarkBridgeManager } from '../src/bridge-manager.js'
import { LarkBridgeStore } from '../src/store.js'

const tempDirs: string[] = []

function makeTempDir(prefix = 'dsh-lark-p2-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface PendingTurnHandle {
  readonly sessionId: string
  readonly turn: number
  readonly emitStep: (text: string) => void
  readonly finish: (replyText: string) => void
}

function createAnchorHarness(options: {
  readonly idleSweepIntervalMs?: number
  readonly queueWaitAnchorMs?: number
  readonly longTurnAnchorMs?: number
  readonly maxConcurrentTurnsPerRuntime?: number
}) {
  const dir = makeTempDir()
  const store = new LarkBridgeStore(dir)
  const listeners = new Set<(session: Session, event: SessionEvent) => void>()
  const agents = new Map<string, { session: Session; followup: (msg: unknown) => void }>()
  const pendingTurns: PendingTurnHandle[] = []
  let turnSeq = 0

  const emit = (session: Session, event: SessionEvent) => {
    for (const fn of [...listeners]) fn(session, event)
  }

  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    get: (key: string) => {
      if (key === 'workspaceRegistry') {
        return {
          list: () => [],
          archivedSessionIds: [] as string[],
          create: async (_cwd: string, title?: string) => ({
            id: 'ws-p2',
            title: title ?? 'demo',
            cwd: dir,
            sessionIds: [] as string[],
            setTitle: vi.fn(),
            attachSession: vi.fn(),
          }),
          archiveSession: vi.fn().mockReturnValue(true),
        }
      }
      if (key === 'externalRuntimes') {
        return {
          list: () => [
            {
              id: 'codex',
              displayName: 'Codex',
              description: 'Codex',
              providerId: 'codex-cli',
              defaultModel: 'gpt-5-codex',
            },
          ],
          get: (id: string) =>
            id === 'codex'
              ? {
                  id: 'codex',
                  displayName: 'Codex',
                  description: 'Codex',
                  providerId: 'codex-cli',
                  defaultModel: 'gpt-5-codex',
                }
              : undefined,
          listModelsForProvider: async () => [{ id: 'gpt-5-codex', name: 'GPT-5 Codex' }],
        }
      }
      return undefined
    },
    inject: vi.fn(),
    effect: () => () => {},
    on: (name: string, fn: (session: Session, event: SessionEvent) => void) => {
      if (name === 'session/event') listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    sessions: { get: (id: string) => agents.get(id)?.session },
    agents: {
      get: (id: string) => agents.get(id),
      create: async (opts: { sessionId: string; meta: { cwd: string; agentPreset: string } }) => {
        const session = {
          id: opts.sessionId,
          header: { cwd: opts.meta.cwd, agentPreset: opts.meta.agentPreset },
          snapshotEvents: () => [],
        } as unknown as Session
        const agent = {
          session,
          followup: (userMsg: { id?: string; content: Array<{ type: string; text?: string }> }) => {
            const turn = ++turnSeq
            emit(session, { type: 'turn/start', data: { turn } } as unknown as SessionEvent)
            emit(session, {
              type: 'user/message',
              data: { id: userMsg.id, turn },
            } as unknown as SessionEvent)

            pendingTurns.push({
              sessionId: opts.sessionId,
              turn,
              emitStep: (stepText: string) => {
                emit(session, {
                  type: 'assistant/message',
                  data: {
                    turn,
                    step: 1,
                    message: {
                      role: 'assistant',
                      content: [
                        { type: 'text', text: stepText },
                        { type: 'tool-call', id: 'tc-1', name: 'bash', input: {} },
                      ],
                    },
                  },
                } as unknown as SessionEvent)
              },
              finish: (replyText: string) => {
                emit(session, {
                  type: 'assistant/message',
                  data: {
                    turn,
                    step: 2,
                    message: {
                      role: 'assistant',
                      content: [{ type: 'text', text: replyText }],
                    },
                  },
                } as unknown as SessionEvent)
                emit(session, {
                  type: 'turn/end',
                  data: { turn, reason: { kind: 'completed' } },
                } as unknown as SessionEvent)
              },
            })
          },
          abort: vi.fn(),
        }
        agents.set(opts.sessionId, agent)
        return {
          agent,
          dispose: vi.fn().mockResolvedValue(undefined),
        }
      },
      resume: vi.fn(),
    },
  } as unknown as Context

  const manager = new LarkBridgeManager(
    ctx,
    {
      dataDir: dir,
      publicBaseUrl: 'http://127.0.0.1:3880',
      idleSweepIntervalMs: options.idleSweepIntervalMs ?? 0,
      maxAuditEvents: 200,
      autoInstallCliAndSkill: false,
      syncGlobalCliAndSkill: false,
      enableInstanceLock: false,
      ...(options.maxConcurrentTurnsPerRuntime !== undefined
        ? { maxConcurrentTurnsPerRuntime: options.maxConcurrentTurnsPerRuntime }
        : {}),
      ...(options.queueWaitAnchorMs !== undefined
        ? { queueWaitAnchorMs: options.queueWaitAnchorMs }
        : {}),
      ...(options.longTurnAnchorMs !== undefined
        ? { longTurnAnchorMs: options.longTurnAnchorMs }
        : {}),
    },
    store,
  )

  const sentReplies: SendLarkReplyInput[] = []
  let replySeq = 0
  const transport = {
    state: { botOpenId: 'ou_bot_p2', connected: true },
    addReaction: vi.fn(async () => 'rx_1'),
    removeReaction: vi.fn(async () => {}),
    sendReply: vi.fn(async (input: SendLarkReplyInput) => {
      sentReplies.push(input)
      const id = `om_reply_${++replySeq}`
      return {
        messageId: id,
        ...(input.replyMode === 'new-topic'
          ? { rootId: input.replyToMessageId, threadId: `omt_${input.replyToMessageId}` }
          : {}),
      }
    }),
    resolveUserSummary: vi.fn(async (openId: string) => ({ openId, name: 'Alex' })),
  } as unknown as LarkBotTransport

  return { dir, store, manager, transport, sentReplies, pendingTurns }
}

function makeBot(dir: string, overrides: Partial<Parameters<typeof LarkBotConfigSchema.parse>[0]> = {}) {
  return LarkBotConfigSchema.parse({
    id: 'bot-p2',
    name: 'AnchorBot',
    enabled: true,
    larkAppId: 'cli_p2',
    larkAppSecret: 'sec_p2',
    defaultWorkingDir: dir,
    agentPreset: 'codex',
    useInteractiveCard: false,
    groupReplyMode: 'new-topic',
    groupSessionMode: 'thread',
    mentionTriggerMode: 'mention_and_active_thread',
    router: { enabled: false, coalesceQueuedMessages: true },
    ...overrides,
  })
}

function makeMentionMsg(
  id: string,
  text: string,
  extra: Partial<InboundLarkMessage> = {},
): InboundLarkMessage {
  return {
    botId: 'bot-p2',
    larkAppId: 'cli_p2',
    botOpenId: 'ou_bot_p2',
    messageId: id,
    chatId: 'oc_p2',
    chatType: 'group',
    msgType: 'text',
    senderOpenId: 'ou_user_1',
    senderType: 'user',
    text: `@_user_1 ${text}`,
    rawContent: JSON.stringify({ text: `@_user_1 ${text}` }),
    mentions: [{ key: '@_user_1', openId: 'ou_bot_p2', name: 'AnchorBot' }],
    imageKeys: [],
    createTimeMs: Date.now(),
    ...extra,
  }
}

describe('Long-turn & queue-wait automatic progress anchors (P2)', () => {
  it('sends a single queue-wait anchor when same-session follow-ups wait past threshold, coalesces followers without duplicates, and suppresses duplicate exec anchor', async () => {
    const h = createAnchorHarness({ queueWaitAnchorMs: 45, longTurnAnchorMs: 60 })
    const bot = makeBot(h.dir)
    h.store.upsertBot(bot)
    h.store.upsertGroup(
      LarkGroupConfigSchema.parse({
        key: 'bot-p2:oc_p2',
        botId: 'bot-p2',
        chatId: 'oc_p2',
        enabled: true,
      }),
    )

    try {
      // Turn 1 starts in new thread rooted at om_1
      const t1 = h.manager.handleInbound(bot.id, h.transport, makeMentionMsg('om_1', '先查一下全量日志'))
      await vi.waitFor(() => expect(h.pendingTurns).toHaveLength(1))

      // Resolve Turn 1 quickly (before longTurnAnchorMs) — wait, keep Turn 1 running while Turn 2 & Turn 3 queue on same route!
      // Wait 10ms, then enqueue Turn 2 (leader) & Turn 3 (coalesced follower) on the same thread root om_1
      const t2 = h.manager.handleInbound(
        bot.id,
        h.transport,
        makeMentionMsg('om_2', '顺便看下报错率', { rootId: 'om_1', threadId: 'omt_om_1' }),
      )
      await sleep(10)
      const t3 = h.manager.handleInbound(
        bot.id,
        h.transport,
        makeMentionMsg('om_3', '再补一个指标', { rootId: 'om_1', threadId: 'omt_om_1' }),
      )

      // Wait past queueWaitAnchorMs (45ms) so queued batch emits queue anchor, and Turn 1 emits exec anchor (60ms)
      await sleep(95)

      const queueAnchors = h.sentReplies.filter((r) => r.text?.includes('已加入队列'))
      expect(queueAnchors).toHaveLength(1)
      expect(queueAnchors[0]?.replyToMessageId).toBe('om_2')

      // Finish Turn 1 -> queued batch (om_2 + om_3) begins executing
      h.pendingTurns[0]!.finish('第一轮结论')
      await t1
      await vi.waitFor(() => expect(h.pendingTurns).toHaveLength(2))

      // Hold Turn 2 past longTurnAnchorMs (60ms): MUST NOT send a second execution anchor since queue anchor was already sent
      await sleep(90)
      const execAnchorsOnTurn2 = h.sentReplies.filter(
        (r) => r.replyToMessageId === 'om_2' && r.text?.includes('深度求索中'),
      )
      expect(execAnchorsOnTurn2).toHaveLength(0)

      // Finish Turn 2 -> Turn 3 starts and finishes cleanly; final replies delivered normally
      h.pendingTurns[1]!.finish('队列第二条结论')
      await t2
      await vi.waitFor(() => expect(h.pendingTurns).toHaveLength(3))
      h.pendingTurns[2]!.finish('队列第三条结论')
      await t3

      const finalTexts = h.sentReplies.map((r) => r.text ?? '')
      expect(finalTexts).toContain('第一轮结论')
      expect(finalTexts).toContain('队列第二条结论')
      expect(finalTexts).toContain('队列第三条结论')
    } finally {
      await h.manager.stop()
      h.store.close()
    }
  })

  it('sends a single execution anchor when a heavy turn has no output past longTurnAnchorMs, cancels on fast turns, and skips when intermediate messages already fired', async () => {
    const h = createAnchorHarness({ queueWaitAnchorMs: 50, longTurnAnchorMs: 60 })
    const bot = makeBot(h.dir, { sendIntermediateMessages: true })
    h.store.upsertBot(bot)
    h.store.upsertGroup(
      LarkGroupConfigSchema.parse({
        key: 'bot-p2:oc_p2',
        botId: 'bot-p2',
        chatId: 'oc_p2',
        enabled: true,
      }),
    )

    try {
      // 1. Fast turn (< longTurnAnchorMs) -> zero anchors
      const fast = h.manager.handleInbound(bot.id, h.transport, makeMentionMsg('om_fast', '快回一下'))
      await vi.waitFor(() => expect(h.pendingTurns).toHaveLength(1))
      h.pendingTurns[0]!.finish('秒回结果')
      await fast
      await sleep(80)
      expect(h.sentReplies.filter((r) => r.replyToMessageId === 'om_fast')).toHaveLength(1)
      expect(h.sentReplies[0]?.text).toBe('秒回结果')

      // 2. Heavy turn with intermediate step BEFORE longTurnAnchorMs -> execution anchor suppressed
      const withStep = h.manager.handleInbound(
        bot.id,
        h.transport,
        makeMentionMsg('om_step', '分步排查'),
      )
      await vi.waitFor(() => expect(h.pendingTurns).toHaveLength(2))
      h.pendingTurns[1]!.emitStep('先检查配置')
      await sleep(90)
      h.pendingTurns[1]!.finish('排查完毕')
      await withStep
      const stepReplies = h.sentReplies.filter((r) => r.replyToMessageId === 'om_step')
      expect(stepReplies.map((r) => r.text)).toEqual(['先检查配置', '排查完毕'])

      // 3. Heavy turn with NO intermediate output past longTurnAnchorMs -> exactly 1 execution anchor + final reply
      const slow = h.manager.handleInbound(bot.id, h.transport, makeMentionMsg('om_slow', '深度分析'))
      await vi.waitFor(() => expect(h.pendingTurns).toHaveLength(3))
      await sleep(95)
      h.pendingTurns[2]!.finish('深度分析报告')
      await slow
      const slowReplies = h.sentReplies.filter((r) => r.replyToMessageId === 'om_slow')
      expect(slowReplies).toHaveLength(2)
      expect(slowReplies[0]?.text).toBe('当前任务仍在深度求索中，请耐心等待…[敲键盘]')
      expect(slowReplies[1]?.text).toBe('深度分析报告')
    } finally {
      await h.manager.stop()
      h.store.close()
    }
  })

  it('never emits progress anchors for passive listener turns, bots with longTurnProgressNotice=false, or recalled messages', async () => {
    const h = createAnchorHarness({ queueWaitAnchorMs: 40, longTurnAnchorMs: 45 })
    const botListener = makeBot(h.dir, { id: 'bot-p2', longTurnProgressNotice: true })
    const botDisabled = makeBot(h.dir, {
      id: 'bot-off',
      name: 'QuietBot',
      larkAppId: 'cli_off',
      longTurnProgressNotice: false,
    })
    h.store.upsertBot(botListener)
    h.store.upsertBot(botDisabled)
    h.store.upsertGroup(
      LarkGroupConfigSchema.parse({
        key: 'bot-p2:oc_p2',
        botId: 'bot-p2',
        chatId: 'oc_p2',
        enabled: true,
        listener: {
          enabled: true,
          name: '工作日常',
          prompt: '旁听',
          debounceSeconds: 0,
          allowSilentEmptyReply: true,
        },
      }),
    )
    h.store.upsertGroup(
      LarkGroupConfigSchema.parse({
        key: 'bot-off:oc_off',
        botId: 'bot-off',
        chatId: 'oc_off',
        enabled: true,
      }),
    )

    try {
      // 1. Passive listener message (not @bot) runs > longTurnAnchorMs and silences -> 0 replies
      const listenerMsg: InboundLarkMessage = {
        botId: 'bot-p2',
        larkAppId: 'cli_p2',
        botOpenId: 'ou_bot_p2',
        messageId: 'om_listen_1',
        chatId: 'oc_p2',
        chatType: 'group',
        msgType: 'text',
        senderOpenId: 'ou_user_1',
        senderType: 'user',
        text: '今天发布窗口顺延半小时',
        rawContent: JSON.stringify({ text: '今天发布窗口顺延半小时' }),
        mentions: [],
        imageKeys: [],
        createTimeMs: Date.now(),
      }
      const pListen = h.manager.handleInbound(botListener.id, h.transport, listenerMsg)
      await vi.waitFor(() => expect(h.pendingTurns).toHaveLength(1))
      await sleep(80)
      h.pendingTurns[0]!.finish('<no_reply/>')
      await pListen
      expect(h.sentReplies).toHaveLength(0)

      // 2. Bot with longTurnProgressNotice=false -> no anchor even past longTurnAnchorMs
      const pOff = h.manager.handleInbound(
        botDisabled.id,
        h.transport,
        makeMentionMsg('om_off_1', '帮我跑个长任务', {
          botId: 'bot-off',
          larkAppId: 'cli_off',
          chatId: 'oc_off',
        }),
      )
      await vi.waitFor(() => expect(h.pendingTurns).toHaveLength(2))
      await sleep(80)
      h.pendingTurns[1]!.finish('已完成')
      await pOff
      expect(h.sentReplies.filter((r) => r.replyToMessageId === 'om_off_1').map((r) => r.text)).toEqual([
        '已完成',
      ])
    } finally {
      await h.manager.stop()
      h.store.close()
    }
  })

  it('respects custom longTurnNoticeText, falls back to default when blank, and honors per-bot longTurnNoticeDelaySeconds including 0=disabled', async () => {
    const h = createAnchorHarness({ queueWaitAnchorMs: 40, longTurnAnchorMs: 50 })
    const botCustom = makeBot(h.dir, {
      id: 'bot-custom',
      name: 'CustomBot',
      larkAppId: 'cli_custom',
      longTurnProgressNotice: true,
      longTurnNoticeDelaySeconds: 120,
      longTurnNoticeText: '全力排查中，请稍候 [思考]',
    })
    const botBlank = makeBot(h.dir, {
      id: 'bot-blank',
      name: 'BlankBot',
      larkAppId: 'cli_blank',
      longTurnProgressNotice: true,
      longTurnNoticeDelaySeconds: 60,
      longTurnNoticeText: '   ',
    })
    const botDelayZero = makeBot(h.dir, {
      id: 'bot-zero',
      name: 'ZeroDelayBot',
      larkAppId: 'cli_zero',
      longTurnProgressNotice: true,
      longTurnNoticeDelaySeconds: 0,
      longTurnNoticeText: '不会发送',
    })
    h.store.upsertBot(botCustom)
    h.store.upsertBot(botBlank)
    h.store.upsertBot(botDelayZero)
    for (const [botId, chatId] of [
      ['bot-custom', 'oc_custom'],
      ['bot-blank', 'oc_blank'],
      ['bot-zero', 'oc_zero'],
    ] as const) {
      h.store.upsertGroup(
        LarkGroupConfigSchema.parse({
          key: `${botId}:${chatId}`,
          botId,
          chatId,
          enabled: true,
        }),
      )
    }

    try {
      const pCustom = h.manager.handleInbound(
        botCustom.id,
        h.transport,
        makeMentionMsg('om_custom_1', '查一下', {
          botId: botCustom.id,
          larkAppId: botCustom.larkAppId,
          chatId: 'oc_custom',
        }),
      )
      await vi.waitFor(() => expect(h.pendingTurns).toHaveLength(1))
      await sleep(80)
      h.pendingTurns[0]!.finish('自定义结论')
      await pCustom
      expect(
        h.sentReplies.filter((r) => r.replyToMessageId === 'om_custom_1').map((r) => r.text),
      ).toEqual(['全力排查中，请稍候 [思考]', '自定义结论'])

      const pBlank = h.manager.handleInbound(
        botBlank.id,
        h.transport,
        makeMentionMsg('om_blank_1', '查一下', {
          botId: botBlank.id,
          larkAppId: botBlank.larkAppId,
          chatId: 'oc_blank',
        }),
      )
      await vi.waitFor(() => expect(h.pendingTurns).toHaveLength(2))
      await sleep(80)
      h.pendingTurns[1]!.finish('留空兜底结论')
      await pBlank
      expect(
        h.sentReplies.filter((r) => r.replyToMessageId === 'om_blank_1').map((r) => r.text),
      ).toEqual(['当前任务仍在深度求索中，请耐心等待…[敲键盘]', '留空兜底结论'])

      // delaySeconds=0 disables execution anchor while keeping queue-wait anchor available
      const pZero1 = h.manager.handleInbound(
        botDelayZero.id,
        h.transport,
        makeMentionMsg('om_zero_1', '长任务一', {
          botId: botDelayZero.id,
          larkAppId: botDelayZero.larkAppId,
          chatId: 'oc_zero',
        }),
      )
      await vi.waitFor(() => expect(h.pendingTurns).toHaveLength(3))
      const pZero2 = h.manager.handleInbound(
        botDelayZero.id,
        h.transport,
        makeMentionMsg('om_zero_2', '排队追问', {
          botId: botDelayZero.id,
          larkAppId: botDelayZero.larkAppId,
          chatId: 'oc_zero',
          rootId: 'om_zero_1',
          threadId: 'omt_om_zero_1',
        }),
      )
      await sleep(80)
      h.pendingTurns[2]!.finish('任务一结论')
      await pZero1
      await vi.waitFor(() => expect(h.pendingTurns).toHaveLength(4))
      h.pendingTurns[3]!.finish('任务二结论')
      await pZero2
      expect(
        h.sentReplies.filter((r) => r.replyToMessageId === 'om_zero_1').map((r) => r.text),
      ).toEqual(['任务一结论'])
      expect(
        h.sentReplies.filter((r) => r.replyToMessageId === 'om_zero_2').map((r) => r.text),
      ).toEqual(['前序任务仍在处理中，已加入队列，完成后会继续处理。', '任务二结论'])
    } finally {
      await h.manager.stop()
      h.store.close()
    }
  })

  it('uses per-bot longTurnNoticeDelaySeconds in production mode when no host override is set', async () => {
    const h = createAnchorHarness({ idleSweepIntervalMs: 60_000, queueWaitAnchorMs: 0 })
    const botOneSec = makeBot(h.dir, {
      id: 'bot-1s',
      name: 'FastNoticeBot',
      larkAppId: 'cli_1s',
      longTurnProgressNotice: true,
      longTurnNoticeDelaySeconds: 1,
      longTurnNoticeText: '1秒后提示…[敲键盘]',
    })
    h.store.upsertBot(botOneSec)
    h.store.upsertGroup(
      LarkGroupConfigSchema.parse({
        key: 'bot-1s:oc_1s',
        botId: 'bot-1s',
        chatId: 'oc_1s',
        enabled: true,
      }),
    )

    try {
      const p = h.manager.handleInbound(
        botOneSec.id,
        h.transport,
        makeMentionMsg('om_1s_1', '测1秒阈值', {
          botId: botOneSec.id,
          larkAppId: botOneSec.larkAppId,
          chatId: 'oc_1s',
        }),
      )
      await vi.waitFor(() => expect(h.pendingTurns).toHaveLength(1))
      await sleep(400)
      expect(h.sentReplies.filter((r) => r.replyToMessageId === 'om_1s_1')).toHaveLength(0)
      await vi.waitFor(
        () =>
          expect(
            h.sentReplies.filter((r) => r.replyToMessageId === 'om_1s_1').map((r) => r.text),
          ).toEqual(['1秒后提示…[敲键盘]']),
        { timeout: 1_500 },
      )
      h.pendingTurns[0]!.finish('完成')
      await p
      expect(
        h.sentReplies.filter((r) => r.replyToMessageId === 'om_1s_1').map((r) => r.text),
      ).toEqual(['1秒后提示…[敲键盘]', '完成'])
    } finally {
      await h.manager.stop()
      h.store.close()
    }
  })

  it('suppresses both exec and queue progress anchors whenever native CoT is enabled (bot default or group override)', async () => {
    const h = createAnchorHarness({ queueWaitAnchorMs: 35, longTurnAnchorMs: 40 })
    const botDefaultOff = makeBot(h.dir, {
      id: 'bot-cot-group',
      name: 'CotGroupBot',
      larkAppId: 'cli_cot_grp',
      cotEnabled: false,
      longTurnProgressNotice: true,
    })
    h.store.upsertBot(botDefaultOff)
    h.store.upsertGroup(
      LarkGroupConfigSchema.parse({
        key: 'bot-cot-group:oc_cot_on',
        botId: 'bot-cot-group',
        chatId: 'oc_cot_on',
        enabled: true,
        cotEnabled: 'on',
      }),
    )

    try {
      // Turn 1 starts in group with cotEnabled='on' and stays silent past longTurnAnchorMs (no CoT bubble yet)
      const p1 = h.manager.handleInbound(
        botDefaultOff.id,
        h.transport,
        makeMentionMsg('om_cot_1', '长耗时任务一', {
          botId: botDefaultOff.id,
          larkAppId: botDefaultOff.larkAppId,
          chatId: 'oc_cot_on',
        }),
      )
      await vi.waitFor(() => expect(h.pendingTurns).toHaveLength(1))

      // Turn 2 queues behind Turn 1 on the same thread past queueWaitAnchorMs
      const p2 = h.manager.handleInbound(
        botDefaultOff.id,
        h.transport,
        makeMentionMsg('om_cot_2', '排队任务二', {
          botId: botDefaultOff.id,
          larkAppId: botDefaultOff.larkAppId,
          chatId: 'oc_cot_on',
          rootId: 'om_cot_1',
          threadId: 'omt_om_cot_1',
        }),
      )

      await sleep(95)
      // Neither exec progress notice nor queue-wait progress notice should fire when CoT is enabled
      expect(h.sentReplies).toHaveLength(0)

      h.pendingTurns[0]!.finish('任务一完成')
      await p1
      await vi.waitFor(() => expect(h.pendingTurns).toHaveLength(2))
      h.pendingTurns[1]!.finish('任务二完成')
      await p2
      expect(h.sentReplies.map((r) => r.text)).toEqual(['任务一完成', '任务二完成'])
    } finally {
      await h.manager.stop()
      h.store.close()
    }
  })
})
