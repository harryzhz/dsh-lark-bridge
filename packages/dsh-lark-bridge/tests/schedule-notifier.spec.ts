import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LarkBridgeManager } from '../src/bridge-manager.js'
import { createLarkHttpHandler, type ConnectionAdmitter } from '../src/http-api.js'
import {
  ScheduleNotifier,
  type HostScheduleService,
  type ScheduleCreateInputLike,
  type ScheduleEntryLike,
} from '../src/schedule-notifier.js'
import { LarkBridgeStore } from '../src/store.js'
import type { WorkspaceGrouping } from '../src/workspace-grouping.js'

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lark-schedule-test-'))
  tempDirs.push(dir)
  return dir
}

function invokeHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
  opts: { method?: string; url: string; body?: unknown },
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const rawBody = opts.body !== undefined ? JSON.stringify(opts.body) : ''
    const req = Readable.from(rawBody ? [Buffer.from(rawBody)] : []) as unknown as IncomingMessage
    req.method = opts.method ?? 'GET'
    req.url = opts.url
    req.headers = {}

    let status = 200
    let body = ''
    const res = {
      writeHead(code: number) {
        status = code
        return res
      },
      end(chunk?: string | Buffer) {
        if (chunk) body += chunk.toString()
        resolve({ status, json: body ? JSON.parse(body) : {} })
      },
    } as unknown as ServerResponse

    Promise.resolve(handler(req, res)).catch(reject)
  })
}

