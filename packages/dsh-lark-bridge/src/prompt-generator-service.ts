import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  buildPromptGenerationMessages,
  expandWorkingDir,
  parseGeneratedListenerOutput,
  parseGeneratedRoleOutput,
  type GeneratedListenerDraft,
  type GeneratedRoleDraft,
  type PromptGenerationContext,
  type PromptGenerationKind,
} from '@dsh-lark/lark-core'
import type { RuntimeCatalog } from './runtime-catalog.js'
import {
  buildRuntimeConcurrencyKey,
  type ConcurrencyLease,
  type RuntimeConcurrencyLimiter,
} from './runtime-concurrency.js'
import type { LarkBridgeStore } from './store.js'
import { runTurnAndCollectReply } from './turn-runner.js'
import type { WorkspaceGrouping } from './workspace-grouping.js'

const MODEL_GENERATION_TIMEOUT_MS = 45_000
const RUNTIME_GENERATION_TIMEOUT_MS = 90_000
const MAX_DESCRIPTION_CHARS = 4_000

export type PromptGenerationTarget =
  | { readonly kind: 'auto' }
  | {
      readonly kind: 'model'
      readonly provider?: string
      readonly model?: string
    }
  | {
      readonly kind: 'runtime'
      readonly agentPreset: string
      readonly runtimeProfileId?: string
      readonly model?: string
      readonly reasoningEffort?: string
    }

export interface GeneratePromptInput {
  readonly kind: PromptGenerationKind
  readonly description: string
  readonly target?: PromptGenerationTarget
  readonly botId?: string
  readonly chatId?: string
  readonly context?: PromptGenerationContext
  readonly signal?: AbortSignal
}

export interface GeneratedPromptEngineInfo {
  readonly kind: 'model' | 'runtime'
  readonly label: string
  readonly provider?: string
  readonly model?: string
  readonly agentPreset?: string
  readonly runtimeProfileId?: string
}

export type GeneratePromptOutput =
  | {
      readonly kind: 'role'
      readonly role: GeneratedRoleDraft
      readonly engine: GeneratedPromptEngineInfo
      readonly durationMs: number
    }
  | {
      readonly kind: 'listener'
      readonly listener: GeneratedListenerDraft
      readonly engine: GeneratedPromptEngineInfo
      readonly durationMs: number
    }

export interface PromptGeneratorHost {
  readonly ctx: Context
  readonly store: LarkBridgeStore
  readonly runtimes: RuntimeCatalog
  readonly workspaces: WorkspaceGrouping
  readonly runtimeLimiter?: RuntimeConcurrencyLimiter
  readonly shutdownSignal?: AbortSignal
}

function linkAbortSignals(
  signals: readonly (AbortSignal | undefined)[],
  timeoutMs: number,
): { readonly signal: AbortSignal; readonly isTimedOut: () => boolean; readonly cleanup: () => void } {
  const controller = new AbortController()
  let timedOut = false
  const listeners: Array<{ readonly sig: AbortSignal; readonly fn: () => void }> = []

  for (const sig of signals) {
    if (!sig) continue
    if (sig.aborted) {
      controller.abort()
      break
    }
    const fn = () => controller.abort()
    sig.addEventListener('abort', fn, { once: true })
    listeners.push({ sig, fn })
  }

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  timer.unref?.()

  return {
    signal: controller.signal,
    isTimedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer)
      for (const { sig, fn } of listeners) {
        sig.removeEventListener('abort', fn)
      }
    },
  }
}

export class PromptGeneratorService {
  constructor(private readonly host: PromptGeneratorHost) {}

