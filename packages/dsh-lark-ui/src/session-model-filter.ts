import { bridgeApi } from './api.js'
import type { RuntimeOption } from './types.js'

export interface DshModelReasoning {
  readonly efforts: ReadonlyArray<{ readonly id: string; readonly name: string }>
  readonly defaultEffort?: string
}

export interface DshModelEntry {
  readonly id: string
  readonly name: string
  readonly reasoning?: DshModelReasoning
}

export interface DshModelProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly DshModelEntry[]
}

export interface DshModelCatalogFailure {
  readonly id: string
  readonly name: string
  readonly message: string
}

export interface DshModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface DshModelDirectoryState {
  readonly current: DshModelSelection | null
  readonly retainedEffort?: string
  readonly routable: boolean | null
  readonly groups: readonly DshModelProviderGroup[]
  readonly failures: readonly DshModelCatalogFailure[]
  readonly status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  readonly pending: DshModelSelection | null
  readonly error: string | null
}

export interface PresetRuntimeTarget {
  readonly kind: 'external' | 'native'
  readonly providerId?: string
  readonly defaultModel?: string
}

const BUILTIN_PRESET_TARGETS: Readonly<Record<string, PresetRuntimeTarget>> = {
  codex: { kind: 'external', providerId: 'codex-cli', defaultModel: 'gpt-6.1-sol' },
  agy: { kind: 'external', providerId: 'agy-cli', defaultModel: 'gemini-4-neon' },
  'claude-code': { kind: 'external', providerId: 'claude-code-cli', defaultModel: 'default' },
  trae: { kind: 'external', providerId: 'trae-cli' },
  standard: { kind: 'native' },
  ptc: { kind: 'native' },
  minimal: { kind: 'native' },
  cordis: { kind: 'native' },
}

let runtimeTargets = new Map<string, PresetRuntimeTarget>(Object.entries(BUILTIN_PRESET_TARGETS))
let runtimeTargetsRevision = 1
const runtimeTargetsListeners = new Set<() => void>()

export function getRuntimeTargetsSnapshot(): {
  readonly map: ReadonlyMap<string, PresetRuntimeTarget>
  readonly revision: number
} {
  return { map: runtimeTargets, revision: runtimeTargetsRevision }
}

export function updateSessionFilterRuntimes(runtimes: readonly RuntimeOption[]): void {
  const next = new Map<string, PresetRuntimeTarget>(Object.entries(BUILTIN_PRESET_TARGETS))
  for (const rt of runtimes) {
    next.set(rt.id, {
      kind: rt.kind,
      ...(rt.providerId ? { providerId: rt.providerId } : {}),
      ...(rt.defaultModel ? { defaultModel: rt.defaultModel } : {}),
    })
  }
  runtimeTargets = next
  runtimeTargetsRevision += 1
  for (const listener of runtimeTargetsListeners) {
    try {
      listener()
    } catch {
      // Isolate subscriber errors.
    }
  }
}

/**
 * Pure projection filtering a session's `ModelDirectoryState` to ONLY the models
 * belonging to the session's active `agentPreset`.
 *
 * - External presets (`codex`, `agy`, `claude-code`, `trae`, or custom external runtimes)
 *   display only their dedicated `providerId` group.
 * - Built-in native presets (`standard`, `ptc`, `minimal`, `cordis`) display only
 *   non-external LLM providers.
 * - If `raw.current` still points at a foreign provider (e.g. before an async preset switch
 *   commits `model/selected`), projects the active runtime's default model so the composer
 *   trigger and effort picker never display another Agent's model.
 */
