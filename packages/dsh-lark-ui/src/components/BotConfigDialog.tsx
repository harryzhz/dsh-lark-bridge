import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button,
  IconAgentPresetOutlineRegular,
  IconCloseOutlineRegular,
  IconNewChatOutlineRegular,
  IconPersonalizationOutlineRegular,
  IconRefreshOutlineRegular,
  IconSettingsOutlineRegular,
  IconSparkleRegular,
  IconUsersOutlineRegular,
  Modal,
  SegmentedControl,
  Switch,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgeApi } from '../api.js'
import {
  ACCESS_MODES,
  cloneRouterBypass,
  DEFAULT_DREAMING_SCOPES,
  DEFAULT_ROUTER_BYPASS,
  DISCLOSURE_MODES,
  P2P_SESSION_MODES,
  REPLY_MODES,
  ROLE_PRESETS,
  SESSION_MODES,
  TRIGGER_MODES,
} from '../presets.js'
import type {
  AuthStatusPayload,
  BaselineEventSyncResult,
  BotConfig,
  BotDreamingConfig,
  BotProactiveConfig,
  BotRecord,
  BotRouterConfig,
  DreamRunState,
  ModelGroup,
  OpenPlatformAppItem,
  QrJobView,
  RuntimeOption,
  SubstituteTarget,
  TriageDefaultsPayload,
} from '../types.js'
import { AgentRuntimeFields } from './AgentRuntimeFields.js'
import { BotMemoryPanel } from './BotMemoryPanel.js'
import { ConfigDialog, type ConfigSection } from './ConfigDialog.js'
import { DirectoryField } from './DirectoryPickerModal.js'
import { ExperimentalSection } from './ExperimentalSection.js'
import {
  Avatar,
  GroupTitle,
  NestedSettings,
  NumberField,
  SelectMenu,
  SettingRow,
  TextArea,
  TextField,
} from './fields.js'
import { OpenPlatformAppPicker } from './OpenPlatformAppPicker.js'
import {
  effectiveDefaultModel,
  leafDirectoryLabel,
  normalizeModelAndEffort,
  reactionOptions,
} from './options.js'
import { RuntimeProfilePanel } from './RuntimeProfileDialog.js'
import { TriageConfigFields } from './TriageConfigFields.js'
import { UserSearchPicker } from './UserSearchPicker.js'

type Section = 'basic' | 'runtime' | 'conversation' | 'role' | 'access' | 'experimental'

const SECTIONS: readonly ConfigSection<Section>[] = [
  { key: 'basic', label: '基本信息', icon: <IconSettingsOutlineRegular size={16} /> },
  { key: 'runtime', label: 'Agent 运行时', icon: <IconAgentPresetOutlineRegular size={16} /> },
  { key: 'conversation', label: '会话与消息', icon: <IconNewChatOutlineRegular size={16} /> },
  { key: 'role', label: '角色设定', icon: <IconPersonalizationOutlineRegular size={16} /> },
  { key: 'access', label: '权限与代答', icon: <IconUsersOutlineRegular size={16} /> },
  { key: 'experimental', label: '实验性', icon: <IconSparkleRegular size={16} /> },
]

export const DEFAULT_DREAMING_CONFIG: BotDreamingConfig = {
  enabled: false,
  scheduleTime: '02:00',
  minNewSessions: 2,
  scopes: [...DEFAULT_DREAMING_SCOPES],
  cleanupAndCorrect: true,
}

export const DEFAULT_PROACTIVE_CONFIG: BotProactiveConfig = {
  remindersEnabled: false,
  reminderCreationMode: 'silent',
  quietHoursEnabled: false,
  quietHoursStart: '23:00',
  quietHoursEnd: '09:00',
  autoCodeEnabled: false,
  branchPrefix: 'agent/',
}

export const DEFAULT_ROUTER_CONFIG: BotRouterConfig = {
  enabled: false,
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

export function newBotConfig(
  defaultRuntime: RuntimeOption | undefined,
  models: readonly ModelGroup[] = [],
): BotConfig {
  return {
    id: '',
    name: '',
    enabled: true,
    larkAppId: '',
    larkAppSecret: '',
    avatarUrl: '',
    description: '',
    agentPreset: defaultRuntime?.id ?? 'standard',
    runtimeProfileId: '',
    model: effectiveDefaultModel(defaultRuntime, models),
    reasoningEffort: '',
    defaultWorkingDir: '~',
    workspaceName: '',
    groupReplyMode: 'new-topic',
    groupSessionMode: 'thread',
    mentionTriggerMode: 'mention_and_active_thread',
    groupAccessMode: 'all_joined',
    p2pEnabled: true,
    p2pSessionMode: 'chat',
    allowedUsers: [],
    allowedUserProfiles: [],
    adminUsers: [],
    adminUserProfiles: [],
    sendIntermediateMessages: false,
    useInteractiveCard: true,
    dshSessionLinkInCard: true,
    sessionLinkGuestReadOnly: true,
    replyFooterEnabled: true,
    replyFooterModel: true,
    replyFooterSignature: true,
    signature: '',
    receivedReactionEmoji: 'OnIt',
    idleCloseMinutes: 720,
    role: { enabled: false, name: '', systemPrompt: '' },
    substituteMode: { enabled: false, targets: [], disclosure: 'none', activeThreadFollowup: true },
    router: { ...DEFAULT_ROUTER_CONFIG, bypass: cloneRouterBypass(DEFAULT_ROUTER_BYPASS) },
    experimental: {
      dreaming: { ...DEFAULT_DREAMING_CONFIG, scopes: [...DEFAULT_DREAMING_CONFIG.scopes] },
      proactive: { ...DEFAULT_PROACTIVE_CONFIG },
    },
  }
}

/** Strip read-only view fields so the PUT body only carries configuration. */
function toBotConfig(record: BotRecord): BotConfig {
  const {
    hasSecret: _h,
    effectiveWorkspaceName: _e,
    configuredGroupCount: _c,
    activeMemoryCount: _m,
    status: _s,
    dreamState: _d,
    ...config
  } = record
  const cloned = structuredClone(config)
  return {
    ...cloned,
    larkAppSecret: '',
    adminUsers: cloned.adminUsers ?? [],
    adminUserProfiles: cloned.adminUserProfiles ?? [],
    sessionLinkGuestReadOnly: cloned.sessionLinkGuestReadOnly ?? true,
    router: {
      ...DEFAULT_ROUTER_CONFIG,
      ...(cloned.router ?? {}),
      bypass: cloneRouterBypass(cloned.router?.bypass),
    },
    experimental: {
      dreaming: {
        ...DEFAULT_DREAMING_CONFIG,
        ...(cloned.experimental?.dreaming ?? {}),
        scopes: cloned.experimental?.dreaming?.scopes?.length
          ? [...cloned.experimental.dreaming.scopes]
          : [...DEFAULT_DREAMING_CONFIG.scopes],
      },
      proactive: {
        ...DEFAULT_PROACTIVE_CONFIG,
        ...(cloned.experimental?.proactive ?? {}),
      },
    },
  }
}

function generateFallbackBotId(name: string, larkAppId: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (ascii) return ascii
  const suffix = larkAppId
    .toLowerCase()
    .replace(/^cli_/, '')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 6)
  return `bot-${suffix || Date.now().toString(36).slice(-6)}`
}

