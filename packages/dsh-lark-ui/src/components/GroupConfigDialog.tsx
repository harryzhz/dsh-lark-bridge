import { useEffect, useState } from 'react'
import {
  IconAgentPresetOutlineRegular,
  IconEyeOutlineRegular,
  IconNewChatOutlineRegular,
  IconPersonalizationOutlineRegular,
  IconSettingsOutlineRegular,
  SegmentedControl,
  Switch,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgeApi } from '../api.js'
import {
  BINARY_SWITCH_MODES,
  cloneRouterBypass,
  DEFAULT_ROUTER_BYPASS,
  INTERMEDIATE_MESSAGE_MODES,
  LISTENER_SCOPES,
  MSG_TYPES,
  REPLY_FORMATS,
  REPLY_MODES,
  ROLE_PRESETS,
  SENDER_TYPES,
  SESSION_MODES,
  TRIGGER_MODES,
  withInherit,
} from '../presets.js'
import type {
  BotRecord,
  ChatMemberItem,
  GroupConfig,
  GroupListenerRule,
  GroupRouterConfig,
  GroupRouterMode,
  GroupView,
  ListenerTemplate,
  ModelGroup,
  RuntimeOption,
  TriageDefaultsPayload,
} from '../types.js'
import { AgentRuntimeFields } from './AgentRuntimeFields.js'
import { ConfigDialog, type ConfigSection } from './ConfigDialog.js'
import { DirectoryField } from './DirectoryPickerModal.js'
import {
  Avatar,
  ChipToggles,
  GroupTitle,
  NestedSettings,
  NumberField,
  SelectMenu,
  SettingRow,
  TagInput,
  TextArea,
  TextField,
} from './fields.js'
import {
  effectiveDefaultModel,
  formatRuntimeSummary,
  leafDirectoryLabel,
  normalizeModelAndEffort,
  reactionOptionsWithInherit,
} from './options.js'
import { RuntimeProfilePanel } from './RuntimeProfileDialog.js'
import {
  formatTriageSummary,
  resolveNativeModelLabel,
  TriageConfigFields,
} from './TriageConfigFields.js'

const DEFAULT_GROUP_ROUTER: GroupRouterConfig = {
  mode: 'inherit',
  provider: '',
  model: '',
  scope: 'passive_only',
  bypass: cloneRouterBypass(DEFAULT_ROUTER_BYPASS),
  timeoutMs: 4000,
  maxTriageImages: 5,
  systemPrompt: '',
  recentMessageCount: 6,
  contextTtlMinutes: 30,
  includeLastReply: true,
  coalesceQueuedMessages: true,
}

const GROUP_ROUTER_MODES: ReadonlyArray<{ readonly value: GroupRouterMode; readonly label: string }> = [
  { value: 'inherit', label: '跟随智能体' },
  { value: 'override', label: '独立配置' },
  { value: 'off', label: '关闭' },
]

type Section = 'basic' | 'runtime' | 'conversation' | 'role' | 'listener'

const SECTIONS: readonly ConfigSection<Section>[] = [
  { key: 'basic', label: '基本信息', icon: <IconSettingsOutlineRegular size={16} /> },
  { key: 'runtime', label: 'Agent 运行时', icon: <IconAgentPresetOutlineRegular size={16} /> },
  { key: 'conversation', label: '会话与消息', icon: <IconNewChatOutlineRegular size={16} /> },
  { key: 'role', label: '角色设定', icon: <IconPersonalizationOutlineRegular size={16} /> },
  { key: 'listener', label: '主动监听', icon: <IconEyeOutlineRegular size={16} /> },
]

const RUNTIME_MODES = [
  { value: 'inherit', label: '跟随智能体' },
  { value: 'override', label: '独立配置' },
] as const

const ROLE_MODES = [
  { value: 'inherit', label: '跟随智能体' },
  { value: 'append', label: '追加' },
  { value: 'override', label: '覆盖' },
] as const

