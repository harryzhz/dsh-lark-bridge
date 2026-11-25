import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconChevronUpOutlineRegular,
  IconCopyOutlineRegular,
  IconPinFillRegular,
  IconPinOutlineRegular,
  IconPlusOutlineRegular,
  Tag,
  type MenuEntry,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgeApi } from '../api.js'
import type { ConfirmRequest } from '../components/ConfirmDialog.js'
import {
  Avatar,
  CountSegmentedSwitch,
  FilterTabs,
  ListFilterBar,
  OverflowMenu,
  resolveEffectiveBotId,
} from '../components/fields.js'
import type { MemoryDialogRequest } from '../components/MemoryEditDialog.js'
import { leafDirectoryLabel } from '../components/options.js'
import { formatTime } from '../state.js'
import type { BotRecord, GroupView, MemoryEntry, MemoryType } from '../types.js'

export type MemoryPane = 'active' | 'history'
export type MemoryTypeFilter = 'all' | MemoryType
export type MemoryHistoryFilter = 'all' | 'superseded' | 'archived'

export const MEMORY_TYPE_META: Readonly<
  Record<MemoryType, { readonly label: string; readonly shortLabel: string; readonly tone: TagTone }>
> = {
  feedback: { label: '纠偏与规范', shortLabel: '纠偏', tone: 'warning' },
  user: { label: '用户偏好', shortLabel: '偏好', tone: 'info' },
  project: { label: '项目决策', shortLabel: '决策', tone: 'success' },
  reference: { label: '外部参考', shortLabel: '参考', tone: 'neutral' },
}

export const MEMORY_TYPE_FILTERS: ReadonlyArray<{
  readonly value: MemoryTypeFilter
  readonly label: string
}> = [
  { value: 'all', label: '全部' },
  { value: 'feedback', label: '纠偏' },
  { value: 'user', label: '偏好' },
  { value: 'project', label: '决策' },
  { value: 'reference', label: '参考' },
]

export const MEMORY_HISTORY_FILTERS: ReadonlyArray<{
  readonly value: MemoryHistoryFilter
  readonly label: string
}> = [
  { value: 'all', label: '全部' },
  { value: 'superseded', label: '已纠偏' },
  { value: 'archived', label: '已归档' },
]

export function resolveMemoryScopeLabel(
  entry: Pick<MemoryEntry, 'botId' | 'scope' | 'scopeId'>,
  groups: readonly Pick<GroupView, 'botId' | 'chatId' | 'chatName'>[],
): { readonly label: string; readonly fullTitle: string } {
  if (entry.scope === 'bot') {
    return { label: '全局', fullTitle: '智能体全局（该智能体所有群聊与私聊可见）' }
  }
  if (entry.scope === 'chat') {
    const found = groups.find((g) => g.botId === entry.botId && g.chatId === entry.scopeId)
    if (found?.chatName) {
      return { label: `群聊 · ${found.chatName}`, fullTitle: `${found.chatName} (${entry.scopeId})` }
    }
    return { label: `群聊 · ${entry.scopeId}`, fullTitle: entry.scopeId }
  }
  const leaf = leafDirectoryLabel(entry.scopeId) || entry.scopeId
  return { label: `工作区 · ${leaf}`, fullTitle: entry.scopeId }
}

export function countMemoriesByType(
  entries: readonly MemoryEntry[],
): Record<MemoryType, number> {
  const counts: Record<MemoryType, number> = { feedback: 0, user: 0, project: 0, reference: 0 }
  for (const e of entries) counts[e.type] += 1
  return counts
}

export function countMemoriesByHistoryStatus(
  entries: readonly MemoryEntry[],
): { readonly superseded: number; readonly archived: number } {
  let superseded = 0
  let archived = 0
  for (const e of entries) {
    if (e.status === 'superseded') superseded += 1
    else if (e.status === 'archived') archived += 1
  }
  return { superseded, archived }
}

