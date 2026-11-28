import { browseHostDirectories, createHostSubdirectory } from '../fs-browser.js'
import type { RuntimeProfileInput } from '../runtime-catalog.js'
import { bodyRecord, ok, type LarkRouteDefinition } from './router.js'

export const runtimeAndFsRoutes: readonly LarkRouteDefinition[] = [
  // ── Local Directory Browser (Owner Web/Desktop session strictly required) ─
  {
    method: 'GET',
    pattern: '/fs/dirs',
    policy: 'owner',
    handler: async ({ ctx, url }) => {
      const rawPath = url.searchParams.get('path') ?? undefined
      const listing = await browseHostDirectories(ctx, rawPath)
      return ok({ ok: true, ...listing })
    },
  },
  {
    method: 'POST',
    pattern: '/fs/dirs',
    policy: 'owner',
    handler: async ({ ctx, request }) => {
      const body = bodyRecord(request.body) as { parentPath?: string; name?: string }
      const createdPath = await createHostSubdirectory(
        ctx,
        body.parentPath ?? '',
        body.name ?? '',
      )
      return ok({ ok: true, path: createdPath }, 201)
    },
  },

  // ── Runtime Profiles (Owner Web/Desktop session strictly required) ───────
  {
    method: 'GET',
    pattern: '/runtime-profiles',
    policy: 'owner',
    handler: ({ manager, url }) => {
      const runtimeId = url.searchParams.get('runtimeId')?.trim() || undefined
      return ok({
        ok: true,
        supported: manager.runtimes.supportsProfiles(),
        profiles: manager.runtimes.listProfiles(runtimeId),
      })
    },
  },
  {
    method: 'POST',
    pattern: '/runtime-profiles',
    policy: 'owner',
    handler: async ({ manager, request }) => {
      const body = bodyRecord(request.body) as unknown as Partial<RuntimeProfileInput>
      if (typeof body.runtimeId !== 'string' || !body.runtimeId.trim()) {
        return ok({ ok: false, error: 'runtimeId is required' }, 400)
      }
      if (typeof body.name !== 'string' || !body.name.trim()) {
        return ok({ ok: false, error: 'name is required' }, 400)
      }
      const profile = await manager.runtimes.upsertProfile({
        ...body,
        runtimeId: body.runtimeId.trim(),
        name: body.name.trim(),
      })
      return ok({ ok: true, profile }, 201)
    },
  },
  {
    method: 'PUT',
    pattern: '/runtime-profiles/:runtimeId/:profileId',
    policy: 'owner',
    handler: async ({ manager, request, params }) => {
      const runtimeId = params.runtimeId!
      const profileId = params.profileId!
      const body = bodyRecord(request.body) as unknown as Partial<RuntimeProfileInput>
      const existing = manager.runtimes.getProfile(runtimeId, profileId)
      const resolvedName =
        typeof body.name === 'string' && body.name.trim()
          ? body.name.trim()
          : existing?.name || profileId
      const profile = await manager.runtimes.upsertProfile({
        ...body,
        id: profileId,
        runtimeId,
        name: resolvedName,
      })
      return ok({ ok: true, profile })
    },
  },
  {
    method: 'DELETE',
    pattern: '/runtime-profiles/:runtimeId/:profileId',
    policy: 'owner',
    handler: async ({ manager, params }) => {
      const runtimeId = params.runtimeId!
      const profileId = params.profileId!
      const deleted = await manager.runtimes.deleteProfile(runtimeId, profileId)
      if (deleted) {
        try {
          manager.setRuntimeConcurrencyLimit?.({
            runtimeId,
            profileId,
            maxConcurrent: null,
          })
        } catch {
          // Best-effort cleanup of orphaned concurrency override.
        }
      }
      return ok({ ok: deleted }, deleted ? 200 : 404)
    },
  },
  {
    method: 'POST',
    pattern: '/runtime-profiles/:runtimeId/:profileId/probe',
    policy: 'owner',
    handler: async ({ manager, params }) => {
      const runtimeId = params.runtimeId!
      const profileId = params.profileId!
      const targetProfileId = profileId === '_default' ? undefined : profileId
      const models = await manager.runtimes.probeProfileModels(runtimeId, targetProfileId)
      const providerId = manager.runtimes.providerFor(runtimeId) ?? ''
      return ok({
        ok: true,
        runtimeId,
        ...(targetProfileId ? { profileId: targetProfileId } : {}),
        provider: providerId,
        models: models.map((m) => ({
          provider: providerId,
          id: m.id,
          name: m.name,
          ...(m.isDefault ? { isDefault: true } : {}),
          ...(m.reasoningEfforts !== undefined
            ? { reasoningEfforts: [...m.reasoningEfforts] }
            : {}),
          ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}),
        })),
      })
    },
  },

  // ── Runtimes & Models ──────────────────────────────────────────────────
  {
    method: 'GET',
    pattern: '/runtimes',
    policy: 'owner_or_cli',
    handler: async ({ manager }) => {
      const runtimes = await manager.runtimes.list()
      const exposedPresets = manager.runtimes.listExposedPresets()
      const concurrency =
        typeof manager.getRuntimeConcurrencyConfig === 'function'
          ? manager.getRuntimeConcurrencyConfig()
          : undefined
      return ok({
        ok: true,
        runtimes,
        exposedPresets,
        ...(concurrency ? { concurrency } : {}),
      })
    },
  },
  {
    method: 'PUT',
    pattern: '/runtimes/concurrency',
    policy: 'owner',
    handler: ({ manager, request }) => {
      const body = bodyRecord(request.body)
      const runtimeId = typeof body.runtimeId === 'string' ? body.runtimeId.trim() : ''
      if (!runtimeId || runtimeId.includes('::')) {
        return ok({ ok: false, error: 'runtimeId is required' }, 400)
      }
      const profileId =
        typeof body.profileId === 'string' && body.profileId.trim()
          ? body.profileId.trim()
          : undefined
      if (profileId?.includes('::')) {
        return ok({ ok: false, error: 'invalid profileId' }, 400)
      }
      const rawLimit = body.maxConcurrent
      if (rawLimit !== null && rawLimit !== undefined && typeof rawLimit !== 'number') {
        return ok({ ok: false, error: 'maxConcurrent must be an integer (0-32) or null' }, 400)
      }
      try {
        const result = manager.setRuntimeConcurrencyLimit({
          runtimeId,
          ...(profileId ? { profileId } : {}),
          maxConcurrent: rawLimit === undefined ? null : rawLimit,
        })
        return ok({ ok: true, ...result })
      } catch (err) {
        return ok(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          400,
        )
      }
    },
  },
  {
    method: 'GET',
    pattern: '/models',
    policy: 'owner_or_cli',
    handler: async ({ ctx, manager, url }) => {
      const runtimeId = url.searchParams.get('runtimeId')?.trim() || ''
      if (runtimeId) {
        const profileId = url.searchParams.get('profileId')?.trim() || undefined
        const refresh = url.searchParams.get('refresh') === '1'
        const meta =
          (await manager.runtimes.modelsForRuntime(runtimeId, profileId, { force: refresh })) ?? []
        const providerId = manager.runtimes.providerFor(runtimeId) ?? ''
        return ok({
          ok: true,
          runtimeId,
          ...(profileId ? { profileId } : {}),
          provider: providerId,
          models: meta.map((m) => ({
            provider: providerId,
            id: m.id,
            name: m.name,
            ...(m.isDefault ? { isDefault: true } : {}),
            ...(m.reasoningEfforts !== undefined
              ? { reasoningEfforts: [...m.reasoningEfforts] }
              : {}),
            ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}),
          })),
        })
      }
      const providers = ctx.llm.listProviders()
      const groups = await Promise.all(
        providers.map(async (info) => {
          const isExternal = manager.runtimes?.isExternalProvider?.(info.id) ?? false
          try {
            const externalMeta = await manager.runtimes?.modelsForProvider?.(info.id)
            if (externalMeta) {
              const models = externalMeta.map((m) => ({
                provider: info.id,
                id: m.id,
                name: m.name,
                ...(m.isDefault ? { isDefault: true } : {}),
                ...(m.reasoningEfforts !== undefined
                  ? { reasoningEfforts: [...m.reasoningEfforts] }
                  : {}),
                ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}),
              }))
              return { provider: info.id, name: info.name, isExternal: true, models }
            }
            const rawModels = await ctx.llm.listModels(info.id)
            const models = await Promise.all(
              rawModels.map(async (m) => {
                if (typeof ctx.llm.resolveModelInfo !== 'function') return m
                const detail = await ctx.llm.resolveModelInfo(info.id, m.id).catch(() => undefined)
                if (!detail?.reasoning) return m
                const reasoningEfforts = detail.reasoning.efforts.map((e) => String(e.id)).filter(Boolean)
                const defaultEffort = detail.reasoning.defaultEffort
                  ? String(detail.reasoning.defaultEffort)
                  : undefined
                return {
                  ...m,
                  reasoningEfforts,
                  ...(defaultEffort ? { defaultEffort } : {}),
                }
              }),
            )
            return { provider: info.id, name: info.name, isExternal, models }
          } catch (err) {
            return {
              provider: info.id,
              name: info.name,
              isExternal,
              models: [],
              error: err instanceof Error ? err.message : String(err),
            }
          }
        }),
      )
      return ok({ ok: true, groups })
    },
  },
]