export function GroupConfigDialog({
  target,
  bots,
  runtimes,
  models,
  listenerTemplates,
  triageDefaults,
  onClose,
  onSave,
  onProfilesChanged,
}: {
  target: GroupView | null
  bots: readonly BotRecord[]
  runtimes: readonly RuntimeOption[]
  models: readonly ModelGroup[]
  listenerTemplates: readonly ListenerTemplate[]
  triageDefaults?: TriageDefaultsPayload
  onClose: () => void
  onSave: (config: GroupConfig) => Promise<void>
  onProfilesChanged?: () => Promise<void>
}) {
  const [section, setSection] = useState<Section>('basic')
  const [draft, setDraft] = useState<GroupConfig | null>(null)
  const [members, setMembers] = useState<ChatMemberItem[]>([])
  const [loadingMembers, setLoadingMembers] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [profileView, setProfileView] = useState<{ runtimeId: string; initialProfileId?: string } | null>(null)
  const [profileRevision, setProfileRevision] = useState(0)

  useEffect(() => {
    if (!target) return
    setDraft(structuredClone(target.config))
    setSection('basic')
    setProfileView(null)
    setMembers([])
    setError('')
  }, [target])

  useEffect(() => {
    if (!target || section !== 'listener') return
    let cancelled = false
    setLoadingMembers(true)
    void bridgeApi
      .groupMembers(target.botId, target.chatId)
      .then((res) => {
        if (!cancelled) setMembers(res)
      })
      .catch(() => {
        if (!cancelled) setMembers([])
      })
      .finally(() => {
        if (!cancelled) setLoadingMembers(false)
      })
    return () => {
      cancelled = true
    }
  }, [target, section])

  if (!target || !draft) return null
  const bot = bots.find((b) => b.id === draft.botId)
  const patch = (p: Partial<GroupConfig>) => setDraft((prev) => (prev ? { ...prev, ...p } : prev))
  const runtimeMode: 'inherit' | 'override' =
    draft.runtimeMode ??
    (draft.agentPreset || draft.runtimeProfileId || draft.model || draft.reasoningEffort
      ? 'override'
      : 'inherit')
  const overridePreset = draft.agentPreset || bot?.agentPreset || runtimes[0]?.id || 'standard'
  const overrideRuntime = runtimes.find((r) => r.id === overridePreset)
  const profileViewRuntime = profileView ? runtimes.find((r) => r.id === profileView.runtimeId) : undefined
  const inheritedSummary = bot
    ? formatRuntimeSummary(
        bot.agentPreset,
        bot.model,
        bot.reasoningEffort,
        runtimes,
        models,
        bot.runtimeProfileId,
      )
    : '跟随智能体默认运行时'

  const switchRuntimeMode = (nextMode: 'inherit' | 'override') => {
    if (nextMode === 'inherit') {
      patch({
        runtimeMode: 'inherit',
        agentPreset: '',
        runtimeProfileId: '',
        model: '',
        reasoningEffort: '',
      })
      return
    }
    const basePreset = draft.agentPreset || bot?.agentPreset || runtimes.find((r) => r.isDefault)?.id || runtimes[0]?.id || 'standard'
    const baseRuntime = runtimes.find((r) => r.id === basePreset)
    const baseProfileId =
      draft.runtimeProfileId ||
      (basePreset === bot?.agentPreset ? bot?.runtimeProfileId : undefined) ||
      ''
    const baseModel =
      draft.model ||
      (basePreset === bot?.agentPreset ? bot?.model : undefined) ||
      effectiveDefaultModel(baseRuntime, models)
    const baseEffort =
      draft.reasoningEffort ||
      (basePreset === bot?.agentPreset ? bot?.reasoningEffort : undefined) ||
      ''
    patch({
      runtimeMode: 'override',
      agentPreset: basePreset,
      runtimeProfileId: baseProfileId,
      model: baseModel,
      reasoningEffort: baseEffort,
    })
  }

  const save = async () => {
    if (draft.listener.enabled && !draft.listener.prompt.trim()) {
      setSection('listener')
      setError('开启主动监听时需要填写判断指令')
      return
    }
    setSaving(true)
    setError('')
    try {
      const savedDraft =
        runtimeMode === 'override'
          ? (() => {
              const hasProfile = Boolean(draft.runtimeProfileId?.trim())
              const norm = hasProfile
                ? { model: draft.model.trim(), reasoningEffort: draft.reasoningEffort.trim() }
                : normalizeModelAndEffort(
                    overrideRuntime,
                    models,
                    draft.model,
                    draft.reasoningEffort,
                  )
              return {
                ...draft,
                runtimeMode: 'override' as const,
                agentPreset: overridePreset,
                runtimeProfileId: draft.runtimeProfileId?.trim() ?? '',
                model: norm.model,
                reasoningEffort: norm.reasoningEffort,
              }
            })()
          : {
              ...draft,
              runtimeMode: 'inherit' as const,
              agentPreset: '',
              runtimeProfileId: '',
              model: '',
              reasoningEffort: '',
            }
      await onSave(savedDraft)
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('工作目录')) setSection('basic')
      setError(msg)
    } finally {
      setSaving(false)
    }
  }

  return (
    <ConfigDialog
      open
      title={draft.chatName || draft.chatId}
      sections={SECTIONS}
      active={section}
      onSectionChange={setSection}
      onClose={onClose}
      onSave={() => void save()}
      saving={saving}
      error={error}
      subview={
        profileViewRuntime
          ? {
              title: `${profileViewRuntime.name} 启动配置`,
              onBack: () => setProfileView(null),
              content: (
                <RuntimeProfilePanel
                  runtime={profileViewRuntime}
                  initialProfileId={profileView?.initialProfileId}
                  backLabel="Agent 运行时"
                  onBack={() => setProfileView(null)}
                  onClose={onClose}
                  onChanged={async (nextProfileId) => {
                    setProfileRevision((v) => v + 1)
                    await onProfilesChanged?.()
                    if (nextProfileId !== undefined) {
                      const changed = nextProfileId !== (draft.runtimeProfileId ?? '')
                      patch({
                        runtimeMode: 'override',
                        agentPreset: overridePreset,
                        runtimeProfileId: nextProfileId,
                        ...(changed ? { model: '', reasoningEffort: '' } : {}),
                      })
                    }
                  }}
                />
              ),
            }
          : null
      }
    >
      {section === 'basic' && (
        <>
          <SettingRow title="在本群响应" desc={`由智能体「${target.botName}」处理本群消息`}>
            <Switch label="在本群响应" checked={draft.enabled} onChange={(enabled) => patch({ enabled })} />
          </SettingRow>
          <SettingRow title="工作目录" desc="留空继承智能体工作目录">
            <DirectoryField
              value={draft.workingDir}
              onChange={(workingDir) => patch({ workingDir })}
              placeholder={bot?.defaultWorkingDir ?? ''}
              browseSeed={draft.workingDir || bot?.defaultWorkingDir}
            />
          </SettingRow>
          <SettingRow title="工作区" desc="留空默认使用工作目录末级名称">
            <TextField
              value={draft.workspaceName}
              onChange={(workspaceName) => patch({ workspaceName })}
              placeholder={
                (draft.workingDir.trim()
                  ? leafDirectoryLabel(draft.workingDir)
                  : bot?.workspaceName.trim() ||
                    leafDirectoryLabel(bot?.defaultWorkingDir ?? '') ||
                    (!target.config.workspaceName ? target.effectiveWorkspaceName : '')) ||
                '默认使用工作目录名称'
              }
            />
          </SettingRow>
        </>
      )}

      {section === 'runtime' && (
        <>
          <GroupTitle>主运行时</GroupTitle>
          <SettingRow
            title="运行时来源"
            desc={runtimeMode === 'inherit' ? `当前继承：${inheritedSummary}` : undefined}
          >
            <SegmentedControl
              id={`fb-runtime-mode-${draft.key}`}
              label="运行时来源"
              value={runtimeMode}
              options={RUNTIME_MODES}
              onChange={switchRuntimeMode}
            />
          </SettingRow>

          {runtimeMode === 'override' && (
            <AgentRuntimeFields
              value={{
                agentPreset: overridePreset,
                runtimeProfileId: draft.runtimeProfileId ?? '',
                model: draft.model,
                reasoningEffort: draft.reasoningEffort,
              }}
              runtimes={runtimes}
              models={models}
              profileRevision={profileRevision}
              onProfilesChanged={onProfilesChanged}
              onManageProfiles={(rt, pid) =>
                setProfileView({ runtimeId: rt.id, ...(pid ? { initialProfileId: pid } : {}) })
              }
              onChange={({ agentPreset, runtimeProfileId, model, reasoningEffort }) =>
                patch({
                  runtimeMode: 'override',
                  agentPreset,
                  runtimeProfileId: runtimeProfileId?.trim() ?? '',
                  model,
                  reasoningEffort,
                })
              }
            />
          )}

          <GroupTitle>智能分流</GroupTitle>
          {(() => {
            const currentRouter: GroupRouterConfig = {
              ...DEFAULT_GROUP_ROUTER,
              ...(draft.router ?? {}),
              bypass: cloneRouterBypass(draft.router?.bypass),
            }
            const botRouterModelLabel = bot?.router?.model
              ? resolveNativeModelLabel(bot.router.provider, bot.router.model, models)
              : ''
            const emptyGroupModelLabel = botRouterModelLabel
              ? `跟随智能体（${botRouterModelLabel}）`
              : '跟随智能体 / DSH 默认原生模型'
            return (
              <>
                <SettingRow
                  title="分流策略"
                  desc={
                    currentRouter.mode === 'inherit'
                      ? `当前继承：${formatTriageSummary(bot?.router, models)}`
                      : currentRouter.mode === 'off'
                        ? '本群关闭智能分流，消息直接交由主运行时处理'
                        : '用轻量模型前置判断本群消息意图，闲聊静默或轻回复，正式任务直通主运行时'
                  }
                >
                  <SegmentedControl
                    id={`fb-router-mode-${draft.key}`}
                    label="分流策略"
                    value={currentRouter.mode}
                    options={GROUP_ROUTER_MODES}
                    onChange={(nextMode) => {
                      if (nextMode === 'override' && currentRouter.mode !== 'override') {
                        const base = bot?.router
                        patch({
                          router: {
                            mode: 'override',
                            provider: currentRouter.provider || base?.provider || '',
                            model: currentRouter.model || base?.model || '',
                            scope: base?.scope ?? currentRouter.scope,
                            bypass: cloneRouterBypass(base?.bypass ?? currentRouter.bypass),
                            timeoutMs: base?.timeoutMs ?? currentRouter.timeoutMs,
                            maxTriageImages:
                              base?.maxTriageImages ?? currentRouter.maxTriageImages ?? 5,
                            systemPrompt: currentRouter.systemPrompt || base?.systemPrompt || '',
                            recentMessageCount:
                              base?.recentMessageCount ?? currentRouter.recentMessageCount,
                            contextTtlMinutes:
                              base?.contextTtlMinutes ?? currentRouter.contextTtlMinutes,
                            includeLastReply:
                              base?.includeLastReply ?? currentRouter.includeLastReply,
                            coalesceQueuedMessages:
                              base?.coalesceQueuedMessages ?? currentRouter.coalesceQueuedMessages,
                          },
                        })
                        return
                      }
                      patch({ router: { ...currentRouter, mode: nextMode } })
                    }}
                  />
                </SettingRow>
                {currentRouter.mode === 'override' && (
                  <TriageConfigFields
                    value={currentRouter}
                    runtimes={runtimes}
                    models={models}
                    triageDefaults={triageDefaults}
                    emptyModelLabel={emptyGroupModelLabel}
                    onChange={(next) =>
                      patch({ router: { ...currentRouter, mode: 'override', ...next } })
                    }
                  />
                )}
              </>
            )
          })()}
        </>
      )}

      {section === 'conversation' && bot && (
        <GroupConversationAndMessageSection draft={draft} bot={bot} patch={patch} />
      )}

      {section === 'role' && (
        <GroupRoleSection draft={draft} bot={bot} patch={patch} />
      )}

      {section === 'listener' && (
        <ListenerSection
          rule={draft.listener}
          templates={listenerTemplates}
          members={members}
          loadingMembers={loadingMembers}
          onChange={(listener) => patch({ listener })}
        />
      )}
    </ConfigDialog>
  )
}

