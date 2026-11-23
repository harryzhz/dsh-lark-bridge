import { useState } from 'react'
import {
  Button,
  IconNewChatOutlineRegular,
  IconPlayOutlineRegular,
  StateDot,
  Switch,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgeApi } from '../api.js'
import {
  DEFAULT_DREAMING_SCOPES,
  REMINDER_CREATION_MODES,
  ROUTER_SCOPE_MODES,
} from '../presets.js'
import { formatTime } from '../state.js'
import type {
  BotDreamingConfig,
  BotExperimentalConfig,
  BotProactiveConfig,
  BotRouterConfig,
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
  TextArea,
  TextField,
  type SelectOption,
} from './fields.js'

export interface DreamStatusPresentation {
  readonly dot: StateDotState
  readonly title: string
  readonly detail?: string
  readonly isError?: boolean
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
    const detail = rawSummary.replace(/^整理失败[：:]\s*/, '').trim()
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
      detail: rawSummary,
    }
  }

  if (dreamState.status === 'succeeded') {
    const countMatch = /^已整理\s+(\d+)\s+个会话(?:\s*·\s*)?([\s\S]*)$/.exec(rawSummary)
    const count = dreamState.lastProcessedCount ?? (countMatch ? Number(countMatch[1]) : undefined)
    const detail = (countMatch ? (countMatch[2] ?? '') : rawSummary).trim()
    const titleParts = [
      timeLabel ? `最近整理 ${timeLabel}` : '最近整理已完成',
      count !== undefined ? `已整理 ${count} 个会话` : null,
    ].filter(Boolean)
    return {
      dot: 'done',
      title: titleParts.join(' · '),
      ...(detail ? { detail } : {}),
    }
  }

  return rawSummary ? { dot: 'idle', title: rawSummary } : null
}

