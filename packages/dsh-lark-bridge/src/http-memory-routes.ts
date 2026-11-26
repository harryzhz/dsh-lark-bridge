import {
  LarkMemoryConfidenceSchema,
  LarkMemoryScopeSchema,
  LarkMemoryStatusSchema,
  LarkMemoryTypeSchema,
  type LarkMemoryConfidence,
  type LarkMemoryScope,
  type LarkMemoryStatus,
  type LarkMemoryType,
} from '@dsh-lark/lark-core'
import {
  SessionIdentityError,
  type LarkBridgeManager,
  type ResolvedCliSessionIdentity,
} from './bridge-manager.js'
import type { LarkApiResponse } from './http-api.js'

function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {}
}

function parseOptionalEnum<T extends string>(
  raw: unknown,
  parse: (v: unknown) => T,
): T | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  return parse(raw.trim())
}

function parseTagsInput(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === 'string')
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return undefined
}

function resolveMemorySessionIdentity(
  manager: LarkBridgeManager,
  rawSessionId?: string,
  externalSessionId?: string,
): ResolvedCliSessionIdentity {
  if (typeof manager.resolveCliSessionIdentity === 'function') {
    return manager.resolveCliSessionIdentity(rawSessionId, externalSessionId)
  }
  const trimmed = rawSessionId?.trim() || undefined
  const extTrimmed = externalSessionId?.trim() || undefined
  const provided = Boolean(trimmed || extTrimmed)
  if (!provided) return { provided: false, unresolved: false }
  const effectiveRaw = trimmed ?? `ext:${extTrimmed!}`
  const canonical =
    typeof manager.resolveCliSessionId === 'function'
      ? manager.resolveCliSessionId(effectiveRaw)
      : trimmed && !trimmed.startsWith('ext:')
        ? trimmed
        : undefined
  return {
    ...(canonical ? { canonicalSessionId: canonical } : {}),
    provided: true,
    unresolved: !canonical,
    rawSessionId: effectiveRaw,
    ...(extTrimmed ? { externalSessionId: extTrimmed } : {}),
  }
}

function resolveSessionContextHints(
  manager: LarkBridgeManager,
  sessionId?: string,
  externalSessionId?: string,
): { readonly bound: boolean; readonly botId?: string; readonly chatId?: string; readonly workingDir?: string } {
  const cleanSid = sessionId?.trim()
  const cleanExt = externalSessionId?.trim()
  if (!cleanSid && !cleanExt) return { bound: false }
  const resolved = manager.resolveAgentContext(cleanSid, cleanExt) as {
    bound?: boolean
    botId?: string
    chatId?: string
    workingDir?: string
  }
  return {
    bound: resolved.bound === true || (resolved.bound === undefined && Boolean(resolved.botId)),
    ...(resolved.botId ? { botId: resolved.botId } : {}),
    ...(resolved.chatId ? { chatId: resolved.chatId } : {}),
    ...(resolved.workingDir ? { workingDir: resolved.workingDir } : {}),
  }
}

function resolveEffectiveScopeId(
  scope: LarkMemoryScope,
  explicitScopeId: string | undefined,
  hints: { readonly chatId?: string; readonly workingDir?: string },
): string | undefined {
  if (scope === 'bot') return ''
  if (explicitScopeId?.trim()) return explicitScopeId.trim()
  if (scope === 'chat') return hints.chatId
  if (scope === 'workspace') return hints.workingDir
  return undefined
}

/**
 * Handles `/api/lark-bridge/memory/*` for both Owner Web/Desktop UI and CLI Bearer callers.
 * Enforces owner-only restriction for physical deletion (`?hard=1`); CLI callers can only
 * soft-archive (`forget`) and operate on valid configured bots.
 */
