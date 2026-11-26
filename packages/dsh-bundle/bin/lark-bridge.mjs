#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { resolveDataDir, runDbCliCommand, runOfflineDoctor } from '@dsh-lark/dsh-lark-bridge/db-cli'

const HELP = `lark-bridge — DSH 飞书桥接辅助 CLI（零密钥暴露，自动感知当前会话上下文）

用法:
  lark-bridge context [--session <id>]
  lark-bridge bots
  lark-bridge chats [--bot <botId>]
  lark-bridge members [--bot <botId>] [--chat <chatId>] [--query <关键词>]
  lark-bridge users search <query> [--bot <botId>]
  lark-bridge send [text] [选项]
  lark-bridge silence [--reason <原因>] [--session <id>]
  lark-bridge history [--bot <botId>] [--chat <chatId>] [--thread <rootOrThreadId|none>] [--limit <n>]
  lark-bridge message <messageId> [--bot <botId>] [--download-dir <dir>] [--no-download] [--raw]
  lark-bridge memory list [--bot <botId>] [--scope bot|chat|workspace] [--scope-id <id>] [--type feedback|user|project|reference] [--status active|superseded|archived|all] [--limit <n>]
  lark-bridge memory search <query> [--bot <botId>] [--scope bot|chat|workspace] [--type feedback|user|project|reference] [--status active|superseded|archived|all] [--limit <n>]
  lark-bridge memory get <memoryId>
  lark-bridge memory upsert --type <feedback|user|project|reference> --title <标题> (--content <正文> | --content-file <路径>) [--bot <botId>] [--scope bot|chat|workspace] [--scope-id <id>] [--tags a,b] [--confidence high|medium] [--supersedes <oldId>] [--reason <原因>] [--pin]
  lark-bridge memory supersede <memoryId> --reason <原因> [--type <type>] [--title <标题> (--content <正文> | --content-file <路径>)] [--scope bot|chat|workspace] [--scope-id <id>] [--tags a,b] [--pin]
  lark-bridge memory forget <memoryId> [--reason <原因>]
  lark-bridge reminder list [--status active|archived|all]
  lark-bridge reminder create --title <标题> (--at "<YYYY-MM-DD HH:mm|ISO>" | --after <秒>) (--prompt <文本> | --prompt-file <路径>) [--kind general|delegation] [--reason <原因>] [--urgency normal|high] [--mention <openId[:姓名]>] [--cc <openId[:姓名]>] [--bot <botId>] [--chat <chatId>] [--user <openId>] [--reply-to <messageId>] [--mode thread|chat|p2p] [--cwd <目录>] [--worktree <路径> --branch <分支> [--pr <链接>]]
  lark-bridge reminder update <reminderId> [--title <标题>] [--at "<YYYY-MM-DD HH:mm|ISO>"] [--prompt <文本> | --prompt-file <路径>] [--reason <原因>] [--mention <openId[:姓名]>] [--cc <openId[:姓名]>]
  lark-bridge reminder cancel <reminderId>
  lark-bridge reminder run <reminderId>
  lark-bridge worktree create <slug> [--prefix agent/] [--base HEAD] [--cwd <仓库目录>]
  lark-bridge worktree list [--cwd <仓库目录>]
  lark-bridge schedule list
  lark-bridge schedule create --title <标题> (--prompt <文本> | --prompt-file <路径>) (--cron <表达式> | --daily <HH:MM> | --weekly <1,2..@HH:MM> | --every <秒> | --after <秒>) [--tz Asia/Shanghai] [--bot <botId> --chat <chatId>] [--mode chat|thread] [--notify non_empty|always|error_only] [--cwd <目录>] [--preset <id>]
  lark-bridge schedule update <scheduleId> [--title <标题>] [--prompt <文本> | --prompt-file <路径>] [--cron <表达式> | --daily <HH:MM> | --weekly <1,2..@HH:MM> | --every <秒> | --after <秒>] [--tz Asia/Shanghai] [--cwd <目录>] [--preset <id>] [--pause | --resume]
  lark-bridge schedule delete <scheduleId>
  lark-bridge schedule bind <scheduleId> --bot <botId> --chat <chatId> [--mode chat|thread] [--notify non_empty|always|error_only]
  lark-bridge schedule run <scheduleId>
  lark-bridge db status [--data-dir <目录>]
  lark-bridge db migrate [--data-dir <目录>] [--from <state.json>] [--dry-run] [--force]
  lark-bridge db verify [--data-dir <目录>] [--against <backup.json>]
  lark-bridge db backup [--data-dir <目录>] [--out <输出路径>]
  lark-bridge db export [--data-dir <目录>] [--out <输出路径>] [--redact]
  lark-bridge db rollback --from <backup.json> [--to-json] [--data-dir <目录>] [--force]
  lark-bridge db compact [--data-dir <目录>] [--force]
  lark-bridge lifecycle status
  lark-bridge lifecycle drain [--wait] [--timeout <秒>] [--reason <原因>]
  lark-bridge lifecycle resume-intake
  lark-bridge plugin status [--check] [--force]
  lark-bridge plugin check [--force]
  lark-bridge plugin update [bridge|external-agents|all] [--version <vX.Y.Z>] [--timeout <秒>] [--force] [--no-wait] [--detached [--delay <秒>] [--notify-bot <botId> --notify-chat <chatId>]]
  lark-bridge doctor [--data-dir <目录>] [--json]

send 选项:
  --bot <botId>             指定发送智能体（默认使用当前会话绑定的智能体）
  --chat <chatId>           指定目标群聊 oc_xxx（默认使用当前会话所在群聊）
  --user <openId>           发送私聊消息给指定用户 ou_xxx
  --reply-to <messageId>    引用回复指定消息 om_xxx（在非话题内显式指定）
  --thread                  以话题形式回复（配合 --reply-to 或当前话题会话）
  --top-level               强制在群顶层发送（不挂入当前话题）
  --title <标题>             卡片标题
  --text-only               以纯文本或纯图片发送（不使用消息卡片）
  --content-file <路径>      从 UTF-8 文件读取正文（多行复杂 Markdown 推荐用法，也支持 stdin 管道）
  --card-file <路径>         直接发送飞书 Schema 2.0 卡片 JSON 文件
  --card-json <JSON>        直接发送飞书 Schema 2.0 卡片 JSON 字符串
  --image <路径>             上传并附带本地图片（可重复传参；正文中可用 ![说明](img:0) 定位）
  --image-mode <模式>        图片宽度模式：fit_horizontal（默认）| medium | small | tiny
  --file <路径>              上传并发送本地文件附件（可重复传参）
  --mention <openId[:姓名]>  在消息开头 @ 指定成员（可重复传参，open_id 须为当前智能体应用视角）
`

