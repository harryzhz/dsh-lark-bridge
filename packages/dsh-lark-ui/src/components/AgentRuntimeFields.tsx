import { useEffect, useMemo, useState } from 'react'
import { IconSettingsOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgeApi } from '../api.js'
import type {
  CatalogModelItem,
  ModelGroup,
  RuntimeConcurrencyConfig,
  RuntimeOption,
  RuntimeProfileSummary,
} from '../types.js'
import { SelectMenu, SettingRow, TextField, type SelectOption } from './fields.js'
import {
  catalogModelsForRuntime,
  effectiveDefaultModel,
  modelOptions,
  normalizeModelAndEffort,
  reasoningEffortOptions,
  runtimeOptions,
} from './options.js'
import {
  RuntimeConcurrencyField,
  resolveRuntimeConcurrencyState,
} from './RuntimeConcurrencyField.js'
import { RuntimeProfileDialog } from './RuntimeProfileDialog.js'

export interface AgentRuntimeSelection {
  agentPreset: string
  runtimeProfileId?: string
  model: string
  reasoningEffort: string
}

function buildProfileSelectOptions(
  profiles: readonly RuntimeProfileSummary[],
  currentProfileId: string,
): SelectOption<string>[] {
  const options: SelectOption<string>[] = [{ value: '', label: '默认配置' }]
  const discovered = profiles.filter((p) => p.source === 'discovered')
  const configured = profiles.filter((p) => p.source === 'config')
  const user = profiles.filter((p) => p.source === 'user')

  const pushGroup = (items: readonly RuntimeProfileSummary[], group: string) => {
    for (const p of items) {
      const desc =
        p.description ||
        (p.configFile ? p.configFile : p.cliProfile ? `profile: ${p.cliProfile}` : undefined)
      options.push({
        value: p.id,
        label: p.name,
        group,
        ...(desc ? { desc } : {}),
      })
    }
  }
  pushGroup(discovered, '自动发现')
  pushGroup(configured, '配置')
  pushGroup(user, '自定义')

  if (currentProfileId && !options.some((o) => o.value === currentProfileId)) {
    options.push({ value: currentProfileId, label: currentProfileId, group: '自定义' })
  }
  return options
}

function profileRowDescription(profile: RuntimeProfileSummary | undefined): string | undefined {
  if (!profile) return undefined
  if (profile.description) return profile.description
  if (profile.configFile) return profile.configFile
  if (profile.cliProfile) return `CLI Profile：${profile.cliProfile}`
  const envCount = Object.keys(profile.env ?? {}).length
  if (envCount > 0) return `已配置 ${envCount} 个环境变量`
  return undefined
}

/**
 * Shared Agent runtime configuration fields (`运行时` + `启动配置` + `模型` + `推理强度`),
 * used identically across Bot creation, Bot settings, and Group overrides.
 */
