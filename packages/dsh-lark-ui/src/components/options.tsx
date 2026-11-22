import { useLayoutEffect, useRef } from 'react'
import { REACTION_EMOJIS, REACTION_NONE, REASONING_EFFORTS } from '../presets.js'
import type { CatalogModelItem, ModelGroup, RuntimeOption } from '../types.js'
import type { SelectOption } from './fields.js'

const UPPERCASE_MODEL_TOKENS = new Set(['gpt', 'oss', 'o1', 'o3', 'o4', 'ai', 'vl'])
const DEFAULT_EFFORT_VALUES: readonly string[] = ['low', 'medium', 'high', 'xhigh']

export function effortDisplayLabel(effort: string): string {
  const clean = effort.trim()
  if (!clean) return ''
  const preset = REASONING_EFFORTS.find((e) => e.value.toLowerCase() === clean.toLowerCase())
  if (preset) return preset.label
  return clean.charAt(0).toUpperCase() + clean.slice(1)
}

export function leafDirectoryLabel(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/[\\/]+$/, '')
  if (!trimmed || trimmed === '~') return ''
  if (trimmed === '/') return '/'
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

function formatModelSlugFallback(rawModelId: string): string {
  const trimmed = rawModelId.trim()
  if (!trimmed || /[A-Z\s()]/.test(trimmed)) return trimmed
  if (trimmed.startsWith('gpt-')) {
    return trimmed
      .split('-')
      .map((part) => {
        const lower = part.toLowerCase()
        if (UPPERCASE_MODEL_TOKENS.has(lower)) return lower.toUpperCase()
        if (/^\d+(\.\d+)?[a-z]?$/i.test(part)) return part.toUpperCase()
        return part.charAt(0).toUpperCase() + part.slice(1)
      })
      .join('-')
  }
  return trimmed
}

export function catalogModelsForRuntime(
  runtime: RuntimeOption | undefined,
  models: readonly ModelGroup[],
): readonly CatalogModelItem[] {
  if (!runtime) return []
  if (runtime.providerId) {
    return models.find((g) => g.provider === runtime.providerId)?.models ?? []
  }
  // Native runtime: gather models from any non-external provider if configured
  return models
    .filter((g) => !g.provider.endsWith('-cli') && g.models.length > 0)
    .flatMap((g) => g.models)
}

/**
 * Effective default model id for a runtime given the loaded provider catalogs.
 * Prefers `runtime.defaultModel` when present in the catalog; falls back to the
 * catalog's `isDefault` (or first) entry when a multi-region CLI (e.g. TRAE CN
 * vs TRAE International) exposes a different live model set than static fallback config.
 */
export function effectiveDefaultModel(
  runtime: RuntimeOption | undefined,
  models: readonly ModelGroup[],
): string {
  const catalog = catalogModelsForRuntime(runtime, models)
  const configured = runtime?.defaultModel?.trim() ?? ''
  if (configured && (catalog.length === 0 || catalog.some((m) => m.id === configured))) {
    return configured
  }
  return catalog.find((m) => m.isDefault)?.id ?? catalog[0]?.id ?? configured
}

/**
 * Splits legacy pre-multiplied model IDs (e.g. `gemini-4-neon-xhigh`) into
 * `{ model: 'gemini-4-neon', reasoningEffort: 'xhigh' }` and clamps unsupported
 * effort values when switching between models with different effort capabilities.
 */
export function normalizeModelAndEffort(
  runtime: RuntimeOption | undefined,
  models: readonly ModelGroup[],
  rawModel: string | undefined,
  rawEffort: string | undefined,
): { model: string; reasoningEffort: string } {
  const catalog = catalogModelsForRuntime(runtime, models)
  let model = rawModel?.trim() ?? ''
  let reasoningEffort = rawEffort?.trim() ?? ''

  if (model && catalog.length > 0 && !catalog.some((m) => m.id === model)) {
    const match = /^(.*)-(low|medium|high|xhigh|max|ultra)$/i.exec(model)
    if (match && catalog.some((m) => m.id === match[1])) {
      model = match[1]!
      if (!reasoningEffort) reasoningEffort = match[2]!.toLowerCase()
    }
  }

  const effectiveModelId = model || effectiveDefaultModel(runtime, models)
  const modelEntry = effectiveModelId ? catalog.find((m) => m.id === effectiveModelId) : undefined
  if (modelEntry?.reasoningEfforts !== undefined) {
    if (modelEntry.reasoningEfforts.length === 0) {
      reasoningEffort = ''
    } else if (reasoningEffort && !modelEntry.reasoningEfforts.includes(reasoningEffort)) {
      reasoningEffort = ''
    }
  }

  return { model, reasoningEffort }
}