export function BotConfigDialog({
  target,
  bots,
  runtimes,
  models,
  triageDefaults,
  auth,
  onClose,
  onSave,
  onAutoCreated,
  onExistingImported,
  onRefresh,
  onProfilesChanged,
  onAuthUpdated,
  onOpenAuth,
  onOpenSession,
}: {
  target: BotRecord | 'new' | null
  bots: readonly BotRecord[]
  runtimes: readonly RuntimeOption[]
  models: readonly ModelGroup[]
  triageDefaults?: TriageDefaultsPayload
  auth: AuthStatusPayload | null
  onClose: () => void
  onSave: (config: BotConfig, existingId: string | null) => Promise<void>
  onAutoCreated: () => Promise<void>
  onExistingImported: (botName: string, eventSync?: BaselineEventSyncResult) => Promise<void>
  onRefresh: () => Promise<void>
  onProfilesChanged?: () => Promise<void>
  onAuthUpdated: () => Promise<void>
  onOpenAuth: () => void
  onOpenSession?: (sessionId: string) => void
}) {
  if (!target) return null
  if (target === 'new') {
    return (
      <CreateBotDialog
        bots={bots}
        runtimes={runtimes}
        models={models}
        auth={auth}
        onClose={onClose}
        onSave={onSave}
        onAutoCreated={onAutoCreated}
        onExistingImported={onExistingImported}
        onProfilesChanged={onProfilesChanged}
        onAuthUpdated={onAuthUpdated}
      />
    )
  }
  return (
    <EditBotDialog
      target={target}
      runtimes={runtimes}
      models={models}
      triageDefaults={triageDefaults}
      auth={auth}
      onClose={onClose}
      onSave={onSave}
      onSynced={onRefresh}
      onProfilesChanged={onProfilesChanged}
      onOpenAuth={onOpenAuth}
      onOpenSession={onOpenSession}
    />
  )
}

function useOpenPlatformAppsState(
  isOpAuthenticated: boolean,
  onAuthUpdated: () => Promise<void>,
) {
  const [loginJob, setLoginJob] = useState<QrJobView | null>(null)
  const [startingLogin, setStartingLogin] = useState(false)
  const [apps, setApps] = useState<OpenPlatformAppItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [selectedAppId, setSelectedAppId] = useState('')

  const refreshApps = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const res = await bridgeApi.openPlatformApps()
      if (!res.authenticated) {
        setApps([])
        setLoaded(false)
        setSelectedAppId('')
        await onAuthUpdated()
        return
      }
      setApps(res.apps)
      setLoaded(true)
      setSelectedAppId((prev) =>
        prev && res.apps.some((a) => a.appId === prev && !a.alreadyConnected) ? prev : '',
      )
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [onAuthUpdated])

  useEffect(() => {
    if (!isOpAuthenticated) {
      setApps([])
      setLoaded(false)
      setSelectedAppId('')
      return
    }
    if (!loaded && !loading) {
      void refreshApps()
    }
  }, [isOpAuthenticated, loaded, loading, refreshApps])

  useEffect(() => {
    if (!loginJob || !['waiting_scan', 'scanned', 'working'].includes(loginJob.status)) return
    const timer = window.setInterval(async () => {
      try {
        const next = await bridgeApi.pollAuthJob(loginJob.jobId)
        setLoginJob(next)
        if (next.status === 'succeeded') {
          await onAuthUpdated()
          setLoginJob(null)
          await refreshApps()
        }
      } catch {
        // Ignore transient polling error.
      }
    }, 1500)
    return () => window.clearInterval(timer)
  }, [loginJob, onAuthUpdated, refreshApps])

  const startLogin = useCallback(async () => {
    setStartingLogin(true)
    try {
      setLoginJob(await bridgeApi.startOpenPlatformLogin())
    } finally {
      setStartingLogin(false)
    }
  }, [])

  return {
    apps,
    loading,
    loadError,
    selectedAppId,
    setSelectedAppId,
    loginJob,
    startingLogin,
    refreshApps,
    startLogin,
  }
}

