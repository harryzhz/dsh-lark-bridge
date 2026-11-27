import { describe, expect, it } from 'vitest'
import { buildGenerationEngineOptions } from '../src/components/prompt-generator-model.js'
import type { ModelGroup, RuntimeOption } from '../src/types.js'

const SAMPLE_RUNTIMES: readonly RuntimeOption[] = [
  {
    id: 'agy',
    name: 'Antigravity',
    description: 'Antigravity CLI',
    kind: 'external',
    group: 'custom',
    providerId: 'agy-cli',
    defaultModel: 'gemini-4-neon',
    supportsReasoningEffort: true,
    isDefault: false,
    profiles: [
      {
        id: 'work',
        runtimeId: 'agy',
        name: '工作账号',
        source: 'user',
      },
    ],
  },
  {
    id: 'standard',
    name: '标准模式',
    description: 'DSH 标准模式',
    kind: 'native',
    group: 'builtin',
    supportsReasoningEffort: false,
    isDefault: true,
  },
  {
    id: 'broken-rt',
    name: 'Broken',
    description: 'Broken runtime',
    kind: 'external',
    group: 'custom',
    providerId: 'broken-cli',
    supportsReasoningEffort: false,
    isDefault: false,
    broken: 'not installed',
  },
]

const SAMPLE_MODELS: readonly ModelGroup[] = [
  {
    provider: 'deepseek',
    name: 'DeepSeek',
    isExternal: false,
    models: [
      { provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { provider: 'deepseek', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ],
  },
  {
    provider: 'agy-cli',
    name: 'Antigravity CLI',
    isExternal: true,
    models: [{ provider: 'agy-cli', id: 'gemini-4-neon', name: 'Gemini 4 Neon' }],
  },
]

describe('buildGenerationEngineOptions', () => {
  it('lists current runtime, configured native models, and healthy agent runtimes with profiles', () => {
    const { choices, defaultId } = buildGenerationEngineOptions({
      runtimes: SAMPLE_RUNTIMES,
      models: SAMPLE_MODELS,
      currentRuntime: {
        agentPreset: 'agy',
        model: 'gemini-4-neon',
      },
      preferredNativeModel: {
        provider: 'deepseek',
        model: 'deepseek-chat',
      },
    })

    expect(defaultId).toBe('model::deepseek::deepseek-chat')
    expect(choices.some((c) => c.group === '当前配置' && c.target.kind === 'runtime')).toBe(true)
    expect(choices.some((c) => c.id === 'model::deepseek::deepseek-chat')).toBe(true)
    // External CLI models must not appear as native models
    expect(choices.some((c) => c.id === 'model::agy-cli::gemini-4-neon')).toBe(false)
    // Broken runtime is excluded
    expect(choices.some((c) => c.id.includes('broken-rt'))).toBe(false)
    // Runtime profile is included
    expect(
      choices.some(
        (c) =>
          c.group === 'Agent 运行时' &&
          c.target.kind === 'runtime' &&
          c.target.agentPreset === 'agy' &&
          c.target.runtimeProfileId === 'work',
      ),
    ).toBe(true)
  })

  it('falls back to current Agent runtime when no native models are configured', () => {
    const { choices, defaultId } = buildGenerationEngineOptions({
      runtimes: SAMPLE_RUNTIMES,
      models: [SAMPLE_MODELS[1]!],
      currentRuntime: {
        agentPreset: 'agy',
        model: 'gemini-4-neon',
      },
    })

    expect(defaultId).toContain('runtime::current::agy')
    const picked = choices.find((c) => c.id === defaultId)
    expect(picked?.target).toMatchObject({
      kind: 'runtime',
      agentPreset: 'agy',
      model: 'gemini-4-neon',
    })
  })
})
