import { useState } from 'react'
import {
  Button,
  IconPlayOutlineRegular,
  StateDot,
  Switch,
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

export function ExperimentalSection({
  botId,
  experimental,
  dreamState,
  onChange,
  onOpenSession,
  onStateUpdated,
}: {
  botId: string | null
  experimental: BotExperimentalConfig
  dreamState?: DreamRunState | undefined
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
  const statusDot =
    isRunning
      ? 'ongoing'
      : dreamState?.status === 'succeeded'
        ? 'done'
        : dreamState?.status === 'failed'
          ? 'error'
          : 'idle'

  const statusLine = runError
    ? `运行异常：${runError}`
    : dreamState?.lastSummary
      ? `最近整理：${dreamState.lastDreamAtMs ? `${formatTime(dreamState.lastDreamAtMs)} · ` : ''}${dreamState.lastSummary}`
      : ''

  return (
    <>
      <GroupTitle>Dreaming 记忆整理</GroupTitle>
      <div className="fb-banner" style={{ margin: '6px 0 2px' }}>
        <div className="fb-row-desc" style={{ minWidth: 0, flex: 1 }}>
          <div>
            到达整理时间且新增会话达到阈值后，自动汇总近期增量对话摘要并结合代码库变更唤醒智能体，调用其自身长期记忆机制提炼关键认知、合并重复项并清理纠偏过期内容。
          </div>
          {statusLine && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
              <StateDot state={statusDot} />
              <span>{statusLine}</span>
            </div>
          )}
        </div>
        {botId && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
            {dreamState?.lastSessionId && onOpenSession && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onOpenSession(dreamState.lastSessionId!)}
              >
                查看会话
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
    </>
  )
}
