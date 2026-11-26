import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-session')>()
  return {
    ...actual,
    appendPluginRecord: vi.fn(),
  }
})

import { LarkBridgeManager } from '../src/bridge-manager.js'
import { LarkBridgeStore } from '../src/store.js'
import { WorkspaceGrouping } from '../src/workspace-grouping.js'

const tempDirs: string[] = []

function makeTempDir(prefix = 'dsh-lark-ws-group-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

interface MockWorkspace {
  readonly path: string
  title: string
  readonly sessionIds: string[]
  readonly setTitle: ReturnType<typeof vi.fn>
  readonly attachSession: ReturnType<typeof vi.fn>
}

function createFakeWorkspaceRegistry() {
  const byPath = new Map<string, MockWorkspace>()
  const archivedSessionIds: string[] = []
  const operations: string[] = []

  const registry = {
    archivedSessionIds,
    list: () => [...byPath.values()],
    create: vi.fn(async (dir: string, title?: string) => {
      let ws = byPath.get(dir)
      if (!ws) {
        const entry: MockWorkspace = {
          path: dir,
          title: title ?? dir.split('/').filter(Boolean).pop() ?? 'workspace',
          sessionIds: [],
          setTitle: vi.fn(async (nextTitle: string) => {
            entry.title = nextTitle
            operations.push(`setTitle:${dir}:${nextTitle}`)
          }),
          attachSession: vi.fn(async (sid: string) => {
            const id = String(sid)
            if (!entry.sessionIds.includes(id)) {
              entry.sessionIds.unshift(id)
            }
            operations.push(`attach:${dir}:${id}`)
          }),
        }
        byPath.set(dir, entry)
        ws = entry
      }
      return ws
    }),
    archiveSession: vi.fn(async (sid: string) => {
      const id = String(sid)
      if (!archivedSessionIds.includes(id)) {
        archivedSessionIds.push(id)
      }
      operations.push(`archive:${id}`)
    }),
  }

  return { registry, byPath, archivedSessionIds, operations }
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

describe('WorkspaceGrouping startup readiness & managed session reconciliation', () => {
  it('defers attachSession and archiveSession until workspaceRegistry becomes active, then flushes in attach-before-archive order', async () => {
    const dataDir = makeTempDir()
    const repoDir = makeTempDir('dsh-lark-repo-')
    const store = new LarkBridgeStore(dataDir)
    store.upsertBot({
      id: 'bot-a',
      name: 'BotA',
      enabled: true,
      larkAppId: 'cli_ws_a',
      larkAppSecret: 'sec_ws_a',
      defaultWorkingDir: repoDir,
      workspaceName: 'repo-main',
    })

    const fake = createFakeWorkspaceRegistry()
    let registryAvailable = false
    let onWorkspaceInject: ((wsCtx: Context) => void) | undefined
    const warn = vi.fn()
    const disposeFiber = vi.fn()

    const ctx = {
      logger: { info: vi.fn(), warn, error: vi.fn() },
      get: (key: string) => {
        if (key === 'workspaceRegistry') {
          return registryAvailable ? fake.registry : undefined
        }
        return undefined
      },
      inject: vi.fn((deps: readonly string[], cb: (subCtx: Context) => void) => {
        if (deps.includes('workspaceRegistry')) {
          onWorkspaceInject = cb
        }
        return { dispose: disposeFiber }
      }),
    } as unknown as Context

    const grouping = new WorkspaceGrouping(ctx, store)
    const dispose = grouping.install()

    // While workspaceRegistry is still initializing, both attach & archive are queued instead of silently lost.
    await grouping.attachSession(repoDir, 'repo-main', 'session-reminder-early')
    await grouping.attachSession(repoDir, 'repo-main', 'session-triage-early')
    const archivedImmediately = await grouping.archiveSession('session-triage-early')

    expect(archivedImmediately).toBe(false)
    expect(warn).toHaveBeenCalled()
    expect(fake.registry.create).not.toHaveBeenCalled()
    expect(fake.registry.archiveSession).not.toHaveBeenCalled()

    // Simulate Cordis activating `workspaceRegistry` once WorkspaceRegistry[Service.init]() finishes.
    registryAvailable = true
    onWorkspaceInject?.({
      get: (k: string) => (k === 'workspaceRegistry' ? fake.registry : undefined),
      effect: vi.fn(),
    } as unknown as Context)
    await flushMicrotasks()

    const ws = fake.byPath.get(repoDir)
    expect(ws?.title).toBe('repo-main')
    expect(ws?.sessionIds).toContain('session-reminder-early')
    expect(ws?.sessionIds).toContain('session-triage-early')
    expect(fake.archivedSessionIds).toContain('session-triage-early')
    // Triage session must be attached BEFORE being archived so it keeps its workspace slot.
    expect(fake.operations.indexOf(`attach:${repoDir}:session-triage-early`)).toBeLessThan(
      fake.operations.indexOf('archive:session-triage-early'),
    )

    dispose()
    expect(disposeFiber).toHaveBeenCalledTimes(1)
    store.close()
  })

  it('reconciles unarchived ungrouped managed sessions (reminders/ephemeral) without clobbering custom-dir titles or touching archived/missing sessions', async () => {
    const dataDir = makeTempDir()
    const botDir = makeTempDir('dsh-lark-botdir-')
    const groupDir = makeTempDir('dsh-lark-groupdir-')
    const customDir = makeTempDir('dsh-lark-customdir-')
    const store = new LarkBridgeStore(dataDir)

    store.upsertBot({
      id: 'bot-r',
      name: 'BotR',
      enabled: true,
      larkAppId: 'cli_ws_r',
      larkAppSecret: 'sec_ws_r',
      defaultWorkingDir: botDir,
    })
    store.upsertGroup({
      botId: 'bot-r',
      chatId: 'oc_release',
      chatName: 'Release Group',
      enabled: true,
      workingDir: groupDir,
      workspaceName: 'release-ws',
    })

    // Pre-populate an existing custom workspace with its own distinct title.
    const fake = createFakeWorkspaceRegistry()
    const customWs = await fake.registry.create(customDir, 'custom-existing-title')
    const groupWs = await fake.registry.create(groupDir, 'release-ws')
    groupWs.sessionIds.push('session-already-grouped')
    fake.archivedSessionIds.push('session-manually-archived')
    fake.operations.length = 0

    const now = Date.now()
    // 1. Already grouped -> must skip cleanly without hitting sessionPersistence.
    store.upsertManagedSession({
      sessionId: 'session-already-grouped',
      botId: 'bot-r',
      chatId: 'oc_release',
      routeKey: 'reminder:rem-ok',
      trigger: 'reminder',
      createdAtMs: now - 5_000,
      lastActivityMs: now - 5_000,
    })
    // 2. Manually archived in DSH UI -> must skip cleanly.
    store.upsertManagedSession({
      sessionId: 'session-manually-archived',
      botId: 'bot-r',
      chatId: 'oc_release',
      routeKey: 'reminder:rem-arch',
      trigger: 'reminder',
      createdAtMs: now - 4_000,
      lastActivityMs: now - 4_000,
    })
    // 3. Ungrouped orphaned reminder in groupDir -> MUST repair into release-ws.
    store.upsertManagedSession({
      sessionId: 'session-orphan-reminder',
      botId: 'bot-r',
      chatId: 'oc_release',
      routeKey: 'reminder:rem-orphan',
      trigger: 'reminder',
      createdAtMs: now - 3_000,
      lastActivityMs: now - 3_000,
    })
    // 4. Ungrouped orphaned reminder with custom workingDir -> MUST repair into customDir without renaming its title.
    store.upsertManagedSession({
      sessionId: 'session-custom-dir-orphan',
      botId: 'bot-r',
      chatId: 'oc_release',
      routeKey: 'reminder:rem-custom',
      trigger: 'reminder',
      createdAtMs: now - 2_000,
      lastActivityMs: now - 2_000,
    })
    // 5. Missing on disk -> MUST skip silently without warning.
    store.upsertManagedSession({
      sessionId: 'session-missing-disk',
      botId: 'bot-r',
      chatId: 'oc_release',
      routeKey: 'reminder:rem-missing',
      trigger: 'reminder',
      createdAtMs: now - 1_000,
      lastActivityMs: now - 1_000,
    })

    const openPersistence = vi.fn(async (sid: string) => {
      const id = String(sid)
      if (id === 'session-orphan-reminder') {
        return { header: { cwd: groupDir }, close: vi.fn(async () => {}) }
      }
      if (id === 'session-custom-dir-orphan') {
        return { header: { cwd: customDir }, close: vi.fn(async () => {}) }
      }
      throw new Error(`ENOENT: ${id}`)
    })

    const warn = vi.fn()
    const info = vi.fn()
    const ctx = {
      logger: { info, warn, error: vi.fn() },
      sessions: { get: () => undefined },
      get: (key: string) => {
        if (key === 'workspaceRegistry') return fake.registry
        if (key === 'sessionPersistence') return { open: openPersistence }
        return undefined
      },
    } as unknown as Context

    const grouping = new WorkspaceGrouping(ctx, store)
    await grouping.reconcileBindings()

    // Already grouped & manually archived sessions never hit disk.
    expect(openPersistence).not.toHaveBeenCalledWith('session-already-grouped', 'read')
    expect(openPersistence).not.toHaveBeenCalledWith('session-manually-archived', 'read')

    // Orphaned reminder repaired into group workspace.
    expect(groupWs.sessionIds).toContain('session-orphan-reminder')
    expect(groupWs.title).toBe('release-ws')

    // Custom-dir reminder repaired into custom workspace WITHOUT overwriting its title.
    expect(customWs.sessionIds).toContain('session-custom-dir-orphan')
    expect(customWs.title).toBe('custom-existing-title')
    expect(customWs.setTitle).not.toHaveBeenCalled()

    // Missing session skipped cleanly with zero warnings.
    expect(warn).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledWith(expect.stringContaining('session-orphan-reminder'))

    store.close()
  })

  it('recovers overdue reminder attachment when LarkBridgeManager starts before workspaceRegistry activates', async () => {
    const dataDir = makeTempDir()
    const workDir = makeTempDir('dsh-lark-mgr-')
    const store = new LarkBridgeStore(dataDir)

    store.upsertBot({
      id: 'bot-m',
      name: 'BotM',
      enabled: false,
      larkAppId: 'cli_ws_m',
      larkAppSecret: 'sec_ws_m',
      defaultWorkingDir: workDir,
      workspaceName: 'mgr-ws',
    })
    store.upsertReminder({
      id: 'rem-overdue-boot',
      title: 'Boot overdue check',
      prompt: 'Check status',
      scheduledAt: new Date(Date.now() - 10_000).toISOString(),
      status: 'scheduled',
      origin: {
        botId: 'bot-m',
        botName: 'BotM',
        larkAppId: 'cli_ws_m',
        chatType: 'p2p',
        deliveryMode: 'p2p',
        userOpenId: 'ou_owner',
      },
      mentions: [],
      ccMentions: [],
      createdAtMs: Date.now() - 20_000,
      updatedAtMs: Date.now() - 20_000,
    })

    const fake = createFakeWorkspaceRegistry()
    let registryAvailable = false
    let onWorkspaceInject: ((wsCtx: Context) => void) | undefined
    const listeners = new Set<(session: Session, event: SessionEvent) => void>()

    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      get: (key: string) => {
        if (key === 'workspaceRegistry') {
          return registryAvailable ? fake.registry : undefined
        }
        return undefined
      },
      inject: vi.fn((deps: readonly string[], cb: (subCtx: Context) => void) => {
        if (deps.includes('workspaceRegistry')) {
          onWorkspaceInject = cb
        }
        return { dispose: vi.fn() }
      }),
      on: (event: string, fn: (session: Session, event: SessionEvent) => void) => {
        if (event === 'session/event') listeners.add(fn)
        return () => listeners.delete(fn)
      },
      sessions: { get: () => undefined },
      llm: {
        listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
        listConfigurableProviders: () => [],
        listModels: async () => [{ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek' }],
      },
      agents: {
        get: () => undefined,
        create: vi.fn(
          async ({
            sessionId,
            setup,
          }: {
            sessionId: string
            setup?: (c: unknown, a: unknown) => Promise<void>
          }) => {
            const session = {
              id: sessionId,
              header: { cwd: workDir, agentPreset: 'codex' },
              append: vi.fn(),
              snapshotEvents: () => [],
            } as unknown as Session
            const agent = {
              session,
              followup: () => {
                queueMicrotask(() => {
                  for (const fn of listeners) {
                    fn(session, { type: 'turn/start', data: { turn: 1 } } as unknown as SessionEvent)
                    fn(session, {
                      type: 'assistant/message',
                      data: {
                        turn: 1,
                        message: { content: [{ type: 'text', text: '<no_reminder_needed/>' }] },
                      },
                    } as unknown as SessionEvent)
                    fn(session, {
                      type: 'turn/end',
                      data: { turn: 1, reason: { kind: 'completed' } },
                    } as unknown as SessionEvent)
                  }
                })
              },
            }
            await setup?.({}, agent)
            return { agent, dispose: vi.fn(async () => {}) }
          },
        ),
      },
    } as unknown as Context

    const manager = new LarkBridgeManager(
      ctx,
      {
        dataDir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
      },
      store,
    )

    await manager.start()
    // Let the 50ms overdue reminder fire while workspaceRegistry is still unavailable.
    await new Promise((resolve) => setTimeout(resolve, 120))

    const completed = store.getReminder('rem-overdue-boot')
    expect(completed?.status).toBe('archived')
    expect(completed?.resolution).toBe('silent_ok')
    expect(completed?.lastSessionId).toBeTruthy()
    const reminderSessionId = completed!.lastSessionId!
    expect(fake.byPath.size).toBe(0)

    // Now workspaceRegistry finishes Service.init() and activates.
    registryAvailable = true
    onWorkspaceInject?.({
      get: (k: string) => (k === 'workspaceRegistry' ? fake.registry : undefined),
      effect: vi.fn(),
    } as unknown as Context)
    await flushMicrotasks()

    expect(fake.byPath.get(workDir)?.sessionIds).toContain(reminderSessionId)

    await manager.stop()
    store.close()
  })

  it('retries transient attachSession and archiveSession failures on subsequent reconcileBindings and skips already-attached bindings', async () => {
    const dataDir = makeTempDir()
    const workDir = makeTempDir('dsh-lark-retry-')
    const store = new LarkBridgeStore(dataDir)

    store.upsertBot({
      id: 'bot-retry',
      name: 'BotRetry',
      enabled: true,
      larkAppId: 'cli_ws_retry',
      larkAppSecret: 'sec_ws_retry',
      defaultWorkingDir: workDir,
      workspaceName: 'retry-ws',
    })
    store.upsertBinding({
      routeKey: 'cli_ws_retry:oc_1:om_1',
      sessionId: 'session-already-in-ws',
      botId: 'bot-retry',
      larkAppId: 'cli_ws_retry',
      chatType: 'group',
      chatId: 'oc_1',
      workspaceName: 'retry-ws',
      agentPreset: 'codex',
      workingDir: workDir,
      trigger: 'mention',
      hasReplied: true,
      createdAtMs: Date.now() - 10_000,
      lastActivityMs: Date.now() - 5_000,
    })

    const fake = createFakeWorkspaceRegistry()
    const ws = await fake.registry.create(workDir, 'retry-ws')
    ws.sessionIds.push('session-already-in-ws')
    ws.attachSession.mockClear()

    // First attach fails transiently (e.g., header persistence race); second succeeds.
    ws.attachSession.mockRejectedValueOnce(new Error('transient persistence race'))
    // First archive fails transiently; second succeeds.
    fake.registry.archiveSession.mockRejectedValueOnce(new Error('transient lock busy'))

    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      sessions: { get: () => undefined },
      get: (key: string) => {
        if (key === 'workspaceRegistry') return fake.registry
        return undefined
      },
    } as unknown as Context

    const grouping = new WorkspaceGrouping(ctx, store)

    await grouping.attachSession(workDir, 'retry-ws', 'session-transient-attach')
    expect(ws.sessionIds).not.toContain('session-transient-attach')

    const archivedFirst = await grouping.archiveSession('session-transient-archive')
    expect(archivedFirst).toBe(false)
    expect(fake.archivedSessionIds).not.toContain('session-transient-archive')

    // Periodic reconcile flushes both transient failures and skips the already-attached binding.
    await grouping.reconcileBindings()

    expect(ws.sessionIds).toContain('session-transient-attach')
    expect(fake.archivedSessionIds).toContain('session-transient-archive')
    expect(ws.attachSession).not.toHaveBeenCalledWith('session-already-in-ws')

    store.close()
  })

  it('eagerly attaches scheduled turn sessions at user/message start before turn/end completes', async () => {
    const dataDir = makeTempDir()
    const workDir = makeTempDir('dsh-lark-sched-')
    const store = new LarkBridgeStore(dataDir)

    store.upsertBot({
      id: 'bot-s',
      name: 'BotS',
      enabled: true,
      larkAppId: 'cli_ws_s',
      larkAppSecret: 'sec_ws_s',
      defaultWorkingDir: workDir,
      workspaceName: 'sched-ws',
    })
    store.upsertScheduleBinding({
      scheduleId: 'sched-1',
      enabled: true,
      targets: [{ botId: 'bot-s', chatId: 'oc_sched' }],
      deliveryMode: 'chat',
      notifyOn: 'non_empty',
    })

    const fake = createFakeWorkspaceRegistry()
    const listeners = new Set<(session: Session, event: SessionEvent) => void>()

    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      get: (key: string) => {
        if (key === 'workspaceRegistry') return fake.registry
        if (key === 'schedule') {
          return {
            catalog: async () => [
              {
                id: 'sched-1',
                kind: 'daily',
                title: 'Daily Check',
                prompt: 'check',
                status: 'active',
                scheduledAt: new Date().toISOString(),
                target: { kind: 'new', create: { cwd: workDir } },
                involvedSessionIds: ['session-sched-running'],
                lastDelivery: {
                  scheduledAt: new Date().toISOString(),
                  deliveredAt: new Date().toISOString(),
                  messageId: 'msg-sched-1',
                  targetSessionId: 'session-sched-running',
                },
              },
            ],
            view: async () => ({ code: 'schedule_not_found' }),
            run: async () => ({ code: 'schedule_not_found' }),
          }
        }
        return undefined
      },
      inject: vi.fn(() => ({ dispose: vi.fn() })),
      on: (event: string, fn: (session: Session, event: SessionEvent) => void) => {
        if (event === 'session/event') listeners.add(fn)
        return () => listeners.delete(fn)
      },
      sessions: { get: () => undefined },
      llm: {
        listProviders: () => [],
        listConfigurableProviders: () => [],
        listModels: async () => [],
      },
      agents: { get: () => undefined },
    } as unknown as Context

    const manager = new LarkBridgeManager(
      ctx,
      {
        dataDir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 100,
        autoInstallCliAndSkill: false,
      },
      store,
    )

    await manager.start()

    const session = {
      id: 'session-sched-running',
      header: { cwd: workDir },
      snapshotEvents: () => [],
    } as unknown as Session

    for (const fn of listeners) {
      fn(session, { type: 'turn/start', data: { turn: 1 } } as unknown as SessionEvent)
      fn(session, {
        type: 'user/message',
        data: { id: 'msg-sched-1', source: { kind: 'schedule' }, content: [] },
      } as unknown as SessionEvent)
    }

    await flushMicrotasks()
    expect(fake.byPath.get(workDir)?.sessionIds).toContain('session-sched-running')

    await manager.stop()
    store.close()
  })
})
