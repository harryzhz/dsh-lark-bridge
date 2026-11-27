import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  type AssistantStreamRecord,
  type ContentBlock,
  type ReasoningEffortId,
  type TokenUsage,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import {
  SESSION_FORMAT_VERSION,
  Session,
  appendPluginRecord,
  type SessionHeader,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import {
  expandWorkingDir,
  type AgentRoutingDecision,
  type InboundLarkMessage,
  type LarkBotConfig,
  type TriageVerdict,
} from '@dsh-lark/lark-core'
import type { LarkBridgeStore } from './store.js'
import { LARK_ORIGIN_RECORD_TYPE, type LarkTriageSession } from './types.js'
import type { WorkspaceGrouping } from './workspace-grouping.js'

export interface RecordTriageSessionInput {
  readonly bot: LarkBotConfig
  readonly msg: InboundLarkMessage
  readonly decision: AgentRoutingDecision
  readonly senderName?: string
  readonly chatName?: string
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: ReasoningEffortId
  readonly maxTokens?: number
  readonly temperature?: number
  readonly toolSchema: ToolSchema
  readonly systemPrompt: string
  readonly userMessage: string
  readonly userContent?: readonly ContentBlock[]
  readonly blocks: readonly ContentBlock[]
  readonly stream: readonly AssistantStreamRecord[]
  readonly usage?: TokenUsage
  readonly verdict: TriageVerdict
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly timedOut?: boolean
  readonly startedAtMs: number
  readonly finishedAtMs: number
  readonly durationMs: number
}

function tierLabel(tier: TriageVerdict['tier']): string {
  if (tier === 'lite') return '轻量'
  if (tier === 'standard') return '标准'
  if (tier === 'heavy') return '深度'
  return ''
}

function actionLabel(verdict: TriageVerdict): string {
  if (verdict.fallback) return '回退'
  if (verdict.action === 'silent') return '静默'
  if (verdict.action === 'quick_reply') return '快回'
  const tl = tierLabel(verdict.tier)
  return tl ? `转交·${tl}` : '转交'
}

function conclusionActionTag(verdict: TriageVerdict): string {
  if (verdict.fallback) return `\`${verdict.action}\`（回退直通）`
  if (verdict.action === 'silent') return '`silent`（静默跳过）'
  if (verdict.action === 'quick_reply') return '`quick_reply`（轻回复）'
  const tl = tierLabel(verdict.tier)
  return tl ? `\`handoff\`（转交 · ${tl}档 \`${verdict.tier}\`）` : '`handoff`（转交主运行时）'
}

export function formatTriageConclusion(verdict: TriageVerdict, errorMessage?: string): string {
  const lines = [conclusionActionTag(verdict)]
  const reason = verdict.reason.trim()
  if (reason) {
    lines.push('', `原因：${reason}`)
  }
  const replyText = verdict.replyText?.trim()
  if (replyText) {
    lines.push(`回复：${replyText}`)
  }
  const error = errorMessage?.trim()
  if (error) {
    lines.push(`异常：${error}`)
  }
  return lines.join('\n')
}

function formatTriageToolOutput(verdict: TriageVerdict, errorMessage?: string): string {
  const tl = tierLabel(verdict.tier)
  const tierSuffix = tl ? ` · 难度档位：${tl} (${verdict.tier})` : ''
  const lines = [
    `裁决：${verdict.action}${verdict.fallback ? '（回退直通）' : ''}${tierSuffix}`,
    `原因：${verdict.reason}`,
  ]
  if (verdict.replyText) {
    lines.push(`快回内容：${verdict.replyText}`)
  }
  if (errorMessage) {
    lines.push(`异常信息：${errorMessage}`)
  }
  return lines.join('\n')
}

function buildTriageTitle(verdict: TriageVerdict, chatLabel: string): string {
  const suffix = chatLabel.trim()
  return suffix ? `分流 · ${actionLabel(verdict)} · ${suffix}` : `分流 · ${actionLabel(verdict)}`
}

/**
 * Persists each smart-triage LLM invocation as a standard DSH v4 Session directly
 * via `ctx.sessionPersistence` (zero Agent boot overhead), attaches it to the target
 * workspace, immediately archives it so it never clutters the main sidebar, and indexes
 * it in `triage_sessions` for inspection from the Lark Bridge console.
 */
export class TriageSessionRecorder {
  constructor(
    private readonly ctx: Context,
    private readonly store: LarkBridgeStore,
    private readonly workspaces: WorkspaceGrouping,
  ) {}

  async record(input: RecordTriageSessionInput): Promise<string | undefined> {
    const persistence = this.ctx.get('sessionPersistence' as never) as
      | SessionPersistence
      | undefined
    if (!persistence || typeof persistence.create !== 'function') {
      return undefined
    }

    const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
    const resolvedCwd = expandWorkingDir(input.decision.workingDir) || input.decision.workingDir
    const chatLabel = input.chatName || input.msg.chatId

    try {
      const session = this.buildSessionLog(sessionId, resolvedCwd, chatLabel, input)
      const handle = await persistence.create(session.header)
      try {
        await handle.append(session.snapshotEvents())
        await handle.flush()
      } finally {
        await handle.close().catch(() => {})
      }

      await this.workspaces.attachSession(resolvedCwd, input.decision.workspaceName, sessionId)
      await this.workspaces.archiveSession(sessionId)

      const entry: LarkTriageSession = {
        sessionId,
        botId: input.bot.id,
        botName: input.bot.name,
        chatId: input.msg.chatId,
        ...(input.chatName ? { chatName: input.chatName } : {}),
        workspaceName: input.decision.workspaceName,
        workingDir: resolvedCwd,
        routeKey: input.decision.routeKey,
        trigger: input.decision.trigger,
        ...(input.decision.listenerName ? { listenerName: input.decision.listenerName } : {}),
        ...(input.senderName ? { senderName: input.senderName } : {}),
        action: input.verdict.action,
        ...(input.verdict.fallback ? { fallback: true } : {}),
        reason: input.verdict.reason,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
        ...(input.verdict.replyText ? { replyText: input.verdict.replyText } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
        durationMs: input.durationMs,
        createdAtMs: input.startedAtMs,
        lastActivityMs: input.finishedAtMs,
      }
      this.store.upsertTriageSession?.(entry)
      return sessionId
    } catch (err) {
      this.ctx.logger.warn(
        `[lark-bridge] failed to persist triage session for bot "${input.bot.id}": ${err instanceof Error ? err.message : String(err)}`,
      )
      return undefined
    }
  }

  private buildSessionLog(
    sessionId: SessionId,
    cwd: string,
    chatLabel: string,
    input: RecordTriageSessionInput,
  ): Session {
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: Math.max(0, Math.floor(input.startedAtMs)),
      cwd,
      isSeeded: false,
      delegationDepth: 0,
    }
    const session = Session.create(sessionId, undefined, header)

    appendPluginRecord(session, LARK_ORIGIN_RECORD_TYPE, {
      botId: input.bot.id,
      botName: input.bot.name,
      larkAppId: input.bot.larkAppId,
      chatType: input.msg.chatType === 'p2p' ? 'p2p' : 'group',
      chatId: input.msg.chatId,
      ...(input.chatName ? { chatName: input.chatName } : {}),
      ...(input.msg.senderUnionId || input.msg.senderOpenId
        ? { userOpenId: input.msg.senderUnionId || input.msg.senderOpenId }
        : {}),
      ...(input.senderName ? { userName: input.senderName } : {}),
      workspaceName: input.decision.workspaceName,
      routeKey: input.decision.routeKey,
      trigger: 'triage',
      ...(input.decision.listenerName ? { listenerName: input.decision.listenerName } : {}),
    })

    ;(session as unknown as { append: (type: string, data: unknown) => void }).append(
      'session/title',
      {
        title: buildTriageTitle(input.verdict, chatLabel),
        messageSeqs: [],
        source: { kind: 'user' },
      },
    )

    if (input.provider && input.model) {
      session.append('model/selection', {
        provider: input.provider,
        model: input.model,
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      })
    }

    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append(
      'system/message',
      { turn: 1, step: 1, message: createSystemMessage(input.systemPrompt) },
      { surfaceOp: 'append' },
    )
    session.append(
      'user/message',
      createUserMessage({
        content:
          input.userContent && input.userContent.length > 0
            ? [...input.userContent]
            : [{ type: 'text', text: input.userMessage }],
        source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    )

    if (input.provider && input.model) {
      session.append('request/header', {
        reason: 'initial',
        header: {
          config: {
            provider: input.provider,
            model: input.model,
            ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
            ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
            ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          },
          tools: [input.toolSchema],
        },
      })
    }

    this.appendAssistantAndToolEvents(session, input)

    session.append('step/end', { turn: 1, step: 1 })
    this.appendConclusionStep(session, input)
    session.append('turn/end', {
      turn: 1,
      reason: input.errorMessage
        ? {
            kind: 'error',
            error: {
              code: input.timedOut ? 'TIMEOUT' : 'UNKNOWN',
              message: input.errorMessage,
            },
          }
        : { kind: 'completed' },
    })
    return session
  }

  private appendConclusionStep(session: Session, input: RecordTriageSessionInput): void {
    const provider = input.provider || 'unknown'
    const model = input.model || 'unknown'
    const conclusionText = formatTriageConclusion(input.verdict, input.errorMessage)
    session.append('step/start', { turn: 1, step: 2 })
    session.append(
      'assistant/message',
      {
        turn: 1,
        step: 2,
        message: createAssistantMessage({
          content: [{ type: 'text', text: conclusionText }],
          source: { provider, model },
        }),
        stream: [],
      },
      { surfaceOp: 'append' },
    )
    session.append('step/end', { turn: 1, step: 2 })
  }

  private appendAssistantAndToolEvents(session: Session, input: RecordTriageSessionInput): void {
    const provider = input.provider || 'unknown'
    const model = input.model || 'unknown'

    if (input.blocks.length > 0) {
      const assistantMessage = createAssistantMessage({
        content: [...input.blocks],
        source: { provider, model },
      })
      session.append(
        'assistant/message',
        {
          turn: 1,
          step: 1,
          message: assistantMessage,
          ...(input.usage ? { usage: input.usage } : {}),
          stream: [...input.stream],
        },
        { surfaceOp: 'append' },
      )

      const toolResultText = formatTriageToolOutput(input.verdict, input.errorMessage)
      for (const block of input.blocks) {
        if (block.type !== 'tool-call') continue
        session.append('tool/call', {
          turn: 1,
          step: 1,
          callId: block.id,
          name: block.name,
          arguments: block.arguments,
        })
        session.append(
          'tool/result',
          {
            turn: 1,
            step: 1,
            message: createToolResultMessage({
              callId: block.id,
              content: [{ type: 'text', text: toolResultText }],
              isError: Boolean(input.errorMessage),
            }),
            ...(input.errorMessage
              ? { error: { name: 'TriageError', code: 'TRIAGE_FALLBACK', reason: input.errorMessage } }
              : {}),
          },
          { surfaceOp: 'append' },
        )
      }
      return
    }

    if (input.stream.length > 0) {
      session.append('assistant/attempt', {
        turn: 1,
        step: 1,
        stream: [...input.stream],
      })
    }
  }
}
