import { Button, StateDot, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { Avatar, OverflowMenu } from '../components/fields.js'
import { resolveModelDisplayName, resolveRuntimeDisplayName } from '../components/options.js'
import type { BotRecord, ModelGroup, RuntimeOption } from '../types.js'

export interface BotActions {
  edit: (bot: BotRecord) => void
  toggle: (bot: BotRecord) => void
  reconnect: (bot: BotRecord) => void
  syncProfile: (bot: BotRecord) => void
  syncChats: (bot: BotRecord) => void
  remove: (bot: BotRecord) => void
}

export function BotsView({
  bots,
  runtimes,
  models,
  actions,
}: {
  bots: readonly BotRecord[]
  runtimes: readonly RuntimeOption[]
  models: readonly ModelGroup[]
  actions: BotActions
}) {
  if (bots.length === 0) {
    return <div className="fb-card fb-empty">还没有智能体，点击右上角「新增智能体」自动创建或接入飞书应用</div>
  }
  return (
    <div className="fb-card fb-list">
      {bots.map((bot) => {
        const connected = Boolean(bot.status?.connected)
        const runtime = resolveRuntimeDisplayName(bot.agentPreset, runtimes, bot.runtimeProfileId)
        const modelLabel = resolveModelDisplayName(bot.agentPreset, bot.model, runtimes, models)
        const avatarUrl = bot.avatarUrl || bot.status?.avatarUrl
        const dreamEnabled = Boolean(bot.experimental?.dreaming?.enabled)
        const proactiveEnabled = Boolean(
          bot.experimental?.proactive?.remindersEnabled ||
            bot.experimental?.proactive?.autoCodeEnabled,
        )
        const routerEnabled = Boolean(bot.router?.enabled)
        return (
          <div key={bot.id} className="fb-item">
            <Avatar src={avatarUrl} name={bot.name} kind="bot" />
            <div className="fb-item-main">
              <div className="fb-item-title">
                <span>{bot.name}</span>
                <StateDot state={connected ? 'done' : bot.enabled ? 'error' : 'idle'} />
                {routerEnabled && <Tag tone="neutral">智能分流</Tag>}
                {dreamEnabled && <Tag tone="info">Dreaming</Tag>}
                {proactiveEnabled && <Tag tone="neutral">主动工作</Tag>}
              </div>
              <div className="fb-item-meta" title={bot.status?.lastError || bot.description}>
                {bot.status?.lastError && bot.enabled && !connected
                  ? bot.status.lastError
                  : [
                      `${runtime}${modelLabel ? ` · ${modelLabel}` : ''}`,
                      `工作区 ${bot.effectiveWorkspaceName}`,
                      `${bot.configuredGroupCount} 个群`,
                      bot.description || null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
              </div>
            </div>
            <div className="fb-item-side">
              <Switch label={`启用 ${bot.name}`} checked={bot.enabled} onChange={() => actions.toggle(bot)} />
              <Button size="sm" variant="outline" onClick={() => actions.edit(bot)}>
                配置
              </Button>
              <OverflowMenu
                label={`${bot.name} 更多操作`}
                items={[
                  { id: 'sync-profile', label: '同步飞书信息', onSelect: () => actions.syncProfile(bot) },
                  { id: 'sync', label: '同步群聊', onSelect: () => actions.syncChats(bot) },
                  { id: 'reconnect', label: '重新连接', onSelect: () => actions.reconnect(bot) },
                  { type: 'separator', id: 'sep' },
                  { id: 'delete', label: '删除', danger: true, onSelect: () => actions.remove(bot) },
                ]}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
