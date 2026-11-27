import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import * as nodeModule from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { BridgeLifecycleStatus } from './types.js'

export type ManagedPluginId = 'bridge' | 'external-agents'

export type PluginSourceKind =
  | 'github-release'
  | 'registry'
  | 'local-link'
  | 'local-file'
  | 'git'
  | 'unknown'
  | 'not-installed'

export interface ManagedPluginSpec {
  readonly id: ManagedPluginId
  readonly displayName: string
  readonly packageName: string
  readonly legacyPackageNames: readonly string[]
  readonly githubRepo: string
  readonly versionedAssetPrefix: string
  readonly latestAssetAlias: string
}

export const MANAGED_PLUGINS: readonly ManagedPluginSpec[] = [
  {
    id: 'bridge',
    displayName: '飞书桥接',
    packageName: '@harryzhz/dsh-lark-bridge',
    legacyPackageNames: ['dsh-lark-bridge'],
    githubRepo: 'harryzhz/dsh-lark-bridge',
    versionedAssetPrefix: 'harryzhz-dsh-lark-bridge-',
    latestAssetAlias: 'dsh-lark-bridge.tgz',
  },
  {
    id: 'external-agents',
    displayName: '外部 Agent 运行时',
    packageName: '@harryzhz/dsh-external-agents',
    legacyPackageNames: ['dsh-external-agents'],
    githubRepo: 'harryzhz/dsh-external-agents',
    versionedAssetPrefix: 'harryzhz-dsh-external-agents-',
    latestAssetAlias: 'dsh-external-agents.tgz',
  },
] as const

export interface ReleaseInfo {
  readonly version: string
  readonly tagName: string
  readonly publishedAt?: string
  readonly releaseUrl: string
  readonly tarballUrl: string
  readonly assetName: string
  readonly expectedSha256?: string
  readonly checksumUrl?: string
  readonly releaseNotes?: string
  readonly source: 'github-api' | 'github-redirect' | 'mirror'
}

export interface ManagedPluginStatus {
  readonly id: ManagedPluginId
  readonly displayName: string
  readonly packageName: string
  readonly installedPackageName?: string
  readonly githubRepo: string
  readonly installed: boolean
  readonly enabled: boolean
  readonly installedVersion?: string
  readonly runningVersion?: string
  readonly sourceKind: PluginSourceKind
  readonly sourceLabel: string
  readonly latest?: ReleaseInfo
  readonly updateAvailable: boolean
  readonly hotReloadSupported: boolean
  readonly updateBlockedReason?: string
  readonly checkError?: string
  readonly checkedAtMs?: number
}

export type PluginUpdateOpStatus =
  | 'queued'
  | 'verifying'
  | 'draining'
  | 'removing'
  | 'installing'
  | 'restoring'
  | 'succeeded'
  | 'failed'
  | 'rolled_back'

export interface PluginUpdateItemResult {
  readonly id: ManagedPluginId
  readonly displayName: string
  readonly packageName: string
  readonly fromVersion?: string
  readonly toVersion: string
  readonly status: 'pending' | 'running' | 'succeeded' | 'failed' | 'rolled_back'
  readonly hotReloaded: boolean
  readonly restartRequired: boolean
  readonly restartReason?: string
  readonly error?: string
  readonly rolledBack?: boolean
}

export type PluginUpdateFailureCode =
  | 'drain_timeout'
  | 'verify_failed'
  | 'install_failed'
  | 'unknown'

export interface PluginUpdateOperation {
  readonly operationId: string
  readonly status: PluginUpdateOpStatus
  readonly message: string
  readonly startedAtMs: number
  readonly updatedAtMs: number
  readonly finishedAtMs?: number
  readonly targetSelector?: ManagedPluginId | 'all'
  readonly currentTarget?: ManagedPluginId
  readonly forced?: boolean
  readonly failureCode?: PluginUpdateFailureCode
  readonly items: readonly PluginUpdateItemResult[]
  readonly hotReloaded: boolean
  readonly restartRequired: boolean
  /** Number of in-flight Feishu turns kept running in the host across bridge hot-reload. */
  readonly preservedTurns?: number
  /** True when the bridge swap ran without draining in-flight Feishu turns. */
  readonly seamlessBridgeSwap?: boolean
  readonly error?: string
}

export interface PluginUpdatesOverview {
  readonly ok: true
  readonly profileName?: string
  readonly hmrAvailable: boolean
  readonly pluginManagerAvailable: boolean
  readonly hotReloadSupported: boolean
  readonly hotReloadUnavailableReason?: string
  readonly checkedAtMs?: number
  readonly inFlightTurns: number
  readonly activeExternalAgents: number
  /** True when `dsh-lark-bridge` self-updates preserve live agents and reattach seamlessly without draining. */
  readonly bridgeSeamlessReload: boolean
  readonly updatableCount: number
  readonly plugins: readonly ManagedPluginStatus[]
  readonly operation?: PluginUpdateOperation
}

export interface StartPluginUpdateOptions {
  readonly target?: ManagedPluginId | 'all'
  readonly version?: string
  readonly drainTimeoutMs?: number
  readonly force?: boolean
  readonly allowMigrateLocal?: boolean
  readonly allowRestartRequired?: boolean
}

export interface HostProfileContextLike {
  readonly name?: string
  readonly dir?: string
}

export interface HostBundleInfoLike {
  readonly name: string
  readonly version?: string
  readonly enabled: boolean
  readonly installed: boolean
  readonly source?: string
  readonly removable?: boolean
}

export interface HostChangeResultLike {
  readonly changed?: boolean
  readonly application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  readonly restartReason?: string
  readonly stage?: 'install' | 'enable' | 'remove'
  readonly bundle?: string
  readonly version?: string
  readonly error?: { readonly code?: string; readonly diagnostic?: string }
  readonly packageResult?: { readonly exitCode?: number; readonly output?: string }
}

export interface HostPluginManagerLike {
  listBundles(): Promise<readonly HostBundleInfoLike[]>
  removeBundle(name: string): Promise<HostChangeResultLike>
  installBundle(
    spec: string,
    options?: {
      enabled?: boolean
      expected?: { readonly name: string; readonly version: string }
    },
  ): Promise<HostChangeResultLike>
  setBundleEnabled?(name: string, enabled: boolean): Promise<HostChangeResultLike>
}

export interface HostHmrLike {
  runExclusive<T>(fn: () => Promise<T>): Promise<T>
  reconcileProfile(requiredIds?: readonly string[]): Promise<unknown>
}

