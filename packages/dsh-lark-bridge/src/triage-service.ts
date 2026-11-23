import type { Context } from '@deepseek-ai/cordis'
import type { ReasoningEffortId, ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  ROUTE_MESSAGE_TOOL_SCHEMA,
  buildTriageSystemPrompt,
  buildTriageUserMessage,
  parseTriageVerdict,
  type AgentRoutingDecision,
  type EffectiveRouterConfig,
  type InboundLarkMessage,
  type LarkBotConfig,
  type LarkGroupConfig,
  type RouterHandoffTurn,
  type TriageHistoryEntry,
  type TriageVerdict,
} from '@dsh-lark/lark-core'
import type { RuntimeCatalog } from './runtime-catalog.js'

const CONTEXT_TTL_MS = 30 * 60_000
const MAX_SCOPE_ENTRIES = 200
const MAX_MESSAGES_PER_SCOPE = 8
const MAX_EPHEMERAL_TURNS = 6
const MAX_WORKER_EXCERPT_CHARS = 400

interface ScopedHistoryBucket {
  readonly entries: TriageHistoryEntry[]
  updatedAtMs: number
}

interface WorkerReplySummary {
  readonly excerpt: string
  readonly updatedAtMs: number
}

export interface EphemeralRouterThread {
  readonly primaryRouteKey: string
  readonly aliasRouteKeys: string[]
  readonly trigger: AgentRoutingDecision['trigger']
  readonly turns: RouterHandoffTurn[]
  updatedAtMs: number
}

export interface EvaluateTriageInput {
  readonly bot: LarkBotConfig
  readonly group?: LarkGroupConfig
  readonly msg: InboundLarkMessage
  readonly decision: AgentRoutingDecision
  readonly routerConfig: EffectiveRouterConfig
  readonly senderName?: string
  readonly resolvedChatName?: string
  readonly hasActiveWorker: boolean
  readonly workerBusy: boolean
  readonly traceId: string
  readonly signal?: AbortSignal
}

export interface TriageEvaluationResult {
  readonly verdict: TriageVerdict
  readonly provider?: string
  readonly model?: string
  readonly durationMs: number
}

/**
 * Bounded in-memory sliding context and ephemeral Router quick-reply thread store.
 * Keeps zero disk overhead while providing enough recent context for accurate triage
 * and lossless handoff when a quick-reply thread escalates to a Worker.
 */
export class TriageContextStore {
  private readonly recentByScope = new Map<string, ScopedHistoryBucket>()
  private readonly workerSummaryByRoute = new Map<string, WorkerReplySummary>()
  private readonly ephemeralThreads = new Map<string, EphemeralRouterThread>()
  private readonly ephemeralAliases = new Map<string, string>()

  resolveEphemeralPrimary(routeKey: string, now = Date.now()): string | undefined {
    const primaryKey = this.ephemeralAliases.get(routeKey) ?? routeKey
    const thread = this.ephemeralThreads.get(primaryKey)
    if (!thread) return undefined
    if (now - thread.updatedAtMs > CONTEXT_TTL_MS) {
      this.deleteEphemeralThread(primaryKey)
      return undefined
    }
    return primaryKey
  }

  hasEphemeralThread(routeKey: string, now = Date.now()): boolean {
    return this.resolveEphemeralPrimary(routeKey, now) !== undefined
  }

  getEphemeralThreadTrigger(routeKey: string, now = Date.now()): string | undefined {
    const primary = this.resolveEphemeralPrimary(routeKey, now)
    return primary ? this.ephemeralThreads.get(primary)?.trigger : undefined
  }

  recordEphemeralQuickReply(input: {
    readonly routeKey: string
    readonly aliasRouteKeys?: readonly string[]
    readonly trigger: AgentRoutingDecision['trigger']
    readonly senderName?: string
    readonly userText: string
    readonly routerReply: string
    readonly nowMs?: number
  }): void {
    const now = input.nowMs ?? Date.now()
    this.pruneExpired(now)
    const primaryKey = this.resolveEphemeralPrimary(input.routeKey, now) ?? input.routeKey
    let thread = this.ephemeralThreads.get(primaryKey)
    if (!thread) {
      thread = {
        primaryRouteKey: primaryKey,
        aliasRouteKeys: [],
        trigger: input.trigger,
        turns: [],
        updatedAtMs: now,
      }
      this.ephemeralThreads.set(primaryKey, thread)
    }

    thread.turns.push({
      ...(input.senderName ? { senderName: input.senderName } : {}),
      userText: input.userText,
      routerReply: input.routerReply,
      timestampMs: now,
    })
    if (thread.turns.length > MAX_EPHEMERAL_TURNS) {
      thread.turns.splice(0, thread.turns.length - MAX_EPHEMERAL_TURNS)
    }
    thread.updatedAtMs = now

    for (const alias of input.aliasRouteKeys ?? []) {
      if (!alias || alias === primaryKey) continue
      if (!thread.aliasRouteKeys.includes(alias)) {
        thread.aliasRouteKeys.push(alias)
      }
      this.ephemeralAliases.set(alias, primaryKey)
    }
    this.appendHistory(primaryKey, { role: 'router', text: input.routerReply, timestampMs: now }, now)
    this.enforceBounds()
  }

