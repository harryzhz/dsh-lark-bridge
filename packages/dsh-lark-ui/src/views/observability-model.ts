import type { ObservabilityWindow } from '../types.js'

export const OBSERVABILITY_WINDOWS: ReadonlyArray<{
  readonly value: ObservabilityWindow
  readonly label: string
  readonly desc: string
}> = [
  { value: '24h', label: '24h', desc: '近 24 小时（按小时）' },
  { value: '7d', label: '7d', desc: '近 7 天（每 6 小时）' },
  { value: '30d', label: '30d', desc: '近 30 天（按天）' },
  { value: '90d', label: '90d', desc: '近 90 天（每 3 天）' },
]

export const P2P_CHAT_FILTER = '__p2p__'

export const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const

export const TRIGGER_LABELS: Readonly<Record<string, string>> = {
  mention: '@提及对话',
  p2p: '私聊直达',
  listener: '主动监听',
  substitute: '代答模式',
  delegate: '委派跟进',
  triage: '智能分流',
  schedule: '定时任务',
  reminder: '主动提醒',
  dreaming: 'Dreaming 记忆整理',
  command: '斜杠命令',
  active_thread: '话题续聊',
  group: '群聊对话',
}

export const ERROR_CODE_LABELS: Readonly<Record<string, string>> = {
  timeout: '模型 / 分流超时',
  rate_limited: '上游限流 / 429',
  auth_error: '鉴权或凭据失败',
  upstream_5xx: '上游服务 5xx',
  upstream_4xx: '上游请求 4xx',
  network_error: '网络连接异常',
  message_recalled: '消息已撤回 (230006)',
  turn_aborted: '回合中止 / 取消',
  triage_fallback: '智能分流回退直通',
  tool_error: '工具调用失败',
  dream_error: 'Dreaming 执行异常',
  turn_error: '回合执行异常',
  llm_error: '模型调用异常',
}

export const TABLE_LABELS: Readonly<Record<string, string>> = {
  telemetry_usage_events: '遥测明细事件',
  telemetry_daily_rollups: '按天聚合指标',
  telemetry_session_watermarks: '会话索引水位',
  audit_events: '运行审计日志',
  managed_sessions: '受管会话索引',
  triage_sessions: '智能分流记录',
  triage_context_scopes: '分流滑动上下文',
  session_bindings: '活跃路由绑定',
  binding_aliases: '话题路由别名',
  memory_entries: '长期记忆条目',
  reminders: '提醒事项',
  seen_messages: '消息去重缓存',
  dream_sessions: 'Dreaming 记录',
  hourly_buckets: '小时指标桶',
  pending_turns: '断点续跑表',
  groups: '群聊配置',
  bots: '智能体配置',
}

export function resolveTriggerLabel(trigger: string): string {
  return TRIGGER_LABELS[trigger] ?? (trigger || '其他')
}

export function resolveErrorCodeLabel(code: string): string {
  return ERROR_CODE_LABELS[code] ?? (code || '未知异常')
}

export function resolveTableLabel(table: string): string {
  return TABLE_LABELS[table] ?? table
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`
  return String(Math.round(n))
}

export function formatCompactNumber(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`
  return Math.round(n).toLocaleString('en-US')
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(bytes >= 100 * 1024 ** 2 ? 1 : 2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(bytes >= 100 * 1024 ? 0 : 1)} KB`
  return `${Math.round(bytes)} B`
}

export function formatLatencyMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 1 : 2)}s`
  const mins = Math.floor(ms / 60_000)
  const secs = Math.round((ms % 60_000) / 1000)
  return `${mins}m ${secs}s`
}

export function formatUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0m'
  const days = Math.floor(sec / 86_400)
  const hours = Math.floor((sec % 86_400) / 3_600)
  const mins = Math.floor((sec % 3_600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${Math.max(1, mins)}m`
}

export function formatDeltaBadge(
  deltaPct: number | null,
  options: { readonly invertGood?: boolean; readonly unit?: '%' | 'pp' } = {},
): {
  readonly text: string
  readonly tone: 'good' | 'bad' | 'neutral'
} {
  if (deltaPct === null || !Number.isFinite(deltaPct)) {
    return { text: 'NEW', tone: 'neutral' }
  }
  const suffix = options.unit ?? '%'
  if (Math.abs(deltaPct) < 0.05) {
    return { text: `0${suffix}`, tone: 'neutral' }
  }
  const sign = deltaPct > 0 ? '+' : '−'
  const text = `${sign}${Math.abs(deltaPct).toFixed(1)}${suffix}`
  const isPositiveGood = !options.invertGood
  const tone = (deltaPct > 0) === isPositiveGood ? 'good' : 'bad'
  return { text, tone }
}

export function resolveHeatmapLevel(count: number, maxCount: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || maxCount <= 0) return 0
  const ratio = count / maxCount
  if (ratio >= 0.75) return 4
  if (ratio >= 0.45) return 3
  if (ratio >= 0.2) return 2
  return 1
}

export function buildSparklineGeometry(
  values: readonly number[],
  width: number,
  height: number,
  padY = 3,
): { readonly linePath: string; readonly areaPath: string; readonly hasData: boolean } {
  const clean = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0))
  const max = Math.max(0, ...clean)
  if (clean.length < 2 || max <= 0) {
    const midY = height - padY
    return {
      linePath: `M 0 ${midY} L ${width} ${midY}`,
      areaPath: '',
      hasData: false,
    }
  }
  const usableH = Math.max(2, height - padY * 2)
  const stepX = width / (clean.length - 1)
  const pts = clean.map((v, i) => {
    const x = Math.round(i * stepX * 10) / 10
    const y = Math.round((padY + usableH * (1 - v / max)) * 10) / 10
    return [x, y] as const
  })
  const linePath = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ')
  const areaPath = `${linePath} L ${width} ${height} L 0 ${height} Z`
  return { linePath, areaPath, hasData: true }
}

export function computeNiceAxisMax(rawMax: number): number {
  if (!Number.isFinite(rawMax) || rawMax <= 0) return 1
  const exp = Math.floor(Math.log10(rawMax))
  const pow = 10 ** exp
  const norm = rawMax / pow
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return nice * pow
}
