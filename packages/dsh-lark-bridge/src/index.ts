import { homedir, networkInterfaces } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'
import { LarkBridgeManager } from './bridge-manager.js'
import {
  LARK_BRIDGE_RPC_PATH,
  createLarkConnectionRpcHandler,
  createLarkHttpHandler,
  createLarkNavigationRequestHandler,
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
  maxAuditEvents: z.number().min(20).max(10_000).default(2000),
  autoInstallCliAndSkill: z.boolean().default(true),
  syncGlobalCliAndSkill: z.boolean(),
  maxConcurrentTurnsPerRuntime: z.number().min(0).max(32).default(3),
}) as z<Partial<LarkBridgeConfig>, LarkBridgeConfig>

export async function apply(ctx: Context, rawConfig: LarkBridgeConfig): Promise<void> {
  const config: LarkBridgeConfig = {
    ...rawConfig,
    dataDir: rawConfig.dataDir?.trim() || defaultDataDir(),
    publicBaseUrl: rawConfig.publicBaseUrl?.trim() || '',
  }

  const store = new LarkBridgeStore(config.dataDir, config.maxAuditEvents)
  const manager = new LarkBridgeManager(ctx, config, store)

  ctx.effect(
    () => async () => {
      try {
        await manager.stop()
      } finally {
        store.close()
      }
    },
    'dsh-lark-bridge.lifecycle',
  )

  // Acquire the per-dataDir instance lock BEFORE mounting HTTP/RPC routes or writing
  // `cli-endpoint.json` so a conflicting secondary process (e.g. Desktop + Web sharing
  // the same `DSH_HOME`) never overwrites the live instance's CLI endpoint metadata.
  await manager.acquireInstanceLock()

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
    const mountHttpSurface = (routeCtx: typeof webCtx): void => {
      try {
        const origin = routeCtx.webServer.getOrigin()
        if (origin) manager.bindLiveWebOrigin(origin, routeCtx.connection, routeCtx.webServer)
      } catch {
        // Listener may not expose an origin on unusual bind addresses.
      }

      // DSH 0.2.3-alpha.2+: handle GET/HEAD top-level navigations (`/open`, `/console-login`)
      // in `webserver/request` before outer `webserver/authorize` rejects cross-site clicks from
      // Feishu Web (`Sec-Fetch-Site: cross-site`). No-op on 0.2.2-rc.5 where the event does not fire.
      const navigationInterceptor = createLarkNavigationRequestHandler(routeCtx.connection, manager)
      const routeCtxEvents = routeCtx as unknown as {
        on?: (
          event: string,
          listener: (
            req: IncomingMessage,
            res: ServerResponse,
            next: () => Promise<void>,
          ) => Promise<void>,
        ) => void
      }
      routeCtxEvents.on?.('webserver/request', navigationInterceptor)

      const handler = createLarkHttpHandler(routeCtx, routeCtx.connection, manager)
      // DSH 0.2.3-alpha.2+ defaults route auth to `'required'`, which enforces DSH browser cookie
      // auth before entering plugin handlers and blocks CLI Bearer / Operator tokens with HTTP 401.
      // Declaring `auth: 'anonymous'` preserves outer Host/Origin trust checks while delegating
      // fail-closed credential verification (`cliAuth` / `operatorAuth` / `connection.admit`) to the plugin.
      const route = {
        kind: 'prefix',
        path: '/api/lark-bridge',
        auth: 'anonymous',
        handler,
      } as WebRoute
      routeCtx.effect(
        () => routeCtx.webServer.register(route),
        'dsh-lark-bridge.http-api',
      )
    }

    // DSH 0.2.3-alpha.2+ splits credential verification into Cordis sub-service `connection.authentication`.
    // Calling `connection.admit(req)` through the Cordis service proxy reads `this.authentication`,
    // which throws under Cordis 4.2 unless `connection.authentication` is explicitly declared in `inject`.
    if (webCtx.get('connection.authentication' as never) !== undefined) {
      ;(webCtx.inject as (deps: readonly string[], cb: (subCtx: typeof webCtx) => void) => void)(
        ['webServer', 'connection', 'connection.authentication'],
        (authCtx) => {
          mountHttpSurface(authCtx)
        },
      )
    } else {
      mountHttpSurface(webCtx)
    }
  })

  await manager.start()
}

