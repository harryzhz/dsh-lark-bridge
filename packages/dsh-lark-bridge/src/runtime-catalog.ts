import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/**
 * Consumer-side contract of the optional `externalRuntimes` service published by
 * `dsh-external-agents`. Declared here (not imported) so the bridge
 * depends only on the shape it reads, never on any external runtime implementation.
 */
export interface ExternalRuntimeSummary {
  readonly id: string
  readonly displayName: string
  readonly description: string
  readonly providerId: string
  readonly defaultModel: string
  readonly defaultReasoningEffort?: string
}

export interface ExternalModelMeta {
  readonly id: string
  readonly name: string
  readonly reasoningEfforts?: readonly string[]
  readonly defaultEffort?: string
  readonly isDefault?: boolean
}

interface ExternalRuntimeDirectory {
  list(): readonly ExternalRuntimeSummary[]
  get(id: string): ExternalRuntimeSummary | undefined
  listModelsForProvider?(providerId: string): Promise<readonly ExternalModelMeta[] | undefined>
}

interface AgentPresetRow {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly isDefault: boolean
  readonly broken?: string
}

interface AgentPresetRosterSource {
  remoteExportList(): Promise<{ readonly presets: readonly AgentPresetRow[] }>
  mount?(agentCtx: Context, presetId?: string): Promise<unknown>
}

interface AgentDefaultModelSource {
  currentSelection?(): {
    readonly provider?: string
    readonly model?: string
    readonly reasoningEffort?: string
  }
}

export interface AgentLaunchInput {
  readonly agentPreset: string
  readonly explicitProvider?: string
  readonly explicitModel?: string
  readonly explicitReasoningEffort?: string
  readonly requireNativeModel?: boolean
}

export interface ResolvedAgentLaunch {
  readonly isExternal: boolean
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: ReasoningEffortId
  mountPreset(agentCtx: Context | undefined): Promise<void>
}

/** One selectable agent runtime as the configuration UI presents it. */
export interface RuntimeOption {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly kind: 'external' | 'native'
  readonly group: 'builtin' | 'custom'
  readonly providerId?: string
  readonly defaultModel?: string
  readonly supportsReasoningEffort: boolean
  readonly isDefault: boolean
  readonly broken?: string
}

/**
 * Mirrors `@deepseek-ai/dsh-client-ui-agent-preset` Simplified Chinese copy
 * so shipped DSH presets present identical names and descriptions everywhere.
 */
const BUILTIN_DSH_PRESETS: Readonly<Record<string, { readonly name: string; readonly description: string }>> = {
  standard: {
    name: '标准模式',
    description: '处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。',
  },
  ptc: {
    name: 'PTC 模式',
    description: '包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。',
  },
  minimal: {
    name: '极简模式',
    description: 'Agent 使用终端和图片读取工具，并支持上下文压缩，适合测试和对比其基础表现。',
  },
  cordis: {
    name: '创造模式',
    description: '用对话定制 DSH：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。',
  },
}

const BUILTIN_ORDER: Readonly<Record<string, number>> = {
  standard: 0,
  ptc: 1,
  minimal: 2,
  cordis: 3,
}

/**
 * Read-only view joining DSH's agent preset roster with the external runtime
 * directory, so the bridge never hard-codes which engines exist.
 */
export class RuntimeCatalog {
  constructor(private readonly ctx: Context) {}

  /** Provider id that owns a preset's model catalog; undefined for native presets. */
  providerFor(presetId: string): string | undefined {
    return this.directory()?.get(presetId)?.providerId
  }