  async generate(input: GeneratePromptInput): Promise<GeneratePromptOutput> {
    const description = input.description.trim()
    if (!description) {
      throw new Error('请先输入简短的需求描述')
    }
    if (description.length > MAX_DESCRIPTION_CHARS) {
      throw new Error(`描述过长，请控制在 ${MAX_DESCRIPTION_CHARS} 字以内`)
    }

    const startedAtMs = Date.now()
    const bot = input.botId?.trim() ? this.host.store.getBot(input.botId.trim()) : undefined
    const group =
      bot && input.chatId?.trim() ? this.host.store.getGroup(bot.id, input.chatId.trim()) : undefined

    const mergedContext: PromptGenerationContext = {
      ...(bot?.name ? { botName: bot.name } : {}),
      ...(bot?.description ? { botDescription: bot.description } : {}),
      ...(group?.chatName ? { chatName: group.chatName } : {}),
      ...(input.context ?? {}),
    }

    const messages = buildPromptGenerationMessages({
      kind: input.kind,
      description,
      context: mergedContext,
    })

    const target = input.target ?? { kind: 'auto' as const }
    const execution = await this.executeGeneration({
      target,
      system: messages.system,
      user: messages.user,
      workingDir: this.resolveSafeWorkingDir(bot?.defaultWorkingDir, group?.workingDir),
      ...(bot ? { bot } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    })

    const durationMs = Date.now() - startedAtMs
    if (input.kind === 'role') {
      const role = parseGeneratedRoleOutput(execution.text)
      return {
        kind: 'role',
        role,
        engine: execution.engine,
        durationMs,
      }
    }
    const listener = parseGeneratedListenerOutput(execution.text)
    return {
      kind: 'listener',
      listener,
      engine: execution.engine,
      durationMs,
    }
  }

  private resolveSafeWorkingDir(botDir?: string, groupDir?: string): string {
    for (const raw of [groupDir, botDir]) {
      const expanded = raw?.trim() ? expandWorkingDir(raw) : ''
      if (expanded && existsSync(expanded)) return expanded
    }
    return homedir()
  }

  private async executeGeneration(params: {
    readonly target: PromptGenerationTarget
    readonly system: string
    readonly user: string
    readonly workingDir: string
    readonly bot?: ReturnType<LarkBridgeStore['getBot']>
    readonly signal?: AbortSignal
  }): Promise<{ readonly text: string; readonly engine: GeneratedPromptEngineInfo }> {
    if (params.target.kind === 'model') {
      return this.runViaNativeModel({
        ...(params.target.provider ? { provider: params.target.provider } : {}),
        ...(params.target.model ? { model: params.target.model } : {}),
        system: params.system,
        user: params.user,
        ...(params.signal ? { signal: params.signal } : {}),
      })
    }

    if (params.target.kind === 'runtime') {
      return this.runViaAgentRuntime({
        agentPreset: params.target.agentPreset,
        ...(params.target.runtimeProfileId
          ? { runtimeProfileId: params.target.runtimeProfileId }
          : {}),
        ...(params.target.model ? { model: params.target.model } : {}),
        ...(params.target.reasoningEffort ? { reasoningEffort: params.target.reasoningEffort } : {}),
        workingDir: params.workingDir,
        system: params.system,
        user: params.user,
        ...(params.signal ? { signal: params.signal } : {}),
      })
    }

    // Auto mode: prefer configured fast native model; fall back to bot/host Agent runtime.
    const routerProvider = params.bot?.router?.provider?.trim() || undefined
    const routerModel = params.bot?.router?.model?.trim() || undefined
    const nativeTarget = await this.host.runtimes
      .resolveNativeLlmTarget({
        ...(routerProvider ? { provider: routerProvider } : {}),
        ...(routerModel ? { model: routerModel } : {}),
      })
      .catch(() => undefined)
    if (nativeTarget && typeof this.host.ctx.llm?.stream === 'function') {
      return this.runViaNativeModel({
        provider: nativeTarget.provider,
        model: nativeTarget.model,
        system: params.system,
        user: params.user,
        ...(params.signal ? { signal: params.signal } : {}),
      })
    }

    const fallbackPreset =
      params.bot?.agentPreset?.trim() ||
      (await this.host.runtimes.list().catch(() => [])).find((r) => !r.broken)?.id ||
      'standard'
    return this.runViaAgentRuntime({
      agentPreset: fallbackPreset,
      ...(params.bot?.runtimeProfileId ? { runtimeProfileId: params.bot.runtimeProfileId } : {}),
      ...(params.bot?.model ? { model: params.bot.model } : {}),
      ...(params.bot?.reasoningEffort ? { reasoningEffort: params.bot.reasoningEffort } : {}),
      workingDir: params.workingDir,
      system: params.system,
      user: params.user,
      ...(params.signal ? { signal: params.signal } : {}),
    })
  }

  private async runViaNativeModel(params: {
    readonly provider?: string
    readonly model?: string
    readonly system: string
    readonly user: string
    readonly signal?: AbortSignal
  }): Promise<{ readonly text: string; readonly engine: GeneratedPromptEngineInfo }> {
    if (!this.host.ctx.llm || typeof this.host.ctx.llm.stream !== 'function') {
      throw new Error('当前宿主未启用原生模型接口，请改选 Agent 运行时生成')
    }
    const target = await this.host.runtimes
      .resolveNativeLlmTarget({
        ...(params.provider ? { provider: params.provider } : {}),
        ...(params.model ? { model: params.model } : {}),
      })
      .catch(() => undefined)
    if (!target) {
      throw new Error('未找到可用的配置模型，请先在 DSH「设置 → 模型」配置模型或改选 Agent 运行时')
    }

    const { effort, reasoningActive, displayName } = await this.resolveNativeModelMeta(
      target.provider,
      target.model,
    )
    const abort = linkAbortSignals([params.signal, this.host.shutdownSignal], MODEL_GENERATION_TIMEOUT_MS)

    const textChunks: string[] = []
    const blockTexts: string[] = []
    try {
      const stream = this.host.ctx.llm.stream({
        provider: target.provider,
        model: target.model,
        ...(effort ? { reasoningEffort: effort } : {}),
        system: params.system,
        messages: [{ role: 'user', content: [{ type: 'text', text: params.user }] }],
        maxTokens: reasoningActive ? 4096 : 2048,
        ...(reasoningActive ? {} : { temperature: 0.3 }),
        signal: abort.signal,
      })

      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') {
          textChunks.push(chunk.text)
        } else if (chunk.type === 'block-end' && chunk.block.type === 'text' && chunk.block.text) {
          blockTexts.push(chunk.block.text)
        } else if (chunk.type === 'finish') {
          if (chunk.reason.kind === 'error') {
            throw new Error(chunk.reason.failure.message || '模型调用失败')
          }
          if (chunk.reason.kind === 'aborted') {
            throw new Error(abort.isTimedOut() ? '模型生成超时，请重试或切换其他模型' : '已取消生成')
          }
        }
      }
    } catch (err) {
      if (abort.isTimedOut()) {
        throw new Error('模型生成超时，请重试或切换其他模型')
      }
      if (params.signal?.aborted) {
        throw new Error('已取消生成')
      }
      throw err instanceof Error ? err : new Error(String(err))
    } finally {
      abort.cleanup()
    }

