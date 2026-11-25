import { randomBytes } from 'node:crypto'
import {
  LarkMemoryConfidenceSchema,
  LarkMemoryScopeSchema,
  LarkMemoryStatusSchema,
  LarkMemoryTypeSchema,
  MEMORY_MAX_CONTENT_CHARS,
  MEMORY_MAX_TITLE_CHARS,
  normalizeMemoryScopeId,
  normalizeMemoryTags,
  normalizeMemoryTitleKey,
  type LarkMemoryConfidence,
  type LarkMemoryEntry,
  type LarkMemoryScope,
  type LarkMemoryStatus,
  type LarkMemoryType,
} from '@dsh-lark/lark-core'
import type { BridgeDatabase } from './database.js'

interface MemoryRow {
  id: string
  bot_id: string
  scope: string
  scope_id: string
  type: string
  title: string
  title_key: string
  content: string
  tags_json: string
  confidence: string
  pinned: number
  status: string
  source_session_id: string | null
  superseded_by: string | null
  superseded_at_ms: number | null
  supersede_reason: string | null
  created_at_ms: number
  updated_at_ms: number
  last_verified_ms: number
  last_recalled_ms: number | null
  recall_count: number
}

export interface MemoryQueryOptions {
  readonly botId?: string
  readonly scope?: LarkMemoryScope
  readonly scopeId?: string
  readonly type?: LarkMemoryType
  readonly status?: LarkMemoryStatus | 'all'
  readonly query?: string
  readonly limit?: number
}

export interface MemoryUpsertInput {
  readonly id?: string
  readonly botId: string
  readonly scope?: LarkMemoryScope
  readonly scopeId?: string
  readonly type: LarkMemoryType
  readonly title: string
  readonly content: string
  readonly tags?: readonly string[]
  readonly confidence?: LarkMemoryConfidence
  readonly pinned?: boolean
  readonly sourceSessionId?: string
  readonly supersedesId?: string
  readonly supersedeReason?: string
}

export interface MemoryUpdateInput {
  readonly scope?: LarkMemoryScope
  readonly scopeId?: string
  readonly type?: LarkMemoryType
  readonly title?: string
  readonly content?: string
  readonly tags?: readonly string[]
  readonly confidence?: LarkMemoryConfidence
  readonly pinned?: boolean
  readonly status?: LarkMemoryStatus
  readonly verified?: boolean
}

export interface MemoryUpsertOutcome {
  readonly action: 'created' | 'updated'
  readonly entry: LarkMemoryEntry
  readonly supersededEntry?: LarkMemoryEntry
}

export interface MemorySupersedeOutcome {
  readonly oldEntry: LarkMemoryEntry
  readonly replacementEntry?: LarkMemoryEntry
}

function generateMemoryId(): string {
  return `mem-${randomBytes(5).toString('hex')}`
}

function sanitizeTitle(raw: string): string {
  const clean = raw.replace(/\s+/g, ' ').trim()
  if (!clean) throw new Error('记忆标题不能为空')
  return clean.slice(0, MEMORY_MAX_TITLE_CHARS)
}

function sanitizeContent(raw: string): string {
  const clean = raw.trim()
  if (!clean) throw new Error('记忆内容不能为空')
  return clean.slice(0, MEMORY_MAX_CONTENT_CHARS)
}

function parseTagsJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function buildFtsMatchQuery(raw: string): string | undefined {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter((t) => t.length >= 3)
  if (tokens.length === 0) return undefined
  return tokens.map((t) => `"${t}"`).join(' AND ')
}

function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

export class MemoryRepo {
  constructor(private readonly db: BridgeDatabase) {}

  get(id: string): LarkMemoryEntry | undefined {
    const row = this.db
      .prepare('SELECT * FROM memory_entries WHERE id = ?')
      .get(id.trim()) as unknown as MemoryRow | undefined
    return row ? this.hydrate(row) : undefined
  }

