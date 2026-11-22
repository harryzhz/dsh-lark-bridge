import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { REMINDER_SILENT_SENTINEL } from '@dsh-lark/lark-core'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-session')>()
  return {
    ...actual,
    appendPluginRecord: vi.fn(),
  }
})

import { LarkBridgeManager } from '../src/bridge-manager.js'
import { ensureCliAuthEndpoint } from '../src/cli-support.js'
import { createLarkHttpHandler, type ConnectionAdmitter } from '../src/http-api.js'
import { ProactiveReminderService } from '../src/reminder-service.js'
import { RuntimeCatalog } from '../src/runtime-catalog.js'
import { LarkBridgeStore } from '../src/store.js'
import type { WorkspaceGrouping } from '../src/workspace-grouping.js'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const LARK_BRIDGE_CLI = resolve(THIS_DIR, '../../dsh-bundle/bin/lark-bridge.mjs')

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function makeTempDir(prefix = 'lark-proactive-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function invokeHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
  opts: { method?: string; url: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolvePromise, reject) => {
    const rawBody = opts.body !== undefined ? JSON.stringify(opts.body) : ''
    const req = Readable.from(rawBody ? [Buffer.from(rawBody)] : []) as unknown as IncomingMessage
    req.method = opts.method ?? 'GET'
    req.url = opts.url
    req.headers = opts.headers ?? {}

    let status = 200
    let body = ''
    const res = {
      writeHead(code: number) {
        status = code
        return res
      },
      end(chunk?: string | Buffer) {
        if (chunk) body += chunk.toString()
        resolvePromise({ status, json: body ? JSON.parse(body) : {} })
      },
    } as unknown as ServerResponse

    Promise.resolve(handler(req, res)).catch(reject)
  })
}

