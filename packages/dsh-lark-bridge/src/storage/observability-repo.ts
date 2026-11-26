import { buildGroupKey } from '@dsh-lark/lark-core'
import type {
  ObservabilityAgentBreakdown,
  ObservabilityChatFilterOption,
  ObservabilityChatRow,
  ObservabilityErrorBreakdown,
  ObservabilityHeatmapCell,
  ObservabilityLatencyBucket,
  ObservabilityModelBreakdown,
  ObservabilityRankModelSummary,
  ObservabilitySenderBotSummary,
  ObservabilitySenderFilterOption,
  ObservabilitySenderRow,
  ObservabilitySeriesPoint,
  ObservabilityTriggerBreakdown,
  ObservabilityWindow,
  TelemetrySenderProfileRecord,
  TelemetryUsageEventInput,
} from '../observability-types.js'
import type { ConfigRepo } from './config-repo.js'
import type { BridgeDatabase } from './database.js'

const DETAIL_RETENTION_MS = 90 * 24 * 60 * 60_000
const MAX_DETAIL_ROWS = 150_000
const ROLLUP_RETENTION_DAYS = 365
const PRUNE_EVERY_INSERTS = 200

export const P2P_CHAT_FILTER_VALUE = '__p2p__'
export const TRIAGE_AGENT_KEY = '__triage__'
export const UNATTRIBUTED_AGENT_KEY = '__unknown__'

export interface WindowSpec {
  readonly window: ObservabilityWindow
  readonly spanMs: number
  readonly bucketSpanMs: number
  readonly bucketCount: number
}

const WINDOW_SPECS: Record<ObservabilityWindow, WindowSpec> = {
  '24h': {
    window: '24h',
    spanMs: 24 * 3_600_000,
    bucketSpanMs: 3_600_000,
    bucketCount: 24,
  },
  '7d': {
    window: '7d',
    spanMs: 7 * 24 * 3_600_000,
    bucketSpanMs: 6 * 3_600_000,
    bucketCount: 28,
  },
  '30d': {
    window: '30d',
    spanMs: 30 * 24 * 3_600_000,
    bucketSpanMs: 24 * 3_600_000,
    bucketCount: 30,
  },
  '90d': {
    window: '90d',
    spanMs: 90 * 24 * 3_600_000,
    bucketSpanMs: 3 * 24 * 3_600_000,
    bucketCount: 30,
  },
}

export function resolveWindowSpec(raw?: string): WindowSpec {
  if (raw === '7d' || raw === '30d' || raw === '90d' || raw === '24h') {
    return WINDOW_SPECS[raw]
  }
  return WINDOW_SPECS['24h']
}

export function formatDayKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function formatBucketLabel(
  startMs: number,
  endMs: number,
  window: ObservabilityWindow,
): { readonly label: string; readonly fullLabel: string } {
  const s = new Date(startMs)
  const e = new Date(Math.max(startMs, endMs - 1))
  if (window === '24h') {
    const hh = pad2(s.getHours())
    return {
      label: `${hh}:00`,
      fullLabel: `${s.getMonth() + 1}/${s.getDate()} ${hh}:00–${hh}:59`,
    }
  }
  if (window === '7d') {
    const md = `${s.getMonth() + 1}/${s.getDate()}`
    const sh = pad2(s.getHours())
    const eh = pad2(e.getHours())
    return {
      label: s.getHours() === 0 ? md : `${sh}:00`,
      fullLabel: `${md} ${sh}:00–${eh}:59`,
    }
  }
  if (window === '30d') {
    const md = `${s.getMonth() + 1}/${s.getDate()}`
    return {
      label: md,
      fullLabel: `${s.getFullYear()}-${pad2(s.getMonth() + 1)}-${pad2(s.getDate())}`,
    }
  }
  const smd = `${s.getMonth() + 1}/${s.getDate()}`
  const emd = `${e.getMonth() + 1}/${e.getDate()}`
  return {
    label: smd,
    fullLabel: `${smd}–${emd}`,
  }
}

export function calcPercentiles(values: readonly number[]): {
  readonly samples: number
  readonly avgMs: number
  readonly p50Ms: number
  readonly p75Ms: number
  readonly p95Ms: number
  readonly p99Ms: number
  readonly maxMs: number
} {
  if (values.length === 0) {
    return { samples: 0, avgMs: 0, p50Ms: 0, p75Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const pick = (q: number) => {
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1))
    return sorted[idx] ?? 0
  }
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  return {
    samples: sorted.length,
    avgMs: Math.round(sum / sorted.length),
    p50Ms: Math.round(pick(0.5)),
    p75Ms: Math.round(pick(0.75)),
    p95Ms: Math.round(pick(0.95)),
    p99Ms: Math.round(pick(0.99)),
    maxMs: Math.round(sorted[sorted.length - 1] ?? 0),
  }
}

export function calcDeltaPct(current: number, previous: number): number | null {
  if (previous <= 0) {
    return current === 0 ? 0 : null
  }
  return Math.round(((current - previous) / previous) * 1000) / 10
}

function buildLatencyHistogram(values: readonly number[]): ObservabilityLatencyBucket[] {
  const bins = [
    { id: 'lt_1s', label: '<1s', min: 0, max: 1_000, count: 0 },
    { id: '1_3s', label: '1–3s', min: 1_000, max: 3_000, count: 0 },
    { id: '3_10s', label: '3–10s', min: 3_000, max: 10_000, count: 0 },
    { id: '10_30s', label: '10–30s', min: 10_000, max: 30_000, count: 0 },
    { id: '30_60s', label: '30–60s', min: 30_000, max: 60_000, count: 0 },
    { id: 'gt_60s', label: '>60s', min: 60_000, max: Number.POSITIVE_INFINITY, count: 0 },
  ]
  for (const v of values) {
    for (const b of bins) {
      if (v >= b.min && v < b.max) {
        b.count += 1
        break
      }
    }
  }
  const total = values.length
  return bins.map((b) => ({
    id: b.id,
    label: b.label,
    count: b.count,
    pct: total > 0 ? Math.round((b.count / total) * 1000) / 10 : 0,
  }))
}

interface RawUsageEventRow {
  timestamp_ms: number
  record_kind: string
  bot_id: string
  chat_id: string
  chat_type: string
  session_id: string
  sender_id: string
  sender_name: string
  sender_type: string
  trigger: string
  agent_preset: string
  provider: string
  model: string
  outcome: string
  error_code: string
  latency_ms: number | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  total_tokens: number
  tool_calls: number
  tool_errors: number
}

interface WindowTotals {
  inbound: number
  replied: number
  silentSkipped: number
  ignored: number
  errors: number
  abortedTurns: number
  llmSteps: number
  toolCalls: number
  toolErrors: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  triageTotal: number
  triageSilent: number
  triageQuickReply: number
  triageHandoff: number
  triageFallback: number
  triageTokens: number
  scheduleRuns: number
  reminderRuns: number
  dreamRuns: number
  sessions: Set<string>
  latencies: number[]
  triageLatencies: number[]
}

function emptyWindowTotals(): WindowTotals {
  return {
    inbound: 0,
    replied: 0,
    silentSkipped: 0,
    ignored: 0,
    errors: 0,
    abortedTurns: 0,
    llmSteps: 0,
    toolCalls: 0,
    toolErrors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    triageTotal: 0,
    triageSilent: 0,
    triageQuickReply: 0,
    triageHandoff: 0,
    triageFallback: 0,
    triageTokens: 0,
    scheduleRuns: 0,
    reminderRuns: 0,
    dreamRuns: 0,
    sessions: new Set<string>(),
    latencies: [],
    triageLatencies: [],
  }
}

function accumulateRow(target: WindowTotals, row: RawUsageEventRow): void {
  const inTok = Number(row.input_tokens) || 0
  const outTok = Number(row.output_tokens) || 0
  const crTok = Number(row.cache_read_tokens) || 0
  const cwTok = Number(row.cache_write_tokens) || 0
  const rTok = Number(row.reasoning_tokens) || 0
  const totTok = Number(row.total_tokens) || inTok + outTok + crTok + cwTok

  target.inputTokens += inTok
  target.outputTokens += outTok
  target.cacheReadTokens += crTok
  target.cacheWriteTokens += cwTok
  target.reasoningTokens += rTok
  target.totalTokens += totTok
  target.toolCalls += Number(row.tool_calls) || 0
  target.toolErrors += Number(row.tool_errors) || 0

  if (row.session_id) {
    target.sessions.add(row.session_id)
  }

  const kind = row.record_kind
  const outcome = row.outcome

  if (kind === 'llm_step') {
    target.llmSteps += 1
    return
  }

  if (kind === 'inbound') {
    if (outcome === 'ignored') {
      target.ignored += 1
    } else {
      target.inbound += 1
    }
    return
  }

  if (kind === 'triage') {
    target.triageTotal += 1
    target.triageTokens += totTok
    if (outcome === 'silent') target.triageSilent += 1
    else if (outcome === 'quick_reply') target.triageQuickReply += 1
    else if (outcome === 'handoff') target.triageHandoff += 1
    else if (outcome === 'fallback') {
      target.triageFallback += 1
      target.triageHandoff += 1
    }
    if (row.latency_ms !== null && Number(row.latency_ms) >= 0) {
      target.triageLatencies.push(Number(row.latency_ms))
    }
    return
  }

  // kind === 'turn' | 'proactive'
  if (row.trigger === 'schedule') target.scheduleRuns += 1
  else if (row.trigger === 'reminder') target.reminderRuns += 1
  else if (row.trigger === 'dreaming') target.dreamRuns += 1

  if (outcome === 'replied' || outcome === 'quick_reply' || outcome === 'completed') {
    target.replied += 1
    if (row.latency_ms !== null && Number(row.latency_ms) >= 0) {
      target.latencies.push(Number(row.latency_ms))
    }
  } else if (outcome === 'silent_skip') {
    target.silentSkipped += 1
  } else if (outcome === 'ignored') {
    target.ignored += 1
  } else if (outcome === 'aborted') {
    target.abortedTurns += 1
  } else if (outcome === 'error') {
    target.errors += 1
  }
}

function isToolErrorMarkerRow(row: RawUsageEventRow): boolean {
  return (
    row.record_kind === 'llm_step' &&
    (Number(row.total_tokens) || 0) === 0 &&
    (Number(row.tool_calls) || 0) === 0 &&
    (Number(row.tool_errors) || 0) > 0
  )
}

function resolveEventAgentKey(row: RawUsageEventRow): string {
  if (row.record_kind === 'triage' || row.trigger.trim() === 'triage') {
    return TRIAGE_AGENT_KEY
  }
  const preset = row.agent_preset.trim()
  if (preset) return preset
  return ''
}

function addTopModelToken(
  target: Map<string, { model: string; agentPreset: string; totalTokens: number }>,
  row: RawUsageEventRow,
  tokens: number,
): void {
  const model = row.model.trim()
  if (!model || tokens <= 0) return
  const key = model.toLowerCase()
  const existing = target.get(key)
  const agentKey = resolveEventAgentKey(row)
  if (existing) {
    existing.totalTokens += tokens
    if (!existing.agentPreset && agentKey) {
      existing.agentPreset = agentKey
    }
  } else {
    target.set(key, {
      model,
      agentPreset: agentKey,
      totalTokens: tokens,
    })
  }
}

function finalizeTopModels(
  source: Map<string, { model: string; agentPreset: string; totalTokens: number }>,
  limit = 4,
): ObservabilityRankModelSummary[] {
  return [...source.values()]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, limit)
}

