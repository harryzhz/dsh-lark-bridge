import { useRef } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { choiceLabel, FALLBACK_TRIAGE_DEFAULTS, ROUTER_SCOPE_MODES } from '../presets.js'
import type {
  BotRouterConfig,
  ModelGroup,
  RouterScopeMode,
  RuntimeOption,
  TriageDefaultsPayload,
} from '../types.js'
import {
  NumberField,
  SelectMenu,
  SettingRow,
  type SelectOption,
} from './fields.js'

export interface TriageFieldsValue {
  readonly provider: string
  readonly model: string
  readonly scope: RouterScopeMode
  readonly timeoutMs: number
  readonly systemPrompt: string
  readonly recentMessageCount: number
  readonly contextTtlMinutes: number
  readonly includeLastReply: boolean
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
  triageDefaults = FALLBACK_TRIAGE_DEFAULTS,
  emptyModelLabel = '跟随 DSH 默认原生模型',
  onChange,
}: {
  value: TriageFieldsValue
  runtimes: readonly RuntimeOption[]
  models: readonly ModelGroup[]
  triageDefaults?: TriageDefaultsPayload
  emptyModelLabel?: string
  onChange: (patch: Partial<TriageFieldsValue>) => void
}) {
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
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

  const defaultPrompt = triageDefaults.defaultSystemPrompt
  const effectivePromptText = value.systemPrompt.trim() ? value.systemPrompt : defaultPrompt
  const isPromptCustomized =
    Boolean(value.systemPrompt.trim()) && value.systemPrompt.trim() !== defaultPrompt.trim()

  const updatePrompt = (nextText: string) => {
    if (!nextText.trim() || nextText.trim() === defaultPrompt.trim()) {
      onChange({ systemPrompt: '' })
      return
    }
    onChange({ systemPrompt: nextText })
  }

  const insertToken = (token: string) => {
    const el = promptRef.current
    const current = effectivePromptText
    if (!el) {
      updatePrompt(`${current}${current.endsWith('\n') || !current ? '' : '\n'}${token}`)
      return
    }
    const start = el.selectionStart ?? current.length
    const end = el.selectionEnd ?? start
    const next = `${current.slice(0, start)}${token}${current.slice(end)}`
    updatePrompt(next)
    const caret = start + token.length
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(caret, caret)
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
      <SettingRow title="最近上下文条数" desc="传给分流模型的最近群聊或话题消息条数（0 表示不带入）">
        <NumberField
          value={value.recentMessageCount}
          min={0}
          onChange={(count) =>
            onChange({ recentMessageCount: Math.min(50, Math.max(0, Math.round(count))) })
          }
          suffix="条"
        />
      </SettingRow>
      <SettingRow title="上下文有效窗口" desc="仅带入该时间窗口内的近期消息">
        <NumberField
          value={value.contextTtlMinutes}
          min={1}
          onChange={(mins) =>
            onChange({ contextTtlMinutes: Math.min(1440, Math.max(1, Math.round(mins))) })
          }
          suffix="分钟"
        />
      </SettingRow>
      <SettingRow title="携带上一轮主回复" desc="话题已有活跃主会话时附带上一轮回复全文">
        <Switch
          label="携带上一轮主回复"
          checked={value.includeLastReply}
          onChange={(includeLastReply) => onChange({ includeLastReply })}
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
      <SettingRow
        title="System Prompt"
        desc={`完整可自定义，支持点击下方占位变量插入；工具定义 ${triageDefaults.toolName} 固定注入`}
        stack
      >
        <div className="fb-prompt-bar">
          <div className="fb-var-chips" aria-label="可用占位变量">
            {triageDefaults.variables.map((v) => (
              <button
                key={v.key}
                type="button"
                className="fb-var-chip"
                title={`${v.label}：${v.desc}`}
                onClick={() => insertToken(v.token)}
              >
                {v.token}
              </button>
            ))}
          </div>
          {isPromptCustomized && (
            <button
              type="button"
              className="fb-link-btn"
              style={{ flex: 'none' }}
              onClick={() => onChange({ systemPrompt: '' })}
            >
              恢复默认
            </button>
          )}
        </div>
        <textarea
          ref={promptRef}
          className="fb-textarea fb-mono"
          rows={11}
          value={effectivePromptText}
          onChange={(e) => updatePrompt(e.target.value)}
        />
        <div className="fb-row-desc">
          UserMessage 全文透传不截断；工具定义 <code>{triageDefaults.toolName}</code>（<code>silent</code> / <code>quick_reply</code> / <code>handoff</code>）固定下发，不可修改。
        </div>
      </SettingRow>
    </>
  )
}
