#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  lark-bridge history [--bot <botId>] [--chat <chatId>] [--thread <rootOrThreadId|none>] [--limit <n>]
  lark-bridge message <messageId> [--bot <botId>] [--download-dir <dir>] [--no-download] [--raw]
  lark-bridge reminder list [--status active|archived|all]
  lark-bridge reminder create --title <标题> (--at "<YYYY-MM-DD HH:mm|ISO>" | --after <秒>) (--prompt <文本> | --prompt-file <路径>) [--reason <原因>] [--mention <openId[:姓名]>] [--bot <botId>] [--chat <chatId>] [--user <openId>] [--reply-to <messageId>] [--mode thread|chat|p2p] [--cwd <目录>] [--worktree <路径> --branch <分支> [--pr <链接>]]
  lark-bridge reminder update <reminderId> [--title <标题>] [--at "<YYYY-MM-DD HH:mm|ISO>"] [--prompt <文本> | --prompt-file <路径>] [--reason <原因>]
  lark-bridge reminder cancel <reminderId>
  lark-bridge reminder run <reminderId>
  lark-bridge worktree create <slug> [--prefix agent/] [--base HEAD] [--cwd <仓库目录>]
  lark-bridge worktree list [--cwd <仓库目录>]
  lark-bridge schedule list
  lark-bridge schedule create --title <标题> (--prompt <文本> | --prompt-file <路径>) (--cron <表达式> | --daily <HH:MM> | --weekly <1,2..@HH:MM> | --every <秒> | --after <秒>) [--tz Asia/Shanghai] [--bot <botId> --chat <chatId>] [--mode chat|thread] [--notify non_empty|always|error_only] [--cwd <目录>] [--preset <id>]
  lark-bridge schedule bind <scheduleId> --bot <botId> --chat <chatId> [--mode chat|thread] [--notify non_empty|always|error_only]
  lark-bridge schedule run <scheduleId>
  lark-bridge db status [--data-dir <目录>]
  lark-bridge db migrate [--data-dir <目录>] [--from <state.json>] [--dry-run] [--force]
  lark-bridge db verify [--data-dir <目录>] [--against <backup.json>]
  lark-bridge db backup [--data-dir <目录>] [--out <输出路径>]
  lark-bridge db export [--data-dir <目录>] [--out <输出路径>] [--redact]
  lark-bridge db rollback --from <backup.json> [--to-json] [--data-dir <目录>] [--force]
  lark-bridge db compact [--data-dir <目录>] [--force]
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

const MULTI_FLAGS = new Set(['image', 'file', 'mention'])
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

async function apiRequest(endpoint, method, path, body) {
  const res = await fetch(`${endpoint.apiBaseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${endpoint.token}`,
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  return data
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

function buildScheduleTiming(flags) {
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
  throw new Error('请指定一种定时规则：--cron、--daily、--weekly、--every 或 --after')
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
      ...(flags.cwd ? { workingDir: resolve(String(flags.cwd)) } : {}),
      ...(flags.reason ? { reason: String(flags.reason).trim() } : {}),
      ...(flags.at ? { at: String(flags.at).trim() } : {}),
      ...(flags.after !== undefined ? { afterSeconds: Number(flags.after) } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
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
    if (!reminderId) throw new Error('用法：lark-bridge reminder update <reminderId> [--title ...] [--at ...] [--prompt ...]')
    const prompt = flags['prompt-file']
      ? readFileSync(resolve(String(flags['prompt-file'])), 'utf8').trim()
      : flags.prompt !== undefined
        ? String(flags.prompt).trim()
        : undefined
    const data = await apiRequest(endpoint, 'PUT', `/reminders/${encodeURIComponent(reminderId)}`, {
      ...(flags.title !== undefined ? { title: String(flags.title) } : {}),
      ...(flags.at !== undefined ? { at: String(flags.at) } : {}),
      ...(flags.reason !== undefined ? { reason: String(flags.reason) } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
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
  throw new Error(`未知的 schedule 子命令 "${sub}"`)
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
  const sessionId = String(flags.session || process.env.DSH_SESSION_ID || '').trim() || undefined
  const qSession = sessionId ? `sessionId=${encodeURIComponent(sessionId)}` : ''

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
