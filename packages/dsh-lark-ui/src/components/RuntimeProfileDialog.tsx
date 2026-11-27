import { useEffect, useMemo, useState } from 'react'
import {
  Button,
  IconChevronDownOutlineRegular,
  IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular,
  IconCloseOutlineRegular,
  IconPlusOutlineRegular,
  Modal,
  Switch,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgeApi } from '../api.js'
import { parseCommandLineToProfileDraft } from '../command-import.js'
import type {
  RuntimeConcurrencyConfig,
  RuntimeOption,
  RuntimeProfileCapabilities,
  RuntimeProfileInput,
  RuntimeProfileSummary,
} from '../types.js'
import {
  GroupTitle,
  SelectMenu,
  SettingRow,
  TagInput,
  TextField,
  type SelectOption,
} from './fields.js'
import {
  RuntimeConcurrencyField,
  resolveRuntimeConcurrencyState,
} from './RuntimeConcurrencyField.js'

const SECRET_ENV_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i

const ARGS_MODE_OPTIONS: readonly SelectOption<'append' | 'prepend' | 'replace'>[] = [
  { value: 'append', label: '追加到默认参数后' },
  { value: 'prepend', label: '前置到默认参数前' },
  { value: 'replace', label: '替换默认参数' },
]

interface EnvRow {
  readonly uid: string
  readonly key: string
  readonly value: string
  readonly hasStoredSecret: boolean
}

interface ProfileFormDraft {
  readonly id?: string
  readonly source: 'new' | 'discovered' | 'config' | 'user'
  readonly name: string
  readonly description: string
  readonly cliProfile: string
  readonly configFile: string
  readonly envRows: readonly EnvRow[]
  readonly removedEnvKeys: readonly string[]
  readonly args: readonly string[]
  readonly argsMode: 'append' | 'prepend' | 'replace'
  readonly authMethodId: string
  readonly defaultModel: string
  readonly exposeAsPreset: boolean
  readonly concurrencyLimit: number | null
}

let rowCounter = 1
function nextRowUid(): string {
  rowCounter += 1
  return `env-${rowCounter}`
}

function isLikelySecretKey(key: string): boolean {
  return SECRET_ENV_PATTERN.test(key.trim())
}

function buildEmptyDraft(): ProfileFormDraft {
  return {
    source: 'new',
    name: '',
    description: '',
    cliProfile: '',
    configFile: '',
    envRows: [],
    removedEnvKeys: [],
    args: [],
    argsMode: 'append',
    authMethodId: '',
    defaultModel: '',
    exposeAsPreset: false,
    concurrencyLimit: null,
  }
}

function draftFromProfile(
  profile: RuntimeProfileSummary,
  concurrencyLimit: number | null = null,
): ProfileFormDraft {
  const secretSet = new Set(profile.secretEnvKeys ?? [])
  const envRows: EnvRow[] = Object.entries(profile.env ?? {}).map(([key, val]) => ({
    uid: nextRowUid(),
    key,
    value: val,
    hasStoredSecret: secretSet.has(key),
  }))
  return {
    id: profile.id,
    source: profile.source,
    name: profile.name,
    description: profile.description ?? '',
    cliProfile: profile.cliProfile ?? '',
    configFile: profile.configFile ?? '',
    envRows,
    removedEnvKeys: [],
    args: [...(profile.args ?? [])],
    argsMode: profile.argsMode ?? 'append',
    authMethodId: profile.authMethodId ?? '',
    defaultModel: profile.defaultModel ?? '',
    exposeAsPreset: Boolean(profile.exposeAsPreset),
    concurrencyLimit,
  }
}

function defaultCapabilities(): RuntimeProfileCapabilities {
  return {
    supportsCliProfile: false,
    supportsConfigFile: false,
    supportsEnv: true,
    supportsArgs: true,
    supportsAuthMethod: false,
    supportsExposeAsPreset: true,
  }
}