  consumeEphemeralHandoff(
    routeKey: string,
    now = Date.now(),
  ): { readonly turns: readonly RouterHandoffTurn[]; readonly aliasRouteKeys: readonly string[] } | undefined {
    const primary = this.resolveEphemeralPrimary(routeKey, now)
    if (!primary) return undefined
    const thread = this.ephemeralThreads.get(primary)
    if (!thread) return undefined
    const result = {
      turns: [...thread.turns],
      aliasRouteKeys: [primary, ...thread.aliasRouteKeys].filter((k) => k !== routeKey),
    }
    this.deleteEphemeralThread(primary)
    return result
  }

  recordInboundMessage(
    chatScopeKey: string,
    routeKey: string,
    entry: TriageHistoryEntry,
    now = entry.timestampMs,
  ): void {
    const targetRouteKey = this.resolveEphemeralPrimary(routeKey, now) ?? routeKey
    this.appendHistory(targetRouteKey, entry, now)
    if (chatScopeKey !== targetRouteKey) {
      this.appendHistory(chatScopeKey, entry, now)
    }
    this.enforceBounds()
  }

  recordWorkerReply(routeKey: string, replyText: string, now = Date.now()): void {
    const trimmed = replyText.trim()
    if (!trimmed) return
    const excerpt =
      trimmed.length > MAX_WORKER_EXCERPT_CHARS
        ? `…${trimmed.slice(trimmed.length - MAX_WORKER_EXCERPT_CHARS)}`
        : trimmed
    this.workerSummaryByRoute.set(routeKey, { excerpt, updatedAtMs: now })
    this.appendHistory(routeKey, { role: 'worker', text: excerpt, timestampMs: now }, now)
    this.enforceBounds()
  }

  getRecentMessages(routeKey: string, chatScopeKey: string, now = Date.now()): readonly TriageHistoryEntry[] {
    const resolvedRoute = this.resolveEphemeralPrimary(routeKey, now) ?? routeKey
    const routeBucket = this.recentByScope.get(resolvedRoute)
    if (routeBucket && now - routeBucket.updatedAtMs <= CONTEXT_TTL_MS && routeBucket.entries.length > 0) {
      return [...routeBucket.entries]
    }
    const chatBucket = this.recentByScope.get(chatScopeKey)
    if (chatBucket && now - chatBucket.updatedAtMs <= CONTEXT_TTL_MS && chatBucket.entries.length > 0) {
      return [...chatBucket.entries]
    }
    return []
  }

  getLastWorkerReplyExcerpt(routeKey: string, now = Date.now()): string | undefined {
    const summary = this.workerSummaryByRoute.get(routeKey)
    if (!summary) return undefined
    if (now - summary.updatedAtMs > CONTEXT_TTL_MS) {
      this.workerSummaryByRoute.delete(routeKey)
      return undefined
    }
    return summary.excerpt
  }

  clearRoute(routeKey: string): void {
    const primary = this.ephemeralAliases.get(routeKey) ?? routeKey
    this.deleteEphemeralThread(primary)
    this.workerSummaryByRoute.delete(routeKey)
    this.recentByScope.delete(routeKey)
  }

  private appendHistory(scopeKey: string, entry: TriageHistoryEntry, now: number): void {
    let bucket = this.recentByScope.get(scopeKey)
    if (!bucket || now - bucket.updatedAtMs > CONTEXT_TTL_MS) {
      bucket = { entries: [], updatedAtMs: now }
      this.recentByScope.set(scopeKey, bucket)
    }
    bucket.entries.push(entry)
    if (bucket.entries.length > MAX_MESSAGES_PER_SCOPE) {
      bucket.entries.splice(0, bucket.entries.length - MAX_MESSAGES_PER_SCOPE)
    }
    bucket.updatedAtMs = now
  }

  private deleteEphemeralThread(primaryKey: string): void {
    const existing = this.ephemeralThreads.get(primaryKey)
    if (!existing) return
    this.ephemeralThreads.delete(primaryKey)
    for (const alias of existing.aliasRouteKeys) {
      if (this.ephemeralAliases.get(alias) === primaryKey) {
        this.ephemeralAliases.delete(alias)
      }
    }
  }

