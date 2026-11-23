import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  pluginRecordOf,
  type Session,
  type SessionEvent,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import {
  extractPureUserIntent,
  hasInjectedPromptMarkup,
  type InboundLarkMessage,
} from '@dsh-lark/lark-core'
import type { LarkBridgeStore } from './store.js'
import type { WorkspaceGrouping } from './workspace-grouping.js'

const DEFAULT_HISTORICAL_ARCHIVE_MS = 60 * 60_000

interface TitleServiceLike {
  readonly get?: (s: Session) => { title?: string; source?: { kind?: string } } | undefined
  readonly rename?: (s: Session, nextTitle: string) => unknown
  readonly registration?: {
    readonly provider?: {
      __larkSanitized?: boolean
      generate?: (req: {
        messages: ReadonlyArray<{ seq: unknown; text: string }>
        [k: string]: unknown
      }) => Promise<unknown>
    }
  }
}

/**
 * Isolates coupling to DSH Host's `sessionTitle` internals (`registration.provider.generate`)
 * and historical session title/archive reconciliation behind a defensive adapter.
 *
 * Host contract target: `@deepseek-ai/dsh-session` 0.2.x.
 * If a future DSH host release removes or renames `registration.provider`, this adapter
 * logs a structured downgrade warning once and falls back cleanly to reactive `session/title`
 * event sanitization without breaking message flow.
 */
export class SessionTitleGuard {
  private warnedHostDrift = false

  constructor(
    private readonly ctx: Context,
    private readonly store: LarkBridgeStore,
    private readonly workspaces: WorkspaceGrouping,
    private readonly archiveSession: (sessionId: string) => Promise<boolean>,
  ) {}

  install(): () => void {
    this.wrapTitleProvider(this.titleService())
    if (typeof this.ctx.inject === 'function') {
      this.ctx.inject(['sessionTitle' as never], (tCtx) => {
        this.wrapTitleProvider((tCtx as Context).get('sessionTitle' as never))
      })
    }

    return this.ctx.on(
      'session/event',
      (session: Session, event: SessionEvent) => {
        const rawEvent = event as unknown as { type: string; data?: { title?: string } }
        if (rawEvent.type !== 'session/title') return
        const rawTitle = rawEvent.data?.title ?? ''
        if (!hasInjectedPromptMarkup(rawTitle)) return
        const repaired = this.deriveCleanTitleFromEvents(session.snapshotEvents())
        if (!repaired || repaired === rawTitle) return
        try {
          this.titleService()?.rename?.(session, repaired)
        } catch {
          // Ignore if session is closing.
        }
      },
      { global: true },
    )
  }

  ensureCleanSessionTitle(
    session: Session,
    msg: InboundLarkMessage,
    userText: string,
    isNew: boolean,
  ): void {
    const titleService = this.titleService()
    if (!titleService?.rename) return

    const pure = extractPureUserIntent(userText || msg.text)
    const candidate = (pure || (msg.imageKeys.length > 0 ? '图片消息' : '')).slice(0, 60)
    if (!candidate) return

    const current = titleService.get?.(session)?.title?.trim() ?? ''
    const isTrivialGreeting = /^(hi|hello|hey|你好|您好|在吗|测试|test)$/i.test(current)
    const shouldWrite =
      isNew ||
      !current ||
      hasInjectedPromptMarkup(current) ||
      (isTrivialGreeting &&
        candidate.length > 6 &&
        !/^(hi|hello|hey|你好|您好|在吗|测试|test)$/i.test(candidate))

    if (shouldWrite && candidate !== current) {
      try {
        titleService.rename(session, candidate)
      } catch {
        // Ignore if session closed.
      }
    }
  }

