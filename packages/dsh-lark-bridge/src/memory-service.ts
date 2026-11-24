import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  composeBridgeMemoryReminder,
  rankMemoryEntriesForContext,
  renderMemoryMarkdownProjection,
  type LarkMemoryEntry,
  type LarkMemoryMutationStats,
  type MemoryRecallContext,
} from '@dsh-lark/lark-core'
import type {
  MemoryQueryOptions,
  MemorySupersedeOutcome,
  MemoryUpdateInput,
  MemoryUpsertInput,
  MemoryUpsertOutcome,
} from './storage/memory-repo.js'
import type { LarkBridgeStore } from './store.js'

interface MutableStats {
  created: number
  updated: number
  superseded: number
  archived: number
}

export interface MemoryMutationTracker {
  snapshot(): LarkMemoryMutationStats
  totalMutations(): number
  dispose(): void
}

function atomicWritePrivate(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 })
  if (process.platform !== 'win32') {
    try {
      chmodSync(tmpPath, 0o600)
    } catch {
      // Best-effort on non-POSIX filesystems.
    }
  }
  renameSync(tmpPath, filePath)
}

/**
 * Runtime-agnostic Bridge Memory service:
 * - Single source of truth in SQLite (`memory_entries` + FTS5 trigram index)
 * - Atomic human-auditable Markdown mirror at `<dataDir>/memory/<botId>/MEMORY.md`
 * - Progressive disclosure Layer 1 context injection + recall telemetry
 * - Scoped mutation trackers for honest Dreaming consolidation accounting
 */
export class BridgeMemoryService {
  private readonly trackersByBot = new Map<string, Set<MutableStats>>()

  constructor(
    private readonly dataDir: string,
    private readonly store: LarkBridgeStore,
  ) {}

  memoryMarkdownPath(botId: string): string {
    const safeBotId = botId.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'default'
    return join(this.dataDir, 'memory', safeBotId, 'MEMORY.md')
  }

  ensureMarkdownMirror(botId: string, nowMs = Date.now()): string {
    const filePath = this.memoryMarkdownPath(botId)
    const bot = this.store.getBot(botId)
    const activeEntries = this.store.listMemoryEntries({
      botId,
      status: 'active',
      limit: 200,
    })
    const markdown = renderMemoryMarkdownProjection({
      botId,
      ...(bot?.name ? { botName: bot.name } : {}),
      entries: activeEntries,
      generatedAtMs: nowMs,
    })
    atomicWritePrivate(filePath, markdown)
    return filePath
  }

  beginMutationTracker(botId: string): MemoryMutationTracker {
    const stats: MutableStats = { created: 0, updated: 0, superseded: 0, archived: 0 }
    let set = this.trackersByBot.get(botId)
    if (!set) {
      set = new Set()
      this.trackersByBot.set(botId, set)
    }
    set.add(stats)
    return {
      snapshot: () => ({ ...stats }),
      totalMutations: () => stats.created + stats.updated + stats.superseded + stats.archived,
      dispose: () => {
        const cur = this.trackersByBot.get(botId)
        if (!cur) return
        cur.delete(stats)
        if (cur.size === 0) this.trackersByBot.delete(botId)
      },
    }
  }

  countActiveForBot(botId: string): number {
    return this.store.countActiveMemoryForBot(botId)
  }

  countActiveByBot(): Map<string, number> {
    return this.store.countActiveMemoryByBot()
  }

  list(options: MemoryQueryOptions = {}): LarkMemoryEntry[] {
    return this.store.listMemoryEntries(options)
  }

  get(id: string, options: { readonly recordRecall?: boolean } = {}): LarkMemoryEntry | undefined {
    const entry = this.store.getMemoryEntry(id)
    if (entry && options.recordRecall !== false && entry.status === 'active') {
      this.store.recordMemoryRecalls([entry.id])
      return this.store.getMemoryEntry(id) ?? entry
    }
    return entry
  }

  upsert(input: MemoryUpsertInput, nowMs = Date.now()): MemoryUpsertOutcome {
    const outcome = this.store.upsertMemoryEntry(input, nowMs)
    this.recordMutation(outcome.entry.botId, outcome.action)
    if (outcome.supersededEntry) {
      this.recordMutation(outcome.entry.botId, 'superseded')
    }
    this.syncMirrorBestEffort(outcome.entry.botId, nowMs)
    return outcome
  }

  update(id: string, patch: MemoryUpdateInput, nowMs = Date.now()): LarkMemoryEntry | undefined {
    const updated = this.store.updateMemoryEntry(id, patch, nowMs)
    if (!updated) return undefined
    this.recordMutation(updated.botId, 'updated')
    this.syncMirrorBestEffort(updated.botId, nowMs)
    return updated
  }

  supersede(
    oldId: string,
    input: {
      readonly reason: string
      readonly replacement?: Omit<MemoryUpsertInput, 'botId' | 'supersedesId' | 'supersedeReason'>
    },
    nowMs = Date.now(),
  ): MemorySupersedeOutcome | undefined {
    const outcome = this.store.supersedeMemoryEntry(oldId, input, nowMs)
    if (!outcome) return undefined
    this.recordMutation(outcome.oldEntry.botId, 'superseded')
    if (outcome.replacementEntry) {
      this.recordMutation(outcome.oldEntry.botId, 'created')
    }
    this.syncMirrorBestEffort(outcome.oldEntry.botId, nowMs)
    return outcome
  }

  archive(id: string, reason?: string, nowMs = Date.now()): LarkMemoryEntry | undefined {
    const archived = this.store.archiveMemoryEntry(id, reason, nowMs)
    if (!archived) return undefined
    this.recordMutation(archived.botId, 'archived')
    this.syncMirrorBestEffort(archived.botId, nowMs)
    return archived
  }

  deleteHard(id: string, nowMs = Date.now()): LarkMemoryEntry | undefined {
    const deleted = this.store.deleteMemoryEntryHard(id)
    if (!deleted) return undefined
    this.recordMutation(deleted.botId, 'archived')
    this.syncMirrorBestEffort(deleted.botId, nowMs)
    return deleted
  }

  /**
   * Builds Layer 1 progressive disclosure `<bridge_memory>` reminder for a new session
   * and updates recall statistics for the surfaced entries.
   */
  composeFirstTurnReminder(
    context: MemoryRecallContext,
    options: { readonly includeWhenEmpty?: boolean; readonly nowMs?: number } = {},
  ): string | undefined {
    const allActive = this.store.listMemoryEntries({
      botId: context.botId,
      status: 'active',
      limit: 200,
    })
    const ranked = rankMemoryEntriesForContext(allActive, context)
    if (ranked.length === 0 && !options.includeWhenEmpty) {
      return undefined
    }
    const composed = composeBridgeMemoryReminder({
      botId: context.botId,
      entries: ranked,
      totalActiveCount: ranked.length,
    })
    if (!composed) return undefined
    if (composed.includedEntryIds.length > 0) {
      this.store.recordMemoryRecalls(composed.includedEntryIds, options.nowMs ?? Date.now())
    }
    return composed.reminder
  }

  private recordMutation(botId: string, kind: keyof MutableStats): void {
    const trackers = this.trackersByBot.get(botId)
    if (!trackers) return
    for (const t of trackers) {
      t[kind] += 1
    }
  }

  private syncMirrorBestEffort(botId: string, nowMs: number): void {
    try {
      this.ensureMarkdownMirror(botId, nowMs)
    } catch {
      // SQLite transaction already succeeded; markdown mirror is derived best-effort.
    }
  }
}
