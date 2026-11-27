import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BridgeDatabase,
  CONFIG_SNAPSHOT_FILENAME,
  DB_FILENAME,
  LEGACY_STATE_FILENAME,
} from '../src/storage/database.js'
import { runDbCliCommand } from '../src/storage/db-cli.js'
import {
  exportDbToV3Json,
  migrateLegacyJsonToSqlite,
  rollbackDbFromJson,
  verifyDbAgainstJson,
} from '../src/storage/legacy-migrator.js'
import { LarkBridgeStore } from '../src/store.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../..')
const tempDirs: string[] = []

function makeTempDir(prefix = 'dsh-lark-sqlite-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeRichLegacyState(now = Date.now()) {
  return {
    version: 3,
    viewerTicketSecret: 'a'.repeat(64),
    bots: [
      {
        id: 'bot-alpha',
        name: 'Alpha Bot',
        enabled: true,
        larkAppId: 'cli_alpha123',
        larkAppSecret: 'mock-secret-value',
        defaultWorkingDir: '~',
        agentPreset: 'agy',
        runtimeProfileId: 'demo-proxy',
        model: 'demo-model',
        groupReplyMode: 'reply',
      },
      {
        id: 'bot-beta',
        name: 'Beta Bot',
        enabled: false,
        larkAppId: 'cli_beta456',
        larkAppSecret: 'dummy-secret-value',
        defaultWorkingDir: '~',
        agentPreset: 'standard',
      },
    ],
    groups: [
      {
        key: 'bot-alpha:oc_team_1',
        botId: 'bot-alpha',
        chatId: 'oc_team_1',
        chatName: '研发联调群',
        enabled: true,
        runtimeMode: 'override',
        agentPreset: 'agy',
        runtimeProfileId: 'demo-proxy',
        replyMode: 'reply',
        listener: {
          enabled: true,
          templateKey: 'project',
          name: '项目讨论',
          prompt: '自定义监听规则',
          memberOverrides: { [`${'ou'}_${'0123456789abcdef'.repeat(2)}`]: true },
        },
      },
    ],
    bindings: [
      {
        routeKey: 'cli_alpha123:oc_team_1:om_root_1',
        aliasRouteKeys: [
          'cli_alpha123:oc_team_1:omt_topic_1',
          'cli_alpha123:oc_team_1:om_reply_2',
        ],
        botId: 'bot-alpha',
        larkAppId: 'cli_alpha123',
        chatType: 'group',
        chatId: 'oc_team_1',
        workspaceName: 'demo',
        sessionId: 'sess-alpha-1',
        agentPreset: 'agy',
        runtimeProfileId: 'demo-proxy',
        workingDir: '/tmp/demo',
        trigger: 'mention',
        hasReplied: true,
        createdAtMs: now - 60_000,
        lastActivityMs: now - 10_000,
        idleCloseMs: 600_000,
      },
    ],
    managedSessions: [
      {
        sessionId: 'sess-alpha-1',
        botId: 'bot-alpha',
        chatId: 'oc_team_1',
        routeKey: 'cli_alpha123:oc_team_1:om_root_1',
        trigger: 'mention',
        createdAtMs: now - 60_000,
        lastActivityMs: now - 10_000,
        idleCloseMs: 600_000,
      },
      {
        sessionId: 'sess-expired-1',
        botId: 'bot-alpha',
        chatId: 'oc_team_1',
        routeKey: 'cli_alpha123:oc_team_1:om_old',
        trigger: 'mention',
        createdAtMs: now - 1_200_000,
        lastActivityMs: now - 900_000,
        idleCloseMs: 600_000,
      },
    ],
    dreamStates: [
      {
        botId: 'bot-alpha',
        status: 'succeeded',
        lastDreamAtMs: now - 3_600_000,
        lastCheckedDateKey: '2026-11-23',
        lastSessionId: 'sess-dream-1',
        lastProcessedCount: 4,
        lastSummary: '整理完成',
        processedSessionIds: ['sess-1', 'sess-2'],
      },
    ],
    dreamSessions: [
      {
        sessionId: 'sess-dream-1',
        botId: 'bot-alpha',
        workspaceName: 'demo',
        workingDir: '~',
        agentPreset: 'agy',
        runtimeProfileId: 'demo-proxy',
        status: 'succeeded',
        dateKey: '2026-11-23',
        processedCount: 4,
        summary: '整理完成',
        createdAtMs: now - 3_600_000,
        lastActivityMs: now - 3_500_000,
      },
    ],
    reminders: [
      {
        id: 'rem-1',
        title: '巡检提醒',
        prompt: '核查发布结果，无需提醒则输出 <no_reminder_needed/>',
        scheduledAt: new Date(now + 3_600_000).toISOString(),
        status: 'scheduled',
        origin: {
          botId: 'bot-alpha',
          larkAppId: 'cli_alpha123',
          chatType: 'group',
          chatId: 'oc_team_1',
          deliveryMode: 'chat',
        },
        mentions: [],
        createdAtMs: now - 30_000,
        updatedAtMs: now - 30_000,
      },
    ],
    pendingTurns: [
      {
        id: 'turn-pending-1',
        botId: 'bot-alpha',
        chatId: 'oc_team_1',
        messageId: 'om_pending_1',
        routeKey: 'cli_alpha123:oc_team_1:om_pending_1',
        replyMode: 'reply',
        trigger: 'mention',
        allowSilentEmptyReply: false,
        startedAtMs: now - 5_000,
      },
    ],
    seenMessages: [{ key: 'cli_alpha123:om_seen_1', seenAtMs: now - 2_000 }],
    listenerTemplates: [
      {
        key: 'project',
        label: '项目讨论',
        name: '项目讨论',
        scope: 'top_level',
        replyMode: 'new-topic',
        sessionMode: 'thread',
        autoCloseAfterCompletion: false,
        msgTypes: ['text', 'post', 'interactive'],
        senderTypes: ['user'],
        prompt: '自定义监听规则',
      },
    ],
    scheduleBindings: [
      {
        scheduleId: 'sched-1',
        enabled: true,
        targets: [{ botId: 'bot-alpha', chatId: 'oc_team_1' }],
        deliveryMode: 'chat',
        notifyOn: 'non_empty',
        sendIntermediateMessages: false,
      },
    ],
    hourlyBuckets: [
      {
        hourKey: '2026-11-23T22',
        inbound: 5,
        replied: 4,
        listenerTriggered: 1,
        silentSkipped: 1,
        ignored: 0,
        errors: 0,
        totalLatencyMs: 8000,
        latencySamples: 4,
      },
    ],
    botMetrics: [
      {
        botId: 'bot-alpha',
        inboundTotal: 5,
        repliedTotal: 4,
        listenerTriggeredTotal: 1,
        silentSkippedTotal: 1,
        ignoredTotal: 0,
        errorTotal: 0,
        latenciesMs: [1800, 2200, 1900, 2100],
      },
    ],
    groupTraffic: [
      {
        key: 'bot-alpha:oc_team_1',
        botId: 'bot-alpha',
        chatId: 'oc_team_1',
        chatName: '研发联调群',
        inboundTotal: 5,
        repliedTotal: 4,
        lastActiveMs: now - 10_000,
      },
    ],
    auditEvents: [
      {
        id: 'ev-newest',
        timestampMs: now - 1_000,
        botId: 'bot-alpha',
        chatId: 'oc_team_1',
        kind: 'reply',
        summary: '已回复 42 字',
      },
      {
        id: 'ev-older',
        timestampMs: now - 2_000,
        botId: 'bot-alpha',
        chatId: 'oc_team_1',
        kind: 'inbound',
        summary: 'mention → agy',
      },
    ],
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('SQLite WAL storage, atomic auto-migration & db CLI', () => {
  it('auto-migrates legacy lark-bridge-state.json atomically with backup, 16-table verification, and preserves all fields', () => {
    const dir = makeTempDir()
    const legacyPath = join(dir, LEGACY_STATE_FILENAME)
    const legacy = makeRichLegacyState()
    writeFileSync(legacyPath, JSON.stringify(legacy, null, 2), 'utf8')

    const store = new LarkBridgeStore(dir)
    try {
      expect(existsSync(join(dir, DB_FILENAME))).toBe(true)
      expect(existsSync(legacyPath)).toBe(false)
      expect(existsSync(join(dir, CONFIG_SNAPSHOT_FILENAME))).toBe(true)

      const files = readdirSync(dir)
      expect(files.some((f) => f.startsWith(`${LEGACY_STATE_FILENAME}.migrated.`))).toBe(true)
      const backups = readdirSync(join(dir, 'backups'))
      expect(backups.some((f) => f.startsWith('lark-bridge-state.pre-sqlite-'))).toBe(true)

      const report = store.getMigrationReport()
      expect(report?.ok).toBe(true)
      expect(report?.integrityOk).toBe(true)
      expect(report?.foreignKeyErrors).toBe(0)
      expect(report?.mismatches).toEqual([])

      expect(store.getViewerTicketSecret()).toBe('a'.repeat(64))
      expect(store.listBots().map((b) => b.id)).toEqual(['bot-alpha', 'bot-beta'])
      expect(store.getBot('bot-alpha')?.runtimeProfileId).toBe('demo-proxy')
      expect(store.getGroup('bot-alpha', 'oc_team_1')?.runtimeProfileId).toBe('demo-proxy')

      // Alias resolution works via binding_aliases table.
      const byAlias = store.getBinding('cli_alpha123:oc_team_1:omt_topic_1')
      expect(byAlias?.routeKey).toBe('cli_alpha123:oc_team_1:om_root_1')
      expect(byAlias?.runtimeProfileId).toBe('demo-proxy')
      expect(byAlias?.aliasRouteKeys).toEqual([
        'cli_alpha123:oc_team_1:omt_topic_1',
        'cli_alpha123:oc_team_1:om_reply_2',
      ])

      expect(store.listDreamSessions('bot-alpha')[0]?.runtimeProfileId).toBe('demo-proxy')
      expect(store.listReminders('active')).toHaveLength(1)
      expect(store.listPendingTurns()).toHaveLength(1)
      expect(store.listSeenMessages().map((s) => s.key)).toEqual(['cli_alpha123:om_seen_1'])
      expect(store.listEvents(10).map((e) => e.id)).toEqual(['ev-newest', 'ev-older'])
      expect(store.listExpiredManagedSessions().map((s) => s.sessionId)).toEqual(['sess-expired-1'])

      if (process.platform !== 'win32') {
        expect(statSync(join(dir, DB_FILENAME)).mode & 0o777).toBe(0o600)
      }
    } finally {
      store.close()
    }

    // Reopening is idempotent and does not re-migrate.
    const reopened = new LarkBridgeStore(dir)
    try {
      expect(reopened.listBots()).toHaveLength(2)
      expect(reopened.runIntegrityCheck().ok).toBe(true)
    } finally {
      reopened.close()
    }
  })

  it('recovers cleanly from corrupt legacy JSON and Step 5->6 leftover legacy JSON crash window', () => {
    const corruptDir = makeTempDir()
    writeFileSync(join(corruptDir, LEGACY_STATE_FILENAME), '{not-valid-json', 'utf8')
    const warnings: string[] = []
    const res = migrateLegacyJsonToSqlite(corruptDir, { onWarn: (m) => warnings.push(m) })
    expect(res).toBeUndefined()
    expect(warnings.length).toBe(1)
    expect(readdirSync(corruptDir).some((f) => f.includes('.corrupt-'))).toBe(true)

    // Simulate Step 5->6 crash where DB was migrated & renamed, but original JSON wasn't renamed yet.
    const crashDir = makeTempDir()
    const legacyJson = JSON.stringify(makeRichLegacyState(), null, 2)
    writeFileSync(join(crashDir, LEGACY_STATE_FILENAME), legacyJson, 'utf8')
    const store1 = new LarkBridgeStore(crashDir)
    store1.close()
    // Copy archived file back to original filename to simulate crash right before rename.
    const archived = readdirSync(crashDir).find((f) => f.startsWith(`${LEGACY_STATE_FILENAME}.migrated.`))!
    renameSync(join(crashDir, archived), join(crashDir, LEGACY_STATE_FILENAME))

    const store2 = new LarkBridgeStore(crashDir)
    try {
      expect(existsSync(join(crashDir, LEGACY_STATE_FILENAME))).toBe(false)
      expect(store2.listBots()).toHaveLength(2)
    } finally {
      store2.close()
    }
  })

  it('atomically cascades deleteBot across groups, bindings, aliases, reminders, metrics and pending turns', () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, LEGACY_STATE_FILENAME), JSON.stringify(makeRichLegacyState()), 'utf8')
    const store = new LarkBridgeStore(dir)
    try {
      expect(store.deleteBot('bot-alpha')).toBe(true)
      expect(store.getBot('bot-alpha')).toBeUndefined()
      expect(store.listGroups('bot-alpha')).toEqual([])
      expect(store.listBindings()).toEqual([])
      expect(store.getBinding('cli_alpha123:oc_team_1:omt_topic_1')).toBeUndefined()
      expect(store.listReminders('all')).toEqual([])
      expect(store.listPendingTurns()).toEqual([])
      expect(store.getDreamState('bot-alpha')).toBeUndefined()
      expect(store.listDreamSessions('bot-alpha')).toEqual([])
      expect(store.runIntegrityCheck()).toEqual({
        ok: true,
        messages: ['ok'],
        foreignKeyErrors: 0,
      })
      expect(store.getStorageStats().tableCounts.binding_aliases).toBe(0)
    } finally {
      store.close()
    }
  })

  it('supports traceId indexed audit queries and db CLI lifecycle (status/migrate/verify/backup/export/compact/rollback)', () => {
    const dir = makeTempDir()
    const legacyPath = join(dir, LEGACY_STATE_FILENAME)
    const legacy = makeRichLegacyState()
    writeFileSync(legacyPath, JSON.stringify(legacy, null, 2), 'utf8')

    // 1. status before migration
    const preStatus = runDbCliCommand('status', { 'data-dir': dir })
    expect(preStatus.backend).toBe('legacy_json')

    // 2. migrate --dry-run touches nothing
    const dryRun = runDbCliCommand('migrate', { 'data-dir': dir, 'dry-run': true })
    expect(dryRun.ok).toBe(true)
    expect(existsSync(join(dir, DB_FILENAME))).toBe(false)

    // 3. real migrate
    const migrated = runDbCliCommand('migrate', { 'data-dir': dir })
    expect(migrated.ok).toBe(true)
    expect(existsSync(join(dir, DB_FILENAME))).toBe(true)

    const backupJson = join(
      dir,
      'backups',
      readdirSync(join(dir, 'backups')).find((f) => f.startsWith('lark-bridge-state.pre-sqlite-'))!,
    )

    // 4. verify --against backup
    const verified = runDbCliCommand('verify', { 'data-dir': dir, against: backupJson })
    expect(verified.ok).toBe(true)

    // 5. traceId indexing & query
    const store = new LarkBridgeStore(dir)
    store.recordEvent({
      botId: 'bot-alpha',
      chatId: 'oc_team_1',
      traceId: 'tr_abc12345',
      kind: 'inbound',
      summary: 'step 1',
    })
    store.recordEvent({
      botId: 'bot-alpha',
      chatId: 'oc_team_1',
      traceId: 'tr_abc12345',
      kind: 'reply',
      summary: 'step 2',
    })
    expect(store.listEventsByTrace('tr_abc12345').map((e) => e.summary)).toEqual([
      'step 1',
      'step 2',
    ])
    store.close()

    // 6. backup (hot consistent copy)
    const dbBackupPath = join(dir, 'manual-backup.db')
    const backed = runDbCliCommand('backup', { 'data-dir': dir, out: dbBackupPath })
    expect(backed.ok).toBe(true)
    expect(existsSync(dbBackupPath)).toBe(true)

    // 7. export --redact masks secrets and production-length Feishu IDs
    const redactedPath = join(dir, 'redacted.json')
    const exported = runDbCliCommand('export', { 'data-dir': dir, out: redactedPath, redact: true })
    expect(exported.ok).toBe(true)
    const redactedText = readFileSync(redactedPath, 'utf8')
    expect(redactedText).not.toContain('mock-secret-value')
    expect(redactedText).not.toContain('a'.repeat(64))
    expect(redactedText).not.toContain('0123456789abcdef')
    expect(redactedText).toContain('"REDACTED"')
    expect(redactedText).toContain('"ou_REDACTED"')

    // 8. compact
    const compacted = runDbCliCommand('compact', { 'data-dir': dir })
    expect(compacted.ok).toBe(true)

    // 9. rollback (rebuild SQLite & to-json mode)
    const rebuilt = rollbackDbFromJson(dir, backupJson)
    expect(rebuilt.mode).toBe('rebuild_sqlite')
    expect(rebuilt.verification?.ok).toBe(true)

    const db = new BridgeDatabase(join(dir, DB_FILENAME), { readOnly: true })
    try {
      expect(verifyDbAgainstJson(db, backupJson).ok).toBe(true)
      const fullExport = exportDbToV3Json(db, dir)
      expect(fullExport.bots).toHaveLength(2)
    } finally {
      db.close({ checkpoint: false })
    }

    const rolledToJson = runDbCliCommand('rollback', {
      'data-dir': dir,
      from: backupJson,
      'to-json': true,
    })
    expect(rolledToJson.ok).toBe(true)
    expect(existsSync(join(dir, LEGACY_STATE_FILENAME))).toBe(true)
    expect(existsSync(join(dir, DB_FILENAME))).toBe(false)
  })

  it('refuses destructive db migrate/rollback when a live bridge.lock exists unless --force is passed', () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, LEGACY_STATE_FILENAME), JSON.stringify(makeRichLegacyState()), 'utf8')
    writeFileSync(
      join(dir, 'bridge.lock'),
      JSON.stringify({ pid: process.pid, host: 'localhost', startedAtMs: Date.now() }),
      'utf8',
    )
    expect(() => runDbCliCommand('migrate', { 'data-dir': dir })).toThrow(/正在运行/)
    const forced = runDbCliCommand('migrate', { 'data-dir': dir, force: true })
    expect(forced.ok).toBe(true)
  })

  it('executes standalone bundled dist/lark-bridge.mjs db status cleanly', () => {
    const bundledCli = join(repoRoot, 'dist', 'lark-bridge.mjs')
    if (!existsSync(bundledCli)) return
    const dir = makeTempDir()
    const stdout = execFileSync(process.execPath, [bundledCli, 'db', 'status', '--data-dir', dir], {
      encoding: 'utf8',
    })
    const parsed = JSON.parse(stdout) as { ok: boolean; backend: string }
    expect(parsed.ok).toBe(true)
    expect(parsed.backend).toBe('uninitialized')
  })

  it('benchmark: SQLite WAL write path drastically outperforms legacy full-file JSON rewrite under realistic payload', () => {
    const dir = makeTempDir()
    const now = Date.now()
    const largeState = makeRichLegacyState(now)
    // Populate realistic production-scale payload: 40 large reminders + 150 sessions + 200 audit events (~350 KB).
    for (let i = 0; i < 40; i += 1) {
      largeState.reminders.push({
        id: `rem-bench-${i}`,
        title: `跟进事项 ${i}`,
        prompt: `详细跟进任务说明 ${i}：`.repeat(120),
        scheduledAt: new Date(now + (i + 1) * 60_000).toISOString(),
        status: i < 10 ? 'scheduled' : 'archived',
        origin: {
          botId: 'bot-alpha',
          larkAppId: 'cli_alpha123',
          chatType: 'group',
          chatId: 'oc_team_1',
          deliveryMode: 'chat',
        },
        mentions: [],
        createdAtMs: now - 100_000,
        updatedAtMs: now - 10_000,
      })
    }
    for (let i = 0; i < 150; i += 1) {
      largeState.managedSessions.push({
        sessionId: `sess-bench-${i}`,
        botId: 'bot-alpha',
        chatId: 'oc_team_1',
        routeKey: `cli_alpha123:oc_team_1:om_${i}`,
        trigger: 'mention',
        createdAtMs: now - 200_000,
        lastActivityMs: now - 50_000,
      })
    }
    for (let i = 0; i < 198; i += 1) {
      largeState.auditEvents.push({
        id: `ev-bench-${i}`,
        timestampMs: now - (i + 10) * 1000,
        botId: 'bot-alpha',
        chatId: 'oc_team_1',
        kind: 'reply',
        summary: `历史事件 ${i} `.repeat(15),
      })
    }

    const legacyJsonPath = join(dir, LEGACY_STATE_FILENAME)
    const initialJson = JSON.stringify(largeState, null, 2)
    writeFileSync(legacyJsonPath, initialJson, 'utf8')
    const payloadBytes = Buffer.byteLength(initialJson, 'utf8')
    expect(payloadBytes).toBeGreaterThan(250_000)

    // Baseline: simulate 20 turns * 10 full-file JSON sync rewrites
    const baselinePath = join(dir, 'baseline-legacy.json')
    const turns = 20
    const jsonStart = performance.now()
    for (let t = 0; t < turns; t += 1) {
      for (let w = 0; w < 10; w += 1) {
        const tmp = `${baselinePath}.tmp`
        writeFileSync(tmp, JSON.stringify(largeState, null, 2), 'utf8')
        renameSync(tmp, baselinePath)
      }
    }
    const jsonElapsedMs = performance.now() - jsonStart

    // SQLite WAL: migrate then run the exact 20 turns (10 mutations per turn)
    const store = new LarkBridgeStore(dir)
    let sqliteElapsedMs = 0
    try {
      const sqlStart = performance.now()
      for (let t = 0; t < turns; t += 1) {
        const turnId = `turn-bench-${t}`
        const msgKey = `cli_alpha123:om_bench_${t}`
        store.rememberSeenMessage(msgKey, now + t)
        store.recordMetric({ botId: 'bot-alpha', chatId: 'oc_team_1', kind: 'inbound', now: now + t })
        store.upsertPendingTurn({
          id: turnId,
          botId: 'bot-alpha',
          chatId: 'oc_team_1',
          messageId: `om_bench_${t}`,
          routeKey: 'cli_alpha123:oc_team_1:om_root_1',
          replyMode: 'reply',
          trigger: 'mention',
          allowSilentEmptyReply: false,
          startedAtMs: now + t,
        })
        store.recordEvent({
          botId: 'bot-alpha',
          chatId: 'oc_team_1',
          sessionId: 'sess-alpha-1',
          kind: 'inbound',
          summary: `bench turn ${t}`,
        })
        store.upsertPendingTurn({
          id: turnId,
          botId: 'bot-alpha',
          chatId: 'oc_team_1',
          messageId: `om_bench_${t}`,
          routeKey: 'cli_alpha123:oc_team_1:om_root_1',
          replyMode: 'reply',
          trigger: 'mention',
          allowSilentEmptyReply: false,
          sessionId: 'sess-alpha-1',
          startedAtMs: now + t,
        })
        store.deletePendingTurn(turnId)
        store.touchBinding('cli_alpha123:oc_team_1:om_root_1', now + t)
        store.markBindingReplied('cli_alpha123:oc_team_1:om_root_1', now + t)
        store.recordMetric({
          botId: 'bot-alpha',
          chatId: 'oc_team_1',
          kind: 'replied',
          latencyMs: 1200,
          now: now + t,
        })
        store.recordEvent({
          botId: 'bot-alpha',
          chatId: 'oc_team_1',
          sessionId: 'sess-alpha-1',
          durationMs: 1200,
          kind: 'reply',
          summary: `bench reply ${t}`,
        })
      }
      sqliteElapsedMs = performance.now() - sqlStart
      const stats = store.getStorageStats()
      expect(stats.journalMode).toBe('wal')
      expect(sqliteElapsedMs).toBeLessThan(jsonElapsedMs)
      // Single turn average must stay fast even under parallel CI disk jitter.
      expect(sqliteElapsedMs / turns).toBeLessThan(15)
    } finally {
      store.close()
    }
  })

  it('applies migration v6 index on triage_context_scopes(updated_at_ms) and counts pending turns without full JSON scan', () => {
    const dir = makeTempDir('dsh-lark-v6-')
    const store = new LarkBridgeStore(dir)
    try {
      expect(store.getStorageStats().schemaVersion).toBe(12)
      const pendingCols = (
        store.db.prepare('PRAGMA table_info(pending_turns)').all() as Array<{ name: string }>
      ).map((c) => c.name)
      expect(pendingCols).toContain('target_turn')
      expect(pendingCols).toContain('user_message_id')
      expect(pendingCols).toContain('last_event_seq')
      expect(pendingCols).toContain('cot_id')
      expect(pendingCols).toContain('cot_message_id')
      const cols = (
        store.db.prepare('PRAGMA table_info(telemetry_usage_events)').all() as Array<{ name: string }>
      ).map((c) => c.name)
      expect(cols).toContain('queue_wait_ms')
      expect(cols).toContain('exec_ms')
      const plan = store.db
        .prepare(
          'EXPLAIN QUERY PLAN SELECT scope_key, kind, payload_json, updated_at_ms FROM triage_context_scopes WHERE updated_at_ms >= ? ORDER BY updated_at_ms ASC',
        )
        .all(0) as Array<{ detail?: string }>
      expect(plan.some((r) => String(r.detail ?? '').includes('idx_triage_context_scopes_updated'))).toBe(
        true,
      )

      expect(store.countPendingTurns()).toBe(0)
      store.upsertPendingTurn({
        id: 'pt-count-1',
        botId: 'bot-a',
        chatId: 'oc_1',
        messageId: 'om_1',
        routeKey: 'cli_a:oc_1:om_1',
        replyMode: 'reply',
        trigger: 'mention',
        allowSilentEmptyReply: false,
        startedAtMs: Date.now(),
      })
      store.upsertPendingTurn({
        id: 'pt-count-2',
        botId: 'bot-a',
        chatId: 'oc_1',
        messageId: 'om_2',
        routeKey: 'cli_a:oc_1:om_2',
        replyMode: 'reply',
        trigger: 'mention',
        allowSilentEmptyReply: false,
        startedAtMs: Date.now(),
      })
      expect(store.countPendingTurns()).toBe(2)
      store.deletePendingTurn('pt-count-1')
      expect(store.countPendingTurns()).toBe(1)
      expect(store.db.getPerfSnapshot().slowThresholdMs).toBe(100)
    } finally {
      store.close()
    }
  })
})
