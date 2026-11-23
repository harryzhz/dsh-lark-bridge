/**
 * Static shell-command parser for the "从命令行导入" profile assistant.
 * Never executes any shell command — strictly tokenizes assignments and CLI flags.
 */

export interface ParsedCommandProfileDraft {
  readonly detectedRuntimeId?: string
  readonly suggestedName?: string
  readonly cliProfile?: string
  readonly configFile?: string
  readonly env: Record<string, string>
  readonly args: string[]
  readonly authMethodId?: string
}

const RUNTIME_ALIASES: Readonly<Record<string, string>> = {
  codex: 'codex',
  agy: 'agy',
  antigravity: 'agy',
  traecli: 'trae',
  trae: 'trae',
  claude: 'claude-code',
  'claude-code': 'claude-code',
  'claude-agent-acp': 'claude-code',
}

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Splits a single shell command (including quoted strings and backslash line
 * continuations) into argument tokens without invoking any shell.
 */
export function tokenizeShellCommand(raw: string): string[] {
  const joined = raw.replace(/\\\r?\n/g, ' ')
  const tokens: string[] = []
  let current = ''
  let inToken = false
  let quote: "'" | '"' | null = null

  for (let i = 0; i < joined.length; i += 1) {
    const ch = joined[i]!
    if (quote === "'") {
      if (ch === "'") {
        quote = null
      } else {
        current += ch
      }
      continue
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null
      } else if (ch === '\\' && i + 1 < joined.length) {
        const next = joined[i + 1]!
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          current += next
          i += 1
        } else {
          current += ch
        }
      } else {
        current += ch
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      inToken = true
      continue
    }
    if (ch === '\\' && i + 1 < joined.length) {
      current += joined[i + 1]!
      inToken = true
      i += 1
      continue
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current)
        current = ''
        inToken = false
      }
      continue
    }
    current += ch
    inToken = true
  }

  if (inToken) tokens.push(current)
  return tokens
}

function parseEnvAssignment(token: string): [string, string] | undefined {
  const eq = token.indexOf('=')
  if (eq <= 0) return undefined
  const key = token.slice(0, eq)
  if (!ENV_KEY_PATTERN.test(key)) return undefined
  return [key, token.slice(eq + 1)]
}

function commandBasename(token: string): string {
  const clean = token.trim().replace(/[\\/]+$/, '')
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  const base = (idx >= 0 ? clean.slice(idx + 1) : clean).toLowerCase()
  return base.replace(/\.(exe|cmd|bat|mjs|cjs|js)$/i, '')
}

function suggestNameFromConfigFile(configFile: string): string | undefined {
  const clean = configFile.trim().replace(/[\\/]+$/, '')
  if (!clean) return undefined
  const parts = clean.split(/[\\/]+/).filter(Boolean)
  const file = parts[parts.length - 1] ?? ''
  const stem = file
    .replace(/\.(config\.toml|traecli\.toml|toml|json|yaml|yml)$/i, '')
    .trim()
  const generic = new Set(['settings', 'config', 'default', 'profile'])
  if (stem && !generic.has(stem.toLowerCase())) return stem
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    const seg = parts[i]!
    const lower = seg.toLowerCase()
    if (!seg || seg.startsWith('.') || seg === '~' || lower === 'agy' || lower === 'codex' || lower === 'trae' || lower === 'config') {
      continue
    }
    return seg
  }
  return stem || undefined
}

/**
 * Parses a pasted shell invocation (supports multi-line `export KEY=VAL` lines
 * followed by `KEY=VAL binary --settings ... -p ...`) into a structured profile draft.
 */
export function parseCommandLineToProfileDraft(
  rawInput: string,
  targetRuntimeId?: string,
): ParsedCommandProfileDraft {
  const env: Record<string, string> = {}
  const lines = rawInput
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))

  let commandTokens: string[] = []
  for (const line of lines) {
    const tokens = tokenizeShellCommand(line)
    if (tokens.length === 0) continue
    if (tokens[0] === 'export') {
      for (const item of tokens.slice(1)) {
        const pair = parseEnvAssignment(item)
        if (pair) env[pair[0]] = pair[1]
      }
      continue
    }
    // Check if the entire line is just KEY=VAL assignments
    if (tokens.every((t) => Boolean(parseEnvAssignment(t)))) {
      for (const item of tokens) {
        const pair = parseEnvAssignment(item)
        if (pair) env[pair[0]] = pair[1]
      }
      continue
    }
    commandTokens = tokens
  }

  let idx = 0
  if (commandTokens[idx] === 'env') idx += 1
  while (idx < commandTokens.length) {
    const pair = parseEnvAssignment(commandTokens[idx]!)
    if (!pair) break
    env[pair[0]] = pair[1]
    idx += 1
  }

  let detectedRuntimeId: string | undefined
  if (idx < commandTokens.length && !commandTokens[idx]!.startsWith('-')) {
    const base = commandBasename(commandTokens[idx]!)
    detectedRuntimeId = RUNTIME_ALIASES[base]
    idx += 1
  }

  const effectiveRuntime = detectedRuntimeId ?? targetRuntimeId
  let cliProfile: string | undefined
  let configFile: string | undefined
  const remainingArgs: string[] = []

  for (; idx < commandTokens.length; idx += 1) {
    const tok = commandTokens[idx]!
    // Strip transport subcommands/flags that DSH manages automatically
    if (tok === 'acp' || tok === 'app-server' || tok === '--stdio') {
      continue
    }
    if (tok === '--listen' && commandTokens[idx + 1] === 'stdio://') {
      idx += 1
      continue
    }
    if (tok === '--listen=stdio://') {
      continue
    }

    if ((tok === '-p' || tok === '--profile') && idx + 1 < commandTokens.length) {
      cliProfile = commandTokens[idx + 1]!.trim()
      idx += 1
      continue
    }
    if (tok.startsWith('--profile=')) {
      cliProfile = tok.slice('--profile='.length).trim()
      continue
    }
    if ((tok === '--settings' || tok === '--config') && idx + 1 < commandTokens.length) {
      configFile = commandTokens[idx + 1]!.trim()
      idx += 1
      continue
    }
    if (tok.startsWith('--settings=')) {
      configFile = tok.slice('--settings='.length).trim()
      continue
    }
    if (tok.startsWith('--config=')) {
      configFile = tok.slice('--config='.length).trim()
      continue
    }
    remainingArgs.push(tok)
  }

  let authMethodId: string | undefined
  if (effectiveRuntime === 'agy' && Object.keys(env).some((k) => k === 'GEMINI_API_KEY')) {
    authMethodId = 'gemini-api-key'
  }

  const suggestedName =
    cliProfile ||
    (configFile ? suggestNameFromConfigFile(configFile) : undefined) ||
    undefined

  return {
    ...(detectedRuntimeId ? { detectedRuntimeId } : {}),
    ...(suggestedName ? { suggestedName } : {}),
    ...(cliProfile ? { cliProfile } : {}),
    ...(configFile ? { configFile } : {}),
    env,
    args: remainingArgs,
    ...(authMethodId ? { authMethodId } : {}),
  }
}
