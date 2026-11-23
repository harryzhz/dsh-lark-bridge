import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_LISTENER_TEMPLATES,
  LarkBotConfigSchema,
  LarkGroupConfigSchema,
  LarkReminderItemSchema,
  ListenerTemplateSchema,
  buildGroupKey,
  expandWorkingDir,
  resolveEffectiveWorkingDir,
  resolveEffectiveWorkspaceName,
  type LarkBotConfig,
  type LarkGroupConfig,
  type LarkReminderItem,
  type ListenerTemplate,
  type SeenMessageEntry,
} from '@dsh-lark/lark-core'
import type {
  LarkAuditEvent,
  LarkBotMetrics,
  LarkDreamRunState,
  LarkDreamSession,
  LarkGroupTraffic,
  LarkHourlyBucket,
  LarkManagedSession,
  LarkPendingTurn,
  LarkScheduleBinding,
  LarkSessionBinding,
} from '../types.js'
import { ConfigRepo, parseScheduleBinding } from './config-repo.js'
import {
  BridgeDatabase,
  DB_FILENAME,
  LEGACY_STATE_FILENAME,
  tightenFileMode,
} from './database.js'
import { ENTITY_TABLE_NAMES, type EntityTableName } from './migrations/001-initial.js'
import { RuntimeRepo } from './runtime-repo.js'
import { TelemetryRepo } from './telemetry-repo.js'

const MAX_SEEN_MESSAGES = 2000
const SEEN_MESSAGE_TTL_MS = 24 * 60 * 60_000
const MAX_DREAM_SESSIONS = 100

export interface PersistedStateV3 {
  readonly version: 3
  readonly viewerTicketSecret?: string
  readonly bots: LarkBotConfig[]
  readonly groups: LarkGroupConfig[]
  readonly bindings: LarkSessionBinding[]
  readonly managedSessions: LarkManagedSession[]
  readonly dreamStates?: LarkDreamRunState[]
  readonly dreamSessions?: LarkDreamSession[]
  readonly reminders?: LarkReminderItem[]
  readonly pendingTurns?: LarkPendingTurn[]
  readonly seenMessages?: SeenMessageEntry[]
  readonly listenerTemplates: ListenerTemplate[]
  readonly scheduleBindings: LarkScheduleBinding[]
  readonly hourlyBuckets: LarkHourlyBucket[]
  readonly botMetrics: LarkBotMetrics[]
  readonly groupTraffic: LarkGroupTraffic[]
  readonly auditEvents: LarkAuditEvent[]
}

export interface ParsedLegacyState {
  readonly sourceVersion: number
  readonly viewerTicketSecret?: string
  readonly bots: LarkBotConfig[]
  readonly groups: LarkGroupConfig[]
  readonly listenerTemplates: ListenerTemplate[]
  readonly scheduleBindings: LarkScheduleBinding[]
  readonly bindings: LarkSessionBinding[]
  readonly bindingAliasCount: number
  readonly managedSessions: LarkManagedSession[]
  readonly pendingTurns: LarkPendingTurn[]
  readonly seenMessages: SeenMessageEntry[]
  readonly reminders: LarkReminderItem[]
  readonly dreamStates: LarkDreamRunState[]
  readonly dreamSessions: LarkDreamSession[]
  readonly hourlyBuckets: LarkHourlyBucket[]
  readonly botMetrics: LarkBotMetrics[]
  readonly groupTraffic: LarkGroupTraffic[]
  readonly auditEvents: LarkAuditEvent[]
  readonly warnings: string[]
}

export interface MigrationVerificationReport {
  readonly ok: boolean
  readonly sourcePath?: string
  readonly sourceSha256?: string
  readonly backupPath?: string
  readonly archivedSourcePath?: string
  readonly migratedAtMs: number
  readonly expectedCounts: Record<EntityTableName, number>
  readonly actualCounts: Record<EntityTableName, number>
  readonly integrityOk: boolean
  readonly foreignKeyErrors: number
  readonly warnings: readonly string[]
  readonly mismatches: readonly string[]
}

export interface CrossVerifyReport {
  readonly ok: boolean
  readonly integrityOk: boolean
  readonly foreignKeyErrors: number
  readonly mismatches: readonly string[]
  readonly dbCounts: Record<EntityTableName, number>
  readonly jsonCounts?: Record<EntityTableName, number>
}

export interface RollbackResult {
  readonly mode: 'to_json' | 'rebuild_sqlite'
  readonly previousDbBackupPath?: string
  readonly restoredPath: string
  readonly verification?: MigrationVerificationReport
}

function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function formatLocalDateKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function stripDreamSummaryPrefix(raw?: string): string | undefined {
  if (!raw) return undefined
  const trimmed = raw
    .trim()
    .replace(/^已整理\s+\d+\s+个会话(?:\s*·\s*)?/, '')
    .replace(/^整理失败[：:]\s*/, '')
    .trim()
  return trimmed || undefined
}

function normalizeAliases(primaryRouteKey: string, aliases?: readonly string[]): string[] {
  if (!aliases || aliases.length === 0) return []
  const out: string[] = []
  for (const raw of aliases) {
    const clean = raw.trim()
    if (!clean || clean === primaryRouteKey || out.includes(clean)) continue
    out.push(clean)
  }
  return out
}

function resolveLegacyWorkspaceName(
  bots: ReadonlyMap<string, LarkBotConfig>,
  groups: ReadonlyMap<string, LarkGroupConfig>,
  bot: LarkBotConfig,
  group?: LarkGroupConfig,
): string {
  const explicitSelf = (group ? group.workspaceName : bot.workspaceName).trim()
  if (explicitSelf) return explicitSelf
  const targetDir = group
    ? resolveEffectiveWorkingDir(bot, group)
    : expandWorkingDir(bot.defaultWorkingDir) || bot.defaultWorkingDir
  for (const g of groups.values()) {
    if (!g.enabled || !g.workspaceName.trim()) continue
    const owner = bots.get(g.botId)
    if (owner && resolveEffectiveWorkingDir(owner, g) === targetDir) {
      return g.workspaceName.trim()
    }
  }
  for (const b of bots.values()) {
    if (!b.enabled || !b.workspaceName.trim()) continue
    if ((expandWorkingDir(b.defaultWorkingDir) || b.defaultWorkingDir) === targetDir) {
      return b.workspaceName.trim()
    }
  }
  return resolveEffectiveWorkspaceName(bot, group)
}

