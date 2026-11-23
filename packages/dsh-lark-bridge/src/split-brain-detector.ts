import type { ExternalSelfMessageEvent } from '@dsh-lark/lark-core'

export interface SplitBrainAlert {
  readonly botId: string
  readonly botName: string
  readonly larkAppId: string
  readonly botOpenId: string
  readonly observedCount: number
  readonly firstObservedAtMs: number
  readonly lastObservedAtMs: number
  readonly lastChatId: string
  readonly lastMessageId: string
}

const AUDIT_COOLDOWN_MS = 10 * 60_000

/**
 * Detects cross-host same-`appId` split-brain connections:
 * When a bot receives a Feishu event whose sender is itself (`botOpenId`),
 * yet the `messageId` was NOT sent by this process, another machine/process
 * is actively connected with the same Feishu App credentials.
 */
export class SplitBrainDetector {
  private readonly alerts = new Map<string, SplitBrainAlert>()
  private readonly lastAuditedAtMs = new Map<string, number>()

  recordExternalSelfMessage(
    event: ExternalSelfMessageEvent,
    botName: string,
    nowMs = Date.now(),
  ): { readonly shouldAudit: boolean; readonly alert: SplitBrainAlert } {
    const prev = this.alerts.get(event.botId)
    const alert: SplitBrainAlert = {
      botId: event.botId,
      botName,
      larkAppId: event.larkAppId,
      botOpenId: event.botOpenId,
      observedCount: (prev?.observedCount ?? 0) + 1,
      firstObservedAtMs: prev?.firstObservedAtMs ?? nowMs,
      lastObservedAtMs: nowMs,
      lastChatId: event.chatId,
      lastMessageId: event.messageId,
    }
    this.alerts.set(event.botId, alert)

    const lastAudited = this.lastAuditedAtMs.get(event.botId) ?? 0
    const shouldAudit = !lastAudited || nowMs - lastAudited >= AUDIT_COOLDOWN_MS
    if (shouldAudit) {
      this.lastAuditedAtMs.set(event.botId, nowMs)
    }
    return { shouldAudit, alert }
  }

  getAlert(botId: string): SplitBrainAlert | undefined {
    return this.alerts.get(botId)
  }

  listAlerts(): SplitBrainAlert[] {
    return [...this.alerts.values()].sort((a, b) => b.lastObservedAtMs - a.lastObservedAtMs)
  }

  clearAlert(botId: string): boolean {
    this.lastAuditedAtMs.delete(botId)
    return this.alerts.delete(botId)
  }
}
