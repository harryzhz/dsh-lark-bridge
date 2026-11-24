import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import {
  TurnAbortedError,
  TurnFinalReplyTracker,
  runTurnAndCollectReply,
} from '../src/turn-runner.js'

describe('TurnFinalReplyTracker & runTurnAndCollectReply', () => {
  it('ignores intermediate progress commentary before/with tool calls and returns only the final response', () => {
    const tracker = new TurnFinalReplyTracker()

    // Step 1: commentary + tool call advertisement
    tracker.onEvent({
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: 'reasoning', text: 'planning...' },
            { type: 'text', text: '我会先读取仓库规范，再重新查询全部开启 MR。' },
            { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
          ],
        },
      },
    } as unknown as SessionEvent)
    tracker.onEvent({
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' },
    } as unknown as SessionEvent)

    // Step 2: more commentary + tool call
    tracker.onEvent({
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 2,
        message: {
          content: [
            { type: 'text', text: '已核对到 5 个开启 MR，接下来核对旧 MR 是否已被后续变更覆盖。' },
            { type: 'tool-call', id: 'c2', name: 'bash', arguments: '{}' },
          ],
        },
      },
    } as unknown as SessionEvent)
    tracker.onEvent({
      type: 'tool/call',
      data: { turn: 1, step: 2, callId: 'c2', name: 'bash', arguments: '{}' },
    } as unknown as SessionEvent)

    // Step 3: final answer (no tool call)
    tracker.onEvent({
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 3,
        message: {
          content: [
            { type: 'reasoning', text: 'ready to report' },
            { type: 'text', text: '**巡检时间：2026-11-21**\n\n共 5 个开启 MR。' },
          ],
        },
      },
    } as unknown as SessionEvent)

    expect(tracker.result()).toBe('**巡检时间：2026-11-21**\n\n共 5 个开启 MR。')
  })

  it('picks only the last text block when commentary and final_answer appear in the same step', () => {
    const tracker = new TurnFinalReplyTracker()

    tracker.onEvent({
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: 'text', text: '我先整理一下最终结论。' },
            { type: 'reasoning', text: 'double checking...' },
            { type: 'text', text: '最终结论：所有服务健康。' },
          ],
        },
      },
    } as unknown as SessionEvent)

    expect(tracker.result()).toBe('最终结论：所有服务健康。')
  })

  it('preserves empty result for silent-skip turns even if pre-tool commentary was emitted earlier', () => {
    const tracker = new TurnFinalReplyTracker()

    tracker.onEvent({
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: 'text', text: '先检查群上下文。' },
            { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
          ],
        },
      },
    } as unknown as SessionEvent)
    tracker.onEvent({
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' },
    } as unknown as SessionEvent)

    // Final step decides silent skip (reasoning only / empty text)
    tracker.onEvent({
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 2,
        message: {
          content: [{ type: 'reasoning', text: '无需回复，返回空文本' }],
        },
      },
    } as unknown as SessionEvent)

    expect(tracker.result()).toBe('')
  })

  it('runTurnAndCollectReply resolves with only the terminal response of the turn', async () => {
    const handlers: Array<(s: Session, ev: SessionEvent) => void> = []
    const session = { id: 'session-turn-test' } as unknown as Session
    const ctx = {
      on(_event: string, fn: (s: Session, ev: SessionEvent) => void) {
        handlers.push(fn)
        return () => {}
      },
    } as unknown as Context

    const emit = (ev: Record<string, unknown>) => {
      for (const h of handlers) h(session, ev as unknown as SessionEvent)
    }

    const agent = {
      session,
      followup() {
        emit({ type: 'turn/start', data: { turn: 2 } })
        emit({
          type: 'assistant/message',
          data: {
            turn: 2,
            step: 1,
            message: {
              content: [
                { type: 'text', text: '正在执行命令排查…' },
                { type: 'tool-call', id: 'tc1', name: 'bash', arguments: '{}' },
              ],
            },
          },
        })
        emit({ type: 'tool/call', data: { turn: 2, step: 1, callId: 'tc1', name: 'bash', arguments: '{}' } })
        emit({
          type: 'assistant/message',
          data: {
            turn: 2,
            step: 2,
            message: {
              content: [{ type: 'text', text: '排查完毕：一切正常。' }],
            },
          },
        })
        emit({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
      },
    } as unknown as Agent

    const reply = await runTurnAndCollectReply(ctx, agent, [{ type: 'text', text: '检查状态' }])
    expect(reply).toBe('排查完毕：一切正常。')
  })

  it('dispatches intermediate messages immediately upon step commit without concatenating into final reply', async () => {
    const handlers: Array<(s: Session, ev: SessionEvent) => void> = []
    const session = { id: 'session-stream-progress' } as unknown as Session
    const ctx = {
      on(_event: string, fn: (s: Session, ev: SessionEvent) => void) {
        handlers.push(fn)
        return () => {}
      },
    } as unknown as Context

    const emit = (ev: Record<string, unknown>) => {
      for (const h of handlers) h(session, ev as unknown as SessionEvent)
    }

    const timeline: string[] = []
    let finishTurn!: () => void

    const agent = {
      session,
      followup() {
        emit({ type: 'turn/start', data: { turn: 5 } })
        emit({
          type: 'assistant/message',
          data: {
            turn: 5,
            step: 1,
            message: {
              content: [
                { type: 'text', text: '第 1 步：读取仓库规范。' },
                { type: 'tool-call', id: 'tc1', name: 'bash', arguments: '{}' },
              ],
            },
          },
        })
        emit({ type: 'tool/call', data: { turn: 5, step: 1, callId: 'tc1', name: 'bash', arguments: '{}' } })

        finishTurn = () => {
          emit({
            type: 'assistant/message',
            data: {
              turn: 5,
              step: 2,
              message: {
                content: [
                  { type: 'text', text: '第 2 步：核对 CI 结果。' },
                  { type: 'tool-call', id: 'tc2', name: 'bash', arguments: '{}' },
                ],
              },
            },
          })
          emit({ type: 'tool/call', data: { turn: 5, step: 2, callId: 'tc2', name: 'bash', arguments: '{}' } })
          emit({
            type: 'assistant/message',
            data: {
              turn: 5,
              step: 3,
              message: {
                content: [{ type: 'text', text: '最终结论：共 2 个待审 MR。' }],
              },
            },
          })
          emit({ type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
        }
      },
    } as unknown as Agent

    const replyPromise = runTurnAndCollectReply(
      ctx,
      agent,
      [{ type: 'text', text: '巡检 MR' }],
      {
        onIntermediate: async (stepText) => {
          timeline.push(`intermediate:${stepText}`)
        },
      },
    )

    // Before turn/end is even emitted, Step 1 intermediate message MUST already be dispatched!
    await Promise.resolve()
    expect(timeline).toEqual(['intermediate:第 1 步：读取仓库规范。'])

    finishTurn()
    const finalReply = await replyPromise
    timeline.push(`final:${finalReply}`)

    expect(timeline).toEqual([
      'intermediate:第 1 步：读取仓库规范。',
      'intermediate:第 2 步：核对 CI 结果。',
      'final:最终结论：共 2 个待审 MR。',
    ])
  })

  it('rejects immediately with TurnAbortedError when Cordis fiber disposes in LIFO order before turn/end arrives', async () => {
    const disposables: Array<() => void> = []
    const handlers: Array<(s: Session, ev: SessionEvent) => void> = []
    const session = { id: 'session-hmr-dispose' } as unknown as Session

    const ctx = {
      on(_event: string, fn: (s: Session, ev: SessionEvent) => void) {
        handlers.push(fn)
        const off = () => {
          const idx = handlers.indexOf(fn)
          if (idx >= 0) handlers.splice(idx, 1)
        }
        disposables.push(off)
        return off
      },
      effect(execute: () => () => void) {
        const cleanup = execute()
        let active = true
        const off = () => {
          if (!active) return
          active = false
          cleanup()
        }
        disposables.push(off)
        return off
      },
    } as unknown as Context

    const agent = {
      session,
      followup() {
        for (const h of handlers) h(session, { type: 'turn/start', data: { turn: 4 } } as unknown as SessionEvent)
      },
    } as unknown as Agent

    const promise = runTurnAndCollectReply(ctx, agent, [{ type: 'text', text: '继续排查' }])

    // Simulate Cordis LIFO disposal during HMR: later-registered effects dispose before manager.stop() emits turn/end.
    for (const dispose of disposables.splice(0).reverse()) {
      dispose()
    }

    await expect(promise).rejects.toSatisfy(
      (err: unknown) => err instanceof TurnAbortedError && err.kind === 'disposed',
    )
    expect(handlers).toHaveLength(0)
  })

  it('rejects with TurnAbortedError when AbortSignal triggers and when turn/end reports aborted or interrupted', async () => {
    const handlers: Array<(s: Session, ev: SessionEvent) => void> = []
    const session = { id: 'session-abort-cases' } as unknown as Session
    const ctx = {
      on(_event: string, fn: (s: Session, ev: SessionEvent) => void) {
        handlers.push(fn)
        return () => {
          const idx = handlers.indexOf(fn)
          if (idx >= 0) handlers.splice(idx, 1)
        }
      },
    } as unknown as Context

    const emit = (ev: Record<string, unknown>) => {
      for (const h of [...handlers]) h(session, ev as unknown as SessionEvent)
    }

    // 1. Signal abort while in-flight
    const ac = new AbortController()
    const hangingAgent = {
      session,
      followup() {
        emit({ type: 'turn/start', data: { turn: 1 } })
      },
    } as unknown as Agent
    const signalPromise = runTurnAndCollectReply(ctx, hangingAgent, [{ type: 'text', text: 'A' }], {
      signal: ac.signal,
    })
    ac.abort()
    await expect(signalPromise).rejects.toSatisfy(
      (err: unknown) => err instanceof TurnAbortedError && err.kind === 'disposed',
    )
    expect(handlers).toHaveLength(0)

    // 2. turn/end aborted by user
    const userStopAgent = {
      session,
      followup() {
        emit({ type: 'turn/start', data: { turn: 2 } })
        emit({ type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
      },
    } as unknown as Agent
    await expect(
      runTurnAndCollectReply(ctx, userStopAgent, [{ type: 'text', text: 'B' }]),
    ).rejects.toSatisfy((err: unknown) => err instanceof TurnAbortedError && err.kind === 'user')

    // 3. turn/end interrupted
    const interruptedAgent = {
      session,
      followup() {
        emit({ type: 'turn/start', data: { turn: 3 } })
        emit({ type: 'turn/end', data: { turn: 3, reason: { kind: 'interrupted' } } })
      },
    } as unknown as Agent
    await expect(
      runTurnAndCollectReply(ctx, interruptedAgent, [{ type: 'text', text: 'C' }]),
    ).rejects.toSatisfy((err: unknown) => err instanceof TurnAbortedError && err.kind === 'interrupted')

    // 4. turn/end aborted by hook preserves custom hook reason
    const hookAgent = {
      session,
      followup() {
        emit({ type: 'turn/start', data: { turn: 4 } })
        emit({
          type: 'turn/end',
          data: { turn: 4, reason: { kind: 'aborted', reason: { kind: 'hook', reason: '策略拦截' } } },
        })
      },
    } as unknown as Agent
    await expect(
      runTurnAndCollectReply(ctx, hookAgent, [{ type: 'text', text: 'D' }]),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof TurnAbortedError && err.kind === 'hook' && err.message === '策略拦截',
    )
  })

  it('resolves completed turns on a real Cordis Context without self-aborting on ctx.effect cleanup, and survives dispose during intermediate flush', async () => {
    const root = new Context()
    let pluginCtx!: Context
    let ready1!: () => void
    const fiber1Ready = new Promise<void>((resolve) => {
      ready1 = resolve
    })
    const fiber = root.plugin((ctx) => {
      pluginCtx = ctx
      ready1()
    })
    await fiber1Ready

    const session = { id: 'session-real-cordis' } as unknown as Session
    const emit = (ev: Record<string, unknown>) => {
      ;(root as unknown as { emit: (name: string, ...args: unknown[]) => void }).emit(
        'session/event',
        session,
        ev as unknown as SessionEvent,
      )
    }

    // 1. Synchronous turn/end completion on real Cordis Context (verifies offDispose does not self-reject)
    const syncAgent = {
      session,
      followup() {
        emit({ type: 'turn/start', data: { turn: 1 } })
        emit({
          type: 'assistant/message',
          data: {
            turn: 1,
            step: 1,
            message: { content: [{ type: 'text', text: '同步完成回复' }] },
          },
        })
        emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      },
    } as unknown as Agent
    const syncReply = await runTurnAndCollectReply(pluginCtx, syncAgent, [{ type: 'text', text: 'Q1' }])
    expect(syncReply).toBe('同步完成回复')
    expect(pluginCtx.fiber.getEffects()).toEqual([])

    // 2. Asynchronous turn/end completion with slow onIntermediate; dispose + AbortSignal during flush
    let releaseIntermediate!: () => void
    const intermediateGate = new Promise<void>((resolve) => {
      releaseIntermediate = resolve
    })
    const ac = new AbortController()
    let finishAsyncTurn!: () => void
    const asyncAgent = {
      session,
      followup() {
        emit({ type: 'turn/start', data: { turn: 2 } })
        emit({
          type: 'assistant/message',
          data: {
            turn: 2,
            step: 1,
            message: {
              content: [
                { type: 'text', text: '阶段进度' },
                { type: 'tool-call', id: 'tc1', name: 'bash', arguments: '{}' },
              ],
            },
          },
        })
        emit({ type: 'tool/call', data: { turn: 2, step: 1, callId: 'tc1', name: 'bash', arguments: '{}' } })
        finishAsyncTurn = () => {
          emit({
            type: 'assistant/message',
            data: {
              turn: 2,
              step: 2,
              message: { content: [{ type: 'text', text: '异步最终回复' }] },
            },
          })
          emit({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
        }
      },
    } as unknown as Agent

    const deliveredIntermediate: string[] = []
    const asyncPromise = runTurnAndCollectReply(pluginCtx, asyncAgent, [{ type: 'text', text: 'Q2' }], {
      signal: ac.signal,
      onIntermediate: async (stepText) => {
        await intermediateGate
        deliveredIntermediate.push(stepText)
      },
    })
    expect(pluginCtx.fiber.getEffects().map((e) => e.label)).toContain('dsh-lark-bridge.turn-runner')

    finishAsyncTurn()
    // Effect and event listener should already be detached on turn/end before flush finishes
    expect(pluginCtx.fiber.getEffects()).toEqual([])

    // Trigger both abort signal and real Cordis fiber disposal while intermediate flush is still pending
    ac.abort()
    await fiber.dispose()
    releaseIntermediate()

    expect(await asyncPromise).toBe('异步最终回复')
    expect(deliveredIntermediate).toEqual(['阶段进度'])

    // 3. Real Cordis fiber disposal while a turn is still running rejects with TurnAbortedError('disposed')
    let pluginCtx2!: Context
    let ready2!: () => void
    const fiber2Ready = new Promise<void>((resolve) => {
      ready2 = resolve
    })
    const fiber2 = root.plugin((ctx) => {
      pluginCtx2 = ctx
      ready2()
    })
    await fiber2Ready
    const hangingAgent = {
      session,
      followup() {
        emit({ type: 'turn/start', data: { turn: 3 } })
      },
    } as unknown as Agent
    const inFlight = runTurnAndCollectReply(pluginCtx2, hangingAgent, [{ type: 'text', text: 'Q3' }])
    await fiber2.dispose()
    await expect(inFlight).rejects.toSatisfy(
      (err: unknown) => err instanceof TurnAbortedError && err.kind === 'disposed',
    )
  })

  it('ignores zero-width/invisible text blocks in TurnFinalReplyTracker and avoids hijacking another caller turn by user/message id', async () => {
    // 1. Invisible-only text (\u200b) is never treated as final reply or intermediate message,
    //    and a trailing invisible message does not erase a real prior final text.
    const intermediates: string[] = []
    const tracker1 = new TurnFinalReplyTracker({
      onIntermediate: (t) => {
        intermediates.push(t)
      },
    })
    tracker1.onEvent({
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: '\u200b' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] },
      },
    } as unknown as SessionEvent)
    tracker1.onEvent({ type: 'tool/call', data: { turn: 1, step: 1 } } as unknown as SessionEvent)
    tracker1.onEvent({
      type: 'assistant/message',
      data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: '\u200b\u200c' }] } },
    } as unknown as SessionEvent)
    await tracker1.flush()
    expect(intermediates).toEqual([])
    expect(tracker1.result()).toBe('')

    const tracker2 = new TurnFinalReplyTracker()
    tracker2.onEvent({
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '真实有效回复' }] } },
    } as unknown as SessionEvent)
    tracker2.onEvent({
      type: 'assistant/message',
      data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: '\u200b' }] } },
    } as unknown as SessionEvent)
    expect(tracker2.result()).toBe('真实有效回复')

    // 2. runTurnAndCollectReply releases a turn whose user/message.id belongs to another caller (e.g. Web UI)
    //    and keeps waiting for its own userMessage.id turn.
    const handlers: Array<(s: Session, ev: SessionEvent) => void> = []
    const session = { id: 'session-isolation' } as unknown as Session
    const ctx = {
      on(_event: string, fn: (s: Session, ev: SessionEvent) => void) {
        handlers.push(fn)
        return () => {
          const idx = handlers.indexOf(fn)
          if (idx >= 0) handlers.splice(idx, 1)
        }
      },
    } as unknown as Context
    const emit = (ev: Record<string, unknown>) => {
      for (const h of [...handlers]) h(session, ev as unknown as SessionEvent)
    }

    const agent = {
      session,
      followup(msg: { id?: string }) {
        // First, an unrelated Web UI turn starts & finishes
        emit({ type: 'turn/start', data: { turn: 10 } })
        emit({ type: 'user/message', data: { id: 'web-ui-msg-999', source: { kind: 'user' } } })
        emit({
          type: 'assistant/message',
          data: { turn: 10, message: { content: [{ type: 'text', text: '这是 Web 端的私密回复' }] } },
        })
        emit({ type: 'turn/end', data: { turn: 10, reason: { kind: 'completed' } } })

        // Then our actual Feishu turn runs
        emit({ type: 'turn/start', data: { turn: 11 } })
        emit({ type: 'user/message', data: { id: msg.id, source: { kind: 'user' } } })
        emit({
          type: 'assistant/message',
          data: { turn: 11, message: { content: [{ type: 'text', text: '这是飞书这轮的正确回复' }] } },
        })
        emit({ type: 'turn/end', data: { turn: 11, reason: { kind: 'completed' } } })
      },
    } as unknown as Agent

    const reply = await runTurnAndCollectReply(ctx, agent, [{ type: 'text', text: '飞书提问' }])
    expect(reply).toBe('这是飞书这轮的正确回复')
  })

  it('logs a diagnostic warning when turn/end stalls for >= 3s after step/end', async () => {
    vi.useFakeTimers()
    try {
      const handlers: Array<(s: Session, ev: SessionEvent) => void> = []
      const warn = vi.fn()
      const session = { id: 'session-stall-diag' } as unknown as Session
      const ctx = {
        logger: { warn },
        on(_event: string, fn: (s: Session, ev: SessionEvent) => void) {
          handlers.push(fn)
          return () => {
            const idx = handlers.indexOf(fn)
            if (idx >= 0) handlers.splice(idx, 1)
          }
        },
      } as unknown as Context
      const emit = (ev: Record<string, unknown>) => {
        for (const h of [...handlers]) h(session, ev as unknown as SessionEvent)
      }

      const slowAgent = {
        session,
        followup(msg: { id?: string }) {
          emit({ type: 'turn/start', data: { turn: 1 } })
          emit({ type: 'user/message', data: { id: msg.id, source: { kind: 'user' } } })
          emit({
            type: 'assistant/message',
            data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '模型已回复' }] } },
          })
          emit({ type: 'step/end', data: { turn: 1, step: 1 } })
          setTimeout(() => {
            emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
          }, 18_200)
        },
      } as unknown as Agent

      const slowPromise = runTurnAndCollectReply(ctx, slowAgent, [{ type: 'text', text: 'hello' }])
      await vi.advanceTimersByTimeAsync(18_200)
      expect(await slowPromise).toBe('模型已回复')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toContain('post-step turn-stopping stall detected: 18200ms')
      expect(warn.mock.calls[0]?.[0]).toContain('workspace-changes')

      warn.mockClear()
      const fastAgent = {
        session,
        followup(msg: { id?: string }) {
          emit({ type: 'turn/start', data: { turn: 2 } })
          emit({ type: 'user/message', data: { id: msg.id, source: { kind: 'user' } } })
          emit({
            type: 'assistant/message',
            data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '秒回' }] } },
          })
          emit({ type: 'step/end', data: { turn: 2, step: 1 } })
          setTimeout(() => {
            emit({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
          }, 120)
        },
      } as unknown as Agent
      const fastPromise = runTurnAndCollectReply(ctx, fastAgent, [{ type: 'text', text: 'hi' }])
      await vi.advanceTimersByTimeAsync(120)
      expect(await fastPromise).toBe('秒回')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
