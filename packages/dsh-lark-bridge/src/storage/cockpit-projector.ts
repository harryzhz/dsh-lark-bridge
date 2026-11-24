import {
  DEFAULT_TRIAGE_SYSTEM_PROMPT,
  LarkGroupConfigSchema,
  ROUTE_MESSAGE_TOOL_SCHEMA,
  TRIAGE_PROMPT_VARIABLES,
  TRIAGE_TOOL_NAME,
  buildGroupKey,
  expandWorkingDir,
  resolveEffectiveAgentRuntime,
  resolveEffectiveWorkingDir,
  resolveEffectiveWorkspaceName,
  type LarkBotConfig,
  type LarkBotStatus,
  type LarkGroupConfig,
} from '@dsh-lark/lark-core'
import type {
  LarkCockpitPayload,
  LarkDreamSession,
  LarkGroupView,
  LarkSessionBinding,
  LarkTriageSession,
} from '../types.js'
import type { ConfigRepo } from './config-repo.js'
import type { RuntimeRepo } from './runtime-repo.js'
import { formatHourKey, type TelemetryRepo } from './telemetry-repo.js'

function calcStats(values: readonly number[]): { avg: number; p95: number } {
  if (values.length === 0) return { avg: 0, p95: 0 }
  const sum = values.reduce((a, b) => a + b, 0)
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
  return {
    avg: Math.round(sum / values.length),
    p95: Math.round(sorted[idx] ?? 0),
  }
}

/**
 * Pure read-model projection layer separating UI cockpit/view composition
 * from low-level SQLite repositories.
 */
export class CockpitProjector {
  constructor(
    private readonly config: ConfigRepo,
    private readonly runtime: RuntimeRepo,
    private readonly telemetry: TelemetryRepo,
  ) {}

  resolveBotWorkspaceName(bot: LarkBotConfig): string {
    const explicitSelf = bot.workspaceName.trim()
    if (explicitSelf) return explicitSelf
    const targetDir = expandWorkingDir(bot.defaultWorkingDir) || bot.defaultWorkingDir
    const explicitPeer = this.findExplicitWorkspaceNameForDir(targetDir)
    if (explicitPeer) return explicitPeer
    return resolveEffectiveWorkspaceName(bot)
  }

  resolveGroupWorkspaceName(
    bot: LarkBotConfig,
    group?: LarkGroupConfig,
    _fallbackChatName?: string,
  ): string {
    const explicitSelf = group?.workspaceName?.trim()
    if (explicitSelf) return explicitSelf
    const targetDir = resolveEffectiveWorkingDir(bot, group)
    const explicitPeer = this.findExplicitWorkspaceNameForDir(targetDir)
    if (explicitPeer) return explicitPeer
    return resolveEffectiveWorkspaceName(bot, group)
  }

  listBindings(): LarkSessionBinding[] {
    const botsById = new Map(this.config.listBots().map((b) => [b.id, b]))
    const groupsByKey = new Map(this.config.listGroups().map((g) => [g.key, g]))
    const discovered = this.config.getDiscoveredChats()

    return this.runtime.listRawBindings().map((b) => {
      const gKey = buildGroupKey(b.botId, b.chatId)
      const bot = botsById.get(b.botId)
      const grp = groupsByKey.get(gKey)
      const disc = discovered.get(gKey)
      const isP2p = b.chatType === 'p2p' || b.trigger === 'p2p'
      const resolvedChatName = b.chatName || grp?.chatName || disc?.name
      const resolvedWorkspaceName = bot
        ? isP2p
          ? this.resolveBotWorkspaceName(bot)
          : this.resolveGroupWorkspaceName(bot, grp, resolvedChatName)
        : b.workspaceName
      return {
        ...b,
        ...(bot?.name ? { botName: bot.name } : {}),
        ...(resolvedChatName ? { chatName: resolvedChatName } : {}),
        workspaceName: resolvedWorkspaceName,
      }
    })
  }

