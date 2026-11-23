import type { Context } from '@deepseek-ai/cordis'
import {
  LarkBotTransport,
  slugifyBotId,
  type CardActionEvent,
  type DiscoveredLarkChat,
  type InboundLarkMessage,
  type LarkBotConfig,
  type LarkBotProfile,
  type LarkBotStatus,
  type LarkChatMember,
  type LarkPlatformManager,
  type LarkQrJobView,
  type LarkUserSearchHit,
  type SubstituteTarget,
  type TransportDiagnosticsSnapshot,
} from '@dsh-lark/lark-core'
import type { LarkDirectoryEnricher } from './directory-enrichment.js'
import { assertExistingWorkingDirectory } from './fs-browser.js'
import type { RuntimeCatalog } from './runtime-catalog.js'
import { SplitBrainDetector } from './split-brain-detector.js'
import type { LarkBridgeStore } from './store.js'
import type { WorkspaceGrouping } from './workspace-grouping.js'

export interface ManagedTransport {
  readonly config: LarkBotConfig
  readonly transport: LarkBotTransport
}

export interface BotConnectionPoolHost {
  readonly ctx: Context
  readonly store: LarkBridgeStore
  readonly runtimes: RuntimeCatalog
  readonly workspaces: WorkspaceGrouping
  readonly platform: LarkPlatformManager
  readonly directoryEnricher: LarkDirectoryEnricher
  readonly isDisposed: () => boolean
  readonly onInboundMessage: (
    botId: string,
    transport: LarkBotTransport,
    msg: InboundLarkMessage,
  ) => Promise<void>
  readonly onCardAction: (action: CardActionEvent) => Promise<{ toast?: string } | void>
  readonly onBotReady: (botId: string) => void
}

/**
 * Manages per-bot Lark WSClient connections, serialized `syncBot` transitions,
 * bot profile & member directory hydration, and cross-host split-brain detection.
 */
export class BotConnectionPool {
  readonly transports = new Map<string, ManagedTransport>()
  readonly splitBrain = new SplitBrainDetector()
  private readonly botSyncQueues = new Map<string, Promise<void>>()
  private readonly preserveLocalDescriptionBots = new Set<string>()
  private readonly hydratedProfileBots = new Set<string>()

  constructor(private readonly host: BotConnectionPoolHost) {}

