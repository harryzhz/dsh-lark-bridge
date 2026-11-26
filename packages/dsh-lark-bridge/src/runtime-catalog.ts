import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, type Session } from '@deepseek-ai/dsh-session'

/**
 * Session plugin record consumed by `dsh-external-agents` to bind a session
 * to a specific launch profile (env/configFile/cliProfile/args/authMethodId).
 */
export const EXTERNAL_LAUNCH_RECORD_TYPE = 'plugin:external-agent/launch' as const

export interface ExternalLaunchRecord {
  readonly runtimeId: string
  readonly profileId: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:external-agent/launch': {
      runtimeId: string
      profileId: string
    }
  }
}

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

export interface ExternalRuntimeAuthMethod {
  readonly id: string
  readonly name?: string
  readonly description?: string
}

export interface RuntimeProfileCapabilities {
  readonly supportsCliProfile: boolean
  readonly supportsConfigFile: boolean
  readonly configFileHint?: string
  readonly supportsEnv: boolean
  readonly envHints?: readonly string[]
  readonly supportsArgs: boolean
  readonly supportsAuthMethod: boolean
  readonly authMethods?: readonly ExternalRuntimeAuthMethod[]
  readonly supportsExposeAsPreset: boolean
}

export interface RuntimeProfileSummary {
  readonly id: string
  readonly runtimeId: string
  readonly name: string
  readonly description?: string
  readonly source: 'discovered' | 'config' | 'user'
  readonly cliProfile?: string
  readonly configFile?: string
  readonly env?: Readonly<Record<string, string>>
  readonly secretEnvKeys?: readonly string[]
  readonly args?: readonly string[]
  readonly argsMode?: 'append' | 'prepend' | 'replace'
  readonly authMethodId?: string
  readonly defaultModel?: string
  readonly defaultReasoningEffort?: string
  readonly exposeAsPreset?: boolean
  readonly presetId?: string
  readonly providerId?: string
}

export interface RuntimeProfileInput {
  readonly id?: string
  readonly runtimeId: string
  readonly name: string
  readonly description?: string
  readonly cliProfile?: string
  readonly configFile?: string
  readonly env?: Readonly<Record<string, string>>
  readonly removeEnvKeys?: readonly string[]
  readonly args?: readonly string[]
  readonly argsMode?: 'append' | 'prepend' | 'replace'
  readonly authMethodId?: string
  readonly defaultModel?: string
  readonly defaultReasoningEffort?: string
  readonly exposeAsPreset?: boolean
}

export interface ExposedExternalPresetSummary {
  readonly presetId: string
  readonly runtimeId: string
  readonly profileId: string
  readonly displayName: string
  readonly description: string
  readonly providerId: string
  readonly defaultModel: string
  readonly defaultReasoningEffort?: string
}

interface RawExposedPresetRow {
  readonly id?: string
  readonly presetId?: string
  readonly parentRuntimeId?: string
  readonly runtimeId?: string
  readonly profileId: string
  readonly displayName: string
  readonly description: string
  readonly providerId: string
  readonly defaultModel: string
  readonly defaultReasoningEffort?: string
}

interface ExternalRuntimeDirectory {
  list(): readonly ExternalRuntimeSummary[]
  get(id: string): ExternalRuntimeSummary | undefined
  listModelsForProvider?(providerId: string): Promise<readonly ExternalModelMeta[] | undefined>
  listExposedPresets?(): readonly RawExposedPresetRow[]
  getProfileCapabilities?(runtimeId: string): RuntimeProfileCapabilities | undefined
  listProfiles?(runtimeId?: string): readonly RuntimeProfileSummary[]
  upsertProfile?(
    input: RuntimeProfileInput,
  ): Promise<RuntimeProfileSummary> | RuntimeProfileSummary
  deleteProfile?(runtimeId: string, profileId: string): Promise<boolean> | boolean
  listModelsForRuntime?(
    runtimeId: string,
    profileId?: string,
    options?: { readonly force?: boolean },
  ): Promise<readonly ExternalModelMeta[] | undefined>
  probeProfileModels?(
    runtimeId: string,
    profileId?: string,
  ): Promise<readonly ExternalModelMeta[]>
  resolveSessionIdByExternalId?(externalId: string): string | undefined
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
  readonly runtimeProfileId?: string
  readonly explicitProvider?: string
  readonly explicitModel?: string
  readonly explicitReasoningEffort?: string
  readonly requireNativeModel?: boolean
}