function isMemberMonitored(rule: GroupListenerRule, member: ChatMemberItem): boolean {
  const overrides = rule.memberOverrides ?? {}
  if (Object.prototype.hasOwnProperty.call(overrides, member.openId)) {
    return Boolean(overrides[member.openId])
  }
  if (rule.senderTypes.length > 0 && !rule.senderTypes.includes(member.memberType)) {
    return false
  }
  if (rule.senderFilterMode === 'include_only') {
    return rule.senderOpenIds.includes(member.openId)
  }
  return !rule.senderOpenIds.includes(member.openId)
}

function ListenerSection({
  rule,
  templates,
  members,
  loadingMembers,
  onChange,
}: {
  rule: GroupListenerRule
  templates: readonly ListenerTemplate[]
  members: readonly ChatMemberItem[]
  loadingMembers: boolean
  onChange: (next: GroupListenerRule) => void
}) {
  const patch = (p: Partial<GroupListenerRule>) => onChange({ ...rule, ...p })
  const activeTemplate =
    templates.find((t) => t.key === rule.templateKey) ??
    templates.find((t) => !rule.templateKey && t.name === rule.name)

  const toggleMember = (member: ChatMemberItem, enabled: boolean) => {
    patch({
      memberOverrides: {
        ...(rule.memberOverrides ?? {}),
        [member.openId]: enabled,
      },
    })
  }

  const batchSetMembers = (predicate: (m: ChatMemberItem) => boolean) => {
    const nextOverrides: Record<string, boolean> = { ...(rule.memberOverrides ?? {}) }
    for (const m of members) {
      nextOverrides[m.openId] = predicate(m)
    }
    patch({ memberOverrides: nextOverrides })
  }

  return (
    <>
      <SettingRow title="启用主动监听" desc="无需 @，自动判断群消息是否需要回复">
        <Switch label="启用主动监听" checked={rule.enabled} onChange={(enabled) => patch({ enabled })} />
      </SettingRow>
      {rule.enabled && (
        <>
          <SettingRow title="场景模板" desc="修改下方指令并保存时将同步更新所选模板">
            <SelectMenu
              value={activeTemplate?.key ?? ''}
              options={[{ value: '', label: '自定义' }, ...templates.map((t) => ({ value: t.key, label: t.label }))]}
              onChange={(key) => {
                if (!key) {
                  patch({ templateKey: '', name: rule.name || '自定义监听' })
                  return
                }
                const t = templates.find((x) => x.key === key)
                if (!t) return
                patch({
                  templateKey: t.key,
                  name: t.name,
                  scope: t.scope,
                  replyMode: t.replyMode,
                  sessionMode: t.sessionMode,
                  autoCloseAfterCompletion: t.autoCloseAfterCompletion,
                  msgTypes: [...t.msgTypes],
                  senderTypes: [...t.senderTypes],
                  prompt: t.prompt,
                  allowSilentEmptyReply: true,
                })
              }}
            />
          </SettingRow>
          <SettingRow
            title="判断指令"
            desc="无需回复时输出空文本即可保持静默"
            stack
          >
            <TextArea
              value={rule.prompt}
              onChange={(prompt) =>
                patch({
                  prompt,
                  ...(activeTemplate && !rule.templateKey ? { templateKey: activeTemplate.key } : {}),
                })
              }
              rows={8}
            />
          </SettingRow>

          <GroupTitle>监听对象</GroupTitle>
          <SettingRow title="群成员与应用" stack>
            {members.length > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="fb-row-desc">
                  已开启 {members.filter((m) => isMemberMonitored(rule, m)).length} / {members.length}
                </span>
                <span className="fb-inline-actions">
                  <button type="button" className="fb-link-btn" onClick={() => batchSetMembers(() => true)}>
                    全开
                  </button>
                  <button type="button" className="fb-link-btn" onClick={() => batchSetMembers((m) => m.memberType === 'user')}>
                    仅成员
                  </button>
                  <button type="button" className="fb-link-btn" onClick={() => batchSetMembers(() => false)}>
                    全关
                  </button>
                </span>
              </div>
            )}

            <div className="fb-member-box">
              {loadingMembers && <div className="fb-row-desc" style={{ padding: '12px 0' }}>正在加载本群成员列表…</div>}
              {!loadingMembers && members.length === 0 && (
                <div className="fb-row-desc" style={{ padding: '12px 0' }}>暂无可展示的其他群成员或应用</div>
              )}
              {!loadingMembers &&
                members.map((m) => {
                  const checked = isMemberMonitored(rule, m)
                  return (
                    <div key={m.openId} className="fb-member-item">
                      <div className="fb-member-left">
                        <Avatar src={m.avatarUrl} name={m.name} kind={m.memberType} size="sm" />
                        <span className="fb-member-name" title={m.openId}>
                          {m.name}
                        </span>
                        {m.memberType === 'bot' && <Tag tone="neutral">应用</Tag>}
                      </div>
                      <Switch
                        label={`监听 ${m.name}`}
                        checked={checked}
                        onChange={(on) => toggleMember(m, on)}
                      />
                    </div>
                  )
                })}
            </div>
          </SettingRow>

          <SettingRow title="新入群默认监听" stack>
            <ChipToggles values={rule.senderTypes} options={SENDER_TYPES} onChange={(senderTypes) => patch({ senderTypes })} />
          </SettingRow>

          <GroupTitle>消息过滤</GroupTitle>
          <SettingRow title="消息位置" desc="「仅群内新消息」会忽略已有话题下的楼中楼回复">
            <SelectMenu value={rule.scope} options={LISTENER_SCOPES} onChange={(scope) => patch({ scope })} />
          </SettingRow>
          <SettingRow title="消息类型" stack>
            <ChipToggles values={rule.msgTypes} options={MSG_TYPES} onChange={(msgTypes) => patch({ msgTypes })} />
          </SettingRow>
          <SettingRow title="包含关键词" desc="命中任一关键词才触发判断，留空不限" stack>
            <TagInput values={rule.includeKeywords} onChange={(includeKeywords) => patch({ includeKeywords })} placeholder="回车添加" />
          </SettingRow>
          <SettingRow title="排除关键词" desc="命中任一排除词直接跳过" stack>
            <TagInput values={rule.excludeKeywords} onChange={(excludeKeywords) => patch({ excludeKeywords })} placeholder="回车添加" />
          </SettingRow>

          <GroupTitle>回复策略</GroupTitle>
          <SettingRow title="回复方式">
            <SelectMenu value={rule.replyMode} options={REPLY_MODES} onChange={(replyMode) => patch({ replyMode })} />
          </SettingRow>
          <SettingRow title="会话策略">
            <SelectMenu value={rule.sessionMode} options={SESSION_MODES} onChange={(sessionMode) => patch({ sessionMode })} />
          </SettingRow>
          <SettingRow title="无需回复时静默" desc="返回空文本时不发消息并自动归档临时会话">
            <Switch label="无需回复时静默" checked={rule.allowSilentEmptyReply} onChange={(allowSilentEmptyReply) => patch({ allowSilentEmptyReply })} />
          </SettingRow>
          <SettingRow title="回复后结束会话" desc="关闭后话题内可免 @ 继续跟进">
            <Switch label="回复后结束会话" checked={rule.autoCloseAfterCompletion} onChange={(autoCloseAfterCompletion) => patch({ autoCloseAfterCompletion })} />
          </SettingRow>
        </>
      )}
    </>
  )
}