export function filterModelDirectoryState(
  raw: DshModelDirectoryState,
  presetId: string | null | undefined,
  targets: ReadonlyMap<string, PresetRuntimeTarget> = runtimeTargets,
): DshModelDirectoryState {
  const trimmedPreset = presetId?.trim() ?? ''
  if (!trimmedPreset) return raw
  const target = targets.get(trimmedPreset)
  if (!target) return raw

  const externalProviderIds = new Set<string>()
  for (const entry of targets.values()) {
    if (entry.kind === 'external' && entry.providerId) {
      externalProviderIds.add(entry.providerId)
    }
  }

  const allowsProvider = (providerId: string): boolean => {
    if (target.kind === 'external' && target.providerId) {
      return providerId === target.providerId
    }
    return !externalProviderIds.has(providerId) && !providerId.endsWith('-cli')
  }

  const groups = raw.groups.filter((g) => allowsProvider(g.id))
  const failures = raw.failures.filter((f) => allowsProvider(f.id))

  // While catalog hasn't finished its initial load, filter groups/failures and hide foreign current.
  if (raw.groups.length === 0 && raw.status !== 'ready') {
    const keepCurrent = raw.current !== null && allowsProvider(raw.current.provider)
    return {
      ...raw,
      current: keepCurrent ? raw.current : null,
      ...(keepCurrent && raw.retainedEffort !== undefined ? { retainedEffort: raw.retainedEffort } : {}),
      groups,
      failures,
    }
  }

  if (raw.current !== null && allowsProvider(raw.current.provider)) {
    const routable = groups.some(
      (g) => g.id === raw.current!.provider && g.models.some((m) => m.id === raw.current!.model),
    )
    return {
      ...raw,
      routable,
      groups,
      failures,
    }
  }

  // Foreign or missing `current`: synthesize the active runtime's default selection from `groups`.
  const primaryGroup = groups[0]
  const preferredModel =
    (target.defaultModel
      ? primaryGroup?.models.find((m) => m.id === target.defaultModel)
      : undefined) ?? primaryGroup?.models[0]

  if (!primaryGroup || !preferredModel) {
    const base: DshModelDirectoryState = {
      current: null,
      routable: groups.length === 0 ? false : null,
      groups,
      failures,
      status: raw.status,
      pending: raw.pending && allowsProvider(raw.pending.provider) ? raw.pending : null,
      error: raw.error,
    }
    return base
  }

  const defaultEffort = preferredModel.reasoning?.defaultEffort
  const retainedEffort =
    defaultEffort === undefined
      ? undefined
      : (preferredModel.reasoning?.efforts.find((e) => e.id === defaultEffort)?.name ?? defaultEffort)

  return {
    current: {
      provider: primaryGroup.id,
      model: preferredModel.id,
      ...(defaultEffort !== undefined ? { reasoningEffort: defaultEffort } : {}),
    },
    ...(retainedEffort !== undefined ? { retainedEffort } : {}),
    routable: true,
    groups,
    failures,
    status: raw.status,
    pending: raw.pending && allowsProvider(raw.pending.provider) ? raw.pending : null,
    error: raw.error,
  }
}

interface StoreLike<T> {
  getSnapshot(): T
  set?(value: T): void
  subscribe(listener: () => void): () => void
}

interface DirectoryLike {
  readonly sessionId?: string
  readonly store: StoreLike<DshModelDirectoryState>
  load(): Promise<DshModelDirectoryState>
}

interface SessionsServiceLike {
  scope?(sessionId: string): { effect?: (fn: () => () => void, label?: string) => void } | undefined
  binding?(sessionId: string):
    | {
        readonly session?: {
          readonly projections?: {
            faceOf?(key: string): StoreLike<unknown> | undefined
          }
        }
      }
    | undefined
  list?: StoreLike<{
    readonly byId?: Readonly<
      Record<string, { readonly projectionValues?: { readonly agentPreset?: unknown } }>
    >
  }>
}

interface ModelDirectoriesServiceLike {
  readonly live?: {
    readonly directories?: {
      readonly values?: Iterable<DirectoryLike>
    }
  }
  directoryFor(sessionId: string): DirectoryLike
}

const ENHANCED_STORE = Symbol.for('dsh-lark-ui.scoped-model-store')

function readSessionPreset(sessions: SessionsServiceLike, sessionId: string): string | undefined {
  const face = sessions.binding?.(sessionId)?.session?.projections?.faceOf?.('agentPreset')
  const fromFace = face?.getSnapshot()
  if (typeof fromFace === 'string' && fromFace.length > 0) return fromFace
  const listed = sessions.list?.getSnapshot()?.byId?.[sessionId]?.projectionValues?.agentPreset
  return typeof listed === 'string' && listed.length > 0 ? listed : undefined
}

