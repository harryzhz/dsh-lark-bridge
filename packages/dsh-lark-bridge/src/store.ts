import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_LISTENER_TEMPLATES,
  LarkBotConfigSchema,
  LarkGroupConfigSchema,
  LarkReminderItemSchema,
  ListenerTemplateSchema,
  buildGroupKey,
  expandWorkingDir,
  resolveEffectiveAgentRuntime,
  resolveEffectiveWorkingDir,
  resolveEffectiveWorkspaceName,
  type DiscoveredLarkChat,
  type LarkBotConfig,
  type LarkBotStatus,
  type LarkGroupConfig,
  type LarkReminderItem,
  type ListenerTemplate,
} from '@dsh-lark/lark-core'
import type {
  LarkAuditEvent,
  LarkBotMetrics,
  LarkCockpitPayload,
  LarkDreamRunState,
  LarkDreamSession,
  LarkGroupTraffic,
  LarkGroupView,
  LarkHourlyBucket,
  LarkManagedSession,
  LarkScheduleBinding,
  LarkScheduleDeliveryMode,
  LarkScheduleNotifyOn,
  LarkScheduleTarget,
  LarkSessionBinding,
} from './types.js'

function parseScheduleBinding(raw: unknown): LarkScheduleBinding {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid schedule binding payload')
  }
  const obj = raw as Record<string, unknown>
  const scheduleId = typeof obj.scheduleId === 'string' ? obj.scheduleId.trim() : ''
  if (!scheduleId) throw new Error('scheduleId is required')
  const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : true
  const rawTargets = Array.isArray(obj.targets) ? obj.targets : []
  const targets: LarkScheduleTarget[] = []
  for (const item of rawTargets) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const botId = typeof rec.botId === 'string' ? rec.botId.trim() : ''
    const chatId = typeof rec.chatId === 'string' ? rec.chatId.trim() : ''
    if (!botId || !chatId) continue
    if (!targets.some((t) => t.botId === botId && t.chatId === chatId)) {
      targets.push({ botId, chatId })
    }
  }
  const deliveryMode: LarkScheduleDeliveryMode =
    obj.deliveryMode === 'thread' ? 'thread' : 'chat'
  const notifyOn: LarkScheduleNotifyOn =
    obj.notifyOn === 'always' || obj.notifyOn === 'error_only' ? obj.notifyOn : 'non_empty'
  const sendIntermediateMessages = obj.sendIntermediateMessages === true
  return {
    scheduleId,
    enabled,
    targets,
    deliveryMode,
    notifyOn,
    sendIntermediateMessages,
  }
}

interface PersistedStateV3 {
  readonly version: 3
  readonly viewerTicketSecret?: string
  readonly bots: LarkBotConfig[]
  readonly groups: LarkGroupConfig[]
  readonly bindings: LarkSessionBinding[]
  readonly managedSessions: LarkManagedSession[]
  readonly dreamStates?: LarkDreamRunState[]
  readonly dreamSessions?: LarkDreamSession[]
  readonly reminders?: LarkReminderItem[]
  readonly listenerTemplates: ListenerTemplate[]
  readonly scheduleBindings: LarkScheduleBinding[]
  readonly hourlyBuckets: LarkHourlyBucket[]
  readonly botMetrics: LarkBotMetrics[]
  readonly groupTraffic: LarkGroupTraffic[]
  readonly auditEvents: LarkAuditEvent[]
}

const MAX_LATENCY_SAMPLES = 80
const MAX_HOURLY_BUCKETS = 48
const MAX_MANAGED_SESSIONS = 600
const MAX_DREAM_SESSIONS = 100
const MAX_ARCHIVED_REMINDERS = 300

function stripDreamSummaryPrefix(raw?: string): string | undefined {
  if (!raw) return undefined
  const trimmed = raw
    .trim()
    .replace(/^已整理\s+\d+\s+个会话(?:\s*·\s*)?/, '')
    .replace(/^整理失败[：:]\s*/, '')
    .trim()
  return trimmed || undefined
}

function formatLocalDateKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function formatHourKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  return `${y}-${m}-${day}T${h}`
}

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

export class LarkBridgeStore {
  private readonly statePath: string
  private viewerTicketSecret = ''
  private readonly bots = new Map<string, LarkBotConfig>()
  private readonly groups = new Map<string, LarkGroupConfig>()
  private readonly discoveredChats = new Map<string, DiscoveredLarkChat>()
  private readonly bindings = new Map<string, LarkSessionBinding>()
  private readonly routeAliases = new Map<string, string>()
  private readonly managedSessions = new Map<string, LarkManagedSession>()
  private readonly dreamStates = new Map<string, LarkDreamRunState>()
  private readonly dreamSessions = new Map<string, LarkDreamSession>()
  private readonly reminders = new Map<string, LarkReminderItem>()
  private readonly listenerTemplates = new Map<string, ListenerTemplate>()
  private readonly scheduleBindings = new Map<string, LarkScheduleBinding>()
  private readonly hourlyBuckets = new Map<string, LarkHourlyBucket>()
  private readonly botMetrics = new Map<string, LarkBotMetrics>()
  private readonly groupTraffic = new Map<string, LarkGroupTraffic>()
  private readonly auditEvents: LarkAuditEvent[] = []

  constructor(
    private readonly dataDir: string,
    private readonly maxAuditEvents = 200,
  ) {
    for (const tpl of DEFAULT_LISTENER_TEMPLATES) {
      this.listenerTemplates.set(tpl.key, structuredClone(tpl))
    }
    this.statePath = join(dataDir, 'lark-bridge-state.json')
    this.load()
  }

  getViewerTicketSecret(): string {
    if (!this.viewerTicketSecret) {
      this.viewerTicketSecret = randomBytes(32).toString('hex')
      this.persist()
    }
    return this.viewerTicketSecret
  }

  rotateViewerTicketSecret(): string {
    this.viewerTicketSecret = randomBytes(32).toString('hex')
    this.persist()
    return this.viewerTicketSecret
  }

  listBots(): LarkBotConfig[] {
    return [...this.bots.values()]
  }

  getBot(id: string): LarkBotConfig | undefined {
    return this.bots.get(id)
  }