export function parseLegacyStatePayload(
  raw: Record<string, unknown>,
  nowMs = Date.now(),
): ParsedLegacyState {
  const warnings: string[] = []
  const sourceVersion = typeof raw.version === 'number' ? raw.version : 1

  const botsMap = new Map<string, LarkBotConfig>()
  const rawBots = Array.isArray(raw.bots) ? raw.bots : []
  for (let i = 0; i < rawBots.length; i += 1) {
    const item = rawBots[i]
    if (!item || typeof item !== 'object') {
      warnings.push(`bots[${i}]: skipped non-object entry`)
      continue
    }
    const rec = item as Record<string, unknown>
    const mappedBotInput: Record<string, unknown> = {
      ...rec,
      groupReplyMode: rec.groupReplyMode ?? rec.regularGroupReplyMode ?? 'new-topic',
      p2pEnabled: rec.p2pEnabled ?? (rec.p2pOpen === true || Array.isArray(rec.allowedUsers)),
      idleCloseMinutes: rec.idleCloseMinutes ?? rec.idleSuspendMinutes ?? 720,
    }
    const parsedBot = LarkBotConfigSchema.safeParse(mappedBotInput)
    if (!parsedBot.success) {
      warnings.push(`bots[${i}]: skipped invalid bot (${parsedBot.error.issues[0]?.message ?? 'parse error'})`)
      continue
    }
    botsMap.set(parsedBot.data.id, parsedBot.data)
  }

  const groupsMap = new Map<string, LarkGroupConfig>()
  if (Array.isArray(raw.groups)) {
    for (let i = 0; i < raw.groups.length; i += 1) {
      const parsed = LarkGroupConfigSchema.safeParse(raw.groups[i])
      if (!parsed.success) {
        warnings.push(`groups[${i}]: skipped invalid group`)
        continue
      }
      groupsMap.set(parsed.data.key, parsed.data)
    }
  }

  const viewerTicketSecret =
    typeof raw.viewerTicketSecret === 'string' && raw.viewerTicketSecret.trim().length >= 32
      ? raw.viewerTicketSecret.trim()
      : undefined

  const templatesMap = new Map<string, ListenerTemplate>()
  for (const tpl of DEFAULT_LISTENER_TEMPLATES) {
    templatesMap.set(tpl.key, structuredClone(tpl))
  }
  if (Array.isArray(raw.listenerTemplates)) {
    for (const rawTpl of raw.listenerTemplates) {
      const parsed = ListenerTemplateSchema.safeParse(rawTpl)
      if (parsed.success && DEFAULT_LISTENER_TEMPLATES.some((d) => d.key === parsed.data.key)) {
        templatesMap.set(parsed.data.key, parsed.data)
      }
    }
  }

  const managedMap = new Map<string, LarkManagedSession>()
  if (Array.isArray(raw.managedSessions)) {
    for (const item of raw.managedSessions as Partial<LarkManagedSession>[]) {
      if (!item?.sessionId || !item?.botId || !item?.chatId) continue
      managedMap.set(item.sessionId, {
        sessionId: item.sessionId,
        botId: item.botId,
        chatId: item.chatId,
        ...(item.routeKey ? { routeKey: item.routeKey } : {}),
        ...(item.trigger ? { trigger: item.trigger } : {}),
        createdAtMs: item.createdAtMs ?? nowMs,
        lastActivityMs: item.lastActivityMs ?? nowMs,
        ...(item.idleCloseMs ? { idleCloseMs: item.idleCloseMs } : {}),
        ...(item.archivedAtMs ? { archivedAtMs: item.archivedAtMs } : {}),
      })
    }
  }

  const dreamStatesMap = new Map<string, LarkDreamRunState>()
  if (Array.isArray(raw.dreamStates)) {
    for (const ds of raw.dreamStates as Partial<LarkDreamRunState>[]) {
      if (!ds?.botId || typeof ds.botId !== 'string') continue
      const status =
        ds.status === 'succeeded' || ds.status === 'skipped' || ds.status === 'failed'
          ? ds.status
          : 'idle'
      dreamStatesMap.set(ds.botId, {
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
          ? ds.processedSessionIds.filter((id): id is string => typeof id === 'string').slice(-400)
          : [],
      })
    }
  }

  const dreamSessionsMap = new Map<string, LarkDreamSession>()
  if (Array.isArray(raw.dreamSessions)) {
    for (const item of raw.dreamSessions as Partial<LarkDreamSession>[]) {
      if (!item?.sessionId || !item?.botId) continue
      const bot = botsMap.get(item.botId)
      const wasRunning = item.status === 'running'
      const status: LarkDreamSession['status'] =
        item.status === 'succeeded' || item.status === 'failed' ? item.status : 'failed'
      const createdAtMs = typeof item.createdAtMs === 'number' ? item.createdAtMs : nowMs
      const lastActivityMs =
        typeof item.lastActivityMs === 'number' ? item.lastActivityMs : createdAtMs
      const summary = wasRunning
        ? '执行因服务重启中断'
        : typeof item.summary === 'string' && item.summary.trim()
          ? item.summary.trim()
          : undefined
      dreamSessionsMap.set(item.sessionId, {
        sessionId: item.sessionId,
        botId: item.botId,
        ...(item.botName ?? bot?.name ? { botName: item.botName ?? bot?.name } : {}),
        workspaceName:
          item.workspaceName ||
          (bot ? resolveLegacyWorkspaceName(botsMap, groupsMap, bot) : item.botId),
        workingDir: item.workingDir || bot?.defaultWorkingDir || '',
        agentPreset: item.agentPreset || bot?.agentPreset || 'standard',
        ...(item.runtimeProfileId ? { runtimeProfileId: item.runtimeProfileId } : {}),
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
    }
  }

  const remindersMap = new Map<string, LarkReminderItem>()
  if (Array.isArray(raw.reminders)) {
    for (let i = 0; i < raw.reminders.length; i += 1) {
      const parsed = LarkReminderItemSchema.safeParse(raw.reminders[i])
      if (!parsed.success) {
        warnings.push(`reminders[${i}]: skipped invalid reminder`)
        continue
      }
      remindersMap.set(parsed.data.id, parsed.data)
    }
  }

  const pendingTurnsMap = new Map<string, LarkPendingTurn>()
  if (Array.isArray(raw.pendingTurns)) {
    for (const item of raw.pendingTurns as Partial<LarkPendingTurn>[]) {
      if (!item?.id || !item.botId || !item.chatId || !item.messageId || !item.routeKey) continue
      const replyMode =
        item.replyMode === 'chat' || item.replyMode === 'reply' || item.replyMode === 'new-topic'
          ? item.replyMode
          : 'new-topic'
      pendingTurnsMap.set(item.id, {
        id: item.id,
        botId: item.botId,
        chatId: item.chatId,
        ...(item.chatName ? { chatName: item.chatName } : {}),
        messageId: item.messageId,
        routeKey: item.routeKey,
        replyMode,
        trigger: item.trigger ?? 'mention',
        allowSilentEmptyReply: Boolean(item.allowSilentEmptyReply),
        ...(item.reactionId ? { reactionId: item.reactionId } : {}),
        ...(item.sessionId ? { sessionId: item.sessionId } : {}),
        ...(item.traceId ? { traceId: item.traceId } : {}),
        startedAtMs: typeof item.startedAtMs === 'number' ? item.startedAtMs : nowMs,
      })
    }
  }

  const bindingsMap = new Map<string, LarkSessionBinding>()
  if (Array.isArray(raw.bindings)) {
    for (const b of raw.bindings as Array<
      Partial<LarkSessionBinding> & { workspaceGroupName?: string }
    >) {
      if (!b?.routeKey || !b?.sessionId || !b?.botId || !b?.chatId) continue
      const bot = botsMap.get(b.botId)
      const grp = groupsMap.get(buildGroupKey(b.botId, b.chatId))
      const aliasRouteKeys = normalizeAliases(
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
              ? resolveLegacyWorkspaceName(botsMap, groupsMap, bot)
              : resolveLegacyWorkspaceName(botsMap, groupsMap, bot, grp)
            : b.botId),
        sessionId: b.sessionId,
        agentPreset: b.agentPreset ?? 'codex',
        ...(b.runtimeProfileId ? { runtimeProfileId: b.runtimeProfileId } : {}),
        ...(b.model ? { model: b.model } : {}),
        ...(b.reasoningEffort ? { reasoningEffort: b.reasoningEffort } : {}),
        workingDir: b.workingDir ?? bot?.defaultWorkingDir ?? process.cwd(),
        trigger: b.trigger ?? 'mention',
        ...(b.listenerName ? { listenerName: b.listenerName } : {}),
        ...(typeof b.hasReplied === 'boolean' ? { hasReplied: b.hasReplied } : {}),
        createdAtMs: b.createdAtMs ?? nowMs,
        lastActivityMs: b.lastActivityMs ?? nowMs,
        ...(b.idleCloseMs ? { idleCloseMs: b.idleCloseMs } : {}),
      }
      bindingsMap.set(binding.routeKey, binding)
      if (!managedMap.has(binding.sessionId)) {
        managedMap.set(binding.sessionId, {
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

  // Deduplicate binding aliases across bindings (last owner wins, matching legacy map semantics).
  const aliasOwner = new Map<string, string>()
  for (const b of bindingsMap.values()) {
    for (const alias of b.aliasRouteKeys ?? []) {
      const directOwner = bindingsMap.get(alias)
      if (directOwner && directOwner.sessionId !== b.sessionId) continue
      aliasOwner.set(alias, b.routeKey)
    }
  }
  const normalizedBindings: LarkSessionBinding[] = []
  for (const b of bindingsMap.values()) {
    const ownedAliases = [...aliasOwner.entries()]
      .filter(([, primary]) => primary === b.routeKey)
      .map(([alias]) => alias)
    const copy: LarkSessionBinding = { ...b }
    if (ownedAliases.length > 0) {
      ;(copy as { aliasRouteKeys?: readonly string[] }).aliasRouteKeys = ownedAliases
    } else {
      delete (copy as { aliasRouteKeys?: readonly string[] }).aliasRouteKeys
    }
    normalizedBindings.push(copy)
  }

  const scheduleMap = new Map<string, LarkScheduleBinding>()
  if (Array.isArray(raw.scheduleBindings)) {
    for (let i = 0; i < raw.scheduleBindings.length; i += 1) {
      try {
        const parsed = parseScheduleBinding(raw.scheduleBindings[i])
        scheduleMap.set(parsed.scheduleId, parsed)
      } catch {
        warnings.push(`scheduleBindings[${i}]: skipped invalid schedule binding`)
      }
    }
  }

  const hourlyMap = new Map<string, LarkHourlyBucket>()
  if (Array.isArray(raw.hourlyBuckets)) {
    for (const hb of raw.hourlyBuckets as LarkHourlyBucket[]) {
      if (hb?.hourKey) hourlyMap.set(hb.hourKey, hb)
    }
  }

  const botMetricsMap = new Map<string, LarkBotMetrics>()
  if (Array.isArray(raw.botMetrics)) {
    for (const bm of raw.botMetrics as LarkBotMetrics[]) {
      if (bm?.botId) botMetricsMap.set(bm.botId, bm)
    }
  }

  const groupTrafficMap = new Map<string, LarkGroupTraffic>()
  if (Array.isArray(raw.groupTraffic)) {
    for (const gt of raw.groupTraffic as LarkGroupTraffic[]) {
      if (gt?.key) groupTrafficMap.set(gt.key, gt)
    }
  }

  const seenMap = new Map<string, number>()
  if (Array.isArray(raw.seenMessages)) {
    const valid = (raw.seenMessages as Array<Partial<SeenMessageEntry>>)
      .filter(
        (item): item is SeenMessageEntry =>
          typeof item?.key === 'string' &&
          item.key.length > 0 &&
          typeof item.seenAtMs === 'number' &&
          Number.isFinite(item.seenAtMs) &&
          nowMs - item.seenAtMs < SEEN_MESSAGE_TTL_MS,
      )
      .sort((a, b) => a.seenAtMs - b.seenAtMs)
      .slice(-MAX_SEEN_MESSAGES)
    for (const entry of valid) {
      seenMap.set(entry.key, entry.seenAtMs)
    }
  }

  const auditMap = new Map<string, LarkAuditEvent>()
  if (Array.isArray(raw.auditEvents)) {
    for (const ev of raw.auditEvents as LarkAuditEvent[]) {
      if (ev?.id && !auditMap.has(ev.id)) {
        auditMap.set(ev.id, ev)
      }
    }
  }
  const auditEvents = [...auditMap.values()]

  // One-time backfill for legacy state files that predated `dreamSessions`.
  if (!Array.isArray(raw.dreamSessions)) {
    for (const ds of dreamStatesMap.values()) {
      if (!ds.lastSessionId || dreamSessionsMap.has(ds.lastSessionId)) continue
      if (ds.status !== 'succeeded' && ds.status !== 'failed') continue
      const bot = botsMap.get(ds.botId)
      const ts = ds.lastDreamAtMs ?? nowMs
      const cleanSummary = stripDreamSummaryPrefix(ds.lastSummary)
      dreamSessionsMap.set(ds.lastSessionId, {
        sessionId: ds.lastSessionId,
        botId: ds.botId,
        ...(bot?.name ? { botName: bot.name } : {}),
        workspaceName: bot ? resolveLegacyWorkspaceName(botsMap, groupsMap, bot) : ds.botId,
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
    }

    for (const ev of auditEvents) {
      if (!ev.sessionId || dreamSessionsMap.has(ev.sessionId)) continue
      const isDreamDone = ev.summary.startsWith('Dreaming 完成')
      const isDreamFail = ev.summary.startsWith('Dreaming 失败')
      if (!isDreamDone && !isDreamFail) continue
      const bot = botsMap.get(ev.botId)
      const countMatch = /已整理\s+(\d+)\s+个会话/.exec(ev.summary)
      const failReason = isDreamFail
        ? ev.summary.replace(/^Dreaming 失败[：:]\s*/, '').trim()
        : undefined
      dreamSessionsMap.set(ev.sessionId, {
        sessionId: ev.sessionId,
        botId: ev.botId,
        ...(ev.botName ?? bot?.name ? { botName: ev.botName ?? bot?.name } : {}),
        workspaceName: bot ? resolveLegacyWorkspaceName(botsMap, groupsMap, bot) : ev.botId,
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
    }
  }

  const dreamSessions = [...dreamSessionsMap.values()]
    .sort((a, b) => b.lastActivityMs - a.lastActivityMs)
    .slice(0, MAX_DREAM_SESSIONS)

  return {
    sourceVersion,
    ...(viewerTicketSecret ? { viewerTicketSecret } : {}),
    bots: [...botsMap.values()],
    groups: [...groupsMap.values()],
    listenerTemplates: [...templatesMap.values()],
    scheduleBindings: [...scheduleMap.values()],
    bindings: normalizedBindings,
    bindingAliasCount: aliasOwner.size,
    managedSessions: [...managedMap.values()],
    pendingTurns: [...pendingTurnsMap.values()],
    seenMessages: [...seenMap.entries()].map(([key, seenAtMs]) => ({ key, seenAtMs })),
    reminders: [...remindersMap.values()],
    dreamStates: [...dreamStatesMap.values()],
    dreamSessions,
    hourlyBuckets: [...hourlyMap.values()],
    botMetrics: [...botMetricsMap.values()],
    groupTraffic: [...groupTrafficMap.values()],
    auditEvents,
    warnings,
  }
}

export function expectedCountsFromParsed(parsed: ParsedLegacyState): Record<EntityTableName, number> {
  return {
    bots: parsed.bots.length,
    groups: parsed.groups.length,
    listener_templates: parsed.listenerTemplates.length,
    schedule_bindings: parsed.scheduleBindings.length,
    session_bindings: parsed.bindings.length,
    binding_aliases: parsed.bindingAliasCount,
    managed_sessions: parsed.managedSessions.length,
    pending_turns: parsed.pendingTurns.length,
    seen_messages: parsed.seenMessages.length,
    reminders: parsed.reminders.length,
    dream_states: parsed.dreamStates.length,
    dream_sessions: parsed.dreamSessions.length,
    hourly_buckets: parsed.hourlyBuckets.length,
    bot_metrics: parsed.botMetrics.length,
    group_traffic: parsed.groupTraffic.length,
    audit_events: parsed.auditEvents.length,
  }
}

export function importParsedStateIntoDb(
  db: BridgeDatabase,
  parsed: ParsedLegacyState,
  meta: {
    readonly sourcePath?: string
    readonly sourceSha256?: string
    readonly backupPath?: string
    readonly archivedSourcePath?: string
    readonly migratedAtMs?: number
  } = {},
): MigrationVerificationReport {
  const migratedAtMs = meta.migratedAtMs ?? Date.now()

  db.transaction(() => {
    if (parsed.viewerTicketSecret) {
      db.setMeta('viewer_ticket_secret', parsed.viewerTicketSecret, migratedAtMs)
    }
    if (meta.sourceSha256) {
      db.setMeta('migrated_from_sha256', meta.sourceSha256, migratedAtMs)
    }

    const insertBot = db.prepare(
      'INSERT OR REPLACE INTO bots (id, name, lark_app_id, enabled, config_json, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (const bot of parsed.bots) {
      insertBot.run(bot.id, bot.name, bot.larkAppId, bot.enabled ? 1 : 0, JSON.stringify(bot), migratedAtMs)
    }

    const insertGroup = db.prepare(
      'INSERT OR REPLACE INTO groups (key, bot_id, chat_id, chat_name, enabled, listener_enabled, config_json, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const grp of parsed.groups) {
      insertGroup.run(
        grp.key,
        grp.botId,
        grp.chatId,
        grp.chatName,
        grp.enabled ? 1 : 0,
        grp.listener.enabled ? 1 : 0,
        JSON.stringify(grp),
        migratedAtMs,
      )
    }

    const insertTpl = db.prepare(
      'INSERT OR REPLACE INTO listener_templates (key, config_json, updated_at_ms) VALUES (?, ?, ?)',
    )
    for (const tpl of parsed.listenerTemplates) {
      insertTpl.run(tpl.key, JSON.stringify(tpl), migratedAtMs)
    }

    const insertSched = db.prepare(
      'INSERT OR REPLACE INTO schedule_bindings (schedule_id, enabled, delivery_mode, notify_on, send_intermediate, targets_json, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    for (const sb of parsed.scheduleBindings) {
      insertSched.run(
        sb.scheduleId,
        sb.enabled ? 1 : 0,
        sb.deliveryMode,
        sb.notifyOn,
        sb.sendIntermediateMessages ? 1 : 0,
        JSON.stringify(sb.targets),
        migratedAtMs,
      )
    }

    const insertBinding = db.prepare(
      `INSERT OR REPLACE INTO session_bindings (
         route_key, session_id, bot_id, bot_name, lark_app_id, chat_type, chat_id, chat_name,
         user_open_id, user_name, workspace_name, agent_preset, runtime_profile_id, model,
         reasoning_effort, working_dir, trigger, listener_name, has_replied, created_at_ms,
         last_activity_ms, idle_close_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insertAlias = db.prepare(
      'INSERT OR REPLACE INTO binding_aliases (alias_route_key, primary_route_key) VALUES (?, ?)',
    )
    for (const b of parsed.bindings) {
      insertBinding.run(
        b.routeKey,
        b.sessionId,
        b.botId,
        b.botName ?? null,
        b.larkAppId,
        b.chatType ?? null,
        b.chatId,
        b.chatName ?? null,
        b.userOpenId ?? null,
        b.userName ?? null,
        b.workspaceName,
        b.agentPreset,
        b.runtimeProfileId ?? null,
        b.model ?? null,
        b.reasoningEffort ?? null,
        b.workingDir,
        b.trigger,
        b.listenerName ?? null,
        typeof b.hasReplied === 'boolean' ? (b.hasReplied ? 1 : 0) : null,
        b.createdAtMs,
        b.lastActivityMs,
        b.idleCloseMs ?? null,
      )
      for (const alias of b.aliasRouteKeys ?? []) {
        insertAlias.run(alias, b.routeKey)
      }
    }

    const insertManaged = db.prepare(
      `INSERT OR REPLACE INTO managed_sessions (
         session_id, bot_id, chat_id, route_key, trigger, created_at_ms, last_activity_ms, idle_close_ms, archived_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const ms of parsed.managedSessions) {
      insertManaged.run(
        ms.sessionId,
        ms.botId,
        ms.chatId,
        ms.routeKey ?? null,
        ms.trigger ?? null,
        ms.createdAtMs,
        ms.lastActivityMs,
        ms.idleCloseMs ?? null,
        ms.archivedAtMs ?? null,
      )
    }

    const insertPending = db.prepare(
      `INSERT OR REPLACE INTO pending_turns (
         id, bot_id, chat_id, chat_name, message_id, route_key, reply_mode, trigger,
         allow_silent_empty_reply, reaction_id, session_id, trace_id, started_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const pt of parsed.pendingTurns) {
      insertPending.run(
        pt.id,
        pt.botId,
        pt.chatId,
        pt.chatName ?? null,
        pt.messageId,
        pt.routeKey,
        pt.replyMode,
        pt.trigger,
        pt.allowSilentEmptyReply ? 1 : 0,
        pt.reactionId ?? null,
        pt.sessionId ?? null,
        pt.traceId ?? null,
        pt.startedAtMs,
      )
    }

    const insertSeen = db.prepare('INSERT OR REPLACE INTO seen_messages (key, seen_at_ms) VALUES (?, ?)')
    for (const sm of parsed.seenMessages) {
      insertSeen.run(sm.key, sm.seenAtMs)
    }

    const insertReminder = db.prepare(
      'INSERT OR REPLACE INTO reminders (id, bot_id, status, scheduled_at, scheduled_at_ms, updated_at_ms, archived_at_ms, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const rem of parsed.reminders) {
      const parsedSched = Date.parse(rem.scheduledAt)
      insertReminder.run(
        rem.id,
        rem.origin.botId,
        rem.status,
        rem.scheduledAt,
        Number.isFinite(parsedSched) ? parsedSched : rem.updatedAtMs,
        rem.updatedAtMs,
        rem.archivedAtMs ?? null,
        JSON.stringify(rem),
      )
    }

    const insertDreamState = db.prepare(
      `INSERT OR REPLACE INTO dream_states (
         bot_id, status, last_dream_at_ms, last_checked_date_key, last_session_id,
         last_processed_count, last_summary, processed_session_ids_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const ds of parsed.dreamStates) {
      insertDreamState.run(
        ds.botId,
        ds.status,
        ds.lastDreamAtMs ?? null,
        ds.lastCheckedDateKey ?? null,
        ds.lastSessionId ?? null,
        ds.lastProcessedCount ?? null,
        ds.lastSummary ?? null,
        JSON.stringify(ds.processedSessionIds),
      )
    }

    const insertDreamSession = db.prepare(
      'INSERT OR REPLACE INTO dream_sessions (session_id, bot_id, status, date_key, last_activity_ms, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (const dses of parsed.dreamSessions) {
      insertDreamSession.run(
        dses.sessionId,
        dses.botId,
        dses.status,
        dses.dateKey,
        dses.lastActivityMs,
        JSON.stringify(dses),
      )
    }

    const insertHourly = db.prepare(
      `INSERT OR REPLACE INTO hourly_buckets (
         hour_key, inbound, replied, listener_triggered, silent_skipped,
         ignored, errors, total_latency_ms, latency_samples
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const hb of parsed.hourlyBuckets) {
      insertHourly.run(
        hb.hourKey,
        hb.inbound,
        hb.replied,
        hb.listenerTriggered,
        hb.silentSkipped,
        hb.ignored,
        hb.errors,
        hb.totalLatencyMs,
        hb.latencySamples,
      )
    }

    const insertBotMetric = db.prepare(
      `INSERT OR REPLACE INTO bot_metrics (
         bot_id, inbound_total, replied_total, listener_triggered_total,
         silent_skipped_total, ignored_total, error_total, latencies_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const bm of parsed.botMetrics) {
      insertBotMetric.run(
        bm.botId,
        bm.inboundTotal,
        bm.repliedTotal,
        bm.listenerTriggeredTotal,
        bm.silentSkippedTotal,
        bm.ignoredTotal,
        bm.errorTotal,
        JSON.stringify(bm.latenciesMs ?? []),
      )
    }

    const insertTraffic = db.prepare(
      `INSERT OR REPLACE INTO group_traffic (
         key, bot_id, chat_id, chat_name, inbound_total, replied_total, last_active_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const gt of parsed.groupTraffic) {
      insertTraffic.run(
        gt.key,
        gt.botId,
        gt.chatId,
        gt.chatName,
        gt.inboundTotal,
        gt.repliedTotal,
        gt.lastActiveMs,
      )
    }

    // Legacy auditEvents are stored newest-first; insert oldest-first so AUTOINCREMENT seq preserves order.
    const insertAudit = db.prepare(
      `INSERT OR REPLACE INTO audit_events (
         id, timestamp_ms, bot_id, bot_name, chat_id, chat_name,
         route_key, session_id, trace_id, duration_ms, kind, summary
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (let i = parsed.auditEvents.length - 1; i >= 0; i -= 1) {
      const ev = parsed.auditEvents[i]!
      insertAudit.run(
        ev.id,
        ev.timestampMs,
        ev.botId,
        ev.botName ?? null,
        ev.chatId ?? null,
        ev.chatName ?? null,
        ev.routeKey ?? null,
        ev.sessionId ?? null,
        ev.traceId ?? null,
        ev.durationMs ?? null,
        ev.kind,
        ev.summary,
      )
    }
  })

  // Post-import verification across all 16 tables + integrity & FK checks.
  const expectedCounts = expectedCountsFromParsed(parsed)
  const actualCounts = db.getStats().tableCounts
  const integrity = db.integrityCheck()
  const mismatches: string[] = []

  for (const table of ENTITY_TABLE_NAMES) {
    if (actualCounts[table] !== expectedCounts[table]) {
      mismatches.push(`${table}: expected ${expectedCounts[table]}, got ${actualCounts[table]}`)
    }
  }
  if (!integrity.ok) {
    mismatches.push(`integrity_check failed: ${integrity.messages.join('; ')}`)
  }
  if (integrity.foreignKeyErrors > 0) {
    mismatches.push(`foreign_key_check found ${integrity.foreignKeyErrors} violation(s)`)
  }
  if (parsed.viewerTicketSecret && db.getMeta('viewer_ticket_secret') !== parsed.viewerTicketSecret) {
    mismatches.push('viewer_ticket_secret mismatch')
  }

  const report: MigrationVerificationReport = {
    ok: mismatches.length === 0,
    ...(meta.sourcePath ? { sourcePath: meta.sourcePath } : {}),
    ...(meta.sourceSha256 ? { sourceSha256: meta.sourceSha256 } : {}),
    ...(meta.backupPath ? { backupPath: meta.backupPath } : {}),
    ...(meta.archivedSourcePath ? { archivedSourcePath: meta.archivedSourcePath } : {}),
    migratedAtMs,
    expectedCounts,
    actualCounts,
    integrityOk: integrity.ok,
    foreignKeyErrors: integrity.foreignKeyErrors,
    warnings: parsed.warnings,
    mismatches,
  }

  if (report.ok) {
    db.setMeta('migration_report_json', JSON.stringify(report), migratedAtMs)
  }
  return report
}

function cleanupStaleMigratingFiles(dataDir: string): void {
  if (!existsSync(dataDir)) return
  try {
    for (const name of readdirSync(dataDir)) {
      if (name.startsWith(`${DB_FILENAME}.migrating`)) {
        rmSync(join(dataDir, name), { force: true })
      }
    }
  } catch {
    // Best-effort cleanup.
  }
}

/**
 * Zero-touch atomic migration executed on store initialization or via `lark-bridge db migrate`.
 * Guarantees: backup -> temp DB single-tx import -> 16-table verification -> atomic rename -> archive legacy JSON.
 */
export function migrateLegacyJsonToSqlite(
  dataDir: string,
  options: {
    readonly legacyPath?: string
    readonly archiveLegacy?: boolean
    readonly dryRun?: boolean
    readonly force?: boolean
    readonly onWarn?: (msg: string) => void
  } = {},
): MigrationVerificationReport | undefined {
  const dbPath = join(dataDir, DB_FILENAME)
  const legacyPath = options.legacyPath ?? join(dataDir, LEGACY_STATE_FILENAME)
  const archiveLegacy = options.archiveLegacy !== false

  // Case 1: Target SQLite DB already exists.
  if (existsSync(dbPath) && !options.force) {
    // Recover Step 5 -> Step 6 crash window: DB already migrated this exact JSON, archive leftover JSON.
    if (archiveLegacy && existsSync(legacyPath) && !options.dryRun) {
      try {
        const rawBuf = readFileSync(legacyPath)
        const sha = sha256Buffer(rawBuf)
        const existingDb = new BridgeDatabase(dbPath, { readOnly: true })
        let migratedSha: string | undefined
        try {
          migratedSha = existingDb.getMeta('migrated_from_sha256')
        } finally {
          existingDb.close({ checkpoint: false })
        }
        if (migratedSha && migratedSha === sha) {
          const archivedPath = `${legacyPath}.migrated.${Date.now()}`
          renameSync(legacyPath, archivedPath)
          tightenFileMode(archivedPath, 0o600)
        }
      } catch {
        // Leave existing files untouched if read fails.
      }
    }
    return undefined
  }

  if (!existsSync(legacyPath)) {
    return undefined
  }

  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const rawBuf = readFileSync(legacyPath)
  const sourceSha256 = sha256Buffer(rawBuf)
  const ts = Date.now()

  let rawJson: Record<string, unknown>
  try {
    const parsedJson = JSON.parse(rawBuf.toString('utf8'))
    if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
      throw new Error('Root JSON value must be an object')
    }
    rawJson = parsedJson as Record<string, unknown>
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (options.dryRun) {
      throw new Error(`Invalid legacy JSON (${legacyPath}): ${msg}`)
    }
    const corruptBackup = `${legacyPath}.corrupt-${ts}.bak`
    try {
      copyFileSync(legacyPath, corruptBackup)
      tightenFileMode(corruptBackup, 0o600)
      renameSync(legacyPath, `${legacyPath}.corrupt-archived-${ts}.bak`)
    } catch {
      // Best-effort backup.
    }
    options.onWarn?.(
      `[lark-bridge] Failed to parse legacy state JSON (${msg}); backed up unreadable file to ${corruptBackup} and initialized empty SQLite database`,
    )
    return undefined
  }

  const parsed = parseLegacyStatePayload(rawJson, ts)
  const expectedCounts = expectedCountsFromParsed(parsed)

  if (options.dryRun) {
    return {
      ok: true,
      sourcePath: legacyPath,
      sourceSha256,
      migratedAtMs: ts,
      expectedCounts,
      actualCounts: expectedCounts,
      integrityOk: true,
      foreignKeyErrors: 0,
      warnings: parsed.warnings,
      mismatches: [],
    }
  }

  cleanupStaleMigratingFiles(dataDir)

  // Step 1: Full pre-migration backup of original JSON bytes.
  const backupDir = join(dataDir, 'backups')
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const backupPath = join(backupDir, `lark-bridge-state.pre-sqlite-${ts}.json`)
  writeFileSync(backupPath, rawBuf, { mode: 0o600 })
  tightenFileMode(backupPath, 0o600)

  // Step 2-4: Write into temp SQLite file in a single transaction & verify 100%.
  const tempDbPath = join(dataDir, `${DB_FILENAME}.migrating.${process.pid}.${ts}`)
  const archivedSourcePath = archiveLegacy ? `${legacyPath}.migrated.${ts}` : undefined
  let tempDb: BridgeDatabase | undefined
  let report: MigrationVerificationReport
  try {
    tempDb = new BridgeDatabase(tempDbPath)
    report = importParsedStateIntoDb(tempDb, parsed, {
      sourcePath: legacyPath,
      sourceSha256,
      backupPath,
      ...(archivedSourcePath ? { archivedSourcePath } : {}),
      migratedAtMs: ts,
    })
    if (!report.ok) {
      throw new Error(`Migration verification failed: ${report.mismatches.join('; ')}`)
    }
    // Checkpoint WAL fully into main temp file before atomic rename.
    tempDb.close({ checkpoint: true })
    tempDb = undefined
    rmSync(`${tempDbPath}-wal`, { force: true })
    rmSync(`${tempDbPath}-shm`, { force: true })
  } catch (err) {
    try {
      tempDb?.close({ checkpoint: false })
    } catch {
      // Ignore.
    }
    rmSync(tempDbPath, { force: true })
    rmSync(`${tempDbPath}-wal`, { force: true })
    rmSync(`${tempDbPath}-shm`, { force: true })
    throw err
  }

  // Step 5: If force-overwriting an existing DB, preserve a safety backup first.
  if (existsSync(dbPath) && options.force) {
    const prevDbBackup = join(backupDir, `lark-bridge.pre-force-migrate-${ts}.db`)
    try {
      const prev = new BridgeDatabase(dbPath, { readOnly: true })
      try {
        prev.backupTo(prevDbBackup)
      } finally {
        prev.close({ checkpoint: false })
      }
    } catch {
      copyFileSync(dbPath, prevDbBackup)
      tightenFileMode(prevDbBackup, 0o600)
    }
    rmSync(`${dbPath}-wal`, { force: true })
    rmSync(`${dbPath}-shm`, { force: true })
  }

  renameSync(tempDbPath, dbPath)
  tightenFileMode(dbPath, 0o600)

  // Step 6: Archive original legacy JSON so future startups never re-import.
  if (archiveLegacy && archivedSourcePath && existsSync(legacyPath)) {
    renameSync(legacyPath, archivedSourcePath)
    tightenFileMode(archivedSourcePath, 0o600)
  }

  // Step 7: Emit initial disaster-recovery config.snapshot.json.
  try {
    const opened = new BridgeDatabase(dbPath)
    try {
      const cfg = new ConfigRepo(opened, dataDir)
      cfg.flushConfigSnapshot()
    } finally {
      opened.close({ checkpoint: true })
    }
  } catch {
    // Non-fatal; snapshot will also be written on next config mutation.
  }

  return report
}

function redactString(value: string): string {
  return value
    .replace(/(?<![A-Za-z0-9])cli_[a-zA-Z0-9]{10,}/g, 'cli_REDACTED')
    .replace(/(?<![A-Za-z0-9])ou_[a-zA-Z0-9]{12,}/g, 'ou_REDACTED')
    .replace(/(?<![A-Za-z0-9])oc_[a-zA-Z0-9]{12,}/g, 'oc_REDACTED')
    .replace(/(?<![A-Za-z0-9])on_[a-zA-Z0-9]{12,}/g, 'on_REDACTED')
    .replace(/(?<![A-Za-z0-9])om_[a-zA-Z0-9]{12,}/g, 'om_REDACTED')
    .replace(/(?<![A-Za-z0-9])omt_[a-zA-Z0-9]{10,}/g, 'omt_REDACTED')
}

function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as T
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const safeKey = redactString(k)
    if (k === 'larkAppSecret' || k === 'viewerTicketSecret') {
      out[safeKey] = v ? 'REDACTED' : ''
    } else {
      out[safeKey] = redactDeep(v)
    }
  }
  return out as T
}

export function exportDbToV3Json(
  db: BridgeDatabase,
  dataDir: string,
  options: { readonly redact?: boolean } = {},
): PersistedStateV3 {
  const config = new ConfigRepo(db, dataDir)
  const runtime = new RuntimeRepo(db)
  const telemetry = new TelemetryRepo(db, config, 10_000)

  const secret = db.getMeta('viewer_ticket_secret')
  const managedRows = db
    .prepare('SELECT * FROM managed_sessions ORDER BY created_at_ms ASC')
    .all() as Array<{
    session_id: string
    bot_id: string
    chat_id: string
    route_key: string | null
    trigger: string | null
    created_at_ms: number
    last_activity_ms: number
    idle_close_ms: number | null
    archived_at_ms: number | null
  }>
  const managedSessions: LarkManagedSession[] = managedRows.map((row) => ({
    sessionId: row.session_id,
    botId: row.bot_id,
    chatId: row.chat_id,
    ...(row.route_key ? { routeKey: row.route_key } : {}),
    ...(row.trigger ? { trigger: row.trigger } : {}),
    createdAtMs: Number(row.created_at_ms),
    lastActivityMs: Number(row.last_activity_ms),
    ...(row.idle_close_ms !== null ? { idleCloseMs: Number(row.idle_close_ms) } : {}),
    ...(row.archived_at_ms !== null ? { archivedAtMs: Number(row.archived_at_ms) } : {}),
  }))

  const bots = config.listBots()
  const dreamStates = bots
    .map((b) => runtime.getDreamState(b.id))
    .filter((d): d is LarkDreamRunState => Boolean(d))
  // Also include dream states whose bot was removed if any remain.
  const allDreamStateRows = db
    .prepare('SELECT bot_id FROM dream_states')
    .all() as Array<{ bot_id: string }>
  const dreamStateIds = new Set(dreamStates.map((d) => d.botId))
  for (const row of allDreamStateRows) {
    if (!dreamStateIds.has(row.bot_id)) {
      const ds = runtime.getDreamState(row.bot_id)
      if (ds) dreamStates.push(ds)
    }
  }

  const payload: PersistedStateV3 = {
    version: 3,
    ...(secret ? { viewerTicketSecret: secret } : {}),
    bots,
    groups: config.listGroups(),
    bindings: runtime.listRawBindings(),
    managedSessions,
    dreamStates,
    dreamSessions: runtime.listRawDreamSessions(),
    reminders: runtime.listReminders('all'),
    pendingTurns: runtime.listPendingTurns(),
    seenMessages: runtime.listSeenMessages(),
    listenerTemplates: config.listListenerTemplates(),
    scheduleBindings: config.listScheduleBindings(),
    hourlyBuckets: [...telemetry.listHourlyBucketsMap().values()],
    botMetrics: [...telemetry.listBotMetricsMap().values()],
    groupTraffic: [...telemetry.listGroupTrafficMap().values()],
    auditEvents: telemetry.listEvents(10_000),
  }

  return options.redact ? redactDeep(payload) : payload
}

export function verifyDbAgainstJson(
  db: BridgeDatabase,
  jsonPath?: string,
): CrossVerifyReport {
  const integrity = db.integrityCheck()
  const dbCounts = db.getStats().tableCounts
  const mismatches: string[] = []
  if (!integrity.ok) {
    mismatches.push(`integrity_check failed: ${integrity.messages.join('; ')}`)
  }
  if (integrity.foreignKeyErrors > 0) {
    mismatches.push(`foreign_key_check found ${integrity.foreignKeyErrors} violation(s)`)
  }

  let jsonCounts: Record<EntityTableName, number> | undefined
  if (jsonPath) {
    const raw = JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<string, unknown>
    const parsed = parseLegacyStatePayload(raw)
    jsonCounts = expectedCountsFromParsed(parsed)
    for (const table of ENTITY_TABLE_NAMES) {
      if (table === 'seen_messages') continue // TTL-dependent
      if (dbCounts[table] !== jsonCounts[table]) {
        mismatches.push(`${table}: db=${dbCounts[table]} vs json=${jsonCounts[table]}`)
      }
    }
    const dbBotIds = new Set(
      (db.prepare('SELECT id FROM bots').all() as Array<{ id: string }>).map((r) => r.id),
    )
    for (const bot of parsed.bots) {
      if (!dbBotIds.has(bot.id)) mismatches.push(`missing bot id: ${bot.id}`)
    }
    const dbGroupKeys = new Set(
      (db.prepare('SELECT key FROM groups').all() as Array<{ key: string }>).map((r) => r.key),
    )
    for (const grp of parsed.groups) {
      if (!dbGroupKeys.has(grp.key)) mismatches.push(`missing group key: ${grp.key}`)
    }
  }

  return {
    ok: mismatches.length === 0,
    integrityOk: integrity.ok,
    foreignKeyErrors: integrity.foreignKeyErrors,
    mismatches,
    dbCounts,
    ...(jsonCounts ? { jsonCounts } : {}),
  }
}

export function rollbackDbFromJson(
  dataDir: string,
  backupJsonPath: string,
  options: { readonly toJsonOnly?: boolean } = {},
): RollbackResult {
  if (!existsSync(backupJsonPath)) {
    throw new Error(`Backup JSON not found: ${backupJsonPath}`)
  }
  const rawBuf = readFileSync(backupJsonPath)
  // Validate JSON before touching live files.
  const parsedRaw = JSON.parse(rawBuf.toString('utf8')) as Record<string, unknown>
  if (!parsedRaw || typeof parsedRaw !== 'object' || Array.isArray(parsedRaw)) {
    throw new Error('Backup JSON must contain a root object')
  }

  const ts = Date.now()
  const dbPath = join(dataDir, DB_FILENAME)
  const backupDir = join(dataDir, 'backups')
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })

  let previousDbBackupPath: string | undefined
  if (existsSync(dbPath)) {
    previousDbBackupPath = join(backupDir, `lark-bridge.db.rollback-${ts}.bak`)
    try {
      const existing = new BridgeDatabase(dbPath, { readOnly: true })
      try {
        existing.backupTo(previousDbBackupPath)
      } finally {
        existing.close({ checkpoint: false })
      }
    } catch {
      copyFileSync(dbPath, previousDbBackupPath)
      tightenFileMode(previousDbBackupPath, 0o600)
    }
    rmSync(dbPath, { force: true })
    rmSync(`${dbPath}-wal`, { force: true })
    rmSync(`${dbPath}-shm`, { force: true })
  }

  if (options.toJsonOnly) {
    const legacyTarget = join(dataDir, LEGACY_STATE_FILENAME)
    const tmpPath = `${legacyTarget}.${process.pid}.${ts}.tmp`
    writeFileSync(tmpPath, rawBuf, { mode: 0o600 })
    renameSync(tmpPath, legacyTarget)
    tightenFileMode(legacyTarget, 0o600)
    return {
      mode: 'to_json',
      ...(previousDbBackupPath ? { previousDbBackupPath } : {}),
      restoredPath: legacyTarget,
    }
  }

  const verification = migrateLegacyJsonToSqlite(dataDir, {
    legacyPath: backupJsonPath,
    archiveLegacy: false,
    force: true,
  })
  return {
    mode: 'rebuild_sqlite',
    ...(previousDbBackupPath ? { previousDbBackupPath } : {}),
    restoredPath: dbPath,
    ...(verification ? { verification } : {}),
  }
}