export interface PluginUpdateLifecycleHost {
  getLifecycleStatus(): BridgeLifecycleStatus
  beginDrain(options?: { readonly reason?: string }): Promise<BridgeLifecycleStatus>
  waitForDrain(timeoutMs?: number, signal?: AbortSignal): Promise<BridgeLifecycleStatus>
  cancelDrain(): Promise<BridgeLifecycleStatus>
  prepareHotReloadSwap?(operationId: string): void
  finishHotReloadSwap?(operationId: string, options?: { readonly disposeDetached?: boolean }): void
  countActiveExternalAgents?(): number
  recordUpdateEvent?(summary: string, isError?: boolean): void
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

interface GlobalUpdateState {
  active?: PluginUpdateOperation
  last?: PluginUpdateOperation
  drainAbort?: AbortController
  drainForceRequested?: boolean
}

class TaggedUpdateError extends Error {
  readonly failureCode: PluginUpdateFailureCode
  constructor(message: string, failureCode: PluginUpdateFailureCode) {
    super(message)
    this.name = 'TaggedUpdateError'
    this.failureCode = failureCode
  }
}

interface HostClientModulesLike {
  sources: Map<string, { readonly packageName?: string }>
  dirty: Set<string>
  reconcilePackage(packageName: string): boolean
  flush(onError: (err: unknown) => void): void
}

/**
 * Hold intermediate client-module removal broadcasts while self-updating `dsh-lark-bridge`.
 * Without this guard, `removeBundle` emits a graph frame deleting the UI bundle, immediately
 * unmounting the Lark Bridge panel & sidebar icon for 8-15 seconds until `installBundle` finishes.
 * Holding only deletion (while still allowing the newly installed source to publish) makes the
 * browser receive ONE atomic `graph` update with a changed `rev`, triggering DSH `entries.replace()`
 * which prefetches the new `client.js` before swapping in ~15ms.
 */
export function holdClientModulesDuringSwap(
  ctx: Context,
  packageNames: readonly string[],
): () => Promise<void> {
  const raw = ctx.get('clientModules' as never) as Partial<HostClientModulesLike> | undefined
  if (
    !raw ||
    typeof raw.reconcilePackage !== 'function' ||
    !(raw.sources instanceof Map) ||
    !(raw.dirty instanceof Set) ||
    typeof raw.flush !== 'function'
  ) {
    return async () => {}
  }
  const cm = raw as HostClientModulesLike
  const held = new Set(packageNames.filter(Boolean))
  if (held.size === 0) return async () => {}

  const hasOwnReconcile = Object.prototype.hasOwnProperty.call(cm, 'reconcilePackage')
  const origReconcile = cm.reconcilePackage

  const hasActiveSource = (pkgName: string): boolean => {
    for (const source of cm.sources.values()) {
      if (source?.packageName === pkgName) return true
    }
    return false
  }

  const wrapped = function (this: HostClientModulesLike, packageName: string): boolean {
    if (held.has(packageName) && !hasActiveSource(packageName)) {
      return false
    }
    return origReconcile.call(this, packageName)
  }

  cm.reconcilePackage = wrapped
  let released = false

  return async () => {
    if (released) return
    released = true
    // Allow any microtask flush queued by `installBundle`'s fiber activation to settle first.
    await Promise.resolve()
    if (cm.reconcilePackage === wrapped) {
      if (hasOwnReconcile) {
        cm.reconcilePackage = origReconcile
      } else {
        delete (cm as Partial<HostClientModulesLike>).reconcilePackage
      }
    }
    // If swap & rollback both left a held package genuinely absent, converge `clientModules` to truth.
    let needConverge = false
    for (const pkgName of held) {
      if (!hasActiveSource(pkgName)) {
        cm.dirty.add(pkgName)
        needConverge = true
      }
    }
    if (needConverge) {
      try {
        cm.flush(() => {})
      } catch {
        // Non-fatal fallback convergence.
      }
    }
  }
}

const GLOBAL_UPDATE_KEY = Symbol.for('dsh-lark-bridge.plugin-update-state')
const GLOBAL_RELOCATOR_KEY = Symbol.for('dsh-lark-bridge.esm-relocator')
const UPDATE_STATUS_FILENAME = 'plugin-update-status.json'
const CHECK_CACHE_TTL_MS = 15 * 60_000
const RELEASE_FETCH_TIMEOUT_MS = 12_000
const TARBALL_VERIFY_TIMEOUT_MS = 90_000
const MAX_TARBALL_VERIFY_BYTES = 80 * 1024 * 1024
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const SHA256_RE = /^[0-9a-f]{64}$/i
const LOOPBACK_MIRROR_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i

interface GlobalEsmRelocatorState {
  installed: boolean
  /** Maps previous real package dirs (trailing sep) -> live profile node_modules symlink path. */
  readonly staleDirToSymlink: Map<string, string>
}

function getGlobalEsmRelocatorState(): GlobalEsmRelocatorState {
  const g = globalThis as Record<PropertyKey, unknown>
  let state = g[GLOBAL_RELOCATOR_KEY] as GlobalEsmRelocatorState | undefined
  if (!state) {
    state = {
      installed: false,
      staleDirToSymlink: new Map(),
    }
    g[GLOBAL_RELOCATOR_KEY] = state
  }
  return state
}

function realDirSpellings(targetPath: string): string[] {
  const results = new Set<string>()
  try {
    results.add(realpathSync(targetPath))
  } catch {
    // Ignore missing path.
  }
  const nativeRealpath = (realpathSync as { native?: (p: string) => string }).native
  if (typeof nativeRealpath === 'function') {
    try {
      results.add(nativeRealpath(targetPath))
    } catch {
      // Ignore missing path.
    }
  }
  return [...results]
}

/**
 * Node's ESM resolver retains an internal realpath cache for symlinked `node_modules` packages
 * (such as pnpm's `.pnpm/` package store). When a profile bundle is updated in-place via
 * `removeBundle` -> `installBundle`, Node keeps resolving the symlink to the previous `.pnpm/`
 * directory even after `dsh-hmr` clears `ResolveCache`. Relocating stale `file:` URLs to the
 * live symlink target ensures both server modules (`cordis-plugin-loader`) and client bundles
 * (`dsh-client-modules`) evaluate the newly installed version without restarting DSH Web.
 */
export function relocateStaleModuleUrl(
  url: string,
  parentURL: string | undefined,
  staleDirToSymlink: ReadonlyMap<string, string>,
): string | undefined {
  if (!url.startsWith('file:') || staleDirToSymlink.size === 0) return undefined
  let filename: string
  try {
    filename = fileURLToPath(url)
  } catch {
    return undefined
  }
  let matchedOldDir = ''
  let matchedSymlink = ''
  for (const [oldDir, symlinkPath] of staleDirToSymlink) {
    if (filename.startsWith(oldDir) && oldDir.length > matchedOldDir.length) {
      matchedOldDir = oldDir
      matchedSymlink = symlinkPath
    }
  }
  if (!matchedOldDir) return undefined
  if (parentURL?.startsWith('file:')) {
    try {
      if (fileURLToPath(parentURL).startsWith(matchedOldDir)) return undefined
    } catch {
      // Ignore malformed parent URL.
    }
  }
  try {
    const currentReal = realpathSync(matchedSymlink) + sep
    if (currentReal === matchedOldDir) return undefined
    const relocated = currentReal + filename.slice(matchedOldDir.length)
    if (!existsSync(relocated)) return undefined
    const parsedUrl = new URL(url)
    parsedUrl.pathname = pathToFileURL(relocated).pathname
    return parsedUrl.href
  } catch {
    return undefined
  }
}

function ensureGlobalEsmRelocatorInstalled(): void {
  const state = getGlobalEsmRelocatorState()
  if (state.installed) return
  type RegisterHooksFn = (hooks: {
    resolve?: (
      specifier: string,
      context: { parentURL?: string },
      nextResolve: (specifier: string, context?: { parentURL?: string }) => { url?: string },
    ) => { url?: string }
  }) => unknown
  const registerHooks = (nodeModule as { registerHooks?: RegisterHooksFn }).registerHooks
  if (typeof registerHooks !== 'function') return
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const res = nextResolve(specifier, context)
      if (!res?.url) return res
      const relocated = relocateStaleModuleUrl(res.url, context?.parentURL, state.staleDirToSymlink)
      return relocated ? { ...res, url: relocated } : res
    },
  })
  state.installed = true
}

export function recordManagedPackageMove(
  profileDir: string,
  installedPackageName: string,
  targetPackageName: string,
): void {
  const oldSymlink = join(profileDir, 'node_modules', ...installedPackageName.split('/'))
  const newSymlink = join(profileDir, 'node_modules', ...targetPackageName.split('/'))
  const spellings = realDirSpellings(oldSymlink)
  if (spellings.length === 0) return
  const state = getGlobalEsmRelocatorState()
  for (const dir of spellings) {
    state.staleDirToSymlink.set(dir.endsWith(sep) ? dir : dir + sep, newSymlink)
  }
  ensureGlobalEsmRelocatorInstalled()
}

function getGlobalUpdateState(): GlobalUpdateState {
  const g = globalThis as Record<PropertyKey, unknown>
  let state = g[GLOBAL_UPDATE_KEY] as GlobalUpdateState | undefined
  if (!state) {
    state = {}
    g[GLOBAL_UPDATE_KEY] = state
  }
  return state
}

function detectRunningBridgeVersion(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string }
        if (
          (pkg.name === '@harryzhz/dsh-lark-bridge' || pkg.name === '@dsh-lark/dsh-lark-bridge') &&
          typeof pkg.version === 'string' &&
          pkg.version.trim()
        ) {
          return pkg.version.trim()
        }
      } catch {
        // Continue walking up.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

export const RUNNING_BRIDGE_VERSION = detectRunningBridgeVersion()

interface ParsedSemver {
  readonly core: readonly [number, number, number]
  readonly pre: readonly string[]
}

export function parseSemver(raw: string | undefined): ParsedSemver | null {
  if (!raw) return null
  const match = SEMVER_RE.exec(raw.trim())
  if (!match) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  }
}

export function normalizeVersion(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim().replace(/^v/i, '')
  return parseSemver(trimmed) ? trimmed : undefined
}

/**
 * Standard Semver comparison (> 0 means `a` is newer than `b`; null if either is invalid).
 */
export function compareSemver(a: string | undefined, b: string | undefined): number | null {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i += 1) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i]! - pb.core[i]!
  }
  if (pa.pre.length === 0 || pb.pre.length === 0) {
    return pb.pre.length - pa.pre.length
  }
  const len = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < len; i += 1) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) return Number(x) - Number(y)
    if (nx !== ny) return nx ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

export function isNewerVersion(installed: string | undefined, latest: string | undefined): boolean {
  const cmp = compareSemver(latest, installed)
  return cmp !== null && cmp > 0
}

