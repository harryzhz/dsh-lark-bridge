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
import { MemoryService } from '../src/memory-service.js'
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
    expect(submittedReminderPrompts[0]).toContain('- 主负责人（必 @）：Sam(open_id="ou_dev_1")')
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

    // Missing operator or non-origin P2P user must fail closed
    const missingOpToast = await reminders.handleCardAction({
      kind: 'lark_reminder_confirm',
      reminderId: confirmItem.id,
      decision: 'approve',
    })
    expect(missingOpToast).toContain('无法确认操作者身份')
    expect(store.getReminder(confirmItem.id)?.status).toBe('pending_confirm')

    const strangerP2pToast = await reminders.handleCardAction(
      {
        kind: 'lark_reminder_confirm',
        reminderId: confirmItem.id,
        decision: 'approve',
      },
      { operatorOpenId: 'ou_other_user' },
    )
    expect(strangerP2pToast).toContain('仅本人或智能体管理员')
    expect(store.getReminder(confirmItem.id)?.status).toBe('pending_confirm')

    const approveToast = await reminders.handleCardAction(
      {
        kind: 'lark_reminder_confirm',
        reminderId: confirmItem.id,
        decision: 'approve',
      },
      { operatorOpenId: 'ou_pm_1' },
    )
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
      mentions: [{ openId: 'ou_dev_1', name: 'Sam' }],
      ccMentions: [{ openId: 'ou_pm_1', name: 'Taylor' }],
      worktree: {
        worktreePath: join(workDir, '.worktrees', 'opt-retry'),
        branch: 'agent/opt-retry',
      },
    })
    expect(notifyItem.status).toBe('scheduled')
    expect(sentOriginCards).toHaveLength(2)

    // Group card action fails closed when adminUsers is empty
    const unconfiguredAdminToast = await reminders.handleCardAction(
      {
        kind: 'lark_reminder_cancel',
        reminderId: notifyItem.id,
      },
      { operatorOpenId: 'ou_member_1' },
    )
    expect(unconfiguredAdminToast).toContain('未配置智能体管理员')
    expect(store.getReminder(notifyItem.id)?.status).toBe('scheduled')

    // Configure adminUsers: non-admin rejected, admin succeeds
    const existingBot = store.getBot('dsh-agent')!
    store.upsertBot({ ...existingBot, adminUsers: ['ou_admin_1'] })

    const nonAdminToast = await reminders.handleCardAction(
      {
        kind: 'lark_reminder_cancel',
        reminderId: notifyItem.id,
      },
      { operatorOpenId: 'ou_member_1' },
    )
    expect(nonAdminToast).toContain('仅智能体管理员')
    expect(store.getReminder(notifyItem.id)?.status).toBe('scheduled')

    const cancelToast = await reminders.handleCardAction(
      {
        kind: 'lark_reminder_cancel',
        reminderId: notifyItem.id,
      },
      { operatorOpenId: 'ou_admin_1' },
    )
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

    const disposeSpy = vi.fn().mockResolvedValue(undefined)
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
          dispose: disposeSpy,
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

    // 1. Stale running reminder from prior restart (within freshness window & retryCount=0)
    //    is automatically requeued once with backfilled lastSessionId instead of being dropped!
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
      status: 'scheduled',
      retryCount: 1,
      lastSessionId: staleSid,
    })

    // Second interruption after retry budget is exhausted archives as error
    const requeued = store.getReminder('rem-stale-1')!
    store.upsertReminder({ ...requeued, status: 'running' })
    const secondRecovered = await reminders.recoverStaleRunningReminders()
    expect(secondRecovered).toBe(1)
    expect(store.getReminder('rem-stale-1')).toMatchObject({
      status: 'archived',
      resolution: 'error',
      retryCount: 1,
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
      mentions: [{ openId: 'ou_oncall_1', name: 'Alex' }],
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

    // Complete the in-flight turn and verify archive preserves lastSessionId (handle stays managed until idle sweep)
    releaseTurn(REMINDER_SILENT_SENTINEL)
    await vi.waitFor(() => {
      expect(store.getReminder(fresh.id)?.status).toBe('archived')
    })
    expect(disposeSpy).not.toHaveBeenCalled()
    expect(store.getReminder(fresh.id)).toMatchObject({
      status: 'archived',
      resolution: 'silent_ok',
      lastSessionId: runningReminder.lastSessionId,
    })

    // 4. Shutdown during ctx.agents.create leaves reminder in `running` for next startup retry
    let rejectCreate!: (err: Error) => void
    ;(fakeCtx.agents.create as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectCreate = reject
        }),
    )
    const shutRem = await reminders.create({
      botId: 'alert-bot',
      chatId: 'oc_alert',
      title: '停机期间启动的提醒',
      prompt: '核查状态',
      mentions: [{ openId: 'ou_oncall_1', name: 'Alex' }],
      afterSeconds: 300,
    })
    const execPromise = reminders.triggerNow(shutRem.id)
    await vi.waitFor(() => expect(rejectCreate).toBeTypeOf('function'))
    const stopPromise = reminders.stop()
    rejectCreate(new Error('host shutting down'))
    await Promise.all([execPromise, stopPromise])
    expect(store.getReminder(shutRem.id)?.status).toBe('running')
  })

  it('enforces prompt length cap, reminder chain depth/TTL/backoff circuit breaker, and same-thread duplicate guard', async () => {
    const dataDir = makeTempDir()
    const workDir = makeTempDir()
    const store = new LarkBridgeStore(dataDir)

    store.upsertBot({
      id: 'guard-bot',
      name: 'GuardBot',
      enabled: true,
      larkAppId: 'cli_guard',
      larkAppSecret: 'sec_guard',
      defaultWorkingDir: workDir,
    })
    store.upsertGroup({
      botId: 'guard-bot',
      chatId: 'oc_ops',
      chatName: '告警群',
      enabled: true,
    })

    const submittedPrompts: string[] = []
    let turnHandler: (sessionId: string) => Promise<string> = async () => REMINDER_SILENT_SENTINEL

    const fakeCtx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      agents: {
        create: vi.fn(async ({ sessionId, setup }: { sessionId: string; setup?: (c: unknown, a: unknown) => void }) => {
          const agent = { session: { id: sessionId, header: { cwd: workDir, agentPreset: 'codex' } } }
          setup?.({}, agent)
          return { agent, dispose: vi.fn().mockResolvedValue(undefined) }
        }),
      },
      get: () => undefined,
    } as unknown as Context

    const reminders = new ProactiveReminderService({
      ctx: fakeCtx,
      store,
      runtimes: new RuntimeCatalog(fakeCtx),
      workspaces: {
        attachSession: vi.fn().mockResolvedValue(undefined),
        archiveSession: vi.fn().mockResolvedValue(true),
      } as unknown as WorkspaceGrouping,
      runTurn: vi.fn(async (agent, content) => {
        submittedPrompts.push(content.map((b) => ('text' in b ? b.text : '')).join('\n'))
        return turnHandler(String(agent.session.id))
      }),
      sendOriginCard: vi.fn().mockResolvedValue({}),
      patchOriginCard: vi.fn().mockResolvedValue(undefined),
      deliverReminderOutput: vi.fn().mockResolvedValue({ messageId: 'om_out_guard' }),
    })

    // Use local daytime 10:00 so default overnight Quiet Hours (00:00-08:00) do not defer chain hops on UTC CI runners.
    const baseNow = new Date(2026, 10, 24, 10, 0, 0).getTime()

    // 1. Oversized prompt (> 2400 chars) is rejected immediately
    await expect(
      reminders.create(
        {
          botId: 'guard-bot',
          chatId: 'oc_ops',
          replyToMessageId: 'om_root_guard',
          title: '超长提醒测试',
          prompt: 'x'.repeat(2401),
          afterSeconds: 1800,
        },
        baseNow,
      ),
    ).rejects.toThrow('提醒指令过长')

    // 2. Root reminder created normally (depth 0)
    const ownerMentions = [{ openId: 'ou_owner_guard', name: 'Sam' }]
    const root = await reminders.create(
      {
        botId: 'guard-bot',
        chatId: 'oc_ops',
        replyToMessageId: 'om_root_guard',
        title: '核查同步任务',
        prompt: '核查同步任务是否完成',
        mentions: ownerMentions,
        afterSeconds: 1800,
      },
      baseNow,
    )
    expect(root.chainDepth).toBeUndefined()

    // 3. Duplicate active reminder on the exact same thread is rejected
    await expect(
      reminders.create(
        {
          botId: 'guard-bot',
          chatId: 'oc_ops',
          replyToMessageId: 'om_root_guard',
          title: '重复的同步核查',
          prompt: '重复核查',
          mentions: ownerMentions,
          afterSeconds: 1800,
        },
        baseNow + 10_000,
      ),
    ).rejects.toThrow('当前话题已存在待触发提醒')

    // 4. Chain hop 1: backoff < 30 min rejected; >= 30 min succeeds and inherits rootReminderId
    let hop1Id = ''
    turnHandler = async (sid) => {
      await expect(
        reminders.create(
          {
            sessionId: sid,
            botId: 'guard-bot',
            chatId: 'oc_ops',
            replyToMessageId: 'om_root_guard',
            title: '核查同步任务',
            prompt: '过密续查',
            afterSeconds: 300,
          },
          baseNow + 1800_000,
        ),
      ).rejects.toThrow('指数退避保护')

      const hop1 = await reminders.create(
        {
          sessionId: sid,
          botId: 'guard-bot',
          chatId: 'oc_ops',
          replyToMessageId: 'om_root_guard',
          title: '核查同步任务',
          prompt: '第 1 次续查',
          afterSeconds: 1800,
        },
        baseNow + 1800_000,
      )
      hop1Id = hop1.id
      expect(hop1.rootReminderId).toBe(root.id)
      expect(hop1.parentReminderId).toBe(root.id)
      expect(hop1.chainDepth).toBe(1)
      return REMINDER_SILENT_SENTINEL
    }
    await reminders.runNow(root.id, baseNow + 1800_000)

    // 5. Hop 2 (after 60 min) -> Hop 3 (after 120 min) -> Hop 4 MUST be blocked by maxChainDepth=3!
    let hop2Id = ''
    turnHandler = async (sid) => {
      const hop2 = await reminders.create(
        {
          sessionId: sid,
          botId: 'guard-bot',
          chatId: 'oc_ops',
          replyToMessageId: 'om_root_guard',
          title: '核查同步任务',
          prompt: '第 2 次续查',
          afterSeconds: 3600,
        },
        baseNow + 3600_000,
      )
      hop2Id = hop2.id
      expect(hop2.chainDepth).toBe(2)
      return REMINDER_SILENT_SENTINEL
    }
    await reminders.runNow(hop1Id, baseNow + 3600_000)

    let hop3Id = ''
    turnHandler = async (sid) => {
      // Exceeding 6h total chain window is also blocked
      await expect(
        reminders.create(
          {
            sessionId: sid,
            botId: 'guard-bot',
            chatId: 'oc_ops',
            replyToMessageId: 'om_root_guard',
            title: '核查同步任务',
            prompt: '超窗续查',
            afterSeconds: 5 * 3600,
          },
          baseNow + 7200_000,
        ),
      ).rejects.toThrow('最长自动续查窗口')

      const hop3 = await reminders.create(
        {
          sessionId: sid,
          botId: 'guard-bot',
          chatId: 'oc_ops',
          replyToMessageId: 'om_root_guard',
          title: '核查同步任务',
          prompt: '第 3 次最终续查',
          afterSeconds: 7200,
        },
        baseNow + 7200_000,
      )
      hop3Id = hop3.id
      expect(hop3.chainDepth).toBe(3)
      return REMINDER_SILENT_SENTINEL
    }
    await reminders.runNow(hop2Id, baseNow + 7200_000)

    turnHandler = async (sid) => {
      // Depth 4 MUST fail closed!
      await expect(
        reminders.create(
          {
            sessionId: sid,
            botId: 'guard-bot',
            chatId: 'oc_ops',
            replyToMessageId: 'om_root_guard',
            title: '核查同步任务',
            prompt: '第 4 次续查（应被拒绝）',
            afterSeconds: 7200,
          },
          baseNow + 14400_000,
        ),
      ).rejects.toThrow('链式续查上限')
      return REMINDER_SILENT_SENTINEL
    }
    await reminders.runNow(hop3Id, baseNow + 14400_000)
    // Prompt injected on depth=3 explicitly warns agent not to re-chain
    expect(submittedPrompts[submittedPrompts.length - 1]).toContain('本轮为链末次核查')
    expect(submittedPrompts[submittedPrompts.length - 1]).toContain('lark-bridge silence')

    await reminders.stop()
  })

  it('dispatches multiple due reminders concurrently in tick() up to concurrency cap and defers normal reminders during Quiet Hours while allowing high urgency', async () => {
    const dataDir = makeTempDir()
    const workDir = makeTempDir()
    const store = new LarkBridgeStore(dataDir)

    store.upsertBot({
      id: 'quiet-bot',
      name: 'QuietBot',
      enabled: true,
      larkAppId: 'cli_quiet',
      larkAppSecret: 'sec_quiet',
      defaultWorkingDir: workDir,
      experimental: {
        dreaming: { enabled: false },
        proactive: {
          remindersEnabled: true,
          reminderCreationMode: 'silent',
          quietHoursEnabled: true,
          quietHoursStart: '23:00',
          quietHoursEnd: '09:00',
          autoCodeEnabled: false,
          branchPrefix: 'agent/',
        },
      },
    })
    store.upsertGroup({
      botId: 'quiet-bot',
      chatId: 'oc_ops',
      chatName: '值班群',
      enabled: true,
    })

    const activeResolvers: Array<(reply: string) => void> = []
    let maxConcurrentSeen = 0
    let currentConcurrent = 0

    const fakeCtx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      agents: {
        create: vi.fn(async ({ sessionId, setup }: { sessionId: string; setup?: (c: unknown, a: unknown) => void }) => {
          const agent = { session: { id: sessionId, header: { cwd: workDir, agentPreset: 'codex' } } }
          setup?.({}, agent)
          return { agent, dispose: vi.fn().mockResolvedValue(undefined) }
        }),
      },
      get: () => undefined,
    } as unknown as Context

    const reminders = new ProactiveReminderService({
      ctx: fakeCtx,
      store,
      runtimes: new RuntimeCatalog(fakeCtx),
      workspaces: {
        attachSession: vi.fn().mockResolvedValue(undefined),
        archiveSession: vi.fn().mockResolvedValue(true),
      } as unknown as WorkspaceGrouping,
      runTurn: vi.fn(async () => {
        currentConcurrent += 1
        maxConcurrentSeen = Math.max(maxConcurrentSeen, currentConcurrent)
        try {
          return await new Promise<string>((resolve) => {
            activeResolvers.push(resolve)
          })
        } finally {
          currentConcurrent -= 1
        }
      }),
      sendOriginCard: vi.fn().mockResolvedValue({}),
      patchOriginCard: vi.fn().mockResolvedValue(undefined),
      deliverReminderOutput: vi.fn().mockResolvedValue({ messageId: 'om_quiet_out' }),
    })

    // 1. Quiet Hours: normal reminder scheduled at local 01:30 defers to 09:00 same day; high urgency stays at 01:30!
    const quietMentions = [{ openId: 'ou_quiet_owner', name: 'Alex' }]
    const nightNow = new Date(2026, 10, 24, 1, 0, 0).getTime()
    const normalNight = await reminders.create(
      {
        botId: 'quiet-bot',
        chatId: 'oc_ops',
        replyToMessageId: 'om_night_normal',
        title: '常规任务核查',
        prompt: '核查常规任务状态',
        mentions: quietMentions,
        afterSeconds: 1800,
      },
      nightNow,
    )
    const deferredDate = new Date(normalNight.scheduledAt)
    expect(deferredDate.getHours()).toBe(9)
    expect(deferredDate.getMinutes()).toBe(0)
    expect(normalNight.deferredFromScheduledAt).toBe(new Date(nightNow + 1800_000).toISOString())

    const highNight = await reminders.create(
      {
        botId: 'quiet-bot',
        chatId: 'oc_ops',
        replyToMessageId: 'om_night_high',
        title: 'P0 止损复查',
        prompt: '核查 P0 止损指标',
        mentions: quietMentions,
        urgency: 'high',
        afterSeconds: 1800,
      },
      nightNow,
    )
    expect(highNight.urgency).toBe('high')
    expect(highNight.deferredFromScheduledAt).toBeUndefined()
    expect(new Date(highNight.scheduledAt).getHours()).toBe(1)

    await reminders.cancel(normalNight.id)
    await reminders.cancel(highNight.id)

    // 2. Concurrent tick(): create 4 due reminders (all daytime); tick() launches 3 concurrently without blocking, then drains #4 when slot frees!
    const dayNow = new Date(2026, 10, 24, 14, 0, 0).getTime()
    const dueIds: string[] = []
    for (let i = 0; i < 4; i += 1) {
      const r = await reminders.create(
        {
          botId: 'quiet-bot',
          chatId: 'oc_ops',
          replyToMessageId: `om_conc_${i}`,
          title: `并发核查 ${i}`,
          prompt: `检查事项 ${i}`,
          mentions: quietMentions,
          afterSeconds: 60,
        },
        dayNow,
      )
      dueIds.push(r.id)
    }

    // tick() resolves immediately while all 3 launched turns are still in flight!
    await reminders.tick(dayNow + 120_000)
    await vi.waitFor(() => expect(activeResolvers).toHaveLength(3))
    expect(maxConcurrentSeen).toBe(3)
    expect(store.getReminder(dueIds[3]!)?.status).toBe('scheduled')

    // Complete 1 turn -> 4th reminder automatically drains into the freed slot!
    activeResolvers.shift()!(REMINDER_SILENT_SENTINEL)
    await vi.waitFor(() => expect(store.getReminder(dueIds[3]!)?.status).toBe('running'))
    while (activeResolvers.length > 0) {
      activeResolvers.shift()!(REMINDER_SILENT_SENTINEL)
    }
    await vi.waitFor(() => {
      for (const id of dueIds) {
        expect(store.getReminder(id)?.status).toBe('archived')
      }
    })

    await reminders.stop()
  })

  it('requires at least one primary owner mention on group reminders, hydrates missing names, formats ccMentions, and supports adaptive delegation chain deferrals', async () => {
    const dataDir = makeTempDir()
    const workDir = makeTempDir()
    const store = new LarkBridgeStore(dataDir)

    store.upsertBot({
      id: 'del-bot',
      name: 'DelegationBot',
      enabled: true,
      larkAppId: 'cli_del',
      larkAppSecret: 'sec_del',
      defaultWorkingDir: workDir,
      experimental: {
        dreaming: { enabled: false },
        proactive: {
          remindersEnabled: true,
          delegationFollowupEnabled: true,
          reminderCreationMode: 'silent',
          quietHoursEnabled: true,
          quietHoursStart: '00:00',
          quietHoursEnd: '08:00',
          autoCodeEnabled: false,
          branchPrefix: 'agent/',
        },
      },
    })
    store.upsertGroup({
      botId: 'del-bot',
      chatId: 'oc_collab',
      chatName: '研发协作群',
      enabled: true,
    })

    const fakeCtx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      agents: {
        create: vi.fn(async ({ sessionId, setup }: { sessionId: string; setup?: (c: unknown, a: unknown) => void }) => {
          const agent = { session: { id: sessionId, header: { cwd: workDir, agentPreset: 'codex' } } }
          setup?.({}, agent)
          return { agent, dispose: vi.fn().mockResolvedValue(undefined) }
        }),
      },
      get: () => undefined,
    } as unknown as Context

    const delivered: Array<{ markdown: string; mentions: unknown; ccMentions: unknown }> = []
    let turnHandler: (sessionId: string) => Promise<string> = async () => REMINDER_SILENT_SENTINEL

    const reminders = new ProactiveReminderService({
      ctx: fakeCtx,
      store,
      runtimes: new RuntimeCatalog(fakeCtx),
      workspaces: {
        attachSession: vi.fn().mockResolvedValue(undefined),
        archiveSession: vi.fn().mockResolvedValue(true),
      } as unknown as WorkspaceGrouping,
      resolveMemberName: async (_botId, _chatId, openId) => {
        if (openId === 'ou_bob') return 'Bob'
        if (openId === 'ou_alex') return 'Alex'
        return undefined
      },
      runTurn: vi.fn(async (agent) => turnHandler(String(agent.session.id))),
      sendOriginCard: vi.fn().mockResolvedValue({}),
      patchOriginCard: vi.fn().mockResolvedValue(undefined),
      deliverReminderOutput: vi.fn(async ({ item, markdown }) => {
        const formatted = `<at id="${item.mentions[0]?.openId}">${item.mentions[0]?.name}</at>\n\n${markdown}\n\ncc <at id="${item.ccMentions[0]?.openId}">${item.ccMentions[0]?.name}</at>`
        delivered.push({ markdown: formatted, mentions: item.mentions, ccMentions: item.ccMentions })
        return { messageId: 'om_del_sent', deliveredMarkdown: formatted }
      }),
    })

    const baseNow = new Date(2026, 10, 24, 15, 0, 0).getTime()

    // 1. Group reminder WITHOUT mentions MUST fail fast
    await expect(
      reminders.create(
        {
          botId: 'del-bot',
          chatId: 'oc_collab',
          replyToMessageId: 'om_no_mention',
          title: '缺负责人提醒',
          prompt: '检查状态',
          afterSeconds: 600,
        },
        baseNow,
      ),
    ).rejects.toThrow('群聊提醒必须至少指定一位主负责人')

    // 2. Delegation reminder hydrates empty names and deduplicates ccMentions against mentions
    const rootDel = await reminders.create(
      {
        botId: 'del-bot',
        chatId: 'oc_collab',
        replyToMessageId: 'om_del_root',
        kind: 'delegation',
        title: '跟进线上登录 502 排查',
        prompt: '检查 Bob 是否已处理并同步结果',
        mentions: [{ openId: 'ou_bob', name: '' }],
        ccMentions: [
          { openId: 'ou_bob', name: '' },
          { openId: 'ou_alex', name: '' },
        ],
        afterSeconds: 600,
      },
      baseNow,
    )
    expect(rootDel.kind).toBe('delegation')
    expect(rootDel.mentions).toEqual([{ openId: 'ou_bob', name: 'Bob' }])
    expect(rootDel.ccMentions).toEqual([{ openId: 'ou_alex', name: 'Alex' }])

    // 3. Updating group reminder to empty mentions is also rejected
    expect(() => reminders.update(rootDel.id, { mentions: [] })).toThrow('至少保留一位主负责人')

    // 4. Chained delegation deferral: allows 10m (600s) hop-1 backoff (rejects < 600s),
    //    auto-inherits kind/mentions/ccMentions from parent, and allows > 6h (within 24h) window!
    let hop1Id = ''
    turnHandler = async (sid) => {
      await expect(
        reminders.create(
          {
            sessionId: sid,
            botId: 'del-bot',
            chatId: 'oc_collab',
            replyToMessageId: 'om_del_root',
            title: '过短顺延',
            prompt: '5 分钟后复查',
            afterSeconds: 300,
          },
          baseNow + 600_000,
        ),
      ).rejects.toThrow('指数退避保护')

      const hop1 = await reminders.create(
        {
          sessionId: sid,
          botId: 'del-bot',
          chatId: 'oc_collab',
          replyToMessageId: 'om_del_root',
          title: '顺延复查线上登录 502 排查',
          prompt: 'Bob 已回应正在看，10 分钟后复查最终结果',
          afterSeconds: 600,
        },
        baseNow + 600_000,
      )
      hop1Id = hop1.id
      expect(hop1.kind).toBe('delegation')
      expect(hop1.mentions).toEqual([{ openId: 'ou_bob', name: 'Bob' }])
      expect(hop1.ccMentions).toEqual([{ openId: 'ou_alex', name: 'Alex' }])
      expect(hop1.chainDepth).toBe(1)
      return REMINDER_SILENT_SENTINEL
    }
    await reminders.runNow(rootDel.id, baseNow + 600_000)

    // Hop 2 scheduled 10 hours later (passes 24h delegation window + shifts out of 00:00-08:00 quiet hours to 08:00!)
    let hop2Id = ''
    turnHandler = async (sid) => {
      const hop2 = await reminders.create(
        {
          sessionId: sid,
          botId: 'del-bot',
          chatId: 'oc_collab',
          replyToMessageId: 'om_del_root',
          title: '次日顺延复查',
          prompt: '确认最终处理结论',
          afterSeconds: 10 * 3600,
        },
        baseNow + 1200_000,
      )
      hop2Id = hop2.id
      expect(hop2.chainDepth).toBe(2)
      const deferred = new Date(hop2.scheduledAt)
      expect(deferred.getHours()).toBe(8)
      expect(deferred.getMinutes()).toBe(0)
      expect(hop2.deferredFromScheduledAt).toBeTruthy()
      return REMINDER_SILENT_SENTINEL
    }
    await reminders.runNow(hop1Id, baseNow + 1200_000)

    // Final execution sends reminder with owner + cc recorded in resultSummary
    turnHandler = async () => '线上 502 排查暂未见进展同步，方便确认下当前状态吗？'
    const finalRes = await reminders.runNow(hop2Id)
    expect(finalRes.resolution).toBe('reminded')
    expect(finalRes.resultSummary).toContain('<at id="ou_bob">Bob</at>')
    expect(finalRes.resultSummary).toContain('cc <at id="ou_alex">Alex</at>')
    expect(delivered).toHaveLength(1)

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

  it('injects bot/group <role> and query-aware scoped <memory> into reminder trigger prompts without empty-memory bloat or cross-chat leakage', async () => {
    const dataDir = makeTempDir()
    const workDir = makeTempDir()
    const store = new LarkBridgeStore(dataDir)
    const memory = new MemoryService(dataDir, store)

    store.upsertBot({
      id: 'dsh-agent',
      name: '工程助手',
      enabled: true,
      larkAppId: 'cli_agent',
      larkAppSecret: 'sec_agent',
      defaultWorkingDir: workDir,
      role: {
        enabled: true,
        name: '研发协作助手',
        systemPrompt: '沟通简洁直接，结论先行。',
      },
      experimental: {
        dreaming: { enabled: true },
        proactive: {
          remindersEnabled: true,
          reminderCreationMode: 'silent',
        },
      },
    })
    store.upsertGroup({
      botId: 'dsh-agent',
      chatId: 'oc_release',
      chatName: '发版协同群',
      enabled: true,
      role: {
        mode: 'append',
        name: '',
        systemPrompt: '本群发版核查必须先核对灰度错误率。',
      },
    })

    const submittedPrompts: string[] = []
    const fakeCtx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      agents: {
        create: vi.fn(async ({ sessionId, setup }: { sessionId: string; setup?: (c: unknown, a: unknown) => void }) => {
          const agent = {
            session: { id: sessionId, header: { cwd: workDir, agentPreset: 'codex' } },
          }
          setup?.({}, agent)
          return { agent, dispose: vi.fn(async () => {}) }
        }),
      },
      get: () => undefined,
    } as unknown as Context

    const reminders = new ProactiveReminderService({
      ctx: fakeCtx,
      store,
      runtimes: new RuntimeCatalog(fakeCtx),
      workspaces: {
        attachSession: vi.fn(async () => {}),
        archiveSession: vi.fn(async () => true),
      } as unknown as WorkspaceGrouping,
      memory,
      runTurn: vi.fn(async (_agent, content) => {
        submittedPrompts.push(content.map((b) => ('text' in b ? b.text : '')).join('\n'))
        return REMINDER_SILENT_SENTINEL
      }),
      sendOriginCard: vi.fn(async () => ({ messageId: 'om_card_1' })),
      patchOriginCard: vi.fn(async () => {}),
      deliverReminderOutput: vi.fn(async () => ({ messageId: 'om_out_1' })),
    })

    // 1. Empty memory store: injects <role> + <reminder_trigger>, omits <memory> even when dreaming is enabled
    const emptyMemItem = await reminders.create({
      botId: 'dsh-agent',
      chatId: 'oc_release',
      title: '核查下午发版',
      prompt: '检查群内发版状态，未完成则同步最新进展',
      afterSeconds: 300,
      mentions: [{ openId: 'ou_dev_1', name: 'Sam' }],
    })
    await reminders.runNow(emptyMemItem.id)
    expect(submittedPrompts[0]?.match(/<system_reminder>/g)).toHaveLength(1)
    expect(submittedPrompts[0]).toContain('<role name="研发协作助手">')
    expect(submittedPrompts[0]).toContain('本群发版核查必须先核对灰度错误率。')
    expect(submittedPrompts[0]).not.toContain('<memory ')
    expect(submittedPrompts[0]).toContain('<reminder_trigger ')

    // 2. Seed bot feedback, current-chat, workspace, and other-chat memories
    memory.upsert({
      botId: 'dsh-agent',
      scope: 'bot',
      type: 'feedback',
      title: '群聊跟进提醒措辞：禁止将语气提示词念进正文',
      content: '群聊跟进评审进展时直接说人话，严禁把提示词中的语气标签字面写进消息正文。',
      tags: ['reminder', '跟进', '评审'],
    })
    memory.upsert({
      botId: 'dsh-agent',
      scope: 'chat',
      scopeId: 'oc_release',
      type: 'project',
      title: '发版群灰度门槛为错误率低于千分之一',
      content: '发版核查需确认灰度窗口满 15 分钟且错误率低于 0.1%。',
    })
    memory.upsert({
      botId: 'dsh-agent',
      scope: 'workspace',
      scopeId: workDir,
      type: 'reference',
      title: '发布回滚手册位于 docs/runbook.md',
      content: '异常时按 docs/runbook.md 执行回滚。',
    })
    memory.upsert({
      botId: 'dsh-agent',
      scope: 'chat',
      scopeId: 'oc_other_secret',
      type: 'feedback',
      title: '其他群专属机密流程',
      content: '禁止泄露到其他群。',
    })

    const seededItem = await reminders.create({
      botId: 'dsh-agent',
      chatId: 'oc_release',
      kind: 'delegation',
      title: '跟进 PR 评审进展',
      prompt: '核查话题与主群消息流，无进展则直接 @ Sam 询问当前评审进展',
      afterSeconds: 300,
      mentions: [{ openId: 'ou_dev_1', name: 'Sam' }],
      ccMentions: [{ openId: 'ou_pm_1', name: 'Taylor' }],
    })
    await reminders.runNow(seededItem.id)

    const promptWithMemory = submittedPrompts[1] ?? ''
    expect(promptWithMemory.match(/<system_reminder>/g)).toHaveLength(1)
    expect(promptWithMemory.indexOf('<role ')).toBeLessThan(promptWithMemory.indexOf('<memory '))
    expect(promptWithMemory.indexOf('<memory ')).toBeLessThan(promptWithMemory.indexOf('<reminder_trigger '))
    expect(promptWithMemory).toContain('群聊跟进提醒措辞：禁止将语气提示词念进正文')
    // Query-aware expansion surfaces the feedback content inline because title/prompt hit 跟进 + 评审
    expect(promptWithMemory).toContain('直接说人话')
    expect(promptWithMemory).toContain('发版群灰度门槛为错误率低于千分之一')
    expect(promptWithMemory).toContain('发布回滚手册位于 docs/runbook.md')
    expect(promptWithMemory).not.toContain('其他群专属机密流程')
    expect(promptWithMemory).not.toContain('温和')
  })

  it('keeps in-flight reminders running for startup recovery when shutdownSignal aborts before reminders.stop()', async () => {
    const dataDir = makeTempDir()
    const workDir = makeTempDir()
    const store = new LarkBridgeStore(dataDir)

    store.upsertBot({
      id: 'ops-bot',
      name: 'OpsBot',
      enabled: true,
      larkAppId: 'cli_ops_1',
      larkAppSecret: 'sec_test',
      defaultWorkingDir: workDir,
    })
    store.upsertGroup({
      botId: 'ops-bot',
      chatId: 'oc_ops_shutdown',
      chatName: '值班告警群',
      enabled: true,
    })

    const shutdownController = new AbortController()
    let turnStarted!: () => void
    const turnStartedPromise = new Promise<void>((resolve) => {
      turnStarted = resolve
    })

    const fakeCtx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      agents: {
        create: vi.fn(async ({ sessionId, setup }: { sessionId: string; setup?: (c: unknown, a: unknown) => void }) => {
          const agent = { session: { id: sessionId, header: { cwd: workDir, agentPreset: 'codex' } } }
          setup?.({}, agent)
          return { agent, dispose: vi.fn().mockResolvedValue(undefined) }
        }),
      },
      get: () => undefined,
    } as unknown as Context

    const runtimes = {
      resolveAgentLaunch: vi.fn(async () => ({
        provider: 'codex-cli',
        model: 'gpt-6.1-sol',
        mountPreset: vi.fn(async () => {}),
      })),
    } as unknown as RuntimeCatalog

    const workspaces = {
      resolveBotWorkspaceName: () => 'OpsBot',
      resolveGroupWorkspaceName: () => 'OpsBot / 值班告警群',
      attachSession: vi.fn(async () => {}),
    } as unknown as WorkspaceGrouping

    const reminders = new ProactiveReminderService({
      ctx: fakeCtx,
      store,
      runtimes,
      workspaces,
      shutdownSignal: shutdownController.signal,
      resolveMemberName: async () => undefined,
      runTurn: () =>
        new Promise<string>((_resolve, reject) => {
          turnStarted()
          shutdownController.signal.addEventListener(
            'abort',
            () => reject(new Error('本轮执行因服务重载或停机已中断')),
            { once: true },
          )
        }),
      sendOriginCard: vi.fn(async () => 'om_card'),
      patchOriginCard: vi.fn(async () => {}),
      deliverReminderOutput: vi.fn(async () => ({ messageIds: [] })),
    })

    const item = await reminders.create({
      botId: 'ops-bot',
      chatId: 'oc_ops_shutdown',
      title: '热更新期间在途复查提醒',
      prompt: '检查告警是否恢复',
      mentions: [{ openId: 'ou_ops_1', name: 'Alex' }],
      afterSeconds: 300,
    })

    // Start execution, wait until runTurn is in-flight, then abort shutdownSignal BEFORE stop()
    const runPromise = reminders.runNow(item.id)
    await turnStartedPromise
    expect(store.getReminder(item.id)?.status).toBe('running')

    reminders.prepareShutdown()
    shutdownController.abort()
    await runPromise
    await reminders.stop()

    // Reminder must remain `running` with no false error event so next instance retries it
    expect(store.getReminder(item.id)?.status).toBe('running')
    expect(store.getReminder(item.id)?.resolution).toBeUndefined()
    expect(store.listEvents(20).some((e) => e.kind === 'error' && e.summary.includes('热更新期间在途复查提醒'))).toBe(false)

    // Simulated restarted instance recovers the stale running reminder cleanly
    const restarted = new ProactiveReminderService({
      ctx: fakeCtx,
      store,
      runtimes,
      workspaces,
      resolveMemberName: async () => undefined,
      runTurn: async () => REMINDER_SILENT_SENTINEL,
      sendOriginCard: vi.fn(async () => 'om_card'),
      patchOriginCard: vi.fn(async () => {}),
      deliverReminderOutput: vi.fn(async () => ({ messageIds: [] })),
    })
    const recovered = await restarted.recoverStaleRunningReminders()
    expect(recovered).toBe(1)
    expect(store.getReminder(item.id)).toMatchObject({
      status: 'scheduled',
      retryCount: 1,
    })
  })
})
