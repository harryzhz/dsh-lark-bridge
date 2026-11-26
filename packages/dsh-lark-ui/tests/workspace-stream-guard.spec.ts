import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { SnapshotSourceLike } from '../src/session-navigation.js'
import {
  installWorkspaceStreamGuard,
  type ConnectionGenerationLike,
  type WorkspaceFollowFrameLike,
  type WorkspaceFollowSinkLike,
  type WorkspaceSnapshotLike,
} from '../src/workspace-stream-guard.js'

interface TestWorkspaceView {
  readonly workspaceId: string
  readonly title: string
  readonly sessionIds: readonly string[]
}

function createControllableSource<T>(initial: T): SnapshotSourceLike<T> & {
  set(next: T): void
} {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(next) {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

function createFakeWorkspaceModel() {
  let state: WorkspaceSnapshotLike['state'] = 'idle'
  let phase: WorkspaceSnapshotLike['phase'] = 'ready'
  let error: WorkspaceSnapshotLike['error'] = null
  let items: TestWorkspaceView[] = []
  let archivedSessionIds: string[] = []
  let pinnedSessionIds: string[] = []
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const fn of [...listeners]) fn()
  }

  const model: WorkspaceFollowSinkLike & {
    failStream(code: string, message: string): void
    readonly snapshot: () => {
      state: WorkspaceSnapshotLike['state']
      phase: WorkspaceSnapshotLike['phase']
      error: WorkspaceSnapshotLike['error']
      items: readonly TestWorkspaceView[]
      archivedSessionIds: readonly string[]
      pinnedSessionIds: readonly string[]
    }
  } = {
    getSnapshot: () => ({ state, phase, error }),
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    replaceBaseline(value) {
      const baseline = value as {
        items?: TestWorkspaceView[]
        archivedSessionIds?: string[]
        pinnedSessionIds?: string[]
      }
      items = [...(baseline.items ?? [])]
      archivedSessionIds = [...(baseline.archivedSessionIds ?? [])]
      pinnedSessionIds = [...(baseline.pinnedSessionIds ?? [])]
      state = 'idle'
      phase = 'ready'
      error = null
      emit()
    },
    upsertView(workspace) {
      const view = workspace as TestWorkspaceView
      const idx = items.findIndex((item) => item.workspaceId === view.workspaceId)
      if (idx === -1) items = [view, ...items]
      else items = items.map((item, i) => (i === idx ? view : item))
      emit()
    },
    removeView(workspaceId) {
      items = items.filter((item) => item.workspaceId !== String(workspaceId))
      emit()
    },
    replaceOrder(workspaceIds) {
      const rank = new Map(workspaceIds.map((id, i) => [String(id), i]))
      items = [...items].sort(
        (a, b) => (rank.get(a.workspaceId) ?? 999) - (rank.get(b.workspaceId) ?? 999),
      )
      emit()
    },
    replaceArchived(sessionIds) {
      archivedSessionIds = sessionIds.map(String)
      emit()
    },
    replacePinned(sessionIds) {
      pinnedSessionIds = sessionIds.map(String)
      emit()
    },
    handleCarrierFailure() {
      state = 'loading'
      error = null
      emit()
    },
    failStream(code, message) {
      state = 'error'
      error = { code, message }
      emit()
    },
    snapshot: () => ({ state, phase, error, items, archivedSessionIds, pinnedSessionIds }),
  }

  return model
}

class MockFollowStream implements AsyncIterable<WorkspaceFollowFrameLike> {
  private readonly queue: Array<
    | { kind: 'frame'; frame: WorkspaceFollowFrameLike }
    | { kind: 'end' }
    | { kind: 'error'; error: unknown }
  > = []
  private wake: (() => void) | undefined
  public disposed = false
  public aborted = false

  constructor(private readonly signal?: AbortSignal) {
    if (signal) {
      if (signal.aborted) {
        this.aborted = true
      } else {
        signal.addEventListener(
          'abort',
          () => {
            this.aborted = true
            this.wake?.()
          },
          { once: true },
        )
      }
    }
  }

  push(frame: WorkspaceFollowFrameLike): void {
    this.queue.push({ kind: 'frame', frame })
    this.wake?.()
  }

  end(): void {
    this.queue.push({ kind: 'end' })
    this.wake?.()
  }

  fail(error: unknown): void {
    this.queue.push({ kind: 'error', error })
    this.wake?.()
  }

