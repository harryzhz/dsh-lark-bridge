import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'

const GLOBAL_HANDOFF_KEY = Symbol.for('dsh-lark-bridge.hot-reload-handoff')
const DEFAULT_SWAP_TTL_MS = 3 * 60_000
const DEFAULT_ORPHAN_HANDLE_TTL_MS = 3 * 60_000

interface SwapMarker {
  readonly operationId: string
  readonly startedAtMs: number
  readonly expiresAtMs: number
}

interface DetachedHandleEntry {
  readonly dataDirKey: string
  readonly sessionId: string
  readonly handle: AgentHandle
  readonly detachedAtMs: number
  orphanTimer?: ReturnType<typeof setTimeout>
}

interface GlobalHotReloadHandoffState {
  readonly activeSwaps: Map<string, SwapMarker>
  readonly detachedHandles: Map<string, DetachedHandleEntry>
}

function getGlobalHandoffState(): GlobalHotReloadHandoffState {
  const g = globalThis as Record<PropertyKey, unknown>
  let state = g[GLOBAL_HANDOFF_KEY] as GlobalHotReloadHandoffState | undefined
  if (!state) {
    state = {
      activeSwaps: new Map(),
      detachedHandles: new Map(),
    }
    g[GLOBAL_HANDOFF_KEY] = state
  }
  return state
}

function normalizeDataDirKey(dataDir: string): string {
  const trimmed = dataDir.trim()
  return trimmed ? resolve(trimmed) : '__default__'
}

function handleEntryKey(dataDir: string, sessionId: string): string {
  return `${normalizeDataDirKey(dataDir)}::${sessionId}`
}

/**
 * Resolve the DSH host root `agents` service so agents created or resumed by
 * `dsh-lark-bridge` are owned by the host root fiber rather than this plugin's
 * HMR-disposable fiber. When `dsh-lark-bridge` hot-reloads, live agents keep
 * running uninterrupted in the host process; when the host process shuts down,
 * `ctx.root` still disposes them cleanly.
 */
export function resolveHostAgents(ctx: Context): Context['agents'] {
  const root = (ctx as { readonly root?: { readonly get?: (name: string) => unknown } }).root
  if (typeof root?.get === 'function') {
    const rootAgents = root.get('agents') as Context['agents'] | undefined
    if (rootAgents && typeof rootAgents.create === 'function') {
      return rootAgents
    }
  }
  return ctx.agents
}

/**
 * Resolve the host `agentPresets` service through `ctx.root` when available so
 * preset mounting does not bind its service tracer to this plugin's short-lived fiber.
 */
export function resolveHostAgentPresets<T>(ctx: Context): T | undefined {
  const root = (ctx as { readonly root?: { readonly get?: (name: string) => unknown } }).root
  if (typeof root?.get === 'function') {
    const rootPresets = root.get('agentPresets') as T | undefined
    if (rootPresets) return rootPresets
  }
  return ctx.get('agentPresets' as never) as T | undefined
}

/**
 * Mark that `dsh-lark-bridge` for `dataDir` is undergoing an in-place HMR self-swap.
 * While active, `LarkBridgeManager.stop()` preserves live in-flight agents instead of
 * cancelling/disposing them so the reloaded instance can reattach seamlessly.
 */
export function markBridgeHotReloadSwap(
  dataDir: string,
  operationId: string,
  ttlMs = DEFAULT_SWAP_TTL_MS,
): void {
  const key = normalizeDataDirKey(dataDir)
  const now = Date.now()
  getGlobalHandoffState().activeSwaps.set(key, {
    operationId,
    startedAtMs: now,
    expiresAtMs: now + Math.max(10_000, ttlMs),
  })
}

export function isBridgeHotReloadSwapping(dataDir: string, nowMs = Date.now()): boolean {
  const key = normalizeDataDirKey(dataDir)
  const state = getGlobalHandoffState()
  const marker = state.activeSwaps.get(key)
  if (!marker) return false
  if (nowMs >= marker.expiresAtMs) {
    state.activeSwaps.delete(key)
    return false
  }
  return true
}

export function clearBridgeHotReloadSwap(dataDir: string, operationId?: string): void {
  const key = normalizeDataDirKey(dataDir)
  const state = getGlobalHandoffState()
  const marker = state.activeSwaps.get(key)
  if (!marker) return
  if (operationId && marker.operationId !== operationId) return
  state.activeSwaps.delete(key)
}