  countActiveByBot(): Map<string, number> {
    const rows = this.db
      .prepare("SELECT bot_id, COUNT(*) AS cnt FROM memory_entries WHERE status = 'active' GROUP BY bot_id")
      .all() as Array<{ bot_id: string; cnt: number }>
    const map = new Map<string, number>()
    for (const r of rows) {
      map.set(String(r.bot_id), Number(r.cnt ?? 0))
    }
    return map
  }

  countActiveForBot(botId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM memory_entries WHERE bot_id = ? AND status = 'active'")
      .get(botId) as { cnt?: number } | undefined
    return Number(row?.cnt ?? 0)
  }

  list(options: MemoryQueryOptions = {}): LarkMemoryEntry[] {
    const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 100)))
    const query = options.query?.trim() ?? ''
    if (query) {
      return this.search(query, { ...options, limit })
    }

    const where: string[] = []
    const params: Array<string | number> = []
    this.appendFilterClauses(where, params, options)

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_entries
         ${whereSql}
         ORDER BY pinned DESC, last_verified_ms DESC, updated_at_ms DESC
         LIMIT ?`,
      )
      .all(...params, limit) as unknown as MemoryRow[]
    return rows.map((r) => this.hydrate(r))
  }

  search(rawQuery: string, options: MemoryQueryOptions = {}): LarkMemoryEntry[] {
    const query = rawQuery.trim()
    if (!query) return this.list(options)

    const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 20)))
    const ftsQuery = buildFtsMatchQuery(query)
    if (ftsQuery) {
      try {
        const where: string[] = ['memory_entries_fts MATCH ?']
        const params: Array<string | number> = [ftsQuery]
        this.appendFilterClauses(where, params, options, 'm.')
        const rows = this.db
          .prepare(
            `SELECT m.* FROM memory_entries m
             JOIN memory_entries_fts f ON f.entry_id = m.id
             WHERE ${where.join(' AND ')}
             ORDER BY m.pinned DESC, bm25(memory_entries_fts), m.last_verified_ms DESC
             LIMIT ?`,
          )
          .all(...params, limit) as unknown as MemoryRow[]
        if (rows.length > 0) {
          return rows.map((r) => this.hydrate(r))
        }
      } catch {
        // Gracefully fall back to LIKE matching if FTS syntax cannot parse unusual input.
      }
    }

    const likeTokens = query
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 6)
    const where: string[] = []
    const params: Array<string | number> = []
    this.appendFilterClauses(where, params, options)
    for (const token of likeTokens) {
      const pattern = `%${escapeLikePattern(token.toLowerCase())}%`
      where.push(
        "(LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(content) LIKE ? ESCAPE '\\' OR LOWER(tags_json) LIKE ? ESCAPE '\\')",
      )
      params.push(pattern, pattern, pattern)
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM memory_entries
         WHERE ${where.join(' AND ')}
         ORDER BY pinned DESC, last_verified_ms DESC, updated_at_ms DESC
         LIMIT ?`,
      )
      .all(...params, limit) as unknown as MemoryRow[]
    return rows.map((r) => this.hydrate(r))
  }

  upsert(input: MemoryUpsertInput, nowMs = Date.now()): MemoryUpsertOutcome {
    const botId = input.botId.trim()
    if (!botId) throw new Error('botId 不能为空')
    const scope = LarkMemoryScopeSchema.parse(input.scope ?? 'bot')
    const scopeId = normalizeMemoryScopeId(scope, input.scopeId)
    if (scope !== 'bot' && !scopeId) {
      throw new Error(`scope="${scope}" 必须提供有效的 scopeId`)
    }
    const type = LarkMemoryTypeSchema.parse(input.type)
    const title = sanitizeTitle(input.title)
    const titleKey = normalizeMemoryTitleKey(title)
    const content = sanitizeContent(input.content)
    const tags = normalizeMemoryTags(input.tags)
    const confidence = LarkMemoryConfidenceSchema.parse(input.confidence ?? 'high')

    return this.db.transaction(() => {
      const explicitExisting = input.id ? this.get(input.id) : undefined
      if (explicitExisting && explicitExisting.botId !== botId) {
        throw new Error(`记忆条目 "${explicitExisting.id}" 属于其他智能体，禁止跨智能体修改`)
      }
      const sameTitleRow =
        !explicitExisting && !input.supersedesId
          ? (this.db
              .prepare(
                `SELECT * FROM memory_entries
                 WHERE bot_id = ? AND scope = ? AND scope_id = ? AND title_key = ? AND status = 'active'
                 LIMIT 1`,
              )
              .get(botId, scope, scopeId, titleKey) as unknown as MemoryRow | undefined)
          : undefined
      const existing = explicitExisting ?? (sameTitleRow ? this.hydrate(sameTitleRow) : undefined)

      if (existing) {
        const pinned = input.pinned !== undefined ? input.pinned : existing.pinned
        const mergedTags = input.tags !== undefined ? tags : existing.tags
        const sourceSessionId = input.sourceSessionId?.trim() || existing.sourceSessionId
        this.db
          .prepare(
            `UPDATE memory_entries
             SET scope = ?, scope_id = ?, type = ?, title = ?, title_key = ?, content = ?,
                 tags_json = ?, confidence = ?, pinned = ?, status = 'active',
                 source_session_id = ?, updated_at_ms = ?, last_verified_ms = ?
             WHERE id = ?`,
          )
          .run(
            scope,
            scopeId,
            type,
            title,
            titleKey,
            content,
            JSON.stringify(mergedTags),
            confidence,
            pinned ? 1 : 0,
            sourceSessionId ?? null,
            nowMs,
            nowMs,
            existing.id,
          )
        const updated = this.get(existing.id)!
        this.syncFts(updated)
        const supersededEntry = this.applySupersedeTarget(
          botId,
          updated.id,
          input.supersedesId,
          input.supersedeReason,
          nowMs,
        )
        return {
          action: 'updated',
          entry: updated,
          ...(supersededEntry ? { supersededEntry } : {}),
        }
      }

      const id = input.id?.trim() || generateMemoryId()
      const pinned = Boolean(input.pinned)
      const sourceSessionId = input.sourceSessionId?.trim() || undefined
      this.db
        .prepare(
          `INSERT INTO memory_entries (
             id, bot_id, scope, scope_id, type, title, title_key, content, tags_json,
             confidence, pinned, status, source_session_id, created_at_ms, updated_at_ms,
             last_verified_ms, recall_count
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 0)`,
        )
        .run(
          id,
          botId,
          scope,
          scopeId,
          type,
          title,
          titleKey,
          content,
          JSON.stringify(tags),
          confidence,
          pinned ? 1 : 0,
          sourceSessionId ?? null,
          nowMs,
          nowMs,
          nowMs,
        )
      const created = this.get(id)!
      this.syncFts(created)

      const supersededEntry = this.applySupersedeTarget(
        botId,
        created.id,
        input.supersedesId,
        input.supersedeReason,
        nowMs,
      )

      return {
        action: 'created',
        entry: created,
        ...(supersededEntry ? { supersededEntry } : {}),
      }
    })
  }

  update(id: string, patch: MemoryUpdateInput, nowMs = Date.now()): LarkMemoryEntry | undefined {
    return this.db.transaction(() => {
      const existing = this.get(id)
      if (!existing) return undefined

      const nextScope = patch.scope ? LarkMemoryScopeSchema.parse(patch.scope) : existing.scope
      const nextScopeId =
        patch.scope !== undefined || patch.scopeId !== undefined
          ? normalizeMemoryScopeId(nextScope, patch.scopeId ?? existing.scopeId)
          : existing.scopeId
      if (nextScope !== 'bot' && !nextScopeId) {
        throw new Error(`scope="${nextScope}" 必须提供有效的 scopeId`)
      }
      const nextType = patch.type ? LarkMemoryTypeSchema.parse(patch.type) : existing.type
      const nextTitle = patch.title !== undefined ? sanitizeTitle(patch.title) : existing.title
      const nextTitleKey = normalizeMemoryTitleKey(nextTitle)
      const nextContent =
        patch.content !== undefined ? sanitizeContent(patch.content) : existing.content
      const nextTags = patch.tags !== undefined ? normalizeMemoryTags(patch.tags) : existing.tags
      const nextConfidence = patch.confidence
        ? LarkMemoryConfidenceSchema.parse(patch.confidence)
        : existing.confidence
      const nextPinned = patch.pinned !== undefined ? patch.pinned : existing.pinned
      const nextStatus = patch.status ? LarkMemoryStatusSchema.parse(patch.status) : existing.status
      const nextVerifiedMs =
        patch.verified === false ? existing.lastVerifiedAtMs : nowMs

      this.db
        .prepare(
          `UPDATE memory_entries
           SET scope = ?, scope_id = ?, type = ?, title = ?, title_key = ?, content = ?,
               tags_json = ?, confidence = ?, pinned = ?, status = ?,
               updated_at_ms = ?, last_verified_ms = ?
           WHERE id = ?`,
        )
        .run(
          nextScope,
          nextScopeId,
          nextType,
          nextTitle,
          nextTitleKey,
          nextContent,
          JSON.stringify(nextTags),
          nextConfidence,
          nextPinned ? 1 : 0,
          nextStatus,
          nowMs,
          nextVerifiedMs,
          existing.id,
        )
      const updated = this.get(existing.id)!
      this.syncFts(updated)
      return updated
    })
  }

  supersede(
    oldId: string,
    input: {
      readonly reason: string
      readonly replacement?: Omit<MemoryUpsertInput, 'botId' | 'supersedesId' | 'supersedeReason'>
    },
    nowMs = Date.now(),
  ): MemorySupersedeOutcome | undefined {
    const reason = input.reason.trim()
    if (!reason) throw new Error('纠偏或替代原因 reason 不能为空')

    return this.db.transaction(() => {
      const existing = this.get(oldId)
      if (!existing) return undefined

      let replacementEntry: LarkMemoryEntry | undefined
      if (input.replacement) {
        const upserted = this.upsert(
          {
            ...input.replacement,
            botId: existing.botId,
            scope: input.replacement.scope ?? existing.scope,
            scopeId:
              input.replacement.scope === 'bot'
                ? ''
                : input.replacement.scopeId ?? existing.scopeId,
            supersedesId: existing.id,
            supersedeReason: reason,
          },
          nowMs,
        )
        replacementEntry = upserted.entry
        return {
          oldEntry: this.get(existing.id)!,
          replacementEntry,
        }
      }

      this.db
        .prepare(
          `UPDATE memory_entries
           SET status = 'superseded', superseded_at_ms = ?, supersede_reason = ?, updated_at_ms = ?
           WHERE id = ?`,
        )
        .run(nowMs, reason, nowMs, existing.id)
      const oldEntry = this.get(existing.id)!
      this.syncFts(oldEntry)
      return { oldEntry }
    })
  }

  archive(id: string, reason?: string, nowMs = Date.now()): LarkMemoryEntry | undefined {
    return this.db.transaction(() => {
      const existing = this.get(id)
      if (!existing) return undefined
      const note = reason?.trim() || existing.supersedeReason || null
      this.db
        .prepare(
          `UPDATE memory_entries
           SET status = 'archived', supersede_reason = ?, updated_at_ms = ?
           WHERE id = ?`,
        )
        .run(note, nowMs, existing.id)
      const archived = this.get(existing.id)!
      this.syncFts(archived)
      return archived
    })
  }

  deleteHard(id: string): LarkMemoryEntry | undefined {
    return this.db.transaction(() => {
      const existing = this.get(id)
      if (!existing) return undefined
      this.db.prepare('DELETE FROM memory_entries WHERE id = ?').run(existing.id)
      this.db.prepare('DELETE FROM memory_entries_fts WHERE entry_id = ?').run(existing.id)
      return existing
    })
  }

  recordRecalls(ids: readonly string[], nowMs = Date.now()): void {
    if (ids.length === 0) return
    this.db.transaction(() => {
      const stmt = this.db.prepare(
        'UPDATE memory_entries SET recall_count = recall_count + 1, last_recalled_ms = ? WHERE id = ?',
      )
      for (const id of ids) {
        stmt.run(nowMs, id)
      }
    })
  }

  private applySupersedeTarget(
    botId: string,
    replacementId: string,
    rawSupersedesId: string | undefined,
    rawReason: string | undefined,
    nowMs: number,
  ): LarkMemoryEntry | undefined {
    const targetId = rawSupersedesId?.trim()
    if (!targetId) return undefined
    const old = this.get(targetId)
    if (!old || old.botId !== botId || old.id === replacementId) return undefined
    this.db
      .prepare(
        `UPDATE memory_entries
         SET status = 'superseded', superseded_by = ?, superseded_at_ms = ?,
             supersede_reason = ?, updated_at_ms = ?
         WHERE id = ?`,
      )
      .run(replacementId, nowMs, rawReason?.trim() || '已被新结论替代', nowMs, old.id)
    const superseded = this.get(old.id)
    if (superseded) this.syncFts(superseded)
    return superseded
  }

  private appendFilterClauses(
    where: string[],
    params: Array<string | number>,
    options: MemoryQueryOptions,
    prefix = '',
  ): void {
    if (options.botId?.trim()) {
      where.push(`${prefix}bot_id = ?`)
      params.push(options.botId.trim())
    }
    if (options.scope) {
      where.push(`${prefix}scope = ?`)
      params.push(options.scope)
    }
    if (options.scopeId !== undefined && options.scopeId.trim() !== '') {
      const normalized = options.scope
        ? normalizeMemoryScopeId(options.scope, options.scopeId)
        : options.scopeId.trim()
      where.push(`${prefix}scope_id = ?`)
      params.push(normalized)
    }
    if (options.type) {
      where.push(`${prefix}type = ?`)
      params.push(options.type)
    }
    if (options.status && options.status !== 'all') {
      where.push(`${prefix}status = ?`)
      params.push(options.status)
    } else if (!options.status) {
      where.push(`${prefix}status = 'active'`)
    }
  }

  private syncFts(entry: LarkMemoryEntry): void {
    this.db.prepare('DELETE FROM memory_entries_fts WHERE entry_id = ?').run(entry.id)
    this.db
      .prepare(
        'INSERT INTO memory_entries_fts (entry_id, bot_id, title, content, tags) VALUES (?, ?, ?, ?, ?)',
      )
      .run(entry.id, entry.botId, entry.title, entry.content, entry.tags.join(' '))
  }

  private hydrate(row: MemoryRow): LarkMemoryEntry {
    return {
      id: String(row.id),
      botId: String(row.bot_id),
      scope: LarkMemoryScopeSchema.parse(row.scope),
      scopeId: String(row.scope_id ?? ''),
      type: LarkMemoryTypeSchema.parse(row.type),
      title: String(row.title),
      content: String(row.content),
      tags: parseTagsJson(row.tags_json),
      confidence: LarkMemoryConfidenceSchema.parse(row.confidence),
      pinned: Boolean(row.pinned),
      status: LarkMemoryStatusSchema.parse(row.status),
      ...(row.source_session_id ? { sourceSessionId: String(row.source_session_id) } : {}),
      ...(row.superseded_by ? { supersededBy: String(row.superseded_by) } : {}),
      ...(typeof row.superseded_at_ms === 'number'
        ? { supersededAtMs: Number(row.superseded_at_ms) }
        : {}),
      ...(row.supersede_reason ? { supersedeReason: String(row.supersede_reason) } : {}),
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms),
      lastVerifiedAtMs: Number(row.last_verified_ms),
      ...(typeof row.last_recalled_ms === 'number'
        ? { lastRecalledAtMs: Number(row.last_recalled_ms) }
        : {}),
      recallCount: Number(row.recall_count ?? 0),
    }
  }
}