    const text = (textChunks.join('') || blockTexts.join('')).trim()
    if (!text) {
      throw new Error('模型未返回有效内容，请重试')
    }

    return {
      text,
      engine: {
        kind: 'model',
        label: displayName || target.model,
        provider: target.provider,
        model: target.model,
      },
    }
  }

  private async runViaAgentRuntime(params: {
    readonly agentPreset: string
    readonly runtimeProfileId?: string
    readonly model?: string
    readonly reasoningEffort?: string
    readonly workingDir: string
    readonly system: string
    readonly user: string
    readonly signal?: AbortSignal
  }): Promise<{ readonly text: string; readonly engine: GeneratedPromptEngineInfo }> {
    const presetId = params.agentPreset.trim()
    if (!presetId) {
      throw new Error('请选择要使用的 Agent 运行时')
    }
    if (!this.host.ctx.agents || typeof this.host.ctx.agents.create !== 'function') {
      throw new Error('当前宿主未启用 Agent 运行时能力')
    }

    const launch = await this.host.runtimes.resolveAgentLaunch({
      agentPreset: presetId,
      ...(params.runtimeProfileId ? { runtimeProfileId: params.runtimeProfileId } : {}),
      ...(params.model ? { explicitModel: params.model } : {}),
      ...(params.reasoningEffort ? { explicitReasoningEffort: params.reasoningEffort } : {}),
      requireNativeModel: true,
    })

    const abort = linkAbortSignals([params.signal, this.host.shutdownSignal], RUNTIME_GENERATION_TIMEOUT_MS)
    const concurrencyKey =
      typeof this.host.runtimes.resolveConcurrencyKey === 'function'
        ? this.host.runtimes.resolveConcurrencyKey(presetId, params.runtimeProfileId)
        : buildRuntimeConcurrencyKey(presetId, params.runtimeProfileId)

    const sid = brandString<SessionId>(`session-${randomUUID()}`)
    const combinedPrompt = [
      '<system_reminder>',
      params.system,
      '</system_reminder>',
      '',
      params.user,
    ].join('\n')

    let lease: ConcurrencyLease | undefined
    let handle: Awaited<ReturnType<Context['agents']['create']>> | undefined
    try {
      if (this.host.runtimeLimiter) {
        lease = await this.host.runtimeLimiter.acquire({
          runtimeKey: concurrencyKey,
          priority: 'interactive',
          signal: abort.signal,
        })
        if (!lease) {
          throw new Error(abort.isTimedOut() ? '等待 Agent 运行时空闲超时' : '已取消生成')
        }
      }

      handle = await this.host.ctx.agents.create({
        sessionId: sid,
        meta: { cwd: params.workingDir, agentPreset: presetId },
        agentOptions: {
          ...(launch.provider ? { provider: launch.provider } : {}),
          ...(launch.model ? { model: launch.model } : {}),
          ...(launch.reasoningEffort ? { reasoningEffort: launch.reasoningEffort } : {}),
        },
        setup: async (agentCtx, agent) => {
          await launch.mountPreset(agentCtx, agent)
        },
      })

      const reply = await runTurnAndCollectReply(
        this.host.ctx,
        handle.agent,
        [{ type: 'text', text: combinedPrompt }],
        { signal: abort.signal },
      )
      const text = reply.trim()
      if (!text) {
        throw new Error('Agent 运行时未返回有效内容，请重试')
      }

      const runtimes = await this.host.runtimes.list().catch(() => [])
      const runtimeName = runtimes.find((r) => r.id === presetId)?.name || presetId
      const modelLabel = launch.model || params.model || ''
      const label = modelLabel ? `${runtimeName} · ${modelLabel}` : runtimeName

      return {
        text,
        engine: {
          kind: 'runtime',
          label,
          agentPreset: presetId,
          ...(params.runtimeProfileId ? { runtimeProfileId: params.runtimeProfileId } : {}),
          ...(launch.model ? { model: launch.model } : {}),
        },
      }
    } catch (err) {
      if (abort.isTimedOut()) {
        throw new Error('Agent 运行时生成超时，请重试或改选更快的模型')
      }
      if (params.signal?.aborted) {
        throw new Error('已取消生成')
      }
      throw err instanceof Error ? err : new Error(String(err))
    } finally {
      abort.cleanup()
      lease?.release()
      if (handle) {
        await handle.dispose().catch(() => {})
        await this.host.workspaces.archiveSession(sid).catch(() => {})
      }
    }
  }

  private async resolveNativeModelMeta(
    provider: string,
    model: string,
  ): Promise<{
    readonly effort?: ReasoningEffortId
    readonly reasoningActive: boolean
    readonly displayName?: string
  }> {
    if (typeof this.host.ctx.llm?.resolveModelInfo !== 'function') {
      return { reasoningActive: false }
    }
    try {
      const info = await this.host.ctx.llm.resolveModelInfo(provider, model)
      const displayName = info?.name?.trim() || undefined
      const efforts = info?.reasoning?.efforts
      if (!efforts || efforts.length === 0) {
        return { reasoningActive: false, ...(displayName ? { displayName } : {}) }
      }
      const least = efforts[0]?.id
      if (!least) {
        return { reasoningActive: false, ...(displayName ? { displayName } : {}) }
      }
      const normalized = String(least).trim().toLowerCase()
      const reasoningActive = normalized !== 'off' && normalized !== 'none'
      return {
        effort: least,
        reasoningActive,
        ...(displayName ? { displayName } : {}),
      }
    } catch {
      return { reasoningActive: false }
    }
  }
}
