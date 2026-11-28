import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PluginUpdateService,
  classifySourceSpec,
  compareSemver,
  dispatchLarkApiRequest,
  findLockfileEntriesMissingTarballIntegrity,
  holdClientModulesDuringSwap,
  isMissingTarballIntegrityError,
  isNewerVersion,
  parseSha256Sums,
  patchLockfileTarballIntegrities,
  relocateStaleModuleUrl,
  resetGlobalPluginUpdateStateForTest,
  type FetchLike,
  type HostBundleInfoLike,
  type HostChangeResultLike,
  type HostPluginManagerLike,
  type PluginUpdateLifecycleHost,
} from '../src/index.js'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writeProfileFixtures(
  profileDir: string,
  deps: Record<string, string>,
  installedVersions: Record<string, string>,
): void {
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-web',
        private: true,
        dependencies: deps,
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', ...Object.keys(deps)] } },
      },
      null,
      2,
    ),
    'utf8',
  )
  for (const [pkg, version] of Object.entries(installedVersions)) {
    const pkgDir = join(profileDir, 'node_modules', ...pkg.split('/'))
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: pkg, version }), 'utf8')
  }
}

function makeFakeLifecycle(overrides: Partial<PluginUpdateLifecycleHost> = {}): PluginUpdateLifecycleHost {
  const baseStatus = {
    phase: 'running' as const,
    draining: false,
    drained: true,
    activeTurns: [],
    activeTriageCount: 0,
    activeRemindersCount: 0,
    activeDreamingCount: 0,
    totalInFlight: 0,
    persistedPendingTurns: 0,
    pid: process.pid,
    startedAtMs: Date.now(),
  }
  return {
    getLifecycleStatus: vi.fn(() => baseStatus),
    beginDrain: vi.fn(async () => ({ ...baseStatus, phase: 'draining', draining: true })),
    waitForDrain: vi.fn(async () => ({ ...baseStatus, phase: 'draining', draining: true, drained: true })),
    cancelDrain: vi.fn(async () => baseStatus),
    countActiveExternalAgents: vi.fn(() => 0),
    recordUpdateEvent: vi.fn(),
    ...overrides,
  }
}

function makeFakeContext(services: Record<string, unknown>) {
  return {
    get(key: string) {
      return services[key]
    },
  } as unknown as import('@deepseek-ai/cordis').Context
}

async function waitForSettledOp(
  service: PluginUpdateService,
  operationId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const op = service.getOperation(operationId)
    if (op && ['succeeded', 'failed', 'rolled_back'].includes(op.status)) {
      return op
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`Timed out waiting for operation ${operationId}`)
}