export interface ResolvedAgentLaunch {
  readonly isExternal: boolean
  readonly runtimeProfileId?: string
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: ReasoningEffortId
  mountPreset(
    agentCtx: Context | undefined,
    agent?: { readonly session?: Session },
  ): Promise<void>
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
  readonly supportsProfiles?: boolean
  readonly profileCapabilities?: RuntimeProfileCapabilities
  readonly profiles?: readonly RuntimeProfileSummary[]
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
 * Read-only + profile-delegating view joining DSH's agent preset roster with the
 * external runtime directory, so the bridge never hard-codes which engines exist.
 */
export class RuntimeCatalog {
  constructor(private readonly ctx: Context) {}

  /** Provider id that owns a preset's model catalog; undefined for native presets. */
  providerFor(presetId: string): string | undefined {
    return this.directory()?.get(presetId)?.providerId
  }

  /** Whether a provider id belongs to an external CLI runtime rather than a native DSH LLM adapter. */
  isExternalProvider(providerId: string | undefined): boolean {
    if (!providerId) return true
    const externalProviders = new Set([
      ...(this.directory()?.list() ?? []).map((r) => r.providerId),
      ...this.listExposedPresets().map((p) => p.providerId),
    ])
    if (externalProviders.has(providerId)) return true
    const configurableProviders = this.listConfigurableProviderIds()
    if (configurableProviders.has(providerId)) return false
    return providerId.endsWith('-cli')
  }

  /**
   * Resolve a native DSH LLM `(provider, model)` pair suitable for direct stateless `ctx.llm.stream()` calls
   * (such as fast Router triage). Never returns external CLI providers.
   */
  async resolveNativeLlmTarget(input: {
    readonly provider?: string
    readonly model?: string
  } = {}): Promise<{ readonly provider: string; readonly model: string } | undefined> {
    if (!this.ctx.llm) return undefined
    const externalProviders = new Set([
      ...(this.directory()?.list() ?? []).map((r) => r.providerId),
      ...this.listExposedPresets().map((p) => p.providerId),
    ])
    const isExt = (id: string | undefined): boolean => this.isExternalProvider(id)

    const explicitProvider = input.provider?.trim() || undefined
    const explicitModel = input.model?.trim() || undefined
    const defaultSel = this.readAgentDefaultSelection()
    const nativeDefault =
      defaultSel?.provider && defaultSel?.model && !isExt(defaultSel.provider)
        ? { provider: defaultSel.provider, model: defaultSel.model }
        : undefined

    if (explicitProvider && explicitModel && !isExt(explicitProvider)) {
      const nativeIds = this.listNativeProviderIds(externalProviders)
      if (nativeIds.length === 0 || nativeIds.includes(explicitProvider)) {
        return { provider: explicitProvider, model: explicitModel }
      }
    }

    if (explicitModel) {
      const resolvedProvider = await this.findNativeProviderForModel(
        explicitModel,
        explicitProvider && !isExt(explicitProvider) ? explicitProvider : nativeDefault?.provider,
        externalProviders,
      )
      if (resolvedProvider && !isExt(resolvedProvider)) {
        return { provider: resolvedProvider, model: explicitModel }
      }
    }

    if (explicitProvider && !isExt(explicitProvider)) {
      const models = await this.listProviderModelsSafe(explicitProvider)
      if (models[0]?.id) {
        return { provider: explicitProvider, model: models[0].id }
      }
    }

    if (nativeDefault) return nativeDefault
    return await this.findFirstNativeModel(externalProviders)
  }

  /** Exposed profile presets dynamically registered by `dsh-external-agents`. */
  listExposedPresets(): readonly ExposedExternalPresetSummary[] {
    const raw = this.directory()?.listExposedPresets?.() ?? []
    const out: ExposedExternalPresetSummary[] = []
    for (const item of raw) {
      const presetId = (item.presetId ?? item.id ?? '').trim()
      const runtimeId = (item.runtimeId ?? item.parentRuntimeId ?? '').trim()
      if (!presetId || !runtimeId) continue
      out.push({
        presetId,
        runtimeId,
        profileId: item.profileId,
        displayName: item.displayName,
        description: item.description,
        providerId: item.providerId,
        defaultModel: item.defaultModel,
        ...(item.defaultReasoningEffort ? { defaultReasoningEffort: item.defaultReasoningEffort } : {}),
      })
    }
    return out
  }

  /** Whether the installed `externalRuntimes` service supports runtime launch profiles. */
  supportsProfiles(): boolean {
    const dir = this.directory()
    return typeof dir?.listProfiles === 'function' && typeof dir?.upsertProfile === 'function'
  }

  listProfiles(runtimeId?: string): readonly RuntimeProfileSummary[] {
    return this.directory()?.listProfiles?.(runtimeId) ?? []
  }