export function classifySourceSpec(spec: string | undefined): {
  readonly kind: PluginSourceKind
  readonly label: string
} {
  if (!spec || !spec.trim()) {
    return { kind: 'unknown', label: '未知来源' }
  }
  const trimmed = spec.trim()
  if (trimmed.startsWith('link:')) {
    return { kind: 'local-link', label: '本地开发链接 (link:)' }
  }
  if (trimmed.startsWith('file:') || trimmed.startsWith('/') || trimmed.startsWith('.')) {
    return { kind: 'local-file', label: '本地路径 (file:)' }
  }
  if (
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/(?:download|latest\/download)\/.+\.tgz(?:$|[?#])/i.test(
      trimmed,
    ) ||
    (LOOPBACK_MIRROR_RE.test(trimmed) && /\.tgz(?:$|[?#])/i.test(trimmed))
  ) {
    return { kind: 'github-release', label: 'GitHub Release' }
  }
  if (/^(?:github:|git\+|git:\/\/|ssh:\/\/)/i.test(trimmed) || trimmed.endsWith('.git')) {
    return { kind: 'git', label: 'Git 仓库' }
  }
  if (/^(?:\^|~|>=|<=|>|<|=)?\d+\.\d+\.\d+/.test(trimmed) || trimmed === 'latest') {
    return { kind: 'registry', label: 'npm Registry' }
  }
  return { kind: 'unknown', label: '自定义来源' }
}

export function parseSha256Sums(content: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line)
    if (!match) continue
    const hash = match[1]!.toLowerCase()
    const fileName = match[2]!.trim().replace(/^\.\//, '')
    if (fileName) map.set(fileName, hash)
  }
  return map
}

function summarizeReleaseNotes(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^###\s+通过\s+GitHub\s+Release/i.test(line))
  if (lines.length === 0) return undefined
  const joined = lines.slice(0, 6).join('\n')
  return joined.length > 420 ? `${joined.slice(0, 417)}...` : joined
}

function atomicWriteText(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
  if (process.platform !== 'win32') {
    try {
      chmodSync(tmp, 0o600)
    } catch {
      // Ignore chmod failure on restricted filesystems.
    }
  }
  renameSync(tmp, filePath)
}

function atomicWriteJson(filePath: string, value: unknown): void {
  try {
    atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`)
  } catch {
    // Non-fatal persistence failure.
  }
}

const MISSING_TARBALL_INTEGRITY_RE =
  /ERR_PNPM_(?:MISSING_TARBALL_INTEGRITY|LOCKFILE_MISSING_INTEGRITY)|lockfile entry has no ["']?integrity["']? field|has no ["']?integrity["']? field,?\s+so\s+(?:its\s+downloaded\s+tarball|pnpm\s+cannot\s+verify)/i

export function isMissingTarballIntegrityError(result: HostChangeResultLike | undefined): boolean {
  if (!result) return false
  const haystack = [result.error?.code, result.error?.diagnostic, result.packageResult?.output]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n')
  return haystack.length > 0 && MISSING_TARBALL_INTEGRITY_RE.test(haystack)
}

function isRemoteTarballUrl(url: string): boolean {
  return /^https:\/\/\S+/i.test(url) || LOOPBACK_MIRROR_RE.test(url)
}

function extractTarballUrlFromInlineBody(body: string): string | undefined {
  if (/\bintegrity\s*:/i.test(body)) return undefined
  const match = /\btarball\s*:\s*(?:'([^']+)'|"([^"]+)"|([^,\s}]+))/i.exec(body)
  const url = (match?.[1] ?? match?.[2] ?? match?.[3])?.trim()
  return url && isRemoteTarballUrl(url) ? url : undefined
}

/**
 * Scan a pnpm lockfile for remote tarball `resolution:` entries that omit an `integrity:` field.
 * pnpm >=10.34 / >=11.4 fails closed with `ERR_PNPM_MISSING_TARBALL_INTEGRITY` on such entries.
 */
export function findLockfileEntriesMissingTarballIntegrity(lockfileContent: string): string[] {
  const missing = new Set<string>()
  const lines = lockfileContent.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    const inlineMatch = /^(\s*resolution:\s*\{)([^}]*)(\}\s*)$/.exec(line)
    if (inlineMatch) {
      const url = extractTarballUrlFromInlineBody(inlineMatch[2]!)
      if (url) missing.add(url)
      continue
    }
    const blockMatch = /^(\s*)resolution:\s*$/.exec(line)
    if (blockMatch) {
      const baseIndent = blockMatch[1]!.length
      let hasIntegrity = false
      let blockUrl: string | undefined
      let j = i + 1
      for (; j < lines.length; j += 1) {
        const sub = lines[j]!
        if (!sub.trim()) break
        const indentMatch = /^(\s*)/.exec(sub)
        const subIndent = indentMatch ? indentMatch[1]!.length : 0
        if (subIndent <= baseIndent) break
        if (/^\s+integrity\s*:/i.test(sub)) {
          hasIntegrity = true
        } else {
          const urlMatch = /^\s+tarball\s*:\s*(?:'([^']+)'|"([^"]+)"|([^\s#]+))\s*$/i.exec(sub)
          if (urlMatch) {
            const candidate = (urlMatch[1] ?? urlMatch[2] ?? urlMatch[3])?.trim()
            if (candidate && isRemoteTarballUrl(candidate)) {
              blockUrl = candidate
            }
          }
        }
      }
      if (!hasIntegrity && blockUrl) {
        missing.add(blockUrl)
      }
      i = j - 1
    }
  }
  return [...missing]
}

/**
 * Backfill `integrity: sha512-...` into matching remote tarball `resolution:` entries in a pnpm
 * lockfile while preserving surrounding YAML structure and existing integrity fields untouched.
 */
export function patchLockfileTarballIntegrities(
  lockfileContent: string,
  urlToIntegrity: ReadonlyMap<string, string>,
): { readonly content: string; readonly patchedCount: number } {
  if (urlToIntegrity.size === 0) {
    return { content: lockfileContent, patchedCount: 0 }
  }
  const eol = lockfileContent.includes('\r\n') ? '\r\n' : '\n'
  const lines = lockfileContent.split(/\r?\n/)
  const out: string[] = []
  let patchedCount = 0

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    const inlineMatch = /^(\s*resolution:\s*\{)([^}]*)(\}\s*)$/.exec(line)
    if (inlineMatch) {
      const url = extractTarballUrlFromInlineBody(inlineMatch[2]!)
      const integrity = url ? urlToIntegrity.get(url) : undefined
      if (integrity) {
        out.push(`${inlineMatch[1]}integrity: ${integrity}, ${inlineMatch[2]!.trim()}${inlineMatch[3]}`)
        patchedCount += 1
        continue
      }
      out.push(line)
      continue
    }

    const blockMatch = /^(\s*)resolution:\s*$/.exec(line)
    if (blockMatch) {
      const baseIndent = blockMatch[1]!.length
      const blockLines: string[] = []
      let hasIntegrity = false
      let tarballLineIdx = -1
      let tarballIndent = ''
      let blockUrl: string | undefined
      let j = i + 1
      for (; j < lines.length; j += 1) {
        const sub = lines[j]!
        if (!sub.trim()) break
        const indentMatch = /^(\s*)/.exec(sub)
        const subIndent = indentMatch ? indentMatch[1]!.length : 0
        if (subIndent <= baseIndent) break
        blockLines.push(sub)
        if (/^\s+integrity\s*:/i.test(sub)) {
          hasIntegrity = true
        } else {
          const urlMatch = /^(\s+)tarball\s*:\s*(?:'([^']+)'|"([^"]+)"|([^\s#]+))\s*$/i.exec(sub)
          if (urlMatch) {
            const candidate = (urlMatch[2] ?? urlMatch[3] ?? urlMatch[4])?.trim()
            if (candidate && isRemoteTarballUrl(candidate)) {
              blockUrl = candidate
              tarballLineIdx = blockLines.length - 1
              tarballIndent = urlMatch[1]!
            }
          }
        }
      }
      out.push(line)
      const integrity = !hasIntegrity && blockUrl ? urlToIntegrity.get(blockUrl) : undefined
      if (integrity && tarballLineIdx >= 0) {
        for (let k = 0; k < blockLines.length; k += 1) {
          if (k === tarballLineIdx) {
            out.push(`${tarballIndent}integrity: ${integrity}`)
          }
          out.push(blockLines[k]!)
        }
        patchedCount += 1
      } else {
        out.push(...blockLines)
      }
      i = j - 1
      continue
    }

    out.push(line)
  }

  return { content: out.join(eol), patchedCount }
}

function formatMissingIntegrityHint(rawMessage: string): string {
  return `${rawMessage}（pnpm-lock.yaml 缺少远端安装包 integrity 校验字段；若宿主机使用 pnpm 10.34.x 存在已知复现缺陷，请升级 pnpm 至 11.x 并清理 profile 锁文件后重试）`
}

function readPersistedOperation(filePath: string): PluginUpdateOperation | undefined {
  if (!existsSync(filePath)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as PluginUpdateOperation
    if (parsed && typeof parsed === 'object' && typeof parsed.operationId === 'string') {
      return parsed
    }
  } catch {
    // Ignore corrupt file.
  }
  return undefined
}

function resolveLoopbackMirrorBase(): string | undefined {
  const raw = process.env.DSH_LARK_PLUGIN_TEST_MIRROR_URL?.trim()
  if (!raw || !LOOPBACK_MIRROR_RE.test(raw)) return undefined
  return raw.replace(/\/+$/, '')
}

function formatChangeError(result: HostChangeResultLike | undefined, fallback: string): string {
  if (!result) return fallback
  const diag = result.error?.diagnostic?.trim()
  const code = result.error?.code?.trim()
  const out = result.packageResult?.output?.trim()
  if (diag) return code ? `${diag} (${code})` : diag
  if (out) return out.split(/\r?\n/).slice(-4).join(' | ').slice(0, 400)
  if (code) return `${fallback} (${code})`
  return fallback
}

interface ReleaseCacheEntry {
  readonly info: ReleaseInfo
  readonly etag?: string
  readonly fetchedAtMs: number
}

interface InstalledProfilePackage {
  readonly installedPackageName: string
  readonly rawSpec?: string
  readonly installedVersion?: string
  readonly enabled: boolean
  readonly installed: boolean
}

export interface PluginUpdateServiceOptions {
  readonly ctx: Context
  readonly dataDir: string
  readonly lifecycle: PluginUpdateLifecycleHost
  readonly fetchImpl?: FetchLike
  readonly plugins?: readonly ManagedPluginSpec[]
  readonly cacheTtlMs?: number
  readonly runningBridgeVersion?: string
}

export class PluginUpdateService {
  private readonly ctx: Context
  private readonly dataDir: string
  private readonly statusFile: string
  private readonly lifecycle: PluginUpdateLifecycleHost
  private readonly fetchImpl: FetchLike
  private readonly plugins: readonly ManagedPluginSpec[]
  private readonly cacheTtlMs: number
  private readonly runningBridgeVersion?: string
  private readonly releaseCache = new Map<string, ReleaseCacheEntry>()

  constructor(options: PluginUpdateServiceOptions) {
    this.ctx = options.ctx
    this.dataDir = options.dataDir
    this.statusFile = join(options.dataDir, UPDATE_STATUS_FILENAME)
    this.lifecycle = options.lifecycle
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.plugins = options.plugins ?? MANAGED_PLUGINS
    this.cacheTtlMs = options.cacheTtlMs ?? CHECK_CACHE_TTL_MS
    this.runningBridgeVersion = options.runningBridgeVersion ?? RUNNING_BRIDGE_VERSION

    // Restore last completed operation after a process restart or hot reload.
    const state = getGlobalUpdateState()
    if (!state.active && !state.last) {
      const persisted = readPersistedOperation(this.statusFile)
      if (persisted) {
        state.last = persisted
      }
    }
  }

  private getProfileContext(): HostProfileContextLike | undefined {
    return this.ctx.get('profileContext' as never) as HostProfileContextLike | undefined
  }

  private getPluginManager(): HostPluginManagerLike | undefined {
    const pm = this.ctx.get('pluginManager' as never) as Partial<HostPluginManagerLike> | undefined
    if (
      pm &&
      typeof pm.listBundles === 'function' &&
      typeof pm.removeBundle === 'function' &&
      typeof pm.installBundle === 'function'
    ) {
      return pm as HostPluginManagerLike
    }
    return undefined
  }

  private getHmr(): HostHmrLike | undefined {
    const hmr = this.ctx.get('hmr' as never) as Partial<HostHmrLike> | undefined
    if (hmr && typeof hmr.runExclusive === 'function' && typeof hmr.reconcileProfile === 'function') {
      return hmr as HostHmrLike
    }
    return undefined
  }

  private readProfileManifest(profileDir: string): {
    readonly dependencies: Record<string, string>
    readonly bundles: readonly string[]
  } {
    const manifestPath = join(profileDir, 'package.json')
    if (!existsSync(manifestPath)) {
      return { dependencies: {}, bundles: [] }
    }
    try {
      const doc = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        dependencies?: Record<string, string>
        dsh?: { profile?: { bundles?: unknown } }
      }
      const dependencies =
        doc.dependencies && typeof doc.dependencies === 'object' ? doc.dependencies : {}
      const bundles = Array.isArray(doc.dsh?.profile?.bundles)
        ? doc.dsh.profile.bundles.filter((item): item is string => typeof item === 'string')
        : []
      return { dependencies, bundles }
    } catch {
      return { dependencies: {}, bundles: [] }
    }
  }

  private readInstalledVersionFromDisk(profileDir: string, pkgName: string): string | undefined {
    const pkgPath = join(profileDir, 'node_modules', ...pkgName.split('/'), 'package.json')
    if (!existsSync(pkgPath)) return undefined
    try {
      const doc = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown }
      return typeof doc.version === 'string' && doc.version.trim() ? doc.version.trim() : undefined
    } catch {
      return undefined
    }
  }

  private async resolveInstalledPackages(): Promise<Map<ManagedPluginId, InstalledProfilePackage>> {
    const map = new Map<ManagedPluginId, InstalledProfilePackage>()
    const profileDir = this.getProfileContext()?.dir
    const manifest = profileDir ? this.readProfileManifest(profileDir) : { dependencies: {}, bundles: [] }
    const pm = this.getPluginManager()
    let bundles: readonly HostBundleInfoLike[] = []
    if (pm) {
      try {
        bundles = await pm.listBundles()
      } catch {
        bundles = []
      }
    }
    const bundleMap = new Map(bundles.map((b) => [b.name, b]))

    for (const spec of this.plugins) {
      const candidates = [spec.packageName, ...spec.legacyPackageNames]
      let matchedName: string | undefined
      for (const name of candidates) {
        if (
          Object.prototype.hasOwnProperty.call(manifest.dependencies, name) ||
          bundleMap.has(name) ||
          manifest.bundles.includes(name)
        ) {
          matchedName = name
          break
        }
      }
      if (!matchedName) {
        if (spec.id === 'bridge' && this.runningBridgeVersion) {
          map.set(spec.id, {
            installedPackageName: spec.packageName,
            installedVersion: this.runningBridgeVersion,
            enabled: true,
            installed: true,
          })
        }
        continue
      }
      const bundleInfo = bundleMap.get(matchedName)
      const rawSpec = manifest.dependencies[matchedName] ?? bundleInfo?.source
      const diskVersion = profileDir ? this.readInstalledVersionFromDisk(profileDir, matchedName) : undefined
      const installedVersion = diskVersion ?? bundleInfo?.version
      const enabled = bundleInfo ? bundleInfo.enabled : manifest.bundles.includes(matchedName)
      map.set(spec.id, {
        installedPackageName: matchedName,
        ...(rawSpec ? { rawSpec } : {}),
        ...(installedVersion ? { installedVersion } : {}),
        enabled,
        installed: true,
      })
    }

    return map
  }

  private async fetchReleaseFromMirror(
    spec: ManagedPluginSpec,
    mirrorBase: string,
    requestedVersion?: string,
  ): Promise<ReleaseInfo> {
    const query = requestedVersion ? `?version=${encodeURIComponent(requestedVersion)}` : ''
    const url = `${mirrorBase}/${spec.id}/latest.json${query}`
    const res = await this.fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      throw new Error(`镜像查询失败 (HTTP ${res.status})`)
    }
    const doc = (await res.json()) as {
      version?: string
      tagName?: string
      publishedAt?: string
      releaseUrl?: string
      tarballUrl?: string
      assetName?: string
      expectedSha256?: string
      checksumUrl?: string
      releaseNotes?: string
    }
    const version = normalizeVersion(doc.version ?? doc.tagName)
    if (!version || !doc.tarballUrl) {
      throw new Error('镜像返回的 Release 元数据不完整')
    }
    return {
      version,
      tagName: doc.tagName || `v${version}`,
      ...(doc.publishedAt ? { publishedAt: doc.publishedAt } : {}),
      releaseUrl: doc.releaseUrl || `${mirrorBase}/${spec.id}`,
      tarballUrl: doc.tarballUrl,
      assetName: doc.assetName || `${spec.versionedAssetPrefix}${version}.tgz`,
      ...(doc.expectedSha256 ? { expectedSha256: doc.expectedSha256.toLowerCase() } : {}),
      ...(doc.checksumUrl ? { checksumUrl: doc.checksumUrl } : {}),
      ...(doc.releaseNotes ? { releaseNotes: doc.releaseNotes } : {}),
      source: 'mirror',
    }
  }

  private async fetchReleaseViaGitHubApi(
    spec: ManagedPluginSpec,
    requestedVersion?: string,
    cached?: ReleaseCacheEntry,
  ): Promise<ReleaseInfo> {
    const normalizedReq = requestedVersion ? normalizeVersion(requestedVersion) : undefined
    if (requestedVersion && !normalizedReq) {
      throw new Error(`版本号格式无效：${requestedVersion}`)
    }
    const endpoint = normalizedReq
      ? `https://api.github.com/repos/${spec.githubRepo}/releases/tags/v${normalizedReq}`
      : `https://api.github.com/repos/${spec.githubRepo}/releases/latest`
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-lark-bridge-updater',
    }
    if (!normalizedReq && cached?.etag) {
      headers['if-none-match'] = cached.etag
    }
    const res = await this.fetchImpl(endpoint, {
      headers,
      signal: AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS),
    })
    if (res.status === 304 && cached) {
      return cached.info
    }
    if (!res.ok) {
      throw new Error(`GitHub API HTTP ${res.status}`)
    }
    const payload = (await res.json()) as {
      tag_name?: string
      published_at?: string
      html_url?: string
      body?: string
      assets?: Array<{
        name?: string
        browser_download_url?: string
        digest?: string
      }>
    }
    const tagName = String(payload.tag_name ?? '').trim()
    const version = normalizeVersion(tagName)
    if (!version) {
      throw new Error(`无法解析 GitHub Release 版本标签：${tagName || '(empty)'}`)
    }
    const assets = Array.isArray(payload.assets) ? payload.assets : []
    const versionedName = `${spec.versionedAssetPrefix}${version}.tgz`
    const chosenAsset =
      assets.find((a) => a.name === versionedName && a.browser_download_url) ??
      assets.find((a) => a.name === spec.latestAssetAlias && a.browser_download_url) ??
      assets.find((a) => typeof a.name === 'string' && a.name.endsWith('.tgz') && a.browser_download_url)
    if (!chosenAsset?.browser_download_url || !chosenAsset.name) {
      throw new Error(`Release ${tagName} 未包含可用的 .tgz 资产`)
    }
    const checksumAsset = assets.find((a) => a.name === 'SHA256SUMS.txt' && a.browser_download_url)
    let expectedSha256: string | undefined
    if (typeof chosenAsset.digest === 'string' && chosenAsset.digest.startsWith('sha256:')) {
      const candidate = chosenAsset.digest.slice('sha256:'.length).trim().toLowerCase()
      if (SHA256_RE.test(candidate)) expectedSha256 = candidate
    }
    const releaseNotes = summarizeReleaseNotes(payload.body)
    const info: ReleaseInfo = {
      version,
      tagName,
      ...(payload.published_at ? { publishedAt: payload.published_at } : {}),
      releaseUrl: payload.html_url || `https://github.com/${spec.githubRepo}/releases/tag/${tagName}`,
      tarballUrl: chosenAsset.browser_download_url,
      assetName: chosenAsset.name,
      ...(expectedSha256 ? { expectedSha256 } : {}),
      ...(checksumAsset?.browser_download_url ? { checksumUrl: checksumAsset.browser_download_url } : {}),
      ...(releaseNotes ? { releaseNotes } : {}),
      source: 'github-api',
    }
    if (!normalizedReq) {
      const etag = res.headers.get('etag') ?? undefined
      this.releaseCache.set(spec.id, {
        info,
        ...(etag ? { etag } : {}),
        fetchedAtMs: Date.now(),
      })
    }
    return info
  }

  private async fetchReleaseViaGitHubRedirect(
    spec: ManagedPluginSpec,
    requestedVersion?: string,
  ): Promise<ReleaseInfo> {
    let tagName = ''
    let version: string | undefined
    if (requestedVersion) {
      version = normalizeVersion(requestedVersion)
      if (!version) throw new Error(`版本号格式无效：${requestedVersion}`)
      tagName = `v${version}`
    } else {
      const latestUrl = `https://github.com/${spec.githubRepo}/releases/latest`
      const res = await this.fetchImpl(latestUrl, {
        method: 'HEAD',
        redirect: 'manual',
        headers: { 'user-agent': 'dsh-lark-bridge-updater' },
        signal: AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS),
      })
      if (res.status !== 301 && res.status !== 302) {
        throw new Error(`GitHub Release 重定向探测失败 (HTTP ${res.status})`)
      }
      const location = res.headers.get('location') ?? ''
      const parsed = new URL(location, latestUrl)
      const prefix = `/${spec.githubRepo}/releases/tag/`
      if (
        parsed.origin !== 'https://github.com' ||
        !parsed.pathname.toLowerCase().startsWith(prefix.toLowerCase())
      ) {
        throw new Error(`无法从重定向路径解析 Release 标签：${location}`)
      }
      tagName = parsed.pathname.slice(prefix.length).replace(/\/+$/, '')
      version = normalizeVersion(tagName)
      if (!version) {
        throw new Error(`非法的 Release 标签：${tagName}`)
      }
    }

    const versionedName = `${spec.versionedAssetPrefix}${version}.tgz`
    const candidates = [versionedName, spec.latestAssetAlias]
    for (const assetName of candidates) {
      const tarballUrl = `https://github.com/${spec.githubRepo}/releases/download/${tagName}/${assetName}`
      const head = await this.fetchImpl(tarballUrl, {
        method: 'HEAD',
        redirect: 'manual',
        headers: { 'user-agent': 'dsh-lark-bridge-updater' },
        signal: AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS),
      })
      if (head.status === 200 || head.status === 301 || head.status === 302) {
        const info: ReleaseInfo = {
          version,
          tagName,
          releaseUrl: `https://github.com/${spec.githubRepo}/releases/tag/${tagName}`,
          tarballUrl,
          assetName,
          checksumUrl: `https://github.com/${spec.githubRepo}/releases/download/${tagName}/SHA256SUMS.txt`,
          source: 'github-redirect',
        }
        if (!requestedVersion) {
          this.releaseCache.set(spec.id, { info, fetchedAtMs: Date.now() })
        }
        return info
      }
    }
    throw new Error(`Release ${tagName} 中未找到可下载的 .tgz 资产`)
  }

  async resolveLatestRelease(
    spec: ManagedPluginSpec,
    options: { readonly force?: boolean; readonly version?: string } = {},
  ): Promise<ReleaseInfo> {
    const mirrorBase = resolveLoopbackMirrorBase()
    if (mirrorBase) {
      const info = await this.fetchReleaseFromMirror(spec, mirrorBase, options.version)
      if (!options.version) {
        this.releaseCache.set(spec.id, { info, fetchedAtMs: Date.now() })
      }
      return info
    }

    const cached = !options.version ? this.releaseCache.get(spec.id) : undefined
    if (cached && !options.force && Date.now() - cached.fetchedAtMs < this.cacheTtlMs) {
      return cached.info
    }

    try {
      return await this.fetchReleaseViaGitHubApi(spec, options.version, cached)
    } catch (apiErr) {
      try {
        return await this.fetchReleaseViaGitHubRedirect(spec, options.version)
      } catch (redirectErr) {
        const msg1 = apiErr instanceof Error ? apiErr.message : String(apiErr)
        const msg2 = redirectErr instanceof Error ? redirectErr.message : String(redirectErr)
        throw new Error(`检测新版本失败：${msg1}；降级探测也失败：${msg2}`)
      }
    }
  }

  /**
   * Pre-download and cryptographically verify the release tarball before removing the currently
   * installed bundle, ensuring a broken network or corrupted asset never leaves the plugin missing.
   */
  async verifyReleaseAsset(release: ReleaseInfo): Promise<{ readonly bytes: number; readonly sha256: string }> {
    let expectedSha256 = release.expectedSha256?.toLowerCase()
    if (!expectedSha256 && release.checksumUrl) {
      try {
        const sumRes = await this.fetchImpl(release.checksumUrl, {
          headers: { 'user-agent': 'dsh-lark-bridge-updater' },
          signal: AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS),
        })
        if (sumRes.ok) {
          const sums = parseSha256Sums(await sumRes.text())
          expectedSha256 = sums.get(release.assetName)
        }
      } catch {
        // Optional checksum fetch; if SHA256SUMS is unreachable we still verify archive download.
      }
    }

    const res = await this.fetchImpl(release.tarballUrl, {
      headers: { 'user-agent': 'dsh-lark-bridge-updater' },
      signal: AbortSignal.timeout(TARBALL_VERIFY_TIMEOUT_MS),
    })
    if (!res.ok) {
      throw new Error(`下载发布包预检失败 (HTTP ${res.status})：${release.assetName}`)
    }
    const contentLength = Number(res.headers.get('content-length') ?? '0')
    if (Number.isFinite(contentLength) && contentLength > MAX_TARBALL_VERIFY_BYTES) {
      throw new Error(`发布包体积异常 (${contentLength} bytes)，已拒绝更新`)
    }

    const hash = createHash('sha256')
    let bytes = 0
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader()
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > MAX_TARBALL_VERIFY_BYTES) {
          await reader.cancel().catch(() => {})
          throw new Error(`发布包体积超过上限 (${MAX_TARBALL_VERIFY_BYTES} bytes)，已拒绝更新`)
        }
        hash.update(chunk.value)
      }
    } else {
      const buf = Buffer.from(await res.arrayBuffer())
      bytes = buf.byteLength
      if (bytes > MAX_TARBALL_VERIFY_BYTES) {
        throw new Error(`发布包体积超过上限 (${MAX_TARBALL_VERIFY_BYTES} bytes)，已拒绝更新`)
      }
      hash.update(buf)
    }

    if (bytes === 0) {
      throw new Error(`发布包内容为空：${release.assetName}`)
    }
    const sha256 = hash.digest('hex')
    if (expectedSha256 && sha256 !== expectedSha256) {
      throw new Error(
        `发布包 SHA256 校验不匹配（期望 ${expectedSha256.slice(0, 12)}…，实际 ${sha256.slice(0, 12)}…）`,
      )
    }
    return { bytes, sha256 }
  }

  private resolveManagedTarballChecksum(tarballUrl: string): {
    readonly checksumUrl: string
    readonly assetName: string
  } | undefined {
    for (const spec of this.plugins) {
      const escapedRepo = spec.githubRepo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const match = new RegExp(
        `^https://github\\.com/${escapedRepo}/releases/download/([^/]+)/([^/?#]+\\.tgz)(?:[?#].*)?$`,
        'i',
      ).exec(tarballUrl)
      if (match) {
        const tagName = match[1]!
        const assetName = match[2]!
        return {
          checksumUrl: `https://github.com/${spec.githubRepo}/releases/download/${tagName}/SHA256SUMS.txt`,
          assetName,
        }
      }
    }
    return undefined
  }

  /**
   * Compute verified `sha512-<base64>` SRI integrity for a remote tarball URL declared in the
   * profile manifest. For managed GitHub Release URLs, cross-checks SHA256 against `SHA256SUMS.txt`
   * when available and fails closed on mismatch.
   */
  private async computeVerifiedTarballIntegrity(tarballUrl: string): Promise<string | undefined> {
    let expectedSha256: string | undefined
    const managedChecksum = this.resolveManagedTarballChecksum(tarballUrl)
    if (managedChecksum) {
      try {
        const sumRes = await this.fetchImpl(managedChecksum.checksumUrl, {
          headers: { 'user-agent': 'dsh-lark-bridge-updater' },
          signal: AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS),
        })
        if (sumRes.ok) {
          const sums = parseSha256Sums(await sumRes.text())
          expectedSha256 = sums.get(managedChecksum.assetName)
        }
      } catch {
        // Optional checksum lookup; continue and still verify download & bounds.
      }
    }

    const res = await this.fetchImpl(tarballUrl, {
      headers: { 'user-agent': 'dsh-lark-bridge-updater' },
      signal: AbortSignal.timeout(TARBALL_VERIFY_TIMEOUT_MS),
    })
    if (!res.ok) return undefined
    const contentLength = Number(res.headers.get('content-length') ?? '0')
    if (Number.isFinite(contentLength) && contentLength > MAX_TARBALL_VERIFY_BYTES) {
      return undefined
    }

    const sha256Hash = createHash('sha256')
    const sha512Hash = createHash('sha512')
    let bytes = 0
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader()
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > MAX_TARBALL_VERIFY_BYTES) {
          await reader.cancel().catch(() => {})
          return undefined
        }
        sha256Hash.update(chunk.value)
        sha512Hash.update(chunk.value)
      }
    } else {
      const buf = Buffer.from(await res.arrayBuffer())
      bytes = buf.byteLength
      if (bytes > MAX_TARBALL_VERIFY_BYTES) return undefined
      sha256Hash.update(buf)
      sha512Hash.update(buf)
    }

    if (bytes === 0) return undefined
    if (expectedSha256 && sha256Hash.digest('hex') !== expectedSha256) {
      return undefined
    }
    return `sha512-${sha512Hash.digest('base64')}`
  }

  /**
   * Inspect the profile's `pnpm-lock.yaml` for direct remote tarball dependencies missing an
   * `integrity` field (stripped by older pnpm <=10.33 and rejected by pnpm >=10.34 / >=11.4 with
   * `ERR_PNPM_MISSING_TARBALL_INTEGRITY`) and backfill verified `sha512-...` hashes in-place.
   */
  async repairProfileLockfileIntegrity(profileDir: string): Promise<{
    readonly repairedCount: number
    readonly remainingMissing: number
  }> {
    const lockfilePath = join(profileDir, 'pnpm-lock.yaml')
    if (!existsSync(lockfilePath)) {
      return { repairedCount: 0, remainingMissing: 0 }
    }
    let lockContent: string
    try {
      lockContent = readFileSync(lockfilePath, 'utf8')
    } catch {
      return { repairedCount: 0, remainingMissing: 0 }
    }
    const missingUrls = findLockfileEntriesMissingTarballIntegrity(lockContent)
    if (missingUrls.length === 0) {
      return { repairedCount: 0, remainingMissing: 0 }
    }

    // Fail-closed allowlist: only fetch and backfill URLs explicitly declared in profile `package.json`.
    const manifest = this.readProfileManifest(profileDir)
    const declaredUrls = new Set(
      Object.values(manifest.dependencies)
        .filter((spec): spec is string => typeof spec === 'string')
        .map((spec) => spec.trim()),
    )

    const urlToIntegrity = new Map<string, string>()
    for (const url of missingUrls) {
      if (!declaredUrls.has(url)) continue
      try {
        const integrity = await this.computeVerifiedTarballIntegrity(url)
        if (integrity) urlToIntegrity.set(url, integrity)
      } catch {
        // Leave unverified entries untouched so fallback retry can handle them cleanly.
      }
    }

    if (urlToIntegrity.size === 0) {
      return { repairedCount: 0, remainingMissing: missingUrls.length }
    }
    const patched = patchLockfileTarballIntegrities(lockContent, urlToIntegrity)
    if (patched.patchedCount > 0) {
      atomicWriteText(lockfilePath, patched.content)
    }
    const remaining = findLockfileEntriesMissingTarballIntegrity(patched.content).length
    return { repairedCount: patched.patchedCount, remainingMissing: remaining }
  }

  getOperation(operationId?: string): PluginUpdateOperation | undefined {
    const state = getGlobalUpdateState()
    if (operationId) {
      if (state.active?.operationId === operationId) return state.active
      if (state.last?.operationId === operationId) return state.last
      const persisted = readPersistedOperation(this.statusFile)
      return persisted?.operationId === operationId ? persisted : undefined
    }
    return state.active ?? state.last ?? readPersistedOperation(this.statusFile)
  }

  async getOverview(options: { readonly check?: boolean; readonly force?: boolean } = {}): Promise<PluginUpdatesOverview> {
    const profileCtx = this.getProfileContext()
    const pm = this.getPluginManager()
    const hmr = this.getHmr()
    const hmrAvailable = Boolean(hmr)
    const pluginManagerAvailable = Boolean(pm)
    const hotReloadSupported = hmrAvailable && pluginManagerAvailable
    const hotReloadUnavailableReason = !pluginManagerAvailable
      ? '当前 DSH 运行环境未提供 pluginManager 服务'
      : !hmrAvailable
        ? '当前 DSH Profile 未启用 HMR（请确认 cordis.patch.yml 未禁用 hmr），无法免重启热更新'
        : undefined

    const installedMap = await this.resolveInstalledPackages()
    const plugins: ManagedPluginStatus[] = []
    let latestCheckedAtMs: number | undefined

    await Promise.all(
      this.plugins.map(async (spec) => {
        const installedPkg = installedMap.get(spec.id)
        const source = installedPkg
          ? classifySourceSpec(installedPkg.rawSpec)
          : { kind: 'not-installed' as const, label: '未安装' }

        let latest: ReleaseInfo | undefined
        let checkError: string | undefined
        let checkedAtMs: number | undefined

        if (options.check) {
          try {
            latest = await this.resolveLatestRelease(spec, { force: options.force })
            checkedAtMs = this.releaseCache.get(spec.id)?.fetchedAtMs ?? Date.now()
          } catch (err) {
            checkError = err instanceof Error ? err.message : String(err)
          }
        } else {
          const cached = this.releaseCache.get(spec.id)
          if (cached) {
            latest = cached.info
            checkedAtMs = cached.fetchedAtMs
          }
        }

        if (checkedAtMs && (!latestCheckedAtMs || checkedAtMs > latestCheckedAtMs)) {
          latestCheckedAtMs = checkedAtMs
        }

        const installedVersion = installedPkg?.installedVersion
        const runningVersion = spec.id === 'bridge' ? this.runningBridgeVersion : installedVersion
        const updateAvailable = Boolean(
          installedPkg?.installed &&
            latest &&
            isNewerVersion(installedVersion, latest.version),
        )

        let updateBlockedReason: string | undefined
        if (!installedPkg?.installed) {
          updateBlockedReason = '当前 Profile 未安装该插件'
        } else if (source.kind === 'local-link' || source.kind === 'local-file') {
          updateBlockedReason = '当前通过本地源码路径挂载，不支持直接在线覆盖（请先切换为 GitHub Release 安装）'
        } else if (!hotReloadSupported) {
          updateBlockedReason = hotReloadUnavailableReason
        }

        plugins.push({
          id: spec.id,
          displayName: spec.displayName,
          packageName: spec.packageName,
          ...(installedPkg?.installedPackageName
            ? { installedPackageName: installedPkg.installedPackageName }
            : {}),
          githubRepo: spec.githubRepo,
          installed: Boolean(installedPkg?.installed),
          enabled: Boolean(installedPkg?.enabled),
          ...(installedVersion ? { installedVersion } : {}),
          ...(runningVersion ? { runningVersion } : {}),
          sourceKind: source.kind,
          sourceLabel: source.label,
          ...(latest ? { latest } : {}),
          updateAvailable,
          hotReloadSupported: hotReloadSupported && !updateBlockedReason,
          ...(updateBlockedReason ? { updateBlockedReason } : {}),
          ...(checkError ? { checkError } : {}),
          ...(checkedAtMs ? { checkedAtMs } : {}),
        })
      }),
    )

    // Keep stable declaration order regardless of Promise.all settlement order.
    const order = new Map(this.plugins.map((p, idx) => [p.id, idx]))
    plugins.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))

    const updatableCount = plugins.filter((p) => p.updateAvailable).length
    const op = this.getOperation()
    const lcStatus = this.lifecycle.getLifecycleStatus()
    const activeExternalAgents = this.lifecycle.countActiveExternalAgents?.() ?? 0

    return {
      ok: true,
      ...(profileCtx?.name ? { profileName: profileCtx.name } : {}),
      hmrAvailable,
      pluginManagerAvailable,
      hotReloadSupported,
      ...(hotReloadUnavailableReason ? { hotReloadUnavailableReason } : {}),
      ...(latestCheckedAtMs ? { checkedAtMs: latestCheckedAtMs } : {}),
      inFlightTurns: lcStatus.totalInFlight,
      activeExternalAgents,
      bridgeSeamlessReload: true,
      updatableCount,
      plugins,
      ...(op ? { operation: op } : {}),
    }
  }

  /**
   * Preempt an in-progress `draining` wait and proceed immediately into the hot-update swap.
   */
  forceActiveDrain(operationId?: string): { readonly forced: boolean; readonly operation?: PluginUpdateOperation } {
    const state = getGlobalUpdateState()
    const active = state.active
    if (!active) return { forced: false }
    if (operationId && active.operationId !== operationId) {
      return { forced: false, operation: active }
    }
    if (active.status !== 'draining' || !state.drainAbort) {
      return { forced: false, operation: active }
    }
    state.drainForceRequested = true
    state.drainAbort.abort()
    return { forced: true, operation: active }
  }

  async startUpdate(options: StartPluginUpdateOptions = {}): Promise<PluginUpdateOperation> {
    const state = getGlobalUpdateState()
    if (state.active) {
      throw new Error(`已有插件更新任务正在进行中 (${state.active.operationId})，请稍候`)
    }

    const pm = this.getPluginManager()
    if (!pm) {
      throw new Error('当前 DSH 运行环境未提供 pluginManager 服务，无法执行在线更新')
    }
    const hmr = this.getHmr()
    if (!hmr && !options.allowRestartRequired) {
      throw new Error('当前 DSH Profile 未启用 HMR，无法免重启热更新（请先移除 cordis.patch.yml 中的 hmr 禁用配置并重启一次）')
    }

    const targetSelector = options.target ?? 'all'
    if (options.version && targetSelector === 'all') {
      throw new Error('指定 --version 时必须明确选择单个插件（bridge 或 external-agents）')
    }

    const installedMap = await this.resolveInstalledPackages()
    const selectedSpecs =
      targetSelector === 'all'
        ? this.plugins.filter((spec) => installedMap.has(spec.id))
        : this.plugins.filter((spec) => spec.id === targetSelector)

    if (selectedSpecs.length === 0) {
      throw new Error(`未找到目标插件：${targetSelector}`)
    }

    interface PlannedTarget {
      readonly spec: ManagedPluginSpec
      readonly installedKey: string
      readonly previousSpec?: string
      readonly fromVersion?: string
      readonly wasEnabled: boolean
      readonly release: ReleaseInfo
    }

    const planned: PlannedTarget[] = []
    for (const spec of selectedSpecs) {
      const installed = installedMap.get(spec.id)
      if (!installed?.installed) {
        if (targetSelector !== 'all') {
          throw new Error(`当前 Profile 未安装 ${spec.displayName} (${spec.packageName})`)
        }
        continue
      }
      const source = classifySourceSpec(installed.rawSpec)
      if (
        (source.kind === 'local-link' || source.kind === 'local-file') &&
        !options.allowMigrateLocal
      ) {
        if (targetSelector !== 'all') {
          throw new Error(
            `${spec.displayName} 当前为${source.label}，已拒绝直接覆盖；如需迁移为 GitHub Release 请传入 allowMigrateLocal`,
          )
        }
        continue
      }
      const release = await this.resolveLatestRelease(spec, {
        force: true,
        ...(options.version ? { version: options.version } : {}),
      })
      const newer = isNewerVersion(installed.installedVersion, release.version)
      const allowSameVersion = Boolean(options.allowMigrateLocal) || (Boolean(options.force) && targetSelector !== 'all')
      if (!newer && !allowSameVersion) {
        continue
      }
      planned.push({
        spec,
        installedKey: installed.installedPackageName,
        ...(installed.rawSpec ? { previousSpec: installed.rawSpec } : {}),
        ...(installed.installedVersion ? { fromVersion: installed.installedVersion } : {}),
        wasEnabled: installed.enabled,
        release,
      })
    }

    if (planned.length === 0) {
      throw new Error('所有目标插件均已是最新版本，无需更新')
    }

    // Always update external-agents before self-updating bridge so the coordinator stays alive as long as possible.
    planned.sort((a, b) => {
      if (a.spec.id === 'bridge' && b.spec.id !== 'bridge') return 1
      if (a.spec.id !== 'bridge' && b.spec.id === 'bridge') return -1
      return 0
    })

    const now = Date.now()
    const operationId = `upd_${randomUUID().slice(0, 12)}`
    const items: PluginUpdateItemResult[] = planned.map((p) => ({
      id: p.spec.id,
      displayName: p.spec.displayName,
      packageName: p.spec.packageName,
      ...(p.fromVersion ? { fromVersion: p.fromVersion } : {}),
      toVersion: p.release.version,
      status: 'pending',
      hotReloaded: false,
      restartRequired: false,
    }))

    const initialOp: PluginUpdateOperation = {
      operationId,
      status: 'verifying',
      message: `正在校验 ${planned.map((p) => `${p.spec.displayName} v${p.release.version}`).join('、')} 发布包…`,
      startedAtMs: now,
      updatedAtMs: now,
      targetSelector,
      ...(options.force ? { forced: true } : {}),
      items,
      hotReloaded: false,
      restartRequired: false,
    }

    const statusFile = this.statusFile
    const publishOp = (next: PluginUpdateOperation): PluginUpdateOperation => {
      const finished =
        next.status === 'succeeded' || next.status === 'failed' || next.status === 'rolled_back'
      if (finished) {
        state.active = undefined
        state.drainAbort = undefined
        state.drainForceRequested = false
        state.last = next
      } else {
        state.active = next
        state.last = next
      }
      atomicWriteJson(statusFile, next)
      return next
    }

    publishOp(initialOp)

    // Pre-verify all tarballs synchronously BEFORE queuing the detached swap, or inside the async task?
    // Run inside detached async pipeline after a brief tick so the 202 HTTP/RPC response flushes cleanly.
    const lifecycle = this.lifecycle
    const rootCtx = this.ctx
    const profileDir = this.getProfileContext()?.dir
    const drainTimeoutMs = options.drainTimeoutMs ?? 90_000
    const force = Boolean(options.force)
    const verifyFn = (rel: ReleaseInfo) => this.verifyReleaseAsset(rel)
    const repairLockfileFn = (dir: string) => this.repairProfileLockfileIntegrity(dir)
    const readManifestFn = (dir: string) => this.readProfileManifest(dir)

    const runDetachedPipeline = async (): Promise<void> => {
      let current = initialOp
      const updateOp = (patch: Partial<PluginUpdateOperation>): void => {
        current = publishOp({
          ...current,
          ...patch,
          updatedAtMs: Date.now(),
        })
      }
      const updateItem = (index: number, patch: Partial<PluginUpdateItemResult>): void => {
        const nextItems = current.items.map((item, idx) =>
          idx === index ? { ...item, ...patch } : item,
        )
        updateOp({ items: nextItems })
      }

      let drainedByUs = false
      let releaseClientModulesHold: (() => Promise<void>) | undefined
      try {
        // Yield briefly so the 202 response flushes before any heavy work or plugin unload.
        await new Promise((r) => setTimeout(r, 150))

        // Stage 1: Verify every target tarball's availability & SHA256 before unloading anything.
        for (let i = 0; i < planned.length; i += 1) {
          const target = planned[i]!
          updateOp({
            status: 'verifying',
            currentTarget: target.spec.id,
            message: `正在下载校验 ${target.spec.displayName} v${target.release.version}（SHA256）…`,
          })
          try {
            await verifyFn(target.release)
          } catch (err) {
            throw new TaggedUpdateError(
              err instanceof Error ? err.message : String(err),
              'verify_failed',
            )
          }
        }

        // Stage 2: Drain only when updating `external-agents` while external agent sessions are active.
        // Self-updating `dsh-lark-bridge` preserves live host agents and reattaches to their event
        // streams after HMR reload without blocking on in-flight Feishu turns.
        const includesBridge = planned.some((p) => p.spec.id === 'bridge')
        const includesExternal = planned.some((p) => p.spec.id === 'external-agents')
        const lcStatus = lifecycle.getLifecycleStatus()
        const activeExternalCount = includesExternal
          ? (lifecycle.countActiveExternalAgents?.() ?? 0)
          : 0

        if (force) {
          // Force update: skip blocking drain wait; still briefly pause new inbound intake when self-swapping bridge.
          if (includesBridge) {
            await lifecycle.beginDrain({ reason: `plugin_hot_update_force:${operationId}` }).catch(() => {})
            drainedByUs = true
          }
        } else if (includesExternal && activeExternalCount > 0) {
          const drainAbort = new AbortController()
          state.drainAbort = drainAbort
          state.drainForceRequested = false
          updateOp({
            status: 'draining',
            message: `等待 ${activeExternalCount} 个外部 Agent 会话排空…`,
          })
          try {
            if (includesBridge) {
              await lifecycle.beginDrain({ reason: `plugin_hot_update:${operationId}` }).catch(() => {})
              drainedByUs = true
            }
            const deadline = Date.now() + drainTimeoutMs
            while (Date.now() < deadline && !drainAbort.signal.aborted) {
              if ((lifecycle.countActiveExternalAgents?.() ?? 0) === 0) break
              await new Promise((r) => setTimeout(r, 400))
            }
            if (state.drainForceRequested) {
              updateOp({ forced: true })
            } else {
              const remaining = lifecycle.countActiveExternalAgents?.() ?? 0
              if (remaining > 0) {
                if (drainedByUs) {
                  await lifecycle.cancelDrain().catch(() => {})
                  drainedByUs = false
                }
                throw new TaggedUpdateError(
                  `仍有 ${remaining} 个外部 Agent 会话运行中，已取消更新外部运行时；可等待会话空闲后重试或在弹窗中点击「强制更新」（CLI 使用 --force）`,
                  'drain_timeout',
                )
              }
            }
          } finally {
            state.drainAbort = undefined
            state.drainForceRequested = false
          }
        } else if (includesBridge) {
          // Briefly pause new inbound intake during self-swap so incoming Feishu events
          // wait for the reloaded WS client rather than getting dropped mid-unload, while
          // keeping already-running host agents alive for seamless post-reload reattach.
          await lifecycle.beginDrain({ reason: `plugin_hot_update:${operationId}` }).catch(() => {})
          drainedByUs = true
        }

        const postDrainStatus = lifecycle.getLifecycleStatus()
        const preservedTurns = includesBridge ? postDrainStatus.activeTurns.length : 0
        if (includesBridge) {
          updateOp({
            seamlessBridgeSwap: true,
            ...(preservedTurns > 0 ? { preservedTurns } : {}),
          })
        }

        lifecycle.recordUpdateEvent?.(
          `开始${current.forced ? '强制' : ''}${includesBridge && preservedTurns > 0 ? '无损' : ''}免重启热更新：${planned.map((p) => `${p.spec.displayName} ${p.fromVersion ?? '?'}→${p.release.version}`).join('，')}${preservedTurns > 0 ? `（后台保活 ${preservedTurns} 个在途会话）` : ''}`,
        )

        // Stage 3: Execute removeBundle -> installBundle via host-owned `pluginManager` (survives bridge unload!).
        // Pre-flight repair missing tarball integrity fields in `pnpm-lock.yaml` before unloading any
        // bundle so pnpm >=10.34 / >=11.4 does not abort mid-swap with ERR_PNPM_MISSING_TARBALL_INTEGRITY.
        if (profileDir) {
          await repairLockfileFn(profileDir).catch(() => {})
        }

        let anyRestartRequired = false
        let allHotReloaded = true
        let markedHotReloadSwap = false
        try {

        for (let i = 0; i < planned.length; i += 1) {
          const target = planned[i]!
          updateItem(i, { status: 'running' })
          const preserveSuffix =
            target.spec.id === 'bridge' && preservedTurns > 0
              ? `（后台保持 ${preservedTurns} 个在途会话运行，重载后自动续传）`
              : ''
          updateOp({
            status: 'removing',
            currentTarget: target.spec.id,
            message: `正在准备切换 ${target.spec.displayName} ${target.fromVersion ? `v${target.fromVersion} → ` : ''}v${target.release.version}${preserveSuffix}…`,
          })

          // Record current realpath before removal so Node's persistent ESM realpathCache
          // relocates imports & client-module lookups onto the newly installed `.pnpm/` store dir.
          if (profileDir) {
            recordManagedPackageMove(profileDir, target.installedKey, target.spec.packageName)
          }

          const lockfilePath = profileDir ? join(profileDir, 'pnpm-lock.yaml') : undefined
          let lockfileBackup: string | undefined
          if (lockfilePath && existsSync(lockfilePath)) {
            try {
              lockfileBackup = readFileSync(lockfilePath, 'utf8')
            } catch {
              lockfileBackup = undefined
            }
          }
          let lockfileClearedForRetry = false

          // When self-updating bridge:
          // 1) Signal `LarkBridgeManager.stop()` to preserve live host agents for seamless reattach.
          // 2) Hold intermediate client-module deletion broadcasts so the browser keeps the UI &
          //    sidebar mounted during pnpm swap and transitions atomically via `entries.replace()`.
          if (target.spec.id === 'bridge') {
            lifecycle.prepareHotReloadSwap?.(operationId)
            markedHotReloadSwap = true
            releaseClientModulesHold = holdClientModulesDuringSwap(rootCtx, [
              target.installedKey,
              target.spec.packageName,
            ])
          }

          let removeRes = await pm.removeBundle(target.installedKey)
          if (
            (removeRes.application === 'failed' || removeRes.application === 'cancelled') &&
            isMissingTarballIntegrityError(removeRes) &&
            lockfilePath &&
            existsSync(lockfilePath)
          ) {
            try {
              rmSync(lockfilePath, { force: true })
              lockfileClearedForRetry = true
            } catch {
              // Ignore unlink failure and proceed to rollback path.
            }
            if (lockfileClearedForRetry) {
              removeRes = await pm.removeBundle(target.installedKey)
            }
          }

          if (removeRes.application === 'failed' || removeRes.application === 'cancelled') {
            const missingIntegrity = isMissingTarballIntegrityError(removeRes)
            const rawErrMsg = formatChangeError(removeRes, `卸载旧版 ${target.spec.displayName} 失败`)
            const errMsg = missingIntegrity ? formatMissingIntegrityHint(rawErrMsg) : rawErrMsg

            // DSH `PluginManager.removeBundle` deselects and HMR-unloads the bundle BEFORE running
            // `pnpm remove`, and does NOT re-enable it when `pnpm remove` fails. Re-enable (or
            // reinstall) automatically so the bridge never stays stranded at HTTP 404.
            const stillInstalled = profileDir
              ? Object.prototype.hasOwnProperty.call(
                  readManifestFn(profileDir).dependencies,
                  target.installedKey,
                )
              : true
            if (stillInstalled && lockfilePath && lockfileBackup !== undefined) {
              try {
                atomicWriteText(lockfilePath, lockfileBackup)
              } catch {
                // Non-fatal lockfile backup restore.
              }
            }

            let restored = false
            if (target.wasEnabled) {
              updateOp({
                status: 'restoring',
                currentTarget: target.spec.id,
                message: `卸载旧版失败，正在自动恢复启用 ${target.spec.displayName}…`,
              })
              if (stillInstalled && typeof pm.setBundleEnabled === 'function') {
                const enableRes = await pm
                  .setBundleEnabled(target.installedKey, true)
                  .catch(() => undefined)
                restored = Boolean(
                  enableRes &&
                    enableRes.application !== 'failed' &&
                    enableRes.application !== 'cancelled',
                )
              }
              if (!restored && !stillInstalled && target.previousSpec) {
                let reinstallRes = await pm
                  .installBundle(target.previousSpec, { enabled: true })
                  .catch(() => undefined)
                if (
                  (!reinstallRes ||
                    reinstallRes.application === 'failed' ||
                    reinstallRes.application === 'cancelled') &&
                  isMissingTarballIntegrityError(reinstallRes) &&
                  lockfilePath &&
                  existsSync(lockfilePath)
                ) {
                  try {
                    rmSync(lockfilePath, { force: true })
                    reinstallRes = await pm
                      .installBundle(target.previousSpec, { enabled: true })
                      .catch(() => undefined)
                  } catch {
                    // Ignore unlink error.
                  }
                }
                restored = Boolean(
                  reinstallRes &&
                    reinstallRes.application !== 'failed' &&
                    reinstallRes.application !== 'cancelled',
                )
              }
            }

            if (markedHotReloadSwap) {
              lifecycle.finishHotReloadSwap?.(operationId, { disposeDetached: !restored })
              markedHotReloadSwap = false
            }
            if (drainedByUs) {
              await lifecycle.cancelDrain().catch(() => {})
              drainedByUs = false
            }
            updateItem(i, {
              status: restored ? 'rolled_back' : 'failed',
              error: errMsg,
              rolledBack: restored,
            })
            updateOp({
              status: restored ? 'rolled_back' : 'failed',
              failureCode: 'install_failed',
              error: errMsg,
              message: restored ? `${errMsg}（已自动恢复原版本并重新启用）` : errMsg,
              finishedAtMs: Date.now(),
              hotReloaded: false,
              restartRequired: false,
            })
            return
          }

          updateOp({
            status: 'installing',
            currentTarget: target.spec.id,
            message: `正在安装并热重载 ${target.spec.displayName} v${target.release.version}${preserveSuffix}…`,
          })

          let installRes = await pm.installBundle(target.release.tarballUrl, {
            enabled: target.wasEnabled,
            expected: {
              name: target.spec.packageName,
              version: target.release.version,
            },
          })

          if (
            (installRes.application === 'failed' || installRes.application === 'cancelled') &&
            isMissingTarballIntegrityError(installRes) &&
            lockfilePath &&
            existsSync(lockfilePath) &&
            !lockfileClearedForRetry
          ) {
            try {
              rmSync(lockfilePath, { force: true })
              lockfileClearedForRetry = true
            } catch {
              // Ignore unlink failure.
            }
            if (lockfileClearedForRetry) {
              installRes = await pm.installBundle(target.release.tarballUrl, {
                enabled: target.wasEnabled,
                expected: {
                  name: target.spec.packageName,
                  version: target.release.version,
                },
              })
            }
          }

          if (installRes.application === 'failed' || installRes.application === 'cancelled') {
            const missingIntegrity = isMissingTarballIntegrityError(installRes)
            const rawErrMsg = formatChangeError(
              installRes,
              `安装新版 ${target.spec.displayName} v${target.release.version} 失败`,
            )
            const errMsg = missingIntegrity ? formatMissingIntegrityHint(rawErrMsg) : rawErrMsg
            let rolledBack = false
            if (target.previousSpec) {
              updateOp({
                status: 'restoring',
                currentTarget: target.spec.id,
                message: `安装新版失败，正在回滚恢复 ${target.spec.displayName}…`,
              })
              if (installRes.stage === 'enable') {
                await pm.removeBundle(target.spec.packageName).catch(() => {})
              }
              let restoreRes = await pm
                .installBundle(target.previousSpec, { enabled: target.wasEnabled })
                .catch(() => undefined)
              if (
                (!restoreRes ||
                  restoreRes.application === 'failed' ||
                  restoreRes.application === 'cancelled') &&
                isMissingTarballIntegrityError(restoreRes) &&
                lockfilePath &&
                existsSync(lockfilePath)
              ) {
                try {
                  rmSync(lockfilePath, { force: true })
                  restoreRes = await pm
                    .installBundle(target.previousSpec, { enabled: target.wasEnabled })
                    .catch(() => undefined)
                } catch {
                  // Ignore unlink error.
                }
              }
              rolledBack = Boolean(
                restoreRes &&
                  restoreRes.application !== 'failed' &&
                  restoreRes.application !== 'cancelled',
              )
            }
            if (markedHotReloadSwap) {
              lifecycle.finishHotReloadSwap?.(operationId, { disposeDetached: !rolledBack })
              markedHotReloadSwap = false
            }
            if (drainedByUs) {
              await lifecycle.cancelDrain().catch(() => {})
              drainedByUs = false
            }
            updateItem(i, {
              status: rolledBack ? 'rolled_back' : 'failed',
              error: errMsg,
              rolledBack,
            })
            updateOp({
              status: rolledBack ? 'rolled_back' : 'failed',
              failureCode: 'install_failed',
              error: errMsg,
              message: rolledBack ? `${errMsg}（已自动回滚到原版本）` : errMsg,
              finishedAtMs: Date.now(),
              hotReloaded: false,
              restartRequired: false,
            })
            return
          }

          const hotReloaded = installRes.application === 'applied'
          const restartRequired = installRes.application === 'restart-required'
          if (target.spec.id === 'bridge' && markedHotReloadSwap && !hotReloaded) {
            lifecycle.finishHotReloadSwap?.(operationId, { disposeDetached: false })
            markedHotReloadSwap = false
          }
          if (restartRequired) anyRestartRequired = true
          if (!hotReloaded) allHotReloaded = false

          updateItem(i, {
            status: 'succeeded',
            hotReloaded,
            restartRequired,
            ...(installRes.restartReason ? { restartReason: installRes.restartReason } : {}),
          })
        }

        const summary = planned
          .map((p) => `${p.spec.displayName} v${p.release.version}`)
          .join('、')
        updateOp({
          status: 'succeeded',
          currentTarget: undefined,
          hotReloaded: allHotReloaded && !anyRestartRequired,
          restartRequired: anyRestartRequired,
          message: anyRestartRequired
            ? `已安装 ${summary}，但当前环境需要重启 DSH Web 后生效`
            : includesBridge && preservedTurns > 0
              ? `已无损热更新至 ${summary}（已自动续接 ${preservedTurns} 个后台运行中的会话）`
              : `已免重启热更新至 ${summary}`,
          finishedAtMs: Date.now(),
        })
        } catch (stage3Err) {
          if (markedHotReloadSwap) {
            lifecycle.finishHotReloadSwap?.(operationId, { disposeDetached: false })
            markedHotReloadSwap = false
          }
          throw stage3Err
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const failureCode: PluginUpdateFailureCode =
          err instanceof TaggedUpdateError ? err.failureCode : 'unknown'
        if (drainedByUs) {
          await lifecycle.cancelDrain().catch(() => {})
        }
        updateOp({
          status: 'failed',
          failureCode,
          error: message,
          message: `更新失败：${message}`,
          finishedAtMs: Date.now(),
          hotReloaded: false,
          restartRequired: false,
        })
      } finally {
        if (releaseClientModulesHold) {
          await releaseClientModulesHold().catch(() => {})
        }
      }
    }

    void runDetachedPipeline()
    return initialOp
  }
}

export function resetGlobalPluginUpdateStateForTest(): void {
  const state = getGlobalUpdateState()
  state.active = undefined
  state.last = undefined
  state.drainAbort = undefined
  state.drainForceRequested = false
  getGlobalEsmRelocatorState().staleDirToSymlink.clear()
}
