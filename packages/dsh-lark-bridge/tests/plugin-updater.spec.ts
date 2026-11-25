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
  isNewerVersion,
  parseSha256Sums,
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
})