function GroupConversationAndMessageSection({
  draft,
  bot,
  patch,
}: {
  draft: GroupConfig
  bot: BotRecord
  patch: (p: Partial<GroupConfig>) => void
}) {
  const idleMode: 'inherit' | 'custom' | 'off' =
    draft.idleCloseMinutes === undefined || draft.idleCloseMinutes === null
      ? 'inherit'
      : draft.idleCloseMinutes === 0
        ? 'off'
        : 'custom'
  const inheritedIdleLabel =
    bot.idleCloseMinutes > 0
      ? `跟随智能体（${bot.idleCloseMinutes} 分钟）`
      : '跟随智能体（不自动归档）'

  const effectiveFormat =
    (draft.replyFormat ?? 'inherit') === 'inherit'
      ? bot.useInteractiveCard
        ? 'card'
        : 'text'
      : draft.replyFormat
  const effectiveUseCard = effectiveFormat === 'card'
  const effectiveSessionLink =
    (draft.dshSessionLinkInCard ?? 'inherit') === 'inherit'
      ? bot.dshSessionLinkInCard
      : draft.dshSessionLinkInCard === 'on'
  const botSignature =
    bot.replyFooterEnabled && bot.replyFooterSignature ? bot.signature.trim() : ''
  const signatureMode = draft.signatureMode ?? 'inherit'

  return (
    <>
      <GroupTitle>触发与会话</GroupTitle>
      <SettingRow title="触发方式">
        <SelectMenu
          value={draft.mentionTriggerMode ?? 'inherit'}
          options={withInherit(TRIGGER_MODES, bot.mentionTriggerMode)}
          onChange={(mentionTriggerMode) => patch({ mentionTriggerMode })}
        />
      </SettingRow>
      <SettingRow title="会话策略">
        <SelectMenu
          value={draft.sessionMode}
          options={withInherit(SESSION_MODES, bot.groupSessionMode)}
          onChange={(sessionMode) => patch({ sessionMode })}
        />
      </SettingRow>
      <SettingRow title="空闲自动归档">
        <SelectMenu
          value={idleMode}
          options={[
            { value: 'inherit', label: inheritedIdleLabel },
            { value: 'custom', label: '自定义时长' },
            { value: 'off', label: '不自动归档' },
          ]}
          onChange={(next) => {
            if (next === 'inherit') patch({ idleCloseMinutes: null })
            else if (next === 'off') patch({ idleCloseMinutes: 0 })
            else patch({ idleCloseMinutes: bot.idleCloseMinutes > 0 ? bot.idleCloseMinutes : 720 })
          }}
        />
      </SettingRow>
      {idleMode === 'custom' && (
        <NestedSettings>
          <SettingRow title="归档时长">
            <NumberField
              value={draft.idleCloseMinutes ?? 720}
              min={1}
              onChange={(mins) => patch({ idleCloseMinutes: Math.max(1, mins) })}
              suffix="分钟"
            />
          </SettingRow>
        </NestedSettings>
      )}

      <GroupTitle>回复与反馈</GroupTitle>
      <SettingRow title="回复方式">
        <SelectMenu
          value={draft.replyMode}
          options={withInherit(REPLY_MODES, bot.groupReplyMode)}
          onChange={(replyMode) => patch({ replyMode })}
        />
      </SettingRow>
      <SettingRow title="收到消息时的表情">
        <SelectMenu
          value={draft.receivedReactionEmoji || 'inherit'}
          options={reactionOptionsWithInherit(bot.receivedReactionEmoji)}
          onChange={(receivedReactionEmoji) => patch({ receivedReactionEmoji })}
        />
      </SettingRow>
      <SettingRow title="发送中间过程消息">
        <SelectMenu
          value={draft.intermediateMessages ?? 'inherit'}
          options={withInherit(
            INTERMEDIATE_MESSAGE_MODES,
            bot.sendIntermediateMessages ? 'on' : 'off',
          )}
          onChange={(intermediateMessages) => patch({ intermediateMessages })}
        />
      </SettingRow>

      <GroupTitle>消息卡片</GroupTitle>
      <SettingRow title="使用消息卡片">
        <SelectMenu
          value={draft.replyFormat ?? 'inherit'}
          options={withInherit(REPLY_FORMATS, bot.useInteractiveCard ? 'card' : 'text')}
          onChange={(replyFormat) => patch({ replyFormat })}
        />
      </SettingRow>
      {effectiveUseCard && (
        <>
          <SettingRow title="附带会话链接">
            <SelectMenu
              value={draft.dshSessionLinkInCard ?? 'inherit'}
              options={withInherit(BINARY_SWITCH_MODES, bot.dshSessionLinkInCard ? 'on' : 'off')}
              onChange={(dshSessionLinkInCard) => patch({ dshSessionLinkInCard })}
            />
          </SettingRow>
          {effectiveSessionLink && (
            <NestedSettings>
              <SettingRow title="允许群成员只读查看">
                <SelectMenu
                  value={draft.sessionLinkGuestReadOnly ?? 'inherit'}
                  options={withInherit(
                    BINARY_SWITCH_MODES,
                    bot.sessionLinkGuestReadOnly ? 'on' : 'off',
                  )}
                  onChange={(sessionLinkGuestReadOnly) => patch({ sessionLinkGuestReadOnly })}
                />
              </SettingRow>
            </NestedSettings>
          )}
          <SettingRow title="显示模型信息">
            <SelectMenu
              value={draft.replyFooterModel ?? 'inherit'}
              options={withInherit(
                BINARY_SWITCH_MODES,
                bot.replyFooterEnabled && bot.replyFooterModel ? 'on' : 'off',
              )}
              onChange={(replyFooterModel) => patch({ replyFooterModel })}
            />
          </SettingRow>
          <SettingRow
            title="卡片底部签名"
            desc={signatureMode === 'inherit' && botSignature ? `当前继承：「${botSignature}」` : undefined}
          >
            <SelectMenu
              value={signatureMode}
              options={[
                {
                  value: 'inherit',
                  label: botSignature ? '跟随智能体（已设签名）' : '跟随智能体（不展示）',
                },
                { value: 'custom', label: '自定义签名' },
                { value: 'off', label: '不展示' },
              ]}
              onChange={(nextMode) =>
                patch({
                  signatureMode: nextMode,
                  ...(nextMode === 'custom' && !(draft.signature ?? '').trim() && botSignature
                    ? { signature: botSignature }
                    : {}),
                })
              }
            />
          </SettingRow>
          {signatureMode === 'custom' && (
            <NestedSettings>
              <SettingRow title="签名内容">
                <TextField
                  value={draft.signature ?? ''}
                  onChange={(signature) => patch({ signature })}
                  placeholder={bot.signature.trim() || '例如 AI 回复仅供参考'}
                />
              </SettingRow>
            </NestedSettings>
          )}
        </>
      )}
    </>
  )
}

