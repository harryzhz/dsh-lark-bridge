import { useMemo, useState } from 'react'
import {
  Button,
  IconCloseOutlineRegular,
  IconPlusOutlineRegular,
  Switch,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  DEFAULT_TIER_DESCRIPTIONS,
  TASK_DIFFICULTY_TIERS,
  TIER_LABELS,
  TIER_ROUTING_BYPASS_OPTIONS,
  TIER_ROUTING_PRESET_OPTIONS,
  buildPresetTierRouting,
  cloneTierRouting,
} from '../presets.js'
import type {
  ModelGroup,
  RuntimeOption,
  TaskDifficultyTier,
  TierRoutingConfig,
  TierRoutingTarget,
} from '../types.js'
import {
  FilterTabs,
  GroupTitle,
  SelectMenu,
  SettingRow,
  TextField,
  type SelectOption,
} from './fields.js'
import {
  effectiveDefaultModel,
  modelOptions,
  normalizeModelAndEffort,
  reasoningEffortOptions,
  runtimeOptions,
} from './options.js'
import {
  buildEffectiveModelsForProfile,
  profileCatalogCacheKey,
  useProfileModelCatalogs,
} from './profile-models.js'

function hasAnyTargets(config: TierRoutingConfig): boolean {
  return TASK_DIFFICULTY_TIERS.some((t) => config.tiers[t].targets.length > 0)
}

function buildCompactProfileOptions(
  runtime: RuntimeOption | undefined,
  currentProfileId: string,
): SelectOption<string>[] {
  const options: SelectOption<string>[] = [{ value: '', label: '默认配置' }]
  for (const p of runtime?.profiles ?? []) {
    options.push({ value: p.id, label: p.name })
  }
  if (currentProfileId && !options.some((o) => o.value === currentProfileId)) {
    options.push({ value: currentProfileId, label: currentProfileId })
  }
  return options
}

