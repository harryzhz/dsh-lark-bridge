import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'
import { LarkBridgeManager } from './bridge-manager.js'
import {
  LARK_BRIDGE_RPC_PATH,
  createLarkConnectionRpcHandler,
  createLarkHttpHandler,
} from './http-api.js'
import { LarkBridgeStore } from './store.js'
import type { LarkBridgeConfig } from './types.js'

export const name = 'dsh-lark-bridge'

export const inject = ['agents', 'sessions', 'llm'] as const

function defaultDataDir(): string {
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(dshHome, 'lark-bridge')
}

export function detectDefaultPublicBaseUrl(defaultPort = 3880): string {
  const ifaces = networkInterfaces()
  for (const list of Object.values(ifaces)) {
    for (const addr of list ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return `http://${addr.address}:${defaultPort}`
      }
    }
  }
  return `http://127.0.0.1:${defaultPort}`
}

export const Config: z<Partial<LarkBridgeConfig>, LarkBridgeConfig> = z.object({
  dataDir: z.string().default(''),
  publicBaseUrl: z.string().default(''),
  idleSweepIntervalMs: z.number().min(0).default(5 * 60_000),
  maxAuditEvents: z.number().min(20).max(2000).default(200),
  autoInstallCliAndSkill: z.boolean().default(true),
}) as z<Partial<LarkBridgeConfig>, LarkBridgeConfig>

export async function apply(ctx: Context, rawConfig: LarkBridgeConfig): Promise<void> {
  const config: LarkBridgeConfig = {
    ...rawConfig,
    dataDir: rawConfig.dataDir?.trim() || defaultDataDir(),
    publicBaseUrl: rawConfig.publicBaseUrl?.trim() || '',
  }

  const store = new LarkBridgeStore(config.dataDir, config.maxAuditEvents)
  const manager = new LarkBridgeManager(ctx, config, store)

  ctx.effect(() => () => manager.stop(), 'dsh-lark-bridge.lifecycle')

  // 1. Register carrier-independent `/api/lark-bridge-rpc` exact Fetch route on DSH Connection
  //    so both DSH Web and DSH Electron Desktop UI (`file://` + `__DSH_TRANSPORT__`) communicate
  //    through the authenticated owner channel without CORS or origin issues.
  ctx.inject(['connection'], (connCtx) => {
    const fetchRegistry = connCtx.connection?.fetch
    if (!fetchRegistry || typeof fetchRegistry.register !== 'function') return
    const rpcFetch = createLarkConnectionRpcHandler(connCtx, manager)
    connCtx.effect(
      () =>
        fetchRegistry.register({
          path: LARK_BRIDGE_RPC_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: rpcFetch,
        }),
      'dsh-lark-bridge.connection-rpc',
    )
  })

  // 2. Register `/api/lark-bridge` HTTP route for `lark-bridge` CLI (Bearer token), loopback
  //    Desktop session handoff (`/api/lark-bridge/open`), and sync the live listener origin
  //    (including Desktop's OS-assigned port) into `cli-endpoint.json`.
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    try {
      const origin = webCtx.webServer.getOrigin()
      if (origin) manager.bindLiveWebOrigin(origin, webCtx.connection)
    } catch {
      // Listener may not expose an origin on unusual bind addresses.
    }
    const handler = createLarkHttpHandler(webCtx, webCtx.connection, manager)
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: '/api/lark-bridge',
          handler,
        }),
      'dsh-lark-bridge.http-api',
    )
  })

  await manager.start()
}

export { LarkBridgeManager } from './bridge-manager.js'
export {
  buildCliWrapperContent,
  ensureCliAuthEndpoint,
  installLocalCliAndSkill,
  resolveBundledAssetPaths,
  type BundledAssetPaths,
  type CliAuthEndpoint,
} from './cli-support.js'
export { DreamingService, type DreamingHost } from './dreaming-service.js'
export {
  browseHostDirectories,
  createHostSubdirectory,
  type DirectoryBrowseResult,
  type DirectoryCrumb,
} from './fs-browser.js'
export {
  LARK_BRIDGE_RPC_ENDPOINT,
  LARK_BRIDGE_RPC_PATH,
  createLarkConnectionRpcHandler,
  createLarkHttpHandler,
  dispatchLarkApiRequest,
  type ConnectionAdmitter,
  type LarkApiRequest,
  type LarkApiResponse,
} from './http-api.js'
export {
  ProactiveReminderService,
  parseReminderTargetIso,
  type CreateReminderInput,
  type ReminderServiceHost,
  type UpdateReminderInput,
} from './reminder-service.js'
export {
  RuntimeCatalog,
  type AgentLaunchInput,
  type ExternalRuntimeSummary,
  type ResolvedAgentLaunch,
  type RuntimeOption,
} from './runtime-catalog.js'
export { ScheduleNotifier, formatScheduleRuleSummary } from './schedule-notifier.js'
export {
  LARK_SESSION_OPEN_PATH,
  LoopbackSessionHandoff,
  focusDesktopApp,
  handleLoopbackSessionOpen,
  isLoopbackHostname,
  isLoopbackOrigin,
  isLoopbackRemoteAddress,
  renderDesktopOpenedHtml,
  renderSessionBounceHtml,
  type DesktopOpenCommand,
  type LoopbackConnectionAuth,
} from './session-handoff.js'
export { LarkBridgeStore } from './store.js'
export {
  LARK_ORIGIN_RECORD_TYPE,
  type LarkAuditEvent,
  type LarkBridgeConfig,
  type LarkCockpitPayload,
  type LarkCockpitSummary,
  type LarkDreamRunState,
  type LarkGroupView,
  type LarkManagedSession,
  type LarkOriginRecord,
  type LarkScheduleBinding,
  type LarkScheduleView,
  type LarkSessionBinding,
} from './types.js'
