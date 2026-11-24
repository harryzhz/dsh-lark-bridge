import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { TurnFinalReplyTracker } from './turn-runner.js'
import type { LarkPendingTurn } from './types.js'

/** Maximum downtime / inactivity gap eligible for automatic post-restart recovery (15 minutes). */
export const MAX_AUTO_RESUME_AGE_MS = 15 * 60_000

/** Absolute maximum age of a single pending turn eligible for automatic recovery (6 hours). */
export const MAX_AUTO_RESUME_TOTAL_AGE_MS = 6 * 60 * 60_000

/** Maximum automatic recovery attempts after an ungraceful crash to prevent poison-pill restart loops. */
export const MAX_AUTO_RESUME_ATTEMPTS = 1

/** Maximum automatic recovery attempts across planned graceful shutdowns / reloads. */
export const MAX_GRACEFUL_AUTO_RESUME_ATTEMPTS = 3

const READ_PAGE_SIZE = 200
const MAX_INSPECT_EVENTS = 2000
const MAX_PERSISTENCE_SCAN_EVENTS = 50_000

export type PersistedTurnInspection =
  | {
      readonly state: 'completed'
      readonly replyText: string
      readonly silencedByTool: boolean
      readonly turn: number
    }
  | { readonly state: 'incomplete' }
  | { readonly state: 'unavailable' }

function extractUserMessageText(event: SessionEvent): string {
  if (event.type !== 'user/message') return ''
  const data = event.data as { content?: readonly ContentBlock[]; message?: { content?: readonly ContentBlock[] } }
  const blocks = data.content ?? data.message?.content ?? []
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

function isSilenceCliToolCall(event: SessionEvent): boolean {
  if (event.type !== 'tool/call') return false
  const data = event.data as { name?: unknown; arguments?: unknown }
  const args = typeof data.arguments === 'string' ? data.arguments : ''
  return /\blark-bridge\s+silence\b/.test(args)
}

async function loadSessionEventsForRecovery(
  ctx: Context,
  sessionId: string,
): Promise<readonly SessionEvent[] | undefined> {
  const sid = brandString<SessionId>(sessionId)
  const sessionsSvc = ctx.sessions as { get?: (id: SessionId) => Session | undefined } | undefined
  const live = sessionsSvc?.get?.(sid)
  if (live && typeof live.snapshotEvents === 'function') {
    const snap = live.snapshotEvents()
    if (snap.length > 0) return snap.slice(-MAX_INSPECT_EVENTS)
  }

  const persistence = ctx.get?.('sessionPersistence' as never) as SessionPersistence | undefined
  if (!persistence || typeof persistence.open !== 'function') return undefined

  try {
    const handle = await persistence.open(sid, 'read')
    try {
      const tailEvents: SessionEvent[] = []
      let offset = 0
      let scanned = 0
      while (scanned < MAX_PERSISTENCE_SCAN_EVENTS) {
        const res = await handle.read(offset, READ_PAGE_SIZE)
        if (!res.events || res.events.length === 0) break
        tailEvents.push(...res.events)
        if (tailEvents.length > MAX_INSPECT_EVENTS) {
          tailEvents.splice(0, tailEvents.length - MAX_INSPECT_EVENTS)
        }
        offset += res.events.length
        scanned += res.events.length
        if (res.events.length < READ_PAGE_SIZE) break
      }
      return tailEvents
    } finally {
      await handle.close().catch(() => {})
    }
  } catch {
    return undefined
  }
}

/**
 * Inspects a persisted DSH session to determine whether the turn corresponding to
 * `messageId` already completed cleanly before shutdown/crash (e.g. process stopped
 * right before Feishu delivery). Matches strictly on `messageId` inside the turn's
 * `user/message` payload so an earlier completed turn in the same thread can never
 * be mistaken for the interrupted turn.
 */
export async function inspectPersistedTurnCompletion(
  ctx: Context,
  sessionId: string,
  messageId: string,
): Promise<PersistedTurnInspection> {
  if (!sessionId || !messageId) return { state: 'unavailable' }
  const events = await loadSessionEventsForRecovery(ctx, sessionId)
  if (!events || events.length === 0) return { state: 'unavailable' }

  // Find the latest turn whose user/message carries this exact Feishu messageId.
  let matchedTurn: number | undefined
  let matchedStartIndex = -1
  let currentTurn: number | undefined
  let currentStartIndex = -1

  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i]!
    if (ev.type === 'turn/start') {
      currentTurn = ev.data.turn
      currentStartIndex = i
    } else if (ev.type === 'user/message' && currentTurn !== undefined) {
      const text = extractUserMessageText(ev)
      if (text.includes(messageId)) {
        matchedTurn = currentTurn
        matchedStartIndex = currentStartIndex
      }
    }
  }

  if (matchedTurn === undefined || matchedStartIndex < 0) {
    return { state: 'incomplete' }
  }

  const tracker = new TurnFinalReplyTracker()
  let silencedByTool = false

  for (let i = matchedStartIndex; i < events.length; i += 1) {
    const ev = events[i]!
    if (
      (ev.type === 'assistant/message' || ev.type === 'tool/call') &&
      ev.data.turn === matchedTurn
    ) {
      if (isSilenceCliToolCall(ev)) {
        silencedByTool = true
      }
      tracker.onEvent(ev)
    } else if (ev.type === 'turn/end' && ev.data.turn === matchedTurn) {
      if (ev.data.reason.kind === 'completed') {
        return {
          state: 'completed',
          replyText: tracker.result(),
          silencedByTool,
          turn: matchedTurn,
        }
      }
      return { state: 'incomplete' }
    }
  }

  return { state: 'incomplete' }
}

