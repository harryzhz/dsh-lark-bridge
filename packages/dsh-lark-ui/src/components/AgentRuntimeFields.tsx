import type { ModelGroup, RuntimeOption } from '../types.js'
import { SelectMenu, SettingRow, TextField } from './fields.js'
import {
  catalogModelsForRuntime,
  effectiveDefaultModel,
  modelOptions,
  normalizeModelAndEffort,
  reasoningEffortOptions,
  runtimeOptions,
} from './options.js'

export interface AgentRuntimeSelection {
  agentPreset: string
  model: string
  reasoningEffort: string
}

/**
 * Shared Agent runtime configuration fields (`运行时` + `模型` + `推理强度`),
 * used identically across Bot creation, Bot settings, and Group overrides.
 */
export function AgentRuntimeFields({
  runtimeTitle = '运行时',
  value,
  runtimes,
  models,
  disabled,
  onChange,
}: {
  runtimeTitle?: string
  value: AgentRuntimeSelection
  runtimes: readonly RuntimeOption[]
  models: readonly ModelGroup[]
  disabled?: boolean
  onChange: (next: AgentRuntimeSelection) => void
}) {
  const runtime = runtimes.find((r) => r.id === value.agentPreset)
  const normalized = normalizeModelAndEffort(runtime, models, value.model, value.reasoningEffort)
  const catalog = catalogModelsForRuntime(runtime, models)
  const useModelDropdown = runtime?.kind === 'external' || catalog.length > 0
  const effortMeta = reasoningEffortOptions(
    runtime,
    models,
    normalized.model,
    normalized.reasoningEffort,
  )

  return (
    <>
      <SettingRow
        title={runtimeTitle}
        desc={runtime?.broken ?? runtime?.description ?? '选择处理飞书消息的智能体运行时'}
      >
        <SelectMenu
          value={value.agentPreset}
          options={runtimeOptions(runtimes)}
          disabled={disabled}
          onChange={(agentPreset) => {
            const nextRt = runtimes.find((r) => r.id === agentPreset)
            const nextModel = effectiveDefaultModel(nextRt, models)
            const nextNorm = normalizeModelAndEffort(nextRt, models, nextModel, '')
            onChange({
              agentPreset,
              model: nextNorm.model,
              reasoningEffort: nextNorm.reasoningEffort,
            })
          }}
        />
      </SettingRow>

      {useModelDropdown ? (
        <SettingRow title="模型">
          <SelectMenu
            value={normalized.model}
            options={modelOptions(runtime, models, normalized.model)}
            disabled={disabled}
            onChange={(nextModel) => {
              const nextNorm = normalizeModelAndEffort(
                runtime,
                models,
                nextModel,
                normalized.reasoningEffort,
              )
              onChange({
                agentPreset: value.agentPreset,
                model: nextNorm.model,
                reasoningEffort: nextNorm.reasoningEffort,
              })
            }}
            placeholder="默认模型"
          />
        </SettingRow>
      ) : (
        <SettingRow title="模型" desc="留空使用默认模型">
          <TextField
            value={normalized.model}
            disabled={disabled}
            onChange={(nextModel) =>
              onChange({
                agentPreset: value.agentPreset,
                model: nextModel,
                reasoningEffort: normalized.reasoningEffort,
              })
            }
            placeholder="默认模型"
            mono
          />
        </SettingRow>
      )}

      <SettingRow
        title="推理强度"
        desc={!effortMeta.supported ? '当前模型不支持手动调节' : undefined}
      >
        <SelectMenu
          value={effortMeta.supported ? normalized.reasoningEffort : ''}
          options={effortMeta.options}
          disabled={disabled || !effortMeta.supported}
          onChange={(reasoningEffort) =>
            onChange({
              agentPreset: value.agentPreset,
              model: normalized.model,
              reasoningEffort,
            })
          }
        />
      </SettingRow>
    </>
  )
}
