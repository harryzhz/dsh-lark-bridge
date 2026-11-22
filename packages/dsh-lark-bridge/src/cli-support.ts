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

export function ensureCliAuthEndpoint(dataDir: string, publicBaseUrl: string): CliAuthEndpoint {
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

  if (currentBase) {
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

export function buildCliWrapperContent(options: {
  readonly endpointFile: string
  readonly cliEntry: string
  readonly execPath?: string
  readonly isElectron?: boolean
  readonly platform?: NodeJS.Platform
}): { readonly fileName: string; readonly content: string } {
  const execPath = options.execPath ?? process.execPath
  const isElectron = options.isElectron ?? 'electron' in process.versions
  const platform = options.platform ?? process.platform

  if (platform === 'win32') {
    const lines = [
      '@echo off',
      'setlocal',
      `set "LARK_BRIDGE_ENDPOINT_FILE=${options.endpointFile}"`,
      ...(isElectron ? ['set "ELECTRON_RUN_AS_NODE=1"'] : []),
      `"${execPath}" "${options.cliEntry}" %*`,
      '',
    ]
    return { fileName: 'lark-bridge.cmd', content: lines.join('\r\n') }
  }

  const lines = [
    '#!/bin/sh',
    `export LARK_BRIDGE_ENDPOINT_FILE="${options.endpointFile}"`,
    ...(isElectron ? ['export ELECTRON_RUN_AS_NODE=1'] : []),
    `exec "${execPath}" "${options.cliEntry}" "$@"`,
    '',
  ]
  return { fileName: 'lark-bridge', content: lines.join('\n') }
}

export function installLocalCliAndSkill(
  dataDir: string,
  endpointFile: string,
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void },
  baseDir?: string,
): void {
  const { cliEntry, skillSource } = resolveBundledAssetPaths(baseDir)

  if (cliEntry) {
    const { fileName, content } = buildCliWrapperContent({ endpointFile, cliEntry })
    for (const binDir of [join(dataDir, 'bin'), join(homedir(), '.local', 'bin')]) {
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
  }

  if (skillSource) {
    try {
      const skillBody = readFileSync(skillSource, 'utf8')
      const agentsHome = process.env.AGENTS_HOME?.trim() || join(homedir(), '.agents')
      const destSkill = join(agentsHome, 'skills', 'lark-bridge', 'SKILL.md')
      if (!existsSync(destSkill) || readFileSync(destSkill, 'utf8') !== skillBody) {
        atomicWrite(destSkill, skillBody)
        logger?.info?.(`[lark-bridge] synced skill -> ${destSkill}`)
      }
    } catch (err) {
      logger?.warn?.(
        `[lark-bridge] failed to sync lark-bridge skill: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}