export interface AutoResumeEligibilityOptions {
  /**
   * - `'shutdown'`: evaluated while the turn is actively running during a graceful stop/reload.
   *   Does not penalize long-running turns for their elapsed execution duration (`startedAtMs`),
   *   only checking payload presence, absolute safety cap, and recovery budget.
   * - `'startup'` (default): evaluated when a new process boots and inspects persisted pending turns.
   *   Measures downtime / inactivity since `interruptedAtMs ?? lastActivityAtMs ?? startedAtMs`.
   */
  readonly phase?: 'shutdown' | 'startup'
}

/**
 * Whether an active or persisted pending turn is eligible to be automatically resumed
 * across a service restart/reload.
 */
export function canAutoResumePendingTurn(
  turn: Pick<
    LarkPendingTurn,
    | 'inboundMsg'
    | 'startedAtMs'
    | 'recoveryAttempts'
    | 'gracefulRecoveryAttempts'
    | 'interruptedAtMs'
    | 'lastActivityAtMs'
    | 'interruptKind'
  >,
  nowMs = Date.now(),
  options: AutoResumeEligibilityOptions = {},
): boolean {
  if (!turn.inboundMsg) return false
  if (nowMs - turn.startedAtMs > MAX_AUTO_RESUME_TOTAL_AGE_MS) return false

  const phase = options.phase ?? 'startup'
  const crashAttempts = turn.recoveryAttempts ?? 0
  if (crashAttempts >= MAX_AUTO_RESUME_ATTEMPTS) return false

  const isGraceful = phase === 'shutdown' || turn.interruptKind === 'graceful_shutdown'
  if (isGraceful) {
    const gracefulAttempts = turn.gracefulRecoveryAttempts ?? 0
    if (gracefulAttempts >= MAX_GRACEFUL_AUTO_RESUME_ATTEMPTS) return false
  }

  if (phase === 'shutdown') {
    return true
  }

  const downtimeAnchorMs = turn.interruptedAtMs ?? turn.lastActivityAtMs ?? turn.startedAtMs
  if (nowMs - downtimeAnchorMs > MAX_AUTO_RESUME_AGE_MS) return false
  return true
}

/**
 * Reminder injected when continuing an interrupted turn inside an existing resumed session.
 * Guides the Agent to inspect prior partial tool progress and avoid duplicate side effects.
 */
export function composeRestartRecoveryReminder(input: {
  readonly attempt: number
  readonly intermediateSentCount: number
}): string {
  const intermediateNote =
    input.intermediateSentCount > 0
      ? `（中断前已向飞书发送过 ${input.intermediateSentCount} 条过程消息，请勿重复播报相同进展）`
      : ''
  return [
    `<restart_recovery attempt="${input.attempt}" intermediate_sent="${input.intermediateSentCount}">`,
    `上一轮处理因桥接服务重启而中断，现已自动恢复会话继续处理${intermediateNote}。请先核对本会话前文已完成的工具调用与产物，避免重复执行有副作用的操作（如重复发消息、重复写文件或重复提交），直接从中断处接着完成用户原始请求并输出最终回复（无需向用户提及重启恢复细节）。`,
    '</restart_recovery>',
  ].join('\n')
}