export function AgentRuntimeFields({
  runtimeTitle = '运行时',
  value,
  runtimes,
  models,
  concurrency,
  concurrencyDraft,
  disabled,
  profileRevision = 0,
  onChange,
  onConcurrencyChange,
  onProfilesChanged,
  onManageProfiles,
}: {
  runtimeTitle?: string
  value: AgentRuntimeSelection
  runtimes: readonly RuntimeOption[]
  models: readonly ModelGroup[]
  concurrency?: RuntimeConcurrencyConfig
  /** Pending draft override for the currently selected `(runtime, profile)`; `undefined` = untouched. */
  concurrencyDraft?: number | null | undefined
  disabled?: boolean
  profileRevision?: number
  onChange: (next: AgentRuntimeSelection) => void
  onConcurrencyChange?: (next: number | null) => void
  onProfilesChanged?: () => Promise<void>
  onManageProfiles?: (runtime: RuntimeOption, initialProfileId?: string) => void
}) {
  const runtime = runtimes.find((r) => r.id === value.agentPreset)
  const activeProfileId = value.runtimeProfileId?.trim() ?? ''
  const profiles = runtime?.profiles ?? []
  const activeProfile = activeProfileId
    ? profiles.find((p) => p.id === activeProfileId)
    : undefined
  const showProfileRow = Boolean(runtime?.kind === 'external' && runtime.supportsProfiles)

  const [manageOpen, setManageOpen] = useState(false)
  const [profileCatalogs, setProfileCatalogs] = useState<Record<string, CatalogModelItem[]>>({})
  const [loadingProfileModels, setLoadingProfileModels] = useState(false)
  const [catalogRevision, setCatalogRevision] = useState(0)

  const cacheKey = runtime && activeProfileId ? `${runtime.id}::${activeProfileId}` : ''
  const effectiveRevision = catalogRevision + profileRevision

  useEffect(() => {
    if (!runtime || runtime.kind !== 'external' || !activeProfileId) {
      setLoadingProfileModels(false)
      return
    }
    let cancelled = false
    setLoadingProfileModels(true)
    void bridgeApi
      .profileModels(runtime.id, activeProfileId)
      .then((items) => {
        if (cancelled) return
        setProfileCatalogs((prev) => ({ ...prev, [cacheKey]: items }))
      })
      .catch(() => {
        // Keep base runtime model catalog as fallback if live probe fails.
      })
      .finally(() => {
        if (!cancelled) setLoadingProfileModels(false)
      })
    return () => {
      cancelled = true
    }
  }, [runtime?.id, runtime?.kind, activeProfileId, cacheKey, effectiveRevision])

  const effectiveModels = useMemo<readonly ModelGroup[]>(() => {
    if (!runtime?.providerId || !cacheKey) return models
    const override = profileCatalogs[cacheKey]
    if (!override || override.length === 0) return models
    const exists = models.some((g) => g.provider === runtime.providerId)
    if (!exists) {
      return [...models, { provider: runtime.providerId, name: runtime.name, models: override }]
    }
    return models.map((g) =>
      g.provider === runtime.providerId ? { ...g, models: override } : g,
    )
  }, [models, runtime, cacheKey, profileCatalogs])

  const effectiveRuntime = useMemo<RuntimeOption | undefined>(() => {
    if (!runtime) return undefined
    if (!activeProfile?.defaultModel) return runtime
    return { ...runtime, defaultModel: activeProfile.defaultModel }
  }, [runtime, activeProfile])

  const normalized = normalizeModelAndEffort(
    effectiveRuntime,
    effectiveModels,
    value.model,
    value.reasoningEffort,
  )
  const catalog = catalogModelsForRuntime(effectiveRuntime, effectiveModels)
  const useModelDropdown = runtime?.kind === 'external' || catalog.length > 0
  const effortMeta = reasoningEffortOptions(
    effectiveRuntime,
    effectiveModels,
    normalized.model,
    normalized.reasoningEffort,
  )

  const concurrencyState = useMemo(
    () =>
      concurrency && runtime
        ? resolveRuntimeConcurrencyState(concurrency, runtime.id, activeProfileId || undefined)
        : undefined,
    [concurrency, runtime, activeProfileId],
  )

  return (
    <>
      <SettingRow
        title={runtimeTitle}
        desc={runtime?.broken ?? runtime?.description ?? '选择处理飞书消息的智能体运行时'}
      >
        <SelectMenu
          value={value.agentPreset}
          options={runtimeOptions(runtimes)}
          disabled={disabled}
          onChange={(agentPreset) => {
            const nextRt = runtimes.find((r) => r.id === agentPreset)
            const nextModel = effectiveDefaultModel(nextRt, models)
            const nextNorm = normalizeModelAndEffort(nextRt, models, nextModel, '')
            onChange({
              agentPreset,
              runtimeProfileId: '',
              model: nextNorm.model,
              reasoningEffort: nextNorm.reasoningEffort,
            })
          }}
        />
      </SettingRow>

      {showProfileRow && runtime && (
        <SettingRow title="启动配置" desc={profileRowDescription(activeProfile)}>
          <SelectMenu
            value={activeProfileId}
            options={buildProfileSelectOptions(profiles, activeProfileId)}
            footer={
              !disabled
                ? [
                    {
                      id: '__manage_profiles__',
                      label: '管理启动配置…',
                      icon: <IconSettingsOutlineRegular size={14} />,
                      onSelect: () => {
                        if (onManageProfiles) {
                          onManageProfiles(runtime, activeProfileId || undefined)
                        } else {
                          setManageOpen(true)
                        }
                      },
                    },
                  ]
                : undefined
            }
            disabled={disabled}
            onChange={(nextProfileId) => {
              const nextProfile = nextProfileId
                ? profiles.find((p) => p.id === nextProfileId)
                : undefined
              const nextKey = nextProfileId ? `${runtime.id}::${nextProfileId}` : ''
              const cachedList = nextKey ? profileCatalogs[nextKey] : undefined
              const nextModels =
                cachedList && cachedList.length > 0 && runtime.providerId
                  ? models.map((g) =>
                      g.provider === runtime.providerId ? { ...g, models: cachedList } : g,
                    )
                  : models
              const nextRt = nextProfile?.defaultModel
                ? { ...runtime, defaultModel: nextProfile.defaultModel }
                : runtime
              const preferredModel = nextProfile?.defaultModel
                ? nextProfile.defaultModel
                : nextProfileId
                  ? cachedList?.find((m) => m.isDefault)?.id ?? ''
                  : effectiveDefaultModel(runtime, models)
              const nextEffort = nextProfile?.defaultReasoningEffort ?? ''
              const nextNorm = normalizeModelAndEffort(
                nextRt,
                nextModels,
                preferredModel,
                nextEffort,
              )
              onChange({
                agentPreset: value.agentPreset,
                runtimeProfileId: nextProfileId,
                model: nextNorm.model,
                reasoningEffort: nextNorm.reasoningEffort,
              })
            }}
          />
        </SettingRow>
      )}

      {useModelDropdown ? (
        <SettingRow title="模型">
          <SelectMenu
            value={normalized.model}
            options={modelOptions(effectiveRuntime, effectiveModels, normalized.model)}
            disabled={disabled}
            onChange={(nextModel) => {
              const nextNorm = normalizeModelAndEffort(
                effectiveRuntime,
                effectiveModels,
                nextModel,
                normalized.reasoningEffort,
              )
              onChange({
                agentPreset: value.agentPreset,
                runtimeProfileId: activeProfileId,
                model: nextNorm.model,
                reasoningEffort: nextNorm.reasoningEffort,
              })
            }}
            placeholder={loadingProfileModels ? '加载模型中…' : '默认模型'}
          />
        </SettingRow>
      ) : (
        <SettingRow title="模型" desc="留空使用默认模型">
          <TextField
            value={normalized.model}
            disabled={disabled}
            onChange={(nextModel) =>
              onChange({
                agentPreset: value.agentPreset,
                runtimeProfileId: activeProfileId,
                model: nextModel,
                reasoningEffort: normalized.reasoningEffort,
              })
            }
            placeholder="默认模型"
            mono
          />
        </SettingRow>
      )}

      <SettingRow
        title="推理强度"
        desc={!effortMeta.supported ? '当前模型不支持手动调节' : undefined}
      >
        <SelectMenu
          value={effortMeta.supported ? normalized.reasoningEffort : ''}
          options={effortMeta.options}
          disabled={disabled || !effortMeta.supported}
          onChange={(reasoningEffort) =>
            onChange({
              agentPreset: value.agentPreset,
              runtimeProfileId: activeProfileId,
              model: normalized.model,
              reasoningEffort,
            })
          }
        />
      </SettingRow>

      {concurrencyState && runtime && onConcurrencyChange && (
        <RuntimeConcurrencyField
          runtimeName={runtime.name}
          profileName={activeProfile?.name || activeProfileId || undefined}
          isProfile={concurrencyState.isProfile}
          inheritedLimit={concurrencyState.inheritedLimit}
          maxLimit={concurrencyState.maxLimit}
          value={concurrencyDraft !== undefined ? concurrencyDraft : concurrencyState.customLimit}
          disabled={disabled}
          onChange={onConcurrencyChange}
        />
      )}

      {showProfileRow && runtime && !onManageProfiles && (
        <RuntimeProfileDialog
          open={manageOpen}
          runtime={runtime}
          initialProfileId={activeProfileId || undefined}
          concurrency={concurrency}
          onClose={() => setManageOpen(false)}
          onChanged={async (nextProfileId) => {
            setProfileCatalogs((prev) => {
              const next: Record<string, CatalogModelItem[]> = {}
              for (const [k, v] of Object.entries(prev)) {
                if (!k.startsWith(`${runtime.id}::`)) next[k] = v
              }
              return next
            })
            setCatalogRevision((v) => v + 1)
            await onProfilesChanged?.()
            if (nextProfileId !== undefined) {
              onChange({
                agentPreset: value.agentPreset,
                runtimeProfileId: nextProfileId,
                model: '',
                reasoningEffort: '',
              })
            }
          }}
        />
      )}
    </>
  )
}
