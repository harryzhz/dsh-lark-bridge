import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface CliAuthEndpoint {
  readonly endpointFile: string
  readonly apiBaseUrl: string
  readonly token: string
  verify(candidateHeaderOrToken: string | undefined): boolean
  updateBaseUrl(nextPublicBaseUrl: string): void
}

export interface OperatorAuthToken {
  readonly tokenFile: string
  readonly token: string
  verify(candidateHeaderOrToken: string | undefined): boolean
}

export const OPERATOR_TOKEN_FILENAME = 'operator-token'
export const OPERATOR_TOKEN_HEADER = 'x-lark-bridge-operator'
export const EXTERNAL_SESSION_ID_HEADER = 'x-lark-external-session-id'

/**
 * Separate host-operator secret (`0600`) for maintenance operations like graceful
 * drain/resume-intake. Kept strictly out of `cli-endpoint.json` and Agent environment
 * variables so sandboxed/session-scoped Agent CLI calls cannot drain the bridge.
 */
export function ensureOperatorAuth(dataDir: string): OperatorAuthToken {
  const tokenFile = join(dataDir, OPERATOR_TOKEN_FILENAME)
  let token = ''
  if (existsSync(tokenFile)) {
    try {
      const existing = readFileSync(tokenFile, 'utf8').trim()
      if (existing.length >= 32) token = existing
    } catch {
      // Regenerate below.
    }
  }
  if (!token) {
    token = randomBytes(32).toString('hex')
    atomicWrite(tokenFile, `${token}\n`, 0o600)
  }
  const tokenBuf = Buffer.from(token, 'utf8')
  return {
    tokenFile,
    token,
    verify(candidate: string | undefined): boolean {
      if (!candidate) return false
      const trimmed = candidate.replace(/^Bearer\s+/i, '').trim()
      if (!trimmed) return false
      const candBuf = Buffer.from(trimmed, 'utf8')
      if (candBuf.length !== tokenBuf.length) return false
      return timingSafeEqual(candBuf, tokenBuf)
    },
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url))

function atomicWrite(filePath: string, content: string, mode?: number): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmpPath, content, { encoding: 'utf8', ...(mode ? { mode } : {}) })
  if (mode && process.platform !== 'win32') {
    try {
      chmodSync(tmpPath, mode)
    } catch {
      // Ignore chmod error on unsupported filesystems.
    }
  }
  renameSync(tmpPath, filePath)
}

function normalizeHttpOrigin(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(trimmed) ? trimmed : ''
}

export interface EnsureCliAuthOptions {
  readonly deferWrite?: boolean
}

export function ensureCliAuthEndpoint(
  dataDir: string,
  publicBaseUrl: string,
  options?: EnsureCliAuthOptions,
): CliAuthEndpoint {
  const endpointFile = join(dataDir, 'cli-endpoint.json')
  let token = ''
  let persistedBaseUrl = ''
  if (existsSync(endpointFile)) {
    try {
      const parsed = JSON.parse(readFileSync(endpointFile, 'utf8')) as {
        token?: unknown
        publicBaseUrl?: unknown
      }
      if (typeof parsed.token === 'string' && parsed.token.length >= 32) {
        token = parsed.token
      }
      if (typeof parsed.publicBaseUrl === 'string') {
        persistedBaseUrl = normalizeHttpOrigin(parsed.publicBaseUrl)
      }
    } catch {
      // Regenerate below.
    }
  }
  if (!token) {
    token = randomBytes(32).toString('hex')
  }

  let currentBase = normalizeHttpOrigin(publicBaseUrl) || persistedBaseUrl
  const persistEndpoint = (base: string): void => {
    const cleanBase = normalizeHttpOrigin(base)
    if (!cleanBase) return
    currentBase = cleanBase
    const apiBaseUrl = `${cleanBase}/api/lark-bridge`
    atomicWrite(
      endpointFile,
      `${JSON.stringify({ apiBaseUrl, publicBaseUrl: cleanBase, token, updatedAtMs: Date.now() }, null, 2)}\n`,
      0o600,
    )
  }

  if (currentBase && !options?.deferWrite) {
    persistEndpoint(currentBase)
  }

  const tokenBuf = Buffer.from(token, 'utf8')
  return {
    endpointFile,
    get apiBaseUrl(): string {
      return currentBase ? `${currentBase}/api/lark-bridge` : ''
    },
    token,
    verify(candidate: string | undefined): boolean {
      if (!candidate) return false
      const trimmed = candidate.replace(/^Bearer\s+/i, '').trim()
      if (!trimmed) return false
      const candBuf = Buffer.from(trimmed, 'utf8')
      if (candBuf.length !== tokenBuf.length) return false
      return timingSafeEqual(candBuf, tokenBuf)
    },
    updateBaseUrl(nextPublicBaseUrl: string): void {
      persistEndpoint(nextPublicBaseUrl)
    },
  }
}