const RAW_FEISHU_ID_RE = /^(?:ou|on|cli)_[a-zA-Z0-9_-]+$/

function isReadableSenderName(name: string | undefined, rawId?: string): boolean {
  const clean = name?.trim() ?? ''
  if (!clean) return false
  if (rawId && clean === rawId.trim()) return false
  return !RAW_FEISHU_ID_RE.test(clean)
}

function normalizeSenderNameKey(name: string): string {
  return name.trim().toLowerCase()
}

function formatFallbackSenderName(rawId: string): string {
  const clean = rawId.trim()
  if (!clean) return '未知触发人'
  if (clean.length > 14 && RAW_FEISHU_ID_RE.test(clean)) {
    return `${clean.slice(0, 6)}…${clean.slice(-4)}`
  }
  return clean
}

export interface ResolvedSenderIdentity {
  readonly senderId: string
  readonly senderName: string
  readonly hasReadableName: boolean
  readonly senderType: 'user' | 'bot'
  readonly avatarUrl: string
  readonly rawOpenId: string
}

interface SenderIdentityResolver {
  readonly resolve: (row: Pick<RawUsageEventRow, 'bot_id' | 'sender_id' | 'sender_name' | 'sender_type'>) => ResolvedSenderIdentity | null
  readonly resolveKnownById: (senderId: string) => ResolvedSenderIdentity | null
}

interface SenderOpenInfo {
  unionId: string
  name: string
  avatarUrl: string
  senderType: 'user' | 'bot'
}

interface SenderUnionInfo {
  name: string
  avatarUrl: string
  senderType: 'user' | 'bot'
}

function collectSenderMaps(
  profiles: readonly TelemetrySenderProfileRecord[],
  bots: ReturnType<ConfigRepo['listBots']>,
  rows: readonly RawUsageEventRow[],
): {
  readonly byBotOpen: Map<string, SenderOpenInfo>
  readonly byBareOpen: Map<string, SenderOpenInfo>
  readonly byUnion: Map<string, SenderUnionInfo>
} {
  const byBotOpen = new Map<string, SenderOpenInfo>()
  const byBareOpen = new Map<string, SenderOpenInfo>()
  const byUnion = new Map<string, SenderUnionInfo>()

  const mergeOpen = (
    botId: string,
    openId: string,
    patch: { unionId?: string; name?: string; avatarUrl?: string; senderType?: 'user' | 'bot' },
  ) => {
    const cleanOpen = openId.trim()
    if (!cleanOpen) return
    const apply = (map: Map<string, SenderOpenInfo>, key: string) => {
      const prev = map.get(key) ?? { unionId: '', name: '', avatarUrl: '', senderType: 'user' }
      map.set(key, {
        unionId: patch.unionId?.trim() || prev.unionId,
        name: isReadableSenderName(patch.name, cleanOpen) ? patch.name!.trim() : prev.name,
        avatarUrl: patch.avatarUrl?.trim() || prev.avatarUrl,
        senderType: patch.senderType === 'bot' ? 'bot' : prev.senderType,
      })
    }
    apply(byBotOpen, `${botId}:${cleanOpen}`)
    apply(byBareOpen, cleanOpen)
  }

  const mergeUnion = (
    unionId: string,
    patch: { name?: string; avatarUrl?: string; senderType?: 'user' | 'bot' },
  ) => {
    const clean = unionId.trim()
    if (!clean) return
    const prev = byUnion.get(clean) ?? { name: '', avatarUrl: '', senderType: 'user' }
    byUnion.set(clean, {
      name: isReadableSenderName(patch.name, clean) ? patch.name!.trim() : prev.name,
      avatarUrl: patch.avatarUrl?.trim() || prev.avatarUrl,
      senderType: patch.senderType === 'bot' ? 'bot' : prev.senderType,
    })
  }

  for (const bot of bots) {
    for (const p of [
      ...bot.allowedUserProfiles,
      ...bot.adminUserProfiles,
      ...bot.substituteMode.targets,
    ]) {
      if (!p.openId) continue
      mergeOpen(bot.id, p.openId, {
        ...(p.name ? { name: p.name } : {}),
        ...(p.avatarUrl ? { avatarUrl: p.avatarUrl } : {}),
        senderType: 'user',
      })
    }
  }
  for (const p of profiles) {
    mergeOpen(p.botId, p.openId, {
      ...(p.unionId ? { unionId: p.unionId } : {}),
      ...(p.name ? { name: p.name } : {}),
      ...(p.avatarUrl ? { avatarUrl: p.avatarUrl } : {}),
      ...(p.senderType ? { senderType: p.senderType } : {}),
    })
    if (p.unionId) {
      mergeUnion(p.unionId, {
        ...(p.name ? { name: p.name } : {}),
        ...(p.avatarUrl ? { avatarUrl: p.avatarUrl } : {}),
        ...(p.senderType ? { senderType: p.senderType } : {}),
      })
    }
  }
  for (const row of rows) {
    const rawId = row.sender_id.trim()
    const rawName = row.sender_name.trim()
    const st: 'user' | 'bot' = row.sender_type === 'bot' ? 'bot' : 'user'
    if (rawId.startsWith('on_')) {
      mergeUnion(rawId, { ...(rawName ? { name: rawName } : {}), senderType: st })
    } else if (rawId) {
      mergeOpen(row.bot_id, rawId, { ...(rawName ? { name: rawName } : {}), senderType: st })
    }
  }
  for (const info of byBotOpen.values()) {
    if (info.unionId) {
      mergeUnion(info.unionId, {
        ...(info.name ? { name: info.name } : {}),
        ...(info.avatarUrl ? { avatarUrl: info.avatarUrl } : {}),
        senderType: info.senderType,
      })
    }
  }
  return { byBotOpen, byBareOpen, byUnion }
}

function buildSenderNameIndexes(
  byBotOpen: ReadonlyMap<string, SenderOpenInfo>,
  byUnion: ReadonlyMap<string, SenderUnionInfo>,
): {
  readonly ambiguousNames: Set<string>
  readonly uniqueNameToUnion: Map<string, string>
  readonly nameMeta: Map<string, SenderUnionInfo>
} {
  const entitiesByBotName = new Map<string, Set<string>>()
  const unionsByName = new Map<string, Set<string>>()
  const nameMeta = new Map<string, SenderUnionInfo>()

  const trackMeta = (name: string, avatarUrl: string, senderType: 'user' | 'bot') => {
    const norm = normalizeSenderNameKey(name)
    const prev = nameMeta.get(norm)
    nameMeta.set(norm, {
      name: prev?.name || name.trim(),
      avatarUrl: prev?.avatarUrl || avatarUrl,
      senderType: prev?.senderType === 'bot' || senderType === 'bot' ? 'bot' : 'user',
    })
  }

  for (const [botOpenKey, info] of byBotOpen.entries()) {
    if (!isReadableSenderName(info.name)) continue
    const sep = botOpenKey.indexOf(':')
    const botId = sep >= 0 ? botOpenKey.slice(0, sep) : ''
    const openId = sep >= 0 ? botOpenKey.slice(sep + 1) : botOpenKey
    const norm = normalizeSenderNameKey(info.name)
    const botNameKey = `${botId}:${norm}`
    const set = entitiesByBotName.get(botNameKey) ?? new Set<string>()
    set.add(info.unionId || openId)
    entitiesByBotName.set(botNameKey, set)
    if (info.unionId) {
      const uSet = unionsByName.get(norm) ?? new Set<string>()
      uSet.add(info.unionId)
      unionsByName.set(norm, uSet)
    }
    trackMeta(info.name, info.avatarUrl, info.senderType)
  }

  for (const [unionId, info] of byUnion.entries()) {
    if (!isReadableSenderName(info.name)) continue
    const norm = normalizeSenderNameKey(info.name)
    const uSet = unionsByName.get(norm) ?? new Set<string>()
    uSet.add(unionId)
    unionsByName.set(norm, uSet)
    trackMeta(info.name, info.avatarUrl, info.senderType)
  }

  const ambiguousNames = new Set<string>()
  for (const [botNameKey, entities] of entitiesByBotName.entries()) {
    if (entities.size > 1) {
      const sep = botNameKey.indexOf(':')
      if (sep >= 0) ambiguousNames.add(botNameKey.slice(sep + 1))
    }
  }
  for (const [norm, unions] of unionsByName.entries()) {
    if (unions.size > 1) ambiguousNames.add(norm)
  }

  const uniqueNameToUnion = new Map<string, string>()
  for (const [norm, unions] of unionsByName.entries()) {
    if (!ambiguousNames.has(norm) && unions.size === 1) {
      uniqueNameToUnion.set(norm, [...unions][0]!)
    }
  }

  return { ambiguousNames, uniqueNameToUnion, nameMeta }
}

function createSenderIdentityResolver(
  profiles: readonly TelemetrySenderProfileRecord[],
  bots: ReturnType<ConfigRepo['listBots']>,
  rows: readonly RawUsageEventRow[],
): SenderIdentityResolver {
  const { byBotOpen, byBareOpen, byUnion } = collectSenderMaps(profiles, bots, rows)
  const { ambiguousNames, uniqueNameToUnion, nameMeta } = buildSenderNameIndexes(byBotOpen, byUnion)

  const resolve = (
    row: Pick<RawUsageEventRow, 'bot_id' | 'sender_id' | 'sender_name' | 'sender_type'>,
  ): ResolvedSenderIdentity | null => {
    const rawId = row.sender_id.trim()
    const rawName = row.sender_name.trim()
    const rawType = row.sender_type.trim()
    if (!rawId && !rawName) return null

    const botOpenInfo =
      rawId && !rawId.startsWith('on_')
        ? (byBotOpen.get(`${row.bot_id}:${rawId}`) ?? byBareOpen.get(rawId))
        : undefined
    const unionId = rawId.startsWith('on_') ? rawId : (botOpenInfo?.unionId ?? '')
    const unionInfo = unionId ? byUnion.get(unionId) : undefined

    const readableName =
      (isReadableSenderName(unionInfo?.name, unionId) ? unionInfo!.name : '') ||
      (isReadableSenderName(botOpenInfo?.name, rawId) ? botOpenInfo!.name : '') ||
      (isReadableSenderName(rawName, rawId) ? rawName : '')

    const normName = readableName ? normalizeSenderNameKey(readableName) : ''
    const isAmbiguous = normName ? ambiguousNames.has(normName) : false
    const matchedUnionByName =
      !unionId && normName && !isAmbiguous ? (uniqueNameToUnion.get(normName) ?? '') : ''
    const effectiveUnionId = unionId || matchedUnionByName
    const effectiveUnionInfo = effectiveUnionId ? byUnion.get(effectiveUnionId) : undefined

    const canonicalId = effectiveUnionId
      ? effectiveUnionId
      : normName && !isAmbiguous
        ? `name:${normName}`
        : rawId || `name:${normName}`

    const senderType: 'user' | 'bot' =
      rawType === 'bot' ||
      botOpenInfo?.senderType === 'bot' ||
      effectiveUnionInfo?.senderType === 'bot'
        ? 'bot'
        : 'user'

    const metaByName = normName && !isAmbiguous ? nameMeta.get(normName) : undefined
    const resolvedReadableName =
      effectiveUnionInfo?.name ||
      readableName ||
      metaByName?.name ||
      ''
    const hasReadableName = isReadableSenderName(resolvedReadableName, rawId || canonicalId)
    const senderName = hasReadableName
      ? resolvedReadableName
      : formatFallbackSenderName(rawId || canonicalId)

    const avatarUrl =
      botOpenInfo?.avatarUrl || effectiveUnionInfo?.avatarUrl || metaByName?.avatarUrl || ''

    return {
      senderId: canonicalId,
      senderName,
      hasReadableName,
      senderType,
      avatarUrl,
      rawOpenId: rawId && !rawId.startsWith('on_') ? rawId : '',
    }
  }

  const resolveKnownById = (senderId: string): ResolvedSenderIdentity | null => {
    const clean = senderId.trim()
    if (!clean) return null
    if (clean.startsWith('name:')) {
      const norm = clean.slice(5)
      const meta = nameMeta.get(norm)
      const resolvedName = meta?.name || norm
      return {
        senderId: clean,
        senderName: resolvedName,
        hasReadableName: isReadableSenderName(resolvedName),
        senderType: meta?.senderType ?? 'user',
        avatarUrl: meta?.avatarUrl ?? '',
        rawOpenId: '',
      }
    }
    const unionInfo = byUnion.get(clean)
    if (unionInfo) {
      const hasReadable = isReadableSenderName(unionInfo.name, clean)
      return {
        senderId: clean,
        senderName: hasReadable ? unionInfo.name : formatFallbackSenderName(clean),
        hasReadableName: hasReadable,
        senderType: unionInfo.senderType,
        avatarUrl: unionInfo.avatarUrl,
        rawOpenId: '',
      }
    }
    const bare = byBareOpen.get(clean)
    if (bare) {
      const hasReadable = isReadableSenderName(bare.name, clean)
      return {
        senderId: clean,
        senderName: hasReadable ? bare.name : formatFallbackSenderName(clean),
        hasReadableName: hasReadable,
        senderType: bare.senderType,
        avatarUrl: bare.avatarUrl,
        rawOpenId: clean,
      }
    }
    return {
      senderId: clean,
      senderName: formatFallbackSenderName(clean),
      hasReadableName: false,
      senderType: 'user',
      avatarUrl: '',
      rawOpenId: clean.startsWith('ou_') ? clean : '',
    }
  }

  return { resolve, resolveKnownById }
}