  async reconcileHistoricalSessions(): Promise<void> {
    const persistence = this.ctx.get('sessionPersistence') as SessionPersistence | undefined
    if (!persistence) return

    const activeBoundSessionIds = new Set(this.store.listBindings().map((b) => b.sessionId))
    const sessionIds = this.workspaces.listWorkspaceSessionIds()
    const now = Date.now()
    const bots = this.store.listBots()
    const defaultIdleMs =
      bots.length > 0 && bots[0]!.idleCloseMinutes > 0
        ? bots[0]!.idleCloseMinutes * 60_000
        : DEFAULT_HISTORICAL_ARCHIVE_MS

    for (const sid of sessionIds) {
      let events: readonly SessionEvent[] = []
      let headerCreatedAt = 0
      try {
        const handle = await persistence.open(brandString<SessionId>(sid), 'read')
        headerCreatedAt = handle.header?.createdAt ?? 0
        try {
          const readRes = await handle.read(0, 200)
          events = readRes.events
        } finally {
          await handle.close().catch(() => {})
        }
      } catch {
        continue
      }
      if (events.length === 0) continue

      let latestTitle = ''
      let lastTimestampMs = 0
      let isBridgeSession = false
      for (const ev of events) {
        const rawEv = ev as unknown as {
          type: string
          time?: number
          timestamp?: number
          data?: { title?: string; content?: ReadonlyArray<{ text?: string }> }
        }
        const evTime =
          typeof rawEv.time === 'number'
            ? rawEv.time
            : typeof rawEv.timestamp === 'number'
              ? rawEv.timestamp
              : 0
        if (rawEv.type !== 'session/title' && evTime > lastTimestampMs) {
          lastTimestampMs = evTime
        }
        const rec = pluginRecordOf(ev as never) as { type?: string } | undefined
        if (rec?.type?.endsWith('/origin')) {
          isBridgeSession = true
        }
        if (rawEv.type === 'user/message') {
          const txt = (rawEv.data?.content ?? []).map((c) => c.text ?? '').join('\n')
          if (hasInjectedPromptMarkup(txt) || txt.includes('<user_message>')) {
            isBridgeSession = true
          }
        }
        if (rawEv.type === 'session/title') {
          latestTitle = rawEv.data?.title ?? ''
        }
      }
      if (lastTimestampMs === 0) {
        lastTimestampMs = headerCreatedAt
      }

      if (latestTitle && hasInjectedPromptMarkup(latestTitle)) {
        const clean = this.deriveCleanTitleFromEvents(events)
        if (clean) {
          try {
            const live = this.ctx.agents.get(brandString<SessionId>(sid))
            if (live) {
              this.titleService()?.rename?.(live.session, clean)
            } else {
              const resumed = await this.ctx.agents.resume({
                resumeSessionId: brandString<SessionId>(sid),
              })
              try {
                this.titleService()?.rename?.(resumed.agent.session, clean)
              } finally {
                await resumed.dispose().catch(() => {})
              }
            }
            this.ctx.logger.info(
              `[lark-bridge] repaired polluted session title for ${sid} -> "${clean}"`,
            )
          } catch {
            // Best-effort historical title repair.
          }
        }
      }

      if (isBridgeSession && !activeBoundSessionIds.has(sid) && lastTimestampMs > 0) {
        const managed = this.store.getManagedSession?.(sid)
        const archiveThresholdMs = managed
          ? managed.idleCloseMs && managed.idleCloseMs > 0
            ? managed.idleCloseMs
            : Number.POSITIVE_INFINITY
          : Math.min(defaultIdleMs, DEFAULT_HISTORICAL_ARCHIVE_MS)
        if (now - lastTimestampMs >= archiveThresholdMs) {
          await this.archiveSession(sid)
        }
      }
    }
  }

  private wrapTitleProvider(rawSvc: unknown): void {
    if (!rawSvc || typeof rawSvc !== 'object') return
    const svc = rawSvc as TitleServiceLike
    const provider = svc.registration?.provider
    if (!provider || typeof provider.generate !== 'function') {
      if (!this.warnedHostDrift && typeof svc.rename === 'function') {
        this.warnedHostDrift = true
        this.ctx.logger?.warn?.(
          '[lark-bridge] sessionTitle host provider hook unavailable; falling back to reactive session/title sanitization',
        )
      }
      return
    }
    if (provider.__larkSanitized) return
    try {
      const origGenerate = provider.generate.bind(provider)
      provider.__larkSanitized = true
      provider.generate = (req) => {
        const cleanedMessages = req.messages.map((m) => {
          if (!hasInjectedPromptMarkup(m.text) && !m.text.includes('<user_message>')) return m
          const pure = extractPureUserIntent(m.text)
          return pure ? { ...m, text: pure } : m
        })
        return origGenerate({ ...req, messages: cleanedMessages })
      }
    } catch (err) {
      if (!this.warnedHostDrift) {
        this.warnedHostDrift = true
        this.ctx.logger?.warn?.(
          `[lark-bridge] sessionTitle provider wrap skipped (${err instanceof Error ? err.message : String(err)}); using reactive fallback`,
        )
      }
    }
  }

  private deriveCleanTitleFromEvents(events: readonly SessionEvent[]): string | undefined {
    for (const ev of events) {
      if (ev.type !== 'user/message') continue
      const content =
        (ev.data as { content?: ReadonlyArray<{ type?: string; text?: string }> }).content ?? []
      const rawText = content
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text!)
        .join('\n')
      const pure = extractPureUserIntent(rawText)
      if (pure) return pure.slice(0, 60)
    }
    return undefined
  }

  private titleService(): TitleServiceLike | undefined {
    return this.ctx.get('sessionTitle' as never) as TitleServiceLike | undefined
  }
}