describe('ProactiveReminderService one-shot lifecycle, origin auto-routing & confirmation modes', () => {
  it('infers group thread/chat/P2P origins, supports silent/notify/confirm modes with card actions, and archives after one-shot execution', async () => {
    const dataDir = makeTempDir()
    const workDir = makeTempDir()
    const store = new LarkBridgeStore(dataDir)

    store.upsertBot({
      id: 'dsh-agent',
      name: '研发助手',
      enabled: true,
      larkAppId: 'cli_agent',
      larkAppSecret: 'sec_agent',
      defaultWorkingDir: workDir,
      experimental: {
        dreaming: { enabled: false },
        proactive: {
          remindersEnabled: true,
          reminderCreationMode: 'silent',
          autoCodeEnabled: true,
          branchPrefix: 'agent/',
        },
      },
    })
    store.upsertGroup({
      botId: 'dsh-agent',
      chatId: 'oc_release',
      chatName: '发版协同群',
      enabled: true,
    })

    // Seed an active group topic session binding and a P2P binding
    store.upsertBinding({
      routeKey: 'dsh-agent:oc_release:om_topic_root_1',
      botId: 'dsh-agent',
      chatId: 'oc_release',
      chatType: 'group',
      replyToMessageId: 'om_topic_root_1',
      workspaceName: '研发助手',
      sessionId: 'sess-topic-1',
      agentPreset: 'codex',
      workingDir: workDir,
      trigger: 'listener',
      lastActivityMs: Date.now(),
    })
    store.upsertBinding({
      routeKey: 'dsh-agent:p2p:ou_pm_1',
      botId: 'dsh-agent',
      chatId: 'oc_p2p_1',
      chatType: 'p2p',
      userOpenId: 'ou_pm_1',
      userName: 'Taylor',
      workspaceName: '研发助手',
      sessionId: 'sess-p2p-1',
      agentPreset: 'codex',
      workingDir: workDir,
      trigger: 'p2p',
      lastActivityMs: Date.now(),
    })

    const archivedSessions: string[] = []
    const attachedSessions: Array<{ workingDir: string; workspaceName: string; sessionId: string }> = []
    const disposedSessions: string[] = []
    const submittedReminderPrompts: string[] = []
    let nextAgentReply = ''

    const fakeCtx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      agents: {
        create: vi.fn(async ({ sessionId, setup }: { sessionId: string; setup?: (c: unknown, a: unknown) => void }) => {
          const agent = {
            session: { id: sessionId, header: { cwd: workDir, agentPreset: 'codex' } },
          }
          setup?.({}, agent)
          return {
            agent,
            dispose: vi.fn(async () => {
              disposedSessions.push(sessionId)
            }),
          }
        }),
      },
      get: () => undefined,
    } as unknown as Context

    const sentOriginCards: Array<{ chatType: string; deliveryMode: string; card: Record<string, unknown> }> = []
    const patchedCards: Array<{ messageId: string; card: Record<string, unknown> }> = []
    const deliveredOutputs: Array<{ reminderId: string; markdown: string; deliveryMode: string }> = []

    const reminders = new ProactiveReminderService({
      ctx: fakeCtx,
      store,
      runtimes: new RuntimeCatalog(fakeCtx),
      workspaces: {
        attachSession: vi.fn(async (workingDir: string, workspaceName: string, sessionId: string) => {
          attachedSessions.push({ workingDir, workspaceName, sessionId })
        }),
        archiveSession: vi.fn(async (sid: string) => {
          archivedSessions.push(sid)
          return true
        }),
      } as unknown as WorkspaceGrouping,
      runTurn: vi.fn(async (_agent, content) => {
        submittedReminderPrompts.push(content.map((b) => ('text' in b ? b.text : '')).join('\n'))
        return nextAgentReply
      }),
      sendOriginCard: vi.fn(async (origin, card) => {
        sentOriginCards.push({ chatType: origin.chatType, deliveryMode: origin.deliveryMode, card })
        return { messageId: `om_card_${sentOriginCards.length}` }
      }),
      patchOriginCard: vi.fn(async (_botId, messageId, card) => {
        patchedCards.push({ messageId, card })
      }),
      deliverReminderOutput: vi.fn(async ({ item, markdown }) => {
        deliveredOutputs.push({
          reminderId: item.id,
          markdown,
          deliveryMode: item.origin.deliveryMode,
        })
        return { messageId: 'om_delivered_1' }
      }),
    })

    // 1. Silent mode (default) from group topic session -> infers thread origin without sending creation notice
    const silentItem = await reminders.create({
      sessionId: 'sess-topic-1',
      title: '核查下午 17:00 发版是否已执行',
      prompt: '检查本群发版消息，若已完成输出 <no_reminder_needed/>，未完成则提醒 @Sam',
      afterSeconds: 600,
      mentions: [{ openId: 'ou_dev_1', name: 'Sam' }],
    })
    expect(silentItem.status).toBe('scheduled')
    expect(silentItem.origin).toMatchObject({
      botId: 'dsh-agent',
      chatType: 'group',
      chatId: 'oc_release',
      chatName: '发版协同群',
      replyToMessageId: 'om_topic_root_1',
      deliveryMode: 'thread',
    })
    expect(sentOriginCards).toHaveLength(0)

    // Execute when release was ALREADY completed -> `<no_reminder_needed/>` silently archives the reminder
    // while keeping the session visible (attached, unarchived, not disposed) in the workspace!
    nextAgentReply = REMINDER_SILENT_SENTINEL
    const silentResult = await reminders.runNow(silentItem.id)
    expect(silentResult).toMatchObject({
      status: 'archived',
      resolution: 'silent_ok',
    })
    expect(silentResult.lastSessionId).toBeTruthy()
    expect(submittedReminderPrompts[0]).toContain('- 关注人员：Sam(open_id="ou_dev_1")')
    expect(submittedReminderPrompts[0]).not.toContain('- 群成员：')
    expect(submittedReminderPrompts[0]).toContain('lark-bridge members --query <姓名>')
    expect(silentResult.resultSummary).not.toContain('核查')
    expect(deliveredOutputs).toHaveLength(0)
    expect(archivedSessions).toHaveLength(0)
    expect(disposedSessions).toHaveLength(0)
    expect(attachedSessions).toHaveLength(1)
    expect(attachedSessions[0]?.sessionId).toBe(silentResult.lastSessionId)
    expect(store.getManagedSession(silentResult.lastSessionId!)).toMatchObject({
      botId: 'dsh-agent',
      chatId: 'oc_release',
      trigger: 'reminder',
    })

    // 2. Confirm mode from P2P session -> pending_confirm + sends interactive card; approve button activates, then due run delivers & archives!
    const confirmItem = await reminders.create({
      sessionId: 'sess-p2p-1',
      title: '周三截止前核查需求交付状态',
      prompt: '核查需求单状态，未完成则提醒负责人与需求人',
      afterSeconds: 1200,
      creationMode: 'confirm',
    })
    expect(confirmItem.status).toBe('pending_confirm')
    expect(confirmItem.origin).toMatchObject({
      chatType: 'p2p',
      deliveryMode: 'p2p',
      userOpenId: 'ou_pm_1',
      userName: 'Taylor',
    })
    expect(sentOriginCards).toHaveLength(1)

    const approveToast = await reminders.handleCardAction({
      kind: 'lark_reminder_confirm',
      reminderId: confirmItem.id,
      decision: 'approve',
    })
    expect(approveToast).toContain('已确认开启')
    expect(patchedCards).toHaveLength(1)
    expect(store.getReminder(confirmItem.id)?.status).toBe('scheduled')

    nextAgentReply = '需求仍处于联调阶段，尚未合入主干，请及时同步风险。'
    const remindedResult = await reminders.runNow(confirmItem.id)
    expect(remindedResult).toMatchObject({
      status: 'archived',
      resolution: 'reminded',
    })
    expect(deliveredOutputs).toHaveLength(1)
    expect(deliveredOutputs[0]).toMatchObject({
      reminderId: confirmItem.id,
      deliveryMode: 'p2p',
    })

    // 3. Notify mode -> sends notice card with one-click cancel button
    const notifyItem = await reminders.create({
      sessionId: 'sess-topic-1',
      title: '次日 10:00 推送告警优化 MR 提醒',
      prompt: '将夜间准备好的优化分支 MR 发到群里提醒评审',
      afterSeconds: 3600,
      creationMode: 'notify',
      worktree: {
        worktreePath: join(workDir, '.worktrees', 'opt-retry'),
        branch: 'agent/opt-retry',
      },
    })
    expect(notifyItem.status).toBe('scheduled')
    expect(sentOriginCards).toHaveLength(2)

    const cancelToast = await reminders.handleCardAction({
      kind: 'lark_reminder_cancel',
      reminderId: notifyItem.id,
    })
    expect(cancelToast).toContain('已取消')
    expect(store.getReminder(notifyItem.id)).toMatchObject({
      status: 'archived',
      resolution: 'cancelled',
    })

    await reminders.stop()
    expect(disposedSessions).toHaveLength(2)
  })

  it('persists lastSessionId while running, supports async triggerNow, recovers stale running reminders on restart, and resolves reminder agent context', async () => {
    const dataDir = makeTempDir()
    const workDir = makeTempDir()
    const store = new LarkBridgeStore(dataDir)

    store.upsertBot({
      id: 'alert-bot',
      name: 'AlertBot',
      enabled: true,
      larkAppId: 'cli_alert_bot',
      larkAppSecret: 'sec_alert_bot',
      defaultWorkingDir: workDir,
    })
    store.upsertGroup({
      botId: 'alert-bot',
      chatId: 'oc_alert',
      chatName: '核心服务告警群',
      enabled: true,
    })

    let releaseTurn!: (reply: string) => void
    const turnPromise = new Promise<string>((resolveTurn) => {
      releaseTurn = resolveTurn
    })
    const attached: string[] = []
    const renamed: string[] = []
    const staleSid = 'session-interrupted-123'

    const fakeCtx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      sessions: {
        get: (sid: string) =>
          sid === staleSid
            ? {
                id: sid,
                snapshotEvents: () => [
                  {
                    type: 'plugin:lark-bridge/origin',
                    ignorable: true,
                    data: {
                      botId: 'alert-bot',
                      botName: 'AlertBot',
                      larkAppId: 'cli_alert_bot',
                      chatType: 'group',
                      chatId: 'oc_alert',
                      workspaceName: 'core-service',
                      routeKey: 'reminder:rem-stale-1',
                      trigger: 'reminder',
                    },
                  },
                ],
              }
            : undefined,
      },
      agents: {
        create: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
          agent: { session: { id: sessionId, header: { cwd: workDir, agentPreset: 'codex' } } },
          dispose: vi.fn().mockResolvedValue(undefined),
        })),
      },
      get: (service: string) => {
        if (service === 'sessionTitle') {
          return {
            rename: (_s: unknown, t: string) => {
              renamed.push(t)
            },
          }
        }
        return undefined
      },
    } as unknown as Context

    const reminders = new ProactiveReminderService({
      ctx: fakeCtx,
      store,
      runtimes: new RuntimeCatalog(fakeCtx),
      workspaces: {
        attachSession: vi.fn(async (_dir: string, _name: string, sid: string) => {
          attached.push(sid)
        }),
        archiveSession: vi.fn().mockResolvedValue(true),
        listWorkspaceSessionIds: () => [staleSid],
      } as unknown as WorkspaceGrouping,
      runTurn: vi.fn(() => turnPromise),
      sendOriginCard: vi.fn().mockResolvedValue({}),
      patchOriginCard: vi.fn().mockResolvedValue(undefined),
      deliverReminderOutput: vi.fn().mockResolvedValue({ messageId: 'om_out_1' }),
    })

    // 1. Stale running reminder from prior restart (missing lastSessionId) is recovered & backfilled
    store.upsertReminder({
      id: 'rem-stale-1',
      title: '被重启中断的提醒',
      prompt: '检查线上状态',
      scheduledAt: new Date(Date.now() - 60_000).toISOString(),
      status: 'running',
      origin: {
        botId: 'alert-bot',
        botName: 'AlertBot',
        larkAppId: 'cli_alert_bot',
        chatType: 'group',
        chatId: 'oc_alert',
        chatName: '核心服务告警群',
        replyToMessageId: 'om_root_1',
        deliveryMode: 'thread',
      },
      mentions: [],
      createdAtMs: Date.now() - 120_000,
      updatedAtMs: Date.now() - 60_000,
    })

    const recoveredCount = await reminders.recoverStaleRunningReminders()
    expect(recoveredCount).toBe(1)
    expect(store.getReminder('rem-stale-1')).toMatchObject({
      status: 'archived',
      resolution: 'error',
      lastSessionId: staleSid,
      resultSummary: '执行因服务重启中断，已归档',
    })

    // 2. triggerNow returns immediately with status='running' and lastSessionId while turn is in-flight
    const fresh = await reminders.create({
      botId: 'alert-bot',
      chatId: 'oc_alert',
      replyToMessageId: 'om_root_2',
      deliveryMode: 'thread',
      title: '复查服务状态',
      prompt: '核对实例状态',
      afterSeconds: 300,
    })

    const cliAuth = ensureCliAuthEndpoint(dataDir, 'http://127.0.0.1:3880')
    const manager = {
      store,
      cliAuth,
      reminders,
      listBotStatuses: () => [],
    } as unknown as LarkBridgeManager
    const admitter: ConnectionAdmitter = { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }
    const handler = createLarkHttpHandler(fakeCtx, admitter, manager)

    const runRes = await invokeHandler(handler, {
      method: 'POST',
      url: `/api/lark-bridge/reminders/${encodeURIComponent(fresh.id)}/run`,
      body: { async: true },
    })
    expect(runRes.status).toBe(200)
    const runningReminder = runRes.json.reminder as { status: string; lastSessionId?: string }
    expect(runningReminder.status).toBe('running')
    expect(runningReminder.lastSessionId).toBeTruthy()
    expect(attached).toContain(runningReminder.lastSessionId)
    expect(renamed[0]).toBe('提醒 · 复查服务状态')

    // 3. LarkBridgeManager.resolveAgentContext resolves reminder sessions so lark-bridge CLI works out of the box
    const bridgeMgr = new LarkBridgeManager(
      fakeCtx,
      {
        dataDir,
        publicBaseUrl: 'http://127.0.0.1:3880',
        idleSweepIntervalMs: 0,
        maxAuditEvents: 50,
        autoInstallCliAndSkill: false,
      },
      store,
    )
    const resolvedCtx = bridgeMgr.resolveAgentContext(runningReminder.lastSessionId)
    expect(resolvedCtx).toMatchObject({
      bound: true,
      source: 'reminder_session',
      botId: 'alert-bot',
      chatId: 'oc_alert',
      replyToMessageId: 'om_root_2',
      routeKey: `reminder:${fresh.id}`,
    })

    // Complete the in-flight turn and verify archive preserves lastSessionId
    releaseTurn(REMINDER_SILENT_SENTINEL)
    await vi.waitFor(() => {
      expect(store.getReminder(fresh.id)?.status).toBe('archived')
    })
    expect(store.getReminder(fresh.id)).toMatchObject({
      status: 'archived',
      resolution: 'silent_ok',
      lastSessionId: runningReminder.lastSessionId,
    })

    await reminders.stop()
  })
})