  async startAllEnabled(): Promise<void> {
    for (const bot of this.host.store.listBots()) {
      if (!bot.enabled) continue
      await this.startBot(bot).catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        this.host.ctx.logger.error(`[lark-bridge] failed to start bot "${bot.name}": ${message}`)
        this.host.store.recordEvent({ botId: bot.id, kind: 'error', summary: `启动失败：${message}` })
      })
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.transports.values()].map((m) => m.transport.stop().catch(() => {})))
    this.transports.clear()
  }

  getTransport(botId: string): LarkBotTransport | undefined {
    return this.transports.get(botId)?.transport
  }

  transportFor(bot: LarkBotConfig): LarkBotTransport {
    return this.transports.get(bot.id)?.transport ?? new LarkBotTransport(bot, { onMessage: () => {} })
  }

  getDiagnosticsSnapshot(botId: string): TransportDiagnosticsSnapshot | undefined {
    return this.transports.get(botId)?.transport.getDiagnosticsSnapshot?.()
  }

  isActiveTransport(botId: string, transport: LarkBotTransport): boolean {
    const managed = this.transports.get(botId)
    return !managed || managed.transport === transport
  }

  listBotStatuses(): LarkBotStatus[] {
    const bindings = this.host.store.listBindings()
    return this.host.store.listBots().map((bot) => {
      const state = this.transports.get(bot.id)?.transport.state
      const avatarUrl = state?.avatarUrl || bot.avatarUrl || undefined
      return {
        botId: bot.id,
        larkAppId: bot.larkAppId,
        name: bot.name,
        ...(avatarUrl ? { avatarUrl } : {}),
        enabled: bot.enabled,
        connected: state?.connected ?? false,
        ...(state?.botOpenId ? { botOpenId: state.botOpenId } : {}),
        ...(state?.startedAtMs ? { startedAtMs: state.startedAtMs } : {}),
        ...(state?.lastEventAtMs ? { lastEventAtMs: state.lastEventAtMs } : {}),
        ...(state?.lastError ? { lastError: state.lastError } : {}),
        activeBindings: bindings.filter((b) => b.botId === bot.id).length,
      }
    })
  }

  async syncBot(
    botId: string,
    options: { readonly preserveLocalDescription?: boolean } = {},
  ): Promise<void> {
    const prev = this.botSyncQueues.get(botId) ?? Promise.resolve()
    const run = prev
      .catch(() => {})
      .then(() => this.syncBotSerialized(botId, options))
    this.botSyncQueues.set(botId, run)
    try {
      await run
    } finally {
      if (this.botSyncQueues.get(botId) === run) {
        this.botSyncQueues.delete(botId)
      }
    }
  }

  async ensureBotProfileHydrated(botId: string): Promise<void> {
    if (this.hydratedProfileBots.has(botId)) return
    const bot = this.host.store.getBot(botId)
    if (!bot) return
    if (bot.avatarUrl.trim() && bot.description.trim()) {
      this.hydratedProfileBots.add(botId)
      return
    }
    this.hydratedProfileBots.add(botId)
    await this.syncBotProfile(botId).catch(() => undefined)
  }

  async syncBotProfile(botId: string): Promise<LarkBotProfile | undefined> {
    const bot = this.host.store.getBot(botId)
    if (!bot) return undefined
    const transport = this.transportFor(bot)
    const remote = await transport.fetchBotProfile()
    const fallback =
      !remote.description || !remote.avatarUrl
        ? await this.host.platform.fetchBotAppProfile(bot.larkAppId)
        : undefined
    const merged: LarkBotProfile = {
      ...(remote.openId ? { openId: remote.openId } : {}),
      ...(remote.name || fallback?.name ? { name: remote.name || fallback?.name } : {}),
      ...(remote.avatarUrl || fallback?.avatarUrl
        ? { avatarUrl: remote.avatarUrl || fallback?.avatarUrl }
        : {}),
      ...(remote.description || fallback?.description
        ? { description: remote.description || fallback?.description }
        : {}),
    }
    this.hydratedProfileBots.add(botId)
    this.host.store.updateBotProfile(botId, merged)
    return merged
  }

  async hydrateAllowedUserProfiles(bot: LarkBotConfig): Promise<SubstituteTarget[]> {
    return this.hydrateUserProfiles(
      bot,
      bot.allowedUsers,
      bot.allowedUserProfiles,
      'allowedUserProfiles',
    )
  }

  async hydrateAdminUserProfiles(bot: LarkBotConfig): Promise<SubstituteTarget[]> {
    return this.hydrateUserProfiles(
      bot,
      bot.adminUsers,
      bot.adminUserProfiles,
      'adminUserProfiles',
    )
  }

  async listGroupMembers(
    botId: string,
    chatId: string,
    options: { readonly includeAvatars?: boolean } = {},
  ): Promise<LarkChatMember[]> {
    const bot = this.host.store.getBot(botId)
    if (!bot) return []
    const includeAvatars = options.includeAvatars !== false
    const uat = includeAvatars
      ? await this.host.platform.getValidUserAccessToken(bot.id, bot.larkAppId, bot.larkAppSecret)
      : undefined
    return this.transportFor(bot).listChatMembersAndBots(chatId, {
      ...(uat ? { userAccessToken: uat } : {}),
      ...(includeAvatars
        ? {
            userDirectoryLookup: (queries) =>
              this.host.directoryEnricher.searchByQueries(queries, bot.id),
            resolveBotAvatar: async (groupBot) => {
              const allBots = this.host.store.listBots()
              const peer = allBots.find((candidate) => {
                if (groupBot.larkAppId && candidate.larkAppId === groupBot.larkAppId) return true
                const st = this.transports.get(candidate.id)?.transport.state
                if (st?.botOpenId && st.botOpenId === groupBot.openId) return true
                if (st?.remoteBotName && st.remoteBotName === groupBot.name) return true
                return candidate.name === groupBot.name
              })
              if (peer) {
                if (!peer.avatarUrl) {
                  await this.ensureBotProfileHydrated(peer.id)
                }
                const refreshedPeer = this.host.store.getBot(peer.id) ?? peer
                const peerAvatar =
                  this.transports.get(peer.id)?.transport.state.avatarUrl || refreshedPeer.avatarUrl
                if (peerAvatar) return peerAvatar
              }
              return this.host.directoryEnricher.resolveAppAvatar(groupBot.larkAppId)
            },
          }
        : {}),
    })
  }

  async searchUsers(botId: string, query: string): Promise<LarkUserSearchHit[]> {
    const bot = this.host.store.getBot(botId)
    if (!bot) return []
    const uat = await this.host.platform.getValidUserAccessToken(
      bot.id,
      bot.larkAppId,
      bot.larkAppSecret,
    )
    return this.transportFor(bot).searchUsers(query, uat, (queries) =>
      this.host.directoryEnricher.searchByQueries(queries, bot.id),
    )
  }

  async syncJoinedChats(targetBotId?: string): Promise<DiscoveredLarkChat[]> {
    const entries = targetBotId
      ? [this.transports.get(targetBotId)].filter((v): v is ManagedTransport => Boolean(v))
      : [...this.transports.values()]
    const results: DiscoveredLarkChat[] = []
    for (const entry of entries) {
      try {
        const chats = await entry.transport.listJoinedChats()
        this.host.store.mergeDiscoveredChats(entry.config.id, chats)
        results.push(...chats)
      } catch (err) {
        this.host.ctx.logger.warn(
          `[lark-bridge] syncJoinedChats(${entry.config.name}) failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    return results
  }

  async startAutoCreateBot(rawBody: Record<string, unknown>): Promise<LarkQrJobView> {
    const mode = rawBody.mode === 'device_flow' ? 'device_flow' : 'open_platform'
    const name = typeof rawBody.name === 'string' ? rawBody.name.trim() : ''
    const description = typeof rawBody.description === 'string' ? rawBody.description.trim() : ''
    const requestedId = typeof rawBody.id === 'string' ? rawBody.id.trim() : ''
    const defaults = await this.resolveNewBotRuntimeDefaults(rawBody)

    return this.host.platform.startAutoCreateBot(
      {
        mode,
        ...(requestedId ? { id: requestedId } : {}),
        name,
        description,
      },
      async (created) => {
        const finalId = this.allocateUniqueBotId(created.id, created.larkAppId)
        const saved = this.host.store.upsertBot({
          id: finalId,
          name: created.name,
          description: created.description,
          larkAppId: created.larkAppId,
          larkAppSecret: created.larkAppSecret,
          enabled: true,
          defaultWorkingDir: defaults.defaultWorkingDir,
          workspaceName: defaults.workspaceName,
          agentPreset: defaults.agentPreset,
          ...(defaults.runtimeProfileId ? { runtimeProfileId: defaults.runtimeProfileId } : {}),
          ...(defaults.model ? { model: defaults.model } : {}),
          ...(defaults.reasoningEffort ? { reasoningEffort: defaults.reasoningEffort } : {}),
        })
        await this.syncBot(saved.id)
      },
    )
  }

  async importExistingOpenPlatformBot(rawBody: Record<string, unknown>): Promise<LarkBotConfig> {
    const larkAppId = typeof rawBody.larkAppId === 'string' ? rawBody.larkAppId.trim() : ''
    if (!larkAppId) throw new Error('请选择要接入的飞书应用')
    const existing = this.host.store.listBots().find((b) => b.larkAppId === larkAppId)
    if (existing) {
      throw new Error(`该飞书应用已接入为智能体「${existing.name}」`)
    }
    const defaults = await this.resolveNewBotRuntimeDefaults(rawBody)
    const creds = await this.host.platform.fetchOpenPlatformAppCredentials(larkAppId)
    const requestedId = typeof rawBody.id === 'string' ? rawBody.id.trim() : ''
    const requestedName = typeof rawBody.name === 'string' ? rawBody.name.trim() : ''
    const requestedDescription =
      typeof rawBody.description === 'string' ? rawBody.description.trim() : ''
    const name = requestedName || creds.name || larkAppId
    const description = requestedDescription || creds.description || ''
    const baseId = requestedId || slugifyBotId(name, larkAppId)
    const finalId = this.allocateUniqueBotId(baseId, creds.appId)

    const saved = this.host.store.upsertBot({
      id: finalId,
      name,
      description,
      avatarUrl: creds.avatarUrl ?? '',
      larkAppId: creds.appId,
      larkAppSecret: creds.appSecret,
      enabled: true,
      defaultWorkingDir: defaults.defaultWorkingDir,
      workspaceName: defaults.workspaceName,
      agentPreset: defaults.agentPreset,
      ...(defaults.runtimeProfileId ? { runtimeProfileId: defaults.runtimeProfileId } : {}),
      ...(defaults.model ? { model: defaults.model } : {}),
      ...(defaults.reasoningEffort ? { reasoningEffort: defaults.reasoningEffort } : {}),
    })
    await this.syncBot(saved.id)
    if (!saved.description.trim() || !saved.avatarUrl.trim()) {
      await this.ensureBotProfileHydrated(saved.id)
    }
    return this.host.store.getBot(saved.id) ?? saved
  }

  private async syncBotSerialized(
    botId: string,
    options: { readonly preserveLocalDescription?: boolean } = {},
  ): Promise<void> {
    const existing = this.transports.get(botId)
    if (existing) {
      this.transports.delete(botId)
      await existing.transport.stop().catch(() => {})
    }
    const bot = this.host.store.getBot(botId)
    if (!bot || this.host.isDisposed()) return
    await this.host.workspaces.syncBot(bot)
    await this.host.workspaces.reconcileBindings()
    if (bot.enabled && !this.host.isDisposed()) {
      if (options.preserveLocalDescription) {
        this.preserveLocalDescriptionBots.add(botId)
      }
      try {
        await this.startBot(bot)
      } finally {
        this.preserveLocalDescriptionBots.delete(botId)
      }
    }
  }

  private async startBot(bot: LarkBotConfig): Promise<void> {
    if (this.host.isDisposed()) return
    const prev = this.transports.get(bot.id)
    if (prev) {
      this.transports.delete(bot.id)
      await prev.transport.stop().catch(() => {})
    }
    if (this.host.isDisposed()) return

    const transport: LarkBotTransport = new LarkBotTransport(bot, {
      onMessage: (msg) => this.host.onInboundMessage(bot.id, transport, msg),
      onCardAction: (action) => this.host.onCardAction(action),
      onChatMembershipChange: () => {
        void this.syncJoinedChats(bot.id)
      },
      onExternalSelfMessage: (ev) => {
        const currentBot = this.host.store.getBot(bot.id) ?? bot
        const { shouldAudit, alert } = this.splitBrain.recordExternalSelfMessage(
          ev,
          currentBot.name,
        )
        this.host.ctx.logger.warn(
          `[lark-bridge][bot=${bot.id}] split-brain detected: observed external self message ${ev.messageId} in chat ${ev.chatId} (count=${alert.observedCount})`,
        )
        if (shouldAudit) {
          this.host.store.recordEvent({
            botId: bot.id,
            chatId: ev.chatId,
            kind: 'error',
            summary: `检测到多实例冲突（${ev.larkAppId}）：群内观测到非本实例发出的自身消息（${ev.messageId}），请检查是否有另一台设备同时在线`,
          })
        }
      },
      onBotProfile: (profile) => {
        this.hydratedProfileBots.add(bot.id)
        this.host.store.updateBotProfile(bot.id, profile, {
          preserveNonEmptyDescription: this.preserveLocalDescriptionBots.has(bot.id),
        })
      },
      logger: (level, message) =>
        this.host.ctx.logger[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](
          `[lark-bridge] ${message}`,
        ),
    })

    this.transports.set(bot.id, { config: bot, transport })
    try {
      await transport.start()
    } catch (err) {
      if (this.transports.get(bot.id)?.transport === transport) {
        this.transports.delete(bot.id)
      }
      await transport.stop().catch(() => {})
      throw err
    }
    if (this.host.isDisposed() || this.transports.get(bot.id)?.transport !== transport) {
      await transport.stop().catch(() => {})
      return
    }

    this.host.store.recordEvent({
      botId: bot.id,
      kind: 'lifecycle',
      summary: `长连接已就绪（${bot.larkAppId}）`,
    })
    await this.host.workspaces.syncBot(bot)
    void this.syncJoinedChats(bot.id)
    this.host.onBotReady(bot.id)
  }

  private async hydrateUserProfiles(
    bot: LarkBotConfig,
    userIds: readonly string[],
    existingProfiles: readonly SubstituteTarget[],
    profileField: 'allowedUserProfiles' | 'adminUserProfiles',
  ): Promise<SubstituteTarget[]> {
    if (userIds.length === 0) return []
    const byId = new Map<string, SubstituteTarget>()
    for (const p of existingProfiles) byId.set(p.openId, p)
    for (const p of [
      ...bot.allowedUserProfiles,
      ...bot.adminUserProfiles,
      ...bot.substituteMode.targets,
    ]) {
      const prev = byId.get(p.openId)
      if (!prev || (!prev.avatarUrl && p.avatarUrl)) byId.set(p.openId, { ...prev, ...p })
    }

    const liveTransport = this.transports.get(bot.id)?.transport
    let mutated = false
    const result: SubstituteTarget[] = []
    for (const openId of userIds) {
      let profile = byId.get(openId)
      if ((!profile || !profile.avatarUrl) && liveTransport) {
        const resolved = await liveTransport
          .resolveUserSummary(openId, profile?.name !== openId ? profile?.name : undefined)
          .catch(() => undefined)
        if (resolved && (resolved.name !== openId || resolved.avatarUrl)) {
          const nextProfile: SubstituteTarget = {
            ...(profile ?? {}),
            ...resolved,
          }
          if (
            !profile ||
            profile.name !== nextProfile.name ||
            profile.avatarUrl !== nextProfile.avatarUrl
          ) {
            profile = nextProfile
            mutated = true
          }
        }
      }
      if (profile && !profile.avatarUrl && profile.name && !profile.name.startsWith('ou_')) {
        const dirHits = await this.host.directoryEnricher.searchByQueries([profile.name], bot.id)
        const matched =
          dirHits.find((h) => h.openId === openId && h.avatarUrl) ??
          (() => {
            const byName = dirHits.filter((h) => h.name === profile!.name && h.avatarUrl)
            return byName.length === 1 ? byName[0] : undefined
          })()
        if (matched?.avatarUrl) {
          profile = {
            ...profile,
            ...(matched.email && !profile.email ? { email: matched.email } : {}),
            avatarUrl: matched.avatarUrl,
          }
          mutated = true
        }
      }
      result.push(profile ?? { openId, name: openId })
    }

    if (mutated) {
      const latestBot = this.host.store.getBot(bot.id) ?? bot
      this.host.store.upsertBot({
        ...latestBot,
        [profileField]: result.filter((p) => p.name !== p.openId),
      })
    }
    return result
  }

  private async resolveNewBotRuntimeDefaults(rawBody: Record<string, unknown>) {
    const workspaceName =
      typeof rawBody.workspaceName === 'string' ? rawBody.workspaceName.trim() : ''
    const defaultWorkingDir =
      (typeof rawBody.defaultWorkingDir === 'string' && rawBody.defaultWorkingDir.trim()) || '~'
    assertExistingWorkingDirectory(defaultWorkingDir)
    const requestedPreset =
      typeof rawBody.agentPreset === 'string' ? rawBody.agentPreset.trim() : ''
    let agentPreset = requestedPreset
    if (!agentPreset) {
      const availableRuntimes = await this.host.runtimes.list().catch(() => [])
      agentPreset =
        availableRuntimes.find((r) => r.isDefault)?.id ?? availableRuntimes[0]?.id ?? 'standard'
    }
    const runtimeProfileId =
      typeof rawBody.runtimeProfileId === 'string' && rawBody.runtimeProfileId.trim()
        ? rawBody.runtimeProfileId.trim()
        : undefined
    const model =
      typeof rawBody.model === 'string' && rawBody.model.trim() ? rawBody.model.trim() : undefined
    const reasoningEffort =
      typeof rawBody.reasoningEffort === 'string' && rawBody.reasoningEffort.trim()
        ? rawBody.reasoningEffort.trim()
        : undefined
    return {
      defaultWorkingDir,
      workspaceName,
      agentPreset,
      ...(runtimeProfileId ? { runtimeProfileId } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    }
  }

  private allocateUniqueBotId(baseId: string, larkAppId: string): string {
    let finalId = baseId
    let suffix = 2
    while (
      this.host.store.getBot(finalId) &&
      this.host.store.getBot(finalId)?.larkAppId !== larkAppId
    ) {
      finalId = `${baseId}-${suffix}`
      suffix += 1
    }
    return finalId
  }
}