  listDreamSessions(botId?: string): LarkDreamSession[] {
    const botsById = new Map(this.config.listBots().map((b) => [b.id, b]))
    return this.runtime.listRawDreamSessions(botId).map((s) => {
      const bot = botsById.get(s.botId)
      return {
        ...s,
        ...(bot?.name ? { botName: bot.name } : {}),
        workspaceName: bot ? this.resolveBotWorkspaceName(bot) : s.workspaceName,
      }
    })
  }

  listTriageSessions(botId?: string): LarkTriageSession[] {
    const botsById = new Map(this.config.listBots().map((b) => [b.id, b]))
    const groupsByKey = new Map(this.config.listGroups().map((g) => [g.key, g]))
    const discovered = this.config.getDiscoveredChats()
    return this.runtime.listRawTriageSessions(botId).map((s) => {
      const bot = botsById.get(s.botId)
      const gKey = buildGroupKey(s.botId, s.chatId)
      const grp = groupsByKey.get(gKey)
      const disc = discovered.get(gKey)
      const resolvedChatName = s.chatName || grp?.chatName || disc?.name
      return {
        ...s,
        ...(bot?.name ? { botName: bot.name } : {}),
        ...(resolvedChatName ? { chatName: resolvedChatName } : {}),
      }
    })
  }

  listGroupViews(filterBotId?: string): LarkGroupView[] {
    const botsById = new Map(this.config.listBots().map((b) => [b.id, b]))
    const groupsByKey = new Map(this.config.listGroups().map((g) => [g.key, g]))
    const discovered = this.config.getDiscoveredChats()
    const keys = new Set<string>([...groupsByKey.keys(), ...discovered.keys()])
    const bindings = this.runtime.listRawBindings()
    const trafficMap = this.telemetry.listGroupTrafficMap()
    const views: LarkGroupView[] = []

    for (const key of keys) {
      const configured = groupsByKey.get(key)
      const disc = discovered.get(key)
      const botId = configured?.botId ?? disc?.botId ?? ''
      if (!botId || (filterBotId && botId !== filterBotId)) continue
      const bot = botsById.get(botId)
      if (!bot) continue

      const chatId = configured?.chatId ?? disc?.chatId ?? ''
      const chatName = configured?.chatName || disc?.name || chatId
      const description = configured?.description || disc?.description || ''
      const fullConfig =
        configured ??
        LarkGroupConfigSchema.parse({
          key,
          botId,
          chatId,
          chatName,
          description,
          enabled: bot.groupAccessMode === 'all_joined',
        })

      const activeSessionCount = bindings.filter(
        (b) => b.botId === botId && b.chatId === chatId,
      ).length
      const traffic = trafficMap.get(key)
      const effectiveRuntime = resolveEffectiveAgentRuntime(bot, fullConfig)

      views.push({
        key,
        botId,
        botName: bot.name,
        larkAppId: bot.larkAppId,
        chatId,
        chatName,
        description,
        ...(disc?.avatar ? { avatar: disc.avatar } : {}),
        configured: Boolean(configured),
        inChat: Boolean(disc),
        effectiveWorkspaceName: this.resolveGroupWorkspaceName(bot, fullConfig, chatName),
        effectiveWorkingDir: resolveEffectiveWorkingDir(bot, fullConfig),
        runtimeSource: effectiveRuntime.source,
        effectiveAgentPreset: effectiveRuntime.agentPreset,
        ...(effectiveRuntime.runtimeProfileId
          ? { effectiveRuntimeProfileId: effectiveRuntime.runtimeProfileId }
          : {}),
        ...(effectiveRuntime.model ? { effectiveModel: effectiveRuntime.model } : {}),
        ...(effectiveRuntime.reasoningEffort
          ? { effectiveReasoningEffort: effectiveRuntime.reasoningEffort }
          : {}),
        activeSessionCount,
        inboundTotal: traffic?.inboundTotal ?? 0,
        config: fullConfig,
      })
    }

    return views.sort((a, b) => {
      if (a.configured !== b.configured) return a.configured ? -1 : 1
      return a.chatName.localeCompare(b.chatName, 'zh-CN')
    })
  }