export function resolveRuntimeDisplayName(
  agentPreset: string,
  runtimes: readonly RuntimeOption[],
): string {
  return runtimes.find((r) => r.id === agentPreset)?.name ?? agentPreset
}

/**
 * Resolves the human-readable display name of a model (e.g. `gpt-6.1-sol` -> `GPT-6.1-Sol`)
 * from the runtime's provider catalog, falling back to structured slug formatting while loading.
 */
export function resolveModelDisplayName(
  agentPreset: string,
  explicitModel: string | undefined,
  runtimes: readonly RuntimeOption[],
  models: readonly ModelGroup[],
): string {
  const runtime = runtimes.find((r) => r.id === agentPreset)
  const normalized = normalizeModelAndEffort(runtime, models, explicitModel, undefined)
  const modelId = normalized.model || effectiveDefaultModel(runtime, models)
  if (!modelId) return ''

  if (runtime?.providerId) {
    const providerGroup = models.find((g) => g.provider === runtime.providerId)
    const exact = providerGroup?.models.find((m) => m.id === modelId)
    if (exact?.name) return exact.name
  }
  for (const group of models) {
    const found = group.models.find((m) => m.id === modelId)
    if (found?.name) return found.name
  }
  return formatModelSlugFallback(modelId)
}

export function formatRuntimeSummary(
  agentPreset: string,
  model: string | undefined,
  reasoningEffort: string | undefined,
  runtimes: readonly RuntimeOption[],
  models: readonly ModelGroup[],
): string {
  const runtime = runtimes.find((r) => r.id === agentPreset)
  const normalized = normalizeModelAndEffort(runtime, models, model, reasoningEffort)
  const runtimeLabel = resolveRuntimeDisplayName(agentPreset, runtimes)
  const modelLabel = resolveModelDisplayName(agentPreset, normalized.model, runtimes, models)
  const effortLabel = effortDisplayLabel(normalized.reasoningEffort)
  return [runtimeLabel, modelLabel, effortLabel].filter(Boolean).join(' · ')
}

/** Models offered for a runtime: its provider's catalog, keeping an unknown current value visible. */
export function modelOptions(
  runtime: RuntimeOption | undefined,
  models: readonly ModelGroup[],
  current: string,
): SelectOption<string>[] {
  const catalog = catalogModelsForRuntime(runtime, models)
  const options = catalog.map((m) => ({ value: m.id, label: m.name || m.id }))
  if (current && !options.some((o) => o.value === current)) {
    options.unshift({ value: current, label: formatModelSlugFallback(current) })
  }
  return options
}

/**
 * Per-model reasoning effort options. Models with an explicit empty `reasoningEfforts: []`
 * (e.g. Orchestrator in Antigravity) report `supported: false` so the UI displays a clear
 * read-only state while keeping the control consistently present across all runtimes.
 */
export function reasoningEffortOptions(
  runtime: RuntimeOption | undefined,
  models: readonly ModelGroup[],
  selectedModel: string,
  currentEffort: string,
): { supported: boolean; options: SelectOption<string>[] } {
  const catalog = catalogModelsForRuntime(runtime, models)
  const effectiveModelId = selectedModel.trim() || effectiveDefaultModel(runtime, models)
  const modelEntry = effectiveModelId ? catalog.find((m) => m.id === effectiveModelId) : undefined

  if (modelEntry?.reasoningEfforts !== undefined && modelEntry.reasoningEfforts.length === 0) {
    return {
      supported: false,
      options: [{ value: '', label: '模型内置（不支持调节）' }],
    }
  }

  const allowedIds = modelEntry?.reasoningEfforts ?? DEFAULT_EFFORT_VALUES
  const defaultHint = modelEntry?.defaultEffort
    ? `模型默认（${effortDisplayLabel(modelEntry.defaultEffort)}）`
    : '模型默认'

  const options: SelectOption<string>[] = [
    { value: '', label: defaultHint },
    ...allowedIds.map((id) => ({ value: id, label: effortDisplayLabel(id) })),
  ]
  if (currentEffort && !options.some((o) => o.value === currentEffort)) {
    options.push({ value: currentEffort, label: effortDisplayLabel(currentEffort) })
  }
  return { supported: true, options }
}