function buildProfilePayload(runtimeId: string, draft: ProfileFormDraft): RuntimeProfileInput {
  const env: Record<string, string> = {}
  const activeKeys = new Set<string>()
  for (const row of draft.envRows) {
    const key = row.key.trim()
    if (!key) continue
    activeKeys.add(key)
    env[key] = row.value
  }
  const removeEnvKeys = draft.removedEnvKeys.filter((k) => !activeKeys.has(k))
  return {
    ...(draft.id ? { id: draft.id } : {}),
    runtimeId,
    name: draft.name.trim(),
    description: draft.description.trim(),
    cliProfile: draft.cliProfile.trim(),
    configFile: draft.configFile.trim(),
    env,
    ...(removeEnvKeys.length > 0 ? { removeEnvKeys } : {}),
    args: [...draft.args],
    argsMode: draft.argsMode,
    authMethodId: draft.authMethodId.trim(),
    defaultModel: draft.defaultModel.trim(),
    exposeAsPreset: draft.exposeAsPreset,
  }
}

function commandImportPlaceholder(runtime: RuntimeOption, caps: RuntimeProfileCapabilities): string {
  if (caps.supportsConfigFile && caps.configFileHint?.endsWith('.json')) {
    return `例如 GOOGLE_GEMINI_BASE_URL="http://127.0.0.1:8787" GEMINI_API_KEY="key" ${runtime.id} --settings ~/.config/proxy/settings.json`
  }
  if (caps.supportsCliProfile) {
    return `例如 ${runtime.id} -p personal`
  }
  return `例如 KEY=VALUE ${runtime.id} --flag`
}

function sourceTagLabel(source: RuntimeProfileSummary['source']): string | undefined {
  if (source === 'discovered') return '自动'
  if (source === 'config') return '配置'
  return undefined
}

