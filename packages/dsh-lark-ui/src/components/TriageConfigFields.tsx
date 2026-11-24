import { useMemo, useRef, useState } from 'react'
import {
  Button,
  IconCheckOutlineRegular,
  IconCloseOutlineRegular,
  IconCodeOutlineRegular,
  IconCopyOutlineRegular,
  Modal,
  Switch,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { choiceLabel, FALLBACK_TRIAGE_DEFAULTS, ROUTER_SCOPE_MODES } from '../presets.js'
import type {
  BotRouterConfig,
  ModelGroup,
  RouterScopeMode,
  RuntimeOption,
  TriageDefaultsPayload,
  TriageToolSchema,
} from '../types.js'
import {
  GroupTitle,
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

export interface TriagePreviewContext {
  readonly botName?: string
  readonly chatName?: string
  readonly listenerName?: string
}

const SAMPLE_RECENT_ENTRIES: ReadonlyArray<string> = [
  '- [成员A] 刚发了一个版本，大家关注下线上指标',
  '- [智能体] 已记录本次变更，如触发异常可直接排查',
  '- [成员B] 登录接口偶发 504，麻烦看下是不是超时配置问题',
  '- [智能体] 排查完毕，请问按方案 A 还是方案 B 调整超时？',
]

/**
 * Generates a live preview mirroring `@dsh-lark/lark-core`'s `buildTriageUserMessage()`
 * for the currently configured triage parameters.
 */
export function buildTriageUserMessagePreview(
  value: Pick<
    TriageFieldsValue,
    'scope' | 'recentMessageCount' | 'contextTtlMinutes' | 'includeLastReply'
  >,
  ctx: TriagePreviewContext = {},
): string {
  const trigger = ctx.listenerName
    ? 'listener'
    : value.scope === 'all_group'
      ? 'mention'
      : 'active-thread'
  const chatName = ctx.chatName?.trim() || '示例群聊'
  const metaParts = [
    `trigger=${trigger}`,
    'has_active_session=true',
    'session_busy=false',
    `chat="${chatName}"`,
    ...(ctx.listenerName ? [`listener="${ctx.listenerName}"`] : []),
    'sender_type=user',
    'sender="成员B"',
  ]

  const sections: string[] = [`<triage_meta ${metaParts.join(' ')} />`]

  if (value.includeLastReply) {
    sections.push(
      '<last_reply>\n排查完毕，请问按方案 A 还是方案 B 调整超时？（实际运行时透传上一轮主回复全文）\n</last_reply>',
    )
  }

  const maxRecent = Math.max(0, Math.floor(value.recentMessageCount))
  if (maxRecent > 0) {
    const shownCount = Math.min(maxRecent, SAMPLE_RECENT_ENTRIES.length)
    const lines = SAMPLE_RECENT_ENTRIES.slice(-shownCount)
    if (maxRecent > SAMPLE_RECENT_ENTRIES.length) {
      lines.unshift(
        `…（最近 ${value.contextTtlMinutes} 分钟内最多携带 ${maxRecent} 条上下文，原文不截断）`,
      )
    }
    sections.push(`<recent_context>\n${lines.join('\n')}\n</recent_context>`)
  }

  sections.push(
    '<incoming_message>\n好的，按方案 B 调整吧（实际运行时透传入站消息全文）\n</incoming_message>',
  )
  return sections.join('\n\n')
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

interface ParsedSchemaProp {
  readonly name: string
  readonly type: string
  readonly required: boolean
  readonly enumValues?: readonly string[]
  readonly description?: string
}

function parseSchemaProperties(schema: TriageToolSchema): ParsedSchemaProp[] {
  const params = schema.parameters as {
    properties?: Record<string, { type?: string; enum?: string[]; description?: string }>
    required?: string[]
  }
  const requiredSet = new Set(params.required ?? [])
  return Object.entries(params.properties ?? {}).map(([name, def]) => ({
    name,
    type: def.type || 'string',
    required: requiredSet.has(name),
    ...(Array.isArray(def.enum) ? { enumValues: def.enum } : {}),
    ...(def.description ? { description: def.description } : {}),
  }))
}

function ToolSchemaModal({
  schema,
  onClose,
}: {
  schema: TriageToolSchema
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  const jsonText = useMemo(() => JSON.stringify(schema, null, 2), [schema])
  const props = useMemo(() => parseSchemaProperties(schema), [schema])

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(jsonText)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      // Clipboard unavailable in restricted context.
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`工具 Schema · ${schema.name}`}
      headless
      className="fb-schedule-dialog fb-nested-modal"
    >
      <div className="fb-schedule-dialog-head">
        <div style={{ minWidth: 0 }}>
          <div className="fb-schedule-dialog-title">
            工具 Schema · <span className="fb-mono">{schema.name}</span>
          </div>
          <div className="fb-schedule-dialog-sub">
            固定注入给智能分流模型的结构化裁决工具（只读）
          </div>
        </div>
        <button type="button" className="fb-icon-btn" aria-label="关闭" onClick={onClose}>
          <IconCloseOutlineRegular size={14} />
        </button>
      </div>

      <div className="fb-schedule-dialog-body">
        {props.length > 0 && (
          <div className="fb-schema-params">
            {props.map((p) => (
              <div key={p.name} className="fb-schema-param">
                <div className="fb-schema-param-head">
                  <span className="fb-mono" style={{ fontWeight: 500 }}>
                    {p.name}
                  </span>
                  <Tag tone="neutral">{p.type}</Tag>
                  {p.required && <Tag tone="info">必填</Tag>}
                  {p.enumValues?.map((v) => (
                    <Tag key={v} tone="neutral">
                      {v}
                    </Tag>
                  ))}
                </div>
                {p.description && <div className="fb-row-desc">{p.description}</div>}
              </div>
            ))}
          </div>
        )}
        <pre className="fb-code-preview fb-mono" style={{ maxHeight: 280 }}>
          {jsonText}
        </pre>
      </div>

      <div className="fb-schedule-dialog-foot">
        <Button
          variant="outline"
          icon={copied ? <IconCheckOutlineRegular size={14} /> : <IconCopyOutlineRegular size={14} />}
          onClick={() => void copyJson()}
        >
          {copied ? '已复制' : '复制 JSON'}
        </Button>
        <Button variant="primary" onClick={onClose}>
          关闭
        </Button>
      </div>
    </Modal>
  )
}

function TriagePromptSection({
  value,
  triageDefaults,
  previewContext,
  onChange,
}: {
  value: TriageFieldsValue
  triageDefaults: TriageDefaultsPayload
  previewContext?: TriagePreviewContext
  onChange: (patch: Partial<TriageFieldsValue>) => void
}) {
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  const [schemaOpen, setSchemaOpen] = useState(false)

  const defaultPrompt = triageDefaults.defaultSystemPrompt
  const effectivePromptText = value.systemPrompt.trim() ? value.systemPrompt : defaultPrompt
  const isPromptCustomized =
    Boolean(value.systemPrompt.trim()) && value.systemPrompt.trim() !== defaultPrompt.trim()
  const toolSchema = triageDefaults.toolSchema ?? FALLBACK_TRIAGE_DEFAULTS.toolSchema!

  const userPreviewText = useMemo(
    () => buildTriageUserMessagePreview(value, previewContext),
    [
      value.scope,
      value.recentMessageCount,
      value.contextTtlMinutes,
      value.includeLastReply,
      previewContext?.botName,
      previewContext?.chatName,
      previewContext?.listenerName,
    ],
  )

  const previewSummary = [
    value.recentMessageCount > 0
      ? `最近 ${value.recentMessageCount} 条（${value.contextTtlMinutes} 分钟内）`
      : '不带历史消息',
    value.includeLastReply ? '含上一轮主回复' : '不含上一轮主回复',
    '全文不截断',
  ].join(' · ')

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
      <GroupTitle>Prompt 配置</GroupTitle>
      <SettingRow
        title="System Prompt"
        desc="完整可自定义，点击下方变量标签在光标处插入占位符"
        headerAction={
          <>
            {isPromptCustomized && (
              <button
                type="button"
                className="fb-link-btn"
                onClick={() => onChange({ systemPrompt: '' })}
              >
                恢复默认
              </button>
            )}
            <button
              type="button"
              className="fb-icon-btn"
              aria-label={`查看工具 Schema（${toolSchema.name}）`}
              title={`查看固定工具 Schema（${toolSchema.name}）`}
              onClick={() => setSchemaOpen(true)}
            >
              <IconCodeOutlineRegular size={15} />
            </button>
          </>
        }
        stack
      >
        <div className="fb-var-chips" aria-label="可用占位变量">
          {triageDefaults.variables.map((v) => (
            <button
              key={v.key}
              type="button"
              className="fb-var-chip"
              title={`插入 ${v.token} — ${v.desc}`}
              onClick={() => insertToken(v.token)}
            >
              {v.label}
            </button>
          ))}
        </div>
        <textarea
          ref={promptRef}
          className="fb-textarea fb-mono"
          rows={10}
          value={effectivePromptText}
          onChange={(e) => updatePrompt(e.target.value)}
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
      <SettingRow title="UserMessage 预览" desc={`按当前配置实时生成：${previewSummary}`} stack>
        <pre className="fb-code-preview fb-mono">{userPreviewText}</pre>
      </SettingRow>

      {schemaOpen && <ToolSchemaModal schema={toolSchema} onClose={() => setSchemaOpen(false)} />}
    </>
  )
}

/**
 * Shared smart-triage configuration fields reused across Bot settings and Group overrides,
 * split into Basic and Prompt subgroups inside `<NestedSettings>`.
 */
export function TriageConfigFields({
  value,
  runtimes,
  models,
  triageDefaults = FALLBACK_TRIAGE_DEFAULTS,
  emptyModelLabel = '跟随 DSH 默认原生模型',
  previewContext,
  onChange,
}: {
  value: TriageFieldsValue
  runtimes: readonly RuntimeOption[]
  models: readonly ModelGroup[]
  triageDefaults?: TriageDefaultsPayload
  emptyModelLabel?: string
  previewContext?: TriagePreviewContext
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
      <GroupTitle>基本配置</GroupTitle>
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

      <TriagePromptSection
        value={value}
        triageDefaults={triageDefaults}
        previewContext={previewContext}
        onChange={onChange}
      />
    </>
  )
}
