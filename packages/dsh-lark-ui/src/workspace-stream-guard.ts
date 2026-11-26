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

function applyWorkspaceFrame(sink: WorkspaceFollowSinkLike, frame: WorkspaceFollowFrameLike): void {
  switch (frame.type) {
    case 'baseline':
    case 'replace':
      sink.replaceBaseline(frame.value)
      return
    case 'upsert':
      sink.upsertView(frame.workspace)
      return
    case 'remove':
      sink.removeView(frame.workspaceId)
      return
    case 'order':
      sink.replaceOrder(frame.workspaceIds ?? [])
      return
    case 'archived':
      sink.replaceArchived(frame.archivedSessionIds ?? [])
      return
    case 'pinned':
      sink.replacePinned(frame.pinnedSessionIds ?? [])
      return
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

class WorkspaceStreamGuard {
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number
  private readonly maxRetriesPerGeneration: number
  private readonly logger: Pick<Console, 'warn' | 'info'>
  private readonly markedModel: { [WORKSPACE_STREAM_TAKEN_OVER]?: boolean }
  private takenOver: boolean
  private disposed = false
  private warnedIncompatible = false
  private activeGenerationId: number | undefined
  private activeAbort: AbortController | undefined
  private activeStreamHandle: { dispose?: () => void } | undefined
  private offWs: (() => void) | undefined
  private offGen: (() => void) | undefined

  constructor(
    private readonly generationSource: SnapshotSourceLike<ConnectionGenerationLike | undefined>,
    private readonly remoteWorkspace: WorkspaceRemoteLike,
    private readonly rawList: SnapshotSourceLike<WorkspaceSnapshotLike>,
    options: WorkspaceStreamGuardOptions,
  ) {
    this.logger = options.logger ?? console
    this.retryBaseMs = Math.max(10, options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS)
    this.retryMaxMs = Math.max(this.retryBaseMs, options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS)
    this.maxRetriesPerGeneration = Math.max(
      1,
      options.maxRetriesPerGeneration ?? DEFAULT_MAX_RETRIES_PER_GEN,
    )
    this.markedModel = rawList as unknown as { [WORKSPACE_STREAM_TAKEN_OVER]?: boolean }
    this.takenOver = Boolean(this.markedModel[WORKSPACE_STREAM_TAKEN_OVER])
  }

  start(): () => void {
    const onUpdate = () => {
      this.reconcile()
    }
    this.offWs = this.rawList.subscribe(onUpdate)
    this.offGen = this.generationSource.subscribe(onUpdate)
    this.reconcile()
    return () => {
      this.dispose()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.offWs?.()
    this.offGen?.()
    this.offWs = undefined
    this.offGen = undefined
    this.stopActiveAttempt()
  }

  private stopActiveAttempt(): void {
    this.activeGenerationId = undefined
    const abort = this.activeAbort
    this.activeAbort = undefined
    abort?.abort(new Error('workspace stream recovery superseded'))
    const handle = this.activeStreamHandle
    this.activeStreamHandle = undefined
    try {
      handle?.dispose?.()
    } catch {
      // Ignore cleanup errors on already-terminated stream handles.
    }
  }

  private reconcile(): void {
    if (this.disposed) return
    if (!this.ensureTakenOver()) return
    if (!isWorkspaceFollowSink(this.rawList)) return

    const currentGen = this.generationSource.getSnapshot()
    if (!currentGen) {
      this.stopActiveAttempt()
      return
    }
    if (
      this.activeGenerationId === currentGen.id &&
      this.activeAbort &&
      !this.activeAbort.signal.aborted
    ) {
      return
    }

    this.stopActiveAttempt()
    const abort = new AbortController()
    this.activeAbort = abort
    this.activeGenerationId = currentGen.id
    void this.runRecoveryForGeneration(this.rawList, currentGen.id, abort)
  }

  private ensureTakenOver(): boolean {
    if (this.takenOver) return true
    const wsSnap = this.rawList.getSnapshot()
    if (wsSnap?.state !== 'error' && !this.markedModel[WORKSPACE_STREAM_TAKEN_OVER]) {
      return false
    }
    if (!isWorkspaceFollowSink(this.rawList)) {
      if (!this.warnedIncompatible) {
        this.warnedIncompatible = true
        this.logger.warn(
          '[dsh-lark-ui] workspace stream entered error state, but host model lacks WorkspaceFollowSink methods; automatic recovery skipped',
        )
      }
      return false
    }
    this.takenOver = true
    this.markedModel[WORKSPACE_STREAM_TAKEN_OVER] = true
    this.logger.warn(
      `[dsh-lark-ui] detected terminated DSH workspace stream (${wsSnap?.error?.code ?? 'error'}); activating generation-aware recovery`,
    )
    return true
  }

  private async runRecoveryForGeneration(
    sink: WorkspaceFollowSinkLike,
    generationId: number,
    abort: AbortController,
  ): Promise<void> {
    const signal = abort.signal
    let attempt = 0
    while (!this.disposed && !signal.aborted) {
      const outcome = await this.consumeSingleStream(sink, signal)
      if (this.disposed || signal.aborted) return
      if (outcome.nonRetryableCode) {
        this.logger.warn(
          `[dsh-lark-ui] workspace stream recovery paused on non-retryable error (${outcome.nonRetryableCode}) until next connection generation`,
        )
        return
      }
      if (outcome.baselineAccepted) {
        attempt = 0
      }
      if (this.generationSource.getSnapshot()?.id !== generationId) return

      attempt += 1
      if (attempt > this.maxRetriesPerGeneration) {
        this.logger.warn(
          `[dsh-lark-ui] workspace stream recovery exhausted ${this.maxRetriesPerGeneration} retries in generation #${generationId}; waiting for next connection generation`,
        )
        return
      }

      this.notifyCarrierRetry(sink)
      const delayMs = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (attempt - 1))
      const slept = await abortableSleep(delayMs, signal)
      if (!slept || this.disposed || signal.aborted) return
      if (this.generationSource.getSnapshot()?.id !== generationId) return
    }
  }

  private async consumeSingleStream(
    sink: WorkspaceFollowSinkLike,
    signal: AbortSignal,
  ): Promise<{ readonly baselineAccepted: boolean; readonly nonRetryableCode?: string }> {
    let baselineAccepted = false
    let streamHandle: (AsyncIterable<WorkspaceFollowFrameLike> & { dispose?: () => void }) | undefined
    try {
      streamHandle = this.remoteWorkspace.follow(signal)
      this.activeStreamHandle = streamHandle
      for await (const frame of streamHandle) {
        if (this.disposed || signal.aborted) return { baselineAccepted }
        if (!baselineAccepted) {
          if (frame.type !== 'baseline') {
            throw new Error(`workspace recovery expected baseline frame, got "${String(frame.type)}"`)
          }
          applyWorkspaceFrame(sink, frame)
          baselineAccepted = true
          continue
        }
        if (frame.type === 'baseline') {
          throw new Error('workspace recovery received duplicate opening baseline')
        }
        applyWorkspaceFrame(sink, frame)
      }
      return { baselineAccepted }
    } catch (err) {
      if (this.disposed || signal.aborted) return { baselineAccepted }
      const code = readErrorCode(err)
      if (code && NON_RETRYABLE_REMOTE_CODES.has(code)) {
        return { baselineAccepted, nonRetryableCode: code }
      }
      return { baselineAccepted }
    } finally {
      if (this.activeStreamHandle === streamHandle) {
        this.activeStreamHandle = undefined
      }
      try {
        streamHandle?.dispose?.()
      } catch {
        // Ignore handle dispose errors.
      }
    }
  }

  private notifyCarrierRetry(sink: WorkspaceFollowSinkLike): void {
    try {
      sink.handleCarrierFailure?.()
    } catch {
      // Ignore transient UI state update errors.
    }
  }
}

export function installWorkspaceStreamGuard(
  scope: WorkspaceStreamGuardScope,
  options: WorkspaceStreamGuardOptions = {},
): () => void {
  const generationSource = scope.connection?.generation
  const remoteWorkspace = scope.remote?.workspace
  const rawList = scope.workspaces?.list
  if (!generationSource || !remoteWorkspace || typeof remoteWorkspace.follow !== 'function' || !rawList) {
    return () => {}
  }

  const guard = new WorkspaceStreamGuard(generationSource, remoteWorkspace, rawList, options)
  const dispose = guard.start()
  scope.effect?.(() => dispose, 'dsh-lark-ui.workspace-stream-guard')
  return dispose
}