  upsertBot(raw: unknown): LarkBotConfig {
    const candidate = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {}
    const existing = typeof candidate.id === 'string' ? this.bots.get(candidate.id) : undefined
    if (existing && (!candidate.larkAppSecret || String(candidate.larkAppSecret).trim() === '')) {
      candidate.larkAppSecret = existing.larkAppSecret
    }
    if (existing && !candidate.avatarUrl && existing.avatarUrl) {
      candidate.avatarUrl = existing.avatarUrl
    }
    const parsed = LarkBotConfigSchema.parse(candidate)
    const allowedSet = new Set(parsed.allowedUsers)
    const syncedAllowed = parsed.allowedUserProfiles.filter((p) => allowedSet.has(p.openId))
    const adminSet = new Set(parsed.adminUsers)
    const syncedAdmins = parsed.adminUserProfiles.filter((p) => adminSet.has(p.openId))
    const finalBot: LarkBotConfig =
      syncedAllowed.length === parsed.allowedUserProfiles.length &&
      syncedAdmins.length === parsed.adminUserProfiles.length
        ? parsed
        : { ...parsed, allowedUserProfiles: syncedAllowed, adminUserProfiles: syncedAdmins }
    this.bots.set(finalBot.id, finalBot)
    this.persist()
    return finalBot
  }

  updateBotAvatar(botId: string, avatarUrl: string): void {
    this.updateBotProfile(botId, { avatarUrl })
  }

  updateBotProfile(
    botId: string,
    patch: { readonly avatarUrl?: string; readonly description?: string },
    options: { readonly preserveNonEmptyDescription?: boolean } = {},
  ): void {
    const existing = this.bots.get(botId)
    if (!existing) return
    const nextAvatar =
      patch.avatarUrl && patch.avatarUrl.trim() ? patch.avatarUrl.trim() : existing.avatarUrl
    const canUpdateDesc =
      patch.description !== undefined &&
      patch.description.trim().length > 0 &&
      (!options.preserveNonEmptyDescription || !existing.description.trim())
    const nextDescription = canUpdateDesc ? patch.description!.trim() : existing.description
    if (nextAvatar === existing.avatarUrl && nextDescription === existing.description) return
    this.bots.set(botId, {
      ...existing,
      avatarUrl: nextAvatar,
      description: nextDescription,
    })
    this.persist()
  }

  deleteBot(id: string): boolean {
    const existed = this.bots.delete(id)
    if (!existed) return false
    for (const [key, grp] of this.groups) {
      if (grp.botId === id) this.groups.delete(key)
    }
    for (const [key, binding] of this.bindings) {
      if (binding.botId === id) {
        this.unindexBindingAliases(binding)
        this.bindings.delete(key)
      }
    }
    this.botMetrics.delete(id)
    this.dreamStates.delete(id)
    for (const [sid, ds] of this.dreamSessions) {
      if (ds.botId === id) this.dreamSessions.delete(sid)
    }
    for (const [remId, rem] of this.reminders) {
      if (rem.origin.botId === id) this.reminders.delete(remId)
    }
    this.persist()
    return true
  }

  listListenerTemplates(): ListenerTemplate[] {
    return DEFAULT_LISTENER_TEMPLATES.map((base) => this.listenerTemplates.get(base.key) ?? base)
  }

  resetListenerTemplates(): ListenerTemplate[] {
    this.listenerTemplates.clear()
    for (const tpl of DEFAULT_LISTENER_TEMPLATES) {
      this.listenerTemplates.set(tpl.key, structuredClone(tpl))
    }
    this.persist()
    return this.listListenerTemplates()
  }

  listGroups(botId?: string): LarkGroupConfig[] {
    const all = [...this.groups.values()]
    return botId ? all.filter((g) => g.botId === botId) : all
  }

  getGroup(botId: string, chatId: string): LarkGroupConfig | undefined {
    return this.groups.get(buildGroupKey(botId, chatId))
  }

  upsertGroup(raw: unknown): LarkGroupConfig {
    const candidate = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {}
    const botId = String(candidate.botId ?? '')
    const chatId = String(candidate.chatId ?? '')
    const key = buildGroupKey(botId, chatId)
    const discovered = this.discoveredChats.get(key)
    const existing = this.groups.get(key)

    const merged: Record<string, unknown> = {
      ...(existing ?? {}),
      ...candidate,
      key,
      botId,
      chatId,
      chatName:
        (typeof candidate.chatName === 'string' && candidate.chatName.trim()) ||
        existing?.chatName ||
        discovered?.name ||
        '',
      description:
        (typeof candidate.description === 'string' && candidate.description.trim()) ||
        existing?.description ||
        discovered?.description ||
        '',
    }
    if ('idleCloseMinutes' in candidate && (candidate.idleCloseMinutes === null || candidate.idleCloseMinutes === undefined)) {
      delete merged.idleCloseMinutes
    }
    const parsed = LarkGroupConfigSchema.parse(merged)
    this.groups.set(key, parsed)

    // Sync modified prompt back to the selected listener template when applicable.
    const tplKey = parsed.listener.templateKey.trim()
    const nextPrompt = parsed.listener.prompt.trim()
    if (tplKey && nextPrompt && this.listenerTemplates.has(tplKey)) {
      const currentTpl = this.listenerTemplates.get(tplKey)!
      if (currentTpl.prompt !== nextPrompt) {
        this.listenerTemplates.set(tplKey, { ...currentTpl, prompt: nextPrompt })
      }
    }

    this.persist()
    return parsed
  }

  deleteGroup(botId: string, chatId: string): boolean {
    const existed = this.groups.delete(buildGroupKey(botId, chatId))
    if (existed) this.persist()
    return existed
  }

  mergeDiscoveredChats(botId: string, chats: readonly DiscoveredLarkChat[]): void {
    for (const key of [...this.discoveredChats.keys()]) {
      if (key.startsWith(`${botId}:`)) {
        this.discoveredChats.delete(key)
      }
    }
    let mutated = false
    for (const chat of chats) {
      const key = buildGroupKey(botId, chat.chatId)
      this.discoveredChats.set(key, chat)
      const existing = this.groups.get(key)
      if (existing && chat.name && existing.chatName !== chat.name) {
        this.groups.set(key, {
          ...existing,
          chatName: chat.name,
          description: existing.description || chat.description || '',
        })
        mutated = true
      }
      const traffic = this.groupTraffic.get(key)
      if (traffic && chat.name && traffic.chatName !== chat.name) {
        traffic.chatName = chat.name
      }
    }
    if (mutated) this.persist()
  }

