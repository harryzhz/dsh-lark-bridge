import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InboundLarkMessage, LarkBotTransport } from '@dsh-lark/lark-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LarkBridgeManager } from '../src/bridge-manager.js'
import { dispatchLarkApiRequest } from '../src/http-api.js'
import { SessionTitleGuard } from '../src/session-title-guard.js'
import { LarkBridgeStore } from '../src/store.js'
import { WorkspaceGrouping } from '../src/workspace-grouping.js'

const tempDirs: string[] = []

function makeTempDir(prefix = 'dsh-lark-phasec-'): string {
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

function createMockRuntimeCtx() {
  const listeners = new Set<(session: Session, event: SessionEvent) => void>()
  const agents = new Map<string, { session: Session; followup: (msg: unknown) => void }>()
  const disposedSessions: string[] = []
  const archivedSessions: string[] = []
  let releaseTurn: ((replyText: string) => void) | undefined
  let onTurnStarted: ((sessionId: string) => void) | undefined

  const emit = (session: Session, event: SessionEvent) => {
    for (const fn of [...listeners]) fn(session, event)
  }

  let turnSeq = 0
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    get: (key: string) => {
      if (key === 'workspaces') {
        return {
          list: () => [],
          create: () => ({ id: 'ws-1', name: 'demo', cwd: '/tmp', sessionIds: [] }),
          addSession: vi.fn(),
          archiveSession: (sid: string) => {
            archivedSessions.push(sid)
            return true
          },
          getArchivedSessionIds: () => archivedSessions,
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
    llm: {
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      listModels: async () => [{ id: 'mock-model', name: 'Mock Model' }],
    },
    sessions: {
      get: (id: string) => agents.get(id)?.session,
    },
    agents: {
      listPresets: () => [{ id: 'standard', name: 'Standard', defaultModel: 'mock-model' }],
      get: (id: string) => agents.get(id),
      create: async (opts: { sessionId: string; meta: { cwd: string; agentPreset: string } }) => {
        const session = {
          id: opts.sessionId,
          header: { cwd: opts.meta.cwd, agentPreset: opts.meta.agentPreset },
          snapshotEvents: () => [],
        } as unknown as Session
        const agent = {
          session,
          followup: (userMsg: { id?: string }) => {
            const turn = ++turnSeq
            emit(session, { type: 'turn/start', data: { turn } } as unknown as SessionEvent)
            emit(session, {
              type: 'user/message',
              data: { id: userMsg.id, turn },
            } as unknown as SessionEvent)
            onTurnStarted?.(opts.sessionId)
            releaseTurn = (replyText: string) => {
              emit(session, {
                type: 'assistant/message',
                data: {
                  turn,
                  message: { role: 'assistant', content: [{ type: 'text', text: replyText }] },
                },
              } as unknown as SessionEvent)
              emit(session, {
                type: 'turn/end',
                data: { turn, reason: { kind: 'completed' } },
              } as unknown as SessionEvent)
            }
          },
        }
        agents.set(opts.sessionId, agent)
        return {
          agent,
          dispose: async () => {
            disposedSessions.push(opts.sessionId)
            agents.delete(opts.sessionId)
          },
        }
      },
      resume: async () => {
        throw new Error('resume not expected')
      },
    },
  } as unknown as Context

  return {
    ctx,
    disposedSessions,
    archivedSessions,
    setOnTurnStarted: (cb: (sessionId: string) => void) => {
      onTurnStarted = cb
    },
    finishCurrentTurn: (replyText: string) => {
      const fn = releaseTurn
      releaseTurn = undefined
      if (!fn) throw new Error('no turn waiting to finish')
      fn(replyText)
    },
  }
}

describe('SessionActor invariants, structured silence control & SessionTitleGuard isolation', () => {
  it('enforces SessionActor state machine: blocks idle sweep during running turn and archives cleanly once idle', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const runtime = createMockRuntimeCtx()
    const manager = new LarkBridgeManager(
      runtime.ctx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 200,
        autoInstallCliAndSkill: false,
      },
      store,
    )

    store.upsertBot({
      id: 'bot-actor',
      name: 'ActorBot',
      larkAppId: 'cli_actor_1',
      larkAppSecret: 'mock-secret-value',
      defaultWorkingDir: dir,
      agentPreset: 'standard',
      idleCloseMinutes: 1,
      receivedReactionEmoji: 'NONE',
    })

    const sentReplies: unknown[] = []
    const fakeTransport = {
      state: { botOpenId: 'ou_bot_actor', connected: true },
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      sendReply: vi.fn().mockImplementation(async (opts) => {
        sentReplies.push(opts)
        return { messageId: 'om_reply_actor_1' }
      }),
    } as unknown as LarkBotTransport

    let activeSessionId = ''
    const turnEntered = new Promise<void>((resolve) => {
      runtime.setOnTurnStarted((sid) => {
        activeSessionId = sid
        resolve()
      })
    })

    const msg: InboundLarkMessage = {
      botId: 'bot-actor',
      larkAppId: 'cli_actor_1',
      botOpenId: 'ou_bot_actor',
      messageId: 'om_in_actor_1',
      chatId: 'oc_actor_chat',
      chatType: 'group',
      msgType: 'text',
      senderOpenId: 'ou_user_1',
      senderType: 'user',
      text: '@ActorBot run long task',
      rawContent: '{"text":"@ActorBot run long task"}',
      mentions: [{ key: '@_user_1', openId: 'ou_bot_actor', name: 'ActorBot' }],
      imageKeys: [],
      createTimeMs: Date.now(),
    }

    const turnPromise = manager.inbound.handleInbound('bot-actor', fakeTransport, msg)
    await turnEntered

    // While running, actor state must be 'running' and sweepIdleBindings MUST NOT archive it even far in the future.
    expect(manager.sessions.getActorState(activeSessionId)).toBe('running')
    const sweptDuringRun = await manager.sweepIdleBindings(Date.now() + 10 * 60_000)
    expect(sweptDuringRun).toBe(0)
    expect(runtime.disposedSessions).toEqual([])
    expect(store.listBindings()).toHaveLength(1)

    // Complete turn -> actor transitions to 'idle', now sweepIdleBindings archives it cleanly.
    runtime.finishCurrentTurn('任务已完成')
    await turnPromise

    expect(sentReplies).toHaveLength(1)
    expect(manager.sessions.getActorState(activeSessionId)).toBe('idle')

    const sweptAfterIdle = await manager.sweepIdleBindings(Date.now() + 10 * 60_000)
    expect(sweptAfterIdle).toBe(1)
    expect(runtime.disposedSessions).toContain(activeSessionId)
    expect(store.listBindings()).toHaveLength(0)

    await manager.stop()
    store.close()
  })

  it('suppresses trailing assistant text unconditionally when `POST /agent/silence` is invoked during a listener turn', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const runtime = createMockRuntimeCtx()
    const manager = new LarkBridgeManager(
      runtime.ctx,
      {
        dataDir: dir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 200,
        autoInstallCliAndSkill: false,
      },
      store,
    )

    store.upsertBot({
      id: 'bot-silent',
      name: 'SilentBot',
      larkAppId: 'cli_silent_1',
      larkAppSecret: 'mock-secret-value',
      defaultWorkingDir: dir,
      agentPreset: 'standard',
      receivedReactionEmoji: 'NONE',
    })
    store.upsertGroup({
      botId: 'bot-silent',
      chatId: 'oc_silent_chat',
      chatName: '旁听测试群',
      enabled: true,
      listener: {
        enabled: true,
        name: '工作日常',
        prompt: '无需回复时静默',
        allowSilentEmptyReply: true,
        sessionMode: 'per_message',
      },
    })

    const sendReply = vi.fn().mockResolvedValue({ messageId: 'om_should_not_send' })
    const fakeTransport = {
      state: { botOpenId: 'ou_bot_silent', connected: true },
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      sendReply,
    } as unknown as LarkBotTransport

    let listenerSessionId = ''
    const turnEntered = new Promise<void>((resolve) => {
      runtime.setOnTurnStarted((sid) => {
        listenerSessionId = sid
        resolve()
      })
    })

    const msg: InboundLarkMessage = {
      botId: 'bot-silent',
      larkAppId: 'cli_silent_1',
      botOpenId: 'ou_bot_silent',
      messageId: 'om_in_silent_1',
      chatId: 'oc_silent_chat',
      chatType: 'group',
      msgType: 'text',
      senderOpenId: 'ou_user_2',
      senderType: 'user',
      text: '收到好的+1',
      rawContent: '{"text":"收到好的+1"}',
      mentions: [],
      imageKeys: [],
      createTimeMs: Date.now(),
    }

    const turnPromise = manager.inbound.handleInbound('bot-silent', fakeTransport, msg)
    await turnEntered

    // Agent calls `lark-bridge silence --reason "常规确认语"` via HTTP API.
    const silenceRes = await dispatchLarkApiRequest(runtime.ctx, manager, {
      method: 'POST',
      path: '/api/lark-bridge/agent/silence',
      body: { sessionId: listenerSessionId, reason: '常规确认语，无需打扰' },
      isCliAuthenticated: true,
      principalKind: 'cli',
    })
    expect(silenceRes.status).toBe(200)
    expect((silenceRes.payload as { silenced: boolean }).silenced).toBe(true)

    // Even if the model still emits explanatory prose at the end of the turn, NOTHING is sent to Feishu!
    runtime.finishCurrentTurn('好的，我已调用静默工具，本条消息不需要回复。')
    await turnPromise

    expect(sendReply).not.toHaveBeenCalled()
    const silentEvent = store.listEvents(10).find((e) => e.kind === 'silent_skip')
    expect(silentEvent?.summary).toContain('工具显式静默：常规确认语，无需打扰')
    expect(silentEvent?.traceId).toMatch(/^tr_[0-9a-f]{8}$/)

    await manager.stop()
    store.close()
  })

  it('degrades SessionTitleGuard gracefully when DSH host changes sessionTitle internals', () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const warn = vi.fn()
    const rename = vi.fn()
    let capturedListener: ((session: Session, event: SessionEvent) => void) | undefined

    const driftedCtx = {
      logger: { info: vi.fn(), warn, error: vi.fn() },
      get: (key: string) => {
        if (key === 'sessionTitle') {
          // Simulate host removing `registration.provider` while keeping public `rename`.
          return { rename }
        }
        return undefined
      },
      on: (_name: string, fn: (session: Session, event: SessionEvent) => void) => {
        capturedListener = fn
        return () => {}
      },
    } as unknown as Context

    const guard = new SessionTitleGuard(
      driftedCtx,
      store,
      new WorkspaceGrouping(driftedCtx, store),
      async () => false,
    )
    const dispose = guard.install()
    expect(warn).toHaveBeenCalledTimes(1)

    // Reactive fallback still repairs polluted titles cleanly.
    const fakeSession = {
      id: 'sess-drift-1',
      snapshotEvents: () => [
        {
          type: 'user/message',
          data: {
            content: [
              {
                type: 'text',
                text: '<system_reminder>meta</system_reminder>\n<user_message>帮我排查 SQLite 迁移日志</user_message>',
              },
            ],
          },
        },
      ],
    } as unknown as Session

    capturedListener?.(fakeSession, {
      type: 'session/title',
      data: { title: '<system_reminder>polluted' },
    } as unknown as SessionEvent)
    expect(rename).toHaveBeenCalledWith(fakeSession, '帮我排查 SQLite 迁移日志')

    dispose()
    store.close()
  })
})
