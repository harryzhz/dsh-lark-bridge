import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LarkBotConfigSchema,
  LarkBotTransport,
  createLarkSdkLogger,
  explainLarkErrorCode,
} from '@dsh-lark/lark-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildBridgeDiagnostics, runOfflineDoctor } from '../src/diagnostics.js'
import { dispatchLarkApiRequest } from '../src/http-api.js'
import {
  INSTANCE_LOCK_FILENAME,
  InstanceLock,
  InstanceLockConflictError,
} from '../src/instance-lock.js'
import { SplitBrainDetector } from '../src/split-brain-detector.js'
import { LarkBridgeStore } from '../src/store.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../..')
const tempDirs: string[] = []

function makeTempDir(prefix = 'dsh-lark-phaseb-'): string {
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

describe('InstanceLock, SplitBrainDetector, SDK Logger & Diagnostics/Doctor', () => {
  it('acquires exclusive bridge.lock, rejects alive foreign PID conflict, and reclaims stale dead-PID lock', () => {
    const dir = makeTempDir()
    const lock1 = new InstanceLock(dir, 'test')
    const st1 = lock1.acquire()
    expect(st1.held).toBe(true)
    expect(existsSync(join(dir, INSTANCE_LOCK_FILENAME))).toBe(true)
    lock1.release()
    expect(existsSync(join(dir, INSTANCE_LOCK_FILENAME))).toBe(false)

    // Write a lock held by an alive different PID (parent process PID).
    const aliveOtherPid = process.ppid > 0 && process.ppid !== process.pid ? process.ppid : 1
    writeFileSync(
      join(dir, INSTANCE_LOCK_FILENAME),
      JSON.stringify({
        pid: aliveOtherPid,
        host: hostname(),
        instanceId: 'foreign-instance',
        startedAtMs: Date.now() - 10_000,
        heartbeatAtMs: Date.now(),
        mode: 'web',
      }),
      'utf8',
    )
    const lock2 = new InstanceLock(dir, 'test')
    expect(() => lock2.acquire()).toThrow(InstanceLockConflictError)

    // Write a stale lock held by a guaranteed non-existent PID.
    writeFileSync(
      join(dir, INSTANCE_LOCK_FILENAME),
      JSON.stringify({
        pid: 99999999,
        host: hostname(),
        instanceId: 'dead-instance',
        startedAtMs: Date.now() - 300_000,
        heartbeatAtMs: Date.now() - 300_000,
        mode: 'web',
      }),
      'utf8',
    )
    const lock3 = new InstanceLock(dir, 'test')
    const recovered = lock3.acquire()
    expect(recovered.held).toBe(true)
    expect(recovered.recoveredStaleLock?.pid).toBe(99999999)
    lock3.release()
  })

  it('redacts secrets in SDK logs, downgrades optional-scope 41050/99992402 to warn with Chinese hints, and counts error codes', () => {
    const logs: Array<{ level: string; message: string }> = []
    const codes: Array<{ code: string; hint?: string }> = []
    const logger = createLarkSdkLogger({
      botId: 'bot-obs',
      botName: 'ObsBot',
      emit: (level, message) => logs.push({ level, message }),
      onErrorCode: (code, hint) => codes.push({ code, hint }),
    })

    logger.error({
      response: { data: { code: 41050, msg: 'no user authority error' } },
    })
    const fakeToken = `${'t'}-${'mocktoken1234567890'.repeat(2)}`
    const fakeSecret = `${'mock'}${'Value1234567890'}`
    logger.error(`Authorization: Bearer ${fakeToken} app_secret=${fakeSecret}`)

    expect(logs[0]?.level).toBe('warn')
    expect(logs[0]?.message).toContain('41050')
    expect(logs[0]?.message).toContain('通讯录权限范围不足')
    expect(codes[0]?.code).toBe('41050')
    expect(explainLarkErrorCode('99992402')).toContain('application:application:self_manage')
    expect(explainLarkErrorCode('230002')).toContain('机器人不在目标群聊')

    expect(logs[1]?.message).not.toContain(fakeToken)
    expect(logs[1]?.message).not.toContain(fakeSecret)
    expect(logs[1]?.message).toContain('[REDACTED]')
  })

  it('detects cross-host split-brain when receiving own botOpenId message not sent by this instance, without false positives on own replies', async () => {
    const bot = LarkBotConfigSchema.parse({
      id: 'bot-sb',
      name: 'SplitBot',
      larkAppId: 'cli_sb_1',
      larkAppSecret: 'mock-secret-value',
      defaultWorkingDir: '~',
    })
    const externalEvents: Array<{ messageId: string; chatId: string }> = []
    const transport = new LarkBotTransport(bot, {
      onMessage: () => {},
      onExternalSelfMessage: (ev) =>
        externalEvents.push({ messageId: ev.messageId, chatId: ev.chatId }),
    })

    // Access private client & start state cleanly for deterministic transport test.
    const internal = transport as unknown as {
      client: {
        request: (opts: unknown) => Promise<unknown>
        im: { message: { create: (opts: unknown) => Promise<unknown> } }
      }
      botOpenId?: string
      startedAtMs?: number
      wsClient?: unknown
    }
    internal.botOpenId = 'ou_self_bot'
    internal.startedAtMs = 1_700_000_000_000
    internal.client.im.message.create = vi.fn().mockResolvedValue({
      data: { message_id: 'om_local_sent_1' },
    })

    await transport.sendReply({
      chatId: 'oc_group_1',
      replyMode: 'chat',
      text: 'hello from local',
    })
    expect(transport.wasSentByThisInstance('om_local_sent_1')).toBe(true)
    expect(transport.wasSentByThisInstance('om_remote_other_host_2')).toBe(false)

    // Verify SplitBrainDetector deduplicates audit emission within 10-minute cooldown.
    const detector = new SplitBrainDetector()
    const first = detector.recordExternalSelfMessage(
      {
        botId: 'bot-sb',
        larkAppId: 'cli_sb_1',
        botOpenId: 'ou_self_bot',
        chatId: 'oc_group_1',
        messageId: 'om_remote_1',
        createTimeMs: 1_700_000_020_000,
      },
      'SplitBot',
      1_700_000_020_000,
    )
    expect(first.shouldAudit).toBe(true)
    expect(first.alert.observedCount).toBe(1)

    const second = detector.recordExternalSelfMessage(
      {
        botId: 'bot-sb',
        larkAppId: 'cli_sb_1',
        botOpenId: 'ou_self_bot',
        chatId: 'oc_group_1',
        messageId: 'om_remote_2',
        createTimeMs: 1_700_000_040_000,
      },
      'SplitBot',
      1_700_000_040_000,
    )
    expect(second.shouldAudit).toBe(false)
    expect(second.alert.observedCount).toBe(2)

    expect(detector.clearAlert('bot-sb')).toBe(true)
    expect(detector.listAlerts()).toEqual([])
  })

  it('serves /diagnostics, /cockpit alerts, /events?traceId=, and offline lark-bridge doctor', async () => {
    const dir = makeTempDir()
    const store = new LarkBridgeStore(dir)
    const detector = new SplitBrainDetector()
    const lock = new InstanceLock(dir, 'test')
    lock.acquire()
    try {
      store.upsertBot({
        id: 'bot-diag',
        name: 'DiagBot',
        larkAppId: 'cli_diag_1',
        larkAppSecret: 'mock-secret-value',
        defaultWorkingDir: '~',
      })
      store.recordEvent({
        botId: 'bot-diag',
        chatId: 'oc_diag',
        traceId: 'tr_deadbeef',
        kind: 'inbound',
        summary: 'traced inbound',
      })
      detector.recordExternalSelfMessage(
        {
          botId: 'bot-diag',
          larkAppId: 'cli_diag_1',
          botOpenId: 'ou_bot_diag',
          chatId: 'oc_diag',
          messageId: 'om_ext_1',
          createTimeMs: Date.now(),
        },
        'DiagBot',
      )

      const fakeManager = {
        store,
        listBotStatuses: () => [
          {
            botId: 'bot-diag',
            larkAppId: 'cli_diag_1',
            name: 'DiagBot',
            enabled: true,
            connected: true,
            botOpenId: 'ou_bot_diag',
            activeBindings: 0,
          },
        ],
        sessionWebUrl: (sid: string) => `http://127.0.0.1:3880/#session=${sid}`,
        getDiagnostics: () =>
          buildBridgeDiagnostics({
            store,
            botStatuses: [
              {
                botId: 'bot-diag',
                larkAppId: 'cli_diag_1',
                name: 'DiagBot',
                enabled: true,
                connected: true,
                botOpenId: 'ou_bot_diag',
                activeBindings: 0,
              },
            ],
            getTransportDiagnostics: () => ({
              ackP50Ms: 0.4,
              ackP95Ms: 1.2,
              ackSamples: 12,
              sentCacheSize: 5,
              sdkErrors: [],
            }),
            splitBrainAlerts: detector.listAlerts(),
            instanceLock: lock.status(),
            startedAtMs: Date.now() - 5_000,
          }),
        clearSplitBrainAlert: (botId: string) => detector.clearAlert(botId),
      }

      const diagRes = await dispatchLarkApiRequest({} as never, fakeManager as never, {
        method: 'GET',
        path: '/api/lark-bridge/diagnostics',
        isCliAuthenticated: true,
        principalKind: 'cli',
      })
      expect(diagRes.status).toBe(200)
      const diagBody = diagRes.payload as {
        ok: boolean
        storage: { backend: string; integrity: { ok: boolean } }
        splitBrainAlerts: unknown[]
        alerts: Array<{ code: string }>
      }
      expect(diagBody.ok).toBe(false) // split-brain active
      expect(diagBody.storage.backend).toBe('sqlite_wal')
      expect(diagBody.storage.integrity.ok).toBe(true)
      expect(diagBody.splitBrainAlerts).toHaveLength(1)
      expect(diagBody.alerts.some((a) => a.code === 'split_brain')).toBe(true)

      // Cockpit embeds alerts; events filterable by traceId.
      const cockpitRes = await dispatchLarkApiRequest({} as never, fakeManager as never, {
        method: 'GET',
        path: '/api/lark-bridge/cockpit',
        isCliAuthenticated: false,
        principalKind: 'owner',
      })
      expect((cockpitRes.payload as { alerts: unknown[] }).alerts).toHaveLength(1)

      const traceRes = await dispatchLarkApiRequest({} as never, fakeManager as never, {
        method: 'GET',
        path: '/api/lark-bridge/events?traceId=tr_deadbeef',
        isCliAuthenticated: true,
        principalKind: 'cli',
      })
      expect((traceRes.payload as { events: Array<{ traceId?: string }> }).events).toHaveLength(1)

      // Clear split-brain requires owner session.
      const cliClear = await dispatchLarkApiRequest({} as never, fakeManager as never, {
        method: 'POST',
        path: '/api/lark-bridge/diagnostics/split-brain/bot-diag/clear',
        isCliAuthenticated: true,
        principalKind: 'cli',
      })
      expect(cliClear.status).toBe(403)

      const ownerClear = await dispatchLarkApiRequest({} as never, fakeManager as never, {
        method: 'POST',
        path: '/api/lark-bridge/diagnostics/split-brain/bot-diag/clear',
        isCliAuthenticated: false,
        principalKind: 'owner',
      })
      expect(ownerClear.status).toBe(200)
      expect(detector.listAlerts()).toHaveLength(0)

      // Offline doctor checks DB integrity and lock state cleanly.
      const offline = runOfflineDoctor(dir)
      expect(offline.ok).toBe(true)
      expect(offline.storage.backend).toBe('sqlite_wal')
      expect(offline.instanceLock.alive).toBe(true)

      const bundledCli = join(repoRoot, 'dist', 'lark-bridge.mjs')
      if (existsSync(bundledCli)) {
        const out = execFileSync(
          process.execPath,
          [bundledCli, 'doctor', '--data-dir', dir, '--json'],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              LARK_BRIDGE_ENDPOINT_FILE: join(dir, 'nonexistent-endpoint.json'),
            },
          },
        )
        const doc = JSON.parse(out) as { ok: boolean; offline: { storage: { backend: string } } }
        expect(doc.ok).toBe(true)
        expect(doc.offline.storage.backend).toBe('sqlite_wal')
      }
    } finally {
      lock.release()
      store.close()
    }
  })
})