  /**
   * Resolve `provider`, `model`, `reasoningEffort`, and preset-plugin mounting for
   * both external runtimes (`dsh-external-agents`) and built-in DSH native presets
   * (`standard`, `ptc`, `minimal`, `cordis`). Mirrors `@deepseek-ai/dsh-api-session-controller`
   * so native `AgentLoop` always receives valid `AgentOptions` and preset tools.
   */
  async resolveAgentLaunch(input: AgentLaunchInput): Promise<ResolvedAgentLaunch> {
    const presetId = input.agentPreset.trim()
    const explicitProvider = input.explicitProvider?.trim() || undefined
    const explicitModel = input.explicitModel?.trim() || undefined
    const explicitEffort = input.explicitReasoningEffort?.trim() || undefined

    const ext = this.directory()?.get(presetId)
    const isExternal = Boolean(ext)

    const mountPreset = async (agentCtx: Context | undefined): Promise<void> => {
      if (!agentCtx) return
      if (typeof (agentCtx as { on?: unknown }).on === 'function') {
        installModelSelection(agentCtx)
      }
      if (!presetId) return
      const presets = this.ctx.get('agentPresets' as never) as AgentPresetRosterSource | undefined
      if (typeof presets?.mount !== 'function') return
      if (isExternal) {
        try {
          await presets.mount(agentCtx, presetId)
        } catch {
          // External runtimes supply their own tools; ignore missing preset-registry rows.
        }
        return
      }
      await presets.mount(agentCtx, presetId)
    }

    if (ext) {
      return {
        isExternal: true,
        provider: ext.providerId,
        ...(explicitModel ? { model: explicitModel } : {}),
        ...(explicitEffort ? { reasoningEffort: brandString<ReasoningEffortId>(explicitEffort) } : {}),
        mountPreset,
      }
    }

    const externalProviders = new Set((this.directory()?.list() ?? []).map((r) => r.providerId))
    const isExternalProvider = (id: string | undefined): boolean =>
      !id || externalProviders.has(id) || id.endsWith('-cli')

    const defaultSel = this.readAgentDefaultSelection()
    const nativeDefault =
      defaultSel?.provider && defaultSel?.model && !isExternalProvider(defaultSel.provider)
        ? {
            provider: defaultSel.provider,
            model: defaultSel.model,
            ...(defaultSel.reasoningEffort ? { reasoningEffort: defaultSel.reasoningEffort } : {}),
          }
        : undefined

    let provider: string | undefined
    let model: string | undefined

    if (explicitModel) {
      model = explicitModel
      if (explicitProvider && !isExternalProvider(explicitProvider)) {
        provider = explicitProvider
      } else {
        provider = await this.findNativeProviderForModel(
          explicitModel,
          nativeDefault?.provider,
          externalProviders,
        )
      }
    } else if (nativeDefault) {
      provider =
        explicitProvider && !isExternalProvider(explicitProvider)
          ? explicitProvider
          : nativeDefault.provider
      model = nativeDefault.model
    } else {
      const firstNative = await this.findFirstNativeModel(externalProviders, explicitProvider)
      provider =
        firstNative?.provider ??
        (explicitProvider && !isExternalProvider(explicitProvider) ? explicitProvider : undefined)
      model = firstNative?.model
    }

    if (input.requireNativeModel && this.ctx.llm && (!provider || !model)) {
      throw new Error(
        `内置运行时 "${presetId || 'standard'}" 缺少可用的原生模型配置（provider/model）：请先在 DSH「设置 → 模型」中配置原生模型服务商并设置默认模型，或在本智能体配置中指定可用模型。`,
      )
    }

    const effortRaw =
      explicitEffort ||
      (model && nativeDefault?.model === model ? nativeDefault.reasoningEffort : undefined)

    return {
      isExternal: false,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(effortRaw ? { reasoningEffort: brandString<ReasoningEffortId>(effortRaw) } : {}),
      mountPreset,
    }
  }

  private readAgentDefaultSelection():
    | { readonly provider?: string; readonly model?: string; readonly reasoningEffort?: string }
    | undefined {
    const svc = this.ctx.get('agentDefaultModel' as never) as AgentDefaultModelSource | undefined
    if (typeof svc?.currentSelection !== 'function') return undefined
    try {
      const sel = svc.currentSelection()
      const provider = sel?.provider?.trim() || undefined
      const model = sel?.model?.trim() || undefined
      const reasoningEffort = sel?.reasoningEffort?.trim() || undefined
      return {
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      }
    } catch {
      return undefined
    }
  }

  private listNativeProviderIds(externalProviders: ReadonlySet<string>): string[] {
    if (typeof this.ctx.llm?.listProviders !== 'function') return []
    try {
      return this.ctx.llm
        .listProviders()
        .map((p) => p.id)
        .filter((id) => Boolean(id) && !externalProviders.has(id) && !id.endsWith('-cli'))
    } catch {
      return []
    }
  }

  private async listProviderModelsSafe(providerId: string): Promise<readonly { readonly id: string }[]> {
    if (typeof this.ctx.llm?.listModels !== 'function') return []
    try {
      return await this.ctx.llm.listModels(providerId)
    } catch {
      return []
    }
  }

