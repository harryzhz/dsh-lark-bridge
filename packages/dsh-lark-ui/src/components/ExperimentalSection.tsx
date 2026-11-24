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
import { DEFAULT_DREAMING_SCOPES, REMINDER_CREATION_MODES } from '../presets.js'
import { formatTime } from '../state.js'
import type {
  BotDreamingConfig,
  BotExperimentalConfig,
  BotProactiveConfig,
  DreamRunState,
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
    const countMatch = /^已整理\s+(\d+)\s+个会话(?:（([^）]+)）)?(?:\s*·\s*)?([\s\S]*)$/.exec(rawSummary)
    const count = dreamState.lastProcessedCount ?? (countMatch ? Number(countMatch[1]) : undefined)
    const mutationTag = countMatch?.[2]?.trim() || ''
    const detail = (countMatch ? (countMatch[3] ?? '') : rawSummary).trim()
    const titleParts = [
      timeLabel ? `最近整理 ${timeLabel}` : '最近整理已完成',
      count !== undefined ? `已整理 ${count} 个会话` : null,
      mutationTag || null,
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
  activeMemoryCount,
  onChange,
  onOpenMemory,
  onOpenSession,
  onStateUpdated,
}: {
  botId: string | null
  experimental: BotExperimentalConfig
  dreamState?: DreamRunState | undefined
  activeMemoryCount?: number | undefined
  onChange: (next: BotExperimentalConfig) => void
  onOpenMemory?: (() => void) | undefined
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

  return (
    <>
      <GroupTitle>Dreaming 与长期记忆</GroupTitle>
      <div className="fb-dream-card">
        <div className="fb-dream-head">
          <div className="fb-dream-desc">
            基于跨运行时 Bridge Memory 持久库（渐进披露首轮注入 + 双时态纠偏）。到达整理时间且有效新增会话达到阈值后，自动盘点增量对话并结合活跃代码库变更沉淀长期认知、纠偏与归档过期项。
          </div>
          {botId && (
            <div className="fb-dream-actions">
              {onOpenMemory && (
                <Button size="sm" variant="outline" onClick={onOpenMemory}>
                  {`记忆库 (${activeMemoryCount ?? 0})`}
                </Button>
              )}
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
                  ...(proactive.quietHoursStart ? {} : { quietHoursStart: '23:00' }),
                  ...(proactive.quietHoursEnd ? {} : { quietHoursEnd: '09:00' }),
                })
              }
            />
          </SettingRow>
          {proactive.quietHoursEnabled && (
            <NestedSettings>
              <SettingRow title="开始时间" desc="本地时间（HH:MM）">
                <TextField
                  value={proactive.quietHoursStart || '23:00'}
                  onChange={(quietHoursStart) => patchProactive({ quietHoursStart })}
                  placeholder="23:00"
                  mono
                />
              </SettingRow>
              <SettingRow title="结束时间" desc="本地时间（HH:MM）">
                <TextField
                  value={proactive.quietHoursEnd || '09:00'}
                  onChange={(quietHoursEnd) => patchProactive({ quietHoursEnd })}
                  placeholder="09:00"
                  mono
                />
              </SettingRow>
            </NestedSettings>
          )}
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