export function RuntimeProfilePanel({
  runtime,
  initialProfileId,
  concurrency,
  backLabel,
  onBack,
  onClose,
  onChanged,
}: {
  runtime: RuntimeOption
  initialProfileId?: string
  concurrency?: RuntimeConcurrencyConfig
  backLabel?: string
  onBack?: () => void
  onClose: () => void
  onChanged: (selectedProfileId?: string) => Promise<void>
}) {
  const profiles = useMemo(() => runtime.profiles ?? [], [runtime.profiles])
  const caps = useMemo<RuntimeProfileCapabilities>(
    () => ({
      ...defaultCapabilities(),
      ...(runtime.profileCapabilities ?? {}),
      supportsEnv: runtime.profileCapabilities?.supportsEnv ?? true,
      supportsArgs: runtime.profileCapabilities?.supportsArgs ?? true,
      supportsExposeAsPreset: runtime.profileCapabilities?.supportsExposeAsPreset ?? true,
    }),
    [runtime.profileCapabilities],
  )

  const [selectedId, setSelectedId] = useState<string | '__new__'>('__new__')
  const [draft, setDraft] = useState<ProfileFormDraft>(buildEmptyDraft)
  const [showImport, setShowImport] = useState(false)
  const [importCmd, setImportCmd] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [saving, setSaving] = useState(false)
  const [probing, setProbing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const savedLimitFor = (profileId?: string): number | null => {
    if (!concurrency || !profileId) return null
    return resolveRuntimeConcurrencyState(concurrency, runtime.id, profileId).customLimit
  }

  useEffect(() => {
    const target =
      (initialProfileId ? profiles.find((p) => p.id === initialProfileId) : undefined) ??
      profiles[0]
    if (target) {
      setSelectedId(target.id)
      const next = draftFromProfile(target, savedLimitFor(target.id))
      setDraft(next)
      setShowAdvanced(
        next.args.length > 0 || Boolean(next.defaultModel) || next.concurrencyLimit !== null,
      )
    } else {
      setSelectedId('__new__')
      setDraft(buildEmptyDraft())
      setShowAdvanced(false)
    }
    setShowImport(false)
    setImportCmd('')
    setError('')
    setNotice('')
  }, [runtime.id, initialProfileId])

  const patch = (p: Partial<ProfileFormDraft>) => {
    setDraft((prev) => ({ ...prev, ...p }))
    setError('')
  }

  const selectExisting = (profile: RuntimeProfileSummary) => {
    setSelectedId(profile.id)
    const next = draftFromProfile(profile, savedLimitFor(profile.id))
    setDraft(next)
    setShowAdvanced(
      next.args.length > 0 || Boolean(next.defaultModel) || next.concurrencyLimit !== null,
    )
    setShowImport(false)
    setImportCmd('')
    setError('')
    setNotice('')
  }

  const startNew = () => {
    setSelectedId('__new__')
    setDraft(buildEmptyDraft())
    setShowAdvanced(false)
    setShowImport(false)
    setImportCmd('')
    setError('')
    setNotice('')
  }

  const applyCommandImport = () => {
    const raw = importCmd.trim()
    if (!raw) return
    const parsed = parseCommandLineToProfileDraft(raw, runtime.id)
    const envEntries = Object.entries(parsed.env)
    const nextRows = [...draft.envRows]
    for (const [k, v] of envEntries) {
      const idx = nextRows.findIndex((r) => r.key.trim() === k)
      if (idx >= 0) {
        nextRows[idx] = { ...nextRows[idx]!, key: k, value: v }
      } else {
        nextRows.push({ uid: nextRowUid(), key: k, value: v, hasStoredSecret: false })
      }
    }
    const parts: string[] = []
    if (envEntries.length > 0) parts.push(`${envEntries.length} 个环境变量`)
    if (parsed.configFile) parts.push('配置文件路径')
    if (parsed.cliProfile) parts.push(`CLI Profile (${parsed.cliProfile})`)
    if (parsed.args.length > 0) parts.push(`${parsed.args.length} 个附加参数`)
    if (parsed.authMethodId) parts.push(`认证方式 (${parsed.authMethodId})`)

    if (parts.length === 0) {
      setError('未能从命令行中识别出环境变量、配置文件或启动参数')
      return
    }

    patch({
      ...(draft.name.trim() ? {} : parsed.suggestedName ? { name: parsed.suggestedName } : {}),
      ...(caps.supportsCliProfile && parsed.cliProfile ? { cliProfile: parsed.cliProfile } : {}),
      ...(caps.supportsConfigFile && parsed.configFile ? { configFile: parsed.configFile } : {}),
      ...(caps.supportsEnv ? { envRows: nextRows } : {}),
      ...(caps.supportsArgs && parsed.args.length > 0 ? { args: parsed.args } : {}),
      ...(caps.supportsAuthMethod && parsed.authMethodId ? { authMethodId: parsed.authMethodId } : {}),
    })
    if (parsed.args.length > 0) setShowAdvanced(true)
    setNotice(`已解析填充：${parts.join('、')}`)
    setShowImport(false)
    setImportCmd('')
  }

  const persistCurrent = async (): Promise<RuntimeProfileSummary> => {
    if (!draft.name.trim()) {
      throw new Error('请填写配置名称')
    }
    const payload = buildProfilePayload(runtime.id, draft)
    const prevSavedLimit =
      draft.id && selectedId !== '__new__' ? savedLimitFor(draft.id) : null
    const saved =
      draft.id && selectedId !== '__new__'
        ? await bridgeApi.updateRuntimeProfile(runtime.id, draft.id, payload)
        : await bridgeApi.createRuntimeProfile(payload)
    if (concurrency && draft.concurrencyLimit !== prevSavedLimit) {
      await bridgeApi.setRuntimeConcurrency({
        runtimeId: runtime.id,
        profileId: saved.id,
        maxConcurrent: draft.concurrencyLimit,
      })
    }
    setSelectedId(saved.id)
    setDraft(draftFromProfile(saved, draft.concurrencyLimit))
    return saved
  }

  const handleSave = async () => {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const saved = await persistCurrent()
      await onChanged(saved.id)
      if (onBack) onBack()
      else onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleProbe = async () => {
    setProbing(true)
    setError('')
    setNotice('')
    try {
      const saved = await persistCurrent()
      await onChanged(saved.id)
      const models = await bridgeApi.probeRuntimeProfile(runtime.id, saved.id)
      const preview = models
        .slice(0, 3)
        .map((m) => m.name || m.id)
        .join('、')
      setNotice(
        models.length > 0
          ? `连接成功：探测到 ${models.length} 个模型${preview ? `（${preview}${models.length > 3 ? ' 等' : ''}）` : ''}`
          : '连接成功，但未返回模型列表',
      )
    } catch (err) {
      setError(`连接测试失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setProbing(false)
    }
  }

  const handleDelete = async () => {
    if (!draft.id || selectedId === '__new__') return
    setDeleting(true)
    setError('')
    setNotice('')
    try {
      await bridgeApi.deleteRuntimeProfile(runtime.id, draft.id)
      await onChanged('')
      const remaining = profiles.filter((p) => p.id !== draft.id)
      if (remaining[0]) {
        selectExisting(remaining[0])
      } else {
        startNew()
      }
      setNotice('已删除配置')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  const addEnvRow = (initialKey = '') => {
    if (initialKey && draft.envRows.some((r) => r.key.trim() === initialKey)) return
    patch({
      envRows: [
        ...draft.envRows,
        { uid: nextRowUid(), key: initialKey, value: '', hasStoredSecret: false },
      ],
    })
  }

  const updateEnvRow = (uid: string, field: 'key' | 'value', nextVal: string) => {
    patch({
      envRows: draft.envRows.map((row) =>
        row.uid === uid ? { ...row, [field]: nextVal } : row,
      ),
    })
  }

  const removeEnvRow = (row: EnvRow) => {
    const cleanKey = row.key.trim()
    patch({
      envRows: draft.envRows.filter((r) => r.uid !== row.uid),
      removedEnvKeys:
        cleanKey && !draft.removedEnvKeys.includes(cleanKey)
          ? [...draft.removedEnvKeys, cleanKey]
          : draft.removedEnvKeys,
    })
  }

  const usedEnvKeys = new Set(draft.envRows.map((r) => r.key.trim()).filter(Boolean))
  const availableEnvHints = (caps.envHints ?? []).filter((k) => !usedEnvKeys.has(k))
  const authOptions: SelectOption<string>[] = [
    { value: '', label: '自动 / 默认' },
    ...(caps.authMethods ?? []).map((m) => ({
      value: m.id,
      label: m.name || m.id,
      ...(m.description ? { desc: m.description } : {}),
    })),
  ]
  const busy = saving || probing || deleting
  const canDelete = Boolean(draft.id && selectedId !== '__new__' && draft.source === 'user')

  return (
    <>
      <div className="fb-dialog-header">
        <div className="fb-dialog-header-main">
          {onBack && (
            <>
              <button
                type="button"
                className="fb-dialog-back"
                aria-label={backLabel ? `返回${backLabel}` : '返回'}
                onClick={onBack}
              >
                <IconChevronLeftOutlineRegular size={15} />
                <span>{backLabel || '返回'}</span>
              </button>
              <span className="fb-dialog-header-sep" aria-hidden="true">
                /
              </span>
            </>
          )}
          <div className="fb-dialog-title">{`${runtime.name} 启动配置`}</div>
        </div>
        <button type="button" className="fb-icon-btn" aria-label="关闭" onClick={onClose}>
          <IconCloseOutlineRegular size={14} />
        </button>
      </div>

      <nav className="fb-dialog-nav" aria-label="启动配置列表">
        <button
          type="button"
          className="fb-profile-new-btn"
          aria-current={selectedId === '__new__' ? 'page' : undefined}
          onClick={startNew}
        >
          <IconPlusOutlineRegular size={14} />
          <span>新建配置</span>
        </button>
        {profiles.map((p) => {
          const badge = sourceTagLabel(p.source)
          return (
            <button
              key={p.id}
              type="button"
              className="fb-nav-cell fb-profile-nav-item"
              aria-current={selectedId === p.id ? 'page' : undefined}
              onClick={() => selectExisting(p)}
            >
              <span className="fb-profile-nav-name" title={p.name}>
                {p.name}
              </span>
              {p.exposeAsPreset ? (
                <Tag tone="info">预设</Tag>
              ) : badge ? (
                <Tag tone="neutral">{badge}</Tag>
              ) : null}
            </button>
          )
        })}
      </nav>

      <div className="fb-dialog-options">
        {(caps.supportsEnv || caps.supportsConfigFile || caps.supportsCliProfile || caps.supportsArgs) && (
          <div className="fb-import-bar">
            <button
              type="button"
              className="fb-collapse-toggle"
              onClick={() => setShowImport((v) => !v)}
            >
              {showImport ? (
                <IconChevronDownOutlineRegular size={13} />
              ) : (
                <IconChevronRightOutlineRegular size={13} />
              )}
              <span>从命令行导入</span>
            </button>
            {showImport && (
              <div className="fb-import-box">
                <textarea
                  className="fb-textarea fb-mono fb-import-textarea"
                  rows={2}
                  spellCheck={false}
                  value={importCmd}
                  placeholder={commandImportPlaceholder(runtime, caps)}
                  onChange={(e) => setImportCmd(e.target.value)}
                />
                <div className="fb-import-foot">
                  <span className="fb-row-desc">本地静态解析，不会执行命令</span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!importCmd.trim()}
                    onClick={applyCommandImport}
                  >
                    解析填充
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        <GroupTitle>基本信息</GroupTitle>
        <SettingRow title="配置名称">
          <TextField
            value={draft.name}
            onChange={(name) => patch({ name })}
            placeholder="例如 personal 或 代理环境"
          />
        </SettingRow>
        <SettingRow title="说明">
          <TextField
            value={draft.description}
            onChange={(description) => patch({ description })}
            placeholder="选填，便于区分用途"
          />
        </SettingRow>
        {caps.supportsCliProfile && (
          <SettingRow
            title="CLI Profile"
            desc="对应 CLI 本地的 profile 名称（如 config.toml 中的配置名）"
          >
            <TextField
              value={draft.cliProfile}
              onChange={(cliProfile) => patch({ cliProfile })}
              placeholder="例如 personal"
              mono
            />
          </SettingRow>
        )}
        {caps.supportsConfigFile && (
          <SettingRow title="配置文件路径" desc="支持 ~ 路径展开">
            <TextField
              value={draft.configFile}
              onChange={(configFile) => patch({ configFile })}
              placeholder={caps.configFileHint ?? '~/.config/.../settings.json'}
              mono
            />
          </SettingRow>
        )}

        {caps.supportsEnv && (
          <>
            <GroupTitle>环境变量</GroupTitle>
            <div className="fb-env-editor">
              {draft.envRows.map((row) => {
                const secret = row.hasStoredSecret || isLikelySecretKey(row.key)
                return (
                  <div key={row.uid} className="fb-env-row">
                    <input
                      className="fb-field fb-mono fb-env-key"
                      type="text"
                      spellCheck={false}
                      value={row.key}
                      title={row.key || undefined}
                      placeholder="KEY"
                      onChange={(e) => updateEnvRow(row.uid, 'key', e.target.value)}
                    />
                    <span className="fb-env-val-box">
                      <input
                        className="fb-env-val-input fb-mono"
                        type={secret ? 'password' : 'text'}
                        autoComplete={secret ? 'new-password' : 'off'}
                        spellCheck={false}
                        value={row.value}
                        title={!secret && row.value ? row.value : undefined}
                        placeholder={row.hasStoredSecret ? '已保存，留空保持不变' : 'VALUE'}
                        onChange={(e) => updateEnvRow(row.uid, 'value', e.target.value)}
                      />
                      <button
                        type="button"
                        className="fb-env-remove"
                        aria-label={`移除 ${row.key || '环境变量'}`}
                        title="移除环境变量"
                        onClick={() => removeEnvRow(row)}
                      >
                        <IconCloseOutlineRegular size={13} />
                      </button>
                    </span>
                  </div>
                )
              })}
              <div className="fb-env-actions">
                <button type="button" className="fb-scope-add-btn" onClick={() => addEnvRow()}>
                  <IconPlusOutlineRegular size={12} />
                  <span>添加环境变量</span>
                </button>
                {availableEnvHints.map((hint) => (
                  <button
                    key={hint}
                    type="button"
                    className="fb-env-hint-btn fb-mono"
                    onClick={() => addEnvRow(hint)}
                  >
                    + {hint}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {((caps.supportsAuthMethod && (caps.authMethods?.length ?? 0) > 0) ||
          caps.supportsExposeAsPreset) && (
          <>
            <GroupTitle>认证与预设</GroupTitle>
            {caps.supportsAuthMethod && (caps.authMethods?.length ?? 0) > 0 && (
              <SettingRow title="认证方式">
                <SelectMenu
                  value={draft.authMethodId}
                  options={authOptions}
                  onChange={(authMethodId) => patch({ authMethodId })}
                />
              </SettingRow>
            )}
            {caps.supportsExposeAsPreset && (
              <SettingRow
                title="同步为 DSH 预设"
                desc="开启后可在 DSH 原生新建会话中直接选择"
              >
                <Switch
                  label="同步为 DSH 预设"
                  checked={draft.exposeAsPreset}
                  onChange={(exposeAsPreset) => patch({ exposeAsPreset })}
                />
              </SettingRow>
            )}
          </>
        )}

        <div className="fb-advanced-section">
          <button
            type="button"
            className="fb-collapse-toggle"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? (
              <IconChevronDownOutlineRegular size={13} />
            ) : (
              <IconChevronRightOutlineRegular size={13} />
            )}
            <span>高级选项</span>
          </button>
          {showAdvanced && (
            <>
              {caps.supportsArgs && (
                <>
                  <SettingRow title="附加启动参数" stack>
                    <TagInput
                      values={draft.args}
                      onChange={(args) => patch({ args })}
                      placeholder="回车添加，例如 --sandbox"
                      mono
                    />
                  </SettingRow>
                  <SettingRow title="参数模式">
                    <SelectMenu
                      value={draft.argsMode}
                      options={ARGS_MODE_OPTIONS}
                      onChange={(argsMode) => patch({ argsMode })}
                    />
                  </SettingRow>
                </>
              )}
              <SettingRow title="默认模型" desc="留空由 CLI 自动选择">
                <TextField
                  value={draft.defaultModel}
                  onChange={(defaultModel) => patch({ defaultModel })}
                  placeholder="例如 gpt-5.4 或 gemini-4-carbon"
                  mono
                />
              </SettingRow>
              {concurrency && (
                <RuntimeConcurrencyField
                  runtimeName={runtime.name}
                  profileName={draft.name.trim() || draft.id || '新启动配置'}
                  isProfile
                  inheritedLimit={
                    resolveRuntimeConcurrencyState(
                      concurrency,
                      runtime.id,
                      draft.id || '__draft__',
                    ).inheritedLimit
                  }
                  maxLimit={concurrency.maxLimit}
                  value={draft.concurrencyLimit}
                  disabled={busy}
                  onChange={(concurrencyLimit) => patch({ concurrencyLimit })}
                />
              )}
            </>
          )}
        </div>
      </div>

      <div className="fb-dialog-footer">
        {error ? (
          <span className="fb-dialog-error">{error}</span>
        ) : notice ? (
          <span className="fb-dialog-notice">{notice}</span>
        ) : null}
        {canDelete && (
          <Button variant="ghost" disabled={busy} onClick={() => void handleDelete()}>
            {deleting ? '删除中…' : '删除'}
          </Button>
        )}
        <Button variant="outline" disabled={busy} onClick={() => void handleProbe()}>
          {probing ? '测试中…' : '测试连接'}
        </Button>
        <Button variant="outline" disabled={busy} onClick={onBack ?? onClose}>
          {onBack ? '返回' : '取消'}
        </Button>
        <Button variant="primary" disabled={busy} onClick={() => void handleSave()}>
          {saving ? '保存中…' : '保存'}
        </Button>
      </div>
    </>
  )
}

export function RuntimeProfileDialog({
  open,
  runtime,
  initialProfileId,
  concurrency,
  onClose,
  onChanged,
}: {
  open: boolean
  runtime: RuntimeOption
  initialProfileId?: string
  concurrency?: RuntimeConcurrencyConfig
  onClose: () => void
  onChanged: (selectedProfileId?: string) => Promise<void>
}) {
  if (!open) return null
  return (
    <Modal
      open
      onClose={onClose}
      title={`${runtime.name} 启动配置`}
      headless
      className="fb-dialog fb-profile-dialog"
    >
      <RuntimeProfilePanel
        runtime={runtime}
        initialProfileId={initialProfileId}
        concurrency={concurrency}
        onClose={onClose}
        onChanged={onChanged}
      />
    </Modal>
  )
}
