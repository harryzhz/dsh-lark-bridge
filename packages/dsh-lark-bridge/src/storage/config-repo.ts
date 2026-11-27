import { randomBytes } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_LISTENER_TEMPLATES,
  DEFAULT_NEW_GROUP_CONVERSATION_CONFIG,
  LarkBotConfigSchema,
  LarkGroupConfigSchema,
  ListenerTemplateSchema,
  buildGroupKey,
  type DiscoveredLarkChat,
  type LarkBotConfig,
  type LarkGroupConfig,
  type ListenerTemplate,
} from '@dsh-lark/lark-core'
import {
  normalizeRuntimeConcurrencyKey,
  parseRuntimeConcurrencyLimit,
  sanitizeRuntimeConcurrencyLimits,
} from '../runtime-concurrency.js'
import type {
  LarkScheduleBinding,
  LarkScheduleDeliveryMode,
  LarkScheduleNotifyOn,
  LarkScheduleTarget,
} from '../types.js'
import {
  CONFIG_SNAPSHOT_FILENAME,
  tightenFileMode,
  type BridgeDatabase,
} from './database.js'

const SNAPSHOT_DEBOUNCE_MS = 500
const RUNTIME_CONCURRENCY_LIMITS_META_KEY = 'runtime_concurrency_limits_json'