  private pruneExpired(now: number): void {
    for (const [key, bucket] of this.recentByScope) {
      if (now - bucket.updatedAtMs > CONTEXT_TTL_MS) this.recentByScope.delete(key)
    }
    for (const [key, summary] of this.workerSummaryByRoute) {
      if (now - summary.updatedAtMs > CONTEXT_TTL_MS) this.workerSummaryByRoute.delete(key)
    }
    for (const [key, thread] of this.ephemeralThreads) {
      if (now - thread.updatedAtMs > CONTEXT_TTL_MS) this.deleteEphemeralThread(key)
    }
  }

  private enforceBounds(): void {
    while (this.recentByScope.size > MAX_SCOPE_ENTRIES) {
      const oldest = this.recentByScope.keys().next().value
      if (!oldest) break
      this.recentByScope.delete(oldest)
    }
    while (this.workerSummaryByRoute.size > MAX_SCOPE_ENTRIES) {
      const oldest = this.workerSummaryByRoute.keys().next().value
      if (!oldest) break
      this.workerSummaryByRoute.delete(oldest)
    }
    while (this.ephemeralThreads.size > MAX_SCOPE_ENTRIES) {
      const oldest = this.ephemeralThreads.keys().next().value
      if (!oldest) break
      this.deleteEphemeralThread(oldest)
    }
  }
}

/**
 * Stateless, concurrent, Fail-Open fast triage gate backed by DSH native `ctx.llm.stream()`.
 * Never creates DSH sessions, never attaches workspaces, and never blocks on Worker queues.
 */
export class LlmTriageService {
  readonly context = new TriageContextStore()

  constructor(
    private readonly ctx: Context,
    private readonly runtimes: RuntimeCatalog,
  ) {}

  async evaluate(input: EvaluateTriageInput): Promise<TriageEvaluationResult> {
    const startedAtMs = Date.now()
    const failOpen = (
      reason: string,
      resolved?: { readonly provider?: string; readonly model?: string },
    ): TriageEvaluationResult => ({
      verdict: { action: 'handoff', reason, fallback: true },
      ...(resolved?.provider ? { provider: resolved.provider } : {}),
      ...(resolved?.model ? { model: resolved.model } : {}),
      durationMs: Date.now() - startedAtMs,
    })

    if (!this.ctx.llm || typeof this.ctx.llm.stream !== 'function') {
      return failOpen('宿主原生 LLM 接口不可用，自动直通主运行时')
    }

    const target = await this.runtimes
      .resolveNativeLlmTarget({
        provider: input.routerConfig.provider,
        model: input.routerConfig.model,
      })
      .catch(() => undefined)
    if (!target) {
      return failOpen('未配置可用的原生分流模型，自动直通主运行时')
    }

    const reasoningPlan = await this.resolveTriageReasoningPlan(target.provider, target.model)
    const chatScopeKey = `chat:${input.bot.id}:${input.msg.chatId}`
    const recentMessages = this.context.getRecentMessages(input.decision.routeKey, chatScopeKey)
    const lastWorkerReplyExcerpt = input.hasActiveWorker
      ? this.context.getLastWorkerReplyExcerpt(input.decision.routeKey)
      : undefined

    const roleName =
      input.group?.role?.mode === 'override'
        ? input.group.role.name.trim()
        : input.group?.role?.name?.trim() || (input.bot.role.enabled ? input.bot.role.name.trim() : '')
    const roleSummary =
      input.group?.role?.mode === 'override'
        ? input.group.role.systemPrompt.trim()
        : input.bot.role.enabled
          ? input.bot.role.systemPrompt.trim()
          : ''

    const system = buildTriageSystemPrompt({
      botName: input.bot.name,
      ...(roleName ? { botRoleName: roleName } : {}),
      ...(roleSummary ? { botRoleSummary: roleSummary } : {}),
      hasActiveWorker: input.hasActiveWorker,
      trigger: input.decision.trigger,
      ...(input.decision.trigger === 'listener' && input.group?.listener?.prompt
        ? { listenerPrompt: input.group.listener.prompt }
        : {}),
      ...(input.routerConfig.customPrompt ? { customPrompt: input.routerConfig.customPrompt } : {}),
    })

    const userText = buildTriageUserMessage({
      botName: input.bot.name,
      ...(roleName ? { botRoleName: roleName } : {}),
      ...(roleSummary ? { botRoleSummary: roleSummary } : {}),
      ...(input.resolvedChatName ? { chatName: input.resolvedChatName } : {}),
      trigger: input.decision.trigger,
      ...(input.decision.listenerName ? { listenerName: input.decision.listenerName } : {}),
      ...(input.senderName ? { senderName: input.senderName } : {}),
      senderType: input.msg.senderType,
      userText: input.decision.userText,
      hasActiveWorker: input.hasActiveWorker,
      workerBusy: input.workerBusy,
      ...(lastWorkerReplyExcerpt ? { lastWorkerReplyExcerpt } : {}),
      recentMessages,
    })

    const controller = new AbortController()
    let timedOut = false
    const onParentAbort = () => controller.abort()
    if (input.signal) {
      if (input.signal.aborted) {
        return failOpen('服务正在关闭，跳过分流', target)
      }
      input.signal.addEventListener('abort', onParentAbort, { once: true })
    }
    const timeoutTimer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, input.routerConfig.timeoutMs)
    timeoutTimer.unref?.()