  getProfile(runtimeId: string, profileId: string): RuntimeProfileSummary | undefined {
    const dir = this.directory()
    if (!dir) return undefined
    // Always read from `listProfiles` so secret environment values stay masked.
    return dir.listProfiles?.(runtimeId).find((p) => p.id === profileId)
  }

  async upsertProfile(input: RuntimeProfileInput): Promise<RuntimeProfileSummary> {
    const dir = this.directory()
    if (typeof dir?.upsertProfile !== 'function') {
      throw new Error('当前宿主未启用外部 Agent 启动配置管理能力，请升级 dsh-external-agents 插件')
    }
    return await dir.upsertProfile(input)
  }

  async deleteProfile(runtimeId: string, profileId: string): Promise<boolean> {
    const dir = this.directory()
    if (typeof dir?.deleteProfile !== 'function') {
      throw new Error('当前宿主未启用外部 Agent 启动配置管理能力，请升级 dsh-external-agents 插件')
    }
    return await dir.deleteProfile(runtimeId, profileId)
  }

  async probeProfileModels(
    runtimeId: string,
    profileId?: string,
  ): Promise<readonly ExternalModelMeta[]> {
    const dir = this.directory()
    if (typeof dir?.probeProfileModels === 'function') {
      return await dir.probeProfileModels(runtimeId, profileId)
    }
    if (typeof dir?.listModelsForRuntime === 'function') {
      return (await dir.listModelsForRuntime(runtimeId, profileId, { force: true })) ?? []
    }
    const summary = dir?.get(runtimeId)
    if (summary && typeof dir?.listModelsForProvider === 'function') {
      return (await dir.listModelsForProvider(summary.providerId)) ?? []
    }
    throw new Error('当前宿主未启用外部 Agent 模型探测能力')
  }

  async modelsForRuntime(
    runtimeId: string,
    profileId?: string,
    options?: { readonly force?: boolean },
  ): Promise<readonly ExternalModelMeta[] | undefined> {
    const dir = this.directory()
    if (!dir) return undefined
    if (typeof dir.listModelsForRuntime === 'function') {
      return await dir.listModelsForRuntime(runtimeId, profileId, options)
    }
    const summary = dir.get(runtimeId)
    if (!summary) return undefined
    return await dir.listModelsForProvider?.(summary.providerId)
  }

