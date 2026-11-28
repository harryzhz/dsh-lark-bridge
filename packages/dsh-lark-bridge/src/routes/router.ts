import type { Context } from '@deepseek-ai/cordis'
import type { LarkBridgeManager } from '../bridge-manager.js'
import type { LarkApiRequest, LarkApiResponse } from '../http-api.js'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * Mandatory declarative authorization policy for every Lark Bridge API route.
 * Omitting `policy` is a compile-time error; unrecognized values fail closed at runtime.
 */
export type RouteAuthPolicy =
  /** Web/Desktop owner session only (rejects CLI, Operator, and non-owner principals). */
  | 'owner'
  /** Owner Web/Desktop session OR local operator maintenance token (including dual CLI+operator). */
  | 'owner_or_operator'
  /** Read/check ops endpoints accessible to Owner Web, CLI Bearer, and Operator tokens. */
  | 'ops_read'
  /** Owner Web/Desktop session OR CLI Bearer token (rejects pure Operator and non-owner Web principals). */
  | 'owner_or_cli'
  /** Owner Web/Desktop session OR pure CLI Bearer token (rejects any Operator token, including dual headers). */
  | 'owner_or_cli_no_operator'

export interface ResolvedCallerAuth {
  readonly principalKind: string
  readonly isCliAuthenticated: boolean
  readonly isOperatorAuthenticated: boolean
  readonly isOwnerWebSession: boolean
  readonly isPureOperatorSession: boolean
  readonly isValidCaller: boolean
}

export interface LarkRouteContext {
  readonly ctx: Context
  readonly manager: LarkBridgeManager
  readonly request: LarkApiRequest
  readonly method: HttpMethod
  readonly url: URL
  readonly pathname: string
  readonly segments: readonly string[]
  readonly params: Readonly<Record<string, string>>
  readonly auth: ResolvedCallerAuth
}

export interface LarkRouteDefinition {
  readonly method: HttpMethod | readonly HttpMethod[]
  readonly pattern: string
  /** Required authorization policy — fail-closed by construction. */
  readonly policy: RouteAuthPolicy | ((url: URL) => RouteAuthPolicy)
  /** Optional custom error code when `'owner'` policy rejects a non-operator caller. */
  readonly deniedError?: string
  /** Optional HTTP body byte limit override for direct HTTP callers. */
  readonly maxBodyBytes?: number
  readonly handler: (context: LarkRouteContext) => Promise<LarkApiResponse> | LarkApiResponse
}

interface CompiledSegment {
  readonly kind: 'static' | 'param' | 'wildcard'
  readonly value: string
}

interface CompiledRoute {
  readonly method: HttpMethod
  readonly pattern: string
  readonly segments: readonly CompiledSegment[]
  readonly hasWildcard: boolean
  readonly specificity: number
  readonly definition: LarkRouteDefinition
}

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024
export const UPLOAD_MAX_BODY_BYTES = 25 * 1024 * 1024

export function ok(payload: unknown, status = 200): LarkApiResponse {
  return { status, payload }
}

export function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {}
}

export function resolveCallerAuth(request: Pick<
  LarkApiRequest,
  'principalKind' | 'isCliAuthenticated' | 'isOperatorAuthenticated'
>): ResolvedCallerAuth {
  const isCliAuthenticated = Boolean(request.isCliAuthenticated)
  const isOperatorAuthenticated = Boolean(request.isOperatorAuthenticated)
  const principalKind = request.principalKind
  const isOwnerWebSession =
    principalKind === 'owner' && !isCliAuthenticated && !isOperatorAuthenticated
  const isPureOperatorSession = isOperatorAuthenticated && !isCliAuthenticated
  const isValidCaller = isOwnerWebSession || isCliAuthenticated || isOperatorAuthenticated
  return {
    principalKind,
    isCliAuthenticated,
    isOperatorAuthenticated,
    isOwnerWebSession,
    isPureOperatorSession,
    isValidCaller,
  }
}

/**
 * Evaluate a route's declared `RouteAuthPolicy` with strict fail-closed semantics.
 * Returns `undefined` when authorized, or a `403` `LarkApiResponse` when denied.
 */