export function ExperimentalSection({
  botId,
  experimental,
  dreamState,
  runtimes = [],
  models = [],
  onChange,
  onOpenSession,
  onStateUpdated,
}: {
  botId: string | null
  experimental: BotExperimentalConfig
  dreamState?: DreamRunState | undefined
  runtimes?: readonly RuntimeOption[]
  models?: readonly ModelGroup[]
  onChange: (next: BotExperimentalConfig) => void
  onOpenSession?: ((sessionId: string) => void) | undefined
  onStateUpdated?: ((next: DreamRunState) => void) | undefined
}) {
  const [runningNow, setRunningNow] = useState(false)
  const [runError, setRunError] = useState('')

  const { dreaming, proactive, router } = experimental
  const patchDreaming = (p: Partial<BotDreamingConfig>) =>
    onChange({ ...experimental, dreaming: { ...dreaming, ...p } })
  const patchProactive = (p: Partial<BotProactiveConfig>) =>
    onChange({ ...experimental, proactive: { ...proactive, ...p } })
  const patchRouter = (p: Partial<BotRouterConfig>) =>
    onChange({ ...experimental, router: { ...router, ...p } })

  const externalProviders = new Set(
    runtimes.filter((r) => r.kind === 'external' && r.providerId).map((r) => r.providerId!),
  )
  const nativeGroups = models.filter(
    (g) =>
      !g.isExternal &&
      !externalProviders.has(g.provider) &&
      !g.provider.endsWith('-cli') &&
      g.models.length > 0,
  )
  const routerModelValue =
    router.provider && router.model ? `${router.provider}::${router.model}` : router.model || ''
  const routerModelOptions: SelectOption<string>[] = [{ value: '', label: '跟随 DSH 默认原生模型' }]
  for (const group of nativeGroups) {
    const groupLabel = group.name || group.provider
    for (const m of group.models) {
      routerModelOptions.push({
        value: `${group.provider}::${m.id}`,
        label: m.name || m.id,
        group: groupLabel,
      })
    }
  }
  if (routerModelValue && !routerModelOptions.some((o) => o.value === routerModelValue)) {
    routerModelOptions.push({
      value: routerModelValue,
      label: router.provider ? `${router.provider} / ${router.model}` : router.model,
    })
  }

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

  return (
    <>
      <GroupTitle>Dreaming 记忆整理</GroupTitle>
      <div className="fb-dream-card">
        <div className="fb-dream-head">
          <div className="fb-dream-desc">
            到达整理时间且新增会话达到阈值后，自动汇总近期增量对话摘要并结合代码库变更唤醒智能体，调用其自身长期记忆机制提炼关键认知、合并重复项并清理纠偏过期内容。
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
              {dreamState?.lastSessionId && onOpenSession && (
                <Button
                  size="sm"
                  variant="outline"
                  icon={<IconNewChatOutlineRegular size={14} />}
                  onClick={() => onOpenSession(dreamState.lastSessionId!)}
                >
                  查看会话
                </Button>
              )}
            </div>
          )}
        </div>
        {statusView && (
          <div className="fb-dream-status">
            <span className="fb-dream-status-dot">
              <StateDot state={statusView.dot} />
            </span>
            <div className="fb-dream-status-body">
              <div
                className="fb-dream-status-title fb-num"
                data-error={statusView.isError ? '' : undefined}
              >
                {statusView.title}
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
        <NestedSettings>
          <SettingRow title="整理时间" desc="每日定时执行的本地时间（HH:MM）">
            <TextField
              value={dreaming.scheduleTime}
              onChange={(scheduleTime) => patchDreaming({ scheduleTime })}
              placeholder="02:00"
              mono
            />
          </SettingRow>
          <SettingRow title="触发阈值" desc="距上次整理至少新增该数量会话才触发">
            <NumberField
              value={dreaming.minNewSessions}
              min={1}
              onChange={(minNewSessions) =>
                patchDreaming({ minNewSessions: Math.min(50, Math.max(1, minNewSessions)) })
              }
              suffix="个会话"
            />
          </SettingRow>
          <SettingRow title="提炼范围" desc="点击标签可直接修改文字" stack>
            <EditableScopeList
              values={dreaming.scopes}
              presets={DEFAULT_DREAMING_SCOPES}
              onChange={(scopes) => patchDreaming({ scopes })}
            />
          </SettingRow>
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
        </NestedSettings>
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
          onChange={(remindersEnabled) => patchProactive({ remindersEnabled })}
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

      <GroupTitle>Router 快速分流</GroupTitle>
      <div className="fb-banner" style={{ margin: '6px 0 2px' }}>
        <div className="fb-row-desc" style={{ minWidth: 0, flex: 1 }}>
          使用无状态轻量原生模型先判断群聊消息意图：闲聊与确认语直接静默或轻文本回应，不创建会话也不阻塞队列；正式任务安静贴上表情并直接移交当前 Agent 运行时作为 Worker 接管，超时或异常自动回退直通 Worker。
        </div>
      </div>

      <SettingRow title="启用 Router / Worker 分流">
        <Switch
          label="启用 Router / Worker 分流"
          checked={router.enabled}
          onChange={(enabled) => patchRouter({ enabled })}
        />
      </SettingRow>

      {router.enabled && (
        <NestedSettings>
          {nativeGroups.length === 0 && (
            <div className="fb-banner" data-tone="warn" style={{ margin: '4px 0 6px' }}>
              <div className="fb-row-desc" style={{ minWidth: 0, flex: 1 }}>
                当前未检测到可用的 DSH 原生模型服务商，请先在 DSH「设置 → 模型」配置至少一个轻量模型；未就绪期间消息将自动直通 Worker。
              </div>
            </div>
          )}
          <SettingRow title="分流模型" desc="建议选择响应快、低思考的原生模型">
            <SelectMenu
              value={routerModelValue}
              options={routerModelOptions}
              onChange={(nextVal) => {
                if (!nextVal) {
                  patchRouter({ provider: '', model: '' })
                  return
                }
                const sep = nextVal.indexOf('::')
                if (sep > 0) {
                  patchRouter({
                    provider: nextVal.slice(0, sep),
                    model: nextVal.slice(sep + 2),
                  })
                } else {
                  patchRouter({ provider: '', model: nextVal })
                }
              }}
            />
          </SettingRow>
          <SettingRow title="生效范围">
            <SelectMenu
              value={router.scope}
              options={ROUTER_SCOPE_MODES}
              onChange={(scope) => patchRouter({ scope })}
            />
          </SettingRow>
          <SettingRow title="分流超时" desc="超时自动直通 Worker，避免阻塞正式任务">
            <NumberField
              value={Math.round(router.timeoutMs / 1000)}
              min={1}
              onChange={(secs) =>
                patchRouter({ timeoutMs: Math.min(15, Math.max(1, Math.round(secs))) * 1000 })
              }
              suffix="秒"
            />
          </SettingRow>
          <SettingRow
            title="忙碌队列合批"
            desc="Worker 运行期间堆积的多条有效消息自动合并为一轮增量提交"
          >
            <Switch
              label="忙碌队列合批"
              checked={router.coalesceQueuedMessages}
              onChange={(coalesceQueuedMessages) => patchRouter({ coalesceQueuedMessages })}
            />
          </SettingRow>
          <SettingRow title="补充判断规则" desc="可选，追加团队特定的静默或移交约定" stack>
            <TextArea
              value={router.customPrompt}
              onChange={(customPrompt) => patchRouter({ customPrompt })}
              rows={4}
              placeholder="例如：涉及发版审批、数据库变更或线上报错的消息一律移交 Worker；打卡和日常问候静默跳过"
            />
          </SettingRow>
        </NestedSettings>
      )}
    </>
  )
}