const BUILTIN_PRESET_IDS = new Set(['standard', 'ptc', 'minimal', 'cordis'])

function resolveRuntimeGroup(runtime: RuntimeOption): 'builtin' | 'custom' {
  if (runtime.group) return runtime.group
  return runtime.kind === 'native' && BUILTIN_PRESET_IDS.has(runtime.id) ? 'builtin' : 'custom'
}

function RuntimeMenuOption({ label, description }: { label: string; description: string }) {
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const descRef = useRef<HTMLSpanElement | null>(null)

  useLayoutEffect(() => {
    const root = rootRef.current
    const desc = descRef.current
    if (!root || !desc) return
    const overflow = Math.ceil(desc.scrollWidth - desc.clientWidth)
    if (overflow > 2) {
      const durationSec = Math.max(2.2, overflow / 65) + 1.4
      root.setAttribute('data-overflow', '')
      root.style.setProperty('--fb-marquee-dist', `-${overflow}px`)
      root.style.setProperty('--fb-marquee-dur', `${durationSec.toFixed(2)}s`)
    } else {
      root.removeAttribute('data-overflow')
      root.style.removeProperty('--fb-marquee-dist')
      root.style.removeProperty('--fb-marquee-dur')
    }
  }, [label, description])

  return (
    <span ref={rootRef} className="fb-rt-opt">
      <span className="fb-rt-opt-name">{label}</span>
      <span ref={descRef} className="fb-rt-opt-desc">
        <span className="fb-rt-opt-desc-track">{description}</span>
      </span>
    </span>
  )
}

export function runtimeOptions(runtimes: readonly RuntimeOption[]): SelectOption<string>[] {
  const ordered = [
    ...runtimes.filter((r) => resolveRuntimeGroup(r) === 'custom'),
    ...runtimes.filter((r) => resolveRuntimeGroup(r) === 'builtin'),
  ]
  return ordered.map((r) => {
    const label = r.broken ? `${r.name}（不可用）` : r.name
    const groupLabel = resolveRuntimeGroup(r) === 'builtin' ? '内置' : '自定义'
    return {
      value: r.id,
      label,
      group: groupLabel,
      ...(r.broken ? { disabled: true } : {}),
      menuNode: r.description ? <RuntimeMenuOption label={label} description={r.description} /> : undefined,
    }
  })
}

export function reactionOptions(): SelectOption<string>[] {
  return [
    ...REACTION_EMOJIS.map((e) => ({
      value: e.type,
      label: e.label,
      node: (
        <span className="fb-option">
          <img className="fb-emoji" src={e.src} alt="" />
          {e.label}
        </span>
      ),
    })),
    { value: REACTION_NONE, label: '不添加' },
  ]
}

export function reactionOptionsWithInherit(inheritedEmoji: string): SelectOption<string>[] {
  const clean = inheritedEmoji.trim()
  const botEmoji = clean && clean !== REACTION_NONE ? REACTION_EMOJIS.find((e) => e.type === clean) : undefined
  const inheritLabel =
    !clean || clean === REACTION_NONE
      ? '跟随智能体（不添加）'
      : `跟随智能体（${botEmoji?.label ?? clean}）`
  return [
    {
      value: 'inherit',
      label: inheritLabel,
      ...(botEmoji
        ? {
            node: (
              <span className="fb-option">
                <img className="fb-emoji" src={botEmoji.src} alt="" />
                <span>跟随智能体 · {botEmoji.label}</span>
              </span>
            ),
          }
        : {}),
    },
    ...reactionOptions(),
  ]
}