  private async findNativeProviderForModel(
    modelId: string,
    preferredProvider: string | undefined,
    externalProviders: ReadonlySet<string>,
  ): Promise<string | undefined> {
    const nativeProviders = this.listNativeProviderIds(externalProviders)
    const ordered = preferredProvider
      ? [preferredProvider, ...nativeProviders.filter((id) => id !== preferredProvider)]
      : nativeProviders

    for (const candidate of ordered) {
      const models = await this.listProviderModelsSafe(candidate)
      if (models.some((m) => m.id === modelId)) return candidate
    }
    return preferredProvider ?? nativeProviders[0]
  }

  private async findFirstNativeModel(
    externalProviders: ReadonlySet<string>,
    preferredProvider?: string,
  ): Promise<{ readonly provider: string; readonly model: string } | undefined> {
    const nativeProviders = this.listNativeProviderIds(externalProviders)
    const ordered =
      preferredProvider && !externalProviders.has(preferredProvider)
        ? [preferredProvider, ...nativeProviders.filter((id) => id !== preferredProvider)]
        : nativeProviders

    for (const candidate of ordered) {
      const models = await this.listProviderModelsSafe(candidate)
      if (models.length > 0 && models[0]?.id) {
        return { provider: candidate, model: models[0].id }
      }
    }
    return undefined
  }

  /** Rich per-model metadata (including exact per-model `reasoningEfforts` & `defaultEffort`) for an external provider. */
  async modelsForProvider(providerId: string): Promise<readonly ExternalModelMeta[] | undefined> {
    return await this.directory()?.listModelsForProvider?.(providerId)
  }

  /** Effective default model id for a preset, reconciling static config against the live provider catalog. */
  async resolveDefaultModel(presetId: string, fallbackDefault?: string): Promise<string> {
    const ext = this.directory()?.get(presetId)
    const configured = fallbackDefault ?? ext?.defaultModel ?? ''
    const providerId = ext?.providerId
    if (!providerId) return configured
    const catalog = await this.modelsForProvider(providerId).catch(() => undefined)
    if (!catalog || catalog.length === 0) return configured
    if (configured && catalog.some((m) => m.id === configured)) return configured
    return catalog.find((m) => m.isDefault)?.id ?? catalog[0]?.id ?? configured
  }

  async list(): Promise<RuntimeOption[]> {
    const external = new Map((this.directory()?.list() ?? []).map((r) => [r.id, r]))
    const roster = await this.roster()
    const options: RuntimeOption[] = roster.map((row) => {
      const ext = external.get(row.id)
      const builtinMeta =
        !ext && row.name === undefined ? BUILTIN_DSH_PRESETS[row.id] : undefined
      return {
        id: row.id,
        name: row.name ?? ext?.displayName ?? builtinMeta?.name ?? row.id,
        description: row.description ?? ext?.description ?? builtinMeta?.description ?? '',
        kind: ext ? 'external' : 'native',
        group: builtinMeta ? 'builtin' : 'custom',
        ...(ext ? { providerId: ext.providerId, defaultModel: ext.defaultModel } : {}),
        supportsReasoningEffort: true,
        isDefault: row.isDefault,
        ...(row.broken ? { broken: row.broken } : {}),
      }
    })
    for (const ext of external.values()) {
      if (options.some((o) => o.id === ext.id)) continue
      options.push({
        id: ext.id,
        name: ext.displayName,
        description: ext.description,
        kind: 'external',
        group: 'custom',
        providerId: ext.providerId,
        defaultModel: ext.defaultModel,
        supportsReasoningEffort: true,
        isDefault: false,
      })
    }

    const customItems = options.filter((o) => o.group === 'custom')
    const builtinItems = options
      .filter((o) => o.group === 'builtin')
      .sort((a, b) => (BUILTIN_ORDER[a.id] ?? 99) - (BUILTIN_ORDER[b.id] ?? 99))
    return [...customItems, ...builtinItems]
  }

  private directory(): ExternalRuntimeDirectory | undefined {
    return this.ctx.get('externalRuntimes' as never) as ExternalRuntimeDirectory | undefined
  }

  private async roster(): Promise<readonly AgentPresetRow[]> {
    const presets = this.ctx.get('agentPresets' as never) as AgentPresetRosterSource | undefined
    if (!presets) return []
    try {
      return (await presets.remoteExportList()).presets
    } catch (err) {
      this.ctx.logger.warn(
        `[lark-bridge] agent preset roster unavailable: ${err instanceof Error ? err.message : String(err)}`,
      )
      return []
    }
  }
}
