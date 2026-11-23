import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { choiceLabel, ROUTER_SCOPE_MODES } from '../presets.js'
import type {
  BotRouterConfig,
  ModelGroup,
  RouterScopeMode,
  RuntimeOption,
} from '../types.js'
import {
  NumberField,
  SelectMenu,
  SettingRow,
  TextArea,
  type SelectOption,
} from './fields.js'

export interface TriageFieldsValue {
  readonly provider: string
  readonly model: string
  readonly scope: RouterScopeMode
  readonly timeoutMs: number
  readonly customPrompt: string
  readonly coalesceQueuedMessages: boolean
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

export function resolveNativeModelLabel(
  provider: string,
  model: string,
  models: readonly ModelGroup[],
): string {
  if (!model) return ''
  const group = provider ? models.find((g) => g.provider === provider) : undefined
  const hit = group?.models.find((m) => m.id === model)
  if (hit?.name) return hit.name
  for (const g of models) {
    const found = g.models.find((m) => m.id === model)
    if (found?.name) return found.name
  }
  return model
}

export function formatTriageSummary(
  router: BotRouterConfig | undefined,
  models: readonly ModelGroup[],
): string {
  if (!router?.enabled) return '未开启'
  const modelLabel =
    resolveNativeModelLabel(router.provider, router.model, models) || 'DSH 默认原生模型'
  const scopeLabel = choiceLabel(ROUTER_SCOPE_MODES, router.scope)
  return `已开启 · ${modelLabel} · ${scopeLabel}`
}

/**
 * Shared smart-triage configuration fields reused across Bot settings and Group overrides.
 */
export function TriageConfigFields({
  value,
  runtimes,
  models,
  emptyModelLabel = '跟随 DSH 默认原生模型',
  onChange,
}: {
  value: TriageFieldsValue
  runtimes: readonly RuntimeOption[]
  models: readonly ModelGroup[]
  emptyModelLabel?: string
  onChange: (patch: Partial<TriageFieldsValue>) => void
}) {
  const nativeGroups = listNativeModelGroups(models, runtimes)
  const modelValue =
    value.provider && value.model ? `${value.provider}::${value.model}` : value.model || ''
  const modelOptions: SelectOption<string>[] = [{ value: '', label: emptyModelLabel }]
  for (const group of nativeGroups) {
    const groupLabel = group.name || group.provider
    for (const m of group.models) {
      modelOptions.push({
        value: `${group.provider}::${m.id}`,
        label: m.name || m.id,
        group: groupLabel,
      })
    }
  }
  if (modelValue && !modelOptions.some((o) => o.value === modelValue)) {
    modelOptions.push({
      value: modelValue,
      label: value.provider ? `${value.provider} / ${value.model}` : value.model,
    })
  }

  return (
    <>
      {nativeGroups.length === 0 && (
        <div className="fb-banner" data-tone="warn" style={{ margin: '4px 0 6px' }}>
          <div className="fb-row-desc" style={{ minWidth: 0, flex: 1 }}>
            当前未检测到可用的 DSH 原生或自定义模型，请先在 DSH「设置 → 模型」配置至少一个轻量模型；未就绪期间消息将自动直通主运行时。
          </div>
        </div>
      )}
      <SettingRow title="分流模型" desc="建议选择响应快的轻量原生模型">
        <SelectMenu
          value={modelValue}
          options={modelOptions}
          onChange={(nextVal) => {
            if (!nextVal) {
              onChange({ provider: '', model: '' })
              return
            }
            const sep = nextVal.indexOf('::')
            if (sep > 0) {
              onChange({
                provider: nextVal.slice(0, sep),
                model: nextVal.slice(sep + 2),
              })
            } else {
              onChange({ provider: '', model: nextVal })
            }
          }}
        />
      </SettingRow>
      <SettingRow title="生效范围">
        <SelectMenu
          value={value.scope}
          options={ROUTER_SCOPE_MODES}
          onChange={(scope) => onChange({ scope })}
        />
      </SettingRow>
      <SettingRow title="分流超时" desc="超时自动直通主运行时，避免阻塞正式任务">
        <NumberField
          value={Math.round(value.timeoutMs / 1000)}
          min={1}
          onChange={(secs) =>
            onChange({ timeoutMs: Math.min(15, Math.max(1, Math.round(secs))) * 1000 })
          }
          suffix="秒"
        />
      </SettingRow>
      <SettingRow
        title="忙碌队列合批"
        desc="主运行时处理期间堆积的多条有效消息自动合并为一轮增量提交"
      >
        <Switch
          label="忙碌队列合批"
          checked={value.coalesceQueuedMessages}
          onChange={(coalesceQueuedMessages) => onChange({ coalesceQueuedMessages })}
        />
      </SettingRow>
      <SettingRow title="补充判断规则" desc="可选，追加团队特定的静默或转交约定" stack>
        <TextArea
          value={value.customPrompt}
          onChange={(customPrompt) => onChange({ customPrompt })}
          rows={4}
          placeholder="例如：涉及发版审批、数据库变更或线上报错的消息一律交由主运行时处理；打卡和日常问候静默跳过"
        />
      </SettingRow>
    </>
  )
}