export function parseScheduleBinding(raw: unknown): LarkScheduleBinding {
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

export class ConfigRepo {
  private readonly discoveredChats = new Map<string, DiscoveredLarkChat>()
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null
  private snapshotDirty = false
  private viewerSecretCache: string | null = null
  private runtimeConcurrencyLimitsCache: Record<string, number> | null = null
  private botsCache: { list: LarkBotConfig[]; byId: Map<string, LarkBotConfig> } | null = null
  private groupsCache: { list: LarkGroupConfig[]; byKey: Map<string, LarkGroupConfig> } | null = null
  private listenerTemplatesCache: ListenerTemplate[] | null = null

  constructor(
    private readonly db: BridgeDatabase,
    private readonly dataDir: string,
  ) {}

  private loadBotsCache(): { list: LarkBotConfig[]; byId: Map<string, LarkBotConfig> } {
    if (this.botsCache) return this.botsCache
    const rows = this.db
      .prepare('SELECT config_json FROM bots ORDER BY rowid ASC')
      .all() as Array<{ config_json: string }>
    const list: LarkBotConfig[] = []
    const byId = new Map<string, LarkBotConfig>()
    for (const row of rows) {
      try {
        const parsed = LarkBotConfigSchema.safeParse(JSON.parse(row.config_json))
        if (parsed.success) {
          list.push(parsed.data)
          byId.set(parsed.data.id, parsed.data)
        }
      } catch {
        // Skip corrupt row defensively.
      }
    }
    this.botsCache = { list, byId }
    return this.botsCache
  }

  private loadGroupsCache(): { list: LarkGroupConfig[]; byKey: Map<string, LarkGroupConfig> } {
    if (this.groupsCache) return this.groupsCache
    const rows = this.db
      .prepare('SELECT config_json FROM groups ORDER BY rowid ASC')
      .all() as Array<{ config_json: string }>
    const list: LarkGroupConfig[] = []
    const byKey = new Map<string, LarkGroupConfig>()
    for (const row of rows) {
      try {
        const parsed = LarkGroupConfigSchema.safeParse(JSON.parse(row.config_json))
        if (parsed.success) {
          list.push(parsed.data)
          byKey.set(parsed.data.key, parsed.data)
        }
      } catch {
        // Skip corrupt row.
      }
    }
    this.groupsCache = { list, byKey }
    return this.groupsCache
  }

  getViewerTicketSecret(): string {
    if (this.viewerSecretCache) return this.viewerSecretCache
    const existing = this.db.getMeta('viewer_ticket_secret')?.trim()
    if (existing && existing.length >= 32) {
      this.viewerSecretCache = existing
      return existing
    }
    const next = randomBytes(32).toString('hex')
    this.db.setMeta('viewer_ticket_secret', next)
    this.viewerSecretCache = next
    this.scheduleConfigSnapshot()
    return next
  }

  rotateViewerTicketSecret(): string {
    const next = randomBytes(32).toString('hex')
    this.db.setMeta('viewer_ticket_secret', next)
    this.viewerSecretCache = next
    this.scheduleConfigSnapshot()
    return next
  }

  listBots(): LarkBotConfig[] {
    return [...this.loadBotsCache().list]
  }

  getBot(id: string): LarkBotConfig | undefined {
    return this.loadBotsCache().byId.get(id)
  }

  upsertBot(raw: unknown): LarkBotConfig {
    const candidate = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {}
    const existing = typeof candidate.id === 'string' ? this.getBot(candidate.id) : undefined
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

    this.db
      .prepare(
        `INSERT INTO bots (id, name, lark_app_id, enabled, config_json, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           lark_app_id = excluded.lark_app_id,
           enabled = excluded.enabled,
           config_json = excluded.config_json,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(
        finalBot.id,
        finalBot.name,
        finalBot.larkAppId,
        finalBot.enabled ? 1 : 0,
        JSON.stringify(finalBot),
        Date.now(),
      )
    this.botsCache = null
    this.scheduleConfigSnapshot()
    return finalBot
  }

  updateBotProfile(
    botId: string,
    patch: { readonly avatarUrl?: string; readonly description?: string },
    options: { readonly preserveNonEmptyDescription?: boolean } = {},
  ): void {
    const existing = this.getBot(botId)
    if (!existing) return
    const nextAvatar =
      patch.avatarUrl && patch.avatarUrl.trim() ? patch.avatarUrl.trim() : existing.avatarUrl
    const canUpdateDesc =
      patch.description !== undefined &&
      patch.description.trim().length > 0 &&
      (!options.preserveNonEmptyDescription || !existing.description.trim())
    const nextDescription = canUpdateDesc ? patch.description!.trim() : existing.description
    if (nextAvatar === existing.avatarUrl && nextDescription === existing.description) return
    const updated: LarkBotConfig = {
      ...existing,
      avatarUrl: nextAvatar,
      description: nextDescription,
    }
    this.db
      .prepare('UPDATE bots SET config_json = ?, updated_at_ms = ? WHERE id = ?')
      .run(JSON.stringify(updated), Date.now(), botId)
    this.botsCache = null
    this.scheduleConfigSnapshot()
  }

  deleteBot(id: string): boolean {
    const deleted = this.db.transaction(() => {
      const res = this.db.prepare('DELETE FROM bots WHERE id = ?').run(id)
      if (Number(res.changes) === 0) return false
      this.db.prepare('DELETE FROM groups WHERE bot_id = ?').run(id)
      // binding_aliases rows cascade automatically via FK ON DELETE CASCADE.
      this.db.prepare('DELETE FROM session_bindings WHERE bot_id = ?').run(id)
      this.db.prepare('DELETE FROM bot_metrics WHERE bot_id = ?').run(id)
      this.db.prepare('DELETE FROM dream_states WHERE bot_id = ?').run(id)
      this.db.prepare('DELETE FROM dream_sessions WHERE bot_id = ?').run(id)
      this.db.prepare('DELETE FROM reminders WHERE bot_id = ?').run(id)
      this.db.prepare('DELETE FROM pending_turns WHERE bot_id = ?').run(id)
      return true
    })
    if (deleted) {
      this.botsCache = null
      this.groupsCache = null
      for (const key of [...this.discoveredChats.keys()]) {
        if (key.startsWith(`${id}:`)) this.discoveredChats.delete(key)
      }
      this.scheduleConfigSnapshot()
    }
    return deleted
  }

  listListenerTemplates(): ListenerTemplate[] {
    if (this.listenerTemplatesCache) return [...this.listenerTemplatesCache]
    const rows = this.db
      .prepare('SELECT key, config_json FROM listener_templates')
      .all() as Array<{ key: string; config_json: string }>
    const stored = new Map<string, ListenerTemplate>()
    for (const row of rows) {
      try {
        const parsed = ListenerTemplateSchema.safeParse(JSON.parse(row.config_json))
        if (parsed.success) stored.set(parsed.data.key, parsed.data)
      } catch {
        // Fallback to default template.
      }
    }
    this.listenerTemplatesCache = DEFAULT_LISTENER_TEMPLATES.map(
      (base) => stored.get(base.key) ?? structuredClone(base),
    )
    return [...this.listenerTemplatesCache]
  }

  resetListenerTemplates(): ListenerTemplate[] {
    const now = Date.now()
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM listener_templates').run()
      const stmt = this.db.prepare(
        'INSERT INTO listener_templates (key, config_json, updated_at_ms) VALUES (?, ?, ?)',
      )
      for (const tpl of DEFAULT_LISTENER_TEMPLATES) {
        stmt.run(tpl.key, JSON.stringify(tpl), now)
      }
    })
    this.listenerTemplatesCache = null
    this.scheduleConfigSnapshot()
    return this.listListenerTemplates()
  }

  listGroups(botId?: string): LarkGroupConfig[] {
    const { list } = this.loadGroupsCache()
    return botId ? list.filter((g) => g.botId === botId) : [...list]
  }

  getGroup(botId: string, chatId: string): LarkGroupConfig | undefined {
    return this.getGroupByKey(buildGroupKey(botId, chatId))
  }

  getGroupByKey(key: string): LarkGroupConfig | undefined {
    return this.loadGroupsCache().byKey.get(key)
  }

  upsertGroup(raw: unknown): LarkGroupConfig {
    const candidate = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {}
    const botId = String(candidate.botId ?? '')
    const chatId = String(candidate.chatId ?? '')
    const key = buildGroupKey(botId, chatId)
    const discovered = this.discoveredChats.get(key)
    const existing = this.getGroupByKey(key)

    const merged: Record<string, unknown> = {
      ...(existing ?? DEFAULT_NEW_GROUP_CONVERSATION_CONFIG),
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
    if (
      'idleCloseMinutes' in candidate &&
      (candidate.idleCloseMinutes === null || candidate.idleCloseMinutes === undefined)
    ) {
      delete merged.idleCloseMinutes
    }
    const parsed = LarkGroupConfigSchema.parse(merged)
    const now = Date.now()

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO groups (key, bot_id, chat_id, chat_name, enabled, listener_enabled, config_json, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             bot_id = excluded.bot_id,
             chat_id = excluded.chat_id,
             chat_name = excluded.chat_name,
             enabled = excluded.enabled,
             listener_enabled = excluded.listener_enabled,
             config_json = excluded.config_json,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(
          parsed.key,
          parsed.botId,
          parsed.chatId,
          parsed.chatName,
          parsed.enabled ? 1 : 0,
          parsed.listener.enabled ? 1 : 0,
          JSON.stringify(parsed),
          now,
        )

      const tplKey = parsed.listener.templateKey.trim()
      const nextPrompt = parsed.listener.prompt.trim()
      if (tplKey && nextPrompt) {
        const baseTpl = this.listListenerTemplates().find((t) => t.key === tplKey)
        if (baseTpl && baseTpl.prompt !== nextPrompt) {
          const updatedTpl: ListenerTemplate = { ...baseTpl, prompt: nextPrompt }
          this.db
            .prepare(
              `INSERT INTO listener_templates (key, config_json, updated_at_ms)
               VALUES (?, ?, ?)
               ON CONFLICT(key) DO UPDATE SET config_json = excluded.config_json, updated_at_ms = excluded.updated_at_ms`,
            )
            .run(tplKey, JSON.stringify(updatedTpl), now)
          this.listenerTemplatesCache = null
        }
      }
    })

    this.groupsCache = null
    this.scheduleConfigSnapshot()
    return parsed
  }

  deleteGroup(botId: string, chatId: string): boolean {
    const res = this.db
      .prepare('DELETE FROM groups WHERE key = ?')
      .run(buildGroupKey(botId, chatId))
    const existed = Number(res.changes) > 0
    if (existed) {
      this.groupsCache = null
      this.scheduleConfigSnapshot()
    }
    return existed
  }

  mergeDiscoveredChats(botId: string, chats: readonly DiscoveredLarkChat[]): void {
    for (const key of [...this.discoveredChats.keys()]) {
      if (key.startsWith(`${botId}:`)) {
        this.discoveredChats.delete(key)
      }
    }
    const now = Date.now()
    let configMutated = false
    this.db.transaction(() => {
      for (const chat of chats) {
        const key = buildGroupKey(botId, chat.chatId)
        this.discoveredChats.set(key, chat)
        const existing = this.getGroupByKey(key)
        if (existing && chat.name && existing.chatName !== chat.name) {
          const updated: LarkGroupConfig = {
            ...existing,
            chatName: chat.name,
            description: existing.description || chat.description || '',
          }
          this.db
            .prepare(
              'UPDATE groups SET chat_name = ?, config_json = ?, updated_at_ms = ? WHERE key = ?',
            )
            .run(updated.chatName, JSON.stringify(updated), now, key)
          configMutated = true
        }
        if (chat.name) {
          this.db
            .prepare('UPDATE group_traffic SET chat_name = ? WHERE key = ? AND chat_name != ?')
            .run(chat.name, key, chat.name)
        }
      }
    })
    if (configMutated) {
      this.groupsCache = null
      this.scheduleConfigSnapshot()
    }
  }

  getDiscoveredChats(): ReadonlyMap<string, DiscoveredLarkChat> {
    return this.discoveredChats
  }

  resolveChatName(botId: string, chatId: string): string | undefined {
    const key = buildGroupKey(botId, chatId)
    return this.getGroupByKey(key)?.chatName || this.discoveredChats.get(key)?.name
  }

  listScheduleBindings(): LarkScheduleBinding[] {
    const rows = this.db
      .prepare(
        'SELECT schedule_id, enabled, delivery_mode, notify_on, send_intermediate, targets_json FROM schedule_bindings ORDER BY rowid ASC',
      )
      .all() as Array<{
      schedule_id: string
      enabled: number
      delivery_mode: string
      notify_on: string
      send_intermediate: number
      targets_json: string
    }>
    return rows.map((row) => this.hydrateScheduleBinding(row))
  }

  getScheduleBinding(scheduleId: string): LarkScheduleBinding | undefined {
    const row = this.db
      .prepare(
        'SELECT schedule_id, enabled, delivery_mode, notify_on, send_intermediate, targets_json FROM schedule_bindings WHERE schedule_id = ?',
      )
      .get(scheduleId) as
      | {
          schedule_id: string
          enabled: number
          delivery_mode: string
          notify_on: string
          send_intermediate: number
          targets_json: string
        }
      | undefined
    return row ? this.hydrateScheduleBinding(row) : undefined
  }

  upsertScheduleBinding(raw: unknown): LarkScheduleBinding {
    const normalized = parseScheduleBinding(raw)
    this.db
      .prepare(
        `INSERT INTO schedule_bindings (schedule_id, enabled, delivery_mode, notify_on, send_intermediate, targets_json, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(schedule_id) DO UPDATE SET
           enabled = excluded.enabled,
           delivery_mode = excluded.delivery_mode,
           notify_on = excluded.notify_on,
           send_intermediate = excluded.send_intermediate,
           targets_json = excluded.targets_json,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(
        normalized.scheduleId,
        normalized.enabled ? 1 : 0,
        normalized.deliveryMode,
        normalized.notifyOn,
        normalized.sendIntermediateMessages ? 1 : 0,
        JSON.stringify(normalized.targets),
        Date.now(),
      )
    this.scheduleConfigSnapshot()
    return normalized
  }

  deleteScheduleBinding(scheduleId: string): boolean {
    const res = this.db
      .prepare('DELETE FROM schedule_bindings WHERE schedule_id = ?')
      .run(scheduleId)
    const existed = Number(res.changes) > 0
    if (existed) this.scheduleConfigSnapshot()
    return existed
  }

  getRuntimeConcurrencyLimits(): Record<string, number> {
    if (this.runtimeConcurrencyLimitsCache) {
      return { ...this.runtimeConcurrencyLimitsCache }
    }
    const raw = this.db.getMeta(RUNTIME_CONCURRENCY_LIMITS_META_KEY)
    if (!raw) {
      this.runtimeConcurrencyLimitsCache = {}
      return {}
    }
    try {
      this.runtimeConcurrencyLimitsCache = sanitizeRuntimeConcurrencyLimits(JSON.parse(raw))
    } catch {
      this.runtimeConcurrencyLimitsCache = {}
    }
    return { ...this.runtimeConcurrencyLimitsCache }
  }

  setRuntimeConcurrencyLimit(runtimeKey: string, limit: number | null): Record<string, number> {
    const key = normalizeRuntimeConcurrencyKey(runtimeKey)
    const parsed = parseRuntimeConcurrencyLimit(limit)
    const next = this.getRuntimeConcurrencyLimits()
    if (parsed === null) {
      delete next[key]
    } else {
      next[key] = parsed
    }
    if (Object.keys(next).length === 0) {
      this.db.deleteMeta(RUNTIME_CONCURRENCY_LIMITS_META_KEY)
    } else {
      this.db.setMeta(RUNTIME_CONCURRENCY_LIMITS_META_KEY, JSON.stringify(next))
    }
    this.runtimeConcurrencyLimitsCache = { ...next }
    this.scheduleConfigSnapshot()
    return { ...next }
  }

  /**
   * Writes a read-only disaster recovery snapshot of low-frequency configuration tables.
   * Debounced on normal mutations so config backup stays off the hot path.
   */
  flushConfigSnapshot(): void {
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer)
      this.snapshotTimer = null
    }
    if (!this.db.isOpen || this.db.readOnly || this.db.dbPath === ':memory:') return
    this.snapshotDirty = false
    try {
      mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
      const secret = this.db.getMeta('viewer_ticket_secret')
      const runtimeConcurrencyLimits = this.getRuntimeConcurrencyLimits()
      const payload = {
        version: 1,
        exportedAtMs: Date.now(),
        ...(secret ? { viewerTicketSecret: secret } : {}),
        ...(Object.keys(runtimeConcurrencyLimits).length > 0 ? { runtimeConcurrencyLimits } : {}),
        bots: this.listBots(),
        groups: this.listGroups(),
        listenerTemplates: this.listListenerTemplates(),
        scheduleBindings: this.listScheduleBindings(),
      }
      const snapshotPath = join(this.dataDir, CONFIG_SNAPSHOT_FILENAME)
      const tmpPath = `${snapshotPath}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      renameSync(tmpPath, snapshotPath)
      tightenFileMode(snapshotPath, 0o600)
    } catch {
      // Best-effort snapshot must never break primary SQLite transaction semantics.
    }
  }

  dispose(): void {
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer)
      this.snapshotTimer = null
    }
    if (this.snapshotDirty) {
      this.flushConfigSnapshot()
    }
  }

  private scheduleConfigSnapshot(): void {
    if (this.db.readOnly || this.db.dbPath === ':memory:') return
    this.snapshotDirty = true
    if (this.snapshotTimer) return
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null
      this.flushConfigSnapshot()
    }, SNAPSHOT_DEBOUNCE_MS)
    this.snapshotTimer.unref?.()
  }

  private hydrateScheduleBinding(row: {
    schedule_id: string
    enabled: number
    delivery_mode: string
    notify_on: string
    send_intermediate: number
    targets_json: string
  }): LarkScheduleBinding {
    let targets: LarkScheduleTarget[] = []
    try {
      const parsed = JSON.parse(row.targets_json)
      if (Array.isArray(parsed)) targets = parsed as LarkScheduleTarget[]
    } catch {
      targets = []
    }
    return {
      scheduleId: row.schedule_id,
      enabled: row.enabled === 1,
      targets,
      deliveryMode: row.delivery_mode === 'thread' ? 'thread' : 'chat',
      notifyOn:
        row.notify_on === 'always' || row.notify_on === 'error_only'
          ? row.notify_on
          : 'non_empty',
      sendIntermediateMessages: row.send_intermediate === 1,
    }
  }
}
