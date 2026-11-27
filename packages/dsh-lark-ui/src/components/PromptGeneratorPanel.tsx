import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, IconSparkleRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgeApi } from '../api.js'
import type {
  GeneratedListenerDraft,
  GeneratedRoleDraft,
  GeneratePromptRequest,
  ModelGroup,
  RoleGenerationMode,
  RuntimeOption,
} from '../types.js'
import { SelectMenu, SettingRow, type SelectOption } from './fields.js'
import {
  buildGenerationEngineOptions,
  type BuildGenerationEnginesInput,
} from './prompt-generator-model.js'

export {
  buildGenerationEngineOptions,
  type BuildGenerationEnginesInput,
  type GenerationEngineChoice,
} from './prompt-generator-model.js'

interface PromptGeneratorBaseProps {
  readonly botId?: string | undefined
  readonly chatId?: string | undefined
  readonly runtimes: readonly RuntimeOption[]
  readonly models: readonly ModelGroup[]
  readonly currentRuntime?: BuildGenerationEnginesInput['currentRuntime']
  readonly preferredNativeModel?: BuildGenerationEnginesInput['preferredNativeModel']
  readonly context?: GeneratePromptRequest['context']
}

type PromptGeneratorProps =
  | (PromptGeneratorBaseProps & {
      readonly kind: 'role'
      readonly roleMode?: RoleGenerationMode
      readonly onApplyRole: (draft: GeneratedRoleDraft) => () => void
    })
  | (PromptGeneratorBaseProps & {
      readonly kind: 'listener'
      readonly onApplyListener: (draft: GeneratedListenerDraft) => () => void
    })

export function PromptGeneratorPanel(props: PromptGeneratorProps) {
  const { choices, defaultId } = useMemo(
    () =>
      buildGenerationEngineOptions({
        runtimes: props.runtimes,
        models: props.models,
        ...(props.currentRuntime ? { currentRuntime: props.currentRuntime } : {}),
        ...(props.preferredNativeModel ? { preferredNativeModel: props.preferredNativeModel } : {}),
      }),
    [props.runtimes, props.models, props.currentRuntime, props.preferredNativeModel],
  )

  const [selectedId, setSelectedId] = useState(defaultId)
  const [brief, setBrief] = useState('')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [appliedInfo, setAppliedInfo] = useState<{
    readonly engineLabel: string
    readonly extraNote?: string
    readonly undo: () => void
  } | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  const effectiveChoice =
    choices.find((c) => c.id === selectedId) ??
    choices.find((c) => c.id === defaultId) ??
    choices[0]

  const selectOptions: SelectOption<string>[] = useMemo(
    () =>
      choices.map((c) => ({
        value: c.id,
        label: c.label,
        ...(c.desc ? { desc: c.desc } : {}),
        group: c.group,
      })),
    [choices],
  )

  const desc =
    props.kind === 'role'
      ? props.roleMode === 'append'
        ? '输入简短描述，自动生成本群追加设定'
        : '输入简短描述，自动生成角色名称与提示词'
      : '输入简短描述，自动生成判断指令与推荐监听策略'

  const placeholder =
    props.kind === 'role'
      ? props.roleMode === 'append'
        ? '例如：聚焦当前微服务的线上排查和发布风险把关，回答先给结论和定位命令'
        : '例如：后端架构与代码评审专家，重点查边界条件、并发和鉴权，说话简洁直接'
      : '例如：监听群里监控机器人发出的告警卡片，忽略恢复通知，命中后排查根因并给出止损建议'

  const cancelGeneration = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setGenerating(false)
  }

  const runGenerate = async () => {
    const cleanBrief = brief.trim()
    if (!cleanBrief || !effectiveChoice || generating) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setGenerating(true)
    setError('')

    try {
      const response = await bridgeApi.generatePrompt(
        {
          kind: props.kind,
          description: cleanBrief,
          target: effectiveChoice.target,
          ...(props.botId ? { botId: props.botId } : {}),
          ...(props.chatId ? { chatId: props.chatId } : {}),
          context: {
            ...(props.context ?? {}),
            ...(props.kind === 'role' && props.roleMode ? { roleMode: props.roleMode } : {}),
          },
        },
        controller.signal,
      )
      if (controller.signal.aborted) return

      if (props.kind === 'role' && response.kind === 'role') {
        const undo = props.onApplyRole(response.role)
        setAppliedInfo({
          engineLabel: response.engine.label,
          undo,
        })
      } else if (props.kind === 'listener' && response.kind === 'listener') {
        const undo = props.onApplyListener(response.listener)
        const syncedPolicy = Boolean(
          response.listener.scope ||
            response.listener.replyMode ||
            response.listener.sessionMode ||
            response.listener.msgTypes?.length ||
            response.listener.senderTypes?.length,
        )
        setAppliedInfo({
          engineLabel: response.engine.label,
          ...(syncedPolicy ? { extraNote: '已同步推荐策略' } : {}),
          undo,
        })
      }
    } catch (err) {
      if (controller.signal.aborted) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null
      }
      setGenerating(false)
    }
  }

  return (
    <SettingRow
      title="智能生成"
      desc={desc}
      headerAction={
        selectOptions.length > 0 ? (
          <SelectMenu
            size="sm"
            value={effectiveChoice?.id ?? ''}
            options={selectOptions}
            placeholder="选择模型或运行时"
            disabled={generating}
            onChange={(nextId) => {
              setSelectedId(nextId)
              setError('')
            }}
          />
        ) : undefined
      }
      stack
    >
      <textarea
        className="fb-textarea fb-textarea-compact"
        rows={3}
        value={brief}
        disabled={generating}
        placeholder={placeholder}
        onChange={(e) => {
          setBrief(e.target.value)
          if (error) setError('')
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            void runGenerate()
          }
        }}
      />
      <div className="fb-gen-bar">
        <div className="fb-gen-status">
          {error ? (
            <span className="fb-gen-error">{error}</span>
          ) : generating ? (
            <span className="fb-row-desc">
              正在通过 {effectiveChoice?.label || '所选引擎'} 生成…
            </span>
          ) : appliedInfo ? (
            <>
              <span className="fb-row-desc">
                已由 {appliedInfo.engineLabel} 生成
                {appliedInfo.extraNote ? `（${appliedInfo.extraNote}）` : ''}
              </span>
              <button
                type="button"
                className="fb-link-btn"
                onClick={() => {
                  appliedInfo.undo()
                  setAppliedInfo(null)
                }}
              >
                撤销
              </button>
            </>
          ) : !effectiveChoice ? (
            <span className="fb-row-desc">请先配置可用模型或 Agent 运行时</span>
          ) : null}
        </div>
        <div className="fb-gen-actions">
          {generating && (
            <Button size="sm" variant="outline" onClick={cancelGeneration}>
              取消
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            icon={<IconSparkleRegular size={14} />}
            disabled={generating || !brief.trim() || !effectiveChoice}
            onClick={() => void runGenerate()}
          >
            {generating ? '生成中…' : '自动生成'}
          </Button>
        </div>
      </div>
    </SettingRow>
  )
}
