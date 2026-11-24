import { describe, expect, it, vi } from 'vitest'
import {
  activateDshSession,
  activateDshSessionDetailed,
  parseSessionDeepLinkFromLocation,
  stripSessionDeepLinkUrl,
  type SnapshotSourceLike,
} from '../src/session-navigation.js'

function createMockSource<T>(initial: T): SnapshotSourceLike<T> & { set: (next: T) => void } {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    set: (next) => {
      state = next
      for (const fn of [...listeners]) fn()
    },
  }
}

describe('DSH Web session deep-link parsing & deferred activation', () => {
  it('parses #session= and ?session= deep links and strips them cleanly from URLs', () => {
    expect(
      parseSessionDeepLinkFromLocation({
        hash: '#session=session-00000000-0000-4000-8000-000000000001',
        search: '',
      }),
    ).toBe('session-00000000-0000-4000-8000-000000000001')

    expect(
      parseSessionDeepLinkFromLocation({
        hash: '',
        search: '?session=session-abc-123&foo=1',
      }),
    ).toBe('session-abc-123')

    expect(
      stripSessionDeepLinkUrl(
        'http://192.168.1.10:3880/#session=session-00000000-0000-4000-8000-000000000001',
      ),
    ).toBe('/')

    expect(
      stripSessionDeepLinkUrl(
        'http://192.168.1.10:3880/ui/?foo=bar&session=session-1#tab=overview&session=session-1',
      ),
    ).toBe('/ui/?foo=bar#tab=overview')
  })

  it('waits for catalogs to reach ready, unarchives archived sessions, aborts boot restoration, and opens target session', async () => {
    const sid = 'session-00000000-0000-4000-8000-000000000001'
    const wsList = createMockSource({
      phase: 'loading',
      archivedSessionIds: [sid] as readonly string[],
    })
    const sessList = createMockSource({
      phase: 'loading',
      byId: {} as Record<string, unknown>,
    })

    const callOrder: string[] = []
    const beginNavigation = vi.fn(() => {
      callOrder.push('beginNavigation')
      return new AbortController().signal
    })
    const unarchiveSession = vi.fn(async (id: string) => {
      callOrder.push(`unarchive:${id}`)
      wsList.set({ phase: 'ready', archivedSessionIds: [] })
    })
    const openSession = vi.fn((id: string) => {
      callOrder.push(`open:${id}`)
    })

    const pending = activateDshSession({
      sessionId: sid,
      scope: {
        uiWorkspace: { openSession, unarchiveSession },
        workspaces: { list: wsList },
        sessions: { list: sessList },
      },
      getLayout: () => ({ beginNavigation }),
    })

    expect(openSession).not.toHaveBeenCalled()

    // Simulate WebSocket catalog arrival
    wsList.set({ phase: 'ready', archivedSessionIds: [sid] })
    sessList.set({ phase: 'ready', byId: { [sid]: { id: sid } } })

    const opened = await pending
    expect(opened).toBe(true)
    expect(unarchiveSession).toHaveBeenCalledWith(sid)
    expect(openSession).toHaveBeenCalledWith(sid)
    expect(callOrder).toEqual([
      'beginNavigation',
      `unarchive:${sid}`,
      'beginNavigation',
      `open:${sid}`,
    ])
  })

  it('returns false without opening when sessionId no longer exists in catalog', async () => {
    const wsList = createMockSource({ phase: 'ready', archivedSessionIds: [] })
    const sessList = createMockSource({ phase: 'ready', byId: { 'session-other': {} } })
    const openSession = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const opened = await activateDshSession({
      sessionId: 'session-deleted',
      scope: {
        uiWorkspace: { openSession },
        workspaces: { list: wsList },
        sessions: { list: sessList },
      },
    })

    warnSpy.mockRestore()
    expect(opened).toBe(false)
    expect(openSession).not.toHaveBeenCalled()
  })

  it('refreshes session catalog when target cold session was evicted after dispose, waits for projection & unarchive, and opens cleanly', async () => {
    const sid = 'session-00000000-0000-4000-8000-000000000002'
    const wsList = createMockSource({
      phase: 'ready',
      archivedSessionIds: [sid] as readonly string[],
    })
    // Cold session initially missing from byId (simulating api-session/removed after handle.dispose())
    const sessList = createMockSource({
      phase: 'ready',
      byId: { 'session-other': {} } as Record<string, unknown>,
    })

    const callOrder: string[] = []
    const refresh = vi.fn(async () => {
      callOrder.push('refresh')
      // Simulate SessionManager's async microtask projection flush
      queueMicrotask(() => {
        sessList.set({ phase: 'ready', byId: { 'session-other': {}, [sid]: { id: sid } } })
      })
    })
    const unarchiveSession = vi.fn(async (id: string) => {
      callOrder.push(`unarchive:${id}`)
      // Simulate delayed WS workspace/updated broadcast after RPC resolves
      setTimeout(() => {
        wsList.set({ phase: 'ready', archivedSessionIds: [] })
      }, 10)
    })
    const openSession = vi.fn((id: string) => {
      // Must NOT run before workspaces.list confirms unarchived!
      expect(wsList.getSnapshot().archivedSessionIds).not.toContain(id)
      callOrder.push(`open:${id}`)
    })

    const result = await activateDshSessionDetailed({
      sessionId: sid,
      scope: {
        uiWorkspace: { openSession, unarchiveSession },
        workspaces: { list: wsList },
        sessions: { list: sessList, refresh },
      },
    })

    expect(result).toEqual({ ok: true })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(unarchiveSession).toHaveBeenCalledWith(sid)
    expect(openSession).toHaveBeenCalledWith(sid)
    expect(callOrder).toEqual(['refresh', `unarchive:${sid}`, `open:${sid}`])
  })

  it('returns structured not_found and open_failed errors for user-visible feedback', async () => {
    const wsList = createMockSource({ phase: 'ready', archivedSessionIds: [] })
    const sessList = createMockSource({ phase: 'ready', byId: {} as Record<string, unknown> })
    const refresh = vi.fn(async () => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const missing = await activateDshSessionDetailed({
      sessionId: 'session-truly-missing',
      scope: {
        uiWorkspace: { openSession: vi.fn() },
        workspaces: { list: wsList },
        sessions: { list: sessList, refresh },
      },
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(missing).toMatchObject({ ok: false, reason: 'not_found' })

    const sid = 'session-throws'
    sessList.set({ phase: 'ready', byId: { [sid]: { id: sid } } })
    const failed = await activateDshSessionDetailed({
      sessionId: sid,
      scope: {
        uiWorkspace: {
          openSession: () => {
            throw new Error('boom')
          },
        },
        workspaces: { list: wsList },
        sessions: { list: sessList },
      },
    })
    warnSpy.mockRestore()
    expect(failed).toMatchObject({ ok: false, reason: 'open_failed' })
    if (!failed.ok) expect(failed.message).toContain('boom')
  })
})
