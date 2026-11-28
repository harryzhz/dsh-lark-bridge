import { useMemo, useState } from 'react'
import {
  Button,
  IconChevronRightOutlineRegular,
  IconPlayOutlineRegular,
  StateDot,
  Switch,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgeApi } from '../api.js'
import { DEFAULT_DREAMING_SCOPES, REMINDER_CREATION_MODES } from '../presets.js'
import { formatTime } from '../state.js'
import type {
  BotDreamingConfig,
  BotExperimentalConfig,
  BotProactiveConfig,
  DreamRunState,
  ModelGroup,
  RuntimeOption,
} from '../types.js'
import {
  EditableScopeList,
  GroupTitle,
  NestedSettings,
  NumberField,
  SelectMenu,
  SettingRow,
  TextField,
} from './fields.js'
import {
  catalogModelsForRuntime,
  modelOptions,
  reasoningEffortOptions,
} from './options.js'
import {
  buildEffectiveModelsForProfile,
  profileCatalogCacheKey,
  useProfileModelCatalogs,
} from './profile-models.js'

export interface DreamStatusPresentation {
  readonly dot: StateDotState
  readonly title: string
  readonly detail?: string
  readonly isError?: boolean
}

export function cleanSummaryDetail(raw: string): string {
  return raw
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*$/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(?:^|\s)-\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildDreamStatusPresentation(
  dreamState: DreamRunState | undefined,
  runError: string,
  isRunning: boolean,
): DreamStatusPresentation | null {
  if (runError) {
    return { dot: 'error', title: '运行异常', detail: runError, isError: true }
  }
  if (isRunning) {
    return {
      dot: 'ongoing',
      title: '正在整理记忆…',
      detail: '正在盘点增量会话与代码库并整理记忆…',
    }
  }
  if (!dreamState) return null

  const timeLabel = dreamState.lastDreamAtMs ? formatTime(dreamState.lastDreamAtMs) : ''
  const rawSummary = dreamState.lastSummary?.trim() ?? ''

  if (dreamState.status === 'failed') {
    const detail = cleanSummaryDetail(rawSummary.replace(/^整理失败[：:]\s*/, ''))
    return {
      dot: 'error',
      title: timeLabel ? `最近整理失败 · ${timeLabel}` : '最近整理失败',
      ...(detail ? { detail } : {}),
      isError: true,
    }
  }

  if (dreamState.status === 'skipped') {
    if (!rawSummary) return null
    return {
      dot: 'idle',
      title: dreamState.lastCheckedDateKey
        ? `上次检查 ${dreamState.lastCheckedDateKey}`
        : '上次检查已跳过',
      detail: cleanSummaryDetail(rawSummary),
    }
  }

  if (dreamState.status === 'succeeded') {
    const countMatch =
      /^已整理\s+(\d+)\s+个会话(?:（\d+\s*批）)?(?:（([^）]+)）)?(?:\s*·\s*)?([\s\S]*)$/.exec(
        rawSummary,
      )
    const count = dreamState.lastProcessedCount ?? (countMatch ? Number(countMatch[1]) : undefined)
    const mutationTag = countMatch?.[2]?.trim() || ''
    const detail = cleanSummaryDetail(countMatch ? (countMatch[3] ?? '') : rawSummary)
    const batchesRun = dreamState.proactiveStats?.batchesRun ?? 0
    const countLabel =
      count !== undefined
        ? batchesRun > 1
          ? `已整理 ${count} 个会话（${batchesRun} 批）`
          : `已整理 ${count} 个会话`
        : null
    const titleParts = [
      timeLabel ? `最近整理 ${timeLabel}` : '最近整理已完成',
      countLabel,
      mutationTag || null,
    ].filter(Boolean)
    return {
      dot: 'done',
      title: titleParts.join(' · '),
      ...(detail ? { detail } : {}),
    }
  }

  return rawSummary ? { dot: 'idle', title: cleanSummaryDetail(rawSummary) } : null
}

export function ExperimentalSection({
  botId,
  experimental,
  dreamState,
  runtime,
  runtimeProfileId,
  models = [],
  botModel = '',
  onChange,
  onOpenSession,
  onStateUpdated,
}: {
  botId: string | null
  experimental: BotExperimentalConfig
  dreamState?: DreamRunState | undefined
  runtime?: RuntimeOption | undefined
  runtimeProfileId?: string | undefined
  models?: readonly ModelGroup[]
  botModel?: string | undefined
  onChange: (next: BotExperimentalConfig) => void
  onOpenSession?: ((sessionId: string) => void) | undefined
  onStateUpdated?: ((next: DreamRunState) => void) | undefined
}) {
  const [runningNow, setRunningNow] = useState(false)
  const [runError, setRunError] = useState('')

  const { dreaming, proactive } = experimental
  const patchDreaming = (p: Partial<BotDreamingConfig>) =>
    onChange({ ...experimental, dreaming: { ...dreaming, ...p } })
  const patchProactive = (p: Partial<BotProactiveConfig>) =>
    onChange({ ...experimental, proactive: { ...proactive, ...p } })

  const triggerDreamNow = async () => {
    if (!botId) return
    setRunningNow(true)
    setRunError('')
    try {
      const next = await bridgeApi.runBotDream(botId, true)
      onStateUpdated?.(next)
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunningNow(false)
    }
  }

  const isRunning = runningNow || dreamState?.status === 'running'
  const statusView = buildDreamStatusPresentation(dreamState, runError, isRunning)

  const dreamModelValue = dreaming.model?.trim() ?? ''
  const dreamEffortValue = dreaming.reasoningEffort?.trim() ?? ''
  const activeProfileId = runtimeProfileId?.trim() ?? ''
  const dreamRuntimes = useMemo(() => (runtime ? [runtime] : []), [runtime])
  const dreamProfilePairs = useMemo(
    () => (runtime && activeProfileId ? [{ runtimeId: runtime.id, profileId: activeProfileId }] : []),
    [runtime, activeProfileId],
  )
  const { catalogs: profileCatalogs, loadingKeys } = useProfileModelCatalogs(
    dreamProfilePairs,
    dreamRuntimes,
    models,
  )
  const profileLoading = Boolean(
    runtime && activeProfileId && loadingKeys.has(profileCatalogCacheKey(runtime.id, activeProfileId)),
  )
  const effectiveModels = useMemo(
    () =>
      buildEffectiveModelsForProfile(runtime, activeProfileId, models, profileCatalogs, {
        loading: profileLoading,
      }),
    [runtime, activeProfileId, models, profileCatalogs, profileLoading],
  )
  const runtimeCatalog = useMemo(
    () => catalogModelsForRuntime(runtime, effectiveModels),
    [runtime, effectiveModels],
  )
  const useModelDropdown = runtime?.kind === 'external' || runtimeCatalog.length > 0
  const dreamModelChoices = useMemo(
    () => [
      { value: '', label: '跟随智能体默认' },
      ...modelOptions(runtime, effectiveModels, dreamModelValue),
    ],
    [runtime, effectiveModels, dreamModelValue],
  )
  const effectiveModelForEffort = dreamModelValue || botModel?.trim() || ''
  const effortMeta = useMemo(
    () =>
      reasoningEffortOptions(runtime, effectiveModels, effectiveModelForEffort, dreamEffortValue),
    [runtime, effectiveModels, effectiveModelForEffort, dreamEffortValue],
  )
  const dreamEffortChoices = useMemo(
    () => [
      { value: '', label: '跟随智能体默认' },
      ...effortMeta.options.filter((o) => o.value !== ''),
    ],
    [effortMeta.options],
  )

  const defaultQuietWindowPatch = () => {
    const isUntouchedLegacy =
      !proactive.quietHoursEnabled &&
      proactive.quietHoursStart === '23:00' &&
      proactive.quietHoursEnd === '09:00'
    return {
      quietHoursStart:
        !proactive.quietHoursStart || isUntouchedLegacy ? '00:00' : proactive.quietHoursStart,
      quietHoursEnd:
        !proactive.quietHoursEnd || isUntouchedLegacy ? '08:00' : proactive.quietHoursEnd,
    }
  }

  return (
    <>
      <GroupTitle>Dreaming 与长期记忆</GroupTitle>
      <div className="fb-dream-card">
        <div className="fb-dream-head">
          <div className="fb-dream-desc">
            夜间分批回顾增量对话与代码变更，完成记忆沉淀、存量验真、冷记忆治理与未闭环事项盘点。
          </div>
          {botId && (
            <div className="fb-dream-actions">
              <Button
                size="sm"
                variant="outline"
                icon={<IconPlayOutlineRegular size={14} />}
                disabled={isRunning}
                onClick={() => void triggerDreamNow()}
              >
                {isRunning ? '整理中…' : '立即整理'}
              </Button>
            </div>
          )}
        </div>
        {statusView && (
          <div className="fb-dream-status">
            <span className="fb-dream-status-dot">
              <StateDot state={statusView.dot} />
            </span>
            <div className="fb-dream-status-body">
              <div className="fb-dream-status-head">
                <div
                  className="fb-dream-status-title fb-num"
                  data-error={statusView.isError ? '' : undefined}
                >
                  {statusView.title}
                </div>
                {dreamState?.lastSessionId && onOpenSession && (
                  <button
                    type="button"
                    className="fb-dream-inline-link"
                    onClick={() => onOpenSession(dreamState.lastSessionId!)}
                  >
                    <span>查看会话</span>
                    <IconChevronRightOutlineRegular size={13} />
                  </button>
                )}
              </div>
              {statusView.detail && (
                <div className="fb-dream-status-note" title={statusView.detail}>
                  {statusView.detail}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <SettingRow title="启用 Dreaming">
        <Switch
          label="启用 Dreaming"
          checked={dreaming.enabled}
          onChange={(enabled) => patchDreaming({ enabled })}
        />
      </SettingRow>

      {dreaming.enabled && (
        <>
          <SettingRow title="整理时间" desc="每日定时执行的本地时间（HH:MM）">
            <TextField
              value={dreaming.scheduleTime}
              onChange={(scheduleTime) => patchDreaming({ scheduleTime })}
              placeholder="03:00"
              mono
            />
          </SettingRow>
          <SettingRow title="触发阈值" desc="距上次整理至少新增该数量会话才触发">
            <NumberField
              value={dreaming.minNewSessions}
              min={1}
              max={50}
              onChange={(minNewSessions) =>
                patchDreaming({ minNewSessions: Math.min(50, Math.max(1, minNewSessions)) })
              }
              suffix="个会话"
            />
          </SettingRow>
          <SettingRow
            title="每次整理上限"
            desc="0 表示处理上次整理后的全部未处理会话，填正数则限制单次条数"
          >
            <NumberField
              value={dreaming.maxSessionsPerRun ?? 0}
              min={0}
              max={500}
              onChange={(maxSessionsPerRun) =>
                patchDreaming({
                  maxSessionsPerRun: Math.min(500, Math.max(0, Math.floor(maxSessionsPerRun))),
                })
              }
              suffix="个会话"
            />
          </SettingRow>
          <SettingRow
            title="单会话字数预算"
            desc="超长会话自动头尾采样，保留首轮诉求与收尾结论"
          >
            <NumberField
              value={dreaming.maxCharsPerSession ?? 5000}
              min={1000}
              max={20000}
              step={500}
              onChange={(maxCharsPerSession) =>
                patchDreaming({
                  maxCharsPerSession: Math.min(
                    20000,
                    Math.max(1000, Math.floor(maxCharsPerSession)),
                  ),
                })
              }
              suffix="字"
            />
          </SettingRow>
          <SettingRow
            title="单次提醒上限"
            desc="仅在开启主动创建提醒时生效，0 表示整理期间不自动建单"
          >
            <NumberField
              value={dreaming.maxRemindersPerRun ?? 5}
              min={0}
              max={20}
              onChange={(maxRemindersPerRun) =>
                patchDreaming({
                  maxRemindersPerRun: Math.min(20, Math.max(0, Math.floor(maxRemindersPerRun))),
                })
              }
              suffix="条"
            />
          </SettingRow>

          <GroupTitle>整理深度与模型</GroupTitle>
          <SettingRow
            title="深度验真与反思"
            desc="对照代码库核验存量记忆、治理长期未召回条目并沉淀排障经验"
          >
            <Switch
              label="深度验真与反思"
              checked={dreaming.deepConsolidation !== false}
              onChange={(deepConsolidation) => patchDreaming({ deepConsolidation })}
            />
          </SettingRow>
          {dreaming.deepConsolidation !== false && (
            <NestedSettings>
              <SettingRow
                title="周度监听规则反思"
                desc="每周评估各主动监听规则的命中、静默与耗时效果并沉淀调优建议"
              >
                <Switch
                  label="周度监听规则反思"
                  checked={dreaming.weeklyRuleReflection !== false}
                  onChange={(weeklyRuleReflection) => patchDreaming({ weeklyRuleReflection })}
                />
              </SettingRow>
            </NestedSettings>
          )}
          <SettingRow
            title="清理过期与纠偏"
            desc="对照当前代码与最新反馈，剔除失效路径和被推翻的旧结论"
          >
            <Switch
              label="清理过期与纠偏"
              checked={dreaming.cleanupAndCorrect}
              onChange={(cleanupAndCorrect) => patchDreaming({ cleanupAndCorrect })}
            />
          </SettingRow>
          <SettingRow title="夜间整理模型" desc="可选为夜间整理指定更强推理模型">
            {useModelDropdown ? (
              <SelectMenu
                value={dreamModelValue}
                options={dreamModelChoices}
                onChange={(model) => patchDreaming({ model, reasoningEffort: '' })}
              />
            ) : (
              <TextField
                value={dreamModelValue}
                onChange={(model) => patchDreaming({ model })}
                placeholder="跟随智能体默认"
                mono
              />
            )}
          </SettingRow>
          {effortMeta.supported && (
            <SettingRow title="夜间推理强度">
              <SelectMenu
                value={dreamEffortValue}
                options={dreamEffortChoices}
                onChange={(reasoningEffort) => patchDreaming({ reasoningEffort })}
              />
            </SettingRow>
          )}
          <SettingRow title="提炼范围" desc="点击标签可直接修改文字" stack>
            <EditableScopeList
              values={dreaming.scopes}
              presets={DEFAULT_DREAMING_SCOPES}
              onChange={(scopes) => patchDreaming({ scopes })}
            />
          </SettingRow>
        </>
      )}

      <GroupTitle>主动工作</GroupTitle>
      <div className="fb-banner" style={{ margin: '6px 0 2px' }}>
        <div className="fb-row-desc" style={{ minWidth: 0, flex: 1 }}>
          提醒事项在「自动化 → 提醒事项」按来源群话题或私聊单次定时唤醒执行，事项已完成则静默跳过，触发后自动归档；主动代码优化在工作区 .worktrees/ 下新建独立分支完成修改验证并提交审核，不改动主工作分支。
        </div>
      </div>

      <SettingRow
        title="主动创建提醒事项"
        desc="识别待跟进节点、发版核查与错峰汇报事项"
      >
        <Switch
          label="主动创建提醒事项"
          checked={proactive.remindersEnabled}
          onChange={(remindersEnabled) =>
            patchProactive({
              remindersEnabled,
              ...(remindersEnabled && proactive.quietHoursEnabled === undefined
                ? { quietHoursEnabled: true, ...defaultQuietWindowPatch() }
                : {}),
            })
          }
        />
      </SettingRow>

      {proactive.remindersEnabled && (
        <NestedSettings>
          <SettingRow title="提醒创建方式">
            <SelectMenu
              value={proactive.reminderCreationMode}
              options={REMINDER_CREATION_MODES}
              onChange={(reminderCreationMode) => patchProactive({ reminderCreationMode })}
            />
          </SettingRow>
          <SettingRow
            title="委派事项跟进"
            desc="静默记录群内 A @ B 明确指派，逾期提醒负责人并 cc 发起人（已回应未给结果自动顺延复查）"
          >
            <Switch
              label="委派事项跟进"
              checked={Boolean(proactive.delegationFollowupEnabled)}
              onChange={(delegationFollowupEnabled) =>
                patchProactive({
                  delegationFollowupEnabled,
                  ...(delegationFollowupEnabled && !proactive.quietHoursEnabled
                    ? {
                        quietHoursEnabled: true,
                        ...defaultQuietWindowPatch(),
                      }
                    : {}),
                })
              }
            />
          </SettingRow>
          <SettingRow
            title="夜间免打扰"
            desc="非紧急提醒落在静默时段时自动顺延至结束时刻"
          >
            <Switch
              label="夜间免打扰"
              checked={Boolean(proactive.quietHoursEnabled)}
              onChange={(quietHoursEnabled) =>
                patchProactive({
                  quietHoursEnabled,
                  ...(quietHoursEnabled ? defaultQuietWindowPatch() : {}),
                })
              }
            />
          </SettingRow>
          {proactive.quietHoursEnabled && (
            <NestedSettings>
              <SettingRow title="开始时间" desc="本地时间（HH:MM）">
                <TextField
                  value={proactive.quietHoursStart || '00:00'}
                  onChange={(quietHoursStart) => patchProactive({ quietHoursStart })}
                  placeholder="00:00"
                  mono
                />
              </SettingRow>
              <SettingRow title="结束时间" desc="本地时间（HH:MM）">
                <TextField
                  value={proactive.quietHoursEnd || '08:00'}
                  onChange={(quietHoursEnd) => patchProactive({ quietHoursEnd })}
                  placeholder="08:00"
                  mono
                />
              </SettingRow>
            </NestedSettings>
          )}
          <SettingRow
            title="避开周末"
            desc="非紧急提醒落在周六、周日时自动顺延至周一早晨"
          >
            <Switch
              label="避开周末"
              checked={Boolean(proactive.skipWeekends)}
              onChange={(skipWeekends) => patchProactive({ skipWeekends })}
            />
          </SettingRow>
        </NestedSettings>
      )}

      <SettingRow
        title="主动代码优化与提审"
        desc="发现明确问题或待办时新建隔离分支修改并提交 PR/MR"
      >
        <Switch
          label="主动代码优化与提审"
          checked={proactive.autoCodeEnabled}
          onChange={(autoCodeEnabled) => patchProactive({ autoCodeEnabled })}
        />
      </SettingRow>

      {proactive.autoCodeEnabled && (
        <NestedSettings>
          <SettingRow title="分支前缀">
            <TextField
              value={proactive.branchPrefix}
              onChange={(branchPrefix) => patchProactive({ branchPrefix })}
              placeholder="agent/"
              mono
            />
          </SettingRow>
        </NestedSettings>
      )}
    </>
  )
}
