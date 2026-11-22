import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

// `@deepseek-ai/cordis` declares `FiberState` as a `const enum` (erased at runtime).
const FIBER_STATE_ACTIVE = 2

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const stub = () => null
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === '__esModule') return true
        if (prop === 'then' || typeof prop === 'symbol') return undefined
        return stub
      },
      has: (_target, prop) => typeof prop === 'string' && prop !== 'then',
      getOwnPropertyDescriptor: (_target, prop) =>
        typeof prop === 'string' && prop !== 'then'
          ? { configurable: true, enumerable: true, value: stub }
          : undefined,
    },
  )
})

import { bridgeApi, configureBridgeTransport, type BridgeConnectionRpcLike } from '../src/api.js'
import * as clientPlugin from '../src/client.js'
import type { LayoutNavigationLike, SnapshotSourceLike } from '../src/session-navigation.js'

interface MockWindowHarness {
  readonly location: { href: string; protocol: string; hash: string; search: string }
  readonly history: { replaceState: ReturnType<typeof vi.fn> }
  readonly focus: ReturnType<typeof vi.fn>
  readonly addEventListener: ReturnType<typeof vi.fn>
  readonly removeEventListener: ReturnType<typeof vi.fn>
  dispatch(type: string): void
}

function installMockWindow(initialHref = 'file:///app/index.html'): MockWindowHarness {
  const url = new URL(initialHref)
  const listeners = new Map<string, Set<() => void>>()
  const location = {
    href: url.href,
    protocol: url.protocol,
    hash: url.hash,
    search: url.search,
  }
  const replaceState = vi.fn((_data: unknown, _unused: string, nextUrl?: string | URL | null) => {
    if (typeof nextUrl === 'string') {
      const resolved = new URL(nextUrl, location.href)
      location.href = resolved.href
      location.protocol = resolved.protocol
      location.hash = resolved.hash
      location.search = resolved.search
    }
  })
  const focus = vi.fn()
  const addEventListener = vi.fn((type: string, fn: () => void) => {
    let set = listeners.get(type)
    if (!set) {
      set = new Set()
      listeners.set(type, set)
    }
    set.add(fn)
  })
  const removeEventListener = vi.fn((type: string, fn: () => void) => {
    listeners.get(type)?.delete(fn)
  })

  const mockWin: MockWindowHarness = {
    location,
    history: { replaceState },
    focus,
    addEventListener,
    removeEventListener,
    dispatch(type: string) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn()
    },
  }
  vi.stubGlobal('window', mockWin)
  return mockWin
}