  buildCockpit(
    statuses: readonly LarkBotStatus[],
    sessionUrlBuilder: (sessionId: string) => string,
    now = Date.now(),
  ): LarkCockpitPayload {
    const botsById = new Map(this.config.listBots().map((b) => [b.id, b]))
    const groupsByKey = new Map(this.config.listGroups().map((g) => [g.key, g]))
    const hourlyBuckets = this.telemetry.listHourlyBucketsMap()
    const botMetrics = this.telemetry.listBotMetricsMap()
    const groupTraffic = this.telemetry.listGroupTrafficMap()

    const hourlySeries: Array<{
      hourKey: string
      label: string
      inbound: number
      replied: number
      silentSkipped: number
      errors: number
      avgLatencyMs: number
    }> = []

    let inbound24h = 0
    let replied24h = 0
    let silentSkipped24h = 0
    let errors24h = 0
    let peakHourlyCount = 0

    for (let offset = 23; offset >= 0; offset -= 1) {
      const slotMs = now - offset * 3_600_000
      const key = formatHourKey(slotMs)
      const bucket = hourlyBuckets.get(key)
      const hourNum = key.slice(11, 13)
      const inbound = bucket?.inbound ?? 0
      const replied = bucket?.replied ?? 0
      const silentSkipped = bucket?.silentSkipped ?? 0
      const errors = bucket?.errors ?? 0
      const avgLatencyMs =
        bucket && bucket.latencySamples > 0
          ? Math.round(bucket.totalLatencyMs / bucket.latencySamples)
          : 0
      inbound24h += inbound
      replied24h += replied
      silentSkipped24h += silentSkipped
      errors24h += errors
      const slotTotal = Math.max(inbound, replied) + errors
      if (slotTotal > peakHourlyCount) peakHourlyCount = slotTotal
      hourlySeries.push({
        hourKey: key,
        label: `${hourNum}:00`,
        inbound,
        replied,
        silentSkipped,
        errors,
        avgLatencyMs,
      })
    }

    const allLatencies = [...botMetrics.values()].flatMap((m) => m.latenciesMs)
    const latencyStats = calcStats(allLatencies)

    const enabledStatuses = statuses.filter((s) => s.enabled)
    const onlineBots = enabledStatuses.filter((s) => s.connected).length
    const serviceHealthy = enabledStatuses.length === 0 || onlineBots === enabledStatuses.length

    const botRows = statuses.map((st) => {
      const bot = botsById.get(st.botId)
      const bm = botMetrics.get(st.botId)
      const lat = calcStats(bm?.latenciesMs ?? [])
      const avatarUrl = st.avatarUrl || bot?.avatarUrl
      return {
        ...st,
        ...(avatarUrl ? { avatarUrl } : {}),
        workspaceName: bot ? this.resolveBotWorkspaceName(bot) : st.name,
        agentPreset: bot?.agentPreset ?? 'codex',
        ...(bot?.runtimeProfileId ? { runtimeProfileId: bot.runtimeProfileId } : {}),
        ...(bot?.model ? { model: bot.model } : {}),
        inboundTotal: bm?.inboundTotal ?? 0,
        repliedTotal: bm?.repliedTotal ?? 0,
        errorTotal: bm?.errorTotal ?? 0,
        avgLatencyMs: lat.avg,
      }
    })

    const bindings = this.listBindings().map((b) => ({
      ...b,
      sessionUrl: sessionUrlBuilder(b.sessionId),
    }))

    const engineCounts = new Map<string, number>()
    for (const b of bindings) {
      engineCounts.set(b.agentPreset, (engineCounts.get(b.agentPreset) ?? 0) + 1)
    }
    const engineDistribution = [...engineCounts.entries()].map(([engine, count]) => ({
      engine,
      count,
    }))

    const topGroups = [...groupTraffic.values()]
      .sort((a, b) => b.inboundTotal - a.inboundTotal || b.lastActiveMs - a.lastActiveMs)
      .slice(0, 8)
      .map((gt) => {
        const bot = botsById.get(gt.botId)
        const group = groupsByKey.get(gt.key)
        const activeSessions = bindings.filter(
          (b) => b.botId === gt.botId && b.chatId === gt.chatId,
        ).length
        return {
          key: gt.key,
          botId: gt.botId,
          botName: bot?.name ?? gt.botId,
          chatId: gt.chatId,
          chatName: group?.chatName || gt.chatName || gt.chatId,
          workspaceName: bot ? this.resolveGroupWorkspaceName(bot, group, gt.chatName) : gt.botId,
          inboundTotal: gt.inboundTotal,
          repliedTotal: gt.repliedTotal,
          activeSessions,
          lastActiveMs: gt.lastActiveMs,
        }
      })

    const configuredGroups = groupsByKey.size
    const activeListeners = [...groupsByKey.values()].filter(
      (g) => g.enabled && g.listener.enabled,
    ).length
    const denom = replied24h + errors24h
    const successRate24h = denom > 0 ? Math.round((replied24h / denom) * 1000) / 10 : 100

    return {
      summary: {
        serviceHealthy,
        onlineBots,
        totalBots: statuses.length,
        configuredGroups,
        activeListeners,
        activeBindings: bindings.length,
        inbound24h,
        replied24h,
        silentSkipped24h,
        errors24h,
        peakHourlyCount,
        successRate24h,
        avgLatencyMs: latencyStats.avg,
        p95LatencyMs: latencyStats.p95,
      },
      hourlySeries,
      botRows,
      engineDistribution,
      topGroups,
      bindings,
      recentEvents: this.telemetry.listEvents(40),
      listenerTemplates: this.config.listListenerTemplates(),
      triageDefaults: {
        defaultSystemPrompt: DEFAULT_TRIAGE_SYSTEM_PROMPT,
        variables: TRIAGE_PROMPT_VARIABLES,
        toolName: TRIAGE_TOOL_NAME,
        toolSchema: ROUTE_MESSAGE_TOOL_SCHEMA,
      },
    }
  }