export interface ObservabilityRepoAggregate {
  readonly window: ObservabilityWindow
  readonly fromMs: number
  readonly toMs: number
  readonly bucketSpanMs: number
  readonly current: WindowTotals
  readonly previous: WindowTotals
  readonly createdSessionsInWindow: number
  readonly prevCreatedSessions: number
  readonly archivedSessionsInWindow: number
  readonly series: readonly ObservabilitySeriesPoint[]
  readonly latencyHistogram: readonly ObservabilityLatencyBucket[]
  readonly models: readonly ObservabilityModelBreakdown[]
  readonly agents: readonly ObservabilityAgentBreakdown[]
  readonly triggers: readonly ObservabilityTriggerBreakdown[]
  readonly errors: readonly ObservabilityErrorBreakdown[]
  readonly heatmap: { readonly maxCount: number; readonly cells: readonly ObservabilityHeatmapCell[] }
  readonly botStats: ReadonlyMap<
    string,
    {
      readonly sessions: number
      readonly inbound: number
      readonly replied: number
      readonly silentSkipped: number
      readonly errors: number
      readonly totalTokens: number
      readonly inputTokens: number
      readonly cacheReadTokens: number
      readonly cacheWriteTokens: number
      readonly outputTokens: number
      readonly promptTokens: number
      readonly topModels: readonly ObservabilityRankModelSummary[]
      readonly latencies: number[]
    }
  >
  readonly chatRanking: readonly ObservabilityChatRow[]
  readonly senderRanking: readonly ObservabilitySenderRow[]
  readonly chatFilterOptions: readonly ObservabilityChatFilterOption[]
  readonly senderFilterOptions: readonly ObservabilitySenderFilterOption[]
  readonly matchedSessionIds: ReadonlySet<string>
  readonly unresolvedSenderChats: ReadonlyArray<{ readonly botId: string; readonly chatId: string }>
}

const AGGREGATE_CACHE_TTL_MS = 5_000
const MAX_AGGREGATE_CACHE_ENTRIES = 16

export class ObservabilityRepo {
  private insertCounter = 0
  private readonly aggregateCache = new Map<
    string,
    { readonly expiresAtMs: number; readonly result: ObservabilityRepoAggregate }
  >()
  private readonly senderProfileMem = new Map<string, string>()

  constructor(
    private readonly db: BridgeDatabase,
    private readonly config: ConfigRepo,
  ) {}

  private invalidateAggregateCache(): void {
    if (this.aggregateCache.size > 0) this.aggregateCache.clear()
  }

