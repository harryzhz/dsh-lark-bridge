import type { SnapshotSourceLike } from './session-navigation.js'

/**
 * Minimal structural mirror of DSH Host's `WorkspaceSnapshot` + `WorkspaceFollowSink`
 * (`@deepseek-ai/dsh-api-workspace-controller@0.2.x`).
 *
 * Host contract note:
 * In DSH 0.2.x, `@deepseek-ai/dsh-api-workspace-controller/client` starts its
 * `RemoteSnapshotStream` once and never subscribes to `connection.generation`.
 * If the multiplexed WebSocket drops during a reconnect handshake (after `$events`
 * publishes a new generation `ready` frame, before the larger `workspace/follow`
 * `baseline` frame arrives), `RemoteStream`'s `waitForRemoteStreamRetry` (`attempt >= 2`
 * while `generation !== undefined`) terminates `workspace/follow` permanently and
 * freezes `ClientWorkspaceModel` in `state = 'error'` with its old snapshot.
 * Meanwhile `dsh-api-session-controller` DOES subscribe to `connection.generation`
 * and continues refreshing/adding sessions, causing all subsequent sessions (and
 * archived sessions absent from the frozen `archivedSessionIds`) to flood into
 * the sidebar's "Ungrouped" bucket until a full page reload.
 *
 * This guard stays completely passive while Host's own stream is healthy and only
 * takes over `workspace/follow` once `workspaces.list` enters terminal `state === 'error'`.
 */

export interface WorkspaceSnapshotLike {
  readonly state?: 'idle' | 'loading' | 'error'
  readonly phase?: 'pending' | 'ready'
  readonly error?: { readonly code?: string; readonly message?: string } | null
}

export interface WorkspaceFollowSinkLike extends SnapshotSourceLike<WorkspaceSnapshotLike> {
  replaceBaseline(value: unknown): void
  upsertView(workspace: unknown): void
  removeView(workspaceId: unknown): void
  replaceOrder(workspaceIds: readonly unknown[]): void
  replaceArchived(sessionIds: readonly unknown[]): void
  replacePinned(pinnedSessionIds: readonly unknown[]): void
  handleCarrierFailure?(): void
}

export interface WorkspaceFollowFrameLike {
  readonly type: 'baseline' | 'replace' | 'upsert' | 'remove' | 'order' | 'archived' | 'pinned'
  readonly value?: unknown
  readonly workspace?: unknown
  readonly workspaceId?: unknown
  readonly workspaceIds?: readonly unknown[]
  readonly archivedSessionIds?: readonly unknown[]
  readonly pinnedSessionIds?: readonly unknown[]
}

export interface WorkspaceRemoteLike {
  follow(signal?: AbortSignal): AsyncIterable<WorkspaceFollowFrameLike> & { dispose?: () => void }
}

export interface ConnectionGenerationLike {
  readonly id: number
}

export interface WorkspaceStreamGuardScope {
  readonly connection: {
    readonly generation?: SnapshotSourceLike<ConnectionGenerationLike | undefined>
  }
  readonly remote: {
    readonly workspace?: WorkspaceRemoteLike
  }
  readonly workspaces: {
    readonly list: SnapshotSourceLike<WorkspaceSnapshotLike>
  }
  effect?: (fn: () => () => void, label?: string) => void
}

export interface WorkspaceStreamGuardOptions {
  readonly retryBaseMs?: number
  readonly retryMaxMs?: number
  readonly maxRetriesPerGeneration?: number
  readonly logger?: Pick<Console, 'warn' | 'info'>
}

const WORKSPACE_STREAM_TAKEN_OVER = Symbol.for('dsh-lark-ui.workspace-stream-recovered')
const DEFAULT_RETRY_BASE_MS = 500
const DEFAULT_RETRY_MAX_MS = 8_000
const DEFAULT_MAX_RETRIES_PER_GEN = 5

const NON_RETRYABLE_REMOTE_CODES = new Set([
  'access/denied',
  'gateway/unauthorized',
  'gateway/forbidden',
  'gateway/not-found',
])

function isWorkspaceFollowSink(value: unknown): value is WorkspaceFollowSinkLike {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.getSnapshot === 'function' &&
    typeof candidate.subscribe === 'function' &&
    typeof candidate.replaceBaseline === 'function' &&
    typeof candidate.upsertView === 'function' &&
    typeof candidate.removeView === 'function' &&
    typeof candidate.replaceOrder === 'function' &&
    typeof candidate.replaceArchived === 'function' &&
    typeof candidate.replacePinned === 'function'
  )
}

function readErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function applyWorkspaceFrame(sink: WorkspaceFollowSinkLike, frame: WorkspaceFollowFrameLike): boolean {
  switch (frame.type) {
    case 'baseline':
      sink.replaceBaseline(frame.value)
      return true
    case 'replace':
      sink.replaceBaseline(frame.value)
      return false
    case 'upsert':
      sink.upsertView(frame.workspace)
      return false
    case 'remove':
      sink.removeView(frame.workspaceId)
      return false
    case 'order':
      sink.replaceOrder(frame.workspaceIds ?? [])
      return false
    case 'archived':
      sink.replaceArchived(frame.archivedSessionIds ?? [])
      return false
    case 'pinned':
      sink.replacePinned(frame.pinnedSessionIds ?? [])
      return false
    default:
      return false
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function installWorkspaceStreamGuard(
  scope: WorkspaceStreamGuardScope,
  options: WorkspaceStreamGuardOptions = {},
): () => void {
  const generationSource = scope.connection?.generation
  const remoteWorkspace = scope.remote?.workspace
  const rawList = scope.workspaces?.list
  const logger = options.logger ?? console
  const retryBaseMs = Math.max(10, options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS)
  const retryMaxMs = Math.max(retryBaseMs, options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS)
  const maxRetriesPerGeneration = Math.max(
    1,
    options.maxRetriesPerGeneration ?? DEFAULT_MAX_RETRIES_PER_GEN,
  )

  if (!generationSource || !remoteWorkspace || typeof remoteWorkspace.follow !== 'function' || !rawList) {
    return () => {}
  }

  let disposed = false
  let warnedIncompatible = false
  let activeGenerationId: number | undefined
  let activeAbort: AbortController | undefined
  let activeStreamHandle: { dispose?: () => void } | undefined

  const markedModel = rawList as unknown as { [WORKSPACE_STREAM_TAKEN_OVER]?: boolean }
  let takenOver = Boolean(markedModel[WORKSPACE_STREAM_TAKEN_OVER])

  const stopActiveAttempt = () => {
    activeGenerationId = undefined
    const abort = activeAbort
    activeAbort = undefined
    abort?.abort(new Error('workspace stream recovery superseded'))
    const handle = activeStreamHandle
    activeStreamHandle = undefined
    try {
      handle?.dispose?.()
    } catch {
      // Ignore cleanup errors on already-terminated stream handles.
    }
  }

  const runRecoveryForGeneration = async (
    sink: WorkspaceFollowSinkLike,
    generationId: number,
    abort: AbortController,
  ): Promise<void> => {
    const signal = abort.signal
    let attempt = 0
    while (!disposed && !signal.aborted) {
      let baselineAccepted = false
      let streamHandle: (AsyncIterable<WorkspaceFollowFrameLike> & { dispose?: () => void }) | undefined
      try {
        streamHandle = remoteWorkspace.follow(signal)
        activeStreamHandle = streamHandle
        for await (const frame of streamHandle) {
          if (disposed || signal.aborted) return
          if (!baselineAccepted) {
            if (frame.type !== 'baseline') {
              throw new Error(`workspace recovery expected baseline frame, got "${String(frame.type)}"`)
            }
            applyWorkspaceFrame(sink, frame)
            baselineAccepted = true
            attempt = 0
            continue
          }
          if (frame.type === 'baseline') {
            throw new Error('workspace recovery received duplicate opening baseline')
          }
          applyWorkspaceFrame(sink, frame)
        }
        if (disposed || signal.aborted) return
      } catch (err) {
        if (disposed || signal.aborted) return
        const code = readErrorCode(err)
        if (code && NON_RETRYABLE_REMOTE_CODES.has(code)) {
          logger.warn(
            `[dsh-lark-ui] workspace stream recovery paused on non-retryable error (${code}) until next connection generation`,
          )
          return
        }
      } finally {
        if (activeStreamHandle === streamHandle) {
          activeStreamHandle = undefined
        }
        try {
          streamHandle?.dispose?.()
        } catch {
          // Ignore handle dispose errors.
        }
      }

      if (disposed || signal.aborted) return
      if (generationSource.getSnapshot()?.id !== generationId) return

      attempt += 1
      if (attempt > maxRetriesPerGeneration) {
        logger.warn(
          `[dsh-lark-ui] workspace stream recovery exhausted ${maxRetriesPerGeneration} retries in generation #${generationId}; waiting for next connection generation`,
        )
        return
      }

      try {
        sink.handleCarrierFailure?.()
      } catch {
        // Ignore transient UI state update errors.
      }

      const delayMs = Math.min(retryMaxMs, retryBaseMs * 2 ** (attempt - 1))
      const slept = await abortableSleep(delayMs, signal)
      if (!slept || disposed || signal.aborted) return
      if (generationSource.getSnapshot()?.id !== generationId) return
    }
  }

  const reconcile = () => {
    if (disposed) return
    const wsSnap = rawList.getSnapshot()
    if (!takenOver) {
      if (wsSnap?.state !== 'error' && !markedModel[WORKSPACE_STREAM_TAKEN_OVER]) {
        return
      }
      if (!isWorkspaceFollowSink(rawList)) {
        if (!warnedIncompatible) {
          warnedIncompatible = true
          logger.warn(
            '[dsh-lark-ui] workspace stream entered error state, but host model lacks WorkspaceFollowSink methods; automatic recovery skipped',
          )
        }
        return
      }
      takenOver = true
      markedModel[WORKSPACE_STREAM_TAKEN_OVER] = true
      logger.warn(
        `[dsh-lark-ui] detected terminated DSH workspace stream (${wsSnap?.error?.code ?? 'error'}); activating generation-aware recovery`,
      )
    }

    if (!isWorkspaceFollowSink(rawList)) return

    const currentGen = generationSource.getSnapshot()
    if (!currentGen) {
      stopActiveAttempt()
      return
    }
    if (activeGenerationId === currentGen.id && activeAbort && !activeAbort.signal.aborted) {
      return
    }

    stopActiveAttempt()
    const abort = new AbortController()
    activeAbort = abort
    activeGenerationId = currentGen.id
    void runRecoveryForGeneration(rawList, currentGen.id, abort)
  }

  const offWs = rawList.subscribe(reconcile)
  const offGen = generationSource.subscribe(reconcile)
  reconcile()

  const dispose = () => {
    if (disposed) return
    disposed = true
    offWs()
    offGen()
    stopActiveAttempt()
  }

  scope.effect?.(() => dispose, 'dsh-lark-ui.workspace-stream-guard')
  return dispose
}
