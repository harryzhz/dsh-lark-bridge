import { agentRoutes } from './agent.js'
import { authRoutes } from './auth.js'
import { automationRoutes } from './automation.js'
import { botRoutes } from './bots.js'
import { groupRoutes } from './groups.js'
import { memoryRoutes } from './memory.js'
import { opsRoutes } from './ops.js'
import { LarkDeclarativeRouter, type LarkRouteDefinition } from './router.js'
import { runtimeAndFsRoutes } from './runtime-and-fs.js'
import { sessionRoutes } from './sessions.js'

export {
  DEFAULT_MAX_BODY_BYTES,
  LarkDeclarativeRouter,
  UPLOAD_MAX_BODY_BYTES,
  bodyRecord,
  evaluateRoutePolicy,
  normalizeApiRouteLabel,
  ok,
  resolveCallerAuth,
  type HttpMethod,
  type LarkRouteContext,
  type LarkRouteDefinition,
  type ResolvedCallerAuth,
  type RouteAuthPolicy,
} from './router.js'

export const ALL_LARK_ROUTES: readonly LarkRouteDefinition[] = [
  ...opsRoutes,
  ...agentRoutes,
  ...authRoutes,
  ...memoryRoutes,
  ...botRoutes,
  ...groupRoutes,
  ...sessionRoutes,
  ...automationRoutes,
  ...runtimeAndFsRoutes,
]

export const LARK_API_ROUTER = new LarkDeclarativeRouter(ALL_LARK_ROUTES)
