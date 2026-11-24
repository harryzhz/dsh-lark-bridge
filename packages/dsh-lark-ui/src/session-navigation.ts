export interface LayoutNavigationLike {
  selectPanel?: (panelId: string | null) => void
  hasMainPanel?: (panelId: string) => boolean
  beginNavigation?: () => AbortSignal
}

export interface SnapshotSourceLike<T> {
  getSnapshot: () => T
  subscribe: (listener: () => void) => () => void
}

export interface WorkspaceNavigationScope {
  uiWorkspace: {
    openSession: (id: string) => void
    unarchiveSession?: (id: string) => Promise<void>
  }
  workspaces: {
    list: SnapshotSourceLike<{
      phase?: string
      archivedSessionIds?: readonly string[]
    }>
  }
  sessions: {
    list: SnapshotSourceLike<{
      phase?: string
      byId?: Record<string, unknown>
    }>
    refresh?: () => Promise<void>
  }
}

export type SessionActivationFailureReason =
  | 'empty'
  | 'disposed'
  | 'not_found'
  | 'open_failed'

export type SessionActivationResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly reason: SessionActivationFailureReason
      readonly message: string
    }

const CATALOG_SYNC_TIMEOUT_MS = 1500

export function parseSessionDeepLinkFromLocation(loc: {
  readonly hash?: string
  readonly search?: string
}): string | undefined {
  const hashMatch = /(?:^|[#&?])session=([^&]+)/.exec(loc.hash || '')
  if (hashMatch?.[1]) {
    try {
      const decoded = decodeURIComponent(hashMatch[1]).trim()
      if (decoded) return decoded
    } catch {
      const raw = hashMatch[1].trim()
      if (raw) return raw
    }
  }
  const params = new URLSearchParams(loc.search || '')
  const fromQuery = params.get('session')?.trim()
  return fromQuery || undefined
}

export function stripSessionDeepLinkUrl(href: string): string | undefined {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return undefined
  }
  let changed = false
  if (url.searchParams.has('session')) {
    url.searchParams.delete('session')
    changed = true
  }
  if (url.hash && /(?:^|[#&])session=/.test(url.hash)) {
    const raw = url.hash.replace(/^#/, '')
    const rest = raw
      .split('&')
      .filter((part) => part && !part.startsWith('session='))
      .join('&')
    url.hash = rest ? `#${rest}` : ''
    changed = true
  }
  if (!changed) return undefined
  return url.pathname + url.search + url.hash
}

export function waitForWorkspaceCatalogsReady(
  scope: Pick<WorkspaceNavigationScope, 'workspaces' | 'sessions'>,
  isDisposed: () => boolean = () => false,
): Promise<boolean> {
  const isReady = () =>
    scope.workspaces.list.getSnapshot().phase === 'ready' &&
    scope.sessions.list.getSnapshot().phase === 'ready'
  if (isReady()) return Promise.resolve(!isDisposed())

  return new Promise<boolean>((resolve) => {
    let settled = false
    let offWs: (() => void) | undefined
    let offSess: (() => void) | undefined
    const finish = (ready: boolean) => {
      if (settled) return
      settled = true
      offWs?.()
      offSess?.()
      resolve(ready)
    }
    const check = () => {
      if (isDisposed()) {
        finish(false)
        return
      }
      if (isReady()) finish(true)
    }
    offWs = scope.workspaces.list.subscribe(check)
    offSess = scope.sessions.list.subscribe(check)
    check()
  })
}

function waitForSnapshotCondition<T>(
  source: SnapshotSourceLike<T>,
  predicate: (snap: T) => boolean,
  isDisposed: () => boolean,
  timeoutMs = CATALOG_SYNC_TIMEOUT_MS,
): Promise<boolean> {
  if (isDisposed()) return Promise.resolve(false)
  if (predicate(source.getSnapshot())) return Promise.resolve(true)

  return new Promise<boolean>((resolve) => {
    let settled = false
    let off: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (matched: boolean) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      off?.()
      resolve(matched)
    }
    const check = () => {
      if (isDisposed()) {
        finish(false)
        return
      }
      if (predicate(source.getSnapshot())) {
        finish(true)
      }
    }
    off = source.subscribe(check)
    timer = setTimeout(() => finish(predicate(source.getSnapshot())), timeoutMs)
    queueMicrotask(check)
  })
}

/**
 * Ensures `sid` is present in `sessions.list.byId`. When a live session's handle was
 * disposed after completion (`per_message`, silent listener, Dreaming, or smart triage),
 * DSH's `session/disposed -> api-session/removed` evicts it from the live client catalog
 * even though the persisted cold log still exists on disk. Triggering `sessions.refresh()`
 * re-hydrates cold sessions from disk and waits for the async microtask projection flush.
 */
async function ensureSessionInCatalog(
  scope: WorkspaceNavigationScope,
  sid: string,
  isDisposed: () => boolean,
): Promise<boolean> {
  const hasSession = (snap: { byId?: Record<string, unknown> }) =>
    !snap.byId || sid in snap.byId
  if (hasSession(scope.sessions.list.getSnapshot())) return true
  if (typeof scope.sessions.refresh !== 'function') return false

  try {
    await scope.sessions.refresh()
  } catch (err) {
    console.warn(`[dsh-lark-ui] sessions.refresh() failed while locating "${sid}":`, err)
    return hasSession(scope.sessions.list.getSnapshot())
  }
  if (isDisposed()) return false

  // `SessionManager.refreshList()` notifies `ClientSessions.projectList()` via queueMicrotask.
  // Yield once and wait briefly for the projected snapshot to contain `sid`.
  await Promise.resolve()
  if (hasSession(scope.sessions.list.getSnapshot())) return true
  return waitForSnapshotCondition(scope.sessions.list, hasSession, isDisposed, 250)
}

export async function activateDshSessionDetailed(options: {
  readonly sessionId: string
  readonly scope: WorkspaceNavigationScope
  readonly getLayout?: () => LayoutNavigationLike | undefined
  readonly isDisposed?: () => boolean
  readonly allowUnarchive?: boolean
}): Promise<SessionActivationResult> {
  const sid = options.sessionId.trim()
  if (!sid) {
    return { ok: false, reason: 'empty', message: '无效的会话 ID' }
  }
  const isDisposed = options.isDisposed ?? (() => false)
  const allowUnarchive = options.allowUnarchive !== false

  const ready = await waitForWorkspaceCatalogsReady(options.scope, isDisposed)
  if (!ready || isDisposed()) {
    return { ok: false, reason: 'disposed', message: '页面状态未就绪，请稍后重试' }
  }

  const found = await ensureSessionInCatalog(options.scope, sid, isDisposed)
  if (isDisposed()) {
    return { ok: false, reason: 'disposed', message: '页面已卸载' }
  }
  if (!found) {
    console.warn(`[dsh-lark-ui] session "${sid}" does not exist in session catalog after refresh`)
    return {
      ok: false,
      reason: 'not_found',
      message: '未找到该会话记录，可能已被清理或尚未持久化',
    }
  }

  options.getLayout?.()?.beginNavigation?.()

  const wsSnap = options.scope.workspaces.list.getSnapshot()
  if (
    allowUnarchive &&
    wsSnap.archivedSessionIds?.includes(sid) &&
    options.scope.uiWorkspace.unarchiveSession
  ) {
    try {
      await options.scope.uiWorkspace.unarchiveSession(sid)
      await waitForSnapshotCondition(
        options.scope.workspaces.list,
        (snap) => !snap.archivedSessionIds?.includes(sid),
        isDisposed,
      )
    } catch (err) {
      console.warn(`[dsh-lark-ui] unarchiveSession("${sid}") failed:`, err)
    }
    if (isDisposed()) {
      return { ok: false, reason: 'disposed', message: '页面已卸载' }
    }
  }

  options.getLayout?.()?.beginNavigation?.()
  try {
    options.scope.uiWorkspace.openSession(sid)
    return { ok: true }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.warn(`[dsh-lark-ui] openSession("${sid}") failed:`, err)
    return {
      ok: false,
      reason: 'open_failed',
      message: `打开会话失败：${detail}`,
    }
  }
}

export async function activateDshSession(options: {
  readonly sessionId: string
  readonly scope: WorkspaceNavigationScope
  readonly getLayout?: () => LayoutNavigationLike | undefined
  readonly isDisposed?: () => boolean
  readonly allowUnarchive?: boolean
}): Promise<boolean> {
  const result = await activateDshSessionDetailed(options)
  return result.ok
}
