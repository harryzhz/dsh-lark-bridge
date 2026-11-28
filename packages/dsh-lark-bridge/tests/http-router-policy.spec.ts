import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { LarkBridgeManager } from '../src/bridge-manager.js'
import { dispatchLarkApiRequest } from '../src/http-api.js'
import {
  ALL_LARK_ROUTES,
  DEFAULT_MAX_BODY_BYTES,
  LARK_API_ROUTER,
  LarkDeclarativeRouter,
  UPLOAD_MAX_BODY_BYTES,
  evaluateRoutePolicy,
  resolveCallerAuth,
  type RouteAuthPolicy,
} from '../src/routes/index.js'

function samplePathForPattern(pattern: string): string {
  return pattern
    .replace(/\*[A-Za-z0-9_]+/g, 'bot_a/chat_1/thread_1')
    .replace(/:[A-Za-z0-9_]+/g, 'sample_id')
}

function makeStubManager() {
  const timings: string[] = []
  return {
    timings,
    manager: {
      recordApiTiming: vi.fn((label: string) => {
        timings.push(label)
      }),
    } as unknown as LarkBridgeManager,
  }
}

describe('declarative HTTP router and fail-closed route policy table', () => {
  it('registers every route with a valid explicit policy and zero duplicate signatures', () => {
    const validPolicies = new Set<RouteAuthPolicy>([
      'owner',
      'owner_or_operator',
      'ops_read',
      'owner_or_cli',
      'owner_or_cli_no_operator',
    ])
    expect(ALL_LARK_ROUTES.length).toBeGreaterThanOrEqual(80)
    for (const def of ALL_LARK_ROUTES) {
      const resolved =
        typeof def.policy === 'function'
          ? def.policy(new URL(`http://127.0.0.1${samplePathForPattern(def.pattern)}`))
          : def.policy
      expect(validPolicies.has(resolved)).toBe(true)
      expect(typeof def.handler).toBe('function')
    }
    expect(() => new LarkDeclarativeRouter(ALL_LARK_ROUTES)).not.toThrow()
  })

  it('rejects duplicate route registrations at router construction time', () => {
    expect(
      () =>
        new LarkDeclarativeRouter([
          { method: 'GET', pattern: '/items/:id', policy: 'owner', handler: () => ({ status: 200, payload: {} }) },
          { method: 'GET', pattern: '/items/:otherId', policy: 'owner', handler: () => ({ status: 200, payload: {} }) },
        ]),
    ).toThrow(/Duplicate route registration/)
  })

  it('prioritizes static segments over parameter segments and captures wildcard routeKey', () => {
    const autoCreate = LARK_API_ROUTER.match('POST', ['bots', 'auto-create'])
    expect(autoCreate?.definition.pattern).toBe('/bots/auto-create')

    const forceUpdate = LARK_API_ROUTER.match('POST', ['plugins', 'update', 'force'])
    expect(forceUpdate?.definition.pattern).toBe('/plugins/update/force')

    const unbind = LARK_API_ROUTER.match('DELETE', ['bindings', 'bot_1', 'oc_chat', 'om_thread'])
    expect(unbind?.definition.pattern).toBe('/bindings/*routeKey')
    expect(unbind?.params.routeKey).toBe('bot_1/oc_chat/om_thread')

    // Trailing extra segments must not match fixed-length routes.
    expect(LARK_API_ROUTER.match('POST', ['bots', 'bot_1', 'toggle', 'extra'])).toBeUndefined()
    expect(LARK_API_ROUTER.match('GET', ['lifecycle', 'status', 'extra'])).toBeUndefined()
  })

  it('resolves body size limits declaratively from matched routes', () => {
    expect(LARK_API_ROUTER.resolveMaxBodyBytes('POST', '/api/lark-bridge/agent/send')).toBe(
      UPLOAD_MAX_BODY_BYTES,
    )
    expect(LARK_API_ROUTER.resolveMaxBodyBytes('POST', '/api/lark-bridge/bots')).toBe(
      DEFAULT_MAX_BODY_BYTES,
    )
  })

  it('fails closed at runtime if an unknown or missing policy is ever passed', () => {
    const ownerAuth = resolveCallerAuth({
      principalKind: 'owner',
      isCliAuthenticated: false,
      isOperatorAuthenticated: false,
    })
    const unknownPolicyResult = evaluateRoutePolicy(
      'unrecognized_policy' as unknown as RouteAuthPolicy,
      ownerAuth,
    )
    expect(unknownPolicyResult).toEqual({
      status: 403,
      payload: { ok: false, error: 'forbidden' },
    })

    const missingPolicyResult = evaluateRoutePolicy(
      undefined as unknown as RouteAuthPolicy,
      ownerAuth,
    )
    expect(missingPolicyResult).toEqual({
      status: 403,
      payload: { ok: false, error: 'forbidden' },
    })
  })

  it('fails closed (403) across EVERY registered route for non-owner unauthenticated web principals (e.g. viewer)', async () => {
    const { manager } = makeStubManager()
    const ctx = {} as Context

    for (const def of ALL_LARK_ROUTES) {
      const methods = Array.isArray(def.method) ? def.method : [def.method]
      const samplePath = samplePathForPattern(def.pattern)
      for (const method of methods) {
        const res = await dispatchLarkApiRequest(ctx, manager, {
          method,
          path: samplePath,
          isCliAuthenticated: false,
          isOperatorAuthenticated: false,
          principalKind: 'viewer',
        })
        expect(res.status, `${method} ${def.pattern} should reject viewer`).toBe(403)
        expect((res.payload as { ok?: boolean }).ok).toBe(false)
      }
    }
  })

  it('enforces exact error codes across principal matrices', async () => {
    const { manager } = makeStubManager()
    const ctx = {} as Context

    // Pure operator hitting non-ops route -> operator_scope_forbidden
    const opOnBots = await dispatchLarkApiRequest(ctx, manager, {
      method: 'POST',
      path: '/bots',
      isCliAuthenticated: false,
      isOperatorAuthenticated: true,
      principalKind: 'operator',
    })
    expect(opOnBots).toEqual({
      status: 403,
      payload: { ok: false, error: 'operator_scope_forbidden' },
    })

    // CLI hitting desktop channel -> owner_session_required (preserving exact code)
    const cliOnDesktop = await dispatchLarkApiRequest(ctx, manager, {
      method: 'GET',
      path: '/desktop/open-wait',
      isCliAuthenticated: true,
      principalKind: 'cli',
    })
    expect(cliOnDesktop).toEqual({
      status: 403,
      payload: { ok: false, error: 'owner_session_required' },
    })

    // CLI hitting owner_or_operator route -> owner_or_operator_required
    const cliOnDrain = await dispatchLarkApiRequest(ctx, manager, {
      method: 'POST',
      path: '/lifecycle/drain',
      isCliAuthenticated: true,
      principalKind: 'cli',
    })
    expect(cliOnDrain).toEqual({
      status: 403,
      payload: { ok: false, error: 'owner_or_operator_required' },
    })

    // Dual CLI+Operator hitting owner_or_cli_no_operator route -> owner_or_cli_required
    const dualOnAgentSchedule = await dispatchLarkApiRequest(ctx, manager, {
      method: 'DELETE',
      path: '/agent/schedules/sched-1',
      isCliAuthenticated: true,
      isOperatorAuthenticated: true,
      principalKind: 'operator',
    })
    expect(dualOnAgentSchedule).toEqual({
      status: 403,
      payload: { ok: false, error: 'owner_or_cli_required' },
    })

    // Unregistered path -> 404 not_found
    const unknown = await dispatchLarkApiRequest(ctx, manager, {
      method: 'GET',
      path: '/does-not-exist',
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(unknown).toEqual({
      status: 404,
      payload: { ok: false, error: 'not_found' },
    })
  })

  it('returns 400 and records invalid route label on malformed percent-encoding', async () => {
    const { manager, timings } = makeStubManager()
    const ctx = {} as Context
    const res = await dispatchLarkApiRequest(ctx, manager, {
      method: 'GET',
      path: '/bots/%E0%A4%A',
      isCliAuthenticated: false,
      principalKind: 'owner',
    })
    expect(res.status).toBe(400)
    expect((res.payload as { ok?: boolean }).ok).toBe(false)
    expect(timings).toContain('GET /invalid')
  })
})
