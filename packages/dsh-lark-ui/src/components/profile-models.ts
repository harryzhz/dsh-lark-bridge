import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { bridgeApi } from '../api.js'
import type { CatalogModelItem, ModelGroup, RuntimeOption } from '../types.js'

export function profileCatalogCacheKey(runtimeId: string, profileId?: string): string {
  const rt = runtimeId.trim()
  const prof = profileId?.trim() ?? ''
  return rt && prof ? `${rt}::${prof}` : ''
}

/**
 * Look up an already-loaded model list for `(runtime, profileId)` from:
 * 1. Explicit live-probed `profileCatalogs` cache;
 * 2. Exposed profile preset provider group already bundled in `/models` (e.g. `agy--mh-proxy-cli`).
 */
export function resolveProfileCatalogModels(
  runtime: RuntimeOption | undefined,
  profileId: string | undefined,
  models: readonly ModelGroup[],
  profileCatalogs: Readonly<Record<string, readonly CatalogModelItem[]>>,
): readonly CatalogModelItem[] | undefined {
  if (!runtime || runtime.kind !== 'external') return undefined
  const cleanProfile = profileId?.trim() ?? ''
  if (!cleanProfile) return undefined
  const cacheKey = profileCatalogCacheKey(runtime.id, cleanProfile)
  const cached = cacheKey ? profileCatalogs[cacheKey] : undefined
  if (cached && cached.length > 0) return cached

  const profile = runtime.profiles?.find((p) => p.id === cleanProfile)
  if (profile?.providerId) {
    const exposedGroup = models.find((g) => g.provider === profile.providerId)
    if (exposedGroup && exposedGroup.models.length > 0) {
      return exposedGroup.models
    }
  }
  return undefined
}

/**
 * Produce a `ModelGroup[]` view where `runtime.providerId` reflects the live
 * profile-specific model list (preventing incompatible base runtime models from
 * leaking when a proxy or custom launch profile is selected).
 */
export function buildEffectiveModelsForProfile(
  runtime: RuntimeOption | undefined,
  profileId: string | undefined,
  models: readonly ModelGroup[],
  profileCatalogs: Readonly<Record<string, readonly CatalogModelItem[]>>,
  options: { readonly loading?: boolean } = {},
): readonly ModelGroup[] {
  if (!runtime?.providerId) return models
  const cleanProfile = profileId?.trim() ?? ''
  if (!cleanProfile) return models

  const override = resolveProfileCatalogModels(runtime, cleanProfile, models, profileCatalogs)
  if (override && override.length > 0) {
    const exists = models.some((g) => g.provider === runtime.providerId)
    if (!exists) {
      return [...models, { provider: runtime.providerId, name: runtime.name, models: [...override] }]
    }
    return models.map((g) =>
      g.provider === runtime.providerId ? { ...g, models: [...override] } : g,
    )
  }

  // While a non-exposed profile's catalog is actively being probed for the first time,
  // avoid showing the base runtime's unrelated models as if they belonged to this profile.
  if (options.loading) {
    return models.map((g) =>
      g.provider === runtime.providerId ? { ...g, models: [] } : g,
    )
  }
  return models
}

/**
 * Shared live profile model catalog loader for any set of `(runtimeId, profileId)` pairs.
 * Keeps `AgentRuntimeFields`, Dreaming model pickers, and Tier Routing target rows
 * backed by real live models (including proxy profiles).
 */
export function useProfileModelCatalogs(
  pairs: ReadonlyArray<{ readonly runtimeId: string; readonly profileId?: string }>,
  runtimes: readonly RuntimeOption[],
  models: readonly ModelGroup[],
  revision = 0,
): {
  readonly catalogs: Readonly<Record<string, readonly CatalogModelItem[]>>
  readonly loadingKeys: ReadonlySet<string>
  readonly invalidateRuntime: (runtimeId: string) => void
} {
  const [catalogs, setCatalogs] = useState<Record<string, readonly CatalogModelItem[]>>({})
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(() => new Set())
  const inflightRef = useRef<Set<string>>(new Set())

  const requestedKeys = useMemo(() => {
    const seen = new Set<string>()
    const list: Array<{ readonly key: string; readonly runtimeId: string; readonly profileId: string }> = []
    for (const pair of pairs) {
      const rt = runtimes.find((r) => r.id === pair.runtimeId)
      const prof = pair.profileId?.trim() ?? ''
      if (!rt || rt.kind !== 'external' || !prof) continue
      const key = profileCatalogCacheKey(rt.id, prof)
      if (!key || seen.has(key)) continue
      seen.add(key)
      list.push({ key, runtimeId: rt.id, profileId: prof })
    }
    return list
  }, [pairs, runtimes])

  const requestedSig = requestedKeys.map((item) => item.key).sort().join('|')

  useEffect(() => {
    if (requestedKeys.length === 0) return
    let cancelled = false

    for (const item of requestedKeys) {
      const requestToken = `${item.key}@${revision}`
      if (inflightRef.current.has(requestToken)) continue
      // Skip network fetch only if we already cached this revision.
      if (catalogs[item.key] && revision === 0) continue

      const rt = runtimes.find((r) => r.id === item.runtimeId)
      const hasInstantExposed = Boolean(
        rt && resolveProfileCatalogModels(rt, item.profileId, models, catalogs),
      )

      inflightRef.current.add(requestToken)
      if (!hasInstantExposed) {
        setLoadingKeys((prev) => {
          const next = new Set(prev)
          next.add(item.key)
          return next
        })
      }

      void bridgeApi
        .profileModels(item.runtimeId, item.profileId)
        .then((items) => {
          if (cancelled || items.length === 0) return
          setCatalogs((prev) => ({ ...prev, [item.key]: items }))
        })
        .catch(() => {
          // Keep exposed/base catalog fallback if live probe fails.
        })
        .finally(() => {
          inflightRef.current.delete(requestToken)
          if (cancelled) return
          setLoadingKeys((prev) => {
            if (!prev.has(item.key)) return prev
            const next = new Set(prev)
            next.delete(item.key)
            return next
          })
        })
    }

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedSig, revision])

  const invalidateRuntime = useCallback((runtimeId: string) => {
    setCatalogs((prev) => {
      const next: Record<string, readonly CatalogModelItem[]> = {}
      for (const [k, v] of Object.entries(prev)) {
        if (!k.startsWith(`${runtimeId}::`)) next[k] = v
      }
      return next
    })
  }, [])

  return { catalogs, loadingKeys, invalidateRuntime }
}
