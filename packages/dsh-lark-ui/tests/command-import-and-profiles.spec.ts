import { describe, expect, it } from 'vitest'
import {
  parseCommandLineToProfileDraft,
  tokenizeShellCommand,
} from '../src/command-import.js'
import {
  filterModelDirectoryState,
  getRuntimeTargetsSnapshot,
  updateSessionFilterRuntimes,
  type DshModelDirectoryState,
} from '../src/session-model-filter.js'

describe('parseCommandLineToProfileDraft', () => {
  it('parses Antigravity proxy command with inline env vars and --settings path', () => {
    const cmd =
      'GOOGLE_GEMINI_BASE_URL="http://127.0.0.1:8787" GEMINI_API_KEY="test-proxy-key" agy --settings ~/.config/demo-proxy/agy/settings.json'
    const draft = parseCommandLineToProfileDraft(cmd)
    expect(draft).toEqual({
      detectedRuntimeId: 'agy',
      suggestedName: 'demo-proxy',
      configFile: '~/.config/demo-proxy/agy/settings.json',
      env: {
        GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:8787',
        GEMINI_API_KEY: 'test-proxy-key',
      },
      args: [],
      authMethodId: 'gemini-api-key',
    })
  })

  it('parses Codex and TRAE profile invocations while stripping transport subcommands', () => {
    expect(parseCommandLineToProfileDraft('codex -p personal')).toEqual({
      detectedRuntimeId: 'codex',
      suggestedName: 'personal',
      cliProfile: 'personal',
      env: {},
      args: [],
    })

    expect(
      parseCommandLineToProfileDraft('traecli --profile=work app-server --listen stdio:// --debug'),
    ).toEqual({
      detectedRuntimeId: 'trae',
      suggestedName: 'work',
      cliProfile: 'work',
      env: {},
      args: ['--debug'],
    })
  })

  it('supports multi-line export statements and quoted tokens', () => {
    const tokens = tokenizeShellCommand('KEY="hello world" claude --note \'a b\'')
    expect(tokens).toEqual(['KEY=hello world', 'claude', '--note', 'a b'])

    const multiline = [
      'export ANTHROPIC_BASE_URL="http://127.0.0.1:9090"',
      'export ANTHROPIC_AUTH_TOKEN="test-token"',
      'claude --model sonnet',
    ].join('\n')
    const draft = parseCommandLineToProfileDraft(multiline)
    expect(draft.detectedRuntimeId).toBe('claude-code')
    expect(draft.env).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9090',
      ANTHROPIC_AUTH_TOKEN: 'test-token',
    })
    expect(draft.args).toEqual(['--model', 'sonnet'])
  })
})

describe('session-model-filter with exposed runtime profile presets', () => {
  it('scopes exposed profile presets to their dedicated provider and hides them from native presets', () => {
    updateSessionFilterRuntimes(
      [
        {
          id: 'agy',
          name: 'Antigravity',
          description: 'ACP',
          kind: 'external',
          providerId: 'agy-cli',
          defaultModel: 'gemini-4-neon',
          supportsReasoningEffort: true,
          isDefault: false,
        },
        {
          id: 'standard',
          name: '标准模式',
          description: 'Native',
          kind: 'native',
          supportsReasoningEffort: true,
          isDefault: true,
        },
      ],
      [
        {
          presetId: 'agy:demo-proxy',
          runtimeId: 'agy',
          profileId: 'demo-proxy',
          displayName: 'Antigravity (Demo Proxy)',
          description: 'Proxy',
          providerId: 'agy--demo-proxy-cli',
          defaultModel: 'gemini-4-carbon',
        },
      ],
    )

    const state: DshModelDirectoryState = {
      current: { provider: 'agy-cli', model: 'gemini-4-neon' },
      routable: true,
      status: 'ready',
      pending: null,
      error: null,
      failures: [],
      groups: [
        {
          id: 'agy-cli',
          name: 'Antigravity',
          models: [{ id: 'gemini-4-neon', name: 'Gemini 4 Neon' }],
        },
        {
          id: 'agy--demo-proxy-cli',
          name: 'Antigravity (Demo Proxy)',
          models: [{ id: 'gemini-4-carbon', name: 'Gemini 4 Carbon' }],
        },
        {
          id: 'deepseek-account',
          name: 'DeepSeek',
          models: [{ id: 'deepseek-chat', name: 'DeepSeek' }],
        },
      ],
    }

    const targets = getRuntimeTargetsSnapshot().map
    const proxyFiltered = filterModelDirectoryState(state, 'agy:demo-proxy', targets)
    expect(proxyFiltered.groups.map((g) => g.id)).toEqual(['agy--demo-proxy-cli'])
    expect(proxyFiltered.current).toEqual({
      provider: 'agy--demo-proxy-cli',
      model: 'gemini-4-carbon',
    })

    const nativeFiltered = filterModelDirectoryState(state, 'standard', targets)
    expect(nativeFiltered.groups.map((g) => g.id)).toEqual(['deepseek-account'])
  })
})
