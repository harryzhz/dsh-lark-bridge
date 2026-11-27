import type {
  ModelGroup,
  PromptGenerationTarget,
  RuntimeOption,
} from '../types.js'
import { resolveModelDisplayName, resolveRuntimeDisplayName } from './options.js'

export interface GenerationEngineChoice {
  readonly id: string
  readonly label: string
  readonly desc?: string
  readonly group: string
  readonly target: PromptGenerationTarget
}

export interface BuildGenerationEnginesInput {
  readonly runtimes: readonly RuntimeOption[]
  readonly models: readonly ModelGroup[]
  readonly currentRuntime?: {
    readonly agentPreset?: string
    readonly runtimeProfileId?: string
    readonly model?: string
    readonly reasoningEffort?: string
  }
  readonly preferredNativeModel?: {
    readonly provider?: string
    readonly model?: string
  }
}

function listNativeModelGroups(
  models: readonly ModelGroup[],
  runtimes: readonly RuntimeOption[],
): ModelGroup[] {
  const externalProviders = new Set(
    runtimes.filter((r) => r.kind === 'external' && r.providerId).map((r) => r.providerId!),
  )
  return models.filter((g) => {
    if (g.models.length === 0) return false
    if (g.isExternal !== undefined) return !g.isExternal
    return !externalProviders.has(g.provider) && !g.provider.endsWith('-cli')
  })
}

export function buildGenerationEngineOptions(input: BuildGenerationEnginesInput): {
  readonly choices: readonly GenerationEngineChoice[]
  readonly defaultId: string
} {
  const choices: GenerationEngineChoice[] = []
  const seenIds = new Set<string>()
  const pushChoice = (choice: GenerationEngineChoice) => {
    if (seenIds.has(choice.id)) return
    seenIds.add(choice.id)
    choices.push(choice)
  }

  const nativeGroups = listNativeModelGroups(input.models, input.runtimes)
  const multiProvider = nativeGroups.length > 1
  const nativeModelChoices: GenerationEngineChoice[] = []
  for (const group of nativeGroups) {
    const providerLabel = group.name || group.provider
    for (const model of group.models) {
      const id = `model::${group.provider}::${model.id}`
      const choice: GenerationEngineChoice = {
        id,
        label: model.name || model.id,
        ...(multiProvider ? { desc: providerLabel } : {}),
        group: '配置的模型',
        target: {
          kind: 'model',
          provider: group.provider,
          model: model.id,
        },
      }
      nativeModelChoices.push(choice)
    }
  }

  const healthyRuntimes = input.runtimes.filter((r) => !r.broken)
  let currentRuntimeId = ''
  const curPreset = input.currentRuntime?.agentPreset?.trim()
  if (curPreset && healthyRuntimes.some((r) => r.id === curPreset)) {
    const curProfile = input.currentRuntime?.runtimeProfileId?.trim() || ''
    const curModel = input.currentRuntime?.model?.trim() || ''
    const curEffort = input.currentRuntime?.reasoningEffort?.trim() || ''
    const runtimeLabel = resolveRuntimeDisplayName(curPreset, input.runtimes, curProfile || undefined)
    const modelLabel = curModel
      ? resolveModelDisplayName(curPreset, curModel, input.runtimes, input.models)
      : ''
    currentRuntimeId = `runtime::current::${curPreset}::${curProfile}::${curModel}`
    pushChoice({
      id: currentRuntimeId,
      label: modelLabel ? `当前运行时 · ${runtimeLabel} (${modelLabel})` : `当前运行时 · ${runtimeLabel}`,
      group: '当前配置',
      target: {
        kind: 'runtime',
        agentPreset: curPreset,
        ...(curProfile ? { runtimeProfileId: curProfile } : {}),
        ...(curModel ? { model: curModel } : {}),
        ...(curEffort ? { reasoningEffort: curEffort } : {}),
      },
    })
  }

  for (const choice of nativeModelChoices) {
    pushChoice(choice)
  }

  for (const rt of healthyRuntimes) {
    const baseId = `runtime::${rt.id}`
    pushChoice({
      id: baseId,
      label: rt.name,
      group: 'Agent 运行时',
      target: {
        kind: 'runtime',
        agentPreset: rt.id,
      },
    })
    for (const prof of rt.profiles ?? []) {
      const profId = `runtime::${rt.id}::${prof.id}`
      pushChoice({
        id: profId,
        label: `${rt.name} · ${prof.name}`,
        group: 'Agent 运行时',
        target: {
          kind: 'runtime',
          agentPreset: rt.id,
          runtimeProfileId: prof.id,
        },
      })
    }
  }

  // Pick fastest ready default: configured router model -> first native model -> current runtime -> first runtime.
  let defaultId = ''
  const prefProvider = input.preferredNativeModel?.provider?.trim()
  const prefModel = input.preferredNativeModel?.model?.trim()
  if (prefModel) {
    const exact = prefProvider
      ? nativeModelChoices.find((c) => c.id === `model::${prefProvider}::${prefModel}`)
      : nativeModelChoices.find((c) => c.target.kind === 'model' && c.target.model === prefModel)
    if (exact) defaultId = exact.id
  }
  if (!defaultId && nativeModelChoices[0]) {
    defaultId = nativeModelChoices[0].id
  }
  if (!defaultId && currentRuntimeId) {
    defaultId = currentRuntimeId
  }
  if (!defaultId && choices[0]) {
    defaultId = choices[0].id
  }

  return { choices, defaultId }
}