export function evaluateRoutePolicy(
  policy: RouteAuthPolicy,
  auth: ResolvedCallerAuth,
  deniedError?: string,
): LarkApiResponse | undefined {
  switch (policy) {
    case 'ops_read':
      if (!auth.isValidCaller) {
        return ok({ ok: false, error: 'forbidden' }, 403)
      }
      return undefined

    case 'owner_or_operator':
      if (auth.isOwnerWebSession || auth.isOperatorAuthenticated) {
        return undefined
      }
      return ok({ ok: false, error: 'owner_or_operator_required' }, 403)

    case 'owner':
      if (auth.isPureOperatorSession) {
        return ok({ ok: false, error: 'operator_scope_forbidden' }, 403)
      }
      if (!auth.isOwnerWebSession) {
        return ok({ ok: false, error: deniedError ?? 'owner_web_session_required' }, 403)
      }
      return undefined

    case 'owner_or_cli':
      if (auth.isPureOperatorSession) {
        return ok({ ok: false, error: 'operator_scope_forbidden' }, 403)
      }
      if (auth.isOwnerWebSession || auth.isCliAuthenticated) {
        return undefined
      }
      return ok({ ok: false, error: 'forbidden' }, 403)

    case 'owner_or_cli_no_operator':
      if (auth.isPureOperatorSession) {
        return ok({ ok: false, error: 'operator_scope_forbidden' }, 403)
      }
      if (auth.isOperatorAuthenticated) {
        return ok({ ok: false, error: 'owner_or_cli_required' }, 403)
      }
      if (auth.isOwnerWebSession || auth.isCliAuthenticated) {
        return undefined
      }
      return ok({ ok: false, error: 'forbidden' }, 403)

    default: {
      // Fail-closed guard for any unexpected/missing runtime policy value.
      const _exhaustive: never = policy
      void _exhaustive
      return ok({ ok: false, error: 'forbidden' }, 403)
    }
  }
}

export function normalizeApiRouteLabel(method: string, segments: readonly string[]): string {
  if (segments.length === 0) return `${method} /health`
  const [s0, s1] = segments
  if (s0 === 'cockpit' || s0 === 'overview') return `${method} /cockpit`
  if (s0 === 'observability') {
    return s1 === 'checkpoint' ? `${method} /observability/checkpoint` : `${method} /observability`
  }
  if (s0 === 'memory') return `${method} /memory`
  if (
    s0 === 'bindings' ||
    s0 === 'events' ||
    s0 === 'bots' ||
    s0 === 'groups' ||
    s0 === 'reminders' ||
    s0 === 'schedules' ||
    s0 === 'diagnostics' ||
    s0 === 'runtimes' ||
    s0 === 'models'
  ) {
    return segments.length > 1 ? `${method} /${s0}/:id` : `${method} /${s0}`
  }
  if (s0 === 'generate-prompt') return `${method} /generate-prompt`
  if (s0 === 'plugins' && s1) return `${method} /plugins/${s1}`
  if (s0 === 'lifecycle' && s1) return `${method} /lifecycle/${s1}`
  if (s0 === 'auth' && s1) return `${method} /auth/${s1}`
  if (s0 === 'agent' && s1) return `${method} /agent/${s1}`
  return `${method} /${s0}`
}

function parsePattern(pattern: string): {
  segments: CompiledSegment[]
  hasWildcard: boolean
  specificity: number
  signature: string
} {
  const cleaned = pattern.replace(/^\/+/, '').replace(/\/+$/, '')
  if (!cleaned) {
    return { segments: [], hasWildcard: false, specificity: 1000, signature: '/' }
  }
  const rawParts = cleaned.split('/')
  const segments: CompiledSegment[] = []
  let hasWildcard = false
  let specificity = 0

  for (let i = 0; i < rawParts.length; i += 1) {
    const part = rawParts[i]!
    if (part.startsWith('*')) {
      if (i !== rawParts.length - 1) {
        throw new Error(`Wildcard segment "${part}" must be the final segment in "${pattern}"`)
      }
      const name = part.slice(1).trim()
      if (!name) {
        throw new Error(`Wildcard segment must have a parameter name in "${pattern}"`)
      }
      hasWildcard = true
      segments.push({ kind: 'wildcard', value: name })
      specificity += 1
    } else if (part.startsWith(':')) {
      const name = part.slice(1).trim()
      if (!name) {
        throw new Error(`Param segment must have a parameter name in "${pattern}"`)
      }
      segments.push({ kind: 'param', value: name })
      specificity += 10
    } else {
      segments.push({ kind: 'static', value: part })
      specificity += 100
    }
  }

  const signature = `/${segments
    .map((s) => (s.kind === 'static' ? s.value : s.kind === 'param' ? ':param' : '*wildcard'))
    .join('/')}`

  return { segments, hasWildcard, specificity, signature }
}