  /**
   * Resolve `provider`, `model`, `reasoningEffort`, `runtimeProfileId`, and preset-plugin mounting for
   * both external runtimes (`dsh-external-agents`) and built-in DSH native presets
   * (`standard`, `ptc`, `minimal`, `cordis`). Mirrors `@deepseek-ai/dsh-api-session-controller`
   * so native `AgentLoop` always receives valid `AgentOptions` and preset tools.
   */
  async resolveAgentLaunch(input: AgentLaunchInput): Promise<ResolvedAgentLaunch> {
    const presetId = input.agentPreset.trim()
    const runtimeProfileId = input.runtimeProfileId?.trim() || undefined
    const explicitProvider = input.explicitProvider?.trim() || undefined
    const explicitModel = input.explicitModel?.trim() || undefined
    const explicitEffort = input.explicitReasoningEffort?.trim() || undefined

    const ext = this.directory()?.get(presetId)
    const isExternal = Boolean(ext)

    const mountPreset = async (
      agentCtx: Context | undefined,
      agent?: { readonly session?: Session },
    ): Promise<void> => {
      if (isExternal && runtimeProfileId && agent?.session) {
        appendPluginRecord(agent.session, EXTERNAL_LAUNCH_RECORD_TYPE, {
          runtimeId: presetId,
          profileId: runtimeProfileId,
        })
      }
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
      const profileMeta = runtimeProfileId ? this.getProfile(presetId, runtimeProfileId) : undefined
      const effectiveModel = explicitModel || profileMeta?.defaultModel
      const effectiveEffort = explicitEffort || profileMeta?.defaultReasoningEffort
      return {
        isExternal: true,
        ...(runtimeProfileId ? { runtimeProfileId } : {}),
        provider: ext.providerId,
        ...(effectiveModel ? { model: effectiveModel } : {}),
        ...(effectiveEffort ? { reasoningEffort: brandString<ReasoningEffortId>(effectiveEffort) } : {}),
        mountPreset,
      }
    }

    const externalProviders = new Set([
      ...(this.directory()?.list() ?? []).map((r) => r.providerId),
      ...this.listExposedPresets().map((p) => p.providerId),
    ])
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

  private listConfigurableProviderIds(): ReadonlySet<string> {
    if (typeof this.ctx.llm?.listConfigurableProviders !== 'function') return new Set()
    try {
      return new Set(
        this.ctx.llm
          .listConfigurableProviders()
          .map((p) => p.provider)
          .filter(Boolean),
      )
    } catch {
      return new Set()
    }
  }

  private listNativeProviderIds(externalProviders: ReadonlySet<string>): string[] {
    if (typeof this.ctx.llm?.listProviders !== 'function') return []
    const configurableProviders = this.listConfigurableProviderIds()
    try {
      return this.ctx.llm
        .listProviders()
        .map((p) => p.id)
        .filter(
          (id) =>
            Boolean(id) &&
            !externalProviders.has(id) &&
            (configurableProviders.has(id) || !id.endsWith('-cli')),
        )
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

  /** Effective default model id for a preset (and optional profile), reconciling static config against the live catalog. */
  async resolveDefaultModel(
    presetId: string,
    fallbackDefault?: string,
    runtimeProfileId?: string,
  ): Promise<string> {
    const ext = this.directory()?.get(presetId)
    const profileId = runtimeProfileId?.trim() || undefined
    const profileMeta = profileId ? this.getProfile(presetId, profileId) : undefined
    const explicitProfileDefault = profileMeta?.defaultModel?.trim() || ''
    const baseConfigured = fallbackDefault?.trim() || ext?.defaultModel?.trim() || ''
    const configured = explicitProfileDefault || baseConfigured
    if (!ext) return configured
    const catalog = profileId
      ? await this.modelsForRuntime(presetId, profileId).catch(() => undefined)
      : await this.modelsForProvider(ext.providerId).catch(() => undefined)
    if (!catalog || catalog.length === 0) return configured
    if (profileId) {
      if (explicitProfileDefault && catalog.some((m) => m.id === explicitProfileDefault)) {
        return explicitProfileDefault
      }
      const catalogDefault = catalog.find((m) => m.isDefault)?.id
      if (catalogDefault) return catalogDefault
      if (baseConfigured && catalog.some((m) => m.id === baseConfigured)) return baseConfigured
      return catalog[0]?.id ?? configured
    }
    if (configured && catalog.some((m) => m.id === configured)) return configured
    return catalog.find((m) => m.isDefault)?.id ?? catalog[0]?.id ?? configured
  }

  async list(): Promise<RuntimeOption[]> {
    const dir = this.directory()
    const external = new Map((dir?.list() ?? []).map((r) => [r.id, r]))
    const exposedPresetIds = new Set(this.listExposedPresets().map((p) => p.presetId))
    const profileSupport = this.supportsProfiles()
    const roster = await this.roster()

    const attachExternalMeta = (ext: ExternalRuntimeSummary) => {
      if (!profileSupport) {
        return {
          providerId: ext.providerId,
          defaultModel: ext.defaultModel,
          supportsProfiles: false,
        }
      }
      const caps = dir?.getProfileCapabilities?.(ext.id)
      const profiles = dir?.listProfiles?.(ext.id) ?? []
      return {
        providerId: ext.providerId,
        defaultModel: ext.defaultModel,
        supportsProfiles: true,
        ...(caps ? { profileCapabilities: caps } : {}),
        profiles,
      }
    }

    const options: RuntimeOption[] = []
    for (const row of roster) {
      // Exposed profile presets (`<runtimeId>:<profileId>`) are surfaced under their
      // parent runtime's profile selector inside Lark Bridge, avoiding duplicate entries.
      if (exposedPresetIds.has(row.id)) continue
      const ext = external.get(row.id)
      const builtinMeta =
        !ext && row.name === undefined ? BUILTIN_DSH_PRESETS[row.id] : undefined
      options.push({
        id: row.id,
        name: row.name ?? ext?.displayName ?? builtinMeta?.name ?? row.id,
        description: row.description ?? ext?.description ?? builtinMeta?.description ?? '',
        kind: ext ? 'external' : 'native',
        group: builtinMeta ? 'builtin' : 'custom',
        ...(ext ? attachExternalMeta(ext) : {}),
        supportsReasoningEffort: true,
        isDefault: row.isDefault,
        ...(row.broken ? { broken: row.broken } : {}),
      })
    }
    for (const ext of external.values()) {
      if (options.some((o) => o.id === ext.id)) continue
      options.push({
        id: ext.id,
        name: ext.displayName,
        description: ext.description,
        kind: 'external',
        group: 'custom',
        ...attachExternalMeta(ext),
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

  resolveSessionIdByExternalId(externalId: string): string | undefined {
    const clean = externalId.trim()
    if (!clean) return undefined
    return this.directory()?.resolveSessionIdByExternalId?.(clean)
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