function CreateBotDialog({
  bots,
  runtimes,
  models,
  auth,
  onClose,
  onSave,
  onAutoCreated,
  onExistingImported,
  onProfilesChanged,
  onAuthUpdated,
}: {
  bots: readonly BotRecord[]
  runtimes: readonly RuntimeOption[]
  models: readonly ModelGroup[]
  auth: AuthStatusPayload | null
  onClose: () => void
  onSave: (config: BotConfig, existingId: string | null) => Promise<void>
  onAutoCreated: () => Promise<void>
  onExistingImported: (botName: string, eventSync?: BaselineEventSyncResult) => Promise<void>
  onProfilesChanged?: () => Promise<void>
  onAuthUpdated: () => Promise<void>
}) {
  const [createMode, setCreateMode] = useState<'auto' | 'existing'>('auto')
  const [autoProtocol, setAutoProtocol] = useState<'open_platform' | 'device_flow'>('open_platform')
  const [existingSource, setExistingSource] = useState<'open_platform' | 'manual'>('open_platform')
  const [syncBaselineEvents, setSyncBaselineEvents] = useState(false)
  const [draft, setDraft] = useState<BotConfig>(() =>
    newBotConfig(runtimes.find((r) => r.isDefault) ?? runtimes[0], models),
  )
  const runtimeTouchedRef = useRef(false)
  const [autoJob, setAutoJob] = useState<QrJobView | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [profileView, setProfileView] = useState<{ runtimeId: string; initialProfileId?: string } | null>(null)
  const [profileRevision, setProfileRevision] = useState(0)

  const opAuth = auth?.openPlatform
  const isOpAuthenticated = Boolean(opAuth?.authenticated)
  const opState = useOpenPlatformAppsState(isOpAuthenticated, onAuthUpdated)
  const patch = (p: Partial<BotConfig>) => setDraft((prev) => ({ ...prev, ...p }))
  const runtime = runtimes.find((r) => r.id === draft.agentPreset)
  const profileViewRuntime = profileView ? runtimes.find((r) => r.id === profileView.runtimeId) : undefined

  useEffect(() => {
    if (runtimeTouchedRef.current || runtimes.length === 0) return
    const defaultRuntime = runtimes.find((r) => r.isDefault) ?? runtimes[0]
    if (!defaultRuntime) return
    setDraft((prev) => {
      const nextModel = effectiveDefaultModel(defaultRuntime, models)
      if (prev.agentPreset === defaultRuntime.id && (prev.model ?? '') === (nextModel ?? '')) {
        return prev
      }
      return {
        ...prev,
        agentPreset: defaultRuntime.id,
        model: nextModel,
        reasoningEffort: '',
      }
    })
  }, [runtimes, models])

  useEffect(() => {
    if (!auth) void onAuthUpdated()
  }, [auth, onAuthUpdated])

  useEffect(() => {
    if (!autoJob || !['waiting_scan', 'scanned', 'working'].includes(autoJob.status)) return
    const timer = window.setInterval(async () => {
      try {
        const next = await bridgeApi.pollAuthJob(autoJob.jobId)
        setAutoJob(next)
        if (next.status === 'succeeded') {
          await onAutoCreated()
          onClose()
        } else if (next.status === 'failed' || next.status === 'expired') {
          setError(next.error || next.stepMessage)
        }
      } catch {
        // Ignore transient polling error.
      }
    }, 1500)
    return () => window.clearInterval(timer)
  }, [autoJob, onAutoCreated, onClose])

  const handleExistingSourceChange = (next: 'open_platform' | 'manual') => {
    setExistingSource(next)
    setError('')
    if (next === 'manual' && opState.selectedAppId && !draft.larkAppId.trim()) {
      const picked = opState.apps.find((a) => a.appId === opState.selectedAppId)
      if (picked) {
        patch({
          name: picked.name,
          description: picked.description,
          larkAppId: picked.appId,
          avatarUrl: picked.avatarUrl ?? '',
        })
      }
    }
  }

  const handlePrimarySubmit = async () => {
    setError('')
    const hasProfile = Boolean(draft.runtimeProfileId?.trim())
    const norm = hasProfile
      ? { model: draft.model?.trim() ?? '', reasoningEffort: draft.reasoningEffort?.trim() ?? '' }
      : normalizeModelAndEffort(runtime, models, draft.model, draft.reasoningEffort)
    if (createMode === 'auto') {
      if (!draft.name.trim() || !draft.defaultWorkingDir.trim()) {
        setError('请填写智能体名称与工作目录')
        return
      }
      setSaving(true)
      try {
        const job = await bridgeApi.autoCreateBot({
          mode: autoProtocol,
          ...(draft.id.trim() ? { id: draft.id.trim() } : {}),
          name: draft.name.trim(),
          description: draft.description.trim(),
          workspaceName: draft.workspaceName.trim(),
          defaultWorkingDir: draft.defaultWorkingDir.trim(),
          agentPreset: draft.agentPreset,
          ...(draft.runtimeProfileId?.trim() ? { runtimeProfileId: draft.runtimeProfileId.trim() } : {}),
          ...(norm.model ? { model: norm.model } : {}),
          ...(norm.reasoningEffort ? { reasoningEffort: norm.reasoningEffort } : {}),
        })
        setAutoJob(job)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setSaving(false)
      }
      return
    }

    if (existingSource === 'open_platform') {
      if (!opState.selectedAppId) {
        setError('请先从开放平台列表中选择一个已有应用')
        return
      }
      if (!draft.defaultWorkingDir.trim()) {
        setError('请填写工作目录')
        return
      }
      setSaving(true)
      try {
        const res = await bridgeApi.importExistingBot({
          larkAppId: opState.selectedAppId,
          workspaceName: draft.workspaceName.trim(),
          defaultWorkingDir: draft.defaultWorkingDir.trim(),
          agentPreset: draft.agentPreset,
          ...(draft.runtimeProfileId?.trim() ? { runtimeProfileId: draft.runtimeProfileId.trim() } : {}),
          ...(norm.model ? { model: norm.model } : {}),
          ...(norm.reasoningEffort ? { reasoningEffort: norm.reasoningEffort } : {}),
          ...(syncBaselineEvents ? { syncBaselineEvents: true } : {}),
        })
        await onExistingImported(res.bot.name, res.eventSync)
        onClose()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setSaving(false)
      }
      return
    }

    const missing =
      !draft.name.trim() ||
      !draft.larkAppId.trim() ||
      !draft.larkAppSecret?.trim() ||
      !draft.defaultWorkingDir.trim()
    if (missing) {
      setError('请补全显示名称、App ID、App Secret 与工作目录')
      return
    }
    setSaving(true)
    try {
      const resolvedId = draft.id.trim() || generateFallbackBotId(draft.name, draft.larkAppId)
      await onSave(
        {
          ...draft,
          id: resolvedId,
          runtimeProfileId: draft.runtimeProfileId?.trim() || undefined,
          model: norm.model || undefined,
          reasoningEffort: norm.reasoningEffort || undefined,
        },
        null,
      )
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const isJobRunning = Boolean(autoJob && ['waiting_scan', 'scanned', 'working'].includes(autoJob.status))
  const primaryDisabled =
    saving ||
    isJobRunning ||
    (createMode === 'existing' && existingSource === 'open_platform' && (!isOpAuthenticated || !opState.selectedAppId))
  const primaryLabel =
    createMode === 'auto'
      ? isJobRunning
        ? '等待完成…'
        : isOpAuthenticated && autoProtocol === 'open_platform'
          ? '一键创建并接入'
          : '扫码创建并接入'
      : saving
        ? '接入中…'
        : existingSource === 'open_platform'
          ? '接入所选应用'
          : '接入智能体'

  return (
    <Modal
      open
      onClose={onClose}
      title={profileViewRuntime ? `${profileViewRuntime.name} 启动配置` : '新增智能体'}
      headless
      className={profileViewRuntime ? 'fb-dialog' : 'fb-schedule-dialog fb-create-bot-dialog'}
      onKeyDownCapture={
        profileViewRuntime
          ? (event) => {
              if (event.key === 'Escape' && !event.shiftKey && !event.defaultPrevented) {
                event.preventDefault()
                event.stopPropagation()
                setProfileView(null)
              }
            }
          : undefined
      }
    >
      {profileViewRuntime ? (
        <RuntimeProfilePanel
          runtime={profileViewRuntime}
          initialProfileId={profileView?.initialProfileId}
          backLabel="新增智能体"
          onBack={() => setProfileView(null)}
          onClose={onClose}
          onChanged={async (nextProfileId) => {
            setProfileRevision((v) => v + 1)
            await onProfilesChanged?.()
            if (nextProfileId !== undefined) {
              const changed = nextProfileId !== (draft.runtimeProfileId ?? '')
              patch({
                runtimeProfileId: nextProfileId || undefined,
                ...(changed ? { model: undefined, reasoningEffort: undefined } : {}),
              })
            }
          }}
        />
      ) : (
        <>
          <div className="fb-schedule-dialog-head">
        <div style={{ minWidth: 0 }}>
          <div className="fb-schedule-dialog-title">新增飞书智能体</div>
          <div className="fb-schedule-dialog-sub">
            支持一键自动创建飞书应用，或登录开放平台直接选择已有应用接入
          </div>
        </div>
        <button type="button" className="fb-icon-btn" aria-label="关闭" onClick={onClose}>
          <IconCloseOutlineRegular size={14} />
        </button>
      </div>

      <div className="fb-schedule-dialog-body">
        <div style={{ marginBottom: 10 }}>
          <SegmentedControl
            id="fb-bot-create-mode"
            label="创建方式"
            value={createMode}
            options={[
              { value: 'auto', label: '自动创建飞书智能体' },
              { value: 'existing', label: '接入已有应用' },
            ]}
            onChange={(m) => {
              setCreateMode(m)
              setError('')
            }}
          />
        </div>

        {createMode === 'auto' ? (
          <>
            <SettingRow
              title="创建通道"
              desc={
                autoProtocol === 'open_platform'
                  ? isOpAuthenticated && opAuth?.identity
                    ? `已登录开放平台：${opAuth.identity.userName}（${opAuth.identity.tenantName}）`
                    : '扫码自动创建自建应用并开通权限与长连接'
                  : '通过官方 SDK 设备流注册个人智能体凭证'
              }
            >
              <SelectMenu
                value={autoProtocol}
                options={[
                  { value: 'open_platform', label: '开放平台全自动创建（推荐）', desc: '创建企业自建应用并自动开通权限与长连接' },
                  { value: 'device_flow', label: '扫码快速注册（SDK）', desc: '通过官方设备流注册个人应用凭证' },
                ]}
                onChange={setAutoProtocol}
              />
            </SettingRow>
            <SettingRow title="智能体名称">
              <TextField value={draft.name} onChange={(name) => patch({ name })} placeholder="例如 研发协作助手" />
            </SettingRow>
            <SettingRow title="智能体签名">
              <TextField value={draft.description} onChange={(description) => patch({ description })} placeholder="飞书名片简介（选填）" />
            </SettingRow>
          </>
        ) : (
          <>
            <SettingRow
              title="接入方式"
              desc={
                existingSource === 'open_platform'
                  ? isOpAuthenticated && opAuth?.identity
                    ? `已登录开放平台：${opAuth.identity.userName}（${opAuth.identity.tenantName}）`
                    : '登录开放平台后直接从列表选择，免填基本信息与凭证'
                  : '手动输入已有应用的 App ID、App Secret 与基本信息'
              }
            >
              <SelectMenu
                value={existingSource}
                options={[
                  { value: 'open_platform', label: '从开放平台选择（推荐）', desc: '登录后从已有应用列表直接选取并自动读取凭证' },
                  { value: 'manual', label: '手动填写凭证', desc: '手动填写 App ID、App Secret 与基本信息' },
                ]}
                onChange={handleExistingSourceChange}
              />
            </SettingRow>

            {existingSource === 'open_platform' ? (
              <>
                <OpenPlatformAppPicker
                  authenticated={isOpAuthenticated}
                  apps={opState.apps}
                  bots={bots}
                  loading={opState.loading}
                  loadError={opState.loadError}
                  selectedAppId={opState.selectedAppId}
                  loginJob={opState.loginJob}
                  startingLogin={opState.startingLogin}
                  onSelect={(app) => {
                    opState.setSelectedAppId(app.appId)
                    setError('')
                  }}
                  onRefresh={() => void opState.refreshApps()}
                  onStartLogin={() => {
                    setError('')
                    void opState.startLogin().catch((err) => {
                      setError(err instanceof Error ? err.message : String(err))
                    })
                  }}
                />
                {isOpAuthenticated ? (
                  <SettingRow
                    title="补齐基线事件订阅"
                    desc="导入时自动补订收发与撤回消息等长连接事件并发布新版本"
                  >
                    <Switch
                      label="补齐基线事件订阅"
                      checked={syncBaselineEvents}
                      onChange={setSyncBaselineEvents}
                    />
                  </SettingRow>
                ) : null}
              </>
            ) : (
              <>
                <SettingRow title="显示名称">
                  <TextField value={draft.name} onChange={(name) => patch({ name })} placeholder="例如 DSH-Agent" />
                </SettingRow>
                <SettingRow title="智能体签名">
                  <TextField value={draft.description} onChange={(description) => patch({ description })} placeholder="留空保存可从飞书自动同步" />
                </SettingRow>
                <SettingRow title="标识" desc="内部唯一 ID，留空自动生成">
                  <TextField value={draft.id} onChange={(id) => patch({ id })} placeholder="dsh-agent" mono />
                </SettingRow>
                <SettingRow title="App ID">
                  <TextField value={draft.larkAppId} onChange={(larkAppId) => patch({ larkAppId })} placeholder="cli_xxx" mono />
                </SettingRow>
                <SettingRow title="App Secret" desc="仅加密保存在本机">
                  <TextField value={draft.larkAppSecret ?? ''} onChange={(larkAppSecret) => patch({ larkAppSecret })} secret mono />
                </SettingRow>
              </>
            )}
          </>
        )}

        <SettingRow title="工作目录">
          <DirectoryField
            value={draft.defaultWorkingDir}
            onChange={(defaultWorkingDir) => patch({ defaultWorkingDir })}
            placeholder="~ 或 /path/to/workspace"
          />
        </SettingRow>
        <SettingRow title="工作区" desc="留空默认使用工作目录末级名称">
          <TextField
            value={draft.workspaceName}
            onChange={(workspaceName) => patch({ workspaceName })}
            placeholder={leafDirectoryLabel(draft.defaultWorkingDir) || '默认使用工作目录名称'}
          />
        </SettingRow>
        <AgentRuntimeFields
          runtimeTitle="默认运行时"
          value={{
            agentPreset: draft.agentPreset,
            runtimeProfileId: draft.runtimeProfileId ?? '',
            model: draft.model ?? '',
            reasoningEffort: draft.reasoningEffort ?? '',
          }}
          runtimes={runtimes}
          models={models}
          profileRevision={profileRevision}
          onProfilesChanged={onProfilesChanged}
          onManageProfiles={(rt, pid) =>
            setProfileView({ runtimeId: rt.id, ...(pid ? { initialProfileId: pid } : {}) })
          }
          onChange={({ agentPreset, runtimeProfileId, model, reasoningEffort }) => {
            runtimeTouchedRef.current = true
            patch({
              agentPreset,
              runtimeProfileId: runtimeProfileId?.trim() || undefined,
              model: model || undefined,
              reasoningEffort: reasoningEffort || undefined,
            })
          }}
        />

        {createMode === 'auto' && autoJob && (
          <div className="fb-qr-panel" style={{ marginTop: 12 }}>
            {autoJob.qrSvgDataUrl && <img className="fb-qr-img" src={autoJob.qrSvgDataUrl} alt="扫码创建智能体" />}
            <div className="fb-qr-info">
              <div style={{ fontWeight: 500 }}>自动创建进度</div>
              <div className="fb-row-desc">{autoJob.stepMessage}</div>
              {autoJob.verificationUrl && (
                <a href={autoJob.verificationUrl} target="_blank" rel="noreferrer" className="fb-row-desc" style={{ textDecoration: 'underline' }}>
                  在浏览器中打开验证链接
                </a>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="fb-schedule-dialog-foot">
        {error ? <span className="fb-dialog-error">{error}</span> : null}
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button variant="primary" disabled={primaryDisabled} onClick={() => void handlePrimarySubmit()}>
          {primaryLabel}
        </Button>
      </div>
        </>
      )}
    </Modal>
  )
}

function EditBotDialog({
  target,
  runtimes,
  models,
  triageDefaults,
  auth,
  onClose,
  onSave,
  onSynced,
  onProfilesChanged,
  onOpenAuth,
  onOpenSession,
}: {
  target: BotRecord
  runtimes: readonly RuntimeOption[]
  models: readonly ModelGroup[]
  triageDefaults?: TriageDefaultsPayload
  auth: AuthStatusPayload | null
  onClose: () => void
  onSave: (config: BotConfig, existingId: string | null) => Promise<void>
  onSynced: () => Promise<void>
  onProfilesChanged?: () => Promise<void>
  onOpenAuth: () => void
  onOpenSession?: (sessionId: string) => void
}) {
  const [section, setSection] = useState<Section>('basic')
  const [draft, setDraft] = useState<BotConfig>(() => toBotConfig(target))
  const [localDreamState, setLocalDreamState] = useState<DreamRunState | undefined>(target.dreamState)
  const [localMemoryCount, setLocalMemoryCount] = useState<number>(target.activeMemoryCount ?? 0)
  const [saving, setSaving] = useState(false)
  const [syncingProfile, setSyncingProfile] = useState(false)
  const [error, setError] = useState('')
  const [profileView, setProfileView] = useState<{ runtimeId: string; initialProfileId?: string } | null>(null)
  const [memoryViewOpen, setMemoryViewOpen] = useState(false)
  const [profileRevision, setProfileRevision] = useState(0)
  const existingId = target.id

  useEffect(() => {
    setDraft(toBotConfig(target))
    setLocalDreamState(target.dreamState)
    setLocalMemoryCount(target.activeMemoryCount ?? 0)
    setSection('basic')
    setProfileView(null)
    setMemoryViewOpen(false)
    setError('')

    if (!target.avatarUrl?.trim() || !target.description?.trim()) {
      let cancelled = false
      void bridgeApi
        .syncBotProfile(target.id)
        .then((res) => {
          if (cancelled) return
          const nextAvatar = res.profile.avatarUrl?.trim()
          const nextDesc = res.profile.description?.trim()
          if (!nextAvatar && !nextDesc) return
          setDraft((prev) => {
            if (prev.id !== target.id) return prev
            return {
              ...prev,
              ...(nextAvatar && !prev.avatarUrl.trim() ? { avatarUrl: nextAvatar } : {}),
              ...(nextDesc && !prev.description.trim() ? { description: nextDesc } : {}),
            }
          })
        })
        .catch(() => {})
      return () => {
        cancelled = true
      }
    }
    return undefined
  }, [target])

  useEffect(() => {
    if (target.dreamState) {
      setLocalDreamState(target.dreamState)
    }
  }, [target])

  const patch = (p: Partial<BotConfig>) => setDraft((prev) => ({ ...prev, ...p }))
  const runtime = runtimes.find((r) => r.id === draft.agentPreset)
  const profileViewRuntime = profileView ? runtimes.find((r) => r.id === profileView.runtimeId) : undefined

  const save = async () => {
    const missing = !draft.id.trim() || !draft.name.trim() || !draft.larkAppId.trim() || !draft.defaultWorkingDir.trim()
    if (missing) {
      setSection('basic')
      setError('请补全基本信息中的必填项')
      return
    }
    setSaving(true)
    setError('')
    try {
      const hasProfile = Boolean(draft.runtimeProfileId?.trim())
      const norm = hasProfile
        ? { model: draft.model?.trim() ?? '', reasoningEffort: draft.reasoningEffort?.trim() ?? '' }
        : normalizeModelAndEffort(runtime, models, draft.model, draft.reasoningEffort)
      const hasSignature = Boolean(draft.signature.trim())
      const showModel = Boolean(draft.replyFooterEnabled && draft.replyFooterModel)
      await onSave(
        {
          ...draft,
          runtimeProfileId: draft.runtimeProfileId?.trim() || undefined,
          model: norm.model || undefined,
          reasoningEffort: norm.reasoningEffort || undefined,
          replyFooterSignature: hasSignature,
          replyFooterEnabled: showModel || hasSignature,
        },
        existingId,
      )
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('工作目录')) setSection('basic')
      setError(msg)
    } finally {
      setSaving(false)
    }
  }

  const syncAvatarAndProfile = async () => {
    setSyncingProfile(true)
    try {
      const res = await bridgeApi.syncBotProfile(existingId)
      patch({
        ...(res.profile.avatarUrl ? { avatarUrl: res.profile.avatarUrl } : {}),
        ...(res.profile.description ? { description: res.profile.description } : {}),
      })
      await onSynced()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSyncingProfile(false)
    }
  }

  return (
    <ConfigDialog
      open
      title={draft.name || existingId}
      sections={SECTIONS}
      active={section}
      onSectionChange={setSection}
      onClose={onClose}
      onSave={() => void save()}
      saving={saving}
      error={error}
      subview={
        memoryViewOpen
          ? {
              title: `${draft.name || existingId} · Memory`,
              onBack: () => setMemoryViewOpen(false),
              content: (
                <BotMemoryPanel
                  botId={existingId}
                  botName={draft.name || existingId}
                  onBack={() => setMemoryViewOpen(false)}
                  onClose={onClose}
                  onChanged={(count) => {
                    setLocalMemoryCount(count)
                    void onSynced()
                  }}
                />
              ),
            }
          : profileViewRuntime
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
                          runtimeProfileId: nextProfileId || undefined,
                          ...(changed ? { model: undefined, reasoningEffort: undefined } : {}),
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
          <SettingRow title="智能体头像">
            <Avatar src={draft.avatarUrl} name={draft.name || existingId} kind="bot" />
            <Button
              size="sm"
              variant="outline"
              icon={<IconRefreshOutlineRegular size={14} />}
              disabled={syncingProfile}
              onClick={() => void syncAvatarAndProfile()}
            >
              {syncingProfile ? '同步中…' : '同步飞书信息'}
            </Button>
          </SettingRow>
          <SettingRow title="显示名称">
            <TextField value={draft.name} onChange={(name) => patch({ name })} placeholder="例如 DSH-Agent" />
          </SettingRow>
          <SettingRow
            title="智能体签名"
            desc={auth?.openPlatform.authenticated ? '修改保存后同步更新至飞书名片' : '留空保存可从飞书自动同步'}
          >
            <TextField value={draft.description} onChange={(description) => patch({ description })} placeholder="飞书名片简介" />
          </SettingRow>
          <SettingRow title="标识" desc="内部唯一 ID，创建后不可修改">
            <TextField value={draft.id} onChange={(id) => patch({ id })} placeholder="dsh-agent" mono disabled />
          </SettingRow>
          <SettingRow title="App ID">
            <TextField value={draft.larkAppId} onChange={(larkAppId) => patch({ larkAppId })} placeholder="cli_xxx" mono />
          </SettingRow>
          <SettingRow title="App Secret" desc="留空保持原密钥不变">
            <TextField value={draft.larkAppSecret ?? ''} onChange={(larkAppSecret) => patch({ larkAppSecret })} placeholder="••••••••" secret mono />
          </SettingRow>
          <SettingRow title="工作目录">
            <DirectoryField
              value={draft.defaultWorkingDir}
              onChange={(defaultWorkingDir) => patch({ defaultWorkingDir })}
              placeholder="~ 或 /path/to/workspace"
            />
          </SettingRow>
          <SettingRow title="工作区" desc="留空默认使用工作目录末级名称">
            <TextField
              value={draft.workspaceName}
              onChange={(workspaceName) => patch({ workspaceName })}
              placeholder={
                leafDirectoryLabel(draft.defaultWorkingDir) ||
                (!target.workspaceName && draft.defaultWorkingDir === target.defaultWorkingDir
                  ? target.effectiveWorkspaceName
                  : '') ||
                '默认使用工作目录名称'
              }
            />
          </SettingRow>
        </>
      )}

      {section === 'runtime' && (
        <>
          <GroupTitle>主运行时</GroupTitle>
          <AgentRuntimeFields
            value={{
              agentPreset: draft.agentPreset,
              runtimeProfileId: draft.runtimeProfileId ?? '',
              model: draft.model ?? '',
              reasoningEffort: draft.reasoningEffort ?? '',
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
                agentPreset,
                runtimeProfileId: runtimeProfileId?.trim() || undefined,
                model: model || undefined,
                reasoningEffort: reasoningEffort || undefined,
              })
            }
          />

          <GroupTitle>智能分流</GroupTitle>
          <SettingRow
            title="启用智能分流"
            desc="用轻量模型前置判断群消息意图，闲聊静默或轻回复，正式任务直通主运行时，各群可单独覆盖"
          >
            <Switch
              label="启用智能分流"
              checked={draft.router.enabled}
              onChange={(enabled) => patch({ router: { ...draft.router, enabled } })}
            />
          </SettingRow>

          {draft.router.enabled && (
            <TriageConfigFields
              value={draft.router}
              runtimes={runtimes}
              models={models}
              triageDefaults={triageDefaults}
              onChange={(next) => patch({ router: { ...draft.router, ...next } })}
            />
          )}
        </>
      )}

      {section === 'conversation' && <BotConversationAndMessageSection draft={draft} patch={patch} />}

      {section === 'role' && (
        <>
          <SettingRow title="启用角色设定" desc="新会话开始时注入角色设定，群聊可单独追加或覆盖">
            <Switch label="启用角色设定" checked={draft.role.enabled} onChange={(enabled) => patch({ role: { ...draft.role, enabled } })} />
          </SettingRow>
          {draft.role.enabled && (
            <>
              <SettingRow title="模板">
                <SelectMenu
                  value={draft.role.presetKey ?? ''}
                  options={[{ value: '', label: '自定义' }, ...ROLE_PRESETS.map((p) => ({ value: p.key, label: p.label }))]}
                  onChange={(key) => {
                    const preset = ROLE_PRESETS.find((p) => p.key === key)
                    patch({ role: preset ? { enabled: true, presetKey: preset.key, name: preset.roleName, systemPrompt: preset.systemPrompt } : { ...draft.role, presetKey: undefined } })
                  }}
                />
              </SettingRow>
              <SettingRow title="角色名称">
                <TextField value={draft.role.name} onChange={(name) => patch({ role: { ...draft.role, name } })} placeholder="例如 研发协作搭档" />
              </SettingRow>
              <SettingRow title="角色提示词" stack>
                <TextArea value={draft.role.systemPrompt} onChange={(systemPrompt) => patch({ role: { ...draft.role, systemPrompt } })} rows={8} placeholder="定义职责、回答风格与协作边界" />
              </SettingRow>
            </>
          )}
        </>
      )}

      {section === 'access' && (
        <AccessSection
          botId={existingId}
          draft={draft}
          patch={patch}
          auth={auth}
          onOpenAuth={onOpenAuth}
        />
      )}

      {section === 'experimental' && (
        <ExperimentalSection
          botId={existingId}
          experimental={draft.experimental}
          dreamState={localDreamState}
          activeMemoryCount={localMemoryCount}
          onChange={(experimental) => patch({ experimental })}
          onOpenMemory={() => setMemoryViewOpen(true)}
          onOpenSession={(sid) => {
            onClose()
            onOpenSession?.(sid)
          }}
          onStateUpdated={(next) => {
            setLocalDreamState(next)
            void onSynced()
          }}
        />
      )}
    </ConfigDialog>
  )
}

function BotConversationAndMessageSection({
  draft,
  patch,
}: {
  draft: BotConfig
  patch: (p: Partial<BotConfig>) => void
}) {
  return (
    <>
      <GroupTitle>群聊触发与会话</GroupTitle>
      <SettingRow title="可用范围">
        <SelectMenu value={draft.groupAccessMode} options={ACCESS_MODES} onChange={(groupAccessMode) => patch({ groupAccessMode })} />
      </SettingRow>
      <SettingRow title="触发方式" desc="开启活跃话题后，进行中的话题内追问无需再次 @">
        <SelectMenu value={draft.mentionTriggerMode} options={TRIGGER_MODES} onChange={(mentionTriggerMode) => patch({ mentionTriggerMode })} />
      </SettingRow>
      <SettingRow title="会话策略">
        <SelectMenu value={draft.groupSessionMode} options={SESSION_MODES} onChange={(groupSessionMode) => patch({ groupSessionMode })} />
      </SettingRow>
      <SettingRow title="空闲自动归档" desc="0 表示不自动归档">
        <NumberField value={draft.idleCloseMinutes} onChange={(idleCloseMinutes) => patch({ idleCloseMinutes })} suffix="分钟" />
      </SettingRow>

      <GroupTitle>回复与反馈</GroupTitle>
      <SettingRow title="回复方式">
        <SelectMenu value={draft.groupReplyMode} options={REPLY_MODES} onChange={(groupReplyMode) => patch({ groupReplyMode })} />
      </SettingRow>
      <SettingRow title="收到消息时的表情" desc="处理期间贴在原消息上，回复完成后自动移除">
        <SelectMenu value={draft.receivedReactionEmoji} options={reactionOptions()} onChange={(receivedReactionEmoji) => patch({ receivedReactionEmoji })} />
      </SettingRow>
      <SettingRow title="发送中间过程消息" desc="执行过程中的阶段说明实时发出，不与最终回复合并">
        <Switch
          label="发送中间过程消息"
          checked={Boolean(draft.sendIntermediateMessages)}
          onChange={(sendIntermediateMessages) => patch({ sendIntermediateMessages })}
        />
      </SettingRow>

      <GroupTitle>消息卡片</GroupTitle>
      <SettingRow title="使用消息卡片" desc="关闭后以纯文本发送回复">
        <Switch label="使用消息卡片" checked={draft.useInteractiveCard} onChange={(useInteractiveCard) => patch({ useInteractiveCard })} />
      </SettingRow>
      {draft.useInteractiveCard && (
        <>
          <SettingRow title="附带会话链接" desc="卡片底部提供跳转 DSH 接管会话的入口">
            <Switch label="附带会话链接" checked={draft.dshSessionLinkInCard} onChange={(dshSessionLinkInCard) => patch({ dshSessionLinkInCard })} />
          </SettingRow>
          {draft.dshSessionLinkInCard && (
            <NestedSettings>
              <SettingRow
                title="允许群成员只读查看"
                desc="未登录 DSH 的群成员点击卡片链接可只读观看该会话，无权发消息或改配置"
              >
                <Switch
                  label="允许群成员只读查看"
                  checked={draft.sessionLinkGuestReadOnly}
                  onChange={(sessionLinkGuestReadOnly) => patch({ sessionLinkGuestReadOnly })}
                />
              </SettingRow>
            </NestedSettings>
          )}
          <SettingRow title="显示模型信息">
            <Switch
              label="显示模型信息"
              checked={draft.replyFooterEnabled && draft.replyFooterModel}
              onChange={(on) => patch({ replyFooterEnabled: on || Boolean(draft.signature.trim()), replyFooterModel: on })}
            />
          </SettingRow>
          <SettingRow title="卡片底部签名">
            <TextField
              value={draft.signature}
              onChange={(signature) => patch({ signature, replyFooterEnabled: true, replyFooterSignature: true })}
              placeholder="留空不展示，例如 AI 回复仅供参考"
            />
          </SettingRow>
        </>
      )}
    </>
  )
}

function resolveUsersAsTargets(
  draft: BotConfig,
  userIds: readonly string[],
  primaryProfiles: readonly SubstituteTarget[] | undefined,
): SubstituteTarget[] {
  const byId = new Map<string, SubstituteTarget>()
  for (const p of primaryProfiles ?? []) byId.set(p.openId, p)
  for (const p of [
    ...(draft.allowedUserProfiles ?? []),
    ...(draft.adminUserProfiles ?? []),
    ...draft.substituteMode.targets,
  ]) {
    if (!byId.has(p.openId)) byId.set(p.openId, p)
  }
  return userIds.map((openId) => byId.get(openId) ?? { openId, name: openId })
}

function AccessSection({
  botId,
  draft,
  patch,
  auth,
  onOpenAuth,
}: {
  botId: string | null
  draft: BotConfig
  patch: (p: Partial<BotConfig>) => void
  auth: AuthStatusPayload | null
  onOpenAuth: () => void
}) {
  const sub = draft.substituteMode
  const setSub = (p: Partial<BotConfig['substituteMode']>) => patch({ substituteMode: { ...sub, ...p } })
  const userAuth = botId ? auth?.userAuth.find((u) => u.botId === botId) : undefined
  const allowedTargets = resolveUsersAsTargets(draft, draft.allowedUsers, draft.allowedUserProfiles)
  const adminTargets = resolveUsersAsTargets(draft, draft.adminUsers ?? [], draft.adminUserProfiles)

  const renderSearchHint = (prefix: string) =>
    botId ? (
      <span>
        {prefix}
        {!userAuth?.authorized && (
          <>
            {prefix ? ' ' : ''}当前可搜群成员，全企业搜索需先{' '}
            <button
              type="button"
              className="fb-link-btn"
              style={{ textDecoration: 'underline', padding: 0 }}
              onClick={onOpenAuth}
            >
              飞书授权
            </button>
          </>
        )}
      </span>
    ) : (
      `${prefix}${prefix ? ' ' : ''}请先保存智能体后再搜索成员`
    )

  return (
    <>
      <GroupTitle>私聊</GroupTitle>
      <SettingRow title="允许私聊">
        <Switch label="允许私聊" checked={draft.p2pEnabled} onChange={(p2pEnabled) => patch({ p2pEnabled })} />
      </SettingRow>
      {draft.p2pEnabled && (
        <>
          <SettingRow title="私聊会话">
            <SelectMenu value={draft.p2pSessionMode} options={P2P_SESSION_MODES} onChange={(p2pSessionMode) => patch({ p2pSessionMode })} />
          </SettingRow>
          <SettingRow
            title="私聊白名单"
            desc={renderSearchHint('留空允许所有成员私聊。')}
            stack
          >
            <UserSearchPicker
              botId={botId}
              values={allowedTargets}
              onChange={(next) =>
                patch({
                  allowedUsers: next.map((u) => u.openId),
                  allowedUserProfiles: next,
                })
              }
              placeholder="输入姓名、邮箱或 ou_xxx 搜索添加…"
            />
          </SettingRow>
        </>
      )}

      <GroupTitle>管理权限</GroupTitle>
      <SettingRow
        title="智能体管理员"
        desc={renderSearchHint('仅管理员可点击群内提醒确认/取消按钮；留空时需在 DSH 控制台处理。')}
        stack
      >
        <UserSearchPicker
          botId={botId}
          values={adminTargets}
          onChange={(next) =>
            patch({
              adminUsers: next.map((u) => u.openId),
              adminUserProfiles: next,
            })
          }
          placeholder="输入姓名、邮箱或 ou_xxx 搜索添加管理员…"
        />
      </SettingRow>

      <GroupTitle>代答</GroupTitle>
      <SettingRow title="代答指定成员" desc="群里 @ 这些成员时，由智能体先行检索并协助回复">
        <Switch label="代答指定成员" checked={sub.enabled} onChange={(enabled) => setSub({ enabled })} />
      </SettingRow>
      {sub.enabled && (
        <>
          <SettingRow
            title="身份说明"
            desc={DISCLOSURE_MODES.find((m) => m.value === sub.disclosure)?.desc}
          >
            <SelectMenu value={sub.disclosure} options={DISCLOSURE_MODES} onChange={(disclosure) => setSub({ disclosure })} />
          </SettingRow>
          <SettingRow title="话题内持续跟进" desc="代答开启的话题内后续追问无需再次 @">
            <Switch label="话题内持续跟进" checked={sub.activeThreadFollowup} onChange={(activeThreadFollowup) => setSub({ activeThreadFollowup })} />
          </SettingRow>
          <SettingRow
            title="代答成员"
            desc={!botId || !userAuth?.authorized ? renderSearchHint('') : undefined}
            stack
          >
            <UserSearchPicker
              botId={botId}
              values={sub.targets}
              onChange={(targets) => setSub({ targets })}
              placeholder="输入姓名、邮箱或 ou_xxx 搜索代答成员…"
            />
          </SettingRow>
        </>
      )}
    </>
  )
}