export function filterMemoryEntries(input: {
  readonly entries: readonly MemoryEntry[]
  readonly botId: string
  readonly pane: MemoryPane
  readonly typeFilter: MemoryTypeFilter
  readonly historyFilter: MemoryHistoryFilter
  readonly query: string
  readonly bots?: readonly Pick<BotRecord, 'id' | 'name'>[]
  readonly groups?: readonly Pick<GroupView, 'botId' | 'chatId' | 'chatName'>[]
}): MemoryEntry[] {
  const { entries, botId, pane, typeFilter, historyFilter, query, bots = [], groups = [] } = input
  const q = query.trim().toLowerCase()
  const botNameById = new Map(bots.map((b) => [b.id, b.name]))

  return entries.filter((entry) => {
    if (botId && entry.botId !== botId) return false
    if (pane === 'active') {
      if (entry.status !== 'active') return false
      if (typeFilter !== 'all' && entry.type !== typeFilter) return false
    } else {
      if (entry.status === 'active') return false
      if (historyFilter !== 'all' && entry.status !== historyFilter) return false
    }
    if (!q) return true
    const scopeInfo = resolveMemoryScopeLabel(entry, groups)
    const botName = botNameById.get(entry.botId) ?? ''
    return (
      entry.title.toLowerCase().includes(q) ||
      entry.content.toLowerCase().includes(q) ||
      entry.id.toLowerCase().includes(q) ||
      entry.scopeId.toLowerCase().includes(q) ||
      scopeInfo.label.toLowerCase().includes(q) ||
      botName.toLowerCase().includes(q) ||
      entry.botId.toLowerCase().includes(q) ||
      (entry.supersedeReason ?? '').toLowerCase().includes(q) ||
      entry.tags.some((t) => t.toLowerCase().includes(q))
    )
  })
}

export function partitionActiveMemories(entries: readonly MemoryEntry[]): {
  readonly pinned: MemoryEntry[]
  readonly normal: MemoryEntry[]
} {
  const pinned: MemoryEntry[] = []
  const normal: MemoryEntry[] = []
  for (const entry of entries) {
    if (entry.pinned) pinned.push(entry)
    else normal.push(entry)
  }
  return { pinned, normal }
}