  recordUsageEvent(input: TelemetryUsageEventInput): boolean {
    const id = input.id.trim()
    if (!id) return false
    const ts = Number.isFinite(input.timestampMs) ? Math.round(input.timestampMs) : Date.now()
    const inTok = Math.max(0, Math.round(input.inputTokens ?? 0))
    const outTok = Math.max(0, Math.round(input.outputTokens ?? 0))
    const crTok = Math.max(0, Math.round(input.cacheReadTokens ?? 0))
    const cwTok = Math.max(0, Math.round(input.cacheWriteTokens ?? 0))
    const rTok = Math.max(0, Math.round(input.reasoningTokens ?? 0))
    const computedTotal = inTok + outTok + crTok + cwTok
    const totTok = Math.max(computedTotal, Math.round(input.totalTokens ?? computedTotal))
    const toolCalls = Math.max(0, Math.round(input.toolCalls ?? 0))
    const toolErrors = Math.max(0, Math.round(input.toolErrors ?? 0))
    const latencyMs =
      input.latencyMs !== undefined && Number.isFinite(input.latencyMs) && input.latencyMs >= 0
        ? Math.round(input.latencyMs)
        : null

    const botId = input.botId || 'unknown'
    const chatId = input.chatId ?? ''
    const chatType = input.chatType ?? ''
    const sessionId = input.sessionId ?? ''
    const senderId = input.senderId?.trim() ?? ''
    const senderName = input.senderName?.trim() ?? ''
    const senderType = input.senderType ?? ''
    const trigger = input.trigger ?? ''
    const agentPreset = input.agentPreset ?? ''
    const provider = input.provider ?? ''
    const model = input.model ?? ''
    const outcome = input.outcome ?? ''
    const errorCode = input.errorCode ?? ''

    const inserted = this.db.transaction(() => {
      const res = this.db
        .prepare(
          `INSERT OR IGNORE INTO telemetry_usage_events (
             id, timestamp_ms, record_kind, bot_id, chat_id, chat_type, session_id,
             sender_id, sender_name, sender_type,
             trigger, agent_preset, provider, model, outcome, error_code, latency_ms,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
             reasoning_tokens, total_tokens, tool_calls, tool_errors
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          ts,
          input.recordKind,
          botId,
          chatId,
          chatType,
          sessionId,
          senderId,
          senderName,
          senderType,
          trigger,
          agentPreset,
          provider,
          model,
          outcome,
          errorCode,
          latencyMs,
          inTok,
          outTok,
          crTok,
          cwTok,
          rTok,
          totTok,
          toolCalls,
          toolErrors,
        )
      if (Number(res.changes) === 0) return false

      const dayKey = formatDayKey(ts)
      const isReplied =
        (input.recordKind === 'turn' || input.recordKind === 'proactive') &&
        (outcome === 'replied' || outcome === 'quick_reply' || outcome === 'completed')
      const isLatencyCounted = isReplied && latencyMs !== null
      this.db
        .prepare(
          `INSERT INTO telemetry_daily_rollups (
             day_key, bot_id, chat_id, model, trigger,
             inbound_count, replied_count, silent_count, ignored_count, error_count,
             triage_count, triage_quick_count, triage_handoff_count, triage_silent_count, triage_fallback_count,
             llm_steps, tool_calls, tool_errors,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
             latency_sum_ms, latency_count, latency_max_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(day_key, bot_id, chat_id, model, trigger) DO UPDATE SET
             inbound_count = inbound_count + excluded.inbound_count,
             replied_count = replied_count + excluded.replied_count,
             silent_count = silent_count + excluded.silent_count,
             ignored_count = ignored_count + excluded.ignored_count,
             error_count = error_count + excluded.error_count,
             triage_count = triage_count + excluded.triage_count,
             triage_quick_count = triage_quick_count + excluded.triage_quick_count,
             triage_handoff_count = triage_handoff_count + excluded.triage_handoff_count,
             triage_silent_count = triage_silent_count + excluded.triage_silent_count,
             triage_fallback_count = triage_fallback_count + excluded.triage_fallback_count,
             llm_steps = llm_steps + excluded.llm_steps,
             tool_calls = tool_calls + excluded.tool_calls,
             tool_errors = tool_errors + excluded.tool_errors,
             input_tokens = input_tokens + excluded.input_tokens,
             output_tokens = output_tokens + excluded.output_tokens,
             cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
             cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
             reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
             total_tokens = total_tokens + excluded.total_tokens,
             latency_sum_ms = latency_sum_ms + excluded.latency_sum_ms,
             latency_count = latency_count + excluded.latency_count,
             latency_max_ms = MAX(latency_max_ms, excluded.latency_max_ms)`,
        )
        .run(
          dayKey,
          botId,
          chatId,
          model,
          trigger,
          input.recordKind === 'inbound' && outcome !== 'ignored' ? 1 : 0,
          isReplied ? 1 : 0,
          (input.recordKind === 'turn' || input.recordKind === 'proactive') && outcome === 'silent_skip'
            ? 1
            : 0,
          outcome === 'ignored' ? 1 : 0,
          (input.recordKind === 'turn' || input.recordKind === 'proactive') && outcome === 'error'
            ? 1
            : 0,
          input.recordKind === 'triage' ? 1 : 0,
          input.recordKind === 'triage' && outcome === 'quick_reply' ? 1 : 0,
          input.recordKind === 'triage' && (outcome === 'handoff' || outcome === 'fallback') ? 1 : 0,
          input.recordKind === 'triage' && outcome === 'silent' ? 1 : 0,
          input.recordKind === 'triage' && outcome === 'fallback' ? 1 : 0,
          input.recordKind === 'llm_step' ? 1 : 0,
          toolCalls,
          toolErrors,
          inTok,
          outTok,
          crTok,
          cwTok,
          rTok,
          totTok,
          isLatencyCounted ? latencyMs! : 0,
          isLatencyCounted ? 1 : 0,
          isLatencyCounted ? latencyMs! : 0,
        )
      return true
    })

    if (inserted) {
      this.invalidateAggregateCache()
      this.insertCounter += 1
      if (this.insertCounter >= PRUNE_EVERY_INSERTS) {
        this.insertCounter = 0
        this.prune(ts)
      }
    }
    return inserted
  }

  recordUsageEventsBatch(events: readonly TelemetryUsageEventInput[]): number {
    if (events.length === 0) return 0
    let inserted = 0
    this.db.transaction(() => {
      for (const ev of events) {
        if (this.recordUsageEvent(ev)) {
          inserted += 1
        }
      }
    })
    return inserted
  }

  getSessionWatermark(sessionId: string): number {
    const row = this.db
      .prepare('SELECT last_seq FROM telemetry_session_watermarks WHERE session_id = ?')
      .get(sessionId) as { last_seq?: number } | undefined
    return row?.last_seq !== undefined ? Number(row.last_seq) : -1
  }

  setSessionWatermark(sessionId: string, lastSeq: number, updatedAtMs = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO telemetry_session_watermarks (session_id, last_seq, updated_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           last_seq = MAX(last_seq, excluded.last_seq),
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(sessionId, Math.floor(lastSeq), updatedAtMs)
  }

  listSessionWatermarks(): Map<string, number> {
    const rows = this.db
      .prepare('SELECT session_id, last_seq FROM telemetry_session_watermarks')
      .all() as Array<{ session_id: string; last_seq: number }>
    const map = new Map<string, number>()
    for (const r of rows) {
      map.set(r.session_id, Number(r.last_seq))
    }
    return map
  }

  listSessionsNeedingAttributionRepair(limit = 400): string[] {
    const safeLimit = Math.max(1, Math.min(2000, Math.floor(limit)))
    const rows = this.db
      .prepare(
        `SELECT session_id, MAX(timestamp_ms) AS latest_ts
         FROM telemetry_usage_events
         WHERE record_kind = 'llm_step'
           AND session_id != ''
           AND (trim(model) = '' OR trim(provider) = '' OR trim(agent_preset) = '')
         GROUP BY session_id
         ORDER BY latest_ts DESC
         LIMIT ?`,
      )
      .all(safeLimit) as Array<{ session_id: string }>
    return rows.map((r) => r.session_id)
  }

  repairUsageEventAttribution(
    updates: ReadonlyArray<{
      readonly id: string
      readonly agentPreset?: string
      readonly provider?: string
      readonly model?: string
    }>,
  ): number {
    if (updates.length === 0) return 0
    const stmt = this.db.prepare(
      `UPDATE telemetry_usage_events
       SET agent_preset = CASE WHEN ? != '' THEN ? ELSE agent_preset END,
           provider     = CASE WHEN ? != '' THEN ? ELSE provider END,
           model        = CASE WHEN ? != '' THEN ? ELSE model END
       WHERE id = ?
         AND (
           (? != '' AND agent_preset != ?)
           OR (? != '' AND provider != ?)
           OR (? != '' AND model != ?)
         )`,
    )
    let updated = 0
    this.db.transaction(() => {
      for (const item of updates) {
        const id = item.id.trim()
        if (!id) continue
        const preset = item.agentPreset?.trim() ?? ''
        const provider = item.provider?.trim() ?? ''
        const model = item.model?.trim() ?? ''
        if (!preset && !provider && !model) continue
        const res = stmt.run(
          preset,
          preset,
          provider,
          provider,
          model,
          model,
          id,
          preset,
          preset,
          provider,
          provider,
          model,
          model,
        )
        if (Number(res.changes) > 0) updated += Number(res.changes)
      }
    })
    if (updated > 0) {
      this.invalidateAggregateCache()
    }
    return updated
  }

  upsertSenderProfile(profile: TelemetrySenderProfileRecord): boolean {
    const botId = profile.botId.trim()
    const openId = profile.openId.trim()
    if (!botId || !openId) return false
    const unionId = profile.unionId?.trim() ?? ''
    const rawName = profile.name?.trim() ?? ''
    const name = isReadableSenderName(rawName, openId) ? rawName : ''
    const avatarUrl = profile.avatarUrl?.trim() ?? ''
    const senderType: 'user' | 'bot' = profile.senderType === 'bot' ? 'bot' : 'user'
    if (!unionId && !name && !avatarUrl && senderType === 'user') return false

    const memKey = `${botId}:${openId}`
    const sig = `${unionId}|${name}|${avatarUrl}|${senderType}`
    if (this.senderProfileMem.get(memKey) === sig) return false
    this.senderProfileMem.set(memKey, sig)
    if (this.senderProfileMem.size > 4000) {
      const oldest = this.senderProfileMem.keys().next().value
      if (oldest !== undefined) this.senderProfileMem.delete(oldest)
    }

    const updatedAtMs = profile.updatedAtMs ?? Date.now()
    const res = this.db
      .prepare(
        `INSERT INTO telemetry_sender_profiles (
           bot_id, open_id, union_id, name, avatar_url, sender_type, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bot_id, open_id) DO UPDATE SET
           union_id      = CASE WHEN excluded.union_id != '' THEN excluded.union_id ELSE telemetry_sender_profiles.union_id END,
           name          = CASE WHEN excluded.name != '' THEN excluded.name ELSE telemetry_sender_profiles.name END,
           avatar_url    = CASE WHEN excluded.avatar_url != '' THEN excluded.avatar_url ELSE telemetry_sender_profiles.avatar_url END,
           sender_type   = CASE WHEN excluded.sender_type = 'bot' THEN 'bot' ELSE telemetry_sender_profiles.sender_type END,
           updated_at_ms = MAX(telemetry_sender_profiles.updated_at_ms, excluded.updated_at_ms)
         WHERE (excluded.union_id != '' AND excluded.union_id != telemetry_sender_profiles.union_id)
            OR (excluded.name != '' AND excluded.name != telemetry_sender_profiles.name)
            OR (excluded.avatar_url != '' AND excluded.avatar_url != telemetry_sender_profiles.avatar_url)
            OR (excluded.sender_type = 'bot' AND telemetry_sender_profiles.sender_type != 'bot')`,
      )
      .run(botId, openId, unionId, name, avatarUrl, senderType, updatedAtMs)
    const changed = Number(res.changes) > 0
    if (changed) {
      this.invalidateAggregateCache()
    }
    return changed
  }

  upsertSenderProfilesBatch(profiles: readonly TelemetrySenderProfileRecord[]): number {
    if (profiles.length === 0) return 0
    let changed = 0
    this.db.transaction(() => {
      for (const profile of profiles) {
        if (this.upsertSenderProfile(profile)) {
          changed += 1
        }
      }
    })
    return changed
  }

  getSenderProfile(botId: string, openId: string): TelemetrySenderProfileRecord | undefined {
    const cleanBot = botId.trim()
    const cleanOpen = openId.trim()
    if (!cleanBot || !cleanOpen) return undefined
    const row = this.db
      .prepare(
        `SELECT bot_id, open_id, union_id, name, avatar_url, sender_type, updated_at_ms
         FROM telemetry_sender_profiles
         WHERE bot_id = ? AND open_id = ?`,
      )
      .get(cleanBot, cleanOpen) as
      | {
          bot_id: string
          open_id: string
          union_id: string
          name: string
          avatar_url: string
          sender_type: string
          updated_at_ms: number
        }
      | undefined
    if (!row) return undefined
    return {
      botId: row.bot_id,
      openId: row.open_id,
      ...(row.union_id ? { unionId: row.union_id } : {}),
      ...(row.name ? { name: row.name } : {}),
      ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}),
      senderType: row.sender_type === 'bot' ? 'bot' : 'user',
      updatedAtMs: Number(row.updated_at_ms),
    }
  }

  listChatsWithUnnamedSenders(limit = 20): Array<{ readonly botId: string; readonly chatId: string }> {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)))
    const rows = this.db
      .prepare(
        `SELECT bot_id, chat_id, sender_id, sender_name, sender_type, MAX(timestamp_ms) AS latest_ts
         FROM telemetry_usage_events
         WHERE bot_id != ''
           AND bot_id != 'system'
           AND chat_id != ''
           AND chat_type != 'p2p'
           AND chat_type != 'internal'
           AND chat_id NOT LIKE 'dream:%'
           AND trim(sender_id) != ''
           AND trim(sender_name) = ''
         GROUP BY bot_id, chat_id, sender_id, sender_name, sender_type
         ORDER BY latest_ts DESC
         LIMIT 500`,
      )
      .all() as Array<{
      bot_id: string
      chat_id: string
      sender_id: string
      sender_name: string
      sender_type: string
    }>
    if (rows.length === 0) return []
    const profiles = this.listSenderProfiles()
    const bots = this.config.listBots()
    const resolver = createSenderIdentityResolver(
      profiles,
      bots,
      rows as unknown as readonly RawUsageEventRow[],
    )
    const seen = new Set<string>()
    const out: Array<{ readonly botId: string; readonly chatId: string }> = []
    for (const row of rows) {
      const resolved = resolver.resolve(row)
      if (!resolved || resolved.hasReadableName) continue
      const key = buildGroupKey(row.bot_id, row.chat_id)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ botId: row.bot_id, chatId: row.chat_id })
      if (out.length >= safeLimit) break
    }
    return out
  }

  listSenderProfiles(): TelemetrySenderProfileRecord[] {
    const rows = this.db
      .prepare(
        `SELECT bot_id, open_id, union_id, name, avatar_url, sender_type, updated_at_ms
         FROM telemetry_sender_profiles
         ORDER BY updated_at_ms DESC`,
      )
      .all() as Array<{
      bot_id: string
      open_id: string
      union_id: string
      name: string
      avatar_url: string
      sender_type: string
      updated_at_ms: number
    }>
    return rows.map((r) => ({
      botId: r.bot_id,
      openId: r.open_id,
      ...(r.union_id ? { unionId: r.union_id } : {}),
      ...(r.name ? { name: r.name } : {}),
      ...(r.avatar_url ? { avatarUrl: r.avatar_url } : {}),
      senderType: r.sender_type === 'bot' ? 'bot' : 'user',
      updatedAtMs: Number(r.updated_at_ms),
    }))
  }

  listSessionsNeedingSenderRepair(limit = 400): string[] {
    const safeLimit = Math.max(1, Math.min(2000, Math.floor(limit)))
    const rows = this.db
      .prepare(
        `SELECT session_id, MAX(timestamp_ms) AS latest_ts
         FROM telemetry_usage_events
         WHERE session_id != ''
           AND trim(sender_id) = ''
           AND trim(sender_name) = ''
           AND trigger NOT IN ('schedule', 'reminder', 'dreaming')
         GROUP BY session_id
         ORDER BY latest_ts DESC
         LIMIT ?`,
      )
      .all(safeLimit) as Array<{ session_id: string }>
    return rows.map((r) => r.session_id)
  }

  repairUsageEventSenders(
    updates: ReadonlyArray<{
      readonly id: string
      readonly senderId?: string
      readonly senderName?: string
      readonly senderType?: 'user' | 'bot' | ''
    }>,
  ): number {
    if (updates.length === 0) return 0
    const stmt = this.db.prepare(
      `UPDATE telemetry_usage_events
       SET sender_id   = CASE WHEN trim(sender_id) = '' AND ? != '' THEN ? ELSE sender_id END,
           sender_name = CASE WHEN trim(sender_name) = '' AND ? != '' THEN ? ELSE sender_name END,
           sender_type = CASE WHEN trim(sender_type) = '' AND ? != '' THEN ? ELSE sender_type END
       WHERE id = ?
         AND (
           (trim(sender_id) = '' AND ? != '')
           OR (trim(sender_name) = '' AND ? != '')
           OR (trim(sender_type) = '' AND ? != '')
         )`,
    )
    let updated = 0
    this.db.transaction(() => {
      for (const item of updates) {
        const id = item.id.trim()
        if (!id) continue
        const sid = item.senderId?.trim() ?? ''
        const sname = item.senderName?.trim() ?? ''
        const stype = item.senderType?.trim() ?? ''
        if (!sid && !sname) continue
        const res = stmt.run(sid, sid, sname, sname, stype, stype, id, sid, sname, stype)
        if (Number(res.changes) > 0) updated += Number(res.changes)
      }
    })
    if (updated > 0) this.invalidateAggregateCache()
    return updated
  }

  repairSessionNonStepEventSenders(
    sessionId: string,
    turnWindows: ReadonlyArray<{
      readonly startMs: number
      readonly senderId: string
      readonly senderName: string
      readonly senderType: 'user' | 'bot' | ''
    }>,
    scope?: { readonly botId: string; readonly chatId: string },
  ): number {
    if (!sessionId || turnWindows.length === 0) return 0
    const nonEmptyTurns = turnWindows.filter((t) => t.senderId || t.senderName)
    if (nonEmptyTurns.length === 0) return 0
    const distinctIds = new Set(nonEmptyTurns.map((t) => t.senderId || t.senderName))
    const singleSender = distinctIds.size === 1 ? nonEmptyTurns[0]! : undefined

    const updates: Array<{
      readonly id: string
      readonly senderId?: string
      readonly senderName?: string
      readonly senderType?: 'user' | 'bot' | ''
    }> = []

    const pending = this.db
      .prepare(
        `SELECT id, timestamp_ms, record_kind
         FROM telemetry_usage_events
         WHERE session_id = ?
           AND record_kind IN ('inbound', 'turn')
           AND trim(sender_id) = ''
           AND trim(sender_name) = ''`,
      )
      .all(sessionId) as Array<{ id: string; timestamp_ms: number; record_kind: string }>

    for (const row of pending) {
      let matched = singleSender
      if (!matched) {
        const ts = Number(row.timestamp_ms)
        if (row.record_kind === 'inbound') {
          matched =
            turnWindows.find((t) => t.startMs >= ts - 10_000) ??
            turnWindows[turnWindows.length - 1]
        } else {
          for (let i = turnWindows.length - 1; i >= 0; i -= 1) {
            if (turnWindows[i]!.startMs <= ts + 5_000) {
              matched = turnWindows[i]
              break
            }
          }
          matched ??= turnWindows[0]
        }
      }
      if (matched && (matched.senderId || matched.senderName)) {
        updates.push({
          id: row.id,
          ...(matched.senderId ? { senderId: matched.senderId } : {}),
          ...(matched.senderName ? { senderName: matched.senderName } : {}),
          ...(matched.senderType ? { senderType: matched.senderType } : {}),
        })
      }
    }

    // Legacy v7 inbound metric rows were recorded before acquireAgent() so their session_id is ''.
    // Match each turn window's user/message timestamp back to the nearest unattributed inbound row
    // in the same (bot_id, chat_id) within the pre-turn acquisition window (1-to-1).
    if (scope?.botId && scope?.chatId) {
      const findInboundStmt = this.db.prepare(
        `SELECT id
         FROM telemetry_usage_events
         WHERE bot_id = ?
           AND chat_id = ?
           AND record_kind = 'inbound'
           AND session_id = ''
           AND trim(sender_id) = ''
           AND trim(sender_name) = ''
           AND timestamp_ms >= ?
           AND timestamp_ms <= ?
         ORDER BY ABS(timestamp_ms - ?) ASC
         LIMIT 1`,
      )
      const claimed = new Set<string>()
      for (const tw of nonEmptyTurns) {
        if (tw.startMs <= 0) continue
        const hit = findInboundStmt.get(
          scope.botId,
          scope.chatId,
          tw.startMs - 20_000,
          tw.startMs + 2_000,
          tw.startMs,
        ) as { id?: string } | undefined
        if (hit?.id && !claimed.has(hit.id)) {
          claimed.add(hit.id)
          updates.push({
            id: hit.id,
            ...(tw.senderId ? { senderId: tw.senderId } : {}),
            ...(tw.senderName ? { senderName: tw.senderName } : {}),
            ...(tw.senderType ? { senderType: tw.senderType } : {}),
          })
        }
      }
    }

    return this.repairUsageEventSenders(updates)
  }

  prune(nowMs = Date.now()): void {
    const detailCutoff = nowMs - DETAIL_RETENTION_MS
    this.db.prepare('DELETE FROM telemetry_usage_events WHERE timestamp_ms < ?').run(detailCutoff)
    const countRow = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM telemetry_usage_events')
      .get() as { cnt?: number }
    const excess = Number(countRow?.cnt ?? 0) - MAX_DETAIL_ROWS
    if (excess > 0) {
      this.db
        .prepare(
          `DELETE FROM telemetry_usage_events WHERE id IN (
             SELECT id FROM telemetry_usage_events ORDER BY timestamp_ms ASC LIMIT ?
           )`,
        )
        .run(excess)
    }
    const rollupCutoffDay = formatDayKey(nowMs - ROLLUP_RETENTION_DAYS * 24 * 3_600_000)
    this.db
      .prepare('DELETE FROM telemetry_daily_rollups WHERE day_key < ?')
      .run(rollupCutoffDay)
  }

  queryAggregate(options: {
    readonly window?: ObservabilityWindow
    readonly botId?: string
    readonly chatId?: string
    readonly senderId?: string
    readonly nowMs?: number
  }): ObservabilityRepoAggregate {
    const spec = resolveWindowSpec(options.window)
    const nowMs = options.nowMs ?? Date.now()
    // Align bucket end to the end of the current hour (for 24h/7d) or current day (for 30d/90d)
    const alignedEndMs = this.alignWindowEnd(nowMs, spec)
    const fromMs = alignedEndMs - spec.spanMs
    const prevFromMs = fromMs - spec.spanMs
    const botId = options.botId?.trim() || ''
    const chatId = options.chatId?.trim() || ''
    const senderId = options.senderId?.trim() || ''
    const cacheKey = `${spec.window}|${botId}|${chatId}|${senderId}|${alignedEndMs}`
    const wallNow = Date.now()
    const isLiveNow = options.nowMs === undefined
    if (isLiveNow) {
      const hit = this.aggregateCache.get(cacheKey)
      if (hit && wallNow < hit.expiresAtMs) {
        return hit.result
      }
    }

    // Fetch current + previous window in a single indexed range scan, then partition in memory.
    const combinedRows = this.fetchUsageEvents(prevFromMs, alignedEndMs, botId, chatId)
    const profiles = this.listSenderProfiles()
    const bots = this.config.listBots()
    const senderResolver = createSenderIdentityResolver(profiles, bots, combinedRows)

    const unfilteredCurrentRows: RawUsageEventRow[] = []
    const unfilteredPreviousRows: RawUsageEventRow[] = []
    const unresolvedChatSeen = new Set<string>()
    const unresolvedSenderChats: Array<{ readonly botId: string; readonly chatId: string }> = []
    for (const row of combinedRows) {
      if (Number(row.timestamp_ms) >= fromMs) {
        unfilteredCurrentRows.push(row)
        if (
          unresolvedSenderChats.length < 16 &&
          row.bot_id &&
          row.bot_id !== 'system' &&
          row.chat_id &&
          row.chat_type !== 'p2p' &&
          row.chat_type !== 'internal' &&
          !row.chat_id.startsWith('dream:')
        ) {
          const chatKey = buildGroupKey(row.bot_id, row.chat_id)
          if (!unresolvedChatSeen.has(chatKey)) {
            const resolved = senderResolver.resolve(row)
            if (resolved && !resolved.hasReadableName) {
              unresolvedChatSeen.add(chatKey)
              unresolvedSenderChats.push({ botId: row.bot_id, chatId: row.chat_id })
            }
          }
        }
      } else {
        unfilteredPreviousRows.push(row)
      }
    }

    const senderFilterOptions = this.buildSenderFilterOptions(
      unfilteredCurrentRows,
      unfilteredPreviousRows,
      senderResolver,
      senderId,
    )

    const currentRows = senderId
      ? unfilteredCurrentRows.filter((row) => senderResolver.resolve(row)?.senderId === senderId)
      : unfilteredCurrentRows
    const previousRows = senderId
      ? unfilteredPreviousRows.filter((row) => senderResolver.resolve(row)?.senderId === senderId)
      : unfilteredPreviousRows

    const current = emptyWindowTotals()
    for (const row of currentRows) accumulateRow(current, row)

    const previous = emptyWindowTotals()
    for (const row of previousRows) accumulateRow(previous, row)

    const series = this.buildTimeSeries(currentRows, fromMs, alignedEndMs, spec)
    const latencyHistogram = buildLatencyHistogram(current.latencies)
    const models = this.buildModelBreakdown(currentRows, current.totalTokens)
    const agents = this.buildAgentBreakdown(currentRows, current.totalTokens)
    const triggers = this.buildTriggerBreakdown(currentRows)
    const errors = this.buildErrorBreakdown(currentRows)
    const heatmap = this.buildHeatmap(currentRows)
    const botStats = this.buildBotStatsMap(currentRows)
    const chatRanking = this.buildChatRanking(currentRows)
    const senderRanking = this.buildSenderRanking(currentRows, senderResolver)
    const chatFilterOptions = this.buildChatFilterOptions(botId)

    const sessionCounts = this.countManagedSessionsInRanges(
      fromMs,
      alignedEndMs,
      prevFromMs,
      botId,
      chatId,
      senderId ? { current: current.sessions, previous: previous.sessions } : undefined,
    )

    const result: ObservabilityRepoAggregate = {
      window: spec.window,
      fromMs,
      toMs: alignedEndMs,
      bucketSpanMs: spec.bucketSpanMs,
      current,
      previous,
      createdSessionsInWindow: sessionCounts.createdCurrent,
      prevCreatedSessions: sessionCounts.createdPrevious,
      archivedSessionsInWindow: sessionCounts.archivedCurrent,
      series,
      latencyHistogram,
      models,
      agents,
      triggers,
      errors,
      heatmap,
      botStats,
      chatRanking,
      senderRanking,
      chatFilterOptions,
      senderFilterOptions,
      matchedSessionIds: current.sessions,
      unresolvedSenderChats,
    }
    if (isLiveNow) {
      if (this.aggregateCache.size >= MAX_AGGREGATE_CACHE_ENTRIES) {
        const oldestKey = this.aggregateCache.keys().next().value
        if (oldestKey !== undefined) this.aggregateCache.delete(oldestKey)
      }
      this.aggregateCache.set(cacheKey, {
        expiresAtMs: wallNow + AGGREGATE_CACHE_TTL_MS,
        result,
      })
    }
    return result
  }

  private alignWindowEnd(nowMs: number, spec: WindowSpec): number {
    const d = new Date(nowMs)
    if (spec.window === '24h') {
      d.setMinutes(0, 0, 0)
      return d.getTime() + 3_600_000
    }
    if (spec.window === '7d') {
      const hourFloor = Math.floor(d.getHours() / 6) * 6
      d.setHours(hourFloor, 0, 0, 0)
      return d.getTime() + 6 * 3_600_000
    }
    d.setHours(0, 0, 0, 0)
    return d.getTime() + 24 * 3_600_000
  }

  private fetchUsageEvents(
    fromMs: number,
    toMs: number,
    botId: string,
    chatId: string,
  ): RawUsageEventRow[] {
    const clauses: string[] = ['timestamp_ms >= ?', 'timestamp_ms < ?']
    const params: Array<string | number> = [fromMs, toMs]
    if (botId) {
      clauses.push('bot_id = ?')
      params.push(botId)
    }
    if (chatId === P2P_CHAT_FILTER_VALUE) {
      clauses.push("chat_type = 'p2p'")
    } else if (chatId) {
      clauses.push('chat_id = ?')
      params.push(chatId)
    }
    const sql = `SELECT timestamp_ms, record_kind, bot_id, chat_id, chat_type, session_id,
                        sender_id, sender_name, sender_type,
                        trigger, agent_preset, provider, model, outcome, error_code, latency_ms,
                        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                        reasoning_tokens, total_tokens, tool_calls, tool_errors
                 FROM telemetry_usage_events
                 WHERE ${clauses.join(' AND ')}
                 ORDER BY timestamp_ms ASC`
    return this.db.prepare(sql).all(...params) as unknown as RawUsageEventRow[]
  }

  private countManagedSessionsInRanges(
    fromMs: number,
    toMs: number,
    prevFromMs: number,
    botId: string,
    chatId: string,
    scopedSessions?: { readonly current: ReadonlySet<string>; readonly previous: ReadonlySet<string> },
  ): {
    readonly createdCurrent: number
    readonly createdPrevious: number
    readonly archivedCurrent: number
  } {
    const baseClauses: string[] = []
    const baseParams: Array<string | number> = []
    if (botId) {
      baseClauses.push('bot_id = ?')
      baseParams.push(botId)
    }
    if (chatId === P2P_CHAT_FILTER_VALUE) {
      baseClauses.push("trigger = 'p2p'")
    } else if (chatId) {
      baseClauses.push('chat_id = ?')
      baseParams.push(chatId)
    }
    const prefix = baseClauses.length > 0 ? `${baseClauses.join(' AND ')} AND ` : ''

    if (scopedSessions) {
      const countScoped = (
        ids: ReadonlySet<string>,
        column: 'created_at_ms' | 'archived_at_ms',
        startMs: number,
        endMs: number,
      ): number => {
        if (ids.size === 0) return 0
        const list = [...ids]
        let total = 0
        for (let i = 0; i < list.length; i += 400) {
          const chunk = list.slice(i, i + 400)
          const placeholders = chunk.map(() => '?').join(', ')
          const notNull = column === 'archived_at_ms' ? 'archived_at_ms IS NOT NULL AND ' : ''
          const row = this.db
            .prepare(
              `SELECT COUNT(*) AS cnt FROM managed_sessions
               WHERE ${prefix}${notNull}${column} >= ? AND ${column} < ? AND session_id IN (${placeholders})`,
            )
            .get(...baseParams, startMs, endMs, ...chunk) as { cnt?: number }
          total += Number(row?.cnt ?? 0)
        }
        return total
      }
      return {
        createdCurrent: countScoped(scopedSessions.current, 'created_at_ms', fromMs, toMs),
        createdPrevious: countScoped(scopedSessions.previous, 'created_at_ms', prevFromMs, fromMs),
        archivedCurrent: countScoped(scopedSessions.current, 'archived_at_ms', fromMs, toMs),
      }
    }

    const createdCurrentRow = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM managed_sessions WHERE ${prefix}created_at_ms >= ? AND created_at_ms < ?`,
      )
      .get(...baseParams, fromMs, toMs) as { cnt?: number }
    const createdPrevRow = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM managed_sessions WHERE ${prefix}created_at_ms >= ? AND created_at_ms < ?`,
      )
      .get(...baseParams, prevFromMs, fromMs) as { cnt?: number }
    const archivedRow = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM managed_sessions WHERE ${prefix}archived_at_ms IS NOT NULL AND archived_at_ms >= ? AND archived_at_ms < ?`,
      )
      .get(...baseParams, fromMs, toMs) as { cnt?: number }

    return {
      createdCurrent: Number(createdCurrentRow?.cnt ?? 0),
      createdPrevious: Number(createdPrevRow?.cnt ?? 0),
      archivedCurrent: Number(archivedRow?.cnt ?? 0),
    }
  }

  private buildTimeSeries(
    rows: readonly RawUsageEventRow[],
    fromMs: number,
    toMs: number,
    spec: WindowSpec,
  ): ObservabilitySeriesPoint[] {
    const buckets = Array.from({ length: spec.bucketCount }, (_, idx) => {
      const startMs = fromMs + idx * spec.bucketSpanMs
      const endMs = Math.min(toMs, startMs + spec.bucketSpanMs)
      return {
        startMs,
        endMs,
        totals: emptyWindowTotals(),
      }
    })

    for (const row of rows) {
      const idx = Math.floor((Number(row.timestamp_ms) - fromMs) / spec.bucketSpanMs)
      if (idx < 0 || idx >= buckets.length) continue
      accumulateRow(buckets[idx]!.totals, row)
    }

    return buckets.map((b) => {
      const { label, fullLabel } = formatBucketLabel(b.startMs, b.endMs, spec.window)
      const lat = calcPercentiles(b.totals.latencies)
      return {
        bucketStartMs: b.startMs,
        bucketEndMs: b.endMs,
        label,
        fullLabel,
        inbound: b.totals.inbound,
        replied: b.totals.replied,
        silentSkipped: b.totals.silentSkipped,
        errors: b.totals.errors,
        sessions: b.totals.sessions.size,
        llmSteps: b.totals.llmSteps,
        toolCalls: b.totals.toolCalls,
        inputTokens: b.totals.inputTokens,
        cacheReadTokens: b.totals.cacheReadTokens,
        cacheWriteTokens: b.totals.cacheWriteTokens,
        outputTokens: b.totals.outputTokens,
        reasoningTokens: b.totals.reasoningTokens,
        totalTokens: b.totals.totalTokens,
        latencyP50Ms: lat.p50Ms,
        latencyP95Ms: lat.p95Ms,
        avgLatencyMs: lat.avgMs,
      }
    })
  }

  private buildModelBreakdown(
    rows: readonly RawUsageEventRow[],
    grandTotalTokens: number,
  ): ObservabilityModelBreakdown[] {
    const map = new Map<
      string,
      {
        model: string
        providerWeights: Map<string, number>
        agentWeights: Map<string, number>
        steps: number
        inputTokens: number
        cacheReadTokens: number
        cacheWriteTokens: number
        outputTokens: number
        reasoningTokens: number
        totalTokens: number
      }
    >()

    for (const row of rows) {
      if (isToolErrorMarkerRow(row)) continue
      const tot = Number(row.total_tokens) || 0
      const isStep = row.record_kind === 'llm_step' || row.record_kind === 'triage'
      if (!isStep && tot === 0) continue
      const rawModel = row.model.trim()
      const key = rawModel ? rawModel.toLowerCase() : '__unattributed__'
      const cur = map.get(key) ?? {
        model: rawModel,
        providerWeights: new Map<string, number>(),
        agentWeights: new Map<string, number>(),
        steps: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
      }
      if (!cur.model && rawModel) {
        cur.model = rawModel
      }
      const weight = Math.max(1, tot)
      const provider = row.provider.trim()
      if (provider) {
        cur.providerWeights.set(provider, (cur.providerWeights.get(provider) ?? 0) + weight)
      }
      const agentKey = resolveEventAgentKey(row)
      if (agentKey) {
        cur.agentWeights.set(agentKey, (cur.agentWeights.get(agentKey) ?? 0) + weight)
      }
      if (isStep) cur.steps += 1
      cur.inputTokens += Number(row.input_tokens) || 0
      cur.cacheReadTokens += Number(row.cache_read_tokens) || 0
      cur.cacheWriteTokens += Number(row.cache_write_tokens) || 0
      cur.outputTokens += Number(row.output_tokens) || 0
      cur.reasoningTokens += Number(row.reasoning_tokens) || 0
      cur.totalTokens += tot
      map.set(key, cur)
    }

    return [...map.values()]
      .filter((m) => m.totalTokens > 0 || m.steps > 0)
      .sort((a, b) => b.totalTokens - a.totalTokens || b.steps - a.steps)
      .slice(0, 12)
      .map((m) => {
        const promptTotal = m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens
        const cacheHitRate =
          promptTotal > 0 ? Math.round((m.cacheReadTokens / promptTotal) * 1000) / 10 : 0
        const sharePct =
          grandTotalTokens > 0 ? Math.round((m.totalTokens / grandTotalTokens) * 1000) / 10 : 0
        const sortedAgents = [...m.agentWeights.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([k]) => k)
        const primaryRuntimePreset =
          sortedAgents.find((k) => k !== TRIAGE_AGENT_KEY && k !== UNATTRIBUTED_AGENT_KEY) ?? ''
        const primaryProvider =
          [...m.providerWeights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
        return {
          model: m.model,
          provider: primaryProvider,
          agentPreset: primaryRuntimePreset,
          agents: sortedAgents,
          steps: m.steps,
          inputTokens: m.inputTokens,
          cacheReadTokens: m.cacheReadTokens,
          cacheWriteTokens: m.cacheWriteTokens,
          outputTokens: m.outputTokens,
          reasoningTokens: m.reasoningTokens,
          totalTokens: m.totalTokens,
          cacheHitRate,
          sharePct,
        }
      })
  }

  private buildAgentBreakdown(
    rows: readonly RawUsageEventRow[],
    grandTotalTokens: number,
  ): ObservabilityAgentBreakdown[] {
    const map = new Map<
      string,
      {
        agentKey: string
        sessions: Set<string>
        steps: number
        inputTokens: number
        cacheReadTokens: number
        cacheWriteTokens: number
        outputTokens: number
        reasoningTokens: number
        totalTokens: number
        modelTokens: Map<string, { model: string; totalTokens: number }>
      }
    >()

    for (const row of rows) {
      if (isToolErrorMarkerRow(row)) continue
      const tot = Number(row.total_tokens) || 0
      const isStep = row.record_kind === 'llm_step' || row.record_kind === 'triage'
      if (!isStep && tot === 0) continue
      const agentKey = resolveEventAgentKey(row) || UNATTRIBUTED_AGENT_KEY
      const cur = map.get(agentKey) ?? {
        agentKey,
        sessions: new Set<string>(),
        steps: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        modelTokens: new Map<string, { model: string; totalTokens: number }>(),
      }
      if (row.session_id) cur.sessions.add(row.session_id)
      if (isStep) cur.steps += 1
      cur.inputTokens += Number(row.input_tokens) || 0
      cur.cacheReadTokens += Number(row.cache_read_tokens) || 0
      cur.cacheWriteTokens += Number(row.cache_write_tokens) || 0
      cur.outputTokens += Number(row.output_tokens) || 0
      cur.reasoningTokens += Number(row.reasoning_tokens) || 0
      cur.totalTokens += tot

      const rawModel = row.model.trim()
      if (rawModel && (tot > 0 || isStep)) {
        const mKey = rawModel.toLowerCase()
        const existing = cur.modelTokens.get(mKey)
        if (existing) {
          existing.totalTokens += tot
        } else {
          cur.modelTokens.set(mKey, { model: rawModel, totalTokens: tot })
        }
      }
      map.set(agentKey, cur)
    }

    return [...map.values()]
      .filter((a) => a.totalTokens > 0 || a.steps > 0)
      .sort((a, b) => b.totalTokens - a.totalTokens || b.steps - a.steps)
      .slice(0, 12)
      .map((a) => {
        const promptTotal = a.inputTokens + a.cacheReadTokens + a.cacheWriteTokens
        const cacheHitRate =
          promptTotal > 0 ? Math.round((a.cacheReadTokens / promptTotal) * 1000) / 10 : 0
        const sharePct =
          grandTotalTokens > 0 ? Math.round((a.totalTokens / grandTotalTokens) * 1000) / 10 : 0
        const kind: ObservabilityAgentBreakdown['kind'] =
          a.agentKey === TRIAGE_AGENT_KEY
            ? 'triage'
            : a.agentKey === UNATTRIBUTED_AGENT_KEY
              ? 'unknown'
              : 'runtime'
        const models = [...a.modelTokens.values()]
          .sort((x, y) => y.totalTokens - x.totalTokens)
          .slice(0, 6)
          .map((m) => ({
            model: m.model,
            totalTokens: m.totalTokens,
            sharePct:
              a.totalTokens > 0 ? Math.round((m.totalTokens / a.totalTokens) * 1000) / 10 : 0,
          }))
        return {
          agentKey: a.agentKey,
          agentPreset: kind === 'runtime' ? a.agentKey : '',
          kind,
          sessions: a.sessions.size,
          steps: a.steps,
          inputTokens: a.inputTokens,
          cacheReadTokens: a.cacheReadTokens,
          cacheWriteTokens: a.cacheWriteTokens,
          outputTokens: a.outputTokens,
          reasoningTokens: a.reasoningTokens,
          totalTokens: a.totalTokens,
          cacheHitRate,
          sharePct,
          models,
        }
      })
  }

  private buildTriggerBreakdown(rows: readonly RawUsageEventRow[]): ObservabilityTriggerBreakdown[] {
    const map = new Map<
      string,
      {
        count: number
        sessions: Set<string>
        replied: number
        errors: number
        totalTokens: number
      }
    >()
    let grandCount = 0
    let grandTokens = 0

    for (const row of rows) {
      const trigger =
        row.record_kind === 'triage'
          ? 'triage'
          : row.trigger.trim() || (row.chat_type === 'p2p' ? 'p2p' : 'mention')
      const cur = map.get(trigger) ?? {
        count: 0,
        sessions: new Set<string>(),
        replied: 0,
        errors: 0,
        totalTokens: 0,
      }
      const tok = Number(row.total_tokens) || 0
      cur.totalTokens += tok
      grandTokens += tok
      if (row.session_id) cur.sessions.add(row.session_id)
      if (row.record_kind === 'turn' || row.record_kind === 'proactive' || row.record_kind === 'triage') {
        cur.count += 1
        grandCount += 1
        if (row.outcome === 'replied' || row.outcome === 'quick_reply' || row.outcome === 'completed') {
          cur.replied += 1
        }
        if (row.outcome === 'error' || row.outcome === 'fallback') {
          cur.errors += 1
        }
      }
      map.set(trigger, cur)
    }

    return [...map.entries()]
      .filter(([, v]) => v.count > 0 || v.totalTokens > 0 || v.sessions.size > 0)
      .sort((a, b) => b[1].totalTokens - a[1].totalTokens || b[1].count - a[1].count)
      .map(([trigger, v]) => {
        const sharePct =
          grandTokens > 0
            ? Math.round((v.totalTokens / grandTokens) * 1000) / 10
            : grandCount > 0
              ? Math.round((v.count / grandCount) * 1000) / 10
              : 0
        return {
          trigger,
          count: v.count,
          sessions: v.sessions.size,
          replied: v.replied,
          errors: v.errors,
          totalTokens: v.totalTokens,
          sharePct,
        }
      })
  }

  private buildErrorBreakdown(rows: readonly RawUsageEventRow[]): ObservabilityErrorBreakdown[] {
    const map = new Map<string, { count: number; latestAtMs: number }>()
    let total = 0
    for (const row of rows) {
      const isErr =
        row.outcome === 'error' ||
        row.outcome === 'fallback' ||
        row.outcome === 'aborted' ||
        (Number(row.tool_errors) || 0) > 0
      if (!isErr) continue
      const code =
        row.error_code.trim() ||
        (row.outcome === 'fallback'
          ? 'triage_fallback'
          : row.outcome === 'aborted'
            ? 'turn_aborted'
            : Number(row.tool_errors) > 0
              ? 'tool_error'
              : 'turn_error')
      const weight =
        row.record_kind === 'llm_step' && Number(row.tool_errors) > 0
          ? Number(row.tool_errors)
          : 1
      const prev = map.get(code) ?? { count: 0, latestAtMs: 0 }
      prev.count += weight
      prev.latestAtMs = Math.max(prev.latestAtMs, Number(row.timestamp_ms))
      map.set(code, prev)
      total += weight
    }
    return [...map.entries()]
      .sort((a, b) => b[1].count - a[1].count || b[1].latestAtMs - a[1].latestAtMs)
      .slice(0, 10)
      .map(([code, v]) => ({
        code,
        count: v.count,
        sharePct: total > 0 ? Math.round((v.count / total) * 1000) / 10 : 0,
        latestAtMs: v.latestAtMs,
      }))
  }

  private buildHeatmap(rows: readonly RawUsageEventRow[]): {
    readonly maxCount: number
    readonly cells: readonly ObservabilityHeatmapCell[]
  } {
    const grid = new Map<string, { count: number; tokens: number }>()
    let maxCount = 0
    for (const row of rows) {
      if (row.record_kind === 'inbound' && row.outcome === 'ignored') continue
      const d = new Date(Number(row.timestamp_ms))
      const dow = (d.getDay() + 6) % 7 // Mon=0 .. Sun=6
      const hour = d.getHours()
      const key = `${dow}:${hour}`
      const cur = grid.get(key) ?? { count: 0, tokens: 0 }
      if (row.record_kind === 'inbound' || row.record_kind === 'turn' || row.record_kind === 'proactive') {
        cur.count += 1
      }
      cur.tokens += Number(row.total_tokens) || 0
      if (cur.count > maxCount) maxCount = cur.count
      grid.set(key, cur)
    }
    const cells: ObservabilityHeatmapCell[] = []
    for (let dow = 0; dow < 7; dow += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const entry = grid.get(`${dow}:${hour}`)
        cells.push({
          dayOfWeek: dow,
          hour,
          count: entry?.count ?? 0,
          tokens: entry?.tokens ?? 0,
        })
      }
    }
    return { maxCount, cells }
  }

  private buildBotStatsMap(rows: readonly RawUsageEventRow[]) {
    const map = new Map<
      string,
      {
        sessions: Set<string>
        inbound: number
        replied: number
        silentSkipped: number
        errors: number
        totalTokens: number
        inputTokens: number
        cacheReadTokens: number
        cacheWriteTokens: number
        outputTokens: number
        promptTokens: number
        modelTokens: Map<string, { model: string; agentPreset: string; totalTokens: number }>
        latencies: number[]
      }
    >()

    for (const row of rows) {
      if (!row.bot_id || row.bot_id === 'system') continue
      const cur = map.get(row.bot_id) ?? {
        sessions: new Set<string>(),
        inbound: 0,
        replied: 0,
        silentSkipped: 0,
        errors: 0,
        totalTokens: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        promptTokens: 0,
        modelTokens: new Map<string, { model: string; agentPreset: string; totalTokens: number }>(),
        latencies: [],
      }
      if (row.session_id) cur.sessions.add(row.session_id)
      const inTok = Number(row.input_tokens) || 0
      const crTok = Number(row.cache_read_tokens) || 0
      const cwTok = Number(row.cache_write_tokens) || 0
      const outTok = Number(row.output_tokens) || 0
      const totTok = Number(row.total_tokens) || 0
      cur.totalTokens += totTok
      cur.inputTokens += inTok
      cur.cacheReadTokens += crTok
      cur.cacheWriteTokens += cwTok
      cur.outputTokens += outTok
      cur.promptTokens += inTok + crTok + cwTok
      addTopModelToken(cur.modelTokens, row, totTok)

      if (row.record_kind === 'inbound' && row.outcome !== 'ignored') {
        cur.inbound += 1
      } else if (row.record_kind === 'turn' || row.record_kind === 'proactive') {
        if (row.outcome === 'replied' || row.outcome === 'quick_reply' || row.outcome === 'completed') {
          cur.replied += 1
          if (row.latency_ms !== null && Number(row.latency_ms) >= 0) {
            cur.latencies.push(Number(row.latency_ms))
          }
        } else if (row.outcome === 'silent_skip') {
          cur.silentSkipped += 1
        } else if (row.outcome === 'error') {
          cur.errors += 1
        }
      }
      map.set(row.bot_id, cur)
    }

    const out = new Map<
      string,
      {
        readonly sessions: number
        readonly inbound: number
        readonly replied: number
        readonly silentSkipped: number
        readonly errors: number
        readonly totalTokens: number
        readonly inputTokens: number
        readonly cacheReadTokens: number
        readonly cacheWriteTokens: number
        readonly outputTokens: number
        readonly promptTokens: number
        readonly topModels: readonly ObservabilityRankModelSummary[]
        readonly latencies: number[]
      }
    >()
    for (const [botId, v] of map.entries()) {
      out.set(botId, {
        sessions: v.sessions.size,
        inbound: v.inbound,
        replied: v.replied,
        silentSkipped: v.silentSkipped,
        errors: v.errors,
        totalTokens: v.totalTokens,
        inputTokens: v.inputTokens,
        cacheReadTokens: v.cacheReadTokens,
        cacheWriteTokens: v.cacheWriteTokens,
        outputTokens: v.outputTokens,
        promptTokens: v.promptTokens,
        topModels: finalizeTopModels(v.modelTokens),
        latencies: v.latencies,
      })
    }
    return out
  }

  private buildChatRanking(rows: readonly RawUsageEventRow[]): ObservabilityChatRow[] {
    const botsById = new Map(this.config.listBots().map((b) => [b.id, b]))
    const groupsByKey = new Map(this.config.listGroups().map((g) => [g.key, g]))
    const discovered = this.config.getDiscoveredChats()

    const map = new Map<
      string,
      {
        botId: string
        chatId: string
        chatType: 'group' | 'p2p' | 'internal'
        sessions: Set<string>
        inbound: number
        replied: number
        errors: number
        totalTokens: number
        inputTokens: number
        cacheReadTokens: number
        cacheWriteTokens: number
        outputTokens: number
        promptTokens: number
        modelTokens: Map<string, { model: string; agentPreset: string; totalTokens: number }>
        latencySum: number
        latencyCount: number
        lastActiveMs: number
      }
    >()

    for (const row of rows) {
      if (!row.chat_id || !row.bot_id || row.bot_id === 'system') continue
      const key = buildGroupKey(row.bot_id, row.chat_id)
      const inferredType: 'group' | 'p2p' | 'internal' =
        row.chat_type === 'p2p' || row.trigger === 'p2p'
          ? 'p2p'
          : row.chat_id.startsWith('dream:') || row.chat_type === 'internal'
            ? 'internal'
            : 'group'
      const cur = map.get(key) ?? {
        botId: row.bot_id,
        chatId: row.chat_id,
        chatType: inferredType,
        sessions: new Set<string>(),
        inbound: 0,
        replied: 0,
        errors: 0,
        totalTokens: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        promptTokens: 0,
        modelTokens: new Map<string, { model: string; agentPreset: string; totalTokens: number }>(),
        latencySum: 0,
        latencyCount: 0,
        lastActiveMs: 0,
      }
      if (row.session_id) cur.sessions.add(row.session_id)
      const inTok = Number(row.input_tokens) || 0
      const crTok = Number(row.cache_read_tokens) || 0
      const cwTok = Number(row.cache_write_tokens) || 0
      const outTok = Number(row.output_tokens) || 0
      const totTok = Number(row.total_tokens) || 0
      cur.totalTokens += totTok
      cur.inputTokens += inTok
      cur.cacheReadTokens += crTok
      cur.cacheWriteTokens += cwTok
      cur.outputTokens += outTok
      cur.promptTokens += inTok + crTok + cwTok
      addTopModelToken(cur.modelTokens, row, totTok)
      cur.lastActiveMs = Math.max(cur.lastActiveMs, Number(row.timestamp_ms))

      if (row.record_kind === 'inbound' && row.outcome !== 'ignored') {
        cur.inbound += 1
      } else if (row.record_kind === 'turn' || row.record_kind === 'proactive') {
        if (row.outcome === 'replied' || row.outcome === 'quick_reply' || row.outcome === 'completed') {
          cur.replied += 1
          if (row.latency_ms !== null && Number(row.latency_ms) >= 0) {
            cur.latencySum += Number(row.latency_ms)
            cur.latencyCount += 1
          }
        } else if (row.outcome === 'error') {
          cur.errors += 1
        }
      }
      map.set(key, cur)
    }

    return [...map.entries()]
      .filter(([, v]) => v.chatType !== 'internal')
      .sort(
        (a, b) =>
          b[1].totalTokens - a[1].totalTokens ||
          b[1].inbound - a[1].inbound ||
          b[1].lastActiveMs - a[1].lastActiveMs,
      )
      .slice(0, 16)
      .map(([key, v]) => {
        const bot = botsById.get(v.botId)
        const grp = groupsByKey.get(key)
        const disc = discovered.get(key)
        const resolvedName =
          v.chatType === 'p2p'
            ? `私聊 · ${v.chatId.slice(-6)}`
            : grp?.chatName ||
              disc?.name ||
              this.config.resolveChatName(v.botId, v.chatId) ||
              v.chatId
        const cacheHitRate =
          v.promptTokens > 0 ? Math.round((v.cacheReadTokens / v.promptTokens) * 1000) / 10 : 0
        return {
          key,
          botId: v.botId,
          botName: bot?.name ?? v.botId,
          chatId: v.chatId,
          chatName: resolvedName,
          chatType: v.chatType,
          sessions: v.sessions.size,
          activeBindings: 0,
          inbound: v.inbound,
          replied: v.replied,
          errors: v.errors,
          totalTokens: v.totalTokens,
          inputTokens: v.inputTokens,
          cacheReadTokens: v.cacheReadTokens,
          cacheWriteTokens: v.cacheWriteTokens,
          outputTokens: v.outputTokens,
          topModels: finalizeTopModels(v.modelTokens),
          cacheHitRate,
          avgLatencyMs: v.latencyCount > 0 ? Math.round(v.latencySum / v.latencyCount) : 0,
          lastActiveMs: v.lastActiveMs,
        }
      })
  }

  private buildChatFilterOptions(filterBotId: string): ObservabilityChatFilterOption[] {
    const byChatId = new Map<string, { name: string; bots: Set<string> }>()
    for (const grp of this.config.listGroups(filterBotId || undefined)) {
      const cur = byChatId.get(grp.chatId) ?? { name: grp.chatName || grp.chatId, bots: new Set() }
      if (grp.chatName && cur.name === grp.chatId) cur.name = grp.chatName
      cur.bots.add(grp.botId)
      byChatId.set(grp.chatId, cur)
    }
    for (const disc of this.config.getDiscoveredChats().values()) {
      if (filterBotId && disc.botId !== filterBotId) continue
      const cur = byChatId.get(disc.chatId) ?? { name: disc.name || disc.chatId, bots: new Set() }
      if (disc.name && cur.name === disc.chatId) cur.name = disc.name
      cur.bots.add(disc.botId)
      byChatId.set(disc.chatId, cur)
    }

    return [...byChatId.entries()]
      .map(([chatId, v]) => ({
        chatId,
        chatName: v.name,
        chatType: 'group' as const,
        botIds: [...v.bots],
      }))
      .sort((a, b) => a.chatName.localeCompare(b.chatName, 'zh-CN'))
  }

  private buildSenderRanking(
    rows: readonly RawUsageEventRow[],
    resolver: SenderIdentityResolver,
  ): ObservabilitySenderRow[] {
    const botsById = new Map(this.config.listBots().map((b) => [b.id, b]))
    const map = new Map<
      string,
      {
        senderId: string
        senderName: string
        senderType: 'user' | 'bot'
        avatarUrl: string
        sessions: Set<string>
        chats: Set<string>
        inbound: number
        replied: number
        silentSkipped: number
        errors: number
        llmSteps: number
        totalTokens: number
        inputTokens: number
        cacheReadTokens: number
        cacheWriteTokens: number
        outputTokens: number
        promptTokens: number
        modelTokens: Map<string, { model: string; agentPreset: string; totalTokens: number }>
        botTokens: Map<string, { botId: string; botName: string; totalTokens: number }>
        latencySum: number
        latencyCount: number
        lastActiveMs: number
      }
    >()

    for (const row of rows) {
      const resolved = resolver.resolve(row)
      if (!resolved) continue
      const cur = map.get(resolved.senderId) ?? {
        senderId: resolved.senderId,
        senderName: resolved.senderName,
        senderType: resolved.senderType,
        avatarUrl: resolved.avatarUrl,
        sessions: new Set<string>(),
        chats: new Set<string>(),
        inbound: 0,
        replied: 0,
        silentSkipped: 0,
        errors: 0,
        llmSteps: 0,
        totalTokens: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        promptTokens: 0,
        modelTokens: new Map(),
        botTokens: new Map(),
        latencySum: 0,
        latencyCount: 0,
        lastActiveMs: 0,
      }
      if (!cur.avatarUrl && resolved.avatarUrl) cur.avatarUrl = resolved.avatarUrl
      if (resolved.senderType === 'bot') cur.senderType = 'bot'
      if (isReadableSenderName(resolved.senderName, cur.senderId) && !isReadableSenderName(cur.senderName, cur.senderId)) {
        cur.senderName = resolved.senderName
      }
      if (row.session_id) cur.sessions.add(row.session_id)
      if (row.chat_id && row.chat_type !== 'internal') cur.chats.add(row.chat_id)
      const inTok = Number(row.input_tokens) || 0
      const crTok = Number(row.cache_read_tokens) || 0
      const cwTok = Number(row.cache_write_tokens) || 0
      const outTok = Number(row.output_tokens) || 0
      const totTok = Number(row.total_tokens) || 0
      cur.totalTokens += totTok
      cur.inputTokens += inTok
      cur.cacheReadTokens += crTok
      cur.cacheWriteTokens += cwTok
      cur.outputTokens += outTok
      cur.promptTokens += inTok + crTok + cwTok
      addTopModelToken(cur.modelTokens, row, totTok)
      if (row.bot_id && row.bot_id !== 'system' && totTok > 0) {
        const botName = botsById.get(row.bot_id)?.name ?? row.bot_id
        const prevBot = cur.botTokens.get(row.bot_id)
        if (prevBot) {
          prevBot.totalTokens += totTok
        } else {
          cur.botTokens.set(row.bot_id, { botId: row.bot_id, botName, totalTokens: totTok })
        }
      }
      cur.lastActiveMs = Math.max(cur.lastActiveMs, Number(row.timestamp_ms))

      if (row.record_kind === 'llm_step' && !isToolErrorMarkerRow(row)) {
        cur.llmSteps += 1
      } else if (row.record_kind === 'inbound' && row.outcome !== 'ignored') {
        cur.inbound += 1
      } else if (row.record_kind === 'turn' || row.record_kind === 'proactive') {
        if (row.outcome === 'replied' || row.outcome === 'quick_reply' || row.outcome === 'completed') {
          cur.replied += 1
          if (row.latency_ms !== null && Number(row.latency_ms) >= 0) {
            cur.latencySum += Number(row.latency_ms)
            cur.latencyCount += 1
          }
        } else if (row.outcome === 'silent_skip') {
          cur.silentSkipped += 1
        } else if (row.outcome === 'error') {
          cur.errors += 1
        }
      }
      map.set(resolved.senderId, cur)
    }

    return [...map.values()]
      .filter((v) => v.totalTokens > 0 || v.inbound > 0 || v.replied > 0 || v.sessions.size > 0)
      .sort(
        (a, b) =>
          b.totalTokens - a.totalTokens ||
          b.inbound - a.inbound ||
          b.replied - a.replied ||
          b.lastActiveMs - a.lastActiveMs,
      )
      .slice(0, 50)
      .map((v) => {
        const cacheHitRate =
          v.promptTokens > 0 ? Math.round((v.cacheReadTokens / v.promptTokens) * 1000) / 10 : 0
        const topBots: ObservabilitySenderBotSummary[] = [...v.botTokens.values()]
          .sort((a, b) => b.totalTokens - a.totalTokens)
          .slice(0, 4)
        return {
          senderId: v.senderId,
          senderName: v.senderName,
          senderType: v.senderType,
          ...(v.avatarUrl ? { avatarUrl: v.avatarUrl } : {}),
          sessions: v.sessions.size,
          activeChats: v.chats.size,
          inbound: v.inbound,
          replied: v.replied,
          silentSkipped: v.silentSkipped,
          errors: v.errors,
          llmSteps: v.llmSteps,
          totalTokens: v.totalTokens,
          inputTokens: v.inputTokens,
          cacheReadTokens: v.cacheReadTokens,
          cacheWriteTokens: v.cacheWriteTokens,
          outputTokens: v.outputTokens,
          topModels: finalizeTopModels(v.modelTokens),
          topBots,
          cacheHitRate,
          avgLatencyMs: v.latencyCount > 0 ? Math.round(v.latencySum / v.latencyCount) : 0,
          lastActiveMs: v.lastActiveMs,
        }
      })
  }

  private buildSenderFilterOptions(
    currentRows: readonly RawUsageEventRow[],
    previousRows: readonly RawUsageEventRow[],
    resolver: SenderIdentityResolver,
    activeSenderId: string,
  ): ObservabilitySenderFilterOption[] {
    const byId = new Map<
      string,
      {
        senderId: string
        senderName: string
        senderType: 'user' | 'bot'
        avatarUrl: string
        botIds: Set<string>
        totalTokens: number
        activity: number
      }
    >()

    for (const row of currentRows) {
      const resolved = resolver.resolve(row)
      if (!resolved) continue
      const cur = byId.get(resolved.senderId) ?? {
        senderId: resolved.senderId,
        senderName: resolved.senderName,
        senderType: resolved.senderType,
        avatarUrl: resolved.avatarUrl,
        botIds: new Set<string>(),
        totalTokens: 0,
        activity: 0,
      }
      if (!cur.avatarUrl && resolved.avatarUrl) cur.avatarUrl = resolved.avatarUrl
      if (resolved.senderType === 'bot') cur.senderType = 'bot'
      if (
        resolved.hasReadableName &&
        !isReadableSenderName(cur.senderName, cur.senderId)
      ) {
        cur.senderName = resolved.senderName
      }
      if (row.bot_id && row.bot_id !== 'system') cur.botIds.add(row.bot_id)
      cur.totalTokens += Number(row.total_tokens) || 0
      if (row.record_kind === 'inbound' || row.record_kind === 'turn' || row.record_kind === 'triage') {
        cur.activity += 1
      }
      byId.set(resolved.senderId, cur)
    }

    if (activeSenderId && !byId.has(activeSenderId)) {
      let fallback: ResolvedSenderIdentity | null = null
      const bots = new Set<string>()
      for (const row of previousRows) {
        const resolved = resolver.resolve(row)
        if (resolved?.senderId === activeSenderId) {
          fallback = resolved
          if (row.bot_id && row.bot_id !== 'system') bots.add(row.bot_id)
        }
      }
      fallback ??= resolver.resolveKnownById(activeSenderId)
      if (fallback) {
        byId.set(fallback.senderId, {
          senderId: fallback.senderId,
          senderName: fallback.senderName,
          senderType: fallback.senderType,
          avatarUrl: fallback.avatarUrl,
          botIds: bots,
          totalTokens: 0,
          activity: 0,
        })
      }
    }

    return [...byId.values()]
      .sort(
        (a, b) =>
          b.totalTokens - a.totalTokens ||
          b.activity - a.activity ||
          a.senderName.localeCompare(b.senderName, 'zh-CN'),
      )
      .slice(0, 60)
      .map((item) => ({
        senderId: item.senderId,
        senderName: item.senderName,
        senderType: item.senderType,
        ...(item.avatarUrl ? { avatarUrl: item.avatarUrl } : {}),
        botIds: [...item.botIds],
      }))
  }
}
