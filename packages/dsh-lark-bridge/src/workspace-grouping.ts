import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { expandWorkingDir, type LarkBotConfig } from '@dsh-lark/lark-core'
import type { LarkBridgeStore } from './store.js'

type Workspace = Awaited<ReturnType<WorkspaceRegistry['create']>>

/**
 * Keeps Lark-originated sessions inside their configured DSH sidebar workspace
 * and archives expired sessions through DSH's durable `workspaceRegistry`.
 */
export class WorkspaceGrouping {
  constructor(
    private readonly ctx: Context,
    private readonly store: LarkBridgeStore,
  ) {}

  async attachSession(workingDir: string, title: string, sessionId: string): Promise<void> {
    const ws = await this.open(workingDir, title)
    if (!ws) return
    try {
      await ws.attachSession(brandString<SessionId>(sessionId))
    } catch (err) {
      this.warn(`attachSession(${sessionId}) to "${title}"`, err)
    }
  }

  async archiveSession(sessionId: string): Promise<boolean> {
    const registry = this.registry()
    if (!registry) return false
    const branded = brandString<SessionId>(sessionId)
    if (registry.archivedSessionIds?.includes(branded)) return false
    try {
      await registry.archiveSession(branded, { stopActivity: true })
      return true
    } catch (err) {
      this.warn(`archiveSession(${sessionId})`, err)
      return false
    }
  }

  listArchivedSessionIds(): string[] {
    const registry = this.registry()
    return [...(registry?.archivedSessionIds ?? [])]
  }

  listWorkspaceSessionIds(): string[] {
    const registry = this.registry()
    if (!registry?.list) return []
    const archived = new Set<string>(registry.archivedSessionIds ?? [])
    const ids = new Set<string>()
    for (const ws of registry.list()) {
      for (const sid of ws.sessionIds ?? []) {
        if (!archived.has(sid)) ids.add(sid)
      }
    }
    return [...ids]
  }

  async syncBot(bot: LarkBotConfig): Promise<void> {
    await this.open(bot.defaultWorkingDir, this.store.resolveBotWorkspaceName(bot))
    for (const group of this.store.listGroups(bot.id)) {
      await this.open(
        group.workingDir.trim() || bot.defaultWorkingDir,
        this.store.resolveGroupWorkspaceName(bot, group),
      )
    }
  }

  async syncGroup(botId: string, chatId: string): Promise<void> {
    const bot = this.store.getBot(botId)
    const group = this.store.getGroup(botId, chatId)
    if (!bot || !group) return
    await this.open(
      group.workingDir.trim() || bot.defaultWorkingDir,
      this.store.resolveGroupWorkspaceName(bot, group),
    )
  }

  async reconcileBindings(): Promise<void> {
    for (const binding of this.store.listBindings()) {
      await this.attachSession(binding.workingDir, binding.workspaceName, binding.sessionId)
    }
  }

  private registry(): WorkspaceRegistry | undefined {
    return this.ctx.get('workspaceRegistry') as WorkspaceRegistry | undefined
  }

  private async open(workingDir: string, title: string): Promise<Workspace | undefined> {
    const registry = this.registry()
    const resolvedDir = expandWorkingDir(workingDir)
    if (!registry || !resolvedDir) return undefined
    const desired = title.trim()
    try {
      const ws = await registry.create(resolvedDir, desired || undefined)
      if (desired && ws.title !== desired) {
        await ws.setTitle(desired)
      }
      return ws
    } catch (err) {
      this.warn(`workspace "${resolvedDir}"`, err)
      return undefined
    }
  }

  private warn(subject: string, err: unknown): void {
    this.ctx.logger.warn(
      `[lark-bridge] ${subject} skipped: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