function matchCompiledRoute(
  route: CompiledRoute,
  segments: readonly string[],
): Record<string, string> | undefined {
  if (!route.hasWildcard && route.segments.length !== segments.length) {
    return undefined
  }
  if (route.hasWildcard && segments.length < route.segments.length) {
    return undefined
  }

  const params: Record<string, string> = {}
  for (let i = 0; i < route.segments.length; i += 1) {
    const seg = route.segments[i]!
    if (seg.kind === 'wildcard') {
      const rest = segments.slice(i).join('/')
      if (!rest) return undefined
      params[seg.value] = rest
      return params
    }
    const actual = segments[i]
    if (actual === undefined || actual.length === 0) return undefined
    if (seg.kind === 'static') {
      if (actual !== seg.value) return undefined
    } else {
      params[seg.value] = actual
    }
  }
  return params
}

export class LarkDeclarativeRouter {
  private readonly routesByMethod = new Map<HttpMethod, CompiledRoute[]>()
  readonly definitions: readonly LarkRouteDefinition[]

  constructor(definitions: readonly LarkRouteDefinition[]) {
    this.definitions = definitions
    const seen = new Set<string>()
    for (const def of definitions) {
      const methods = Array.isArray(def.method) ? def.method : [def.method]
      const parsed = parsePattern(def.pattern)
      for (const method of methods) {
        const key = `${method} ${parsed.signature}`
        if (seen.has(key)) {
          throw new Error(`Duplicate route registration detected: ${key} (pattern: "${def.pattern}")`)
        }
        seen.add(key)
        const list = this.routesByMethod.get(method) ?? []
        list.push({
          method,
          pattern: def.pattern,
          segments: parsed.segments,
          hasWildcard: parsed.hasWildcard,
          specificity: parsed.specificity,
          definition: def,
        })
        this.routesByMethod.set(method, list)
      }
    }

    for (const list of this.routesByMethod.values()) {
      list.sort((a, b) => {
        if (b.specificity !== a.specificity) return b.specificity - a.specificity
        return b.segments.length - a.segments.length
      })
    }
  }

  match(
    method: string,
    segments: readonly string[],
  ): { readonly definition: LarkRouteDefinition; readonly params: Record<string, string> } | undefined {
    const candidates = this.routesByMethod.get(method.toUpperCase() as HttpMethod)
    if (!candidates) return undefined
    for (const route of candidates) {
      const params = matchCompiledRoute(route, segments)
      if (params) {
        return { definition: route.definition, params }
      }
    }
    return undefined
  }

  resolveMaxBodyBytes(method: string, rawPath: string): number {
    try {
      const normalized = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
      const url = new URL(normalized, 'http://127.0.0.1')
      const pathname = url.pathname.replace(/^\/api\/lark-bridge\/?/, '').replace(/^\/+/, '')
      const segments = pathname ? pathname.split('/').map(decodeURIComponent) : []
      const matched = this.match(method, segments)
      return matched?.definition.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
    } catch {
      return DEFAULT_MAX_BODY_BYTES
    }
  }

  async dispatch(
    ctx: Context,
    manager: LarkBridgeManager,
    request: LarkApiRequest,
    parsed: {
      readonly method: HttpMethod
      readonly url: URL
      readonly pathname: string
      readonly segments: readonly string[]
    },
  ): Promise<LarkApiResponse> {
    const auth = resolveCallerAuth(request)
    const matched = this.match(parsed.method, parsed.segments)
    if (!matched) {
      return ok({ ok: false, error: 'not_found' }, 404)
    }

    const resolvedPolicy =
      typeof matched.definition.policy === 'function'
        ? matched.definition.policy(parsed.url)
        : matched.definition.policy
    const denied = evaluateRoutePolicy(
      resolvedPolicy,
      auth,
      matched.definition.deniedError,
    )
    if (denied) {
      return denied
    }

    return await matched.definition.handler({
      ctx,
      manager,
      request,
      method: parsed.method,
      url: parsed.url,
      pathname: parsed.pathname,
      segments: parsed.segments,
      params: matched.params,
      auth,
    })
  }
}