function GroupRoleSection({
  draft,
  bot,
  patch,
}: {
  draft: GroupConfig
  bot: BotRecord | undefined
  patch: (p: Partial<GroupConfig>) => void
}) {
  const botRoleActive = Boolean(
    bot?.role.enabled && (bot.role.name.trim() || bot.role.systemPrompt.trim()),
  )
  const botPresetLabel = bot?.role.presetKey
    ? ROLE_PRESETS.find((p) => p.key === bot.role.presetKey)?.label
    : undefined
  const botRolePrompt = bot
    ? bot.role.systemPrompt.trim() ||
      (bot.role.name.trim() ? `你的角色是：${bot.role.name.trim()}` : '')
    : ''
  const presetOptions = [
    { value: '', label: '自定义' },
    ...ROLE_PRESETS.map((p) => ({ value: p.key, label: p.label })),
  ]

  return (
    <>
      <SettingRow
        title="角色来源"
        desc={
          draft.role.mode === 'append'
            ? '在智能体角色之后追加本群设定'
            : draft.role.mode === 'override'
              ? '忽略智能体角色，仅使用本群设定'
              : undefined
        }
      >
        <SegmentedControl
          id={`fb-role-mode-${draft.key}`}
          label="角色来源"
          value={draft.role.mode}
          options={ROLE_MODES}
          onChange={(mode) => patch({ role: { ...draft.role, mode } })}
        />
      </SettingRow>

      {draft.role.mode === 'inherit' &&
        (botRoleActive && bot ? (
          <>
            <SettingRow title="模板">
              <SelectMenu
                value={bot.role.presetKey ?? ''}
                options={presetOptions}
                disabled
                onChange={() => {}}
              />
            </SettingRow>
            <SettingRow title="角色名称">
              <TextField value={bot.role.name || '（未命名）'} disabled onChange={() => {}} />
            </SettingRow>
            <SettingRow title="角色提示词" stack>
              <TextArea value={botRolePrompt} rows={8} readOnly onChange={() => {}} />
            </SettingRow>
          </>
        ) : (
          <div className="fb-banner" style={{ marginTop: 12 }}>
            <span className="fb-row-desc">
              {`智能体「${bot?.name ?? draft.botId}」未启用角色设定；如需单独配置可切换为「追加」或「覆盖」。`}
            </span>
          </div>
        ))}

      {draft.role.mode !== 'inherit' && (
        <>
          {draft.role.mode === 'append' &&
            (botRoleActive && bot ? (
              <SettingRow
                title="基础角色预览"
                desc={`来自「${bot.name}」${bot.role.name.trim() ? ` · ${bot.role.name.trim()}` : ''}${botPresetLabel ? `（${botPresetLabel}）` : ''}`}
                stack
              >
                <TextArea value={botRolePrompt} rows={5} readOnly onChange={() => {}} />
              </SettingRow>
            ) : (
              <div className="fb-banner" style={{ marginTop: 12, marginBottom: 4 }}>
                <span className="fb-row-desc">
                  {`智能体「${bot?.name ?? draft.botId}」未启用基础角色，将仅注入下方本群设定。`}
                </span>
              </div>
            ))}
          <SettingRow title="模板">
            <SelectMenu
              value={draft.role.presetKey ?? ''}
              options={presetOptions}
              onChange={(key) => {
                const preset = ROLE_PRESETS.find((p) => p.key === key)
                patch({
                  role: preset
                    ? {
                        ...draft.role,
                        presetKey: preset.key,
                        name: preset.roleName,
                        systemPrompt: preset.systemPrompt,
                      }
                    : { ...draft.role, presetKey: undefined },
                })
              }}
            />
          </SettingRow>
          <SettingRow title="角色名称">
            <TextField
              value={draft.role.name}
              onChange={(name) => patch({ role: { ...draft.role, name } })}
              placeholder={
                draft.role.mode === 'append' && botRoleActive && bot?.role.name.trim()
                  ? `留空沿用「${bot.role.name.trim()}」`
                  : '例如 研发协作搭档'
              }
            />
          </SettingRow>
          <SettingRow
            title={draft.role.mode === 'append' ? '追加设定' : '角色提示词'}
            stack
          >
            <TextArea
              value={draft.role.systemPrompt}
              onChange={(systemPrompt) => patch({ role: { ...draft.role, systemPrompt } })}
              rows={8}
              placeholder="补充本群项目范围、回答风格与协作边界"
            />
          </SettingRow>
        </>
      )}
    </>
  )
}
