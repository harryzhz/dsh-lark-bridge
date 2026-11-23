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
  }
}

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

export async function activateDshSession(options: {
  readonly sessionId: string
  readonly scope: WorkspaceNavigationScope
  readonly getLayout?: () => LayoutNavigationLike | undefined
  readonly isDisposed?: () => boolean
  readonly allowUnarchive?: boolean
}): Promise<boolean> {
  const sid = options.sessionId.trim()
  if (!sid) return false
  const isDisposed = options.isDisposed ?? (() => false)
  const allowUnarchive = options.allowUnarchive !== false

  const ready = await waitForWorkspaceCatalogsReady(options.scope, isDisposed)
  if (!ready || isDisposed()) return false

  const sessionsSnap = options.scope.sessions.list.getSnapshot()
  if (sessionsSnap.byId && !(sid in sessionsSnap.byId)) {
    console.warn(`[dsh-lark-ui] session "${sid}" does not exist in session catalog`)
    return false
  }

  options.getLayout?.()?.beginNavigation?.()

  const wsSnap = options.scope.workspaces.list.getSnapshot()
  if (allowUnarchive && wsSnap.archivedSessionIds?.includes(sid) && options.scope.uiWorkspace.unarchiveSession) {
    try {
      await options.scope.uiWorkspace.unarchiveSession(sid)
    } catch (err) {
      console.warn(`[dsh-lark-ui] unarchiveSession("${sid}") failed:`, err)
    }
    if (isDisposed()) return false
  }

  options.getLayout?.()?.beginNavigation?.()
  options.scope.uiWorkspace.openSession(sid)
  return true
}
