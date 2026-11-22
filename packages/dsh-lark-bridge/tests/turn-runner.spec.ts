import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { TurnFinalReplyTracker, runTurnAndCollectReply } from '../src/turn-runner.js'

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
})