function formatFullTimestamp(ms?: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  if (!Number.isFinite(d.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function isLongContent(content: string): boolean {
  return content.length > 130 || content.includes('\n')
}

interface MemoryRowActions {
  readonly onTogglePin: (entry: MemoryEntry) => void
  readonly onEdit: (entry: MemoryEntry) => void
  readonly onSupersede: (entry: MemoryEntry) => void
  readonly onArchive: (entry: MemoryEntry) => void
  readonly onRestore: (entry: MemoryEntry) => void
  readonly onDelete: (entry: MemoryEntry) => void
  readonly onCopy: (text: string, notice: string) => void
  readonly onTagClick: (tag: string) => void
  readonly onJumpToEntry: (id: string) => void
  readonly onOpenSession?: (sessionId: string) => void
}

function buildMemoryMenuItems(
  entry: MemoryEntry,
  actions: MemoryRowActions,
): Array<MenuEntry & { onSelect?: () => void }> {
  const isActive = entry.status === 'active'
  return [
    ...(isActive
      ? [{ id: 'supersede', label: '纠偏替代…', onSelect: () => actions.onSupersede(entry) }]
      : [
          { id: 'edit', label: '编辑内容', onSelect: () => actions.onEdit(entry) },
          ...(entry.supersededBy
            ? [
                {
                  id: 'jump-replacement',
                  label: '查看替代记忆',
                  onSelect: () => actions.onJumpToEntry(entry.supersededBy!),
                },
              ]
            : []),
        ]),
    ...(entry.sourceSessionId && actions.onOpenSession
      ? [
          {
            id: 'source-session',
            label: '查看来源会话',
            onSelect: () => actions.onOpenSession!(entry.sourceSessionId!),
          },
        ]
      : []),
    {
      id: 'copy-content',
      label: '复制标题与正文',
      onSelect: () => actions.onCopy(`${entry.title}\n\n${entry.content}`, '已复制记忆内容'),
    },
    {
      id: 'copy-id',
      label: '复制记忆 ID',
      onSelect: () => actions.onCopy(entry.id, `已复制 ${entry.id}`),
    },
    { type: 'separator' as const, id: 'sep' },
    ...(isActive ? [{ id: 'archive', label: '归档', onSelect: () => actions.onArchive(entry) }] : []),
    { id: 'delete', label: '永久删除', danger: true, onSelect: () => actions.onDelete(entry) },
  ]
}

function MemoryRowFooter({
  entry,
  bot,
  showBotBadge,
  scopeInfo,
  canExpand,
  expanded,
  onToggleExpand,
  onTagClick,
}: {
  entry: MemoryEntry
  bot?: BotRecord
  showBotBadge: boolean
  scopeInfo: { readonly label: string; readonly fullTitle: string }
  canExpand: boolean
  expanded: boolean
  onToggleExpand: () => void
  onTagClick: (tag: string) => void
}) {
  return (
    <div className="fb-mem-foot">
      <div className="fb-mem-meta-left">
        {showBotBadge && (
          <span className="fb-mem-bot">
            <Avatar src={bot?.avatarUrl} name={bot?.name ?? entry.botId} kind="bot" size="chip" />
            <span>{bot?.name ?? entry.botId}</span>
          </span>
        )}
        <span className="fb-mem-scope" title={scopeInfo.fullTitle}>
          {scopeInfo.label}
        </span>
        {entry.tags.length > 0 && (
          <div className="fb-mem-tags">
            {entry.tags.map((tag) => (
              <button
                key={tag}
                type="button"
                className="fb-mem-tag-btn"
                title={`按标签「${tag}」筛选`}
                onClick={() => onTagClick(tag)}
              >
                #{tag}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="fb-mem-meta-right fb-num">
        <span
          title={
            entry.lastRecalledAtMs
              ? `累计召回 ${entry.recallCount} 次 · 最近 ${formatFullTimestamp(entry.lastRecalledAtMs)}`
              : `累计召回 ${entry.recallCount} 次`
          }
        >
          {entry.recallCount > 0 ? `召回 ${entry.recallCount} 次` : '未召回'}
        </span>
        <span aria-hidden="true">·</span>
        <span title={`核验于 ${formatFullTimestamp(entry.lastVerifiedAtMs)}`}>
          {formatTime(entry.lastVerifiedAtMs)}
        </span>
        {(canExpand || expanded) && (
          <button
            type="button"
            className="fb-mem-expand-btn"
            aria-expanded={expanded}
            onClick={onToggleExpand}
          >
            <span>{expanded ? '收起' : '展开'}</span>
            {expanded ? (
              <IconChevronUpOutlineRegular size={12} />
            ) : (
              <IconChevronDownOutlineRegular size={12} />
            )}
          </button>
        )}
      </div>
    </div>
  )
}

function MemoryRow({
  entry,
  bot,
  showBotBadge,
  groups,
  replacementEntry,
  expanded,
  highlighted,
  mutating,
  onToggleExpand,
  actions,
}: {
  entry: MemoryEntry
  bot?: BotRecord
  showBotBadge: boolean
  groups: readonly GroupView[]
  replacementEntry?: MemoryEntry
  expanded: boolean
  highlighted: boolean
  mutating: boolean
  onToggleExpand: () => void
  actions: MemoryRowActions
}) {
  const typeMeta = MEMORY_TYPE_META[entry.type]
  const scopeInfo = resolveMemoryScopeLabel(entry, groups)
  const canExpand = isLongContent(entry.content) || Boolean(entry.sourceSessionId)
  const isActive = entry.status === 'active'
  const menuItems = buildMemoryMenuItems(entry, actions)

  return (
    <article
      id={`fb-mem-${entry.id}`}
      className="fb-mem-item"
      data-highlighted={highlighted ? '' : undefined}
      data-inactive={!isActive ? '' : undefined}
    >
      <div className="fb-mem-head">
        <div className="fb-mem-title-group">
          <Tag tone={typeMeta.tone}>{typeMeta.label}</Tag>
          {entry.status === 'superseded' && <Tag tone="neutral">已纠偏</Tag>}
          {entry.status === 'archived' && <Tag tone="quiet">已归档</Tag>}
          <button
            type="button"
            className="fb-mem-title-btn"
            aria-expanded={expanded}
            onClick={onToggleExpand}
          >
            {entry.title}
          </button>
          {entry.confidence === 'medium' && <Tag tone="quiet">中置信度</Tag>}
        </div>

        <div className="fb-mem-actions">
          {isActive ? (
            <>
              <button
                type="button"
                className="fb-mem-pin-btn"
                data-pinned={entry.pinned ? '' : undefined}
                aria-pressed={entry.pinned}
                aria-label={entry.pinned ? `取消置顶「${entry.title}」` : `置顶「${entry.title}」`}
                title={entry.pinned ? '取消核心置顶' : '置顶到核心记忆（新会话首轮优先注入）'}
                disabled={mutating}
                onClick={() => actions.onTogglePin(entry)}
              >
                {entry.pinned ? <IconPinFillRegular size={14} /> : <IconPinOutlineRegular size={14} />}
              </button>
              <Button size="sm" variant="outline" disabled={mutating} onClick={() => actions.onEdit(entry)}>
                编辑
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" disabled={mutating} onClick={() => actions.onRestore(entry)}>
              恢复有效
            </Button>
          )}
          <OverflowMenu label={`${entry.title} 更多操作`} items={menuItems} />
        </div>
      </div>

      <div
        className="fb-mem-body"
        data-expanded={expanded ? '' : undefined}
        onClick={() => {
          if (canExpand && !window.getSelection()?.toString()) onToggleExpand()
        }}
      >
        {entry.content}
      </div>

      {!isActive && (entry.supersedeReason || entry.supersededBy) && (
        <div className="fb-mem-lineage">
          <span className="fb-mem-lineage-text">
            {entry.status === 'superseded' ? '纠偏说明：' : '归档原因：'}
            {entry.supersedeReason || '已被新结论替代'}
          </span>
          {entry.supersededBy && (
            <button
              type="button"
              className="fb-inline-jump"
              onClick={() => actions.onJumpToEntry(entry.supersededBy!)}
            >
              <span>{replacementEntry ? `替代记忆：${replacementEntry.title}` : `查看 ${entry.supersededBy}`}</span>
              <IconChevronRightOutlineRegular size={13} />
            </button>
          )}
        </div>
      )}

      {expanded && (
        <div className="fb-mem-detail-strip fb-num">
          <span className="fb-mono">{entry.id}</span>
          <span>创建 {formatFullTimestamp(entry.createdAtMs)}</span>
          <span>核验 {formatFullTimestamp(entry.lastVerifiedAtMs)}</span>
          {entry.lastRecalledAtMs && <span>最近召回 {formatFullTimestamp(entry.lastRecalledAtMs)}</span>}
          {entry.sourceSessionId && actions.onOpenSession && (
            <button
              type="button"
              className="fb-inline-jump"
              onClick={() => actions.onOpenSession!(entry.sourceSessionId!)}
            >
              <span>查看来源会话</span>
              <IconChevronRightOutlineRegular size={13} />
            </button>
          )}
        </div>
      )}

      <MemoryRowFooter
        entry={entry}
        bot={bot}
        showBotBadge={showBotBadge}
        scopeInfo={scopeInfo}
        canExpand={canExpand}
        expanded={expanded}
        onToggleExpand={onToggleExpand}
        onTagClick={actions.onTagClick}
      />
    </article>
  )
}

function MemoryEmptyState({
  pane,
  hasFilter,
  onClearFilters,
  onCreate,
}: {
  pane: MemoryPane
  hasFilter: boolean
  onClearFilters: () => void
  onCreate: () => void
}) {
  if (hasFilter) {
    return (
      <div className="fb-card fb-empty">
        <div className="fb-empty-stack">
          <div>没有匹配的记忆</div>
          <Button size="sm" variant="outline" onClick={onClearFilters}>
            清除筛选
          </Button>
        </div>
      </div>
    )
  }
  if (pane === 'active') {
    return (
      <div className="fb-card fb-empty">
        <div className="fb-empty-stack">
          <div>
            暂无有效记忆。对话中收到纠偏或偏好、启用 Dreaming 自动整理，或手动新增均可沉淀到这里
          </div>
          <Button size="sm" variant="outline" icon={<IconPlusOutlineRegular size={14} />} onClick={onCreate}>
            新增记忆
          </Button>
        </div>
      </div>
    )
  }
  return <div className="fb-card fb-empty">暂无已纠偏或已归档的历史记忆</div>
}

export function MemoryView({
  bots,
  groups,
  selectedBotId,
  onSelectedBotIdChange,
  revision,
  focusEntryId,
  onFocusHandled,
  onOpenDialog,
  onConfirm,
  onToast,
  onDataChanged,
  onOpenSession,
}: {
  bots: readonly BotRecord[]
  groups: readonly GroupView[]
  selectedBotId: string
  onSelectedBotIdChange: (botId: string) => void
  revision: number
  focusEntryId?: string | null
  onFocusHandled?: () => void
  onOpenDialog: (req: MemoryDialogRequest) => void
  onConfirm: (req: ConfirmRequest) => void
  onToast: (text: string, ok?: boolean) => void
  onDataChanged: () => Promise<void>
  onOpenSession?: (sessionId: string) => void
}) {
  const [pane, setPane] = useState<MemoryPane>('active')
  const [typeFilter, setTypeFilter] = useState<MemoryTypeFilter>('all')
  const [historyFilter, setHistoryFilter] = useState<MemoryHistoryFilter>('all')
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [markdownPath, setMarkdownPath] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [mutatingId, setMutatingId] = useState<string | null>(null)
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({})
  const [highlightedId, setHighlightedId] = useState<string | null>(null)
  const reqSeqRef = useRef(0)

  const effectiveBotId = resolveEffectiveBotId(selectedBotId, bots)
  const singleScopedBotId = bots.length === 1 ? bots[0]!.id : effectiveBotId
  const botsById = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots])
  const entriesById = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries])

  const loadMemories = useCallback(
    async (silent = false) => {
      const seq = ++reqSeqRef.current
      if (!silent) setLoading(true)
      try {
        const res = await bridgeApi.memories({
          ...(singleScopedBotId ? { botId: singleScopedBotId } : {}),
          status: 'all',
          limit: 500,
        })
        if (seq !== reqSeqRef.current) return
        setEntries(res.entries ?? [])
        setMarkdownPath(res.markdownPath ?? '')
        setLoadError('')
      } catch (err) {
        if (seq !== reqSeqRef.current) return
        setLoadError(err instanceof Error ? err.message : String(err))
      } finally {
        if (seq === reqSeqRef.current) setLoading(false)
      }
    },
    [singleScopedBotId],
  )

  useEffect(() => {
    void loadMemories(false)
  }, [loadMemories, revision])

  useEffect(() => {
    const timer = window.setInterval(() => void loadMemories(true), 12_000)
    return () => window.clearInterval(timer)
  }, [loadMemories])

  const revealEntry = useCallback(
    (entryId: string, expand = true) => {
      const target = entriesById.get(entryId)
      if (!target) {
        onToast(`未找到记忆 ${entryId}（可能已被删除）`, false)
        return
      }
      setPane(target.status === 'active' ? 'active' : 'history')
      setTypeFilter('all')
      setHistoryFilter('all')
      setQuery('')
      if (expand) {
        setExpandedIds((prev) => ({ ...prev, [entryId]: true }))
      }
      setHighlightedId(entryId)
      window.requestAnimationFrame(() => {
        document.getElementById(`fb-mem-${entryId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
    },
    [entriesById, onToast],
  )

  useEffect(() => {
    if (!focusEntryId || !entriesById.has(focusEntryId)) return
    revealEntry(focusEntryId, false)
    onFocusHandled?.()
  }, [focusEntryId, entriesById, revealEntry, onFocusHandled])

  useEffect(() => {
    if (!highlightedId) return
    const timer = window.setTimeout(() => setHighlightedId(null), 2400)
    return () => window.clearTimeout(timer)
  }, [highlightedId])

  const scopedEntries = useMemo(
    () => (effectiveBotId ? entries.filter((e) => e.botId === effectiveBotId) : entries),
    [entries, effectiveBotId],
  )
  const activeScoped = useMemo(() => scopedEntries.filter((e) => e.status === 'active'), [scopedEntries])
  const historyScoped = useMemo(() => scopedEntries.filter((e) => e.status !== 'active'), [scopedEntries])
  const typeCounts = useMemo(() => countMemoriesByType(activeScoped), [activeScoped])
  const historyCounts = useMemo(() => countMemoriesByHistoryStatus(historyScoped), [historyScoped])
  const visibleEntries = useMemo(
    () =>
      filterMemoryEntries({
        entries,
        botId: effectiveBotId,
        pane,
        typeFilter,
        historyFilter,
        query,
        bots,
        groups,
      }),
    [entries, effectiveBotId, pane, typeFilter, historyFilter, query, bots, groups],
  )
  const activeGroups = useMemo(() => partitionActiveMemories(visibleEntries), [visibleEntries])

  const runMutation = async (entryId: string, task: () => Promise<unknown>, successText: string) => {
    setMutatingId(entryId)
    try {
      await task()
      onToast(successText, true)
      await Promise.all([loadMemories(true), onDataChanged()])
    } catch (err) {
      onToast(`操作失败：${err instanceof Error ? err.message : String(err)}`, false)
    } finally {
      setMutatingId(null)
    }
  }

  const rowActions: MemoryRowActions = {
    onTogglePin: (entry) =>
      void runMutation(
        entry.id,
        () => bridgeApi.updateMemory(entry.id, { pinned: !entry.pinned }),
        entry.pinned ? '已取消核心置顶' : '已置顶到核心记忆',
      ),
    onEdit: (entry) => onOpenDialog({ mode: 'edit', entry }),
    onSupersede: (entry) => onOpenDialog({ mode: 'supersede', entry }),
    onArchive: (entry) =>
      void runMutation(
        entry.id,
        () => bridgeApi.archiveMemory(entry.id, '控制台手动归档'),
        '已移入历史记录',
      ),
    onRestore: (entry) =>
      void runMutation(
        entry.id,
        () => bridgeApi.updateMemory(entry.id, { status: 'active' }),
        '已恢复为有效记忆',
      ),
    onDelete: (entry) =>
      onConfirm({
        title: `永久删除记忆「${entry.title}」？`,
        description: '永久删除后无法恢复，且会同步更新 MEMORY.md 只读镜像。如仅需停用建议使用「归档」。',
        confirmLabel: '永久删除',
        run: () => runMutation(entry.id, () => bridgeApi.deleteMemory(entry.id), '已永久删除该记忆'),
      }),
    onCopy: (text, notice) => {
      void navigator.clipboard
        ?.writeText(text)
        .then(() => onToast(notice, true))
        .catch(() => onToast('复制失败，请手动选中复制', false))
    },
    onTagClick: (tag) => setQuery((prev) => (prev.trim().toLowerCase() === tag.toLowerCase() ? '' : tag)),
    onJumpToEntry: revealEntry,
    ...(onOpenSession ? { onOpenSession } : {}),
  }

  const hasFilter = Boolean(
    effectiveBotId ||
      query.trim() ||
      (pane === 'active' ? typeFilter !== 'all' : historyFilter !== 'all'),
  )
  const showBotBadge = bots.length > 1 && !effectiveBotId

  const renderCard = (list: readonly MemoryEntry[]) => (
    <div className="fb-card fb-mem-list">
      {list.map((entry) => (
        <MemoryRow
          key={entry.id}
          entry={entry}
          bot={botsById.get(entry.botId)}
          showBotBadge={showBotBadge}
          groups={groups}
          replacementEntry={entry.supersededBy ? entriesById.get(entry.supersededBy) : undefined}
          expanded={Boolean(expandedIds[entry.id])}
          highlighted={highlightedId === entry.id}
          mutating={mutatingId === entry.id}
          onToggleExpand={() => setExpandedIds((prev) => ({ ...prev, [entry.id]: !prev[entry.id] }))}
          actions={rowActions}
        />
      ))}
    </div>
  )

  return (
    <>
      <div className="fb-view-bar">
        <CountSegmentedSwitch
          label="记忆状态视图"
          value={pane}
          options={[
            { value: 'active', label: '有效记忆', count: activeScoped.length },
            { value: 'history', label: '历史记录', count: historyScoped.length },
          ]}
          onChange={(next) => {
            setPane(next)
            setQuery('')
          }}
        />
        {pane === 'active' ? (
          <FilterTabs
            label="记忆分类筛选"
            value={typeFilter}
            options={MEMORY_TYPE_FILTERS.map((opt) => ({
              value: opt.value,
              label: opt.label,
              count: opt.value === 'all' ? activeScoped.length : typeCounts[opt.value],
            }))}
            onChange={setTypeFilter}
          />
        ) : (
          <FilterTabs
            label="历史记忆状态筛选"
            value={historyFilter}
            options={MEMORY_HISTORY_FILTERS.map((opt) => ({
              value: opt.value,
              label: opt.label,
              count:
                opt.value === 'all'
                  ? historyScoped.length
                  : opt.value === 'superseded'
                    ? historyCounts.superseded
                    : historyCounts.archived,
            }))}
            onChange={setHistoryFilter}
          />
        )}
      </div>

      <ListFilterBar
        query={query}
        onQueryChange={setQuery}
        searchPlaceholder={
          pane === 'active'
            ? '搜索标题、正文、标签、群聊或工作区'
            : '搜索历史记忆标题、正文或纠偏原因'
        }
        bots={bots}
        botId={effectiveBotId}
        onBotIdChange={onSelectedBotIdChange}
      />

      {loadError && <div className="fb-card fb-empty">加载记忆库失败：{loadError}</div>}
      {!loadError && bots.length === 0 && (
        <div className="fb-card fb-empty">
          还没有智能体，请先在「智能体」页接入飞书应用后再管理记忆库
        </div>
      )}
      {!loadError && bots.length > 0 && loading && entries.length === 0 && (
        <div className="fb-card fb-empty">加载中…</div>
      )}
      {!loadError && bots.length > 0 && (!loading || entries.length > 0) && visibleEntries.length === 0 && (
        <MemoryEmptyState
          pane={pane}
          hasFilter={hasFilter}
          onClearFilters={() => {
            setQuery('')
            setTypeFilter('all')
            setHistoryFilter('all')
            if (effectiveBotId) onSelectedBotIdChange('')
          }}
          onCreate={() =>
            onOpenDialog({
              mode: 'create',
              ...(singleScopedBotId ? { defaultBotId: singleScopedBotId } : {}),
            })
          }
        />
      )}

      {!loadError && visibleEntries.length > 0 && pane === 'active' && (
        <>
          {activeGroups.pinned.length > 0 && (
            <section className="fb-section">
              <div className="fb-section-head">
                <span className="fb-section-title">核心置顶</span>
                <span className="fb-mem-section-note fb-num">
                  新会话首轮优先注入 · {activeGroups.pinned.length} 条
                </span>
              </div>
              {renderCard(activeGroups.pinned)}
            </section>
          )}
          {activeGroups.normal.length > 0 && (
            <section className="fb-section">
              {activeGroups.pinned.length > 0 && (
                <div className="fb-section-head">
                  <span className="fb-section-title">长期记忆</span>
                  <span className="fb-mem-section-note fb-num">
                    按需检索召回 · {activeGroups.normal.length} 条
                  </span>
                </div>
              )}
              {renderCard(activeGroups.normal)}
            </section>
          )}
        </>
      )}

      {!loadError && visibleEntries.length > 0 && pane === 'history' && renderCard(visibleEntries)}

      {markdownPath && bots.length > 0 && (
        <div className="fb-mem-mirror-bar">
          <div className="fb-mem-mirror-text" title={markdownPath}>
            <span>只读镜像</span>
            <span className="fb-mono">{markdownPath}</span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            icon={<IconCopyOutlineRegular size={13} />}
            onClick={() => rowActions.onCopy(markdownPath, '已复制只读镜像路径')}
          >
            复制路径
          </Button>
        </div>
      )}
    </>
  )
}