/**
 * Park an active `AgentHandle` across a `dsh-lark-bridge` hot-reload swap without
 * disposing it. Installs an unref'd orphan guard so that if no reloaded bridge
 * claims the handle (e.g. failed install or permanent plugin removal), it disposes
 * itself once the agent finishes its current work.
 */
export function stashDetachedAgentHandle(
  dataDir: string,
  sessionId: string,
  handle: AgentHandle,
  orphanTtlMs = DEFAULT_ORPHAN_HANDLE_TTL_MS,
): void {
  const state = getGlobalHandoffState()
  const dataDirKey = normalizeDataDirKey(dataDir)
  const key = handleEntryKey(dataDir, sessionId)
  const existing = state.detachedHandles.get(key)
  if (existing) {
    if (existing.orphanTimer) clearTimeout(existing.orphanTimer)
    state.detachedHandles.delete(key)
  }

  const entry: DetachedHandleEntry = {
    dataDirKey,
    sessionId,
    handle,
    detachedAtMs: Date.now(),
  }

  if (orphanTtlMs > 0) {
    entry.orphanTimer = setTimeout(() => {
      if (state.detachedHandles.get(key) !== entry) return
      state.detachedHandles.delete(key)
      const waitIdle =
        typeof handle.agent?.whenIdle === 'function'
          ? handle.agent.whenIdle().catch(() => {})
          : Promise.resolve()
      void waitIdle.finally(() => {
        void handle.dispose().catch(() => {})
      })
    }, orphanTtlMs)
    entry.orphanTimer.unref?.()
  }

  state.detachedHandles.set(key, entry)
}

/**
 * Reclaim a previously stashed `AgentHandle` after `dsh-lark-bridge` finishes hot-reloading.
 */
export function claimDetachedAgentHandle(dataDir: string, sessionId: string): AgentHandle | undefined {
  const state = getGlobalHandoffState()
  const key = handleEntryKey(dataDir, sessionId)
  const entry = state.detachedHandles.get(key)
  if (!entry) return undefined
  state.detachedHandles.delete(key)
  if (entry.orphanTimer) {
    clearTimeout(entry.orphanTimer)
    entry.orphanTimer = undefined
  }
  return entry.handle
}

export function listDetachedSessionIds(dataDir: string): string[] {
  const dataDirKey = normalizeDataDirKey(dataDir)
  const out: string[] = []
  for (const entry of getGlobalHandoffState().detachedHandles.values()) {
    if (entry.dataDirKey === dataDirKey) {
      out.push(entry.sessionId)
    }
  }
  return out
}

/**
 * Dispose any unclaimed detached handles for `dataDir` that are no longer running.
 * Called after startup recovery has claimed every live reattached turn.
 */
export async function sweepUnclaimedDetachedHandles(
  dataDir: string,
  options: { readonly forceAll?: boolean } = {},
): Promise<number> {
  const state = getGlobalHandoffState()
  const dataDirKey = normalizeDataDirKey(dataDir)
  const toDispose: DetachedHandleEntry[] = []

  for (const [key, entry] of state.detachedHandles.entries()) {
    if (entry.dataDirKey !== dataDirKey) continue
    const stillRunning = entry.handle.agent?.status === 'running'
    if (!options.forceAll && stillRunning) continue
    state.detachedHandles.delete(key)
    if (entry.orphanTimer) {
      clearTimeout(entry.orphanTimer)
      entry.orphanTimer = undefined
    }
    toDispose.push(entry)
  }

  if (toDispose.length > 0) {
    await Promise.allSettled(toDispose.map((entry) => entry.handle.dispose()))
  }
  return toDispose.length
}

/** Reset global handoff state (intended strictly for unit tests). */
export async function resetGlobalHotReloadHandoffForTest(dataDir?: string): Promise<void> {
  const state = getGlobalHandoffState()
  if (dataDir) {
    clearBridgeHotReloadSwap(dataDir)
    await sweepUnclaimedDetachedHandles(dataDir, { forceAll: true })
    return
  }
  state.activeSwaps.clear()
  const entries = [...state.detachedHandles.values()]
  state.detachedHandles.clear()
  for (const entry of entries) {
    if (entry.orphanTimer) clearTimeout(entry.orphanTimer)
  }
  await Promise.allSettled(entries.map((entry) => entry.handle.dispose()))
}