  private findExplicitWorkspaceNameForDir(targetDir: string): string | undefined {
    const bots = this.config.listBots()
    const botsById = new Map(bots.map((b) => [b.id, b]))
    const groups = this.config.listGroups()

    for (const candidate of groups) {
      if (!candidate.enabled || !candidate.workspaceName.trim()) continue
      const ownerBot = botsById.get(candidate.botId)
      if (ownerBot && resolveEffectiveWorkingDir(ownerBot, candidate) === targetDir) {
        return candidate.workspaceName.trim()
      }
    }
    for (const candidateBot of bots) {
      if (!candidateBot.enabled || !candidateBot.workspaceName.trim()) continue
      const botDir =
        expandWorkingDir(candidateBot.defaultWorkingDir) || candidateBot.defaultWorkingDir
      if (botDir === targetDir) {
        return candidateBot.workspaceName.trim()
      }
    }
    for (const candidate of groups) {
      if (!candidate.workspaceName.trim()) continue
      const ownerBot = botsById.get(candidate.botId)
      if (ownerBot && resolveEffectiveWorkingDir(ownerBot, candidate) === targetDir) {
        return candidate.workspaceName.trim()
      }
    }
    for (const candidateBot of bots) {
      if (!candidateBot.workspaceName.trim()) continue
      const botDir =
        expandWorkingDir(candidateBot.defaultWorkingDir) || candidateBot.defaultWorkingDir
      if (botDir === targetDir) {
        return candidateBot.workspaceName.trim()
      }
    }
    return undefined
  }
}