describe('Local directory picker HTTP API & lark-bridge worktree CLI', () => {
  it('lists and creates host directories for Owner Web sessions while rejecting CLI tokens with 403', async () => {
    const dataDir = makeTempDir()
    const browseRoot = makeTempDir('lark-fs-browse-')
    mkdirSync(join(browseRoot, 'alpha-service'))
    mkdirSync(join(browseRoot, '.hidden-cache'))
    writeFileSync(join(browseRoot, 'README.md'), '# hello\n', 'utf8')

    const store = new LarkBridgeStore(dataDir)
    const cliAuth = ensureCliAuthEndpoint(dataDir, 'http://127.0.0.1:3880')
    const fakeCtx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      get: () => undefined,
    } as unknown as Context
    const manager = {
      store,
      cliAuth,
      listBotStatuses: () => [],
    } as unknown as LarkBridgeManager
    const admitter: ConnectionAdmitter = { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }
    const handler = createLarkHttpHandler(fakeCtx, admitter, manager)

    // CLI bearer token must be strictly blocked on /fs/dirs
    const cliDenied = await invokeHandler(handler, {
      method: 'GET',
      url: `/api/lark-bridge/fs/dirs?path=${encodeURIComponent(browseRoot)}`,
      headers: { authorization: `Bearer ${cliAuth.token}` },
    })
    expect(cliDenied.status).toBe(403)

    // Owner Web session lists only directories (including hidden flag) and expands ~
    const homeRes = await invokeHandler(handler, {
      method: 'GET',
      url: '/api/lark-bridge/fs/dirs?path=~',
    })
    expect(homeRes.status).toBe(200)
    expect(homeRes.json.path).toBe(homedir())

    const listRes = await invokeHandler(handler, {
      method: 'GET',
      url: `/api/lark-bridge/fs/dirs?path=${encodeURIComponent(browseRoot)}`,
    })
    expect(listRes.status).toBe(200)
    const entries = listRes.json.entries as Array<{ name: string; hidden: boolean }>
    expect(entries).toEqual([
      { name: '.hidden-cache', path: join(browseRoot, '.hidden-cache'), hidden: true },
      { name: 'alpha-service', path: join(browseRoot, 'alpha-service'), hidden: false },
    ])

    // Create a new subdirectory via POST /api/lark-bridge/fs/dirs
    const createRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/lark-bridge/fs/dirs',
      body: { parentPath: browseRoot, name: 'new-workspace' },
    })
    expect(createRes.status).toBe(201)
    expect(createRes.json.path).toBe(join(browseRoot, 'new-workspace'))
    expect(existsSync(join(browseRoot, 'new-workspace'))).toBe(true)
  })

  it('creates isolated Git worktrees under <repoRoot>/.worktrees/<slug> with self-contained .gitignore', () => {
    const repoDir = makeTempDir('lark-worktree-repo-')
    execFileSync('git', ['init', '-b', 'main', repoDir], { stdio: 'ignore' })
    execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' })
    execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test'], { stdio: 'ignore' })
    writeFileSync(join(repoDir, 'index.ts'), 'export const ok = true\n', 'utf8')
    execFileSync('git', ['-C', repoDir, 'add', 'index.ts'], { stdio: 'ignore' })
    execFileSync('git', ['-C', repoDir, 'commit', '-m', 'init'], { stdio: 'ignore' })

    const out = JSON.parse(
      execFileSync(
        process.execPath,
        [LARK_BRIDGE_CLI, 'worktree', 'create', 'fix-alert-timeout', '--prefix', 'agent/', '--cwd', repoDir],
        { encoding: 'utf8' },
      ),
    ) as { ok: boolean; worktreePath: string; branch: string }

    expect(out.ok).toBe(true)
    expect(out.branch).toBe('agent/fix-alert-timeout')
    expect(existsSync(join(repoDir, '.worktrees', '.gitignore'))).toBe(true)
    expect(readFileSync(join(repoDir, '.worktrees', '.gitignore'), 'utf8')).toBe('*\n')
    expect(existsSync(join(out.worktreePath, 'index.ts'))).toBe(true)
    expect(existsSync(join(repoDir, '.local'))).toBe(false)

    // Git status in main repo must remain completely clean thanks to .worktrees/.gitignore
    const statusOut = execFileSync('git', ['-C', repoDir, 'status', '--porcelain'], {
      encoding: 'utf8',
    }).trim()
    expect(statusOut).toBe('')
  })
})