function makeTargetId(tier: TaskDifficultyTier): string {
  return `${tier}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 3-tier difficulty routing (`lite` / `standard` / `heavy`) with weighted
 * `(Agent, Profile, Model, ReasoningEffort)` pools. Lives directly inside the
 * Smart Triage section so routing remains a single source of truth.
 */
export function TierRoutingFields({
  value,
  runtimes,
  models,
  defaultAgentPreset,
  defaultProfileId,
  defaultModel,
  onChange,
}: {
  value: TierRoutingConfig | undefined
  runtimes: readonly RuntimeOption[]
  models: readonly ModelGroup[]
  defaultAgentPreset?: string
  defaultProfileId?: string
  defaultModel?: string
  onChange: (next: TierRoutingConfig) => void
}) {
  const [activeTier, setActiveTier] = useState<TaskDifficultyTier>('lite')
  const config = useMemo(() => cloneTierRouting(value), [value])

  const allPairs = useMemo(
    () =>
      TASK_DIFFICULTY_TIERS.flatMap((tier) =>
        config.tiers[tier].targets.map((t) => ({
          runtimeId: t.agentPreset,
          ...(t.runtimeProfileId ? { profileId: t.runtimeProfileId } : {}),
        })),
      ),
    [config],
  )
  const { catalogs: profileCatalogs, loadingKeys } = useProfileModelCatalogs(
    allPairs,
    runtimes,
    models,
  )

  const runtimeChoices = useMemo(() => runtimeOptions(runtimes), [runtimes])

  const patchConfig = (patch: Partial<TierRoutingConfig>) => {
    onChange({ ...config, ...patch })
  }

  const updateTierTargets = (
    tier: TaskDifficultyTier,
    updater: (prev: readonly TierRoutingTarget[]) => TierRoutingTarget[],
  ) => {
    const nextTargets = updater(config.tiers[tier].targets)
    onChange({
      ...config,
      presetKey: 'custom',
      tiers: {
        ...config.tiers,
        [tier]: {
          ...config.tiers[tier],
          targets: nextTargets,
        },
      },
    })
  }

  const updateTierPrompt = (tier: TaskDifficultyTier, prompt: string) => {
    onChange({
      ...config,
      tiers: {
        ...config.tiers,
        [tier]: {
          ...config.tiers[tier],
          prompt,
        },
      },
    })
  }

  const handleToggleEnabled = (enabled: boolean) => {
    if (enabled && !hasAnyTargets(config)) {
      const preset = buildPresetTierRouting('recommended', {
        runtimes,
        ...(defaultAgentPreset ? { defaultAgentPreset } : {}),
        ...(defaultProfileId ? { defaultProfileId } : {}),
        ...(defaultModel ? { defaultModel } : {}),
      })
      onChange({ ...preset, enabled: true, bypassTier: config.bypassTier })
      return
    }
    patchConfig({ enabled })
  }

  const handleSelectPreset = (nextPreset: string) => {
    if (nextPreset === 'custom') {
      patchConfig({ presetKey: 'custom' })
      return
    }
    const built = buildPresetTierRouting(nextPreset, {
      runtimes,
      ...(defaultAgentPreset ? { defaultAgentPreset } : {}),
      ...(defaultProfileId ? { defaultProfileId } : {}),
      ...(defaultModel ? { defaultModel } : {}),
    })
    onChange({
      ...built,
      enabled: config.enabled,
      bypassTier: config.bypassTier,
    })
  }

  const handleAddTarget = (tier: TaskDifficultyTier) => {
    const fallbackRt =
      runtimes.find((r) => r.id === defaultAgentPreset && !r.broken) ??
      runtimes.find((r) => !r.broken) ??
      runtimes[0]
    const rtId = fallbackRt?.id ?? 'agy'
    const profId =
      rtId === defaultAgentPreset && defaultProfileId ? defaultProfileId : ''
    const effModels = buildEffectiveModelsForProfile(
      fallbackRt,
      profId,
      models,
      profileCatalogs,
    )
    const modelId = effectiveDefaultModel(fallbackRt, effModels)
    const defaultEffort = tier === 'lite' ? 'low' : tier === 'heavy' ? 'xhigh' : 'high'
    const norm = normalizeModelAndEffort(fallbackRt, effModels, modelId, defaultEffort)
    updateTierTargets(tier, (prev) => [
      ...prev,
      {
        id: makeTargetId(tier),
        agentPreset: rtId,
        runtimeProfileId: profId,
        model: norm.model,
        reasoningEffort: norm.reasoningEffort,
        weight: 50,
        enabled: true,
      },
    ])
  }

  const tierTabOptions = TASK_DIFFICULTY_TIERS.map((tier) => ({
    value: tier,
    label: TIER_LABELS[tier],
    count: config.tiers[tier].targets.filter((t) => t.enabled !== false && t.weight > 0).length,
  }))

  const activeTargets = config.tiers[activeTier].targets
  const activeTotalWeight = activeTargets.reduce(
    (sum, t) => sum + (t.enabled !== false && t.weight > 0 ? t.weight : 0),
    0,
  )

  return (
    <>
      <GroupTitle>按难度路由</GroupTitle>
      <SettingRow
        title="启用按难度路由"
        desc="新话题首轮按任务复杂度自动分档并按权重分配运行时与模型，已有会话保持锁定"
      >
        <Switch
          label="启用按难度路由"
          checked={config.enabled}
          onChange={handleToggleEnabled}
        />
      </SettingRow>

      {config.enabled && (
        <>
          <SettingRow title="推荐预设" desc="一键填充轻量、标准、深度三档推荐组合，随后可自由增删与调整权重">
            <SelectMenu
              value={config.presetKey || 'custom'}
              options={TIER_ROUTING_PRESET_OPTIONS}
              onChange={handleSelectPreset}
            />
          </SettingRow>

          <SettingRow
            title="直通规则落档"
            desc="命中文件附件、关键词或发送者直通规则的新话题落入的档位"
          >
            <SelectMenu
              value={config.bypassTier}
              options={TIER_ROUTING_BYPASS_OPTIONS}
              onChange={(bypassTier) => patchConfig({ bypassTier })}
            />
          </SettingRow>

          <SettingRow
            title="档位与组合权重"
            desc="同档位内按权重分配新会话，并自动优先选择有空闲并发槽位的健康组合"
            stack
          >
            <div className="fb-tier-panel">
              <div className="fb-tier-bar">
                <FilterTabs
                  label="难度档位"
                  value={activeTier}
                  options={tierTabOptions}
                  onChange={setActiveTier}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<IconPlusOutlineRegular size={13} />}
                  onClick={() => handleAddTarget(activeTier)}
                >
                  添加组合
                </Button>
              </div>

              <div className="fb-tier-prompt-row">
                <TextField
                  value={config.tiers[activeTier].prompt}
                  onChange={(prompt) => updateTierPrompt(activeTier, prompt)}
                  placeholder={`判档说明（留空默认：${DEFAULT_TIER_DESCRIPTIONS[activeTier]}）`}
                />
              </div>

              {activeTargets.length === 0 ? (
                <div className="fb-tier-empty">
                  该档位暂无候选组合，命中时将回退默认运行时。点击右上角「添加组合」配置。
                </div>
              ) : (
                <div className="fb-tier-list">
                  {activeTargets.map((target, index) => {
                    const rt = runtimes.find((r) => r.id === target.agentPreset)
                    const hasProfiles = Boolean(
                      rt?.kind === 'external' &&
                        rt.supportsProfiles &&
                        ((rt.profiles?.length ?? 0) > 0 || Boolean(target.runtimeProfileId)),
                    )
                    const cacheKey = profileCatalogCacheKey(
                      target.agentPreset,
                      target.runtimeProfileId,
                    )
                    const isLoadingProfile = Boolean(cacheKey && loadingKeys.has(cacheKey))
                    const effModels = buildEffectiveModelsForProfile(
                      rt,
                      target.runtimeProfileId,
                      models,
                      profileCatalogs,
                      { loading: isLoadingProfile },
                    )
                    const activeProfile = target.runtimeProfileId
                      ? rt?.profiles?.find((p) => p.id === target.runtimeProfileId)
                      : undefined
                    const effRt =
                      rt && activeProfile?.defaultModel
                        ? { ...rt, defaultModel: activeProfile.defaultModel }
                        : rt
                    const norm = normalizeModelAndEffort(
                      effRt,
                      effModels,
                      target.model,
                      target.reasoningEffort,
                    )
                    const mOpts = modelOptions(effRt, effModels, norm.model)
                    const effortMeta = reasoningEffortOptions(
                      effRt,
                      effModels,
                      norm.model,
                      norm.reasoningEffort,
                    )
                    const sharePct =
                      activeTotalWeight > 0 && target.enabled !== false && target.weight > 0
                        ? Math.round((target.weight / activeTotalWeight) * 100)
                        : 0

                    const patchRow = (patch: Partial<TierRoutingTarget>) => {
                      updateTierTargets(activeTier, (prev) =>
                        prev.map((item, idx) => (idx === index ? { ...item, ...patch } : item)),
                      )
                    }

                    return (
                      <div key={target.id} className="fb-tier-row">
                        <div className="fb-tier-row-top">
                          <div className="fb-tier-field fb-tier-field-rt">
                            <SelectMenu
                              value={target.agentPreset}
                              options={runtimeChoices}
                              fullWidth
                              onChange={(nextPreset) => {
                                const nextRt = runtimes.find((r) => r.id === nextPreset)
                                const nextProf =
                                  nextPreset === defaultAgentPreset && defaultProfileId
                                    ? defaultProfileId
                                    : ''
                                const nextEffModels = buildEffectiveModelsForProfile(
                                  nextRt,
                                  nextProf,
                                  models,
                                  profileCatalogs,
                                )
                                const nextModel = effectiveDefaultModel(nextRt, nextEffModels)
                                const nextNorm = normalizeModelAndEffort(
                                  nextRt,
                                  nextEffModels,
                                  nextModel,
                                  target.reasoningEffort,
                                )
                                patchRow({
                                  agentPreset: nextPreset,
                                  runtimeProfileId: nextProf,
                                  model: nextNorm.model,
                                  reasoningEffort: nextNorm.reasoningEffort,
                                })
                              }}
                            />
                          </div>

                          {hasProfiles && (
                            <div className="fb-tier-field fb-tier-field-prof">
                              <SelectMenu
                                value={target.runtimeProfileId}
                                options={buildCompactProfileOptions(rt, target.runtimeProfileId)}
                                fullWidth
                                onChange={(nextProf) => {
                                  const profMeta = nextProf
                                    ? rt?.profiles?.find((p) => p.id === nextProf)
                                    : undefined
                                  const nextEffModels = buildEffectiveModelsForProfile(
                                    rt,
                                    nextProf,
                                    models,
                                    profileCatalogs,
                                  )
                                  const nextRt = profMeta?.defaultModel && rt
                                    ? { ...rt, defaultModel: profMeta.defaultModel }
                                    : rt
                                  const preferredModel = profMeta?.defaultModel
                                    ? profMeta.defaultModel
                                    : effectiveDefaultModel(nextRt, nextEffModels)
                                  const nextNorm = normalizeModelAndEffort(
                                    nextRt,
                                    nextEffModels,
                                    preferredModel,
                                    profMeta?.defaultReasoningEffort ?? target.reasoningEffort,
                                  )
                                  patchRow({
                                    runtimeProfileId: nextProf,
                                    model: nextNorm.model,
                                    reasoningEffort: nextNorm.reasoningEffort,
                                  })
                                }}
                              />
                            </div>
                          )}

                          <div className="fb-tier-weight" title="相对权重（同档内按权重比例分配）">
                            <span className="fb-tier-weight-label">权重</span>
                            <input
                              type="number"
                              className="fb-tier-weight-input"
                              min={0}
                              max={1000}
                              step={5}
                              value={target.weight}
                              aria-label="权重"
                              onChange={(e) => {
                                const parsed = Math.max(
                                  0,
                                  Math.min(1000, Math.round(Number(e.target.value) || 0)),
                                )
                                patchRow({ weight: parsed })
                              }}
                            />
                            <span className="fb-tier-share">{sharePct}%</span>
                          </div>

                          <button
                            type="button"
                            className="fb-icon-btn fb-tier-remove"
                            aria-label="移除组合"
                            title="移除组合"
                            onClick={() =>
                              updateTierTargets(activeTier, (prev) =>
                                prev.filter((_, idx) => idx !== index),
                              )
                            }
                          >
                            <IconCloseOutlineRegular size={13} />
                          </button>
                        </div>

                        <div className="fb-tier-row-bottom">
                          <div className="fb-tier-field fb-tier-field-model">
                            <SelectMenu
                              value={norm.model}
                              options={mOpts}
                              fullWidth
                              placeholder={isLoadingProfile ? '加载模型中…' : '默认模型'}
                              onChange={(nextModel) => {
                                const nextNorm = normalizeModelAndEffort(
                                  effRt,
                                  effModels,
                                  nextModel,
                                  norm.reasoningEffort,
                                )
                                patchRow({
                                  model: nextNorm.model,
                                  reasoningEffort: nextNorm.reasoningEffort,
                                })
                              }}
                            />
                          </div>

                          <div className="fb-tier-field fb-tier-field-effort">
                            <SelectMenu
                              value={effortMeta.supported ? norm.reasoningEffort : ''}
                              options={effortMeta.options}
                              disabled={!effortMeta.supported}
                              fullWidth
                              onChange={(reasoningEffort) => patchRow({ reasoningEffort })}
                            />
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </SettingRow>
        </>
      )}
    </>
  )
}