export function enhanceDirectory(
  directory: DirectoryLike,
  sessionId: string,
  sessions: SessionsServiceLike,
): () => void {
  const store = directory.store as StoreLike<DshModelDirectoryState> & {
    [ENHANCED_STORE]?: () => void
  }
  if (store[ENHANCED_STORE]) return store[ENHANCED_STORE]

  const origGetSnapshot = store.getSnapshot.bind(store)
  const origSet = store.set?.bind(store)

  let cachedRaw: DshModelDirectoryState | undefined
  let cachedPreset: string | undefined
  let cachedRev = -1
  let cachedFiltered: DshModelDirectoryState | undefined

  const computeFiltered = (): DshModelDirectoryState => {
    const raw = origGetSnapshot()
    const preset = readSessionPreset(sessions, sessionId)
    const { map, revision } = getRuntimeTargetsSnapshot()
    if (
      cachedFiltered !== undefined &&
      raw === cachedRaw &&
      preset === cachedPreset &&
      revision === cachedRev
    ) {
      return cachedFiltered
    }
    cachedRaw = raw
    cachedPreset = preset
    cachedRev = revision
    cachedFiltered = filterModelDirectoryState(raw, preset, map)
    return cachedFiltered
  }

  store.getSnapshot = computeFiltered

  let lastObservedPreset = readSessionPreset(sessions, sessionId)
  let lastObservedRev = getRuntimeTargetsSnapshot().revision

  const pulseStore = () => {
    origSet?.({ ...origGetSnapshot() })
  }

  const onExternalInputChanged = () => {
    const nextPreset = readSessionPreset(sessions, sessionId)
    const nextRev = getRuntimeTargetsSnapshot().revision
    if (nextPreset === lastObservedPreset && nextRev === lastObservedRev) return
    lastObservedPreset = nextPreset
    lastObservedRev = nextRev
    pulseStore()
  }

  const unsubs: Array<() => void> = []
  const face = sessions.binding?.(sessionId)?.session?.projections?.faceOf?.('agentPreset')
  if (face) {
    unsubs.push(face.subscribe(onExternalInputChanged))
  }
  if (sessions.list) {
    unsubs.push(sessions.list.subscribe(onExternalInputChanged))
  }
  runtimeTargetsListeners.add(onExternalInputChanged)
  unsubs.push(() => {
    runtimeTargetsListeners.delete(onExternalInputChanged)
  })

  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    for (const unsub of unsubs) unsub()
    unsubs.length = 0
    store.getSnapshot = origGetSnapshot
    delete store[ENHANCED_STORE]
  }
  store[ENHANCED_STORE] = restore

  sessions.scope?.(sessionId)?.effect?.(() => restore, 'dsh-lark-ui.session-model-filter.session')

  // Immediately notify any subscriber that mounted before `enhanceDirectory` ran.
  pulseStore()

  return restore
}

export function installSessionModelFilter(scope: {
  readonly modelDirectories: ModelDirectoriesServiceLike
  readonly sessions: SessionsServiceLike
  effect?: (fn: () => () => void, label?: string) => void
}): void {
  void bridgeApi
    .runtimes()
    .then((list) => updateSessionFilterRuntimes(list))
    .catch(() => {})

  const restorers = new Set<() => void>()
  const modelDirectories = scope.modelDirectories
  const sessions = scope.sessions

  // 1. Enhance any ModelDirectory already created before our plugin initialized.
  for (const existing of modelDirectories.live?.directories?.values ?? []) {
    if (existing.sessionId) {
      restorers.add(enhanceDirectory(existing, existing.sessionId, sessions))
    }
  }

  // 2. Patch `directoryFor` on the service prototype (or object) so future sessions are enhanced too.
  const proto = Object.getPrototypeOf(modelDirectories) as ModelDirectoriesServiceLike | null
  const patchHost: ModelDirectoriesServiceLike =
    proto && typeof proto.directoryFor === 'function' ? proto : modelDirectories
  const origDirectoryFor = patchHost.directoryFor

  patchHost.directoryFor = function patchedDirectoryFor(this: unknown, sessionId: string): DirectoryLike {
    const dir = origDirectoryFor.call(this, sessionId)
    restorers.add(enhanceDirectory(dir, sessionId, sessions))
    return dir
  }

  scope.effect?.(
    () => () => {
      patchHost.directoryFor = origDirectoryFor
      for (const restore of restorers) restore()
      restorers.clear()
    },
    'dsh-lark-ui.session-model-filter',
  )
}