  dispose(): void {
    this.disposed = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<WorkspaceFollowFrameLike> {
    while (!this.disposed && !this.aborted) {
      const next = this.queue.shift()
      if (!next) {
        await new Promise<void>((resolve) => {
          this.wake = () => {
            this.wake = undefined
            resolve()
          }
        })
        continue
      }
      if (next.kind === 'frame') {
        yield next.frame
        continue
      }
      if (next.kind === 'error') {
        throw next.error
      }
      return
    }
  }
}

async function flush(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('WorkspaceStreamGuard (client-side recovery for terminated DSH workspace.follow)', () => {
  it('stays completely passive while host workspace stream is healthy', async () => {
    const model = createFakeWorkspaceModel()
    const generation = createControllableSource<ConnectionGenerationLike | undefined>({ id: 1 })
    const follow = vi.fn(() => new MockFollowStream())

    const dispose = installWorkspaceStreamGuard(
      {
        connection: { generation },
        remote: { workspace: { follow } },
        workspaces: { list: model },
      },
      { logger: { warn: vi.fn(), info: vi.fn() } },
    )

    generation.set(undefined)
    generation.set({ id: 2 })
    await flush()

    expect(follow).not.toHaveBeenCalled()
    dispose()
  })

  it('recovers immediately when host workspace stream enters terminal error state and applies baseline + increments', async () => {
    const model = createFakeWorkspaceModel()
    const generation = createControllableSource<ConnectionGenerationLike | undefined>({ id: 1 })
    const streams: MockFollowStream[] = []
    const follow = vi.fn((signal?: AbortSignal) => {
      const s = new MockFollowStream(signal)
      streams.push(s)
      return s
    })
    const warn = vi.fn()

    const dispose = installWorkspaceStreamGuard(
      {
        connection: { generation },
        remote: { workspace: { follow } },
        workspaces: { list: model },
      },
      { logger: { warn, info: vi.fn() }, retryBaseMs: 15, retryMaxMs: 40 },
    )

    // Simulate Host workspace.follow terminal failure after a flaky reconnect.
    model.failStream('gateway/internal', 'api gateway: Remote stream WebSocket closed')
    await flush()

    expect(follow).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)

    streams[0]!.push({
      type: 'baseline',
      value: {
        items: [{ workspaceId: 'ws-1', title: 'repo', sessionIds: ['sess-1'] }],
        archivedSessionIds: ['sess-old'],
        pinnedSessionIds: [],
      },
    })
    await flush()

    expect(model.snapshot().state).toBe('idle')
    expect(model.snapshot().items).toEqual([
      { workspaceId: 'ws-1', title: 'repo', sessionIds: ['sess-1'] },
    ])
    expect(model.snapshot().archivedSessionIds).toEqual(['sess-old'])

    // Subsequent incremental updates continue flowing smoothly.
    streams[0]!.push({
      type: 'upsert',
      workspace: { workspaceId: 'ws-1', title: 'repo', sessionIds: ['sess-2', 'sess-1'] },
    })
    streams[0]!.push({
      type: 'archived',
      archivedSessionIds: ['sess-old', 'sess-triage'],
    })
    streams[0]!.push({
      type: 'pinned',
      pinnedSessionIds: ['sess-2'],
    })
    await flush()

    expect(model.snapshot().items[0]?.sessionIds).toEqual(['sess-2', 'sess-1'])
    expect(model.snapshot().archivedSessionIds).toEqual(['sess-old', 'sess-triage'])
    expect(model.snapshot().pinnedSessionIds).toEqual(['sess-2'])

    // Connection drops and reconnects under a new generation -> old stream cancelled, new stream opened.
    generation.set(undefined)
    await flush()
    expect(streams[0]!.aborted).toBe(true)

    generation.set({ id: 2 })
    await flush()
    expect(follow).toHaveBeenCalledTimes(2)

    streams[1]!.push({
      type: 'baseline',
      value: {
        items: [{ workspaceId: 'ws-1', title: 'repo', sessionIds: ['sess-3', 'sess-2', 'sess-1'] }],
        archivedSessionIds: ['sess-old', 'sess-triage'],
        pinnedSessionIds: [],
      },
    })
    await flush()

    expect(model.snapshot().items[0]?.sessionIds).toEqual(['sess-3', 'sess-2', 'sess-1'])
    dispose()
    expect(streams[1]!.aborted).toBe(true)
  })

  it('retains takeover continuity across dsh-lark-ui HMR replacement even after state returned to idle', async () => {
    const model = createFakeWorkspaceModel()
    const generation = createControllableSource<ConnectionGenerationLike | undefined>({ id: 1 })
    const streams: MockFollowStream[] = []
    const follow = vi.fn((signal?: AbortSignal) => {
      const s = new MockFollowStream(signal)
      streams.push(s)
      return s
    })

    const disposeFirst = installWorkspaceStreamGuard(
      {
        connection: { generation },
        remote: { workspace: { follow } },
        workspaces: { list: model },
      },
      { logger: { warn: vi.fn(), info: vi.fn() } },
    )

    model.failStream('gateway/internal', 'socket closed')
    await flush()
    streams[0]!.push({
      type: 'baseline',
      value: { items: [{ workspaceId: 'ws-1', title: 'repo', sessionIds: ['s1'] }] },
    })
    await flush()
    expect(model.snapshot().state).toBe('idle')

    // Simulate dsh-lark-ui HMR dispose & remount onto the same host ClientWorkspaceModel.
    disposeFirst()
    expect(streams[0]!.aborted).toBe(true)

    const disposeSecond = installWorkspaceStreamGuard(
      {
        connection: { generation },
        remote: { workspace: { follow } },
        workspaces: { list: model },
      },
      { logger: { warn: vi.fn(), info: vi.fn() } },
    )
    await flush()

    expect(follow).toHaveBeenCalledTimes(2)
    streams[1]!.push({
      type: 'baseline',
      value: { items: [{ workspaceId: 'ws-1', title: 'repo', sessionIds: ['s2', 's1'] }] },
    })
    await flush()
    expect(model.snapshot().items[0]?.sessionIds).toEqual(['s2', 's1'])

    disposeSecond()
  })

  it('pauses retries on non-retryable access errors until the next connection generation and caps transient retries', async () => {
    const model = createFakeWorkspaceModel()
    const generation = createControllableSource<ConnectionGenerationLike | undefined>({ id: 1 })
    const streams: MockFollowStream[] = []
    const follow = vi.fn((signal?: AbortSignal) => {
      const s = new MockFollowStream(signal)
      streams.push(s)
      return s
    })
    const warn = vi.fn()

    const dispose = installWorkspaceStreamGuard(
      {
        connection: { generation },
        remote: { workspace: { follow } },
        workspaces: { list: model },
      },
      {
        logger: { warn, info: vi.fn() },
        retryBaseMs: 10,
        retryMaxMs: 20,
        maxRetriesPerGeneration: 2,
      },
    )

    model.failStream('gateway/internal', 'carrier lost')
    await flush()
    expect(follow).toHaveBeenCalledTimes(1)

    // Non-retryable access denial must pause within generation #1 instead of looping.
    const denied = Object.assign(new Error('forbidden'), { code: 'access/denied' })
    streams[0]!.fail(denied)
    await flush(60)
    expect(follow).toHaveBeenCalledTimes(1)

    // Next generation re-attempts cleanly and caps transient failures at maxRetriesPerGeneration (2 retries -> 3 opens).
    generation.set({ id: 2 })
    await flush()
    expect(follow).toHaveBeenCalledTimes(2)
    streams[1]!.fail(new Error('transient 1'))
    await flush(30)
    expect(follow).toHaveBeenCalledTimes(3)
    streams[2]!.fail(new Error('transient 2'))
    await flush(40)
    expect(follow).toHaveBeenCalledTimes(4)
    streams[3]!.fail(new Error('transient 3'))
    await flush(60)
    expect(follow).toHaveBeenCalledTimes(4)

    dispose()
  })

  it('degrades gracefully when host model does not expose WorkspaceFollowSink methods and cleans up via Cordis effect', async () => {
    const ctx = new Context()
    const generation = createControllableSource<ConnectionGenerationLike | undefined>({ id: 1 })
    const bareList = createControllableSource<WorkspaceSnapshotLike>({
      state: 'error',
      phase: 'ready',
      error: { code: 'gateway/internal', message: 'failed' },
    })
    const follow = vi.fn(() => new MockFollowStream())
    const warn = vi.fn()

    const fiber = ctx.plugin({
      name: 'guard-test',
      apply(subCtx) {
        installWorkspaceStreamGuard(
          {
            connection: { generation },
            remote: { workspace: { follow } },
            workspaces: { list: bareList },
            effect: (fn, label) => {
              subCtx.effect(fn, label)
            },
          },
          { logger: { warn, info: vi.fn() } },
        )
      },
    })

    await flush()
    expect(follow).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)

    // Repeated notifications must not spam warnings.
    generation.set({ id: 2 })
    await flush()
    expect(warn).toHaveBeenCalledTimes(1)

    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