afterEach(() => {
  resetGlobalPluginUpdateStateForTest()
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('plugin-updater pure helpers', () => {
  it('compares semver versions including prereleases', () => {
    expect(compareSemver('0.4.0', '0.3.6')).toBeGreaterThan(0)
    expect(compareSemver('v0.4.0', '0.4.0')).toBe(0)
    expect(compareSemver('0.4.0-rc.10', '0.4.0-rc.9')).toBeGreaterThan(0)
    expect(compareSemver('0.4.0', '0.4.0-rc.10')).toBeGreaterThan(0)
    expect(compareSemver('0.3.5', '0.3.6')).toBeLessThan(0)
    expect(isNewerVersion('0.3.6', '0.4.0')).toBe(true)
    expect(isNewerVersion('0.4.0', '0.3.6')).toBe(false)
    expect(isNewerVersion('invalid', '0.4.0')).toBe(false)
  })

  it('classifies install specs accurately', () => {
    expect(
      classifySourceSpec(
        'https://github.com/harryzhz/dsh-lark-bridge/releases/download/v0.4.0/harryzhz-dsh-lark-bridge-0.4.0.tgz',
      ).kind,
    ).toBe('github-release')
    expect(
      classifySourceSpec(
        'https://github.com/harryzhz/dsh-lark-bridge/releases/latest/download/dsh-lark-bridge.tgz',
      ).kind,
    ).toBe('github-release')
    expect(classifySourceSpec('link:/Users/demo/dsh-lark-bridge').kind).toBe('local-link')
    expect(classifySourceSpec('file:/Users/demo/dsh-external-agents').kind).toBe('local-file')
    expect(classifySourceSpec('^0.4.0').kind).toBe('registry')
    expect(classifySourceSpec('github:harryzhz/dsh-lark-bridge').kind).toBe('git')
  })

  it('parses SHA256SUMS.txt lines', () => {
    const hashA = 'a'.repeat(64)
    const hashB = 'b'.repeat(64)
    const map = parseSha256Sums(`${hashA}  harryzhz-dsh-lark-bridge-0.4.0.tgz\n${hashB} *dsh-lark-bridge.tgz\n`)
    expect(map.get('harryzhz-dsh-lark-bridge-0.4.0.tgz')).toBe(hashA)
    expect(map.get('dsh-lark-bridge.tgz')).toBe(hashB)
  })
})

describe('PluginUpdateService release detection & restart-free hot update', () => {
  it('checks GitHub API with ETag and falls back to 302 redirect on rate limit', async () => {
    const profileDir = makeTempDir('dsh-prof-')
    const dataDir = makeTempDir('dsh-data-')
    writeProfileFixtures(
      profileDir,
      {
        '@harryzhz/dsh-lark-bridge':
          'https://github.com/harryzhz/dsh-lark-bridge/releases/download/v0.3.6/harryzhz-dsh-lark-bridge-0.3.6.tgz',
        '@harryzhz/dsh-external-agents':
          'https://github.com/harryzhz/dsh-external-agents/releases/download/v0.3.1/harryzhz-dsh-external-agents-0.3.1.tgz',
      },
      {
        '@harryzhz/dsh-lark-bridge': '0.3.6',
        '@harryzhz/dsh-external-agents': '0.3.1',
      },
    )

    const fetchImpl: FetchLike = async (url, init) => {
      if (url === 'https://api.github.com/repos/harryzhz/dsh-lark-bridge/releases/latest') {
        return new Response(
          JSON.stringify({
            tag_name: 'v0.4.0',
            published_at: '2026-11-25T12:00:00Z',
            html_url: 'https://github.com/harryzhz/dsh-lark-bridge/releases/tag/v0.4.0',
            body: '## Highlights\n- Added restart-free hot updates',
            assets: [
              {
                name: 'harryzhz-dsh-lark-bridge-0.4.0.tgz',
                browser_download_url:
                  'https://github.com/harryzhz/dsh-lark-bridge/releases/download/v0.4.0/harryzhz-dsh-lark-bridge-0.4.0.tgz',
                digest: `sha256:${'1'.repeat(64)}`,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json', etag: '"etag-1"' } },
        )
      }
      if (url === 'https://api.github.com/repos/harryzhz/dsh-external-agents/releases/latest') {
        return new Response('rate limited', { status: 403 })
      }
      if (url === 'https://github.com/harryzhz/dsh-external-agents/releases/latest' && init?.method === 'HEAD') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://github.com/harryzhz/dsh-external-agents/releases/tag/v0.4.0' },
        })
      }
      if (
        url ===
          'https://github.com/harryzhz/dsh-external-agents/releases/download/v0.4.0/harryzhz-dsh-external-agents-0.4.0.tgz' &&
        init?.method === 'HEAD'
      ) {
        return new Response(null, { status: 302 })
      }
      return new Response('not found', { status: 404 })
    }

    const pm: HostPluginManagerLike = {
      listBundles: vi.fn(async () => [
        {
          name: '@harryzhz/dsh-lark-bridge',
          version: '0.3.6',
          enabled: true,
          installed: true,
          removable: true,
        },
        {
          name: '@harryzhz/dsh-external-agents',
          version: '0.3.1',
          enabled: true,
          installed: true,
          removable: true,
        },
      ]),
      removeBundle: vi.fn(),
      installBundle: vi.fn(),
    }

    const service = new PluginUpdateService({
      ctx: makeFakeContext({
        profileContext: { name: 'web', dir: profileDir },
        pluginManager: pm,
        hmr: { runExclusive: vi.fn(), reconcileProfile: vi.fn() },
      }),
      dataDir,
      lifecycle: makeFakeLifecycle(),
      fetchImpl,
      runningBridgeVersion: '0.3.6',
    })

    const overview = await service.getOverview({ check: true, force: true })
    expect(overview.hotReloadSupported).toBe(true)
    expect(overview.updatableCount).toBe(2)

    const bridge = overview.plugins.find((p) => p.id === 'bridge')!
    const ext = overview.plugins.find((p) => p.id === 'external-agents')!
    expect(bridge.latest?.version).toBe('0.4.0')
    expect(bridge.latest?.source).toBe('github-api')
    expect(bridge.updateAvailable).toBe(true)
    expect(ext.latest?.version).toBe('0.4.0')
    expect(ext.latest?.source).toBe('github-redirect')
    expect(ext.updateAvailable).toBe(true)
  })

  it('rejects overwriting local link/file plugins unless allowMigrateLocal is set', async () => {
    const profileDir = makeTempDir('dsh-prof-')
    const dataDir = makeTempDir('dsh-data-')
    writeProfileFixtures(
      profileDir,
      {
        'dsh-lark-bridge': 'link:/Users/demo/dsh-lark-bridge',
      },
      { 'dsh-lark-bridge': '0.3.6' },
    )

    const pm: HostPluginManagerLike = {
      listBundles: vi.fn(async () => [
        { name: 'dsh-lark-bridge', version: '0.3.6', enabled: true, installed: true, removable: true },
      ]),
      removeBundle: vi.fn(),
      installBundle: vi.fn(),
    }

    const service = new PluginUpdateService({
      ctx: makeFakeContext({
        profileContext: { name: 'web', dir: profileDir },
        pluginManager: pm,
        hmr: { runExclusive: vi.fn(), reconcileProfile: vi.fn() },
      }),
      dataDir,
      lifecycle: makeFakeLifecycle(),
      runningBridgeVersion: '0.3.6',
    })

    await expect(service.startUpdate({ target: 'bridge' })).rejects.toThrow(/本地开发链接/)
  })

  it('verifies SHA256, updates external-agents before bridge, and persists final hot-reloaded state', async () => {
    const profileDir = makeTempDir('dsh-prof-')
    const dataDir = makeTempDir('dsh-data-')
    const bridgeTarballBytes = Buffer.from('fake-bridge-tgz-v0.4.0')
    const extTarballBytes = Buffer.from('fake-ext-tgz-v0.4.0')
    const bridgeSha = createHash('sha256').update(bridgeTarballBytes).digest('hex')
    const extSha = createHash('sha256').update(extTarballBytes).digest('hex')

    writeProfileFixtures(
      profileDir,
      {
        '@harryzhz/dsh-lark-bridge':
          'https://github.com/harryzhz/dsh-lark-bridge/releases/download/v0.3.6/harryzhz-dsh-lark-bridge-0.3.6.tgz',
        '@harryzhz/dsh-external-agents':
          'https://github.com/harryzhz/dsh-external-agents/releases/download/v0.3.1/harryzhz-dsh-external-agents-0.3.1.tgz',
      },
      {
        '@harryzhz/dsh-lark-bridge': '0.3.6',
        '@harryzhz/dsh-external-agents': '0.3.1',
      },
    )

    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith('/harryzhz/dsh-lark-bridge/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v0.4.0',
            assets: [
              {
                name: 'harryzhz-dsh-lark-bridge-0.4.0.tgz',
                browser_download_url:
                  'https://github.com/harryzhz/dsh-lark-bridge/releases/download/v0.4.0/harryzhz-dsh-lark-bridge-0.4.0.tgz',
                digest: `sha256:${bridgeSha}`,
              },
            ],
          }),
          { status: 200 },
        )
      }
      if (url.endsWith('/harryzhz/dsh-external-agents/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v0.4.0',
            assets: [
              {
                name: 'harryzhz-dsh-external-agents-0.4.0.tgz',
                browser_download_url:
                  'https://github.com/harryzhz/dsh-external-agents/releases/download/v0.4.0/harryzhz-dsh-external-agents-0.4.0.tgz',
                digest: `sha256:${extSha}`,
              },
            ],
          }),
          { status: 200 },
        )
      }
      if (url.endsWith('harryzhz-dsh-lark-bridge-0.4.0.tgz')) {
        return new Response(bridgeTarballBytes, { status: 200 })
      }
      if (url.endsWith('harryzhz-dsh-external-agents-0.4.0.tgz')) {
        return new Response(extTarballBytes, { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }

    const callOrder: string[] = []
    const pm: HostPluginManagerLike = {
      listBundles: vi.fn(async (): Promise<HostBundleInfoLike[]> => [
        { name: '@harryzhz/dsh-lark-bridge', version: '0.3.6', enabled: true, installed: true, removable: true },
        { name: '@harryzhz/dsh-external-agents', version: '0.3.1', enabled: true, installed: true, removable: true },
      ]),
      removeBundle: vi.fn(async (name): Promise<HostChangeResultLike> => {
        callOrder.push(`remove:${name}`)
        return { changed: true, application: 'applied', stage: 'remove' }
      }),
      installBundle: vi.fn(async (spec, opts): Promise<HostChangeResultLike> => {
        callOrder.push(`install:${opts?.expected?.name ?? spec}@${opts?.expected?.version ?? ''}`)
        return { changed: true, application: 'applied', stage: 'enable', bundle: opts?.expected?.name }
      }),
    }

    const service = new PluginUpdateService({
      ctx: makeFakeContext({
        profileContext: { name: 'web', dir: profileDir },
        pluginManager: pm,
        hmr: { runExclusive: vi.fn(), reconcileProfile: vi.fn() },
      }),
      dataDir,
      lifecycle: makeFakeLifecycle(),
      fetchImpl,
      runningBridgeVersion: '0.3.6',
    })

    const op = await service.startUpdate({ target: 'all' })
    const settled = await waitForSettledOp(service, op.operationId)

    expect(settled.status).toBe('succeeded')
    expect(settled.hotReloaded).toBe(true)
    expect(settled.restartRequired).toBe(false)
    expect(callOrder).toEqual([
      'remove:@harryzhz/dsh-external-agents',
      'install:@harryzhz/dsh-external-agents@0.4.0',
      'remove:@harryzhz/dsh-lark-bridge',
      'install:@harryzhz/dsh-lark-bridge@0.4.0',
    ])

    const persisted = JSON.parse(readFileSync(join(dataDir, 'plugin-update-status.json'), 'utf8'))
    expect(persisted.operationId).toBe(op.operationId)
    expect(persisted.status).toBe('succeeded')
  })

  it('aborts before removing old bundle when SHA256 mismatches', async () => {
    const profileDir = makeTempDir('dsh-prof-')
    const dataDir = makeTempDir('dsh-data-')
    writeProfileFixtures(
      profileDir,
      {
        '@harryzhz/dsh-lark-bridge':
          'https://github.com/harryzhz/dsh-lark-bridge/releases/download/v0.3.6/harryzhz-dsh-lark-bridge-0.3.6.tgz',
      },
      { '@harryzhz/dsh-lark-bridge': '0.3.6' },
    )

    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith('/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v0.4.0',
            assets: [
              {
                name: 'harryzhz-dsh-lark-bridge-0.4.0.tgz',
                browser_download_url:
                  'https://github.com/harryzhz/dsh-lark-bridge/releases/download/v0.4.0/harryzhz-dsh-lark-bridge-0.4.0.tgz',
                digest: `sha256:${'f'.repeat(64)}`,
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response(Buffer.from('corrupted-tarball'), { status: 200 })
    }

    const pm: HostPluginManagerLike = {
      listBundles: vi.fn(async () => [
        { name: '@harryzhz/dsh-lark-bridge', version: '0.3.6', enabled: true, installed: true, removable: true },
      ]),
      removeBundle: vi.fn(),
      installBundle: vi.fn(),
    }

    const service = new PluginUpdateService({
      ctx: makeFakeContext({
        profileContext: { name: 'web', dir: profileDir },
        pluginManager: pm,
        hmr: { runExclusive: vi.fn(), reconcileProfile: vi.fn() },
      }),
      dataDir,
      lifecycle: makeFakeLifecycle(),
      fetchImpl,
      runningBridgeVersion: '0.3.6',
    })

    const op = await service.startUpdate({ target: 'bridge' })
    const settled = await waitForSettledOp(service, op.operationId)
    expect(settled.status).toBe('failed')
    expect(settled.error).toMatch(/SHA256/)
    expect(pm.removeBundle).not.toHaveBeenCalled()
    expect(pm.installBundle).not.toHaveBeenCalled()
  })

  it('automatically rolls back to previous release spec when new install fails', async () => {
    const profileDir = makeTempDir('dsh-prof-')
    const dataDir = makeTempDir('dsh-data-')
    const prevSpec =
      'https://github.com/harryzhz/dsh-lark-bridge/releases/download/v0.3.6/harryzhz-dsh-lark-bridge-0.3.6.tgz'
    const payload = Buffer.from('valid-bytes')
    const sha = createHash('sha256').update(payload).digest('hex')

    writeProfileFixtures(
      profileDir,
      { '@harryzhz/dsh-lark-bridge': prevSpec },
      { '@harryzhz/dsh-lark-bridge': '0.3.6' },
    )

    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith('/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v0.4.0',
            assets: [
              {
                name: 'harryzhz-dsh-lark-bridge-0.4.0.tgz',
                browser_download_url:
                  'https://github.com/harryzhz/dsh-lark-bridge/releases/download/v0.4.0/harryzhz-dsh-lark-bridge-0.4.0.tgz',
                digest: `sha256:${sha}`,
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response(payload, { status: 200 })
    }

    const installedSpecs: string[] = []
    const pm: HostPluginManagerLike = {
      listBundles: vi.fn(async () => [
        { name: '@harryzhz/dsh-lark-bridge', version: '0.3.6', enabled: true, installed: true, removable: true },
      ]),
      removeBundle: vi.fn(async () => ({ changed: true, application: 'applied', stage: 'remove' })),
      installBundle: vi.fn(async (spec) => {
        installedSpecs.push(spec)
        if (spec.includes('0.4.0')) {
          return {
            changed: false,
            application: 'failed',
            stage: 'install',
            error: { code: 'operation-error', diagnostic: 'simulated pnpm failure' },
          }
        }
        return { changed: true, application: 'applied', stage: 'enable' }
      }),
    }

    const service = new PluginUpdateService({
      ctx: makeFakeContext({
        profileContext: { name: 'web', dir: profileDir },
        pluginManager: pm,
        hmr: { runExclusive: vi.fn(), reconcileProfile: vi.fn() },
      }),
      dataDir,
      lifecycle: makeFakeLifecycle(),
      fetchImpl,
      runningBridgeVersion: '0.3.6',
    })

    const op = await service.startUpdate({ target: 'bridge' })
    const settled = await waitForSettledOp(service, op.operationId)
    expect(settled.status).toBe('rolled_back')
    expect(installedSpecs).toEqual([
      'https://github.com/harryzhz/dsh-lark-bridge/releases/download/v0.4.0/harryzhz-dsh-lark-bridge-0.4.0.tgz',
      prevSpec,
    ])
  })

  it('enforces fail-closed auth on POST /plugins/update (blocks CLI token, allows owner & operator)', async () => {
    const startUpdate = vi.fn(async () => ({
      operationId: 'upd_test',
      status: 'verifying',
      message: 'checking',
      startedAtMs: 1,
      updatedAtMs: 1,
      items: [],
      hotReloaded: false,
      restartRequired: false,
    }))
    const getOverview = vi.fn(async () => ({
      ok: true,
      hmrAvailable: true,
      pluginManagerAvailable: true,
      hotReloadSupported: true,
      updatableCount: 0,
      plugins: [],
    }))
    const fakeManager = {
      pluginUpdater: { getOverview, startUpdate, getOperation: vi.fn(() => undefined) },
    } as unknown as import('../src/index.js').LarkBridgeManager
    const fakeCtx = makeFakeContext({})

    const cliRead = await dispatchLarkApiRequest(fakeCtx, fakeManager, {
      method: 'GET',
      path: '/plugins/updates',
      isCliAuthenticated: true,
      principalKind: 'cli',
    })
    expect(cliRead.status).toBe(200)

    const cliWrite = await dispatchLarkApiRequest(fakeCtx, fakeManager, {
      method: 'POST',
      path: '/plugins/update',
      body: { target: 'all' },
      isCliAuthenticated: true,
      principalKind: 'cli',
    })
    expect(cliWrite.status).toBe(403)
    expect(startUpdate).not.toHaveBeenCalled()

    const operatorWrite = await dispatchLarkApiRequest(fakeCtx, fakeManager, {
      method: 'POST',
      path: '/plugins/update',
      body: { target: 'bridge' },
      isCliAuthenticated: false,
      isOperatorAuthenticated: true,
      principalKind: 'operator',
    })
    expect(operatorWrite.status).toBe(202)
    expect(startUpdate).toHaveBeenCalledTimes(1)

    const ownerWrite = await dispatchLarkApiRequest(fakeCtx, fakeManager, {
      method: 'POST',
      path: '/plugins/update',
      body: { target: 'external-agents' },
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(ownerWrite.status).toBe(202)
    expect(startUpdate).toHaveBeenCalledTimes(2)
  })

  it('relocates stale symlinked pnpm module URLs to live targets across consecutive updates', () => {
    const root = makeTempDir('dsh-reloc-')
    const v1 = join(root, '.pnpm', 'pkg@0.4.0', 'pkg')
    const v2 = join(root, '.pnpm', 'pkg@0.4.1', 'pkg')
    const v3 = join(root, '.pnpm', 'pkg@0.4.2', 'pkg')
    for (const dir of [v1, v2, v3]) {
      mkdirSync(join(dir, 'dist'), { recursive: true })
      writeFileSync(join(dir, 'dist', 'index.js'), 'export default {}', 'utf8')
    }
    const nm = join(root, 'node_modules')
    mkdirSync(nm, { recursive: true })
    const symlinkPath = join(nm, 'pkg')
    symlinkSync(v1, symlinkPath)

    const staleMap = new Map<string, string>()
    const realV1 = realpathSync(symlinkPath) + sep
    staleMap.set(realV1, symlinkPath)

    // Unchanged symlink -> no relocation
    const v1Url = pathToFileURL(join(realpathSync(v1), 'dist', 'index.js')).href
    expect(relocateStaleModuleUrl(v1Url, undefined, staleMap)).toBeUndefined()

    // Swap v1 -> v2
    unlinkSync(symlinkPath)
    symlinkSync(v2, symlinkPath)
    const realV2 = realpathSync(symlinkPath) + sep
    expect(relocateStaleModuleUrl(v1Url, undefined, staleMap)).toBe(
      pathToFileURL(join(realpathSync(v2), 'dist', 'index.js')).href,
    )

    // Internal relative import from inside old dir stays untouched
    const internalParent = pathToFileURL(join(realpathSync(v1), 'dist', 'chunk.js')).href
    expect(relocateStaleModuleUrl(v1Url, internalParent, staleMap)).toBeUndefined()

    // Consecutive swap v2 -> v3: both v1 and v2 stale URLs relocate to v3
    staleMap.set(realV2, symlinkPath)
    unlinkSync(symlinkPath)
    symlinkSync(v3, symlinkPath)
    const expectedV3 = pathToFileURL(join(realpathSync(v3), 'dist', 'index.js')).href
    expect(relocateStaleModuleUrl(v1Url, undefined, staleMap)).toBe(expectedV3)
    const v2Url = pathToFileURL(join(realpathSync(v2), 'dist', 'index.js')).href
    expect(relocateStaleModuleUrl(v2Url, undefined, staleMap)).toBe(expectedV3)

    // Temporarily missing symlink during removeBundle -> no throw, returns undefined
    unlinkSync(symlinkPath)
    expect(relocateStaleModuleUrl(v1Url, undefined, staleMap)).toBeUndefined()
  })

  it('updates bridge seamlessly without draining in-flight Feishu turns, while draining external-agents with force & mid-drain preemption', async () => {
    const profileDir = makeTempDir('dsh-prof-')
    const dataDir = makeTempDir('dsh-data-')
    const tarballBytes = Buffer.from('fake-bridge-tgz-v0.4.4')
    const sha = createHash('sha256').update(tarballBytes).digest('hex')

    writeProfileFixtures(
      profileDir,
      {
        '@harryzhz/dsh-lark-bridge':
          'https://github.com/harryzhz/dsh-lark-bridge/releases/download/v0.4.3/harryzhz-dsh-lark-bridge-0.4.3.tgz',
        '@harryzhz/dsh-external-agents':
          'https://github.com/harryzhz/dsh-external-agents/releases/download/v0.4.1/harryzhz-dsh-external-agents-0.4.1.tgz',
      },
      {
        '@harryzhz/dsh-lark-bridge': '0.4.3',
        '@harryzhz/dsh-external-agents': '0.4.1',
      },
    )

    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith('/harryzhz/dsh-lark-bridge/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v0.4.4',
            assets: [
              {
                name: 'harryzhz-dsh-lark-bridge-0.4.4.tgz',
                browser_download_url:
                  'https://github.com/harryzhz/dsh-lark-bridge/releases/download/v0.4.4/harryzhz-dsh-lark-bridge-0.4.4.tgz',
                digest: `sha256:${sha}`,
              },
            ],
          }),
          { status: 200 },
        )
      }
      if (url.endsWith('/harryzhz/dsh-external-agents/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v0.4.2',
            assets: [
              {
                name: 'harryzhz-dsh-external-agents-0.4.2.tgz',
                browser_download_url:
                  'https://github.com/harryzhz/dsh-external-agents/releases/download/v0.4.2/harryzhz-dsh-external-agents-0.4.2.tgz',
                digest: `sha256:${sha}`,
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response(tarballBytes, { status: 200 })
    }

    const removed: string[] = []
    const pm: HostPluginManagerLike = {
      listBundles: vi.fn(async (): Promise<HostBundleInfoLike[]> => [
        { name: '@harryzhz/dsh-lark-bridge', version: '0.4.3', enabled: true, installed: true, removable: true },
        { name: '@harryzhz/dsh-external-agents', version: '0.4.1', enabled: true, installed: true, removable: true },
      ]),
      removeBundle: vi.fn(async (name): Promise<HostChangeResultLike> => {
        removed.push(name)
        return { changed: true, application: 'applied', stage: 'remove' }
      }),
      installBundle: vi.fn(async (): Promise<HostChangeResultLike> => ({
        changed: true,
        application: 'applied',
        stage: 'enable',
      })),
    }

    const busyStatus = {
      phase: 'running' as const,
      draining: false,
      drained: false,
      activeTurns: [
        {
          id: 'turn-live-1',
          botId: 'bot-a',
          chatId: 'oc_demo',
          messageId: 'om_demo_1',
          routeKey: 'cli_a:oc_demo:om_demo_1',
          sessionId: 'session-live-1',
          trigger: 'mention',
          startedAtMs: Date.now() - 5_000,
          lastActivityAtMs: Date.now(),
          idleSec: 0,
          willAutoResume: true,
        },
      ],
      activeTriageCount: 0,
      activeRemindersCount: 0,
      activeDreamingCount: 0,
      totalInFlight: 1,
      persistedPendingTurns: 1,
      pid: process.pid,
      startedAtMs: Date.now(),
    }

    const waitForDrain = vi.fn(async () => ({ ...busyStatus, draining: true, drained: false }))
    const prepareHotReloadSwap = vi.fn()
    const finishHotReloadSwap = vi.fn()

    let activeExternalAgents = 1
    const lifecycle: PluginUpdateLifecycleHost = {
      getLifecycleStatus: vi.fn(() => busyStatus),
      beginDrain: vi.fn(async () => ({ ...busyStatus, draining: true })),
      waitForDrain,
      cancelDrain: vi.fn(async () => busyStatus),
      prepareHotReloadSwap,
      finishHotReloadSwap,
      countActiveExternalAgents: vi.fn(() => activeExternalAgents),
    }

    const service = new PluginUpdateService({
      ctx: makeFakeContext({
        profileContext: { name: 'web', dir: profileDir },
        pluginManager: pm,
        hmr: { runExclusive: vi.fn(), reconcileProfile: vi.fn() },
      }),
      dataDir,
      lifecycle,
      fetchImpl,
      runningBridgeVersion: '0.4.3',
    })

    // 1. Overview reports active workload counts & bridgeSeamlessReload=true
    const overview = await service.getOverview({ check: true })
    expect(overview.inFlightTurns).toBe(1)
    expect(overview.activeExternalAgents).toBe(1)
    expect(overview.bridgeSeamlessReload).toBe(true)

    // 2. Updating ONLY bridge succeeds immediately without waiting for drain and preserves the live turn
    const opBridge = await service.startUpdate({ target: 'bridge', drainTimeoutMs: 50 })
    const settledBridge = await waitForSettledOp(service, opBridge.operationId)
    expect(settledBridge.status).toBe('succeeded')
    expect(settledBridge.seamlessBridgeSwap).toBe(true)
    expect(settledBridge.preservedTurns).toBe(1)
    expect(settledBridge.message).toContain('无损热更新')
    expect(settledBridge.message).toContain('1 个后台运行中的会话')
    expect(waitForDrain).not.toHaveBeenCalled()
    expect(prepareHotReloadSwap).toHaveBeenCalledWith(opBridge.operationId)
    expect(removed).toEqual(['@harryzhz/dsh-lark-bridge'])

    // 3. Updating target='all' (including external-agents) while external agent is busy hits drain_timeout
    removed.length = 0
    const op1 = await service.startUpdate({ target: 'all', drainTimeoutMs: 80 })
    const settled1 = await waitForSettledOp(service, op1.operationId)
    expect(settled1.status).toBe('failed')
    expect(settled1.failureCode).toBe('drain_timeout')
    expect(settled1.targetSelector).toBe('all')
    expect(removed).toEqual([])

    // 4. Force update with target='all' bypasses external drain wait completely
    const op2 = await service.startUpdate({ target: 'all', force: true })
    const settled2 = await waitForSettledOp(service, op2.operationId)
    expect(settled2.status).toBe('succeeded')
    expect(settled2.forced).toBe(true)
    expect(removed).toEqual(['@harryzhz/dsh-external-agents', '@harryzhz/dsh-lark-bridge'])

    // 5. Mid-drain force preemption via POST /plugins/update/force wakes external-agents drain and succeeds
    removed.length = 0
    const op3 = await service.startUpdate({ target: 'external-agents', drainTimeoutMs: 10_000 })
    const waitDrainingDeadline = Date.now() + 3000
    while (Date.now() < waitDrainingDeadline) {
      if (service.getOperation(op3.operationId)?.status === 'draining') break
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(service.getOperation(op3.operationId)?.status).toBe('draining')

    const fakeManager = {
      pluginUpdater: service,
    } as unknown as import('../src/index.js').LarkBridgeManager
    const fakeCtx = makeFakeContext({})
    // CLI token is blocked (403)
    const cliPreempt = await dispatchLarkApiRequest(fakeCtx, fakeManager, {
      method: 'POST',
      path: '/plugins/update/force',
      body: { operationId: op3.operationId },
      isCliAuthenticated: true,
      principalKind: 'cli',
    })
    expect(cliPreempt.status).toBe(403)

    // Owner session preempts drain immediately (200)
    const ownerPreempt = await dispatchLarkApiRequest(fakeCtx, fakeManager, {
      method: 'POST',
      path: '/plugins/update/force',
      body: { operationId: op3.operationId },
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(ownerPreempt.status).toBe(200)
    expect((ownerPreempt.payload as { forced?: boolean }).forced).toBe(true)

    const settled3 = await waitForSettledOp(service, op3.operationId)
    expect(settled3.status).toBe('succeeded')
    expect(settled3.forced).toBe(true)
    expect(removed).toEqual(['@harryzhz/dsh-external-agents'])

    // 6. When activeExternalAgents === 0, updating target='all' even with active Feishu turns succeeds without draining
    removed.length = 0
    activeExternalAgents = 0
    const op4 = await service.startUpdate({ target: 'all', drainTimeoutMs: 50 })
    const settled4 = await waitForSettledOp(service, op4.operationId)
    expect(settled4.status).toBe('succeeded')
    expect(settled4.seamlessBridgeSwap).toBe(true)
    expect(settled4.preservedTurns).toBe(1)
    expect(removed).toEqual(['@harryzhz/dsh-external-agents', '@harryzhz/dsh-lark-bridge'])
  })

  it('holds intermediate client-module deletion during bridge self-swap and converges cleanly on release', async () => {
    const sources = new Map<string, { packageName: string }>()
    const table = new Map<string, string>()
    const dirty = new Set<string>()
    const reconcileCalls: string[] = []
    const flushMock = vi.fn()

    class FakeClientModules {
      sources = sources
      dirty = dirty
      reconcilePackage(packageName: string): boolean {
        reconcileCalls.push(packageName)
        let hasSource = false
        for (const s of this.sources.values()) {
          if (s.packageName === packageName) hasSource = true
        }
        if (!hasSource) return table.delete(packageName)
        table.set(packageName, 'updated')
        return true
      }
      flush = flushMock
    }

    const cm = new FakeClientModules()
    sources.set('base\0@harryzhz/dsh-lark-bridge', { packageName: '@harryzhz/dsh-lark-bridge' })
    table.set('@harryzhz/dsh-lark-bridge', 'v0.4.3')

    const ctx = makeFakeContext({ clientModules: cm })
    const release = holdClientModulesDuringSwap(ctx, ['@harryzhz/dsh-lark-bridge'])

    // 1. Simulate removeBundle disposing bridge: source disappears, but hold keeps table intact & returns false
    sources.clear()
    expect(cm.reconcilePackage('@harryzhz/dsh-lark-bridge')).toBe(false)
    expect(table.get('@harryzhz/dsh-lark-bridge')).toBe('v0.4.3')
    expect(reconcileCalls).toEqual([])

    // 2. Simulate installBundle activating new bridge: source reappears -> delegates immediately to publish new rev
    sources.set('base\0@harryzhz/dsh-lark-bridge', { packageName: '@harryzhz/dsh-lark-bridge' })
    expect(cm.reconcilePackage('@harryzhz/dsh-lark-bridge')).toBe(true)
    expect(table.get('@harryzhz/dsh-lark-bridge')).toBe('updated')
    expect(reconcileCalls).toEqual(['@harryzhz/dsh-lark-bridge'])

    // 3. Release restores prototype cleanly and does NOT force redundant flush when active source exists
    await release()
    expect(flushMock).not.toHaveBeenCalled()

    // 4. Failure path: if release runs while package is genuinely missing, converges via flush()
    const releaseFail = holdClientModulesDuringSwap(ctx, ['@harryzhz/dsh-lark-bridge'])
    sources.clear()
    expect(cm.reconcilePackage('@harryzhz/dsh-lark-bridge')).toBe(false)
    await releaseFail()
    expect(dirty.has('@harryzhz/dsh-lark-bridge')).toBe(true)
    expect(flushMock).toHaveBeenCalledTimes(1)
  })

  it('detects and patches missing remote tarball integrity entries in pnpm-lock.yaml (inline and multi-line)', () => {
    const urlA =
      'https://github.com/harryzhz/dsh-external-agents/releases/download/v0.4.6/harryzhz-dsh-external-agents-0.4.6.tgz'
    const urlB =
      'https://github.com/harryzhz/dsh-lark-bridge/releases/download/v0.4.31/harryzhz-dsh-lark-bridge-0.4.31.tgz'
    const urlC =
      'https://github.com/harryzhz/dsh-lark-bridge/releases/download/v0.4.35/harryzhz-dsh-lark-bridge-0.4.35.tgz'
    const sample = [
      "lockfileVersion: '9.0'",
      'packages:',
      `  '@harryzhz/dsh-external-agents@${urlA}':`,
      `    resolution: {tarball: ${urlA}}`,
      '    version: 0.4.6',
      `  '@harryzhz/dsh-lark-bridge@${urlB}':`,
      '    resolution:',
      `      tarball: '${urlB}'`,
      '    version: 0.4.31',
      `  '@harryzhz/dsh-lark-bridge@${urlC}':`,
      `    resolution: {integrity: sha512-alreadyValid==, tarball: ${urlC}}`,
      '    version: 0.4.35',
    ].join('\n')

    expect(findLockfileEntriesMissingTarballIntegrity(sample)).toEqual([urlA, urlB])

    const patched = patchLockfileTarballIntegrities(
      sample,
      new Map([
        [urlA, 'sha512-hashA=='],
        [urlB, 'sha512-hashB=='],
        [urlC, 'sha512-shouldNotOverwrite=='],
      ]),
    )
    expect(patched.patchedCount).toBe(2)
    expect(patched.content).toContain(`    resolution: {integrity: sha512-hashA==, tarball: ${urlA}}`)
    expect(patched.content).toContain(`    resolution:\n      integrity: sha512-hashB==\n      tarball: '${urlB}'`)
    expect(patched.content).toContain(`integrity: sha512-alreadyValid==, tarball: ${urlC}`)
    expect(findLockfileEntriesMissingTarballIntegrity(patched.content)).toEqual([])

    expect(
      isMissingTarballIntegrityError({
        application: 'failed',
        error: {
          code: 'operation-error',
          diagnostic:
            'ERR_PNPM_MISSING_TARBALL_INTEGRITY Cannot install package "@harryzhz/dsh-external-agents@...": its lockfile entry has no "integrity" field, so pnpm cannot verify the downloaded tarball.',
        },
      }),
    ).toBe(true)
    expect(
      isMissingTarballIntegrityError({
        application: 'failed',
        packageResult: {
          exitCode: 1,
          output:
            '[ERR_PNPM_MISSING_TARBALL_INTEGRITY] 1 lockfile entry failed verification:\n  @demo/pkg@1.0.0 has no "integrity" field, so its downloaded tarball cannot be verified',
        },
      }),
    ).toBe(true)
    expect(
      isMissingTarballIntegrityError({
        application: 'failed',
        error: { code: 'operation-error', diagnostic: 'ECONNRESET network error' },
      }),
    ).toBe(false)
  })

  it('pre-flight repairs missing tarball integrity in pnpm-lock.yaml with SHA256 verification and ignores undeclared URLs', async () => {
    const profileDir = makeTempDir('dsh-prof-')
    const dataDir = makeTempDir('dsh-data-')
    const extUrl =
      'https://github.com/harryzhz/dsh-external-agents/releases/download/v0.4.6/harryzhz-dsh-external-agents-0.4.6.tgz'
    const undeclaredUrl =
      'https://example.com/untrusted-injected-package-1.0.0.tgz'
    const extBytes = Buffer.from('verified-external-agents-v0.4.6-tarball')
    const extSha256 = createHash('sha256').update(extBytes).digest('hex')
    const extSha512 = `sha512-${createHash('sha512').update(extBytes).digest('base64')}`

    writeProfileFixtures(
      profileDir,
      {
        '@harryzhz/dsh-external-agents': extUrl,
      },
      {
        '@harryzhz/dsh-external-agents': '0.4.6',
      },
    )
    writeFileSync(
      join(profileDir, 'pnpm-lock.yaml'),
      [
        "lockfileVersion: '9.0'",
        'packages:',
        `  '@harryzhz/dsh-external-agents@${extUrl}':`,
        `    resolution: {tarball: ${extUrl}}`,
        '    version: 0.4.6',
        `  'evil@${undeclaredUrl}':`,
        `    resolution: {tarball: ${undeclaredUrl}}`,
      ].join('\n'),
      'utf8',
    )

    const fetchedUrls: string[] = []
    const fetchImpl: FetchLike = async (url) => {
      fetchedUrls.push(url)
      if (url.endsWith('/SHA256SUMS.txt')) {
        return new Response(`${extSha256}  harryzhz-dsh-external-agents-0.4.6.tgz\n`, { status: 200 })
      }
      if (url === extUrl) {
        return new Response(extBytes, { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }

    const service = new PluginUpdateService({
      ctx: makeFakeContext({ profileContext: { name: 'web', dir: profileDir } }),
      dataDir,
      lifecycle: makeFakeLifecycle(),
      fetchImpl,
    })

    const res = await service.repairProfileLockfileIntegrity(profileDir)
    expect(res).toEqual({ repairedCount: 1, remainingMissing: 1 })
    expect(fetchedUrls).not.toContain(undeclaredUrl)

    const updatedLock = readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8')
    expect(updatedLock).toContain(`resolution: {integrity: ${extSha512}, tarball: ${extUrl}}`)
    expect(updatedLock).toContain(`resolution: {tarball: ${undeclaredUrl}}`)
  })

  it('re-enables bundle and restores lockfile backup when removeBundle fails mid-swap (never leaves bridge disabled at 404)', async () => {
    const profileDir = makeTempDir('dsh-prof-')
    const dataDir = makeTempDir('dsh-data-')
    const prevSpec =
      'https://github.com/harryzhz/dsh-lark-bridge/releases/download/v0.4.31/harryzhz-dsh-lark-bridge-0.4.31.tgz'
    const newUrl =
      'https://github.com/harryzhz/dsh-lark-bridge/releases/download/v0.4.35/harryzhz-dsh-lark-bridge-0.4.35.tgz'
    const payload = Buffer.from('valid-bridge-0.4.35-bytes')
    const sha = createHash('sha256').update(payload).digest('hex')

    writeProfileFixtures(
      profileDir,
      { '@harryzhz/dsh-lark-bridge': prevSpec },
      { '@harryzhz/dsh-lark-bridge': '0.4.31' },
    )
    const originalLock = [
      "lockfileVersion: '9.0'",
      'packages:',
      `  '@harryzhz/dsh-lark-bridge@${prevSpec}':`,
      `    resolution: {integrity: sha512-validPrev==, tarball: ${prevSpec}}`,
    ].join('\n')
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), originalLock, 'utf8')

    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith('/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v0.4.35',
            assets: [
              {
                name: 'harryzhz-dsh-lark-bridge-0.4.35.tgz',
                browser_download_url: newUrl,
                digest: `sha256:${sha}`,
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response(payload, { status: 200 })
    }

    const setBundleEnabled = vi.fn(async (): Promise<HostChangeResultLike> => ({
      changed: true,
      application: 'applied',
      stage: 'enable',
    }))
    const removeBundle = vi.fn(async (): Promise<HostChangeResultLike> => {
      // Simulate DSH `removeBundle` corrupting pnpm-lock.yaml & deselecting bundle before pnpm fails
      writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'corrupted-by-failed-pnpm-remove', 'utf8')
      return {
        changed: true,
        application: 'failed',
        stage: 'remove',
        error: {
          code: 'operation-error',
          diagnostic:
            'ERR_PNPM_MISSING_TARBALL_INTEGRITY Cannot install package "@harryzhz/dsh-external-agents": its lockfile entry has no "integrity" field',
        },
      }
    })
    const pm: HostPluginManagerLike = {
      listBundles: vi.fn(async () => [
        { name: '@harryzhz/dsh-lark-bridge', version: '0.4.31', enabled: true, installed: true, removable: true },
      ]),
      removeBundle,
      installBundle: vi.fn(),
      setBundleEnabled,
    }

    const prepareHotReloadSwap = vi.fn()
    const finishHotReloadSwap = vi.fn()
    const lifecycle = makeFakeLifecycle({ prepareHotReloadSwap, finishHotReloadSwap })

    const service = new PluginUpdateService({
      ctx: makeFakeContext({
        profileContext: { name: 'web', dir: profileDir },
        pluginManager: pm,
        hmr: { runExclusive: vi.fn(), reconcileProfile: vi.fn() },
      }),
      dataDir,
      lifecycle,
      fetchImpl,
      runningBridgeVersion: '0.4.31',
    })

    const op = await service.startUpdate({ target: 'bridge' })
    const settled = await waitForSettledOp(service, op.operationId)

    // Tried removeBundle twice (initial + once after clearing lockfile), then rolled back via setBundleEnabled
    expect(removeBundle).toHaveBeenCalledTimes(2)
    expect(setBundleEnabled).toHaveBeenCalledWith('@harryzhz/dsh-lark-bridge', true)
    expect(pm.installBundle).not.toHaveBeenCalled()
    expect(finishHotReloadSwap).toHaveBeenCalledWith(op.operationId, { disposeDetached: false })
    expect(readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8')).toBe(originalLock)
    expect(settled.status).toBe('rolled_back')
    expect(settled.message).toContain('已自动恢复原版本并重新启用')
    expect(settled.error).toContain('升级 pnpm 至 11.x')
  })

  it('recovers automatically by clearing stale pnpm-lock.yaml on ERR_PNPM_MISSING_TARBALL_INTEGRITY during remove/install', async () => {
    const profileDir = makeTempDir('dsh-prof-')
    const dataDir = makeTempDir('dsh-data-')
    const prevSpec =
      'https://github.com/harryzhz/dsh-lark-bridge/releases/download/v0.4.31/harryzhz-dsh-lark-bridge-0.4.31.tgz'
    const newUrl =
      'https://github.com/harryzhz/dsh-lark-bridge/releases/download/v0.4.35/harryzhz-dsh-lark-bridge-0.4.35.tgz'
    const payload = Buffer.from('valid-bridge-0.4.35-bytes')
    const sha = createHash('sha256').update(payload).digest('hex')

    writeProfileFixtures(
      profileDir,
      { '@harryzhz/dsh-lark-bridge': prevSpec },
      { '@harryzhz/dsh-lark-bridge': '0.4.31' },
    )
    // Lockfile with an unresolvable transitive tarball missing integrity (pre-flight cannot patch it)
    writeFileSync(
      join(profileDir, 'pnpm-lock.yaml'),
      "lockfileVersion: '9.0'\npackages:\n  'transitive@https://example.com/t.tgz':\n    resolution: {tarball: https://example.com/t.tgz}\n",
      'utf8',
    )

    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith('/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v0.4.35',
            assets: [
              {
                name: 'harryzhz-dsh-lark-bridge-0.4.35.tgz',
                browser_download_url: newUrl,
                digest: `sha256:${sha}`,
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response(payload, { status: 200 })
    }

    let removeAttempts = 0
    const pm: HostPluginManagerLike = {
      listBundles: vi.fn(async () => [
        { name: '@harryzhz/dsh-lark-bridge', version: '0.4.31', enabled: true, installed: true, removable: true },
      ]),
      removeBundle: vi.fn(async (): Promise<HostChangeResultLike> => {
        removeAttempts += 1
        if (removeAttempts === 1) {
          return {
            changed: true,
            application: 'failed',
            stage: 'remove',
            packageResult: {
              exitCode: 1,
              output: '[ERR_PNPM_MISSING_TARBALL_INTEGRITY] transitive@1.0.0 has no "integrity" field',
            },
          }
        }
        return { changed: true, application: 'applied', stage: 'remove' }
      }),
      installBundle: vi.fn(async (): Promise<HostChangeResultLike> => ({
        changed: true,
        application: 'applied',
        stage: 'enable',
      })),
    }

    const service = new PluginUpdateService({
      ctx: makeFakeContext({
        profileContext: { name: 'web', dir: profileDir },
        pluginManager: pm,
        hmr: { runExclusive: vi.fn(), reconcileProfile: vi.fn() },
      }),
      dataDir,
      lifecycle: makeFakeLifecycle(),
      fetchImpl,
      runningBridgeVersion: '0.4.31',
    })

    const op = await service.startUpdate({ target: 'bridge' })
    const settled = await waitForSettledOp(service, op.operationId)
    expect(removeAttempts).toBe(2)
    expect(settled.status).toBe('succeeded')
    expect(settled.hotReloaded).toBe(true)
  })

  it('clears stale lockfile on installBundle missing-integrity error and cancels drain when external-agents fails', async () => {
    const profileDir = makeTempDir('dsh-prof-')
    const dataDir = makeTempDir('dsh-data-')
    const prevExt =
      'https://github.com/harryzhz/dsh-external-agents/releases/download/v0.4.5/harryzhz-dsh-external-agents-0.4.5.tgz'
    const newExt =
      'https://github.com/harryzhz/dsh-external-agents/releases/download/v0.4.6/harryzhz-dsh-external-agents-0.4.6.tgz'
    const prevBridge =
      'https://github.com/harryzhz/dsh-lark-bridge/releases/download/v0.4.31/harryzhz-dsh-lark-bridge-0.4.31.tgz'
    const newBridge =
      'https://github.com/harryzhz/dsh-lark-bridge/releases/download/v0.4.35/harryzhz-dsh-lark-bridge-0.4.35.tgz'
    const payload = Buffer.from('valid-payload')
    const sha = createHash('sha256').update(payload).digest('hex')

    writeProfileFixtures(
      profileDir,
      {
        '@harryzhz/dsh-external-agents': prevExt,
        '@harryzhz/dsh-lark-bridge': prevBridge,
      },
      {
        '@harryzhz/dsh-external-agents': '0.4.5',
        '@harryzhz/dsh-lark-bridge': '0.4.31',
      },
    )
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\npackages: {}\n", 'utf8')

    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith('/harryzhz/dsh-external-agents/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v0.4.6',
            assets: [{ name: 'harryzhz-dsh-external-agents-0.4.6.tgz', browser_download_url: newExt, digest: `sha256:${sha}` }],
          }),
          { status: 200 },
        )
      }
      if (url.endsWith('/harryzhz/dsh-lark-bridge/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v0.4.35',
            assets: [{ name: 'harryzhz-dsh-lark-bridge-0.4.35.tgz', browser_download_url: newBridge, digest: `sha256:${sha}` }],
          }),
          { status: 200 },
        )
      }
      return new Response(payload, { status: 200 })
    }

    const installCalls: string[] = []
    const pm: HostPluginManagerLike = {
      listBundles: vi.fn(async () => [
        { name: '@harryzhz/dsh-external-agents', version: '0.4.5', enabled: true, installed: true, removable: true },
        { name: '@harryzhz/dsh-lark-bridge', version: '0.4.31', enabled: true, installed: true, removable: true },
      ]),
      removeBundle: vi.fn(async (): Promise<HostChangeResultLike> => ({
        changed: true,
        application: 'applied',
        stage: 'remove',
      })),
      installBundle: vi.fn(async (spec): Promise<HostChangeResultLike> => {
        installCalls.push(spec)
        if (spec === newExt) {
          return {
            changed: false,
            application: 'failed',
            stage: 'install',
            error: {
              code: 'operation-error',
              diagnostic: 'ERR_PNPM_MISSING_TARBALL_INTEGRITY lockfile entry has no "integrity" field',
            },
          }
        }
        return { changed: true, application: 'applied', stage: 'enable' }
      }),
    }

    const cancelDrain = vi.fn(async () => ({
      phase: 'running' as const,
      draining: false,
      drained: true,
      activeTurns: [],
      activeTriageCount: 0,
      activeRemindersCount: 0,
      activeDreamingCount: 0,
      totalInFlight: 0,
      persistedPendingTurns: 0,
      pid: process.pid,
      startedAtMs: Date.now(),
    }))
    const lifecycle = makeFakeLifecycle({ cancelDrain })

    const service = new PluginUpdateService({
      ctx: makeFakeContext({
        profileContext: { name: 'web', dir: profileDir },
        pluginManager: pm,
        hmr: { runExclusive: vi.fn(), reconcileProfile: vi.fn() },
      }),
      dataDir,
      lifecycle,
      fetchImpl,
      runningBridgeVersion: '0.4.31',
    })

    const op = await service.startUpdate({ target: 'all' })
    const settled = await waitForSettledOp(service, op.operationId)

    // Retried newExt once after clearing lockfile, then rolled back to prevExt, and resumed bridge drain
    expect(installCalls).toEqual([newExt, newExt, prevExt])
    expect(cancelDrain).toHaveBeenCalledTimes(1)
    expect(settled.status).toBe('rolled_back')
    expect(settled.error).toContain('升级 pnpm 至 11.x')
  })

  it('blocks concurrent startUpdate calls during release fetch and resumes drain on restart-required bridge exit or rollback', async () => {
    const profileDir = makeTempDir('dsh-prof-')
    const dataDir = makeTempDir('dsh-data-')
    const extTarball = Buffer.from('fake-ext-tgz-v0.4.2')
    const extSha = createHash('sha256').update(extTarball).digest('hex')
    const bridgeTarball = Buffer.from('fake-bridge-tgz-v0.4.10')
    const bridgeSha = createHash('sha256').update(bridgeTarball).digest('hex')

    writeProfileFixtures(
      profileDir,
      {
        '@harryzhz/dsh-lark-bridge':
          'https://github.com/harryzhz/dsh-lark-bridge/releases/download/v0.4.9/harryzhz-dsh-lark-bridge-0.4.9.tgz',
        '@harryzhz/dsh-external-agents':
          'https://github.com/harryzhz/dsh-external-agents/releases/download/v0.4.1/harryzhz-dsh-external-agents-0.4.1.tgz',
      },
      {
        '@harryzhz/dsh-lark-bridge': '0.4.9',
        '@harryzhz/dsh-external-agents': '0.4.1',
      },
    )

    let holdReleaseResolve: (() => void) | undefined
    const fetchImpl: FetchLike = async (url) => {
      if (holdReleaseResolve && url.includes('/releases/latest')) {
        await new Promise<void>((resolve) => {
          const prev = holdReleaseResolve
          holdReleaseResolve = () => {
            prev?.()
            resolve()
          }
        })
      }
      if (url.endsWith('/harryzhz/dsh-external-agents/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v0.4.2',
            assets: [
              {
                name: 'harryzhz-dsh-external-agents-0.4.2.tgz',
                browser_download_url:
                  'https://github.com/harryzhz/dsh-external-agents/releases/download/v0.4.2/harryzhz-dsh-external-agents-0.4.2.tgz',
                digest: `sha256:${extSha}`,
              },
            ],
          }),
          { status: 200 },
        )
      }
      if (url.endsWith('/harryzhz/dsh-lark-bridge/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v0.4.10',
            assets: [
              {
                name: 'harryzhz-dsh-lark-bridge-0.4.10.tgz',
                browser_download_url:
                  'https://github.com/harryzhz/dsh-lark-bridge/releases/download/v0.4.10/harryzhz-dsh-lark-bridge-0.4.10.tgz',
                digest: `sha256:${bridgeSha}`,
              },
            ],
          }),
          { status: 200 },
        )
      }
      if (url.includes('external-agents')) return new Response(extTarball, { status: 200 })
      return new Response(bridgeTarball, { status: 200 })
    }

    let bridgeApplication: HostChangeResultLike['application'] = 'restart-required'
    let failExtInstall = false
    const pm: HostPluginManagerLike = {
      listBundles: vi.fn(async (): Promise<HostBundleInfoLike[]> => [
        { name: '@harryzhz/dsh-lark-bridge', version: '0.4.9', enabled: true, installed: true, removable: true },
        { name: '@harryzhz/dsh-external-agents', version: '0.4.1', enabled: true, installed: true, removable: true },
      ]),
      removeBundle: vi.fn(async (): Promise<HostChangeResultLike> => ({
        changed: true,
        application: 'applied',
        stage: 'remove',
      })),
      installBundle: vi.fn(async (spec): Promise<HostChangeResultLike> => {
        if (failExtInstall && spec.includes('0.4.2')) {
          return {
            changed: false,
            application: 'failed',
            stage: 'install',
            error: { code: 'EINSTALL', diagnostic: 'simulated install failure' },
          }
        }
        if (spec.includes('0.4.10')) {
          return { changed: true, application: bridgeApplication, stage: 'enable' }
        }
        return { changed: true, application: 'applied', stage: 'enable' }
      }),
    }

    const busyStatus = {
      phase: 'running' as const,
      draining: false,
      drained: false,
      activeTurns: [],
      activeTriageCount: 0,
      activeRemindersCount: 0,
      activeDreamingCount: 0,
      totalInFlight: 1,
      persistedPendingTurns: 1,
      pid: process.pid,
      startedAtMs: Date.now(),
    }
    const drainedStatus = { ...busyStatus, draining: true, drained: true, totalInFlight: 0 }

    const beginDrain = vi.fn(async () => ({ ...busyStatus, draining: true }))
    const cancelDrain = vi.fn(async () => busyStatus)
    const lifecycle: PluginUpdateLifecycleHost = {
      getLifecycleStatus: vi.fn(() => busyStatus),
      beginDrain,
      waitForDrain: vi.fn(async () => drainedStatus),
      cancelDrain,
      countActiveExternalAgents: vi.fn(() => 0),
    }

    const service = new PluginUpdateService({
      ctx: makeFakeContext({
        profileContext: { name: 'web', dir: profileDir },
        pluginManager: pm,
        hmr: { runExclusive: vi.fn(), reconcileProfile: vi.fn() },
      }),
      dataDir,
      lifecycle,
      fetchImpl,
      runningBridgeVersion: '0.4.9',
    })

    // 1. Concurrent startUpdate during async release fetch must reject the second caller,
    // and bridge returning `restart-required` (not hot-reloaded) must call cancelDrain to avoid deadlock
    holdReleaseResolve = () => {}
    const firstStart = service.startUpdate({ target: 'bridge' })
    await expect(service.startUpdate({ target: 'bridge' })).rejects.toThrow(/初始化中|进行中/)
    const releaseGate = holdReleaseResolve
    holdReleaseResolve = undefined
    releaseGate()

    const op1 = await firstStart
    const settled1 = await waitForSettledOp(service, op1.operationId)
    expect(settled1.status).toBe('succeeded')
    expect(settled1.restartRequired).toBe(true)
    expect(beginDrain).toHaveBeenCalledTimes(1)
    expect(cancelDrain).toHaveBeenCalledTimes(1)

    // 2. Rollback early-return when external-agents install fails during target='all' must also resume drain
    beginDrain.mockClear()
    cancelDrain.mockClear()
    bridgeApplication = 'applied'
    failExtInstall = true
    const op2 = await service.startUpdate({ target: 'all' })
    const settled2 = await waitForSettledOp(service, op2.operationId)
    expect(settled2.status).toBe('rolled_back')
    expect(beginDrain).toHaveBeenCalledTimes(1)
    expect(cancelDrain).toHaveBeenCalledTimes(1)
  })
})