function createSource<T>(initial: T): SnapshotSourceLike<T> & { set: (next: T) => void } {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: (next) => {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

function provideSiblingService(ctx: Context, serviceName: string, value: unknown) {
  return ctx.plugin({
    name: `${serviceName}-provider`,
    apply(sub: Context) {
      ;(sub as unknown as { provide: (name: string) => void; set: (name: string, val: unknown) => void }).provide(
        serviceName,
      )
      ;(sub as unknown as { set: (name: string, val: unknown) => void }).set(serviceName, value)
    },
  })
}

function captureCordisErrors(ctx: Context): unknown[] {
  const errors: unknown[] = []
  const origError = ctx.logger.error.bind(ctx.logger)
  vi.spyOn(ctx.logger, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.length === 1 ? args[0] : args)
    return origError(...(args as [unknown]))
  })
  return errors
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  configureBridgeTransport(undefined)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('dsh-lark-ui client entry with real @deepseek-ai/cordis Context', () => {
  it('activates cleanly when sibling plugins provide optional services without throwing proxy inject errors', async () => {
    const win = installMockWindow('http://127.0.0.1:3880/#session=session-target-1')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected raw fetch'))

    const ctx = new Context()
    const cordisErrors = captureCordisErrors(ctx)

    const injectedSlots: Array<{ slot: string; registration: unknown }> = []
    const registeredDefs: Array<{ def: Record<string, unknown>; component: unknown }> = []
    const slotsService = {
      inject(slot: string, fn: () => unknown) {
        injectedSlots.push({ slot, registration: fn() })
      },
      register(def: Record<string, unknown>, component: unknown) {
        const entry = { def, component }
        registeredDefs.push(entry)
        return entry
      },
    }

    const rpc: BridgeConnectionRpcLike = {
      call: vi.fn(async (_channel, _endpoint, payload) => {
        const req = payload as { path: string }
        if (req.path === '/bots') {
          return { ok: true, value: { ok: true, bots: [{ id: 'bot-1', name: 'Bot 1' }] } }
        }
        if (req.path === '/runtimes') {
          return { ok: true, value: { ok: true, runtimes: [] } }
        }
        return { ok: true, value: { ok: true } }
      }),
    }

    const beginNavigation = vi.fn(() => new AbortController().signal)
    const selectPanel = vi.fn()
    const layoutService: LayoutNavigationLike = {
      beginNavigation,
      selectPanel,
      hasMainPanel: () => true,
    }

    const openSession = vi.fn()
    const wsList = createSource({
      phase: 'ready',
      archivedSessionIds: [] as readonly string[],
    })
    const sessionsList = createSource({
      phase: 'ready',
      byId: {
        'session-target-1': { id: 'session-target-1' },
        'session-target-2': { id: 'session-target-2' },
      } as Record<string, unknown>,
    })
    const modelDirectoriesService = {
      live: { directories: { values: [] } },
      directoryFor: vi.fn(() => ({
        store: createSource({
          current: null,
          routable: null,
          groups: [],
          failures: [],
          status: 'ready',
          pending: null,
          error: null,
        }),
        load: vi.fn(),
      })),
    }

    // Register services as independent sibling plugins (matching DSH Web/Desktop runtime topology)
    // so direct `ctx.<service>` access on undeclared services triggers Cordis 4.1.0 Proxy guards.
    provideSiblingService(ctx, 'slots', slotsService)
    provideSiblingService(ctx, 'connection', { rpc })
    const layoutFiber = provideSiblingService(ctx, 'layout', layoutService)
    provideSiblingService(ctx, 'uiWorkspace', { openSession })
    provideSiblingService(ctx, 'workspaces', { list: wsList })
    provideSiblingService(ctx, 'sessions', { list: sessionsList })
    provideSiblingService(ctx, 'modelDirectories', modelDirectoriesService)

    const fiber = ctx.plugin(clientPlugin as never)
    await flushMicrotasks()

    expect(cordisErrors).toEqual([])
    expect(fiber.state).toBe(FIBER_STATE_ACTIVE)
    expect(injectedSlots.map((item) => item.slot)).toEqual(['main', 'sidebar.panellist'])
    expect(registeredDefs.map((entry) => entry.def)).toEqual([
      { name: 'main', key: 'lark-bridge' },
      { name: 'sidebar.panellist', id: 'lark-bridge', order: 25, label: '飞书桥接' },
    ])

    // Transport bound synchronously via `ctx.get('connection')` before `modelDirectories` runs
    const bots = await bridgeApi.bots()
    expect(bots).toEqual([{ id: 'bot-1', name: 'Bot 1' }])
    expect(rpc.call).toHaveBeenCalledWith('/api', 'lark-bridge-rpc', { method: 'GET', path: '/bots' }, undefined)
    expect(fetchSpy).not.toHaveBeenCalled()

    // Pending deep-link session consumed without undeclared `ctx.layout` / `ctx.uiWorkspace` access
    expect(beginNavigation).toHaveBeenCalled()
    expect(openSession).toHaveBeenCalledWith('session-target-1')
    expect(win.history.replaceState).toHaveBeenCalled()

    // Disposing layout and handling another deep-link must still read optional layout safely via `ctx.get`
    await layoutFiber.dispose()
    await flushMicrotasks()
    win.location.href = 'http://127.0.0.1:3880/#session=session-target-2'
    win.location.hash = '#session=session-target-2'
    win.dispatch('hashchange')
    await flushMicrotasks()

    expect(openSession).toHaveBeenCalledWith('session-target-2')
    expect(cordisErrors).toEqual([])

    await fiber.dispose()
    expect(win.removeEventListener).toHaveBeenCalledWith('hashchange', expect.any(Function))
    expect(win.removeEventListener).toHaveBeenCalledWith('popstate', expect.any(Function))
    await ctx.fiber.dispose()
  })

  it('registers slots when only slots is present and binds optional services when they arrive later', async () => {
    installMockWindow('file:///app/index.html')

    const ctx = new Context()
    const cordisErrors = captureCordisErrors(ctx)
    const injectedSlots: string[] = []
    provideSiblingService(ctx, 'slots', {
      inject(slot: string, fn: () => unknown) {
        injectedSlots.push(slot)
        fn()
      },
      register(def: Record<string, unknown>, component: unknown) {
        return { def, component }
      },
    })

    const fiber = ctx.plugin(clientPlugin as never)
    await flushMicrotasks()

    expect(cordisErrors).toEqual([])
    expect(fiber.state).toBe(FIBER_STATE_ACTIVE)
    expect(injectedSlots).toEqual(['main', 'sidebar.panellist'])

    const lateRpc: BridgeConnectionRpcLike = {
      call: vi.fn(async () => ({ ok: true, value: { ok: true, bots: [{ id: 'late-bot' }] } })),
    }
    const connFiber = provideSiblingService(ctx, 'connection', { rpc: lateRpc })
    const layoutFiber = provideSiblingService(ctx, 'layout', {
      selectPanel: vi.fn(),
      hasMainPanel: () => true,
    })
    await flushMicrotasks()

    const bots = await bridgeApi.bots()
    expect(bots).toEqual([{ id: 'late-bot' }])
    expect(lateRpc.call).toHaveBeenCalledTimes(1)

    // Disposing optional sibling services should clean up cleanly without throwing proxy errors
    await connFiber.dispose()
    await layoutFiber.dispose()
    await flushMicrotasks()
    expect(cordisErrors).toEqual([])

    const fallbackFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, bots: [{ id: 'http-fallback' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    expect(await bridgeApi.bots()).toEqual([{ id: 'http-fallback' }])
    expect(fallbackFetch).toHaveBeenCalledTimes(1)

    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('starts the Desktop session-open listener on dsh-app://app/, activates target session, and ACKs cleanly', async () => {
    const win = installMockWindow('dsh-app://app/')
    const ctx = new Context()
    const cordisErrors = captureCordisErrors(ctx)

    provideSiblingService(ctx, 'slots', {
      inject: vi.fn(),
      register: vi.fn((def, component) => ({ def, component })),
    })

    const openSession = vi.fn()
    const wsList = createSource({ phase: 'ready', archivedSessionIds: [] as readonly string[] })
    const sessionsList = createSource({
      phase: 'ready',
      byId: { 'session-desktop-42': { id: 'session-desktop-42' } } as Record<string, unknown>,
    })
    provideSiblingService(ctx, 'uiWorkspace', { openSession })
    provideSiblingService(ctx, 'workspaces', { list: wsList })
    provideSiblingService(ctx, 'sessions', { list: sessionsList })

    let waitCalls = 0
    const ackPayloads: Array<{ requestId: string; opened: boolean }> = []
    let releaseSecondWait: (() => void) | undefined
    const rpc: BridgeConnectionRpcLike = {
      call: vi.fn(async (_channel, _endpoint, payload, signal) => {
        const req = payload as { method: string; path: string; body?: { requestId: string; opened: boolean } }
        if (req.path.startsWith('/desktop/open-wait')) {
          waitCalls += 1
          if (waitCalls === 1) {
            return {
              ok: true,
              value: { ok: true, command: { requestId: 'req-desktop-1', sessionId: 'session-desktop-42' } },
            }
          }
          await new Promise<void>((resolve) => {
            releaseSecondWait = resolve
            signal?.addEventListener('abort', () => resolve(), { once: true })
          })
          return { ok: true, value: { ok: true, command: null } }
        }
        if (req.path === '/desktop/open-ack' && req.body) {
          ackPayloads.push(req.body)
          return { ok: true, value: { ok: true, matched: true } }
        }
        return { ok: true, value: { ok: true } }
      }),
    }
    provideSiblingService(ctx, 'connection', { rpc })

    const fiber = ctx.plugin(clientPlugin as never)
    await flushMicrotasks()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(openSession).toHaveBeenCalledWith('session-desktop-42')
    expect(ackPayloads).toEqual([{ requestId: 'req-desktop-1', opened: true }])
    expect(win.focus).toHaveBeenCalled()
    expect(cordisErrors).toEqual([])

    await fiber.dispose()
    releaseSecondWait?.()
    await ctx.fiber.dispose()
  })
})