export interface BundledAssetPaths {
  readonly cliEntry?: string
  readonly skillSource?: string
}

/**
 * Locate bundled `lark-bridge.mjs` and `SKILL.md` in both standalone npm/bundle
 * installations (`dist/index.js` -> `../bin/lark-bridge.mjs`) and monorepo
 * development checkouts (`packages/dsh-lark-bridge/dist/` -> `../../dsh-bundle/bin/`).
 */
export function resolveBundledAssetPaths(baseDir = __dirname): BundledAssetPaths {
  const cliCandidates = [
    resolve(baseDir, './lark-bridge.mjs'),
    resolve(baseDir, '../bin/lark-bridge.mjs'),
    resolve(baseDir, './bin/lark-bridge.mjs'),
    resolve(baseDir, '../../dsh-bundle/bin/lark-bridge.mjs'),
    resolve(baseDir, '../../../packages/dsh-bundle/bin/lark-bridge.mjs'),
  ]
  const skillCandidates = [
    resolve(baseDir, '../skills/lark-bridge/SKILL.md'),
    resolve(baseDir, './skills/lark-bridge/SKILL.md'),
    resolve(baseDir, '../../../skills/lark-bridge/SKILL.md'),
  ]
  const cliEntry = cliCandidates.find((p) => existsSync(p))
  const skillSource = skillCandidates.find((p) => existsSync(p))
  return {
    ...(cliEntry ? { cliEntry } : {}),
    ...(skillSource ? { skillSource } : {}),
  }
}

export function isDefaultDshHomeDataDir(dataDir: string, homeDir = homedir()): boolean {
  return resolve(dataDir) === resolve(homeDir, '.dsh', 'lark-bridge')
}

export interface InstallLocalCliOptions {
  readonly logger?: { info?: (msg: string) => void; warn?: (msg: string) => void }
  readonly baseDir?: string
  readonly homeDir?: string
  readonly agentsHome?: string
  /**
   * Mirror CLI wrapper into `~/.local/bin` and Agent skill into `$AGENTS_HOME/skills/lark-bridge`.
   * Defaults to `isDefaultDshHomeDataDir(dataDir, homeDir)` so secondary isolated `DSH_HOME`
   * instances (e.g. E2E/staging) still install `<dataDir>/bin/lark-bridge` without overwriting
   * host-global `~/.local/bin/lark-bridge` or `~/.agents/skills/lark-bridge`.
   */
  readonly syncGlobalPaths?: boolean
}

export function buildCliWrapperContent(options: {
  readonly endpointFile: string
  readonly cliEntry: string
  readonly execPath?: string
  readonly isElectron?: boolean
  readonly platform?: NodeJS.Platform
  /**
   * When true (used for host-global `~/.local/bin/lark-bridge`), yield to caller's `DSH_HOME`
   * or `LARK_BRIDGE_ENDPOINT_FILE` so `DSH_HOME=~/.dsh-e2e lark-bridge ...` targets that home.
   * When false (default, used for instance-local `<dataDir>/bin/lark-bridge`), bind to this
   * instance unless `LARK_BRIDGE_ENDPOINT_FILE` is explicitly set.
   */
  readonly respectDshHome?: boolean
}): { readonly fileName: string; readonly content: string } {
  const execPath = options.execPath ?? process.execPath
  const isElectron = options.isElectron ?? 'electron' in process.versions
  const platform = options.platform ?? process.platform
  const respectDshHome = options.respectDshHome ?? false

  if (platform === 'win32') {
    const endpointLine = respectDshHome
      ? `if not defined LARK_BRIDGE_ENDPOINT_FILE if not defined DSH_HOME set "LARK_BRIDGE_ENDPOINT_FILE=${options.endpointFile}"`
      : `if not defined LARK_BRIDGE_ENDPOINT_FILE set "LARK_BRIDGE_ENDPOINT_FILE=${options.endpointFile}"`
    const lines = [
      '@echo off',
      'setlocal',
      endpointLine,
      ...(isElectron ? ['set "ELECTRON_RUN_AS_NODE=1"'] : []),
      `"${execPath}" "${options.cliEntry}" %*`,
      '',
    ]
    return { fileName: 'lark-bridge.cmd', content: lines.join('\r\n') }
  }

  const endpointLines = respectDshHome
    ? [
        'if [ -z "${LARK_BRIDGE_ENDPOINT_FILE:-}" ] && [ -z "${DSH_HOME:-}" ]; then',
        `  export LARK_BRIDGE_ENDPOINT_FILE="${options.endpointFile}"`,
        'fi',
      ]
    : [
        'if [ -z "${LARK_BRIDGE_ENDPOINT_FILE:-}" ]; then',
        `  export LARK_BRIDGE_ENDPOINT_FILE="${options.endpointFile}"`,
        'fi',
      ]

  const lines = [
    '#!/bin/sh',
    ...endpointLines,
    ...(isElectron ? ['export ELECTRON_RUN_AS_NODE=1'] : []),
    `exec "${execPath}" "${options.cliEntry}" "$@"`,
    '',
  ]
  return { fileName: 'lark-bridge', content: lines.join('\n') }
}