export async function dispatchMemoryApiRequest(
  manager: LarkBridgeManager,
  input: {
    readonly method: string
    readonly segments: readonly string[]
    readonly url: URL
    readonly body: unknown
    readonly externalSessionId?: string
    readonly isCliAuthenticated: boolean
    readonly isOperatorAuthenticated?: boolean
    readonly principalKind: string
  },
): Promise<LarkApiResponse | undefined> {
  const {
    method,
    segments,
    url,
    externalSessionId,
    isCliAuthenticated,
    isOperatorAuthenticated,
    principalKind,
  } = input
  if (segments[0] !== 'memory') return undefined

  const memory = manager.memory
  const memoryId = segments[1]
  const action = segments[2]

  if (method === 'GET' && segments.length === 1) {
    const rawSessionId = url.searchParams.get('sessionId')?.trim() || undefined
    const identity = resolveMemorySessionIdentity(manager, rawSessionId, externalSessionId)
    const explicitBotId = url.searchParams.get('botId')?.trim() || undefined
    const hints = identity.provided
      ? resolveSessionContextHints(manager, rawSessionId, externalSessionId)
      : { bound: false }
    if (identity.provided && !hints.bound && !explicitBotId) {
      throw new SessionIdentityError(
        'unresolved_session_context',
        `无法解析当前会话上下文（${identity.rawSessionId}），已拒绝回退到默认智能体读取记忆；请显式指定 --bot`,
        400,
      )
    }
    const botId = explicitBotId || hints.botId
    const scope = parseOptionalEnum(url.searchParams.get('scope'), (v) =>
      LarkMemoryScopeSchema.parse(v),
    )
    const rawScopeId = url.searchParams.get('scopeId')?.trim() || undefined
    const scopeId = scope ? resolveEffectiveScopeId(scope, rawScopeId, hints) : rawScopeId
    const type = parseOptionalEnum(url.searchParams.get('type'), (v) =>
      LarkMemoryTypeSchema.parse(v),
    )
    const rawStatus = url.searchParams.get('status')?.trim()
    const status: LarkMemoryStatus | 'all' | undefined =
      rawStatus === 'all'
        ? 'all'
        : parseOptionalEnum(rawStatus, (v) => LarkMemoryStatusSchema.parse(v))
    const query = url.searchParams.get('q')?.trim() || undefined
    const limitParam = url.searchParams.get('limit')
    const limit = limitParam && Number.isFinite(Number(limitParam)) ? Number(limitParam) : undefined

    const recordRecall =
      isCliAuthenticated && Boolean(query) && url.searchParams.get('recordRecall') !== '0'
    const entries = memory.list(
      {
        ...(botId ? { botId } : {}),
        ...(scope ? { scope } : {}),
        ...(scopeId ? { scopeId } : {}),
        ...(type ? { type } : {}),
        ...(status ? { status } : {}),
        ...(query ? { query } : {}),
        ...(limit ? { limit } : {}),
      },
      { recordRecall },
    )
    return {
      status: 200,
      payload: {
        ok: true,
        ...(botId ? { botId, markdownPath: memory.memoryMarkdownPath(botId) } : {}),
        entries,
      },
    }
  }

  if (method === 'GET' && memoryId && segments.length === 2) {
    const recordRecall = url.searchParams.get('recordRecall') !== '0'
    const entry = memory.get(memoryId, { recordRecall })
    if (!entry) {
      return { status: 404, payload: { ok: false, error: 'memory_not_found' } }
    }
    return { status: 200, payload: { ok: true, entry } }
  }

  if (method === 'POST' && segments.length === 1) {
    const body = bodyRecord(input.body)
    const rawSessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : undefined
    const identity = resolveMemorySessionIdentity(manager, rawSessionId, externalSessionId)
    const sessionId = identity.canonicalSessionId
    const explicitBotId = typeof body.botId === 'string' ? body.botId.trim() || undefined : undefined
    const hints = identity.provided
      ? resolveSessionContextHints(manager, rawSessionId, externalSessionId)
      : { bound: false }
    if (identity.provided && !hints.bound && !explicitBotId) {
      throw new SessionIdentityError(
        'unresolved_session_context',
        `无法解析当前会话上下文（${identity.rawSessionId}），已拒绝回退到默认智能体写入记忆；请显式指定 --bot`,
        400,
      )
    }
    const botId = explicitBotId || hints.botId || ''
    if (!botId) {
      return { status: 400, payload: { ok: false, error: 'botId is required' } }
    }
    if (!manager.store.getBot(botId)) {
      return { status: 404, payload: { ok: false, error: `bot "${botId}" not found` } }
    }

    const scope: LarkMemoryScope =
      parseOptionalEnum(body.scope, (v) => LarkMemoryScopeSchema.parse(v)) ?? 'bot'
    const scopeId = resolveEffectiveScopeId(
      scope,
      typeof body.scopeId === 'string' ? body.scopeId : undefined,
      hints,
    )
    const type: LarkMemoryType = LarkMemoryTypeSchema.parse(body.type)
    const title = typeof body.title === 'string' ? body.title : ''
    const content = typeof body.content === 'string' ? body.content : ''
    const tags = parseTagsInput(body.tags)
    const confidence: LarkMemoryConfidence | undefined = parseOptionalEnum(body.confidence, (v) =>
      LarkMemoryConfidenceSchema.parse(v),
    )
    const pinned = typeof body.pinned === 'boolean' ? body.pinned : undefined
    const supersedesId =
      typeof body.supersedesId === 'string' && body.supersedesId.trim()
        ? body.supersedesId.trim()
        : undefined
    const supersedeReason =
      typeof body.supersedeReason === 'string' && body.supersedeReason.trim()
        ? body.supersedeReason.trim()
        : undefined

    const outcome = memory.upsert({
      ...(typeof body.id === 'string' && body.id.trim() ? { id: body.id.trim() } : {}),
      botId,
      scope,
      ...(scopeId !== undefined ? { scopeId } : {}),
      type,
      title,
      content,
      ...(tags !== undefined ? { tags } : {}),
      ...(confidence ? { confidence } : {}),
      ...(pinned !== undefined ? { pinned } : {}),
      ...(sessionId ? { sourceSessionId: sessionId } : {}),
      ...(supersedesId ? { supersedesId } : {}),
      ...(supersedeReason ? { supersedeReason } : {}),
    })
    return {
      status: outcome.action === 'created' ? 201 : 200,
      payload: {
        ok: true,
        action: outcome.action,
        entry: outcome.entry,
        ...(outcome.supersededEntry ? { supersededEntry: outcome.supersededEntry } : {}),
        markdownPath: memory.memoryMarkdownPath(botId),
      },
    }
  }

  if (method === 'PUT' && memoryId && segments.length === 2) {
    const body = bodyRecord(input.body)
    const scope = parseOptionalEnum(body.scope, (v) => LarkMemoryScopeSchema.parse(v))
    const type = parseOptionalEnum(body.type, (v) => LarkMemoryTypeSchema.parse(v))
    const confidence = parseOptionalEnum(body.confidence, (v) =>
      LarkMemoryConfidenceSchema.parse(v),
    )
    const status = parseOptionalEnum(body.status, (v) => LarkMemoryStatusSchema.parse(v))
    const tags = parseTagsInput(body.tags)

    const updated = memory.update(memoryId, {
      ...(scope ? { scope } : {}),
      ...(typeof body.scopeId === 'string' ? { scopeId: body.scopeId } : {}),
      ...(type ? { type } : {}),
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.content === 'string' ? { content: body.content } : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(confidence ? { confidence } : {}),
      ...(typeof body.pinned === 'boolean' ? { pinned: body.pinned } : {}),
      ...(status ? { status } : {}),
      ...(typeof body.verified === 'boolean' ? { verified: body.verified } : {}),
    })
    if (!updated) {
      return { status: 404, payload: { ok: false, error: 'memory_not_found' } }
    }
    return { status: 200, payload: { ok: true, entry: updated } }
  }

  if (method === 'POST' && memoryId && action === 'supersede' && segments.length === 3) {
    const body = bodyRecord(input.body)
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!reason) {
      return { status: 400, payload: { ok: false, error: 'reason is required' } }
    }
    const existing = memory.get(memoryId, { recordRecall: false })
    if (!existing) {
      return { status: 404, payload: { ok: false, error: 'memory_not_found' } }
    }
    const hasReplacement =
      typeof body.title === 'string' &&
      body.title.trim().length > 0 &&
      typeof body.content === 'string' &&
      body.content.trim().length > 0
    const rawSessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : undefined
    const identity = resolveMemorySessionIdentity(manager, rawSessionId, externalSessionId)
    const sessionId = identity.canonicalSessionId
    const tags = parseTagsInput(body.tags)
    const scope = parseOptionalEnum(body.scope, (v) => LarkMemoryScopeSchema.parse(v))
    const confidence = parseOptionalEnum(body.confidence, (v) =>
      LarkMemoryConfidenceSchema.parse(v),
    )

    const outcome = memory.supersede(memoryId, {
      reason,
      ...(hasReplacement
        ? {
            replacement: {
              type:
                parseOptionalEnum(body.type, (v) => LarkMemoryTypeSchema.parse(v)) ??
                existing.type,
              title: String(body.title),
              content: String(body.content),
              ...(scope ? { scope } : {}),
              ...(typeof body.scopeId === 'string' ? { scopeId: body.scopeId } : {}),
              ...(tags !== undefined ? { tags } : {}),
              ...(confidence ? { confidence } : {}),
              ...(typeof body.pinned === 'boolean' ? { pinned: body.pinned } : {}),
              ...(sessionId ? { sourceSessionId: sessionId } : {}),
            },
          }
        : {}),
    })
    if (!outcome) {
      return { status: 404, payload: { ok: false, error: 'memory_not_found' } }
    }
    return {
      status: 200,
      payload: {
        ok: true,
        oldEntry: outcome.oldEntry,
        ...(outcome.replacementEntry ? { replacementEntry: outcome.replacementEntry } : {}),
      },
    }
  }

  if (method === 'DELETE' && memoryId && segments.length === 2) {
    const hard = url.searchParams.get('hard') === '1'
    if (hard) {
      if (principalKind !== 'owner' || isCliAuthenticated || Boolean(isOperatorAuthenticated)) {
        return { status: 403, payload: { ok: false, error: 'owner_web_session_required' } }
      }
      const deleted = memory.deleteHard(memoryId)
      if (!deleted) {
        return { status: 404, payload: { ok: false, error: 'memory_not_found' } }
      }
      return { status: 200, payload: { ok: true, deleted: true, entry: deleted } }
    }
    const reason = url.searchParams.get('reason')?.trim() || undefined
    const archived = memory.archive(memoryId, reason)
    if (!archived) {
      return { status: 404, payload: { ok: false, error: 'memory_not_found' } }
    }
    return { status: 200, payload: { ok: true, archived: true, entry: archived } }
  }

  return undefined
}