const MULTI_FLAGS = new Set(['image', 'file', 'mention', 'cc'])
const BOOL_FLAGS = new Set([
  'help',
  'h',
  'thread',
  'top-level',
  'text-only',
  'no-download',
  'raw',
  'dry-run',
  'force',
  'redact',
  'to-json',
  'json',
  'pin',
  'wait',
  'no-wait',
  'detached',
  'check',
  'allow-migrate-local',
  'allow-restart-required',
  'allow-in-session',
  'pause',
  'resume',
])

function parseCliArgs(argv) {
  const positionals = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('-')) {
      positionals.push(token)
      continue
    }
    if (token === '-h') {
      flags.help = true
      continue
    }
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const eqIdx = token.indexOf('=')
    const key = eqIdx >= 0 ? token.slice(2, eqIdx) : token.slice(2)
    let val = eqIdx >= 0 ? token.slice(eqIdx + 1) : undefined

    if (BOOL_FLAGS.has(key) && val === undefined) {
      const next = argv[i + 1]
      if (key === 'thread' && positionals[0] === 'history' && next !== undefined && !next.startsWith('-')) {
        flags[key] = next
        i += 1
        continue
      }
      flags[key] = true
      continue
    }
    if (val === undefined) {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        val = next
        i += 1
      } else {
        val = 'true'
      }
    }
    if (MULTI_FLAGS.has(key)) {
      if (!Array.isArray(flags[key])) flags[key] = []
      flags[key].push(val)
    } else {
      flags[key] = val
    }
  }
  return { positionals, flags }
}

function ensureSelfIgnoredDir(rootDir) {
  mkdirSync(rootDir, { recursive: true })
  const ignoreFile = join(rootDir, '.gitignore')
  if (!existsSync(ignoreFile)) {
    writeFileSync(ignoreFile, '*\n', 'utf8')
  }
  return rootDir
}

function ensureWorkspaceArtifactDir(workspaceDir, ...segments) {
  const base = ensureSelfIgnoredDir(join(resolve(workspaceDir), '.dsh-lark-bridge'))
  const target = join(base, ...segments)
  mkdirSync(target, { recursive: true })
  return target
}

function parseMentions(rawList) {
  return (rawList || []).map((raw) => {
    const str = String(raw).trim()
    const idx = str.indexOf(':')
    return idx >= 0
      ? { openId: str.slice(0, idx).trim(), name: str.slice(idx + 1).trim() }
      : { openId: str }
  })
}

function loadEndpointConfig() {
  const envUrl = process.env.LARK_BRIDGE_API_URL?.trim()
  const envToken = process.env.LARK_BRIDGE_CLI_TOKEN?.trim()
  if (envUrl && envToken) {
    return { apiBaseUrl: envUrl.replace(/\/+$/, ''), token: envToken }
  }

  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const endpointFile =
    process.env.LARK_BRIDGE_ENDPOINT_FILE?.trim() ||
    join(dshHome, 'lark-bridge', 'cli-endpoint.json')

  if (!existsSync(endpointFile)) {
    throw new Error(
      `未找到桥接 CLI 凭证文件 (${endpointFile})，请确认 dsh-lark-bridge 服务已启动。`,
    )
  }
  const parsed = JSON.parse(readFileSync(endpointFile, 'utf8'))
  if (!parsed?.apiBaseUrl || !parsed?.token) {
    throw new Error(`桥接 CLI 凭证文件格式无效：${endpointFile}`)
  }
  return {
    apiBaseUrl: String(parsed.apiBaseUrl).replace(/\/+$/, ''),
    token: String(parsed.token),
  }
}