function writeWrapperFile(
  binDir: string,
  fileName: string,
  content: string,
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void },
): void {
  try {
    const targetBin = join(binDir, fileName)
    if (!existsSync(targetBin) || readFileSync(targetBin, 'utf8') !== content) {
      atomicWrite(targetBin, content, 0o755)
      if (process.platform !== 'win32') {
        chmodSync(targetBin, 0o755)
      }
    }
  } catch (err) {
    logger?.warn?.(
      `[lark-bridge] skipped CLI wrapper in ${binDir}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export function installLocalCliAndSkill(
  dataDir: string,
  endpointFile: string,
  loggerOrOptions?:
    | { info?: (msg: string) => void; warn?: (msg: string) => void }
    | InstallLocalCliOptions,
  baseDir?: string,
): void {
  const isOptionsBag =
    Boolean(loggerOrOptions) &&
    typeof loggerOrOptions === 'object' &&
    ('syncGlobalPaths' in loggerOrOptions ||
      'homeDir' in loggerOrOptions ||
      'agentsHome' in loggerOrOptions ||
      'baseDir' in loggerOrOptions ||
      'logger' in loggerOrOptions)
  const opts: InstallLocalCliOptions = isOptionsBag
    ? (loggerOrOptions as InstallLocalCliOptions)
    : {
        logger: loggerOrOptions as
          | { info?: (msg: string) => void; warn?: (msg: string) => void }
          | undefined,
        baseDir,
      }

  const homeDir = opts.homeDir ?? homedir()
  const syncGlobal = opts.syncGlobalPaths ?? isDefaultDshHomeDataDir(dataDir, homeDir)
  const { cliEntry, skillSource } = resolveBundledAssetPaths(opts.baseDir)

  if (cliEntry) {
    const instanceWrapper = buildCliWrapperContent({
      endpointFile,
      cliEntry,
      respectDshHome: false,
    })
    writeWrapperFile(join(dataDir, 'bin'), instanceWrapper.fileName, instanceWrapper.content, opts.logger)

    if (syncGlobal) {
      const globalWrapper = buildCliWrapperContent({
        endpointFile,
        cliEntry,
        respectDshHome: true,
      })
      writeWrapperFile(
        join(homeDir, '.local', 'bin'),
        globalWrapper.fileName,
        globalWrapper.content,
        opts.logger,
      )
    }
  }

  if (skillSource && syncGlobal) {
    try {
      const skillBody = readFileSync(skillSource, 'utf8')
      const agentsHome =
        opts.agentsHome?.trim() || process.env.AGENTS_HOME?.trim() || join(homeDir, '.agents')
      const destSkill = join(agentsHome, 'skills', 'lark-bridge', 'SKILL.md')
      if (!existsSync(destSkill) || readFileSync(destSkill, 'utf8') !== skillBody) {
        atomicWrite(destSkill, skillBody)
        opts.logger?.info?.(`[lark-bridge] synced skill -> ${destSkill}`)
      }
    } catch (err) {
      opts.logger?.warn?.(
        `[lark-bridge] failed to sync lark-bridge skill: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}
