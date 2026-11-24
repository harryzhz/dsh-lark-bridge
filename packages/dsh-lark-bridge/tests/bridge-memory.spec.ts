import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LarkBridgeManager } from '../src/bridge-manager.js'
import { ensureCliAuthEndpoint } from '../src/cli-support.js'
import { createLarkHttpHandler, type ConnectionAdmitter } from '../src/http-api.js'
import { BridgeMemoryService } from '../src/memory-service.js'
import { LarkBridgeStore } from '../src/store.js'

const execFileAsync = promisify(execFile)

const __dirname = dirname(fileURLToPath(import.meta.url))
const cliEntryPath = resolve(__dirname, '../../dsh-bundle/bin/lark-bridge.mjs')
const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function makeTempDir(prefix = 'lark-memory-test-'): string {
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

describe('BridgeMemoryService: SOTA typed memory, scope isolation, FTS5 search, bi-temporal supersede & CLI/HTTP auth', () => {
  it('supports scope isolation, priority ranking, FTS5 + short-token LIKE search, bi-temporal supersede, Layer 1 budget & MEMORY.md projection', () => {
    const dataDir = makeTempDir()
    const repoA = makeTempDir('repo-a-')
    const repoB = makeTempDir('repo-b-')
    const store = new LarkBridgeStore(dataDir)
    const memory = new BridgeMemoryService(dataDir, store)

    store.upsertBot({
      id: 'bot-main',
      name: '研发助手',
      enabled: true,
      larkAppId: 'cli_demo_mem',
      larkAppSecret: 'sec_demo_mem',
      defaultWorkingDir: repoA,
    })

    // 1. Seed entries across types & scopes
    const refEntry = memory.upsert({
      botId: 'bot-main',
      scope: 'bot',
      type: 'reference',
      title: '发布监控看板入口',
      content: '灰度发布核心 P95 看板位于内部监控台 dashboard-release。',
      tags: ['ops', 'dashboard'],
    })
    expect(refEntry.action).toBe('created')

    const feedbackEntry = memory.upsert({
      botId: 'bot-main',
      scope: 'chat',
      scopeId: 'oc_group_alpha',
      type: 'feedback',
      title: '禁止在晚间自动合并 PR',
      content: '2026-11-24 团队明确要求 22:00 后仅做检查不自动合入主干。',
      tags: ['PR', '发版'],
      pinned: true,
    })
    expect(feedbackEntry.action).toBe('created')

    const otherGroupEntry = memory.upsert({
      botId: 'bot-main',
      scope: 'chat',
      scopeId: 'oc_group_beta',
      type: 'feedback',
      title: 'Beta 群专属静默规则',
      content: '此条仅在 Beta 群生效，绝不可泄露到 Alpha 群。',
    })
    expect(otherGroupEntry.entry.scopeId).toBe('oc_group_beta')

    const repoAEntry = memory.upsert({
      botId: 'bot-main',
      scope: 'workspace',
      scopeId: `${repoA}/`,
      type: 'project',
      title: '存储层迁移至 SQLite WAL',
      content: '2026-11-23 已完成全量迁移，旧 JSON 仅保留只读快照。',
      tags: ['sqlite', 'architecture'],
    })
    expect(repoAEntry.entry.scopeId).toBe(repoA)

    const repoBEntry = memory.upsert({
      botId: 'bot-main',
      scope: 'workspace',
      scopeId: repoB,
      type: 'project',
      title: 'RepoB 独立策略',
      content: '不应出现在 RepoA 会话中。',
    })
    expect(repoBEntry.entry.scopeId).toBe(repoB)

    // 2. Idempotent upsert by same (botId, scope, scopeId, normalized title)
    const idempotent = memory.upsert({
      botId: 'bot-main',
      scope: 'bot',
      type: 'reference',
      title: '  发布监控看板入口  ',
      content: '灰度发布核心 P95 与错误率看板位于 dashboard-release-v2。',
    })
    expect(idempotent.action).toBe('updated')
    expect(idempotent.entry.id).toBe(refEntry.entry.id)

    // 3. FTS5 trigram search (>= 3 chars Chinese & English) + short-token (< 3 chars) LIKE fallback
    const cjkHits = memory.list({ botId: 'bot-main', query: '自动合并' })
    expect(cjkHits.map((e) => e.id)).toContain(feedbackEntry.entry.id)

    const englishHits = memory.list({ botId: 'bot-main', query: 'SQLite' })
    expect(englishHits.map((e) => e.id)).toContain(repoAEntry.entry.id)

    const shortTokenHits = memory.list({ botId: 'bot-main', query: '发版' })
    expect(shortTokenHits.map((e) => e.id)).toContain(feedbackEntry.entry.id)

    // 4. Bi-temporal supersede: old fact invalidated non-destructively, replacement active
    const sup = memory.supersede(repoAEntry.entry.id, {
      reason: '2026-11-24 已升级至 SQLite WAL v3 并引入 FTS5 索引',
      replacement: {
        type: 'project',
        title: '存储层已升级至 SQLite WAL v3 + FTS5',
        content: '2026-11-24 已新增 memory_entries 与 trigram FTS5 检索表。',
        tags: ['sqlite', 'fts5'],
      },
    })
    expect(sup?.oldEntry.status).toBe('superseded')
    expect(sup?.oldEntry.supersededBy).toBe(sup?.replacementEntry?.id)
    expect(sup?.oldEntry.supersedeReason).toContain('FTS5')
    expect(sup?.replacementEntry?.status).toBe('active')

    // Active-only queries never surface superseded facts
    const activeEntries = memory.list({ botId: 'bot-main', status: 'active' })
    expect(activeEntries.map((e) => e.id)).not.toContain(repoAEntry.entry.id)
    expect(activeEntries.map((e) => e.id)).toContain(sup?.replacementEntry?.id)

    // History audit (`status: 'all'`) preserves superseded entry
    const allEntries = memory.list({ botId: 'bot-main', status: 'all' })
    expect(allEntries.map((e) => e.id)).toContain(repoAEntry.entry.id)

    // 5. Progressive Disclosure Layer 1 injection: strict scope isolation, pinned/type priority, recall telemetry
    const reminder = memory.composeFirstTurnReminder({
      botId: 'bot-main',
      chatId: 'oc_group_alpha',
      workingDir: repoA,
    })
    expect(reminder).toBeDefined()
    expect(reminder).toContain('<bridge_memory bot_id="bot-main"')
    expect(reminder).toContain('禁止在晚间自动合并 PR')
    expect(reminder).toContain('存储层已升级至 SQLite WAL v3 + FTS5')
    expect(reminder).toContain('发布监控看板入口')
    // Must NEVER leak other group or other workspace memories or superseded facts
    expect(reminder).not.toContain('Beta 群专属静默规则')
    expect(reminder).not.toContain('RepoB 独立策略')
    expect(reminder).not.toContain('存储层迁移至 SQLite WAL')
    // Pinned feedback appears before project and reference
    expect(reminder!.indexOf('禁止在晚间自动合并 PR')).toBeLessThan(
      reminder!.indexOf('存储层已升级至 SQLite WAL v3 + FTS5'),
    )
    expect(reminder!.indexOf('存储层已升级至 SQLite WAL v3 + FTS5')).toBeLessThan(
      reminder!.indexOf('发布监控看板入口'),
    )
    // Recall counter incremented for surfaced entries
    const recalled = memory.get(feedbackEntry.entry.id, { recordRecall: false })
    expect(recalled?.recallCount).toBe(1)

    // 6. Human-auditable Markdown mirror strictly under <dataDir>/memory/<botId>/MEMORY.md (never in workDir/.local)
    const mdPath = memory.memoryMarkdownPath('bot-main')
    expect(existsSync(mdPath)).toBe(true)
    expect(existsSync(join(repoA, '.local'))).toBe(false)
    const mdText = readFileSync(mdPath, 'utf8')
    expect(mdText).toContain('# Bridge Memory — 研发助手 (bot-main)')
    expect(mdText).toContain('禁止在晚间自动合并 PR')
    expect(mdText).toContain('存储层已升级至 SQLite WAL v3 + FTS5')
    expect(mdText).not.toContain('存储层迁移至 SQLite WAL')

    store.close()
  })

  it('enforces HTTP auth boundaries (CLI soft-archive only, Owner hard-delete) and works end-to-end via lark-bridge memory CLI', async () => {
    const dataDir = makeTempDir()
    const workDir = makeTempDir('work-')
    const store = new LarkBridgeStore(dataDir)
    const memory = new BridgeMemoryService(dataDir, store)

    store.upsertBot({
      id: 'cli-bot',
      name: 'CLI 测试助手',
      enabled: true,
      larkAppId: 'cli_demo_cli',
      larkAppSecret: 'sec_demo_cli',
      defaultWorkingDir: workDir,
    })

    const cliAuth = ensureCliAuthEndpoint(dataDir, 'http://127.0.0.1:3880')
    const fakeCtx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as Context
    const manager = {
      store,
      memory,
      cliAuth,
      listBotStatuses: () => [],
      resolveAgentContext: (sid?: string) =>
        sid === 'sess-ctx-1'
          ? { botId: 'cli-bot', chatId: 'oc_ctx_chat', workingDir: workDir }
          : {},
    } as unknown as LarkBridgeManager

    const admitter: ConnectionAdmitter = {
      admit: () => ({ peer: { principal: { kind: 'owner' } } }),
    }
    const handler = createLarkHttpHandler(fakeCtx, admitter, manager)

    // 1. CLI Bearer can create & auto-infer botId + chatId scope from sessionId
    const createRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/lark-bridge/memory',
      headers: { authorization: `Bearer ${cliAuth.token}` },
      body: {
        sessionId: 'sess-ctx-1',
        scope: 'chat',
        type: 'user',
        title: '群内汇报偏好',
        content: '先给结论与数据，再列细节。',
      },
    })
    expect(createRes.status).toBe(201)
    const createdId = String((createRes.json.entry as { id: string }).id)
    expect((createRes.json.entry as { botId: string; scopeId: string }).botId).toBe('cli-bot')
    expect((createRes.json.entry as { scopeId: string }).scopeId).toBe('oc_ctx_chat')

    // GET /bots reports activeMemoryCount
    const botsRes = await invokeHandler(handler, { url: '/api/lark-bridge/bots' })
    expect(botsRes.status).toBe(200)
    const botList = botsRes.json.bots as Array<{ id: string; activeMemoryCount?: number }>
    expect(botList.find((b) => b.id === 'cli-bot')?.activeMemoryCount).toBe(1)

    // 2. CLI Bearer is FORBIDDEN from physical hard delete (?hard=1)
    const cliHardDel = await invokeHandler(handler, {
      method: 'DELETE',
      url: `/api/lark-bridge/memory/${encodeURIComponent(createdId)}?hard=1`,
      headers: { authorization: `Bearer ${cliAuth.token}` },
    })
    expect(cliHardDel.status).toBe(403)
    expect(cliHardDel.json.error).toBe('owner_web_session_required')

    // 3. Spin up real ephemeral loopback HTTP server & exercise real `lark-bridge memory` CLI commands
    const server = createServer((req, res) => {
      void handler(req, res)
    })
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    const addr = server.address() as { port: number }
    const apiBaseUrl = `http://127.0.0.1:${addr.port}/api/lark-bridge`

    try {
      const runCli = async (args: string[]) => {
        const { stdout } = await execFileAsync(process.execPath, [cliEntryPath, ...args], {
          env: {
            ...process.env,
            LARK_BRIDGE_API_URL: apiBaseUrl,
            LARK_BRIDGE_CLI_TOKEN: cliAuth.token,
            DSH_SESSION_ID: 'sess-ctx-1',
          },
          encoding: 'utf8',
        })
        return JSON.parse(stdout) as Record<string, unknown>
      }

      const upserted = await runCli([
        'memory',
        'upsert',
        '--type',
        'feedback',
        '--title',
        '接口测试使用模拟桩',
        '--content',
        '禁止在自动化单测中请求线上外部 API。',
        '--tags',
        'testing,mock',
        '--pin',
      ])
      expect(upserted.ok).toBe(true)
      const memId = String((upserted.entry as { id: string }).id)

      const searched = await runCli(['memory', 'search', '模拟桩'])
      expect(searched.ok).toBe(true)
      expect((searched.entries as Array<{ id: string }>).map((e) => e.id)).toContain(memId)

      const got = await runCli(['memory', 'get', memId])
      expect((got.entry as { pinned: boolean }).pinned).toBe(true)

      const superseded = await runCli([
        'memory',
        'supersede',
        memId,
        '--reason',
        '补充离线契约测试要求',
        '--title',
        '接口测试使用模拟桩与契约测试',
        '--content',
        '所有单测使用本地模拟桩，并覆盖契约边界。',
      ])
      expect(superseded.ok).toBe(true)
      const replacementId = String((superseded.replacementEntry as { id: string }).id)
      expect((superseded.oldEntry as { status: string }).status).toBe('superseded')

      const forgotten = await runCli(['memory', 'forget', replacementId, '--reason', '测试清理'])
      expect(forgotten.ok).toBe(true)
      expect((forgotten.entry as { status: string }).status).toBe('archived')
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    }

    // 4. Owner Web session CAN physically hard-delete
    const ownerHardDel = await invokeHandler(handler, {
      method: 'DELETE',
      url: `/api/lark-bridge/memory/${encodeURIComponent(createdId)}?hard=1`,
    })
    expect(ownerHardDel.status).toBe(200)
    expect(memory.get(createdId, { recordRecall: false })).toBeUndefined()

    store.close()
  })
})