async function apiRequest(endpoint, method, path, body, extraHeaders) {
  const res = await fetch(`${endpoint.apiBaseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${endpoint.token}`,
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(extraHeaders || {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  return data
}

function loadOperatorToken(flags) {
  const dataDir = resolveDataDir(flags['data-dir'])
  const tokenFile = join(dataDir, 'operator-token')
  if (!existsSync(tokenFile)) {
    throw new Error(`未找到本机运维凭证 (${tokenFile})，请确认 dsh-lark-bridge 服务已启动。`)
  }
  const token = readFileSync(tokenFile, 'utf8').trim()
  if (token.length < 32) {
    throw new Error(`本机运维凭证无效：${tokenFile}`)
  }
  return token
}

async function readPipedStdin() {
  if (process.stdin.isTTY) return ''
  const chunks = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function normalizeTimeHHMMSS(raw) {
  const trimmed = String(raw).trim()
  if (/^\d{1,2}:\d{2}$/.test(trimmed)) {
    const [h, m] = trimmed.split(':')
    return `${h.padStart(2, '0')}:${m}:00`
  }
  if (/^\d{1,2}:\d{2}:\d{2}$/.test(trimmed)) {
    const [h, m, s] = trimmed.split(':')
    return `${h.padStart(2, '0')}:${m}:${s}`
  }
  throw new Error(`无效的时间格式 "${raw}"，请使用 HH:MM（例如 09:30）`)
}

function buildScheduleTiming(flags, options = {}) {
  const { optional = false } = options
  const selectors = ['cron', 'daily', 'weekly', 'every', 'after'].filter((k) => flags[k] !== undefined)
  if (selectors.length > 1) {
    throw new Error('请仅指定一种定时规则（--cron、--daily、--weekly、--every 或 --after 不能同时使用）')
  }
  if (selectors.length === 0) {
    if (optional) {
      if (flags.tz !== undefined) {
        throw new Error('仅指定 --tz 无法更新定时规则，请同时指定 --cron、--daily 或 --weekly')
      }
      return undefined
    }
    throw new Error('请指定一种定时规则：--cron、--daily、--weekly、--every 或 --after')
  }
  const tz = String(flags.tz || 'Asia/Shanghai')
  if (flags.cron) {
    return { kind: 'cron', cron: { expression: String(flags.cron).trim(), time_zone: tz } }
  }
  if (flags.daily) {
    return { kind: 'daily', daily: { time: normalizeTimeHHMMSS(flags.daily), time_zone: tz } }
  }
  if (flags.weekly) {
    const raw = String(flags.weekly).trim()
    const [daysPart, timePart] = raw.split('@')
    if (!daysPart || !timePart) {
      throw new Error('--weekly 格式应为 "<星期列表>@<HH:MM>"，例如 "1,2,3,4,5@09:30"')
    }
    const weekdays = daysPart
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7)
    if (weekdays.length === 0) throw new Error('--weekly 星期列表须为 1..7（1=周一, 7=周日）')
    return {
      kind: 'weekly',
      weekly: { time: normalizeTimeHHMMSS(timePart), time_zone: tz, weekdays },
    }
  }
  if (flags.every) {
    const sec = Number(flags.every)
    if (!Number.isFinite(sec) || sec <= 0) throw new Error('--every 须为正秒数')
    return { kind: 'every', every_seconds: Math.round(sec) }
  }
  if (flags.after) {
    const sec = Number(flags.after)
    if (!Number.isFinite(sec) || sec <= 0) throw new Error('--after 须为正秒数')
    return { kind: 'after', after_seconds: Math.round(sec) }
  }
  return undefined
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pollPluginUpdateOperation(endpoint, operationId, headers, maxWaitMs) {
  const terminalStates = new Set(['succeeded', 'failed', 'rolled_back'])
  const deadline = Date.now() + Math.max(30_000, maxWaitMs)
  let lastStage = ''
  let lastOp = null
  let consecutiveErrors = 0

  while (Date.now() < deadline) {
    try {
      const res = await apiRequest(
        endpoint,
        'GET',
        `/plugins/update-status?operationId=${encodeURIComponent(operationId)}`,
        undefined,
        headers,
      )
      consecutiveErrors = 0
      const op = res.operation
      if (op) {
        lastOp = op
        const stageKey = `${op.status}:${op.message}`
        if (stageKey !== lastStage) {
          lastStage = stageKey
          process.stderr.write(`[lark-bridge plugin] ${op.status}: ${op.message}\n`)
        }
        if (terminalStates.has(op.status)) {
          return op
        }
      }
    } catch {
      consecutiveErrors += 1
      if (consecutiveErrors === 1) {
        process.stderr.write('[lark-bridge plugin] 插件正在热重载，等待服务恢复连接…\n')
      }
    }
    await sleepMs(1500)
  }

  return (
    lastOp || {
      operationId,
      status: 'failed',
      message: '等待插件热更新完成超时',
      error: 'poll_timeout',
      hotReloaded: false,
      restartRequired: false,
      items: [],
    }
  )
}

async function handlePluginCommand(endpoint, positionals, flags) {
  const sub = (positionals[1] || 'status').toLowerCase()

  if (sub === 'status') {
    const qs = new URLSearchParams()
    if (flags.check) qs.set('check', '1')
    if (flags.force) qs.set('force', '1')
    const suffix = qs.toString()
    printJson(await apiRequest(endpoint, 'GET', `/plugins/updates${suffix ? `?${suffix}` : ''}`))
    return
  }

  if (sub === 'check') {
    const force = flags.force !== undefined ? Boolean(flags.force) : true
    printJson(await apiRequest(endpoint, 'POST', '/plugins/check', { force }))
    return
  }

  if (sub === 'update') {
    const target = String(positionals[2] || flags.target || 'all').trim()
    const delaySecEnv = Number(process.env.DSH_LARK_DETACHED_DELAY_SEC || 0)
    if (Number.isFinite(delaySecEnv) && delaySecEnv > 0) {
      await sleepMs(delaySecEnv * 1000)
    }

    if (flags.detached) {
      const dataDir = resolveDataDir(flags['data-dir'])
      const logDir = join(dataDir, 'logs')
      mkdirSync(logDir, { recursive: true })
      const logPath = join(logDir, `plugin-update-${Date.now()}.log`)
      const delaySec = flags.delay !== undefined ? Math.max(1, Number(flags.delay) || 6) : 6
      const forwarded = ['plugin', 'update', target, '--allow-in-session']
      if (flags.version) forwarded.push('--version', String(flags.version))
      if (flags.timeout !== undefined) forwarded.push('--timeout', String(flags.timeout))
      if (flags.force) forwarded.push('--force')
      if (flags['allow-migrate-local']) forwarded.push('--allow-migrate-local')
      if (flags['allow-restart-required']) forwarded.push('--allow-restart-required')
      if (flags['data-dir']) forwarded.push('--data-dir', String(flags['data-dir']))
      if (flags['notify-bot']) forwarded.push('--notify-bot', String(flags['notify-bot']))
      if (flags['notify-chat']) forwarded.push('--notify-chat', String(flags['notify-chat']))

      const childEnv = { ...process.env, DSH_LARK_DETACHED_DELAY_SEC: String(delaySec) }
      delete childEnv.DSH_SESSION_ID
      delete childEnv.DSH_IN_AGENT_SESSION
      delete childEnv.ANTIGRAVITY_CONVERSATION_ID
      const outFd = openSync(logPath, 'a')
      const child = spawn(process.execPath, [process.argv[1], ...forwarded], {
        detached: true,
        stdio: ['ignore', outFd, outFd],
        env: childEnv,
      })
      child.unref()
      printJson({
        ok: true,
        detached: true,
        pid: child.pid,
        target,
        delaySec,
        logPath,
        message: `已派发后台免重启热更新进程（延迟 ${delaySec}s 启动）`,
      })
      return
    }

    const inAgentSession = Boolean(
      process.env.DSH_SESSION_ID ||
        process.env.DSH_IN_AGENT_SESSION ||
        process.env.ANTIGRAVITY_CONVERSATION_ID,
    )
    if (inAgentSession && !flags['allow-in-session']) {
      throw new Error(
        '拒绝在活跃 Agent 会话内直接热更新插件（会中断当前会话）；请使用 --detached 派发后台延迟热更新，或在宿主机终端执行。',
      )
    }

    const operatorToken = loadOperatorToken(flags)
    const headers = { 'x-lark-bridge-operator': operatorToken }
    const timeoutSec = flags.timeout !== undefined ? Number(flags.timeout) : 90
    const drainTimeoutMs = Number.isFinite(timeoutSec) ? Math.max(0, timeoutSec * 1000) : 90_000

    const accepted = await apiRequest(
      endpoint,
      'POST',
      '/plugins/update',
      {
        target,
        ...(flags.version ? { version: String(flags.version).trim() } : {}),
        drainTimeoutMs,
        force: Boolean(flags.force),
        allowMigrateLocal: Boolean(flags['allow-migrate-local']),
        allowRestartRequired: Boolean(flags['allow-restart-required']),
      },
      headers,
    )

    if (flags['no-wait']) {
      printJson(accepted)
      return
    }

    const op = await pollPluginUpdateOperation(
      endpoint,
      accepted.operation.operationId,
      headers,
      drainTimeoutMs + 180_000,
    )
    const ok = op.status === 'succeeded'

    const notifyBot = flags['notify-bot'] ? String(flags['notify-bot']).trim() : ''
    const notifyChat = flags['notify-chat'] ? String(flags['notify-chat']).trim() : ''
    if (notifyBot && notifyChat) {
      const itemsText = (op.items || [])
        .map(
          (item) =>
            `- **${item.displayName}** (\`${item.packageName}\`)：${item.fromVersion ? `v${item.fromVersion}` : '未安装'} → v${item.toVersion}（${item.status === 'succeeded' ? (item.hotReloaded ? '已免重启热重载' : '需重启生效') : item.status === 'rolled_back' ? '安装失败已自动回滚' : '失败'}）`,
        )
        .join('\n')
      const text = [
        ok ? '✅ **插件热更新完成**' : '⚠️ **插件热更新未完成**',
        '',
        op.message || '',
        itemsText ? `\n${itemsText}` : '',
      ]
        .filter(Boolean)
        .join('\n')
      await apiRequest(endpoint, 'POST', '/agent/send', {
        botId: notifyBot,
        chatId: notifyChat,
        replyInThread: false,
        title: ok ? 'DSH 插件热更新完成' : 'DSH 插件热更新告警',
        text,
      }).catch(() => {})
    }

    printJson({ ok, operation: op })
    if (!ok) {
      process.exitCode = 1
    }
    return
  }

  throw new Error(
    '用法：lark-bridge plugin status [--check] | check [--force] | update [bridge|external-agents|all] [--version <vX.Y.Z>] [--detached]',
  )
}

function handleWorktreeCommand(positionals, flags) {
  const sub = positionals[1] ?? 'list'
  const repoCwd = resolve(String(flags.cwd || process.cwd()))
  let repoRoot = ''
  try {
    repoRoot = execFileSync('git', ['-C', repoCwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    throw new Error(`当前目录不在 Git 仓库中：${repoCwd}`)
  }

  if (sub === 'list') {
    const raw = execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const worktrees = []
    let current = null
    for (const line of raw.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current) worktrees.push(current)
        current = { path: line.slice(9).trim() }
      } else if (current && line.startsWith('branch ')) {
        current.branch = line.slice(7).trim().replace(/^refs\/heads\//, '')
      } else if (current && line.startsWith('HEAD ')) {
        current.head = line.slice(5).trim()
      }
    }
    if (current) worktrees.push(current)
    printJson({ ok: true, repoRoot, worktrees })
    return
  }

  if (sub === 'create') {
    const rawSlug = String(positionals[2] || '').trim()
    const slug = rawSlug.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
    if (!slug) {
      throw new Error('用法：lark-bridge worktree create <slug> [--prefix agent/] [--base HEAD]')
    }
    const rawPrefix = flags.prefix !== undefined ? String(flags.prefix).trim() : 'agent/'
    const branchPrefix = rawPrefix ? (rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`) : ''
    const branch = `${branchPrefix}${slug}`
    const baseRef = String(flags.base || 'HEAD').trim()
    const worktreesRoot = ensureSelfIgnoredDir(join(repoRoot, '.worktrees'))
    const worktreePath = join(worktreesRoot, slug)
    if (existsSync(worktreePath)) {
      throw new Error(`Worktree 目录已存在：${worktreePath}`)
    }
    try {
      execFileSync(
        'git',
        ['-C', repoRoot, 'worktree', 'add', '-b', branch, worktreePath, baseRef],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (err) {
      const stderr = err && typeof err === 'object' && 'stderr' in err ? String(err.stderr).trim() : ''
      throw new Error(stderr || (err instanceof Error ? err.message : String(err)))
    }
    printJson({ ok: true, repoRoot, worktreePath, branch, base: baseRef })
    return
  }

  throw new Error(`未知的 worktree 子命令 "${sub}"（支持 create | list）`)
}

async function handleMemoryCommand(endpoint, positionals, flags, sessionId) {
  const sub = positionals[1] ?? 'list'

  if (sub === 'list' || sub === 'search') {
    const params = new URLSearchParams()
    if (sessionId) params.set('sessionId', sessionId)
    if (flags.bot) params.set('botId', String(flags.bot))
    if (flags.scope) params.set('scope', String(flags.scope))
    if (flags['scope-id']) params.set('scopeId', String(flags['scope-id']))
    if (flags.type) params.set('type', String(flags.type))
    if (flags.status) params.set('status', String(flags.status))
    if (flags.limit) params.set('limit', String(flags.limit))
    if (sub === 'search') {
      const q = positionals.slice(2).join(' ').trim() || String(flags.query || flags.q || '').trim()
      if (!q) throw new Error('用法：lark-bridge memory search "<关键词>" [--bot <botId>]')
      params.set('q', q)
    } else if (flags.query || flags.q) {
      params.set('q', String(flags.query || flags.q).trim())
    }
    printJson(await apiRequest(endpoint, 'GET', `/memory?${params.toString()}`))
    return
  }

  if (sub === 'get') {
    const memoryId = positionals[2]
    if (!memoryId) throw new Error('用法：lark-bridge memory get <memoryId>')
    printJson(await apiRequest(endpoint, 'GET', `/memory/${encodeURIComponent(memoryId)}`))
    return
  }

  if (sub === 'upsert') {
    const type = String(flags.type || '').trim()
    const title = String(flags.title || '').trim()
    const content = flags['content-file']
      ? readFileSync(resolve(String(flags['content-file'])), 'utf8').trim()
      : flags.content
        ? String(flags.content).trim()
        : (await readPipedStdin()).trim()
    if (!type || !title || !content) {
      throw new Error(
        '用法：lark-bridge memory upsert --type <feedback|user|project|reference> --title <标题> (--content <正文> | --content-file <路径>)',
      )
    }
    const payload = {
      ...(sessionId ? { sessionId } : {}),
      ...(flags.bot ? { botId: String(flags.bot) } : {}),
      ...(flags.scope ? { scope: String(flags.scope) } : {}),
      ...(flags['scope-id'] ? { scopeId: String(flags['scope-id']) } : {}),
      ...(flags.tags ? { tags: String(flags.tags) } : {}),
      ...(flags.confidence ? { confidence: String(flags.confidence) } : {}),
      ...(flags.supersedes ? { supersedesId: String(flags.supersedes) } : {}),
      ...(flags.reason ? { supersedeReason: String(flags.reason) } : {}),
      ...(flags.pin ? { pinned: true } : {}),
      type,
      title,
      content,
    }
    printJson(await apiRequest(endpoint, 'POST', '/memory', payload))
    return
  }

  if (sub === 'supersede') {
    const memoryId = positionals[2]
    const reason = String(flags.reason || '').trim()
    if (!memoryId || !reason) {
      throw new Error(
        '用法：lark-bridge memory supersede <memoryId> --reason <原因> [--type <type> --title <标题> --content <正文>]',
      )
    }
    const content = flags['content-file']
      ? readFileSync(resolve(String(flags['content-file'])), 'utf8').trim()
      : flags.content
        ? String(flags.content).trim()
        : undefined
    const payload = {
      ...(sessionId ? { sessionId } : {}),
      reason,
      ...(flags.type ? { type: String(flags.type) } : {}),
      ...(flags.title ? { title: String(flags.title) } : {}),
      ...(content ? { content } : {}),
      ...(flags.scope ? { scope: String(flags.scope) } : {}),
      ...(flags['scope-id'] ? { scopeId: String(flags['scope-id']) } : {}),
      ...(flags.tags ? { tags: String(flags.tags) } : {}),
      ...(flags.confidence ? { confidence: String(flags.confidence) } : {}),
      ...(flags.pin ? { pinned: true } : {}),
    }
    printJson(
      await apiRequest(endpoint, 'POST', `/memory/${encodeURIComponent(memoryId)}/supersede`, payload),
    )
    return
  }

  if (sub === 'forget' || sub === 'archive') {
    const memoryId = positionals[2]
    if (!memoryId) throw new Error('用法：lark-bridge memory forget <memoryId> [--reason <原因>]')
    const params = new URLSearchParams()
    if (flags.reason) params.set('reason', String(flags.reason))
    const qs = params.toString()
    printJson(
      await apiRequest(
        endpoint,
        'DELETE',
        `/memory/${encodeURIComponent(memoryId)}${qs ? `?${qs}` : ''}`,
      ),
    )
    return
  }

  throw new Error(`未知的 memory 子命令 "${sub}"（支持 list | search | get | upsert | supersede | forget）`)
}

async function handleReminderCommand(endpoint, positionals, flags, sessionId) {
  const sub = positionals[1] ?? 'list'
  if (sub === 'list') {
    const status = String(flags.status || 'active').trim()
    const data = await apiRequest(
      endpoint,
      'GET',
      `/reminders?status=${encodeURIComponent(status)}`,
    )
    printJson(data)
    return
  }

  if (sub === 'create') {
    const title = String(flags.title || '').trim()
    const prompt = flags['prompt-file']
      ? readFileSync(resolve(String(flags['prompt-file'])), 'utf8').trim()
      : flags.prompt
        ? String(flags.prompt).trim()
        : (await readPipedStdin()).trim()
    if (!title || !prompt) {
      throw new Error(
        '用法：lark-bridge reminder create --title <标题> (--at "<YYYY-MM-DD HH:mm>" | --after <秒>) (--prompt <文本> | --prompt-file <路径>)',
      )
    }
    const mentions = parseMentions(flags.mention)
    const ccMentions = parseMentions(flags.cc)
    const worktree =
      flags.worktree && flags.branch
        ? {
            worktreePath: resolve(String(flags.worktree)),
            branch: String(flags.branch).trim(),
            ...(flags.pr ? { prUrl: String(flags.pr).trim() } : {}),
          }
        : undefined
    const payload = {
      ...(sessionId ? { sessionId } : {}),
      ...(flags.bot ? { botId: String(flags.bot) } : {}),
      ...(flags.chat ? { chatId: String(flags.chat) } : {}),
      ...(flags.user ? { userOpenId: String(flags.user) } : {}),
      ...(flags['reply-to'] ? { replyToMessageId: String(flags['reply-to']) } : {}),
      ...(flags.mode ? { deliveryMode: String(flags.mode) } : {}),
      ...(flags.kind ? { kind: String(flags.kind).trim() } : {}),
      ...(flags.cwd ? { workingDir: resolve(String(flags.cwd)) } : {}),
      ...(flags.reason ? { reason: String(flags.reason).trim() } : {}),
      ...(flags.urgency ? { urgency: String(flags.urgency).trim() } : {}),
      ...(flags.at ? { at: String(flags.at).trim() } : {}),
      ...(flags.after !== undefined ? { afterSeconds: Number(flags.after) } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(ccMentions.length > 0 ? { ccMentions } : {}),
      ...(worktree ? { worktree } : {}),
      title,
      prompt,
    }
    const data = await apiRequest(endpoint, 'POST', '/reminders', payload)
    printJson(data)
    return
  }

  if (sub === 'update') {
    const reminderId = positionals[2]
    if (!reminderId) throw new Error('用法：lark-bridge reminder update <reminderId> [--title ...] [--at ...] [--prompt ...] [--mention ...] [--cc ...]')
    const prompt = flags['prompt-file']
      ? readFileSync(resolve(String(flags['prompt-file'])), 'utf8').trim()
      : flags.prompt !== undefined
        ? String(flags.prompt).trim()
        : undefined
    const mentions = flags.mention !== undefined ? parseMentions(flags.mention) : undefined
    const ccMentions = flags.cc !== undefined ? parseMentions(flags.cc) : undefined
    const data = await apiRequest(endpoint, 'PUT', `/reminders/${encodeURIComponent(reminderId)}`, {
      ...(flags.title !== undefined ? { title: String(flags.title) } : {}),
      ...(flags.at !== undefined ? { at: String(flags.at) } : {}),
      ...(flags.reason !== undefined ? { reason: String(flags.reason) } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
      ...(mentions !== undefined ? { mentions } : {}),
      ...(ccMentions !== undefined ? { ccMentions } : {}),
    })
    printJson(data)
    return
  }

  if (sub === 'cancel' || sub === 'run') {
    const reminderId = positionals[2]
    if (!reminderId) throw new Error(`用法：lark-bridge reminder ${sub} <reminderId>`)
    const data = await apiRequest(
      endpoint,
      'POST',
      `/reminders/${encodeURIComponent(reminderId)}/${sub}`,
    )
    printJson(data)
    return
  }

  throw new Error(`未知的 reminder 子命令 "${sub}"`)
}

async function handleScheduleCommand(endpoint, positionals, flags, sessionId) {
  const sub = positionals[1] ?? 'list'
  if (sub === 'list') {
    printJson(await apiRequest(endpoint, 'GET', '/schedules'))
    return
  }
  if (sub === 'create') {
    const title = String(flags.title || '').trim()
    const prompt = flags['prompt-file']
      ? readFileSync(resolve(String(flags['prompt-file'])), 'utf8')
      : String(flags.prompt || '').trim()
    if (!title || !prompt) {
      throw new Error('用法：lark-bridge schedule create --title <标题> (--prompt <文本> | --prompt-file <路径>) ...')
    }
    const timing = buildScheduleTiming(flags)
    const data = await apiRequest(endpoint, 'POST', '/agent/schedules', {
      ...(sessionId ? { sessionId } : {}),
      title,
      prompt,
      timing,
      ...(flags.cwd ? { cwd: String(flags.cwd) } : {}),
      ...(flags.preset ? { agentPreset: String(flags.preset) } : {}),
      ...(flags.bot ? { botId: String(flags.bot) } : {}),
      ...(flags.chat ? { chatId: String(flags.chat) } : {}),
      ...(flags.mode ? { deliveryMode: String(flags.mode) } : {}),
      ...(flags.notify ? { notifyOn: String(flags.notify) } : {}),
    })
    printJson(data)
    return
  }
  if (sub === 'update') {
    const scheduleId = positionals[2]
    if (!scheduleId) {
      throw new Error(
        '用法：lark-bridge schedule update <scheduleId> [--title <标题>] [--prompt <文本> | --prompt-file <路径>] [--daily <HH:MM> | --weekly <1,2..@HH:MM> | --cron <表达式> | --every <秒> | --after <秒>] [--tz Asia/Shanghai] [--cwd <目录>] [--preset <id>] [--pause | --resume]',
      )
    }
    if (flags.pause && flags.resume) {
      throw new Error('--pause 与 --resume 不能同时使用')
    }
    const prompt = flags['prompt-file']
      ? readFileSync(resolve(String(flags['prompt-file'])), 'utf8')
      : flags.prompt !== undefined
        ? String(flags.prompt)
        : undefined
    const timing = buildScheduleTiming(flags, { optional: true })
    const payload = {
      ...(flags.title !== undefined ? { title: String(flags.title) } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
      ...(timing !== undefined ? { timing } : {}),
      ...(flags.cwd !== undefined ? { cwd: String(flags.cwd) } : {}),
      ...(flags.preset !== undefined ? { agentPreset: String(flags.preset) } : {}),
      ...(flags.pause ? { active: false } : {}),
      ...(flags.resume ? { active: true } : {}),
    }
    if (Object.keys(payload).length === 0) {
      throw new Error('请至少指定一个要更新的字段（--title、--prompt、--daily/--weekly/--cron、--cwd、--preset、--pause 或 --resume）')
    }
    const data = await apiRequest(
      endpoint,
      'PATCH',
      `/agent/schedules/${encodeURIComponent(scheduleId)}`,
      payload,
    )
    printJson(data)
    return
  }
  if (sub === 'delete') {
    const scheduleId = positionals[2]
    if (!scheduleId) throw new Error('用法：lark-bridge schedule delete <scheduleId>')
    printJson(
      await apiRequest(endpoint, 'DELETE', `/agent/schedules/${encodeURIComponent(scheduleId)}`),
    )
    return
  }
  if (sub === 'bind') {
    const scheduleId = positionals[2]
    const botId = String(flags.bot || '').trim()
    const chatId = String(flags.chat || '').trim()
    if (!scheduleId || !botId || !chatId) {
      throw new Error('用法：lark-bridge schedule bind <scheduleId> --bot <botId> --chat <chatId>')
    }
    const data = await apiRequest(
      endpoint,
      'PUT',
      `/schedules/${encodeURIComponent(scheduleId)}`,
      {
        enabled: true,
        targets: [{ botId, chatId }],
        deliveryMode: String(flags.mode || 'chat'),
        notifyOn: String(flags.notify || 'non_empty'),
      },
    )
    printJson(data)
    return
  }
  if (sub === 'run') {
    const scheduleId = positionals[2]
    if (!scheduleId) throw new Error('用法：lark-bridge schedule run <scheduleId>')
    printJson(await apiRequest(endpoint, 'POST', `/schedules/${encodeURIComponent(scheduleId)}/run`))
    return
  }
  throw new Error(`未知的 schedule 子命令 "${sub}"（支持 list | create | update | delete | bind | run）`)
}

async function main() {
  const { positionals, flags } = parseCliArgs(process.argv.slice(2))
  const cmd = positionals[0]
  if (!cmd || flags.help || cmd === 'help') {
    process.stdout.write(HELP)
    return
  }

  if (cmd === 'worktree') {
    handleWorktreeCommand(positionals, flags)
    return
  }

  if (cmd === 'db') {
    const sub = positionals[1] ?? 'status'
    const result = runDbCliCommand(sub, flags)
    printJson(result)
    if (!result.ok) {
      process.exitCode = 1
    }
    return
  }

  if (cmd === 'doctor') {
    const dataDir = resolveDataDir(typeof flags['data-dir'] === 'string' ? flags['data-dir'] : undefined)
    const offline = runOfflineDoctor(dataDir)
    let live = null
    let liveError = null
    try {
      const endpoint = loadEndpointConfig()
      live = await apiRequest(endpoint, 'GET', '/diagnostics')
    } catch (err) {
      liveError = err instanceof Error ? err.message : String(err)
    }
    const overallOk = offline.ok && (live ? Boolean(live.ok) : true)
    printJson({
      ok: overallOk,
      offline,
      ...(live ? { live } : { liveUnavailableReason: liveError }),
    })
    if (!overallOk) {
      process.exitCode = 1
    }
    return
  }

  const endpoint = loadEndpointConfig()
  const explicitOrEnvSessionId = String(flags.session || process.env.DSH_SESSION_ID || '').trim()
  const fallbackExternalId = !explicitOrEnvSessionId
    ? String(process.env.ANTIGRAVITY_CONVERSATION_ID || '').trim()
    : ''
  const sessionId =
    explicitOrEnvSessionId || (fallbackExternalId ? `ext:${fallbackExternalId}` : undefined)
  const qSession = sessionId ? `sessionId=${encodeURIComponent(sessionId)}` : ''
  const inAgentSession = Boolean(
    process.env.DSH_SESSION_ID ||
      process.env.DSH_IN_AGENT_SESSION ||
      process.env.ANTIGRAVITY_CONVERSATION_ID,
  )

  if (cmd === 'lifecycle') {
    const sub = positionals[1] || 'status'
    if (sub === 'status') {
      printJson(await apiRequest(endpoint, 'GET', '/lifecycle/status'))
      return
    }
    if (sub === 'drain' || sub === 'resume-intake') {
      if (inAgentSession && !flags['allow-in-session']) {
        throw new Error(
          '拒绝在 Agent 会话内直接变更桥接排空状态；请在宿主机运维终端执行（或在明确需要时传 --allow-in-session）。',
        )
      }
      const operatorToken = loadOperatorToken(flags)
      const headers = { 'x-lark-bridge-operator': operatorToken }
      if (sub === 'drain') {
        const timeoutSec = flags.timeout !== undefined ? Number(flags.timeout) : 120
        const timeoutMs = Number.isFinite(timeoutSec) ? Math.max(0, timeoutSec * 1000) : 120_000
        const result = await apiRequest(
          endpoint,
          'POST',
          '/lifecycle/drain',
          {
            wait: Boolean(flags.wait),
            timeoutMs,
            ...(flags.reason ? { reason: String(flags.reason) } : {}),
          },
          headers,
        )
        printJson(result)
        if (flags.wait && !result.drained) {
          process.exitCode = 2
        }
        return
      }
      printJson(await apiRequest(endpoint, 'POST', '/lifecycle/resume-intake', {}, headers))
      return
    }
    throw new Error(
      '用法：lark-bridge lifecycle status | drain [--wait] [--timeout <秒>] [--reason <原因>] | resume-intake',
    )
  }

  if (cmd === 'plugin') {
    await handlePluginCommand(endpoint, positionals, flags)
    return
  }

  if (cmd === 'context') {
    printJson(await apiRequest(endpoint, 'GET', `/agent/context${qSession ? `?${qSession}` : ''}`))
    return
  }

  if (cmd === 'bots') {
    const ctxData = await apiRequest(endpoint, 'GET', '/agent/context')
    printJson({ ok: true, bots: ctxData.bots })
    return
  }

  if (cmd === 'chats') {
    const q = flags.bot ? `?botId=${encodeURIComponent(String(flags.bot))}` : ''
    const data = await apiRequest(endpoint, 'GET', `/groups${q}`)
    printJson({
      ok: true,
      chats: (data.groups || []).map((g) => ({
        botId: g.botId,
        botName: g.botName,
        chatId: g.chatId,
        chatName: g.chatName,
        workspaceName: g.effectiveWorkspaceName,
        workingDir: g.effectiveWorkingDir,
        listenerEnabled: Boolean(g.config?.listener?.enabled),
      })),
    })
    return
  }

  if (cmd === 'members') {
    let botId = flags.bot ? String(flags.bot).trim() : ''
    let chatId = flags.chat ? String(flags.chat).trim() : ''
    const query = String(flags.query ?? positionals.slice(1).join(' ')).trim()
    if (!botId || !chatId) {
      const ctxData = await apiRequest(
        endpoint,
        'GET',
        `/agent/context${qSession ? `?${qSession}` : ''}`,
      )
      botId = botId || ctxData.botId || ''
      chatId = chatId || ctxData.chatId || ''
    }
    if (!botId || !chatId) {
      throw new Error('请通过 --bot <botId> --chat <chatId> 指定目标群，或在已绑定飞书会话内运行')
    }
    const params = new URLSearchParams({ includeAvatars: '0' })
    if (query) params.set('q', query)
    const data = await apiRequest(
      endpoint,
      'GET',
      `/groups/${encodeURIComponent(botId)}/${encodeURIComponent(chatId)}/members?${params.toString()}`,
    )
    const members = (data.members || []).map((m) => ({
      openId: m.openId,
      name: m.name,
      memberType: m.memberType,
      ...(m.email ? { email: m.email } : {}),
      ...(m.larkAppId ? { larkAppId: m.larkAppId } : {}),
    }))
    printJson({ ok: true, botId, chatId, ...(query ? { query } : {}), members })
    return
  }

  if (cmd === 'users') {
    const sub = positionals[1]
    const query = positionals.slice(2).join(' ').trim()
    if (sub !== 'search') {
      throw new Error('用法：lark-bridge users search <关键词> [--bot <botId>]')
    }
    let botId = flags.bot ? String(flags.bot).trim() : ''
    if (!botId) {
      const ctxData = await apiRequest(
        endpoint,
        'GET',
        `/agent/context${qSession ? `?${qSession}` : ''}`,
      )
      botId = ctxData.botId || ''
    }
    if (!botId) throw new Error('未找到可用智能体，请使用 --bot <botId> 指定')
    const data = await apiRequest(
      endpoint,
      'GET',
      `/bots/${encodeURIComponent(botId)}/users/search?q=${encodeURIComponent(query)}`,
    )
    printJson({ ok: true, botId, users: data.users })
    return
  }

  if (cmd === 'silence') {
    const reason = String(flags.reason ?? positionals.slice(1).join(' ')).trim() || undefined
    printJson(
      await apiRequest(endpoint, 'POST', '/agent/silence', {
        ...(sessionId ? { sessionId } : {}),
        ...(reason ? { reason } : {}),
      }),
    )
    return
  }

  if (cmd === 'send') {
    let text = ''
    if (flags['content-file']) {
      text = readFileSync(resolve(String(flags['content-file'])), 'utf8')
    } else if (positionals.length > 1) {
      text = positionals.slice(1).join(' ')
    } else {
      text = await readPipedStdin()
    }

    let card
    if (flags['card-file']) {
      card = JSON.parse(readFileSync(resolve(String(flags['card-file'])), 'utf8'))
    } else if (flags['card-json']) {
      card = JSON.parse(String(flags['card-json']))
    }
    if (card && typeof card === 'object' && card.card && typeof card.card === 'object') {
      card = card.card
    }

    const imageMode = flags['image-mode'] ? String(flags['image-mode']) : undefined
    const images = (flags.image || []).map((p) => {
      const abs = resolve(String(p))
      return {
        fileName: basename(abs),
        dataBase64: readFileSync(abs).toString('base64'),
        ...(imageMode ? { mode: imageMode } : {}),
      }
    })

    const files = (flags.file || []).map((p) => {
      const abs = resolve(String(p))
      return {
        fileName: basename(abs),
        dataBase64: readFileSync(abs).toString('base64'),
      }
    })

    const mentions = parseMentions(flags.mention)
    const topLevel = Boolean(flags['top-level'])
    const payload = {
      ...(sessionId && !topLevel ? { sessionId } : {}),
      ...(flags.bot ? { botId: String(flags.bot) } : {}),
      ...(flags.chat ? { chatId: String(flags.chat) } : {}),
      ...(flags.user ? { userOpenId: String(flags.user) } : {}),
      ...(flags['reply-to'] ? { replyToMessageId: String(flags['reply-to']) } : {}),
      ...(flags.thread ? { replyInThread: true } : topLevel ? { replyInThread: false } : {}),
      ...(flags.title ? { title: String(flags.title) } : {}),
      ...(text ? { text } : {}),
      ...(flags['text-only'] ? { textOnly: true } : {}),
      ...(card ? { card } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(images.length > 0 ? { images } : {}),
      ...(files.length > 0 ? { files } : {}),
    }

    if (topLevel && !payload.chatId && sessionId) {
      const ctxData = await apiRequest(endpoint, 'GET', `/agent/context?${qSession}`)
      if (ctxData.botId && !payload.botId) payload.botId = ctxData.botId
      if (ctxData.chatId) payload.chatId = ctxData.chatId
    }

    printJson(await apiRequest(endpoint, 'POST', '/agent/send', payload))
    return
  }

  if (cmd === 'history') {
    const params = new URLSearchParams()
    if (sessionId) params.set('sessionId', sessionId)
    if (flags.bot) params.set('botId', String(flags.bot))
    if (flags.chat) params.set('chatId', String(flags.chat))
    if (flags.thread) params.set('threadId', String(flags.thread))
    if (flags.limit) params.set('limit', String(flags.limit))
    printJson(await apiRequest(endpoint, 'GET', `/agent/history?${params.toString()}`))
    return
  }

  if (cmd === 'message') {
    const messageId = positionals[1]
    if (!messageId) throw new Error('用法：lark-bridge message <messageId> [--download-dir <dir>] [--raw]')
    const shouldDownload = !flags['no-download']
    const params = new URLSearchParams()
    if (sessionId) params.set('sessionId', sessionId)
    if (flags.bot) params.set('botId', String(flags.bot))
    if (shouldDownload) params.set('download', '1')
    if (flags.raw) params.set('raw', '1')

    const data = await apiRequest(
      endpoint,
      'GET',
      `/agent/messages/${encodeURIComponent(messageId)}?${params.toString()}`,
    )
    const msg = { ...data.message }
    if (Array.isArray(msg.downloaded) && msg.downloaded.length > 0) {
      const outDir = flags['download-dir']
        ? resolve(String(flags['download-dir']))
        : ensureWorkspaceArtifactDir(process.cwd(), 'attachments', messageId)
      mkdirSync(outDir, { recursive: true })
      msg.attachments = msg.downloaded.map((item) => {
        const safeName = basename(item.fileName || item.key)
        const fullPath = join(outDir, safeName)
        writeFileSync(fullPath, Buffer.from(item.dataBase64, 'base64'))
        return { type: item.type, key: item.key, path: fullPath }
      })
      delete msg.downloaded
    }
    printJson({ ok: true, message: msg })
    return
  }

  if (cmd === 'memory') {
    await handleMemoryCommand(endpoint, positionals, flags, sessionId)
    return
  }

  if (cmd === 'reminder') {
    await handleReminderCommand(endpoint, positionals, flags, sessionId)
    return
  }

  if (cmd === 'schedule') {
    await handleScheduleCommand(endpoint, positionals, flags, sessionId)
    return
  }

  throw new Error(`未知命令 "${cmd}"，运行 \`lark-bridge --help\` 查看帮助`)
}

main().catch((err) => {
  process.stderr.write(`lark-bridge error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