export { LarkBridgeManager, type AgentCliSendInput } from './bridge-manager.js'
export { AgentToolFacade, type AgentToolFacadeHost } from './agent-tool-facade.js'
export {
  BotConnectionPool,
  type BotConnectionPoolHost,
  type ManagedTransport,
} from './bot-connection-pool.js'
export {
  InboundPipeline,
  type ActiveTurnRecord,
  type InboundPipelineHost,
} from './inbound-pipeline.js'
export {
  DEFAULT_MAX_CONCURRENT_TURNS_PER_RUNTIME,
  RuntimeConcurrencyLimiter,
  normalizeRuntimeConcurrencyKey,
  type ConcurrencyAcquireOptions,
  type ConcurrencyLease,
  type ConcurrencyPriority,
  type RuntimeConcurrencyBucketStats,
  type RuntimeConcurrencyStats,
} from './runtime-concurrency.js'
export {
  DEFAULT_MAX_DEBOUNCE_BATCH,
  ListenerDebounceBuffer,
  MAX_DEBOUNCE_WINDOW_CAP_MS,
  type DebouncedListenerEntry,
} from './listener-debounce.js'
export {
  SessionActor,
  SessionCoordinator,
  type AcquiredAgent,
  type AgentDecision,
  type SessionActorState,
  type SessionCoordinatorHost,
} from './session-coordinator.js'
export { SessionTitleGuard } from './session-title-guard.js'
export {
  OPERATOR_TOKEN_FILENAME,
  OPERATOR_TOKEN_HEADER,
  buildCliWrapperContent,
  ensureCliAuthEndpoint,
  ensureOperatorAuth,
  installLocalCliAndSkill,
  isDefaultDshHomeDataDir,
  resolveBundledAssetPaths,
  type BundledAssetPaths,
  type CliAuthEndpoint,
  type EnsureCliAuthOptions,
  type InstallLocalCliOptions,
  type OperatorAuthToken,
} from './cli-support.js'
export { DreamingService, type DreamingHost } from './dreaming-service.js'
export { MemoryService, type MemoryMutationTracker } from './memory-service.js'
export {
  MANAGED_PLUGINS,
  PluginUpdateService,
  RUNNING_BRIDGE_VERSION,
  classifySourceSpec,
  compareSemver,
  holdClientModulesDuringSwap,
  isNewerVersion,
  normalizeVersion,
  parseSemver,
  parseSha256Sums,
  recordManagedPackageMove,
  relocateStaleModuleUrl,
  resetGlobalPluginUpdateStateForTest,
  type FetchLike,
  type HostBundleInfoLike,
  type HostChangeResultLike,
  type HostHmrLike,
  type HostPluginManagerLike,
  type HostProfileContextLike,
  type ManagedPluginId,
  type ManagedPluginSpec,
  type ManagedPluginStatus,
  type PluginSourceKind,
  type PluginUpdateFailureCode,
  type PluginUpdateItemResult,
  type PluginUpdateLifecycleHost,
  type PluginUpdateOpStatus,
  type PluginUpdateOperation,
  type PluginUpdateServiceOptions,
  type PluginUpdatesOverview,
  type ReleaseInfo,
  type StartPluginUpdateOptions,
} from './plugin-updater.js'
export {
  MemoryRepo,
  type MemoryQueryOptions,
  type MemorySupersedeOutcome,
  type MemoryUpdateInput,
  type MemoryUpsertInput,
  type MemoryUpsertOutcome,
} from './storage/memory-repo.js'
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
  createLarkNavigationRequestHandler,
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
  EXTERNAL_LAUNCH_RECORD_TYPE,
  RuntimeCatalog,
  type AgentLaunchInput,
  type ExposedExternalPresetSummary,
  type ExternalLaunchRecord,
  type ExternalRuntimeAuthMethod,
  type ExternalRuntimeSummary,
  type ResolvedAgentLaunch,
  type RuntimeOption,
  type RuntimeProfileCapabilities,
  type RuntimeProfileInput,
  type RuntimeProfileSummary,
} from './runtime-catalog.js'
export { ScheduleNotifier, formatScheduleRuleSummary } from './schedule-notifier.js'
export {
  DEFAULT_CONSOLE_LOGIN_TTL_MS,
  LARK_CONSOLE_LOGIN_PATH,
  ConsoleLoginHandoff,
  handleConsoleLogin,
  renderConsoleLoginConfirmHtml,
  renderConsoleLoginDeniedHtml,
  type ConsoleLoginTicket,
  type IssuedConsoleLoginLink,
} from './console-login.js'
export {
  LARK_SESSION_OPEN_PATH,
  LoopbackSessionHandoff,
  focusDesktopApp,
  handleLoopbackSessionOpen,
  handleSessionOpen,
  isLoopbackHostname,
  isLoopbackOrigin,
  isLoopbackRemoteAddress,
  renderDesktopOpenedHtml,
  renderSessionBounceHtml,
  renderViewerDeniedHtml,
  type DesktopOpenCommand,
  type LoopbackConnectionAuth,
  type SessionViewerRenderer,
} from './session-handoff.js'
export {
  LARK_VIEWER_GLOBAL_ROLE,
  LARK_VIEWER_PRINCIPAL_KIND,
  LARK_VIEWER_SESSION_READ_ROLE,
  LARK_VIEWER_WORKSPACE_ROLE,
  LARK_VIEW_RPC_PATH,
  LARK_VIEW_STREAM_PATH,
  LarkSessionViewerService,
  renderViewerCarrierScript,
  transformViewerIndexHtml,
  type LarkViewerPrincipal,
  type ViewerCarrierScriptOptions,
} from './session-viewer.js'
export {
  buildBridgeDiagnostics,
  buildDiagnosticAlerts,
  isNodeVersionSqliteReady,
  runOfflineDoctor,
  type BotDiagnosticItem,
  type BridgeDiagnosticsPayload,
  type OfflineDoctorReport,
} from './diagnostics.js'
export {
  INSTANCE_LOCK_FILENAME,
  InstanceLock,
  InstanceLockConflictError,
  type CoordinationBackend,
  type InstanceLockPayload,
  type InstanceLockStatus,
} from './instance-lock.js'
export { SplitBrainDetector, type SplitBrainAlert } from './split-brain-detector.js'
export { LarkBridgeStore } from './store.js'
export {
  BridgeDatabase,
  CONFIG_SNAPSHOT_FILENAME,
  DB_FILENAME,
  LEGACY_STATE_FILENAME,
  type AppliedMigrationRecord,
  type IntegrityCheckResult,
  type StorageStats,
} from './storage/database.js'
export {
  exportDbToV3Json,
  migrateLegacyJsonToSqlite,
  parseLegacyStatePayload,
  rollbackDbFromJson,
  verifyDbAgainstJson,
  type CrossVerifyReport,
  type MigrationVerificationReport,
  type PersistedStateV3,
  type RollbackResult,
} from './storage/legacy-migrator.js'
export { runDbCliCommand, inspectInstanceLockFile, type ActiveLockSummary, type DbCliResult } from './storage/db-cli.js'
export {
  MAX_AUTO_RESUME_AGE_MS,
  MAX_AUTO_RESUME_ATTEMPTS,
  MAX_AUTO_RESUME_TOTAL_AGE_MS,
  MAX_GRACEFUL_AUTO_RESUME_ATTEMPTS,
  canAutoResumePendingTurn,
  composeRestartRecoveryReminder,
  inspectPersistedTurnCompletion,
  type AutoResumeEligibilityOptions,
  type PersistedTurnInspection,
} from './turn-recovery.js'
export {
  TurnAbortedError,
  TurnFinalReplyTracker,
  detectRuntimeExecutorErrorBanner,
  runTurnAndCollectReply,
  type RunTurnOptions,
  type TurnAbortKind,
  type TurnReplyTrackerOptions,
} from './turn-runner.js'
export {
  LARK_ORIGIN_RECORD_TYPE,
  type ActiveTurnSummary,
  type BridgeLifecyclePhase,
  type BridgeLifecycleStatus,
  type LarkAuditEvent,
  type LarkBridgeConfig,
  type LarkCockpitPayload,
  type LarkCockpitSummary,
  type LarkDreamRunState,
  type LarkDreamSession,
  type LarkGroupView,
  type LarkManagedSession,
  type LarkOriginRecord,
  type LarkPendingTurn,
  type LarkScheduleBinding,
  type LarkScheduleView,
  type LarkSessionBinding,
  type PendingTurnInterruptKind,
  type PendingTurnStatus,
} from './types.js'