describe('ScheduleNotifier, <system_reminder><schedule> injection & /api/lark-bridge/schedules', () => {
  it('injects bound group delivery context (without dumping member rosters) into scheduled prompts and delivers notifications', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)

    store.upsertBot({
      id: 'dsh-bot',
      name: 'DSH-Bot',
      larkAppId: 'cli_123',
      larkAppSecret: 'sec',
      defaultWorkingDir: '~',
    })
    store.mergeDiscoveredChats('dsh-bot', [
      {
        botId: 'dsh-bot',
        botName: 'DSH-Bot',
        larkAppId: 'cli_123',
        chatId: 'oc_team',
        name: '研发协作群',
      },
      {
        botId: 'dsh-bot',
        botName: 'DSH-Bot',
        larkAppId: 'cli_123',
        chatId: 'oc_ops',
        name: '研发值班群',
      },
    ])
    store.upsertBinding({
      routeKey: 'cli_123:oc_team:om_root_topic',
      botId: 'dsh-bot',
      botName: 'DSH-Bot',
      larkAppId: 'cli_123',
      chatId: 'oc_team',
      chatName: '研发协作群',
      workspaceName: 'DSH-Bot',
      sessionId: 'session-origin',
      agentPreset: 'codex',
      workingDir: '/repo',
      trigger: 'mention',
      createdAtMs: 1000,
      lastActivityMs: 1000,
    })

    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const emit = (event: string, ...args: unknown[]) => {
      for (const fn of listeners.get(event) ?? []) fn(...args)
    }

    const catalogEntries: ScheduleEntryLike[] = [
      {
        id: 'sched-implicit',
        kind: 'daily',
        title: '每日构建巡检',
        prompt: '检查每日构建状态',
        status: 'active',
        scheduledAt: '2026-11-21T09:00:00.000Z',
        time: '09:00:00',
        target: { kind: 'new', create: { cwd: '/repo' } },
        involvedSessionIds: ['session-origin'],
      },
      {
        id: 'sched-explicit',
        kind: 'weekly',
        title: '代码仓库 PR 巡检',
        prompt: '巡检开启中的 PR 状态',
        status: 'active',
        scheduledAt: '2026-11-21T02:00:00.000Z',
        time: '09:30:00',
        weekdays: [1, 2, 3, 4, 5],
        target: { kind: 'new', create: { cwd: '/repo' } },
        involvedSessionIds: [],
      },
    ]

    const scheduleService: HostScheduleService = {
      catalog: async () => catalogEntries,
      view: async ({ id }) => catalogEntries.find((e) => e.id === id) ?? { code: 'schedule_not_found' },
      run: vi.fn(async ({ id }) => catalogEntries.find((e) => e.id === id) ?? { code: 'schedule_not_found' }),
    }

    const fakeCtx = {
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      sessions: { get: () => undefined },
      on(event: string, fn: (...args: unknown[]) => void) {
        const list = listeners.get(event) ?? []
        list.push(fn)
        listeners.set(event, list)
        return () => {
          listeners.set(
            event,
            (listeners.get(event) ?? []).filter((item) => item !== fn),
          )
        }
      },
      get(name: string) {
        if (name === 'schedule') return scheduleService
        return undefined
      },
    } as unknown as Context

    const attachSession = vi.fn().mockResolvedValue(undefined)
    const sendScheduleMessage = vi.fn().mockResolvedValue(undefined)

    const notifier = new ScheduleNotifier({
      ctx: fakeCtx,
      store,
      workspaces: { attachSession, archiveSession: vi.fn().mockResolvedValue(true) } as unknown as WorkspaceGrouping,
      getBotOpenId: () => 'ou_bot_self',
      sendScheduleMessage,
    })
    notifier.start()

    const manager = { store, schedules: notifier } as unknown as LarkBridgeManager
    const admitter: ConnectionAdmitter = { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }
    const handler = createLarkHttpHandler(fakeCtx, admitter, manager)

    // 1. Implicit inheritance + weekday rule formatting in GET /schedules
    const list1 = await invokeHandler(handler, { url: '/api/lark-bridge/schedules' })
    expect(list1.status).toBe(200)
    const views1 = list1.json.schedules as Array<Record<string, unknown>>
    expect(views1).toHaveLength(2)
    expect(views1[0]).toMatchObject({
      id: 'sched-implicit',
      ruleSummary: '每天 09:00',
      configured: false,
      inferredOrigin: {
        botId: 'dsh-bot',
        chatId: 'oc_team',
        chatName: '研发协作群',
        replyToMessageId: 'om_root_topic',
      },
    })
    expect(views1[1]).toMatchObject({
      id: 'sched-explicit',
      ruleSummary: '每周一至周五 09:30',
    })

    // 2. Bind sched-explicit to oc_team and verify <system_reminder source="lark_schedule"> injection!
    await invokeHandler(handler, {
      method: 'PUT',
      url: '/api/lark-bridge/schedules/sched-explicit',
      body: {
        enabled: true,
        targets: [{ botId: 'dsh-bot', chatId: 'oc_team' }],
        deliveryMode: 'chat',
        notifyOn: 'non_empty',
      },
    })

    const receivedMessages: UserMessage[] = []
    const fakeAgent = {
      session: { id: 'session-sched-run' },
      followup: (msg: UserMessage) => {
        receivedMessages.push(msg)
      },
    } as unknown as Agent

    // Simulate Cordis `schedule/resolve-agent` waterfall firing via registered `ctx.on` listener
    const resolveHook = listeners.get('schedule/resolve-agent')?.[0] as
      | ((sid: string, next: () => Promise<Agent>) => Promise<Agent>)
      | undefined
    expect(resolveHook).toBeTypeOf('function')
    await resolveHook!('session-sched-run', async () => fakeAgent)
    fakeAgent.followup({
      id: 'msg-sched-1',
      role: 'user',
      source: { kind: 'schedule' },
      content: [
        {
          type: 'text',
          text: [
            '[SCHEDULE REMINDER]',
            'schedule_id_json: "sched-explicit"',
            'occurrence_at: 2026-11-21T01:30:00.000Z',
            'reminder_prompt_json: "巡检开启中的 PR 状态"',
          ].join('\n'),
        },
      ],
    } as unknown as UserMessage)

    const injectedText = (receivedMessages[0]!.content[0] as { text: string }).text
    expect(injectedText).toContain('<system_reminder>\n<schedule schedule_id="sched-explicit"')
    expect(injectedText).toContain('智能体「DSH-Bot」(bot_id="dsh-bot", app_id="cli_123", bot_open_id="ou_bot_self") -> 群聊「研发协作群」(chat_id="oc_team")')
    expect(injectedText).not.toContain('群成员：')
    expect(injectedText).toContain('lark-bridge members --bot <botId> --chat <chatId> --query <姓名>')
    expect(injectedText).not.toContain('.dsh')
    expect(injectedText).not.toContain('本自动化任务已绑定飞书通知投递')
    expect(notifier.getActiveSessionContext('session-sched-run')?.targets[0]?.chatId).toBe('oc_team')

    // 3. Implicit schedule fires across multiple steps (commentary + tool call -> final answer)
    // and pushes ONLY the final response to the inherited group
    const spawnedSession = { id: 'session-spawned-1', header: { cwd: '/repo' } } as unknown as Session
    ;(catalogEntries[0] as { lastDelivery?: unknown }).lastDelivery = {
      scheduledAt: '2026-11-21T09:00:00.000Z',
      deliveredAt: '2026-11-21T09:00:01.000Z',
      messageId: 'msg-1',
      targetSessionId: 'session-spawned-1',
    }
    emit('session/event', spawnedSession, { type: 'turn/start', data: { turn: 1 } } as unknown as SessionEvent)
    emit('session/event', spawnedSession, {
      type: 'user/message',
      data: { id: 'msg-1', source: { kind: 'schedule' } },
    } as unknown as SessionEvent)
    emit('session/event', spawnedSession, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: 'text', text: '我会先查询流水线记录，再汇总巡检结果。' },
            { type: 'tool-call', id: 'tc_1', name: 'bash', arguments: '{}' },
          ],
        },
      },
    } as unknown as SessionEvent)
    emit('session/event', spawnedSession, {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'tc_1', name: 'bash', arguments: '{}' },
    } as unknown as SessionEvent)
    emit('session/event', spawnedSession, {
      type: 'assistant/message',
      data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: '巡检正常：全部流水线绿灯' }] } },
    } as unknown as SessionEvent)
    emit('session/event', spawnedSession, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'complete' } },
    } as unknown as SessionEvent)

    await vi.waitFor(() => {
      expect(sendScheduleMessage).toHaveBeenCalledTimes(1)
    })
    expect(sendScheduleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        markdown: '巡检正常：全部流水线绿灯',
      }),
    )
    expect(attachSession).toHaveBeenCalledWith('/repo', 'repo', 'session-spawned-1')

    // 4. When sendIntermediateMessages is enabled on the schedule binding, intermediate progress
    // steps are pushed immediately (`isIntermediate: true`) and NOT concatenated into the final card
    sendScheduleMessage.mockClear()
    await invokeHandler(handler, {
      method: 'PUT',
      url: '/api/lark-bridge/schedules/sched-explicit',
      body: {
        enabled: true,
        targets: [{ botId: 'dsh-bot', chatId: 'oc_ops' }],
        deliveryMode: 'chat',
        notifyOn: 'non_empty',
        sendIntermediateMessages: true,
      },
    })
    const spawnedSession2 = { id: 'session-spawned-2', header: { cwd: '/repo' } } as unknown as Session
    ;(catalogEntries[1] as { lastDelivery?: unknown }).lastDelivery = {
      scheduledAt: '2026-11-21T09:30:00.000Z',
      deliveredAt: '2026-11-21T09:30:01.000Z',
      messageId: 'msg-2',
      targetSessionId: 'session-spawned-2',
    }
    emit('session/event', spawnedSession2, { type: 'turn/start', data: { turn: 1 } } as unknown as SessionEvent)
    emit('session/event', spawnedSession2, {
      type: 'user/message',
      data: { id: 'msg-2', source: { kind: 'schedule' } },
    } as unknown as SessionEvent)
    emit('session/event', spawnedSession2, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: 'text', text: '正在拉取开启中的 PR 列表…' },
            { type: 'tool-call', id: 'tc_pr_1', name: 'bash', arguments: '{}' },
          ],
        },
      },
    } as unknown as SessionEvent)

    // Intermediate progress card is pushed BEFORE turn/end!
    await vi.waitFor(() => {
      expect(sendScheduleMessage).toHaveBeenCalledTimes(1)
    })
    expect(sendScheduleMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chatId: 'oc_ops',
        markdown: '正在拉取开启中的 PR 列表…',
        isIntermediate: true,
      }),
    )

    emit('session/event', spawnedSession2, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 2,
        message: { content: [{ type: 'text', text: 'PR 巡检完成：共 3 个待审。' }] },
      },
    } as unknown as SessionEvent)
    emit('session/event', spawnedSession2, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'complete' } },
    } as unknown as SessionEvent)

    await vi.waitFor(() => {
      expect(sendScheduleMessage).toHaveBeenCalledTimes(2)
    })
    expect(sendScheduleMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chatId: 'oc_ops',
        markdown: 'PR 巡检完成：共 3 个待审。',
        isError: false,
      }),
    )
    expect(sendScheduleMessage.mock.calls[1]?.[0]?.isIntermediate).toBeUndefined()

    notifier.stop()
  })

  it('auto-backfills Group/Bot workingDir and agentPreset in agentCreateSchedule / createAndBind and rejects nonexistent cwd', async () => {
    const dataDir = makeTempDir()
    const botDir = makeTempDir()
    const groupDir = makeTempDir()
    const customDir = makeTempDir()
    const store = new LarkBridgeStore(dataDir)

    store.upsertBot({
      id: 'dsh-bot',
      name: 'DSH-Bot',
      enabled: false,
      larkAppId: 'cli_sched_bot',
      larkAppSecret: 'sec',
      defaultWorkingDir: botDir,
      agentPreset: 'claude-code',
    })
    store.upsertGroup({
      botId: 'dsh-bot',
      chatId: 'oc_custom_group',
      chatName: '独立目录研发群',
      enabled: true,
      workingDir: groupDir,
      runtimeMode: 'override',
      agentPreset: 'agy',
    })
    store.upsertGroup({
      botId: 'dsh-bot',
      chatId: 'oc_inherit_group',
      chatName: '继承目录群',
      enabled: true,
      workingDir: '',
    })
    store.upsertBinding({
      routeKey: 'cli_sched_bot:oc_custom_group:om_topic_1',
      botId: 'dsh-bot',
      botName: 'DSH-Bot',
      larkAppId: 'cli_sched_bot',
      chatId: 'oc_custom_group',
      chatName: '独立目录研发群',
      workspaceName: 'DSH-Bot',
      sessionId: 'sess-custom-group',
      agentPreset: 'agy',
      workingDir: groupDir,
      trigger: 'mention',
      createdAtMs: 1000,
      lastActivityMs: 1000,
    })

    const createdRequests: ScheduleCreateInputLike[] = []
    const scheduleService: HostScheduleService = {
      catalog: async () => [],
      create: vi.fn(async (req: ScheduleCreateInputLike) => {
        createdRequests.push(req)
        const idx = createdRequests.length
        return {
          id: `sched-created-${idx}`,
          kind: req.timing.kind,
          title: req.title,
          prompt: req.prompt,
          status: 'active',
          scheduledAt: '2026-11-23T01:30:00.000Z',
          target: { kind: 'new', ...(req.target?.create ? { create: req.target.create } : {}) },
          involvedSessionIds: [],
        }
      }),
      view: async () => ({ code: 'schedule_not_found' }),
      run: async () => ({ code: 'schedule_not_found' }),
    }

    const fakeCtx = {
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      sessions: { get: () => undefined },
      llm: { listProviders: () => [] },
      on: () => () => {},
      get(name: string) {
        if (name === 'schedule') return scheduleService
        return undefined
      },
    } as unknown as Context

    const manager = new LarkBridgeManager(
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
    const admitter: ConnectionAdmitter = { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }
    const handler = createLarkHttpHandler(fakeCtx, admitter, manager)

    const dailyTiming: ScheduleCreateInputLike['timing'] = {
      kind: 'daily',
      daily: { time: '09:30:00', time_zone: 'Asia/Shanghai' },
    }

    // 1. Bound group session with custom group workingDir & override runtime -> auto-backfills groupDir + agy
    const res1 = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/lark-bridge/agent/schedules',
      body: {
        sessionId: 'sess-custom-group',
        title: '群独立目录巡检',
        prompt: '检查服务状态',
        timing: dailyTiming,
      },
    })
    expect(res1.status).toBe(201)
    expect(createdRequests[0]?.target).toEqual({
      kind: 'new',
      create: { cwd: groupDir, agentPreset: 'agy' },
    })
    expect(res1.json.binding).toMatchObject({
      scheduleId: 'sched-created-1',
      targets: [{ botId: 'dsh-bot', chatId: 'oc_custom_group' }],
    })

    // 2. Group without custom workingDir -> inherits Bot defaultWorkingDir + Bot agentPreset
    const res2 = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/lark-bridge/agent/schedules',
      body: {
        botId: 'dsh-bot',
        chatId: 'oc_inherit_group',
        title: '群继承目录巡检',
        prompt: '检查流水线',
        timing: dailyTiming,
      },
    })
    expect(res2.status).toBe(201)
    expect(createdRequests[1]?.target).toEqual({
      kind: 'new',
      create: { cwd: botDir, agentPreset: 'claude-code' },
    })

    // 3. Unbound standalone call (no chatId, falls back to default bot) -> still backfills Bot defaultWorkingDir
    const res3 = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/lark-bridge/agent/schedules',
      body: {
        title: '全局默认目录任务',
        prompt: '生成周报草稿',
        timing: dailyTiming,
      },
    })
    expect(res3.status).toBe(201)
    expect(createdRequests[2]?.target).toEqual({
      kind: 'new',
      create: { cwd: botDir, agentPreset: 'claude-code' },
    })

    // 4. Explicit cwd overrides Group/Bot workingDir
    const res4 = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/lark-bridge/agent/schedules',
      body: {
        sessionId: 'sess-custom-group',
        cwd: customDir,
        agentPreset: 'codex',
        title: '显式指定目录任务',
        prompt: '巡检指定仓库',
        timing: dailyTiming,
      },
    })
    expect(res4.status).toBe(201)
    expect(createdRequests[3]?.target).toEqual({
      kind: 'new',
      create: { cwd: customDir, agentPreset: 'codex' },
    })

    // 5. Nonexistent explicit cwd fails fast with HTTP 400
    const missingDir = join(dataDir, 'does-not-exist-dir')
    const resBad = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/lark-bridge/agent/schedules',
      body: {
        sessionId: 'sess-custom-group',
        cwd: missingDir,
        title: '错误目录任务',
        prompt: '巡检',
        timing: dailyTiming,
      },
    })
    expect(resBad.status).toBe(400)
    expect(String(resBad.json.error)).toContain('工作目录不存在')
    expect(createdRequests).toHaveLength(4)

    await manager.stop()
  })

  it('silences zero-width/sentinel scheduled outputs, skips interrupted/blocked turns, and resolves promoted aliasRouteKeys', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    store.upsertBot({
      id: 'dsh-bot',
      name: 'DSH-Bot',
      larkAppId: 'cli_123',
      larkAppSecret: 'sec',
      defaultWorkingDir: '~',
    })
    store.upsertBinding({
      routeKey: 'cli_123:oc_team:om_initial_1',
      aliasRouteKeys: ['cli_123:oc_team:om_promoted_root', 'cli_123:oc_team:omt_topic_1'],
      botId: 'dsh-bot',
      botName: 'DSH-Bot',
      larkAppId: 'cli_123',
      chatId: 'oc_team',
      chatName: '研发协作群',
      workspaceName: 'DSH-Bot',
      sessionId: 'session-promoted',
      agentPreset: 'codex',
      workingDir: '/repo',
      trigger: 'mention',
      createdAtMs: 1000,
      lastActivityMs: 1000,
    })

    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const emit = (event: string, ...args: unknown[]) => {
      for (const fn of listeners.get(event) ?? []) fn(...args)
    }

    const entry: ScheduleEntryLike = {
      id: 'sched-silent-check',
      kind: 'daily',
      title: '巡检静默测试',
      prompt: '无异常输出 <no_reply/>',
      status: 'active',
      scheduledAt: '2026-11-23T09:00:00.000Z',
      time: '09:00:00',
      target: { kind: 'new', create: { cwd: '/repo' } },
      involvedSessionIds: ['session-promoted'],
    }
    const scheduleService: HostScheduleService = {
      catalog: async () => [entry],
      view: async () => entry,
      run: async () => entry,
    }
    const fakeCtx = {
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      sessions: { get: () => undefined },
      on(event: string, fn: (...args: unknown[]) => void) {
        const list = listeners.get(event) ?? []
        list.push(fn)
        listeners.set(event, list)
        return () => {}
      },
      get(name: string) {
        return name === 'schedule' ? scheduleService : undefined
      },
    } as unknown as Context

    const sendScheduleMessage = vi.fn().mockResolvedValue(undefined)
    const archiveSession = vi.fn().mockResolvedValue(true)
    const notifier = new ScheduleNotifier({
      ctx: fakeCtx,
      store,
      workspaces: { attachSession: vi.fn().mockResolvedValue(undefined), archiveSession } as unknown as WorkspaceGrouping,
      sendScheduleMessage,
    })
    notifier.start()

    // 1. Inferred origin resolves promoted alias message id `om_promoted_root`
    const views = await notifier.listViews()
    expect(views.schedules[0]?.inferredOrigin?.replyToMessageId).toBe('om_promoted_root')

    // 2. Zero-width & `<no_reply/>` replies are silently skipped and archived
    const runWith = async (sid: string, msgId: string, text: string, endKind = 'completed') => {
      const s = { id: sid, header: { cwd: '/repo' } } as unknown as Session
      ;(entry as { lastDelivery?: unknown }).lastDelivery = {
        scheduledAt: '2026-11-23T09:00:00.000Z',
        deliveredAt: '2026-11-23T09:00:01.000Z',
        messageId: msgId,
        targetSessionId: sid,
      }
      emit('session/event', s, { type: 'turn/start', data: { turn: 1 } })
      emit('session/event', s, { type: 'user/message', data: { id: msgId, source: { kind: 'schedule' } } })
      emit('session/event', s, {
        type: 'assistant/message',
        data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } },
      })
      emit('session/event', s, { type: 'turn/end', data: { turn: 1, reason: { kind: endKind } } })
      await new Promise((r) => setTimeout(r, 20))
    }

    await runWith('sess-zwsp', 'm-zwsp', '\u200b')
    await runWith('sess-sentinel', 'm-sentinel', '<no_reply/>')
    // 3. Interrupted turn does not falsely notify even under notifyOn='always'
    store.upsertScheduleBinding({
      scheduleId: entry.id,
      enabled: true,
      targets: [{ botId: 'dsh-bot', chatId: 'oc_team' }],
      deliveryMode: 'thread',
      notifyOn: 'always',
      sendIntermediateMessages: false,
    })
    await runWith('sess-interrupted', 'm-interrupted', '', 'interrupted')

    expect(sendScheduleMessage).not.toHaveBeenCalled()
    expect(archiveSession).toHaveBeenCalledWith('sess-zwsp')
    expect(archiveSession).toHaveBeenCalledWith('sess-sentinel')
    notifier.stop()
  })
})
