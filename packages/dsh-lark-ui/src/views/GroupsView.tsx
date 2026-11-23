import { useMemo, useState } from 'react'
import { Button, IconSearchOutlineRegular, Input, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { Avatar, OverflowMenu, SelectMenu } from '../components/fields.js'
import { resolveModelDisplayName, resolveRuntimeDisplayName } from '../components/options.js'
import { choiceLabel, REPLY_MODES, TRIGGER_MODES } from '../presets.js'
import type { BotRecord, GroupView, ModelGroup, RuntimeOption } from '../types.js'

export interface GroupActions {
  edit: (group: GroupView) => void
  setEnabled: (group: GroupView, enabled: boolean) => void
  reset: (group: GroupView) => void
}

export function GroupsView({
  groups,
  bots,
  runtimes,
  models,
  actions,
}: {
  groups: readonly GroupView[]
  bots: readonly BotRecord[]
  runtimes: readonly RuntimeOption[]
  models: readonly ModelGroup[]
  actions: GroupActions
}) {
  const [query, setQuery] = useState('')
  const [botId, setBotId] = useState('')

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return groups.filter(
      (g) =>
        (!botId || g.botId === botId) &&
        (!q || g.chatName.toLowerCase().includes(q) || g.chatId.toLowerCase().includes(q)),
    )
  }, [groups, query, botId])

  return (
    <>
      <div className="fb-toolbar">
        <Input
          className="fb-search"
          icon={<IconSearchOutlineRegular size={16} />}
          placeholder="搜索群名称或 Chat ID"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {bots.length > 1 && (
          <SelectMenu
            value={botId}
            options={[{ value: '', label: '全部智能体' }, ...bots.map((b) => ({ value: b.id, label: b.name }))]}
            onChange={setBotId}
          />
        )}
      </div>

      <div className="fb-card fb-list">
        {visible.length === 0 && (
          <div className="fb-empty">{groups.length === 0 ? '把智能体拉进飞书群后，点击「同步群聊」即可在这里配置' : '没有匹配的群聊'}</div>
        )}
        {visible.map((g) => {
          const cfg = g.config
          const bot = bots.find((b) => b.id === g.botId)
          const effectivePreset = g.effectiveAgentPreset || cfg.agentPreset || bot?.agentPreset || ''
          const effectiveProfileId =
            g.effectiveRuntimeProfileId ??
            (g.runtimeSource === 'group' ? cfg.runtimeProfileId || undefined : bot?.runtimeProfileId)
          const effectiveModel =
            g.effectiveModel ?? (g.runtimeSource === 'group' ? cfg.model || undefined : bot?.model)
          const runtimeLabel = effectivePreset
            ? resolveRuntimeDisplayName(effectivePreset, runtimes, effectiveProfileId)
            : ''
          const modelLabel = effectivePreset
            ? resolveModelDisplayName(effectivePreset, effectiveModel, runtimes, models)
            : ''
          const reply = cfg.replyMode === 'inherit' ? null : choiceLabel(REPLY_MODES, cfg.replyMode)
          const trigger =
            !cfg.mentionTriggerMode || cfg.mentionTriggerMode === 'inherit'
              ? null
              : choiceLabel(TRIGGER_MODES, cfg.mentionTriggerMode)
          const cardOverride =
            !cfg.replyFormat || cfg.replyFormat === 'inherit'
              ? null
              : cfg.replyFormat === 'card'
                ? '消息卡片'
                : '纯文本'
          return (
            <div key={g.key} className="fb-item">
              <Avatar src={g.avatar} name={g.chatName} kind="group" />
              <div className="fb-item-main">
                <div className="fb-item-title">
                  <span title={g.chatName}>{g.chatName}</span>
                  {g.runtimeSource === 'group' && <Tag tone="neutral">独立运行时</Tag>}
                  {cfg.router?.mode === 'override' && <Tag tone="neutral">独立分流</Tag>}
                  {cfg.router?.mode === 'off' && bot?.router?.enabled && (
                    <Tag tone="neutral">已关分流</Tag>
                  )}
                  {cfg.listener.enabled && <Tag tone="info">监听中</Tag>}
                  {!g.inChat && <Tag tone="warning">智能体不在群内</Tag>}
                </div>
                <div className="fb-item-meta">
                  {[
                    bots.length > 1 ? g.botName : null,
                    runtimeLabel ? `${runtimeLabel}${modelLabel ? ` · ${modelLabel}` : ''}` : null,
                    `工作区 ${g.effectiveWorkspaceName}`,
                    reply,
                    trigger,
                    cardOverride,
                    g.activeSessionCount > 0 ? `${g.activeSessionCount} 个活跃会话` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              <div className="fb-item-side">
                <Switch label={`在 ${g.chatName} 响应`} checked={cfg.enabled} onChange={(on) => actions.setEnabled(g, on)} />
                <Button size="sm" variant="outline" onClick={() => actions.edit(g)}>
                  配置
                </Button>
                <OverflowMenu
                  label={`${g.chatName} 更多操作`}
                  items={[
                    { id: 'copy', label: '复制 Chat ID', onSelect: () => void navigator.clipboard?.writeText(g.chatId) },
                    ...(g.configured ? [{ id: 'reset', label: '恢复默认配置', danger: true, onSelect: () => actions.reset(g) }] : []),
                  ]}
                />
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}