  listGroupViews(filterBotId?: string): LarkGroupView[] {
    const keys = new Set<string>([
      ...this.groups.keys(),
      ...this.discoveredChats.keys(),
    ])
    const bindings = this.listBindings()
    const views: LarkGroupView[] = []

    for (const key of keys) {
      const configured = this.groups.get(key)
      const discovered = this.discoveredChats.get(key)
      const botId = configured?.botId ?? discovered?.botId ?? ''
      if (!botId || (filterBotId && botId !== filterBotId)) continue
      const bot = this.bots.get(botId)
      if (!bot) continue

      const chatId = configured?.chatId ?? discovered?.chatId ?? ''
      const chatName = configured?.chatName || discovered?.name || chatId
      const description = configured?.description || discovered?.description || ''
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
      const traffic = this.groupTraffic.get(key)
      const effectiveRuntime = resolveEffectiveAgentRuntime(bot, fullConfig)

      views.push({
        key,
        botId,
        botName: bot.name,
        larkAppId: bot.larkAppId,
        chatId,
        chatName,
        description,
        ...(discovered?.avatar ? { avatar: discovered.avatar } : {}),
        configured: Boolean(configured),
        inChat: Boolean(discovered),
        effectiveWorkspaceName: this.resolveGroupWorkspaceName(bot, fullConfig, chatName),
        effectiveWorkingDir: resolveEffectiveWorkingDir(bot, fullConfig),
        runtimeSource: effectiveRuntime.source,
        effectiveAgentPreset: effectiveRuntime.agentPreset,
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

  /**
   * Resolves the effective DSH workspace title for a bot's `defaultWorkingDir`.
   * Defaults to the leaf directory name (`basename(defaultWorkingDir)`), while honoring
   * any explicit `workspaceName` set on this bot or a peer sharing the same directory.
   */
  resolveBotWorkspaceName(bot: LarkBotConfig): string {
    const explicitSelf = bot.workspaceName.trim()
    if (explicitSelf) return explicitSelf

    const targetDir = expandWorkingDir(bot.defaultWorkingDir) || bot.defaultWorkingDir
    const explicitPeer = this.findExplicitWorkspaceNameForDir(targetDir)
    if (explicitPeer) return explicitPeer

    return resolveEffectiveWorkspaceName(bot)
  }

  /**
   * Resolves the effective DSH workspace title for a group's `effectiveWorkingDir`.
   * Defaults to the leaf directory name (`basename(effectiveWorkingDir)`), while honoring
   * any explicit `workspaceName` set on this group or a peer Bot/Group sharing the same directory.
   */
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

  private findExplicitWorkspaceNameForDir(targetDir: string): string | undefined {
    for (const candidate of this.groups.values()) {
      if (!candidate.enabled || !candidate.workspaceName.trim()) continue
      const ownerBot = this.bots.get(candidate.botId)
      if (ownerBot && resolveEffectiveWorkingDir(ownerBot, candidate) === targetDir) {
        return candidate.workspaceName.trim()
      }
    }
    for (const candidateBot of this.bots.values()) {
      if (!candidateBot.enabled || !candidateBot.workspaceName.trim()) continue
      const botDir = expandWorkingDir(candidateBot.defaultWorkingDir) || candidateBot.defaultWorkingDir
      if (botDir === targetDir) {
        return candidateBot.workspaceName.trim()
      }
    }
    for (const candidate of this.groups.values()) {
      if (!candidate.workspaceName.trim()) continue
      const ownerBot = this.bots.get(candidate.botId)
      if (ownerBot && resolveEffectiveWorkingDir(ownerBot, candidate) === targetDir) {
        return candidate.workspaceName.trim()
      }
    }
    for (const candidateBot of this.bots.values()) {
      if (!candidateBot.workspaceName.trim()) continue
      const botDir = expandWorkingDir(candidateBot.defaultWorkingDir) || candidateBot.defaultWorkingDir
      if (botDir === targetDir) {
        return candidateBot.workspaceName.trim()
      }
    }
    return undefined
  }

  listBindings(): LarkSessionBinding[] {
    return [...this.bindings.values()]
      .map((b) => {
        const gKey = buildGroupKey(b.botId, b.chatId)
        const bot = this.bots.get(b.botId)
        const grp = this.groups.get(gKey)
        const disc = this.discoveredChats.get(gKey)
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
      .sort((a, b) => b.lastActivityMs - a.lastActivityMs)
  }

  private resolvePrimaryRouteKey(routeKey: string): string {
    if (this.bindings.has(routeKey)) return routeKey
    return this.routeAliases.get(routeKey) ?? routeKey
  }

  private normalizeAliases(primaryRouteKey: string, aliases?: readonly string[]): string[] {
    if (!aliases || aliases.length === 0) return []
    const out: string[] = []
    for (const raw of aliases) {
      const clean = raw.trim()
      if (!clean || clean === primaryRouteKey || out.includes(clean)) continue
      out.push(clean)
    }
    return out
  }

  private unindexBindingAliases(binding: LarkSessionBinding): void {
    for (const alias of binding.aliasRouteKeys ?? []) {
      if (this.routeAliases.get(alias) === binding.routeKey) {
        this.routeAliases.delete(alias)
      }
    }
  }

  private indexBindingAliases(binding: LarkSessionBinding): void {
    for (const alias of binding.aliasRouteKeys ?? []) {
      if (alias && alias !== binding.routeKey) {
        this.routeAliases.set(alias, binding.routeKey)
      }
    }
  }

  private detachAliasFromOwner(aliasRouteKey: string, excludePrimaryKey?: string): void {
    const ownerKey = this.routeAliases.get(aliasRouteKey)
    if (!ownerKey || ownerKey === excludePrimaryKey) return
    this.routeAliases.delete(aliasRouteKey)
    const owner = this.bindings.get(ownerKey)
    if (!owner?.aliasRouteKeys) return
    const remaining = owner.aliasRouteKeys.filter((k) => k !== aliasRouteKey)
    const updated: LarkSessionBinding = { ...owner }
    if (remaining.length > 0) {
      ;(updated as { aliasRouteKeys?: readonly string[] }).aliasRouteKeys = remaining
    } else {
      delete (updated as { aliasRouteKeys?: readonly string[] }).aliasRouteKeys
    }
    this.bindings.set(ownerKey, updated)
  }

  getBinding(routeKey: string): LarkSessionBinding | undefined {
    return this.bindings.get(this.resolvePrimaryRouteKey(routeKey))
  }

  upsertBinding(binding: LarkSessionBinding): void {
    const prev = this.bindings.get(binding.routeKey)
    if (prev) {
      this.unindexBindingAliases(prev)
    }
    this.detachAliasFromOwner(binding.routeKey, binding.routeKey)

    const rawAliases =
      binding.aliasRouteKeys !== undefined
        ? binding.aliasRouteKeys
        : prev && prev.sessionId === binding.sessionId
          ? prev.aliasRouteKeys
          : undefined
    const aliases = this.normalizeAliases(binding.routeKey, rawAliases).filter((alias) => {
      const directOwner = this.bindings.get(alias)
      return !directOwner || directOwner.sessionId === binding.sessionId
    })
    for (const alias of aliases) {
      this.detachAliasFromOwner(alias, binding.routeKey)
    }

    const normalized: LarkSessionBinding = { ...binding }
    if (aliases.length > 0) {
      ;(normalized as { aliasRouteKeys?: readonly string[] }).aliasRouteKeys = aliases
    } else {
      delete (normalized as { aliasRouteKeys?: readonly string[] }).aliasRouteKeys
    }

    this.bindings.set(normalized.routeKey, normalized)
    this.indexBindingAliases(normalized)
    this.upsertManagedSession({
      sessionId: normalized.sessionId,
      botId: normalized.botId,
      chatId: normalized.chatId,
      routeKey: normalized.routeKey,
      trigger: normalized.trigger,
      createdAtMs: normalized.createdAtMs,
      lastActivityMs: normalized.lastActivityMs,
      ...(normalized.idleCloseMs ? { idleCloseMs: normalized.idleCloseMs } : {}),
    })
  }

  bindRouteAlias(routeKey: string, aliasRouteKey: string): boolean {
    const cleanAlias = aliasRouteKey.trim()
    if (!cleanAlias) return false
    const primaryKey = this.resolvePrimaryRouteKey(routeKey)
    const existing = this.bindings.get(primaryKey)
    if (!existing || cleanAlias === primaryKey) return false
    if (existing.aliasRouteKeys?.includes(cleanAlias)) return false

    const directOwner = this.bindings.get(cleanAlias)
    if (directOwner && directOwner.sessionId !== existing.sessionId) {
      return false
    }
    this.detachAliasFromOwner(cleanAlias, primaryKey)

    const nextAliases = [...(existing.aliasRouteKeys ?? []), cleanAlias]
    const updated: LarkSessionBinding = {
      ...existing,
      aliasRouteKeys: nextAliases,
    }
    this.bindings.set(primaryKey, updated)
    this.routeAliases.set(cleanAlias, primaryKey)
    this.persist()
    return true
  }

  touchBinding(routeKey: string, now = Date.now()): void {
    const primaryKey = this.resolvePrimaryRouteKey(routeKey)
    const existing = this.bindings.get(primaryKey)
    if (!existing) return
    this.bindings.set(primaryKey, { ...existing, lastActivityMs: now })
    const ms = this.managedSessions.get(existing.sessionId)
    if (ms && !ms.archivedAtMs) {
      this.managedSessions.set(existing.sessionId, { ...ms, lastActivityMs: now })
    }
    this.persist()
  }

  markBindingReplied(routeKey: string, now = Date.now()): void {
    const primaryKey = this.resolvePrimaryRouteKey(routeKey)
    const existing = this.bindings.get(primaryKey)
    if (!existing) return
    this.bindings.set(primaryKey, { ...existing, hasReplied: true, lastActivityMs: now })
    const ms = this.managedSessions.get(existing.sessionId)
    if (ms && !ms.archivedAtMs) {
      this.managedSessions.set(existing.sessionId, { ...ms, lastActivityMs: now })
    }
    this.persist()
  }

  deleteBinding(routeKey: string): LarkSessionBinding | undefined {
    const primaryKey = this.resolvePrimaryRouteKey(routeKey)
    const existing = this.bindings.get(primaryKey)
    if (!existing) return undefined
    this.unindexBindingAliases(existing)
    this.bindings.delete(primaryKey)
    this.persist()
    return existing
  }

  getManagedSession(sessionId: string): LarkManagedSession | undefined {
    return this.managedSessions.get(sessionId)
  }

  upsertManagedSession(entry: LarkManagedSession): void {
    const existing = this.managedSessions.get(entry.sessionId)
    this.managedSessions.set(entry.sessionId, {
      ...(existing ?? {}),
      ...entry,
    })
    this.pruneManagedSessions()
    this.persist()
  }

  touchManagedSession(sessionId: string, now = Date.now()): void {
    const existing = this.managedSessions.get(sessionId)
    if (!existing || existing.archivedAtMs) return
    this.managedSessions.set(sessionId, { ...existing, lastActivityMs: now })
    this.persist()
  }

  markSessionArchived(sessionId: string, now = Date.now()): void {
    const existing = this.managedSessions.get(sessionId)
    if (!existing || existing.archivedAtMs) return
    this.managedSessions.set(sessionId, { ...existing, archivedAtMs: now })
    this.persist()
  }

  listExpiredManagedSessions(now = Date.now()): LarkManagedSession[] {
    const out: LarkManagedSession[] = []
    for (const ms of this.managedSessions.values()) {
      if (ms.archivedAtMs) continue
      if (!ms.idleCloseMs || ms.idleCloseMs <= 0) continue
      if (now - ms.lastActivityMs >= ms.idleCloseMs) {
        out.push(ms)
      }
    }
    return out
  }

  listManagedSessionsForBot(botId: string): LarkManagedSession[] {
    return [...this.managedSessions.values()]
      .filter((ms) => ms.botId === botId)
      .sort((a, b) => b.lastActivityMs - a.lastActivityMs)
  }

  getDreamState(botId: string): LarkDreamRunState | undefined {
    return this.dreamStates.get(botId)
  }

  upsertDreamState(state: LarkDreamRunState): LarkDreamRunState {
    const cappedIds =
      state.processedSessionIds.length > 400
        ? state.processedSessionIds.slice(state.processedSessionIds.length - 400)
        : [...state.processedSessionIds]
    const normalized: LarkDreamRunState = {
      ...state,
      processedSessionIds: cappedIds,
    }
    this.dreamStates.set(normalized.botId, normalized)
    this.persist()
    return normalized
  }

  listDreamSessions(botId?: string): LarkDreamSession[] {
    return [...this.dreamSessions.values()]
      .filter((s) => !botId || s.botId === botId)
      .map((s) => {
        const bot = this.bots.get(s.botId)
        return {
          ...s,
          ...(bot?.name ? { botName: bot.name } : {}),
          workspaceName: bot ? this.resolveBotWorkspaceName(bot) : s.workspaceName,
        }
      })
      .sort((a, b) => b.lastActivityMs - a.lastActivityMs)
  }

  upsertDreamSession(entry: LarkDreamSession): LarkDreamSession {
    const existing = this.dreamSessions.get(entry.sessionId)
    const next: LarkDreamSession = {
      ...(existing ?? {}),
      ...entry,
    }
    this.dreamSessions.set(next.sessionId, next)
    this.pruneDreamSessions()
    this.persist()
    return next
  }

  deleteDreamSession(sessionId: string): boolean {
    const existed = this.dreamSessions.delete(sessionId)
    if (existed) this.persist()
    return existed
  }

  private pruneDreamSessions(): void {
    if (this.dreamSessions.size <= MAX_DREAM_SESSIONS) return
    const sorted = [...this.dreamSessions.values()].sort(
      (a, b) => a.lastActivityMs - b.lastActivityMs,
    )
    while (sorted.length > MAX_DREAM_SESSIONS) {
      const oldest = sorted.shift()
      if (oldest) this.dreamSessions.delete(oldest.sessionId)
    }
  }

  listReminders(filter: 'active' | 'archived' | 'all' = 'all'): LarkReminderItem[] {
    const items = [...this.reminders.values()].filter((r) => {
      if (filter === 'active') return r.status !== 'archived'
      if (filter === 'archived') return r.status === 'archived'
      return true
    })
    return items.sort((a, b) => {
      if (a.status === 'archived' && b.status === 'archived') {
        return (b.archivedAtMs ?? b.updatedAtMs) - (a.archivedAtMs ?? a.updatedAtMs)
      }
      if (a.status === 'archived') return 1
      if (b.status === 'archived') return -1
      return Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt)
    })
  }

  getReminder(id: string): LarkReminderItem | undefined {
    return this.reminders.get(id)
  }

  upsertReminder(raw: unknown): LarkReminderItem {
    const parsed = LarkReminderItemSchema.parse(raw)
    this.reminders.set(parsed.id, parsed)
    this.pruneArchivedReminders()
    this.persist()
    return parsed
  }

  deleteReminder(id: string): boolean {
    const existed = this.reminders.delete(id)
    if (existed) this.persist()
    return existed
  }

  private pruneArchivedReminders(): void {
    const archived = [...this.reminders.values()]
      .filter((r) => r.status === 'archived')
      .sort((a, b) => (a.archivedAtMs ?? a.updatedAtMs) - (b.archivedAtMs ?? b.updatedAtMs))
    while (archived.length > MAX_ARCHIVED_REMINDERS) {
      const oldest = archived.shift()
      if (oldest) this.reminders.delete(oldest.id)
    }
  }

  listScheduleBindings(): LarkScheduleBinding[] {
    return [...this.scheduleBindings.values()]
  }

  getScheduleBinding(scheduleId: string): LarkScheduleBinding | undefined {
    return this.scheduleBindings.get(scheduleId)
  }

  upsertScheduleBinding(raw: unknown): LarkScheduleBinding {
    const normalized = parseScheduleBinding(raw)
    this.scheduleBindings.set(normalized.scheduleId, normalized)
    this.persist()
    return normalized
  }

  deleteScheduleBinding(scheduleId: string): boolean {
    const existed = this.scheduleBindings.delete(scheduleId)
    if (existed) this.persist()
    return existed
  }

  resolveChatName(botId: string, chatId: string): string | undefined {
    const key = buildGroupKey(botId, chatId)
    return this.groups.get(key)?.chatName || this.discoveredChats.get(key)?.name
  }

  recordMetric(input: {
    readonly botId: string
    readonly chatId?: string
    readonly chatName?: string
    readonly kind: 'inbound' | 'replied' | 'listener' | 'silent_skip' | 'ignored' | 'error'
    readonly latencyMs?: number
    readonly now?: number
  }): void {
    const now = input.now ?? Date.now()
    const hourKey = formatHourKey(now)
    let bucket = this.hourlyBuckets.get(hourKey)
    if (!bucket) {
      bucket = {
        hourKey,
        inbound: 0,
        replied: 0,
        listenerTriggered: 0,
        silentSkipped: 0,
        ignored: 0,
        errors: 0,
        totalLatencyMs: 0,
        latencySamples: 0,
      }
      this.hourlyBuckets.set(hourKey, bucket)
      this.pruneHourlyBuckets()
    }

    let bm = this.botMetrics.get(input.botId)
    if (!bm) {
      bm = {
        botId: input.botId,
        inboundTotal: 0,
        repliedTotal: 0,
        listenerTriggeredTotal: 0,
        silentSkippedTotal: 0,
        ignoredTotal: 0,
        errorTotal: 0,
        latenciesMs: [],
      }
      this.botMetrics.set(input.botId, bm)
    }

    if (input.kind === 'inbound') {
      bucket.inbound += 1
      bm.inboundTotal += 1
    } else if (input.kind === 'replied') {
      bucket.replied += 1
      bm.repliedTotal += 1
      if (input.latencyMs !== undefined && input.latencyMs >= 0) {
        bucket.totalLatencyMs += input.latencyMs
        bucket.latencySamples += 1
        bm.latenciesMs.push(input.latencyMs)
        if (bm.latenciesMs.length > MAX_LATENCY_SAMPLES) {
          bm.latenciesMs.splice(0, bm.latenciesMs.length - MAX_LATENCY_SAMPLES)
        }
      }
    } else if (input.kind === 'listener') {
      bucket.listenerTriggered += 1
      bm.listenerTriggeredTotal += 1
    } else if (input.kind === 'silent_skip') {
      bucket.silentSkipped += 1
      bm.silentSkippedTotal += 1
    } else if (input.kind === 'ignored') {
      bucket.ignored += 1
      bm.ignoredTotal += 1
    } else if (input.kind === 'error') {
      bucket.errors += 1
      bm.errorTotal += 1
    }

    if (input.chatId && (input.kind === 'inbound' || input.kind === 'replied')) {
      const gKey = buildGroupKey(input.botId, input.chatId)
      let gt = this.groupTraffic.get(gKey)
      const knownName =
        input.chatName ||
        this.groups.get(gKey)?.chatName ||
        this.discoveredChats.get(gKey)?.name ||
        input.chatId
      if (!gt) {
        gt = {
          key: gKey,
          botId: input.botId,
          chatId: input.chatId,
          chatName: knownName,
          inboundTotal: 0,
          repliedTotal: 0,
          lastActiveMs: now,
        }
        this.groupTraffic.set(gKey, gt)
      }
      if (input.kind === 'inbound') gt.inboundTotal += 1
      if (input.kind === 'replied') gt.repliedTotal += 1
      gt.lastActiveMs = now
      if (input.chatName) gt.chatName = input.chatName
    }

    this.persist()
  }

  recordEvent(input: Omit<LarkAuditEvent, 'id' | 'timestampMs'>): LarkAuditEvent {
    const bot = this.bots.get(input.botId)
    const group = input.chatId ? this.groups.get(buildGroupKey(input.botId, input.chatId)) : undefined
    const discovered = input.chatId
      ? this.discoveredChats.get(buildGroupKey(input.botId, input.chatId))
      : undefined

    const event: LarkAuditEvent = {
      id: randomUUID(),
      timestampMs: Date.now(),
      botName: input.botName ?? bot?.name,
      chatName: input.chatName ?? group?.chatName ?? discovered?.name,
      ...input,
    }
    this.auditEvents.unshift(event)
    if (this.auditEvents.length > this.maxAuditEvents) {
      this.auditEvents.length = this.maxAuditEvents
    }
    this.persist()
    return event
  }

  listEvents(limit = 100): LarkAuditEvent[] {
    return this.auditEvents.slice(0, Math.max(1, Math.min(limit, this.maxAuditEvents)))
  }

  buildCockpit(
    statuses: readonly LarkBotStatus[],
    sessionUrlBuilder: (sessionId: string) => string,
    now = Date.now(),
  ): LarkCockpitPayload {
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
      const bucket = this.hourlyBuckets.get(key)
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

    const allLatencies = [...this.botMetrics.values()].flatMap((m) => m.latenciesMs)
    const latencyStats = calcStats(allLatencies)

    const enabledStatuses = statuses.filter((s) => s.enabled)
    const onlineBots = enabledStatuses.filter((s) => s.connected).length
    const serviceHealthy = enabledStatuses.length === 0 || onlineBots === enabledStatuses.length

    const botRows = statuses.map((st) => {
      const bot = this.bots.get(st.botId)
      const bm = this.botMetrics.get(st.botId)
      const lat = calcStats(bm?.latenciesMs ?? [])
      const avatarUrl = st.avatarUrl || bot?.avatarUrl
      return {
        ...st,
        ...(avatarUrl ? { avatarUrl } : {}),
        workspaceName: bot ? this.resolveBotWorkspaceName(bot) : st.name,
        agentPreset: bot?.agentPreset ?? 'codex',
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

    const topGroups = [...this.groupTraffic.values()]
      .sort((a, b) => b.inboundTotal - a.inboundTotal || b.lastActiveMs - a.lastActiveMs)
      .slice(0, 8)
      .map((gt) => {
        const bot = this.bots.get(gt.botId)
        const group = this.groups.get(gt.key)
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

    const configuredGroups = this.groups.size
    const activeListeners = [...this.groups.values()].filter(
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
      recentEvents: this.listEvents(40),
      listenerTemplates: this.listListenerTemplates(),
    }
  }

  private pruneHourlyBuckets(): void {
    if (this.hourlyBuckets.size <= MAX_HOURLY_BUCKETS) return
    const keys = [...this.hourlyBuckets.keys()].sort()
    while (keys.length > MAX_HOURLY_BUCKETS) {
      const oldest = keys.shift()
      if (oldest) this.hourlyBuckets.delete(oldest)
    }
  }

  private pruneManagedSessions(): void {
    if (this.managedSessions.size <= MAX_MANAGED_SESSIONS) return
    const sorted = [...this.managedSessions.values()].sort(
      (a, b) => a.lastActivityMs - b.lastActivityMs,
    )
    while (sorted.length > MAX_MANAGED_SESSIONS) {
      const oldest = sorted.shift()
      if (oldest) this.managedSessions.delete(oldest.sessionId)
    }
  }

  private load(): void {
    if (!existsSync(this.statePath)) return
    try {
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8')) as Record<string, unknown>
      const rawBots = Array.isArray(raw.bots) ? raw.bots : []
      let needsPersist = raw.version !== 3

      for (const item of rawBots) {
        if (!item || typeof item !== 'object') continue
        const rec = item as Record<string, unknown>
        const mappedBotInput: Record<string, unknown> = {
          ...rec,
          groupReplyMode: rec.groupReplyMode ?? rec.regularGroupReplyMode ?? 'new-topic',
          p2pEnabled: rec.p2pEnabled ?? (rec.p2pOpen === true || Array.isArray(rec.allowedUsers)),
          idleCloseMinutes: rec.idleCloseMinutes ?? rec.idleSuspendMinutes ?? 720,
        }
        const parsedBot = LarkBotConfigSchema.safeParse(mappedBotInput)
        if (!parsedBot.success) continue
        this.bots.set(parsedBot.data.id, parsedBot.data)
      }

      if (Array.isArray(raw.groups)) {
        for (const rawGroup of raw.groups) {
          const parsed = LarkGroupConfigSchema.safeParse(rawGroup)
          if (parsed.success) {
            this.groups.set(parsed.data.key, parsed.data)
          }
        }
      }

      if (typeof raw.viewerTicketSecret === 'string' && raw.viewerTicketSecret.trim().length >= 32) {
        this.viewerTicketSecret = raw.viewerTicketSecret.trim()
      }

      if (Array.isArray(raw.listenerTemplates)) {
        for (const rawTpl of raw.listenerTemplates) {
          const parsed = ListenerTemplateSchema.safeParse(rawTpl)
          if (parsed.success && DEFAULT_LISTENER_TEMPLATES.some((d) => d.key === parsed.data.key)) {
            this.listenerTemplates.set(parsed.data.key, parsed.data)
          }
        }
      }

      if (Array.isArray(raw.managedSessions)) {
        for (const item of raw.managedSessions as Partial<LarkManagedSession>[]) {
          if (!item?.sessionId || !item?.botId || !item?.chatId) continue
          this.managedSessions.set(item.sessionId, {
            sessionId: item.sessionId,
            botId: item.botId,
            chatId: item.chatId,
            ...(item.routeKey ? { routeKey: item.routeKey } : {}),
            ...(item.trigger ? { trigger: item.trigger } : {}),
            createdAtMs: item.createdAtMs ?? Date.now(),
            lastActivityMs: item.lastActivityMs ?? Date.now(),
            ...(item.idleCloseMs ? { idleCloseMs: item.idleCloseMs } : {}),
            ...(item.archivedAtMs ? { archivedAtMs: item.archivedAtMs } : {}),
          })
        }
      }

      if (Array.isArray(raw.dreamStates)) {
        for (const ds of raw.dreamStates as Partial<LarkDreamRunState>[]) {
          if (!ds?.botId || typeof ds.botId !== 'string') continue
          const status =
            ds.status === 'succeeded' ||
            ds.status === 'skipped' ||
            ds.status === 'failed'
              ? ds.status
              : 'idle'
          this.dreamStates.set(ds.botId, {
            botId: ds.botId,
            status,
            ...(typeof ds.lastDreamAtMs === 'number' ? { lastDreamAtMs: ds.lastDreamAtMs } : {}),
            ...(typeof ds.lastCheckedDateKey === 'string'
              ? { lastCheckedDateKey: ds.lastCheckedDateKey }
              : {}),
            ...(typeof ds.lastSessionId === 'string' ? { lastSessionId: ds.lastSessionId } : {}),
            ...(typeof ds.lastProcessedCount === 'number'
              ? { lastProcessedCount: ds.lastProcessedCount }
              : {}),
            ...(typeof ds.lastSummary === 'string' ? { lastSummary: ds.lastSummary } : {}),
            processedSessionIds: Array.isArray(ds.processedSessionIds)
              ? ds.processedSessionIds.filter((id): id is string => typeof id === 'string')
              : [],
          })
        }
      }

      if (Array.isArray(raw.dreamSessions)) {
        for (const item of raw.dreamSessions as Partial<LarkDreamSession>[]) {
          if (!item?.sessionId || !item?.botId) continue
          const bot = this.bots.get(item.botId)
          const wasRunning = item.status === 'running'
          const status: LarkDreamSession['status'] =
            item.status === 'succeeded' || item.status === 'failed'
              ? item.status
              : 'failed'
          const createdAtMs = typeof item.createdAtMs === 'number' ? item.createdAtMs : Date.now()
          const lastActivityMs =
            typeof item.lastActivityMs === 'number' ? item.lastActivityMs : createdAtMs
          const summary = wasRunning
            ? '执行因服务重启中断'
            : typeof item.summary === 'string' && item.summary.trim()
              ? item.summary.trim()
              : undefined
          this.dreamSessions.set(item.sessionId, {
            sessionId: item.sessionId,
            botId: item.botId,
            ...(item.botName ?? bot?.name ? { botName: item.botName ?? bot?.name } : {}),
            workspaceName:
              item.workspaceName ||
              (bot ? this.resolveBotWorkspaceName(bot) : item.botId),
            workingDir: item.workingDir || bot?.defaultWorkingDir || '',
            agentPreset: item.agentPreset || bot?.agentPreset || 'standard',
            ...(item.model ?? bot?.model ? { model: item.model ?? bot?.model } : {}),
            status,
            dateKey:
              typeof item.dateKey === 'string' && item.dateKey.trim()
                ? item.dateKey.trim()
                : formatLocalDateKey(lastActivityMs),
            processedCount:
              typeof item.processedCount === 'number' && Number.isFinite(item.processedCount)
                ? item.processedCount
                : 0,
            ...(summary ? { summary } : {}),
            createdAtMs,
            lastActivityMs,
            ...(typeof item.durationMs === 'number' ? { durationMs: item.durationMs } : {}),
          })
          if (wasRunning) needsPersist = true
        }
      }

      if (Array.isArray(raw.reminders)) {
        for (const rem of raw.reminders) {
          const parsed = LarkReminderItemSchema.safeParse(rem)
          if (parsed.success) {
            this.reminders.set(parsed.data.id, parsed.data)
          }
        }
      }

      if (Array.isArray(raw.bindings)) {
        for (const b of raw.bindings as Array<Partial<LarkSessionBinding> & { workspaceGroupName?: string }>) {
          if (!b?.routeKey || !b?.sessionId || !b?.botId || !b?.chatId) continue
          const bot = this.bots.get(b.botId)
          const grp = this.groups.get(buildGroupKey(b.botId, b.chatId))
          const aliasRouteKeys = this.normalizeAliases(
            b.routeKey,
            Array.isArray(b.aliasRouteKeys)
              ? b.aliasRouteKeys.filter((k): k is string => typeof k === 'string')
              : undefined,
          )
          const binding: LarkSessionBinding = {
            routeKey: b.routeKey,
            ...(aliasRouteKeys.length > 0 ? { aliasRouteKeys } : {}),
            botId: b.botId,
            botName: b.botName ?? bot?.name,
            larkAppId: b.larkAppId ?? bot?.larkAppId ?? '',
            ...(b.chatType ? { chatType: b.chatType } : {}),
            chatId: b.chatId,
            chatName: b.chatName ?? grp?.chatName,
            ...(b.userOpenId ? { userOpenId: b.userOpenId } : {}),
            ...(b.userName ? { userName: b.userName } : {}),
            workspaceName:
              b.workspaceName ||
              b.workspaceGroupName ||
              (bot
                ? b.chatType === 'p2p' || b.trigger === 'p2p'
                  ? this.resolveBotWorkspaceName(bot)
                  : this.resolveGroupWorkspaceName(bot, grp, b.chatName ?? grp?.chatName)
                : b.botId),
            sessionId: b.sessionId,
            agentPreset: b.agentPreset ?? 'codex',
            ...(b.model ? { model: b.model } : {}),
            ...(b.reasoningEffort ? { reasoningEffort: b.reasoningEffort } : {}),
            workingDir: b.workingDir ?? bot?.defaultWorkingDir ?? process.cwd(),
            trigger: b.trigger ?? 'mention',
            ...(b.listenerName ? { listenerName: b.listenerName } : {}),
            ...(typeof b.hasReplied === 'boolean' ? { hasReplied: b.hasReplied } : {}),
            createdAtMs: b.createdAtMs ?? Date.now(),
            lastActivityMs: b.lastActivityMs ?? Date.now(),
            ...(b.idleCloseMs ? { idleCloseMs: b.idleCloseMs } : {}),
          }
          this.bindings.set(binding.routeKey, binding)
          this.indexBindingAliases(binding)
          if (!this.managedSessions.has(binding.sessionId)) {
            this.managedSessions.set(binding.sessionId, {
              sessionId: binding.sessionId,
              botId: binding.botId,
              chatId: binding.chatId,
              routeKey: binding.routeKey,
              ...(binding.trigger ? { trigger: binding.trigger } : {}),
              createdAtMs: binding.createdAtMs,
              lastActivityMs: binding.lastActivityMs,
              ...(binding.idleCloseMs ? { idleCloseMs: binding.idleCloseMs } : {}),
            })
          }
        }
      }

      if (Array.isArray(raw.scheduleBindings)) {
        for (const sb of raw.scheduleBindings) {
          try {
            const parsed = parseScheduleBinding(sb)
            this.scheduleBindings.set(parsed.scheduleId, parsed)
          } catch {
            // Skip malformed entry.
          }
        }
      }

      if (Array.isArray(raw.hourlyBuckets)) {
        for (const hb of raw.hourlyBuckets as LarkHourlyBucket[]) {
          if (hb?.hourKey) this.hourlyBuckets.set(hb.hourKey, hb)
        }
      }

      if (Array.isArray(raw.botMetrics)) {
        for (const bm of raw.botMetrics as LarkBotMetrics[]) {
          if (bm?.botId) this.botMetrics.set(bm.botId, bm)
        }
      }

      if (Array.isArray(raw.groupTraffic)) {
        for (const gt of raw.groupTraffic as LarkGroupTraffic[]) {
          if (gt?.key) this.groupTraffic.set(gt.key, gt)
        }
      }

      if (Array.isArray(raw.auditEvents)) {
        for (const ev of (raw.auditEvents as LarkAuditEvent[]).slice(0, this.maxAuditEvents)) {
          if (ev?.id) this.auditEvents.push(ev)
        }
      }

      // One-time backfill for legacy state files that predated `dreamSessions`.
      if (!Array.isArray(raw.dreamSessions)) {
        const backfilled = this.backfillLegacyDreamSessions()
        if (backfilled > 0) needsPersist = true
      }

      if (needsPersist) {
        this.persist()
      }
    } catch {
      // Leave store empty if unreadable.
    }
  }

  private backfillLegacyDreamSessions(): number {
    let added = 0
    for (const ds of this.dreamStates.values()) {
      if (!ds.lastSessionId || this.dreamSessions.has(ds.lastSessionId)) continue
      if (ds.status !== 'succeeded' && ds.status !== 'failed') continue
      const bot = this.bots.get(ds.botId)
      const ts = ds.lastDreamAtMs ?? Date.now()
      const cleanSummary = stripDreamSummaryPrefix(ds.lastSummary)
      this.dreamSessions.set(ds.lastSessionId, {
        sessionId: ds.lastSessionId,
        botId: ds.botId,
        ...(bot?.name ? { botName: bot.name } : {}),
        workspaceName: bot ? this.resolveBotWorkspaceName(bot) : ds.botId,
        workingDir: bot?.defaultWorkingDir ?? '',
        agentPreset: bot?.agentPreset ?? 'standard',
        ...(bot?.model ? { model: bot.model } : {}),
        status: ds.status,
        dateKey: ds.lastCheckedDateKey || formatLocalDateKey(ts),
        processedCount: ds.lastProcessedCount ?? 0,
        ...(cleanSummary ? { summary: cleanSummary } : {}),
        createdAtMs: ts,
        lastActivityMs: ts,
      })
      added += 1
    }

    for (const ev of this.auditEvents) {
      if (!ev.sessionId || this.dreamSessions.has(ev.sessionId)) continue
      const isDreamDone = ev.summary.startsWith('Dreaming 完成')
      const isDreamFail = ev.summary.startsWith('Dreaming 失败')
      if (!isDreamDone && !isDreamFail) continue
      const bot = this.bots.get(ev.botId)
      const countMatch = /已整理\s+(\d+)\s+个会话/.exec(ev.summary)
      const failReason = isDreamFail ? ev.summary.replace(/^Dreaming 失败[：:]\s*/, '').trim() : undefined
      this.dreamSessions.set(ev.sessionId, {
        sessionId: ev.sessionId,
        botId: ev.botId,
        ...(ev.botName ?? bot?.name ? { botName: ev.botName ?? bot?.name } : {}),
        workspaceName: bot ? this.resolveBotWorkspaceName(bot) : ev.botId,
        workingDir: bot?.defaultWorkingDir ?? '',
        agentPreset: bot?.agentPreset ?? 'standard',
        ...(bot?.model ? { model: bot.model } : {}),
        status: isDreamFail ? 'failed' : 'succeeded',
        dateKey: formatLocalDateKey(ev.timestampMs),
        processedCount: countMatch ? Number(countMatch[1]) : 0,
        ...(failReason ? { summary: failReason } : {}),
        createdAtMs: ev.timestampMs,
        lastActivityMs: ev.timestampMs,
        ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}),
      })
      added += 1
    }

    if (added > 0) this.pruneDreamSessions()
    return added
  }

  private persist(): void {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    const payload: PersistedStateV3 = {
      version: 3,
      ...(this.viewerTicketSecret ? { viewerTicketSecret: this.viewerTicketSecret } : {}),
      bots: [...this.bots.values()],
      groups: [...this.groups.values()],
      bindings: [...this.bindings.values()],
      managedSessions: [...this.managedSessions.values()],
      dreamStates: [...this.dreamStates.values()],
      dreamSessions: [...this.dreamSessions.values()],
      reminders: [...this.reminders.values()],
      listenerTemplates: this.listListenerTemplates(),
      scheduleBindings: [...this.scheduleBindings.values()],
      hourlyBuckets: [...this.hourlyBuckets.values()],
      botMetrics: [...this.botMetrics.values()],
      groupTraffic: [...this.groupTraffic.values()],
      auditEvents: this.auditEvents.slice(0, this.maxAuditEvents),
    }
    const tmpPath = `${this.statePath}.${process.pid}.tmp`
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmpPath, this.statePath)
  }
}
