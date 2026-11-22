import { describe, expect, it } from 'vitest'
import {
  enhanceDirectory,
  filterModelDirectoryState,
  type DshModelDirectoryState,
} from '../src/session-model-filter.js'

const ALL_GROUPS_STATE: DshModelDirectoryState = {
  current: { provider: 'codex-cli', model: 'gpt-6.1-sol', reasoningEffort: 'low' },
  retainedEffort: 'low',
  routable: true,
  status: 'ready',
  pending: null,
  error: null,
  failures: [
    { id: 'codex-cli', name: 'Codex', message: 'codex warn' },
    { id: 'deepseek-account', name: 'DeepSeek', message: 'auth expired' },
  ],
  groups: [
    {
      id: 'codex-cli',
      name: 'Codex',
      models: [
        {
          id: 'gpt-6.1-sol',
          name: 'GPT-6.1-Sol',
          reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'xhigh', name: 'xhigh' }], defaultEffort: 'xhigh' },
        },
      ],
    },
    {
      id: 'trae-cli',
      name: 'Trae',
      models: [
        { id: 'Doubao-Seed-2.0-Code', name: 'Doubao-Seed-2.0-Code' },
        {
          id: 'gpt-6.1-sol',
          name: 'GPT-6.1-Sol',
          reasoning: { efforts: [{ id: 'medium', name: 'medium' }], defaultEffort: 'medium' },
        },
      ],
    },
    {
      id: 'agy-cli',
      name: 'Antigravity',
      models: [
        {
          id: 'gemini-4-neon',
          name: 'Gemini 4 Neon',
          reasoning: { efforts: [{ id: 'high', name: 'high' }], defaultEffort: 'high' },
        },
      ],
    },
    {
      id: 'deepseek-account',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-chat', name: 'DeepSeek V4' }],
    },
  ],
}

describe('filterModelDirectoryState', () => {
  it('filters groups to ONLY the selected external Agent and replaces foreign current selection', () => {
    const traeFiltered = filterModelDirectoryState(ALL_GROUPS_STATE, 'trae')
    expect(traeFiltered.groups.map((g) => g.id)).toEqual(['trae-cli'])
    expect(traeFiltered.failures).toEqual([])
    expect(traeFiltered.current).toEqual({
      provider: 'trae-cli',
      model: 'Doubao-Seed-2.0-Code',
    })
    expect(traeFiltered.retainedEffort).toBeUndefined()
    expect(traeFiltered.routable).toBe(true)

    const agyFiltered = filterModelDirectoryState(ALL_GROUPS_STATE, 'agy')
    expect(agyFiltered.groups.map((g) => g.id)).toEqual(['agy-cli'])
    expect(agyFiltered.current).toEqual({
      provider: 'agy-cli',
      model: 'gemini-4-neon',
      reasoningEffort: 'high',
    })
    expect(agyFiltered.retainedEffort).toBe('high')
  })

  it('preserves user selection when it already belongs to the active external Agent', () => {
    const withTraeGpt: DshModelDirectoryState = {
      ...ALL_GROUPS_STATE,
      current: { provider: 'trae-cli', model: 'gpt-6.1-sol', reasoningEffort: 'medium' },
      retainedEffort: 'medium',
    }
    const filtered = filterModelDirectoryState(withTraeGpt, 'trae')
    expect(filtered.groups.map((g) => g.id)).toEqual(['trae-cli'])
    expect(filtered.current).toEqual({
      provider: 'trae-cli',
      model: 'gpt-6.1-sol',
      reasoningEffort: 'medium',
    })
  })

  it('filters built-in native presets to ONLY non-external LLM providers', () => {
    const nativeFiltered = filterModelDirectoryState(ALL_GROUPS_STATE, 'standard')
    expect(nativeFiltered.groups.map((g) => g.id)).toEqual(['deepseek-account'])
    expect(nativeFiltered.failures.map((f) => f.id)).toEqual(['deepseek-account'])
    expect(nativeFiltered.current).toEqual({
      provider: 'deepseek-account',
      model: 'deepseek-chat',
    })
  })

  it('reactively updates pre-existing store subscribers when session agentPreset switches', () => {
    let rawState = ALL_GROUPS_STATE
    const storeListeners = new Set<() => void>()
    const store = {
      getSnapshot: () => rawState,
      set: (next: DshModelDirectoryState) => {
        rawState = next
        for (const fn of storeListeners) fn()
      },
      subscribe: (fn: () => void) => {
        storeListeners.add(fn)
        return () => storeListeners.delete(fn)
      },
    }

    let activePreset = 'codex'
    const presetListeners = new Set<() => void>()
    const presetFace = {
      getSnapshot: () => activePreset,
      subscribe: (fn: () => void) => {
        presetListeners.add(fn)
        return () => presetListeners.delete(fn)
      },
    }

    // Pre-existing subscriber (simulating ModelSelect mounted before plugin init)
    const observedProviders: string[][] = []
    store.subscribe(() => {
      observedProviders.push(store.getSnapshot().groups.map((g) => g.id))
    })

    const directory = {
      sessionId: 's1',
      store,
      load: async () => store.getSnapshot(),
    }

    const restore = enhanceDirectory(directory, 's1', {
      binding: () => ({ session: { projections: { faceOf: () => presetFace } } }),
    })

    // Initial pulse delivered Codex-only groups
    expect(store.getSnapshot().groups.map((g) => g.id)).toEqual(['codex-cli'])
    expect(observedProviders.at(-1)).toEqual(['codex-cli'])

    // Referential stability across repeated getSnapshot() calls
    expect(store.getSnapshot()).toBe(store.getSnapshot())

    // Switch session preset to Trae -> immediately notifies subscriber with Trae-only groups
    activePreset = 'trae'
    for (const fn of presetListeners) fn()
    expect(store.getSnapshot().groups.map((g) => g.id)).toEqual(['trae-cli'])
    expect(store.getSnapshot().current).toEqual({
      provider: 'trae-cli',
      model: 'Doubao-Seed-2.0-Code',
    })
    expect(observedProviders.at(-1)).toEqual(['trae-cli'])

    restore()
    expect(store.getSnapshot().groups.length).toBe(4)
  })
})