    try {
      const toolSchema: ToolSchema = {
        name: ROUTE_MESSAGE_TOOL_SCHEMA.name,
        description: ROUTE_MESSAGE_TOOL_SCHEMA.description,
        parameters: ROUTE_MESSAGE_TOOL_SCHEMA.parameters,
      }
      const stream = this.ctx.llm.stream({
        provider: target.provider,
        model: target.model,
        ...(reasoningPlan.effort ? { reasoningEffort: reasoningPlan.effort } : {}),
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
        tools: [toolSchema],
        maxTokens: reasoningPlan.reasoningActive ? 1024 : 256,
        ...(reasoningPlan.reasoningActive ? {} : { temperature: 0.1 }),
        signal: controller.signal,
      })

      const textChunks: string[] = []
      const blockTexts: string[] = []
      const finalizedToolCalls: Array<{ name: string; arguments: string }> = []
      const pendingToolCalls = new Map<number, { name: string; arguments: string }>()

      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') {
          textChunks.push(chunk.text)
        } else if (chunk.type === 'tool-call-delta') {
          const entry = pendingToolCalls.get(chunk.index) ?? { name: '', arguments: '' }
          if (chunk.name) entry.name = chunk.name
          if (chunk.argumentsDelta) entry.arguments += chunk.argumentsDelta
          pendingToolCalls.set(chunk.index, entry)
        } else if (chunk.type === 'block-end') {
          if (chunk.block.type === 'tool-call') {
            finalizedToolCalls.push({
              name: chunk.block.name,
              arguments: chunk.block.arguments,
            })
            pendingToolCalls.delete(chunk.index)
          } else if (chunk.block.type === 'text' && chunk.block.text) {
            blockTexts.push(chunk.block.text)
          }
        } else if (chunk.type === 'finish') {
          if (chunk.reason.kind === 'error') {
            throw new Error(chunk.reason.failure.message || 'triage llm error')
          }
          if (chunk.reason.kind === 'aborted') {
            throw new Error(timedOut ? 'triage timeout' : 'triage aborted')
          }
        }
      }

      for (const leftover of pendingToolCalls.values()) {
        if (leftover.name) finalizedToolCalls.push(leftover)
      }

      const assembledText = textChunks.join('') || blockTexts.join('')
      const verdict = parseTriageVerdict({
        toolCalls: finalizedToolCalls,
        text: assembledText,
        hasActiveWorker: input.hasActiveWorker,
      })
      return {
        verdict,
        provider: target.provider,
        model: target.model,
        durationMs: Date.now() - startedAtMs,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.ctx.logger.warn(
        `[lark-bridge][trace=${input.traceId}][bot=${input.bot.id}] triage fail-open (${target.provider}/${target.model}): ${msg}`,
      )
      return failOpen(
        timedOut ? '分流超时，自动直通主运行时' : '分流异常，自动直通主运行时',
        target,
      )
    } finally {
      clearTimeout(timeoutTimer)
      input.signal?.removeEventListener('abort', onParentAbort)
    }
  }

  private async resolveTriageReasoningPlan(
    provider: string,
    model: string,
  ): Promise<{ readonly effort?: ReasoningEffortId; readonly reasoningActive: boolean }> {
    if (typeof this.ctx.llm?.resolveModelInfo !== 'function') {
      return { reasoningActive: false }
    }
    try {
      const info = await this.ctx.llm.resolveModelInfo(provider, model)
      const efforts = info?.reasoning?.efforts
      if (!efforts || efforts.length === 0) return { reasoningActive: false }
      const least = efforts[0]?.id
      if (!least) return { reasoningActive: false }
      const normalized = String(least).trim().toLowerCase()
      const reasoningActive = normalized !== 'off' && normalized !== 'none'
      return { effort: least, reasoningActive }
    } catch {
      return { reasoningActive: false }
    }
  }
}
