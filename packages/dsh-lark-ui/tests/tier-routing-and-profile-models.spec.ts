import { describe, expect, it } from 'vitest'
import { buildPresetTierRouting } from '../src/presets.js'
import {
  buildEffectiveModelsForProfile,
  resolveProfileCatalogModels,
} from '../src/components/profile-models.js'
import type { ModelGroup, RuntimeOption } from '../src/types.js'

const RUNTIMES: RuntimeOption[] = [
  {
    id: 'agy',
    name: 'Antigravity',
    description: 'ACP runtime',
    kind: 'external',
    providerId: 'agy-cli',
    defaultModel: 'gemini-4-neon',
    supportsReasoningEffort: true,
    supportsProfiles: true,
    isDefault: false,
    profiles: [
      {
        id: 'custom-proxy',
        runtimeId: 'agy',
        name: 'custom-proxy',
        source: 'user',
        defaultModel: 'gemini-4-carbon',
        exposeAsPreset: true,
        presetId: 'agy:custom-proxy',
        providerId: 'agy--custom-proxy-cli',
      },
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    description: 'Codex runtime',
    kind: 'external',
    providerId: 'codex-cli',
    defaultModel: 'gpt-6.1-sol',
    supportsReasoningEffort: true,
    supportsProfiles: true,
    isDefault: true,
    profiles: [],
  },
]

const MODELS: ModelGroup[] = [
  {
    provider: 'agy-cli',
    name: 'Antigravity',
    isExternal: true,
    models: [
      { id: 'gemini-4-neon', name: 'Gemini 4 Neon', reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', reasoningEfforts: ['low', 'high'] },
    ],
  },
  {
    provider: 'agy--custom-proxy-cli',
    name: 'Antigravity (custom-proxy)',
    isExternal: true,
    models: [
      { id: 'gemini-4-neon', name: 'Gemini 4 Neon', reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', reasoningEfforts: ['low', 'medium', 'high'] },
    ],
  },
]

describe('Profile-specific real model resolution & tier routing presets', () => {
  it('resolves exposed profile provider models immediately without leaking incompatible base models', () => {
    const agy = RUNTIMES[0]!
    const direct = resolveProfileCatalogModels(agy, 'custom-proxy', MODELS, {})
    expect(direct?.map((m) => m.id)).toEqual(['gemini-4-neon', 'gemini-4-carbon'])

    const effective = buildEffectiveModelsForProfile(agy, 'custom-proxy', MODELS, {})
    const agyGroup = effective.find((g) => g.provider === 'agy-cli')
    expect(agyGroup?.models.map((m) => m.id)).toEqual(['gemini-4-neon', 'gemini-4-carbon'])
    expect(agyGroup?.models.some((m) => m.id === 'claude-opus-5-5')).toBe(false)
  })

  it('hides base runtime models while probing a non-exposed profile for the first time', () => {
    const agyNoExpose: RuntimeOption = {
      ...RUNTIMES[0]!,
      profiles: [{ id: 'unexposed', runtimeId: 'agy', name: 'unexposed', source: 'user' }],
    }
    const effectiveLoading = buildEffectiveModelsForProfile(
      agyNoExpose,
      'unexposed',
      MODELS,
      {},
      { loading: true },
    )
    expect(effectiveLoading.find((g) => g.provider === 'agy-cli')?.models).toEqual([])
  })

  it('builds recommended 3-tier Agy + Codex preset and inherits active profile id', () => {
    const preset = buildPresetTierRouting('recommended', {
      runtimes: RUNTIMES,
      defaultAgentPreset: 'agy',
      defaultProfileId: 'custom-proxy',
    })
    expect(preset.tiers.lite.targets).toEqual([
      expect.objectContaining({
        agentPreset: 'agy',
        runtimeProfileId: 'custom-proxy',
        model: 'gemini-4-neon',
        reasoningEffort: 'low',
        weight: 70,
      }),
      expect.objectContaining({
        agentPreset: 'codex',
        runtimeProfileId: '',
        model: 'gpt-6.1-sol',
        reasoningEffort: 'low',
        weight: 30,
      }),
    ])
    expect(preset.tiers.standard.targets).toEqual([
      expect.objectContaining({ agentPreset: 'agy', model: 'gemini-4-neon', reasoningEffort: 'xhigh', weight: 70 }),
      expect.objectContaining({ agentPreset: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh', weight: 30 }),
    ])
    expect(preset.tiers.heavy.targets).toEqual([
      expect.objectContaining({ agentPreset: 'agy', model: 'gemini-4-carbon', reasoningEffort: 'high', weight: 70 }),
      expect.objectContaining({ agentPreset: 'codex', model: 'gpt-6-astra', reasoningEffort: 'xhigh', weight: 30 }),
    ])
  })
})
