import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconClockOutlineRegular,
  IconCloseOutlineRegular,
  IconLayersOutlineRegular,
  IconPinFillRegular,
  IconPinOutlineRegular,
  IconPlusOutlineRegular,
  IconSearchOutlineRegular,
  Tag,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgeApi } from '../api.js'
import type { ConfirmRequest } from '../components/ConfirmDialog.js'
import {
  Avatar,
  CountSegmentedSwitch,
  FilterTabs,
  OverflowMenu,
  resolveEffectiveBotId,
  SelectMenu,
} from '../components/fields.js'
import type { MemoryDialogRequest } from '../components/MemoryEditDialog.js'
import { formatTime } from '../state.js'
import type { BotRecord, GroupView, MemoryEntry, MemoryType } from '../types.js'
import { MemoryContentBlocks } from './memory-content.js'
import {
  buildMemoryGraph,
  collectMemoryLinkedItems,
  computeGraphNeighborhood,
  DEFAULT_MEMORY_GRAPH_SETTINGS,
  extractLexicalTerms,
  GRAPH_GROUP_ORDER,
  matchGraphSearch,
  resolveMemoryViewMode,
  type MemoryGraphData,
  type MemoryGraphEdge,
  type MemoryGraphEdgeKind,
  type MemoryGraphGroupKey,
  type MemoryGraphNeighborhood,
  type MemoryGraphNode,
  type MemoryGraphSettings,
  type MemoryLinkedItem,
  type MemoryViewMode,
} from './memory-graph-model.js'
import { MemoryGraphView } from './MemoryGraphView.js'
import {
  buildMemoryHierarchy,
  collectTopMemoryTags,
  countMemoriesByHistoryStatus,
  countMemoriesByType,
  filterAndSortMemories,
  findSupersededPredecessors,
  isSameMemoryNav,
  MEMORY_HISTORY_FILTERS,
  MEMORY_SORT_OPTIONS,
  MEMORY_TYPE_META,
  MEMORY_TYPE_ORDER,
  resolveMemoryScopeLabel,
  resolveNavHeading,
  summarizeMemoryExcerpt,
  type MemoryHierarchy,
  type MemoryHistoryFilter,
  type MemoryNavNode,
  type MemorySortBy,
  type MemoryTagStat,
} from './memory-model.js'

export {
  buildMemoryGraph,
  buildMemoryHierarchy,
  collectMemoryLinkedItems,
  collectTopMemoryTags,
  computeGraphNeighborhood,
  countMemoriesByHistoryStatus,
  countMemoriesByType,
  DEFAULT_MEMORY_GRAPH_SETTINGS,
  extractLexicalTerms,
  filterAndSortMemories,
  findSupersededPredecessors,
  GRAPH_GROUP_ORDER,
  isSameMemoryNav,
  matchGraphSearch,
  MEMORY_HISTORY_FILTERS,
  MEMORY_SORT_OPTIONS,
  MEMORY_TYPE_META,
  MEMORY_TYPE_ORDER,
  resolveMemoryScopeLabel,
  resolveMemoryViewMode,
  resolveNavHeading,
  summarizeMemoryExcerpt,
  type MemoryGraphData,
  type MemoryGraphEdge,
  type MemoryGraphEdgeKind,
  type MemoryGraphGroupKey,
  type MemoryGraphNeighborhood,
  type MemoryGraphNode,
  type MemoryGraphSettings,
  type MemoryHierarchy,
  type MemoryHistoryFilter,
  type MemoryLinkedItem,
  type MemoryNavNode,
  type MemorySortBy,
  type MemoryTagStat,
  type MemoryViewMode,
}

function formatFullTimestamp(ms?: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  if (!Number.isFinite(d.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatDateOnly(ms?: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  if (!Number.isFinite(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const DEFAULT_VISIBLE_NAV_TAGS = 6

interface MemoryReaderActions {
  readonly onTogglePin: (entry: MemoryEntry) => void
  readonly onEdit: (entry: MemoryEntry) => void
  readonly onSupersede: (entry: MemoryEntry) => void
  readonly onArchive: (entry: MemoryEntry) => void
  readonly onRestore: (entry: MemoryEntry) => void
  readonly onDelete: (entry: MemoryEntry) => void
  readonly onCopy: (text: string, notice: string) => void
  readonly onSelectTag: (tag: string) => void
  readonly onJumpToEntry: (id: string) => void
  readonly onOpenSession?: (sessionId: string) => void
}

function buildOverflowItems(
  entry: MemoryEntry,
  actions: MemoryReaderActions,
  compact = false,
): Array<MenuEntry & { onSelect?: () => void }> {
  const isActive = entry.status === 'active'
  return [
    ...(compact
      ? [
          { id: 'edit', label: '编辑', onSelect: () => actions.onEdit(entry) },
          ...(isActive
            ? [{ id: 'supersede', label: '纠偏替代', onSelect: () => actions.onSupersede(entry) }]
            : [{ id: 'restore', label: '恢复有效', onSelect: () => actions.onRestore(entry) }]),
          { type: 'separator' as const, id: 'sep-compact' },
        ]
      : []),
    ...(!isActive && entry.supersededBy
      ? [
          {
            id: 'jump-replacement',
            label: '查看替代记忆',
            onSelect: () => actions.onJumpToEntry(entry.supersededBy!),
          },
        ]
      : []),
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

function MemoryNavColumn({
  bots,
  effectiveBotId,
  onBotIdChange,
  nav,
  onSelectNav,
  activeCount,
  pinnedCount,
  historyCount,
  typeCounts,
  hierarchy,
  topTags,
}: {
  bots: readonly BotRecord[]
  effectiveBotId: string
  onBotIdChange: (botId: string) => void
  nav: MemoryNavNode
  onSelectNav: (next: MemoryNavNode) => void
  activeCount: number
  pinnedCount: number
  historyCount: number
  typeCounts: Readonly<Record<MemoryType, number>>
  hierarchy: MemoryHierarchy
  topTags: readonly MemoryTagStat[]
}) {
  const [wsExpanded, setWsExpanded] = useState(true)
  const [chatExpanded, setChatExpanded] = useState(true)
  const [tagsExpanded, setTagsExpanded] = useState(false)
  const singleBot = bots.length === 1 ? bots[0] : undefined
  const activeTagOutsideDefault =
    nav.kind === 'tag' &&
    topTags.findIndex((item) => item.tag.toLowerCase() === nav.tag.toLowerCase()) >=
      DEFAULT_VISIBLE_NAV_TAGS
  const showAllTags = tagsExpanded || activeTagOutsideDefault
  const visibleTags = showAllTags ? topTags : topTags.slice(0, DEFAULT_VISIBLE_NAV_TAGS)
  const hiddenTagCount = Math.max(0, topTags.length - DEFAULT_VISIBLE_NAV_TAGS)

  return (
    <aside className="fb-mem-col-nav" aria-label="记忆目录导航">
      {bots.length > 1 ? (
        <div className="fb-mem-bot-select">
          <SelectMenu
            size="sm"
            fullWidth
            align="start"
            value={effectiveBotId}
            options={[
              { value: '', label: '全部智能体' },
              ...bots.map((b) => ({ value: b.id, label: b.name })),
            ]}
            onChange={onBotIdChange}
          />
        </div>
      ) : singleBot ? (
        <div className="fb-mem-bot-pill" title={singleBot.name}>
          <Avatar src={singleBot.avatarUrl} name={singleBot.name} kind="bot" size="chip" />
          <span className="fb-mem-bot-pill-name">{singleBot.name}</span>
        </div>
      ) : null}

      <div className="fb-mem-nav-group">
        <button
          type="button"
          className="fb-mem-facet-row"
          aria-current={isSameMemoryNav(nav, { kind: 'all' }) ? 'page' : undefined}
          onClick={() => onSelectNav({ kind: 'all' })}
        >
          <IconLayersOutlineRegular size={14} className="fb-mem-facet-icon" />
          <span className="fb-mem-facet-label">全部有效</span>
          <span className="fb-mem-facet-cnt fb-num">{activeCount}</span>
        </button>
        <button
          type="button"
          className="fb-mem-facet-row"
          aria-current={isSameMemoryNav(nav, { kind: 'pinned' }) ? 'page' : undefined}
          onClick={() => onSelectNav({ kind: 'pinned' })}
        >
          <IconPinOutlineRegular size={14} className="fb-mem-facet-icon" data-pin="" />
          <span className="fb-mem-facet-label">核心置顶</span>
          <span className="fb-mem-facet-cnt fb-num">{pinnedCount}</span>
        </button>
        <button
          type="button"
          className="fb-mem-facet-row"
          aria-current={isSameMemoryNav(nav, { kind: 'history' }) ? 'page' : undefined}
          onClick={() => onSelectNav({ kind: 'history' })}
        >
          <IconClockOutlineRegular size={14} className="fb-mem-facet-icon" />
          <span className="fb-mem-facet-label">历史演进</span>
          <span className="fb-mem-facet-cnt fb-num">{historyCount}</span>
        </button>
      </div>

      <div className="fb-mem-nav-group">
        <div className="fb-mem-nav-title">分类</div>
        {MEMORY_TYPE_ORDER.map((type) => (
          <button
            key={type}
            type="button"
            className="fb-mem-facet-row"
            aria-current={isSameMemoryNav(nav, { kind: 'type', type }) ? 'page' : undefined}
            onClick={() => onSelectNav({ kind: 'type', type })}
          >
            <span className="fb-mem-type-dot" data-type={type} aria-hidden="true" />
            <span className="fb-mem-facet-label">{MEMORY_TYPE_META[type].label}</span>
            <span className="fb-mem-facet-cnt fb-num">{typeCounts[type]}</span>
          </button>
        ))}
      </div>

      <div className="fb-mem-nav-group">
        <div className="fb-mem-nav-title">层级</div>
        <div className="fb-mem-branch-row">
          <span className="fb-mem-branch-spacer" aria-hidden="true" />
          <button
            type="button"
            className="fb-mem-facet-row fb-mem-branch-main"
            aria-current={isSameMemoryNav(nav, { kind: 'scope', scope: 'bot' }) ? 'page' : undefined}
            onClick={() => onSelectNav({ kind: 'scope', scope: 'bot' })}
          >
            <span className="fb-mem-facet-label">全局记忆</span>
            <span className="fb-mem-facet-cnt fb-num">{hierarchy.globalCount}</span>
          </button>
        </div>

        <div className="fb-mem-tree-branch">
          <div className="fb-mem-branch-row">
            <button
              type="button"
              className="fb-mem-branch-toggle"
              aria-label={wsExpanded ? '收起工作区列表' : '展开工作区列表'}
              aria-expanded={wsExpanded}
              disabled={hierarchy.workspaces.length === 0}
              onClick={() => setWsExpanded((v) => !v)}
            >
              {wsExpanded ? (
                <IconChevronDownOutlineRegular size={12} />
              ) : (
                <IconChevronRightOutlineRegular size={12} />
              )}
            </button>
            <button
              type="button"
              className="fb-mem-facet-row fb-mem-branch-main"
              aria-current={
                isSameMemoryNav(nav, { kind: 'scope', scope: 'workspace' }) ? 'page' : undefined
              }
              onClick={() => onSelectNav({ kind: 'scope', scope: 'workspace' })}
            >
              <span className="fb-mem-facet-label">工作区</span>
              <span className="fb-mem-facet-cnt fb-num">{hierarchy.workspaceTotal}</span>
            </button>
          </div>
          {wsExpanded && hierarchy.workspaces.length > 0 && (
            <div className="fb-mem-tree-sub">
              {hierarchy.workspaces.map((ws) => (
                <button
                  key={ws.scopeId}
                  type="button"
                  className="fb-mem-scope-leaf"
                  title={ws.fullTitle}
                  aria-current={
                    isSameMemoryNav(nav, {
                      kind: 'scope',
                      scope: 'workspace',
                      scopeId: ws.scopeId,
                    })
                      ? 'page'
                      : undefined
                  }
                  onClick={() =>
                    onSelectNav({ kind: 'scope', scope: 'workspace', scopeId: ws.scopeId })
                  }
                >
                  <span className="fb-mem-scope-leaf-name">{ws.label}</span>
                  <span className="fb-mem-facet-cnt fb-num">{ws.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="fb-mem-tree-branch">
          <div className="fb-mem-branch-row">
            <button
              type="button"
              className="fb-mem-branch-toggle"
              aria-label={chatExpanded ? '收起群聊列表' : '展开群聊列表'}
              aria-expanded={chatExpanded}
              disabled={hierarchy.chats.length === 0}
              onClick={() => setChatExpanded((v) => !v)}
            >
              {chatExpanded ? (
                <IconChevronDownOutlineRegular size={12} />
              ) : (
                <IconChevronRightOutlineRegular size={12} />
              )}
            </button>
            <button
              type="button"
              className="fb-mem-facet-row fb-mem-branch-main"
              aria-current={
                isSameMemoryNav(nav, { kind: 'scope', scope: 'chat' }) ? 'page' : undefined
              }
              onClick={() => onSelectNav({ kind: 'scope', scope: 'chat' })}
            >
              <span className="fb-mem-facet-label">群聊</span>
              <span className="fb-mem-facet-cnt fb-num">{hierarchy.chatTotal}</span>
            </button>
          </div>
          {chatExpanded && hierarchy.chats.length > 0 && (
            <div className="fb-mem-tree-sub">
              {hierarchy.chats.map((chat) => (
                <button
                  key={chat.scopeId}
                  type="button"
                  className="fb-mem-scope-leaf"
                  title={chat.fullTitle}
                  aria-current={
                    isSameMemoryNav(nav, {
                      kind: 'scope',
                      scope: 'chat',
                      scopeId: chat.scopeId,
                    })
                      ? 'page'
                      : undefined
                  }
                  onClick={() =>
                    onSelectNav({ kind: 'scope', scope: 'chat', scopeId: chat.scopeId })
                  }
                >
                  <span className="fb-mem-scope-leaf-name">{chat.label}</span>
                  <span className="fb-mem-facet-cnt fb-num">{chat.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {topTags.length > 0 && (
        <div className="fb-mem-nav-group">
          <div className="fb-mem-nav-title">常用标签</div>
          <div className="fb-mem-tag-cloud">
            {visibleTags.map((item) => {
              const active = isSameMemoryNav(nav, { kind: 'tag', tag: item.tag })
              return (
                <button
                  key={item.tag}
                  type="button"
                  className="fb-mem-mini-tag"
                  aria-pressed={active}
                  title={`#${item.tag} (${item.count})`}
                  onClick={() =>
                    onSelectNav(active ? { kind: 'all' } : { kind: 'tag', tag: item.tag })
                  }
                >
                  #{item.tag}
                </button>
              )
            })}
            {hiddenTagCount > 0 && (
              <button
                type="button"
                className="fb-mem-mini-tag fb-mem-tag-more"
                onClick={() => setTagsExpanded((v) => !v)}
              >
                {showAllTags ? '收起' : `+${hiddenTagCount}`}
              </button>
            )}
          </div>
        </div>
      )}
    </aside>
  )
}

function MemoryListColumn({
  heading,
  nav,
  entries,
  selectedId,
  onSelectId,
  query,
  onQueryChange,
  sortBy,
  onSortByChange,
  historyFilter,
  onHistoryFilterChange,
  historyCounts,
  botsById,
  showBotName,
  groups,
  loading,
  hasActiveTotal,
  onClearToAll,
  onCreate,
}: {
  heading: string
  nav: MemoryNavNode
  entries: readonly MemoryEntry[]
  selectedId: string | null
  onSelectId: (id: string) => void
  query: string
  onQueryChange: (next: string) => void
  sortBy: MemorySortBy
  onSortByChange: (next: MemorySortBy) => void
  historyFilter: MemoryHistoryFilter
  onHistoryFilterChange: (next: MemoryHistoryFilter) => void
  historyCounts: { readonly total: number; readonly superseded: number; readonly archived: number }
  botsById: ReadonlyMap<string, BotRecord>
  showBotName: boolean
  groups: readonly GroupView[]
  loading: boolean
  hasActiveTotal: boolean
  onClearToAll: () => void
  onCreate: () => void
}) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (entries.length === 0) return
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const idx = entries.findIndex((item) => item.id === selectedId)
    const nextIdx =
      e.key === 'ArrowDown'
        ? idx < entries.length - 1
          ? idx + 1
          : 0
        : idx > 0
          ? idx - 1
          : entries.length - 1
    const nextEntry = entries[nextIdx]
    if (nextEntry) {
      onSelectId(nextEntry.id)
      document
        .getElementById(`fb-mem-card-${nextEntry.id}`)
        ?.scrollIntoView({ block: 'nearest' })
    }
  }

  return (
    <section className="fb-mem-col-list" aria-label="记忆摘要列表">
      <div className="fb-mem-list-head">
        <div className="fb-mem-list-title-row">
          <span className="fb-mem-list-heading" title={heading}>
            <span className="fb-mem-list-heading-text">{heading}</span>
            <span className="fb-mem-list-heading-cnt fb-num">{entries.length}</span>
          </span>
          <div className="fb-mem-sort-wrap">
            <SelectMenu
              size="sm"
              value={sortBy}
              options={MEMORY_SORT_OPTIONS}
              onChange={onSortByChange}
            />
          </div>
        </div>

        {nav.kind === 'history' && (
          <div className="fb-mem-history-tabs">
            <FilterTabs
              label="历史记忆状态筛选"
              value={historyFilter}
              options={MEMORY_HISTORY_FILTERS.map((opt) => ({
                value: opt.value,
                label: opt.label,
                count:
                  opt.value === 'all'
                    ? historyCounts.total
                    : opt.value === 'superseded'
                      ? historyCounts.superseded
                      : historyCounts.archived,
              }))}
              onChange={onHistoryFilterChange}
            />
          </div>
        )}

        <div className="fb-mem-col-search">
          <IconSearchOutlineRegular size={14} className="fb-mem-search-icon" />
          <input
            type="text"
            aria-label="筛选记忆列表"
            placeholder={nav.kind === 'history' ? '筛选历史记忆…' : '筛选当前列表…'}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className="fb-mem-search-clear"
              aria-label="清空搜索"
              onClick={() => onQueryChange('')}
            >
              <IconCloseOutlineRegular size={12} />
            </button>
          )}
        </div>
      </div>

      <div
        className="fb-mem-note-scroll"
        role="listbox"
        aria-label="记忆列表"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        {loading && entries.length === 0 ? (
          <div className="fb-mem-list-empty">加载中…</div>
        ) : entries.length === 0 ? (
          <div className="fb-mem-list-empty">
            {query.trim() || nav.kind !== 'all' ? (
              <>
                <div>{nav.kind === 'history' && !query.trim() ? '暂无已纠偏或已归档的历史记忆' : '没有匹配的记忆'}</div>
                {(query.trim() || (nav.kind !== 'all' && hasActiveTotal)) && (
                  <Button size="sm" variant="outline" onClick={onClearToAll}>
                    {query.trim() ? '清除筛选' : '查看全部有效'}
                  </Button>
                )}
              </>
            ) : (
              <>
                <div>暂无有效记忆</div>
                <Button
                  size="sm"
                  variant="outline"
                  icon={<IconPlusOutlineRegular size={13} />}
                  onClick={onCreate}
                >
                  新增记忆
                </Button>
              </>
            )}
          </div>
        ) : (
          entries.map((entry) => {
            const typeMeta = MEMORY_TYPE_META[entry.type]
            const scopeInfo = resolveMemoryScopeLabel(entry, groups)
            const active = entry.id === selectedId
            const botName = showBotName ? botsById.get(entry.botId)?.name : undefined
            return (
              <button
                key={entry.id}
                id={`fb-mem-card-${entry.id}`}
                type="button"
                role="option"
                aria-selected={active}
                className="fb-mem-note-card"
                data-active={active ? '' : undefined}
                data-inactive={entry.status !== 'active' ? '' : undefined}
                onClick={() => onSelectId(entry.id)}
              >
                <div className="fb-mem-note-title">{entry.title}</div>
                <div className="fb-mem-note-meta fb-num">
                  <span className="fb-mem-note-meta-left">
                    <span
                      className="fb-mem-type-dot"
                      data-type={entry.type}
                      title={typeMeta.label}
                      aria-label={typeMeta.label}
                    />
                    <span className="fb-mem-note-scope" title={scopeInfo.fullTitle}>
                      {scopeInfo.shortLabel}
                    </span>
                    {botName && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="fb-mem-note-scope">{botName}</span>
                      </>
                    )}
                  </span>
                  <span className="fb-mem-note-time">
                    {entry.status === 'active' && entry.pinned && (
                      <IconPinFillRegular size={11} className="fb-mem-note-pin" />
                    )}
                    {entry.status === 'superseded' && (
                      <span className="fb-mem-status-chip">已纠偏</span>
                    )}
                    {entry.status === 'archived' && (
                      <span className="fb-mem-status-chip">已归档</span>
                    )}
                    {sortBy === 'recall' && entry.recallCount > 0 && (
                      <span>召回 {entry.recallCount} 次</span>
                    )}
                    <span>{formatTime(entry.lastVerifiedAtMs)}</span>
                  </span>
                </div>
              </button>
            )
          })
        )}
      </div>
    </section>
  )
}

function MemoryReaderColumn({
  entry,
  bot,
  groups,
  replacementEntry,
  predecessors,
  markdownPath,
  mutating,
  actions,
  onCreate,
  hasAnyEntries,
  compact = false,
  extraTool,
  onCloseDrawer,
  linkedItems,
}: {
  entry: MemoryEntry | null
  bot?: BotRecord
  groups: readonly GroupView[]
  replacementEntry?: MemoryEntry
  predecessors: readonly MemoryEntry[]
  markdownPath: string
  mutating: boolean
  actions: MemoryReaderActions
  onCreate: () => void
  hasAnyEntries: boolean
  compact?: boolean
  extraTool?: ReactNode
  onCloseDrawer?: () => void
  linkedItems?: readonly MemoryLinkedItem[]
}) {
  if (!entry) {
    return (
      <section className="fb-mem-col-reader" aria-label="记忆详情">
        <div className="fb-mem-reader-empty">
          {hasAnyEntries ? (
            <div>选择左侧任意一条记忆即可精读详情与演进记录</div>
          ) : (
            <div className="fb-empty-stack">
              <div>对话中的纠偏、偏好与项目决策沉淀后会在此处按分类与层级呈现</div>
              <Button
                size="sm"
                variant="outline"
                icon={<IconPlusOutlineRegular size={14} />}
                onClick={onCreate}
              >
                新增记忆
              </Button>
            </div>
          )}
        </div>
      </section>
    )
  }

  const typeMeta = MEMORY_TYPE_META[entry.type]
  const scopeInfo = resolveMemoryScopeLabel(entry, groups)
  const isActive = entry.status === 'active'
  const menuItems = buildOverflowItems(entry, actions, compact)
  const hasFootLinks =
    predecessors.length > 0 ||
    Boolean(entry.supersededBy) ||
    Boolean(entry.sourceSessionId && actions.onOpenSession) ||
    Boolean(markdownPath)

  return (
    <section className="fb-mem-col-reader" aria-label="记忆精读面板">
      <div className="fb-mem-reader-bar">
        <span className="fb-mem-reader-crumb" title={`${bot?.name ?? entry.botId} · ${scopeInfo.fullTitle}`}>
          <span>{bot?.name ?? entry.botId}</span>
          <span aria-hidden="true">·</span>
          <span>{scopeInfo.label}</span>
        </span>
        <div className="fb-mem-reader-tools">
          {isActive ? (
            <>
              <button
                type="button"
                className="fb-mem-tool-btn"
                data-pinned={entry.pinned ? '' : undefined}
                aria-pressed={entry.pinned}
                title={entry.pinned ? '取消核心置顶' : '置顶到核心记忆（新会话首轮优先注入）'}
                disabled={mutating}
                onClick={() => actions.onTogglePin(entry)}
              >
                {entry.pinned ? (
                  <IconPinFillRegular size={13} />
                ) : (
                  <IconPinOutlineRegular size={13} />
                )}
                <span>{entry.pinned ? '已置顶' : '置顶'}</span>
              </button>
              {!compact && (
                <>
                  <button
                    type="button"
                    className="fb-mem-tool-btn"
                    disabled={mutating}
                    onClick={() => actions.onEdit(entry)}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="fb-mem-tool-btn"
                    disabled={mutating}
                    onClick={() => actions.onSupersede(entry)}
                  >
                    纠偏替代
                  </button>
                </>
              )}
            </>
          ) : !compact ? (
            <>
              <button
                type="button"
                className="fb-mem-tool-btn"
                disabled={mutating}
                onClick={() => actions.onRestore(entry)}
              >
                恢复有效
              </button>
              <button
                type="button"
                className="fb-mem-tool-btn"
                disabled={mutating}
                onClick={() => actions.onEdit(entry)}
              >
                编辑
              </button>
            </>
          ) : null}
          {extraTool}
          <OverflowMenu label={`${entry.title} 更多操作`} items={menuItems} />
          {onCloseDrawer && (
            <button
              type="button"
              className="fb-mem-tool-btn"
              aria-label="关闭记忆详情"
              onClick={onCloseDrawer}
            >
              <IconCloseOutlineRegular size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="fb-mem-reader-scroll">
        <article className="fb-mem-paper" data-compact={compact ? '' : undefined}>
          <div className="fb-mem-paper-eyebrow">
            <div className="fb-mem-paper-kicker">
              <span className="fb-mem-note-cat" data-type={entry.type}>
                <span className="fb-mem-type-dot" data-type={entry.type} aria-hidden="true" />
                <span>{typeMeta.label}</span>
              </span>
              {entry.status === 'superseded' && <Tag tone="neutral">已纠偏</Tag>}
              {entry.status === 'archived' && <Tag tone="quiet">已归档</Tag>}
              {entry.confidence === 'medium' && <Tag tone="quiet">中置信度</Tag>}
            </div>
            <div className="fb-mem-paper-meta fb-num">
              <span
                title={`创建于 ${formatFullTimestamp(entry.createdAtMs)} · 核验于 ${formatFullTimestamp(entry.lastVerifiedAtMs)}`}
              >
                核验于 {formatTime(entry.lastVerifiedAtMs)}
              </span>
              {entry.recallCount > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span
                    title={
                      entry.lastRecalledAtMs
                        ? `累计召回 ${entry.recallCount} 次 · 最近召回 ${formatFullTimestamp(entry.lastRecalledAtMs)}`
                        : `累计召回 ${entry.recallCount} 次`
                    }
                  >
                    召回 {entry.recallCount} 次
                  </span>
                </>
              )}
            </div>
          </div>

          <h2 className="fb-mem-paper-title">{entry.title}</h2>

          {!isActive && (entry.supersedeReason || entry.supersededBy) && (
            <div className="fb-mem-lineage-banner">
              <span>
                <strong>{entry.status === 'superseded' ? '纠偏说明：' : '归档原因：'}</strong>
                {entry.supersedeReason || '已被新结论替代'}
              </span>
              {entry.supersededBy && (
                <button
                  type="button"
                  className="fb-mem-foot-action"
                  title={
                    replacementEntry
                      ? `替代后的新记忆：${replacementEntry.title}`
                      : `查看 ${entry.supersededBy}`
                  }
                  onClick={() => actions.onJumpToEntry(entry.supersededBy!)}
                >
                  <span>查看替代后的新记忆</span>
                  <IconChevronRightOutlineRegular size={12} />
                </button>
              )}
            </div>
          )}

          <MemoryContentBlocks content={entry.content} />

          {entry.tags.length > 0 && (
            <div className="fb-mem-paper-tags">
              {entry.tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="fb-mem-paper-tag"
                  title={`按标签「#${tag}」筛选`}
                  onClick={() => actions.onSelectTag(tag)}
                >
                  #{tag}
                </button>
              ))}
            </div>
          )}

          {linkedItems && linkedItems.length > 0 && (
            <div className="fb-mem-graph-links">
              <div className="fb-mem-graph-links-head">关联记忆（{linkedItems.length}）</div>
              <div className="fb-mem-graph-links-list">
                {linkedItems.map((item) => (
                  <button
                    key={item.entry.id}
                    type="button"
                    className="fb-mem-graph-link-row"
                    title={item.entry.title}
                    onClick={() => actions.onJumpToEntry(item.entry.id)}
                  >
                    <span className="fb-mem-type-dot" data-type={item.entry.type} aria-hidden="true" />
                    <span className="fb-mem-graph-link-title">{item.entry.title}</span>
                    <span className="fb-mem-graph-link-meta">{item.relationLabel}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {hasFootLinks && (
            <div className="fb-mem-paper-foot">
              {predecessors.map((old, idx) => (
                <button
                  key={old.id}
                  type="button"
                  className="fb-mem-foot-action"
                  title={`被替代的旧记忆：${old.title}${old.supersededAtMs ? `（${formatDateOnly(old.supersededAtMs)}）` : ''}`}
                  onClick={() => actions.onJumpToEntry(old.id)}
                >
                  <span>
                    {predecessors.length === 1
                      ? '查看被替代的旧记忆'
                      : `查看被替代的旧记忆 #${idx + 1}`}
                  </span>
                  <IconChevronRightOutlineRegular size={12} />
                </button>
              ))}

              {entry.supersededBy && isActive && (
                <button
                  type="button"
                  className="fb-mem-foot-action"
                  title={`替代后的新记忆：${replacementEntry?.title ?? entry.supersededBy}`}
                  onClick={() => actions.onJumpToEntry(entry.supersededBy!)}
                >
                  <span>查看替代后的新记忆</span>
                  <IconChevronRightOutlineRegular size={12} />
                </button>
              )}

              {entry.sourceSessionId && actions.onOpenSession && (
                <button
                  type="button"
                  className="fb-mem-foot-action"
                  title={`打开来源会话：${entry.sourceSessionId}`}
                  onClick={() => actions.onOpenSession!(entry.sourceSessionId!)}
                >
                  <span>查看来源会话</span>
                  <IconChevronRightOutlineRegular size={12} />
                </button>
              )}

              {markdownPath && (
                <button
                  type="button"
                  className="fb-mem-foot-action"
                  title={`复制本地只读镜像路径：${markdownPath}`}
                  onClick={() => actions.onCopy(markdownPath, '已复制只读镜像路径')}
                >
                  <span>复制本地镜像路径</span>
                </button>
              )}
            </div>
          )}
        </article>
      </div>
    </section>
  )
}

const MEMORY_SWR_CACHE = new Map<string, { entries: MemoryEntry[]; markdownPath: string }>()

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
  const effectiveBotId = resolveEffectiveBotId(selectedBotId, bots)
  const singleScopedBotId = bots.length === 1 ? bots[0]!.id : effectiveBotId
  const memoryCacheKey = singleScopedBotId || '__all__'
  const initialCached = MEMORY_SWR_CACHE.get(memoryCacheKey)

  const [viewMode, setViewMode] = useState<MemoryViewMode>(() => resolveMemoryViewMode())
  const [nav, setNav] = useState<MemoryNavNode>({ kind: 'all' })
  const [sortBy, setSortBy] = useState<MemorySortBy>('priority')
  const [historyFilter, setHistoryFilter] = useState<MemoryHistoryFilter>('all')
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<MemoryEntry[]>(() => initialCached?.entries ?? [])
  const [markdownPath, setMarkdownPath] = useState(() => initialCached?.markdownPath ?? '')
  const [loading, setLoading] = useState(() => !initialCached)
  const [loadError, setLoadError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [graphSelectedId, setGraphSelectedId] = useState<string | null>(null)
  const [mutatingId, setMutatingId] = useState<string | null>(null)
  const reqSeqRef = useRef(0)

  const botsById = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots])
  const entriesById = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries])

  const loadMemories = useCallback(
    async (silent = false) => {
      const seq = ++reqSeqRef.current
      const cached = MEMORY_SWR_CACHE.get(memoryCacheKey)
      if (cached) {
        setEntries(cached.entries)
        setMarkdownPath(cached.markdownPath)
        setLoading(false)
      } else if (!silent) {
        setLoading(true)
      }
      try {
        const res = await bridgeApi.memories({
          ...(singleScopedBotId ? { botId: singleScopedBotId } : {}),
          status: 'all',
          limit: 500,
        })
        if (seq !== reqSeqRef.current) return
        const nextEntries = res.entries ?? []
        const nextPath = res.markdownPath ?? ''
        MEMORY_SWR_CACHE.set(memoryCacheKey, { entries: nextEntries, markdownPath: nextPath })
        setEntries(nextEntries)
        setMarkdownPath(nextPath)
        setLoadError('')
      } catch (err) {
        if (seq !== reqSeqRef.current) return
        setLoadError(err instanceof Error ? err.message : String(err))
      } finally {
        if (seq === reqSeqRef.current) setLoading(false)
      }
    },
    [singleScopedBotId, memoryCacheKey],
  )

  useEffect(() => {
    void loadMemories(MEMORY_SWR_CACHE.has(memoryCacheKey))
  }, [loadMemories, revision, memoryCacheKey])

  useEffect(() => {
    const timer = window.setInterval(() => void loadMemories(true), 12_000)
    return () => window.clearInterval(timer)
  }, [loadMemories])

  const scopedEntries = useMemo(
    () => (effectiveBotId ? entries.filter((e) => e.botId === effectiveBotId) : entries),
    [entries, effectiveBotId],
  )
  const activeScoped = useMemo(
    () => scopedEntries.filter((e) => e.status === 'active'),
    [scopedEntries],
  )
  const historyScoped = useMemo(
    () => scopedEntries.filter((e) => e.status !== 'active'),
    [scopedEntries],
  )
  const pinnedCount = useMemo(
    () => activeScoped.reduce((acc, e) => acc + (e.pinned ? 1 : 0), 0),
    [activeScoped],
  )
  const typeCounts = useMemo(() => countMemoriesByType(activeScoped), [activeScoped])
  const historyStatusCounts = useMemo(
    () => countMemoriesByHistoryStatus(historyScoped),
    [historyScoped],
  )
  const hierarchy = useMemo(() => buildMemoryHierarchy(activeScoped, groups), [activeScoped, groups])
  const topTags = useMemo(() => collectTopMemoryTags(activeScoped), [activeScoped])

  const visibleEntries = useMemo(
    () =>
      filterAndSortMemories({
        entries,
        botId: effectiveBotId,
        nav,
        historyFilter,
        query,
        sortBy,
        bots,
        groups,
      }),
    [entries, effectiveBotId, nav, historyFilter, query, sortBy, bots, groups],
  )

  // Keep right-pane selection valid whenever the visible list changes
  useEffect(() => {
    if (visibleEntries.length === 0) {
      setSelectedId(null)
      return
    }
    if (!selectedId || !visibleEntries.some((e) => e.id === selectedId)) {
      setSelectedId(visibleEntries[0]!.id)
    }
  }, [visibleEntries, selectedId])

  const revealEntry = useCallback(
    (entryId: string) => {
      const target = entriesById.get(entryId)
      if (!target) {
        onToast(`未找到记忆 ${entryId}（可能已被删除）`, false)
        return
      }
      setNav(target.status === 'active' ? { kind: 'all' } : { kind: 'history' })
      setHistoryFilter('all')
      setQuery('')
      setSelectedId(entryId)
      setGraphSelectedId(entryId)
      window.requestAnimationFrame(() => {
        document
          .getElementById(`fb-mem-card-${entryId}`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      })
    },
    [entriesById, onToast],
  )

  useEffect(() => {
    if (!focusEntryId || !entriesById.has(focusEntryId)) return
    revealEntry(focusEntryId)
    onFocusHandled?.()
  }, [focusEntryId, entriesById, revealEntry, onFocusHandled])

  const handleBotChange = (nextBotId: string) => {
    onSelectedBotIdChange(nextBotId)
    setQuery('')
    setGraphSelectedId(null)
    setNav((prev) => (prev.kind === 'history' ? prev : { kind: 'all' }))
  }

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

  const readerActions: MemoryReaderActions = {
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
        '已移入历史演进',
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
        description:
          '永久删除后无法恢复，且会同步更新 MEMORY.md 只读镜像。如仅需停用建议使用「归档」。',
        confirmLabel: '永久删除',
        run: () => runMutation(entry.id, () => bridgeApi.deleteMemory(entry.id), '已永久删除该记忆'),
      }),
    onCopy: (text, notice) => {
      void navigator.clipboard
        ?.writeText(text)
        .then(() => onToast(notice, true))
        .catch(() => onToast('复制失败，请手动选中复制', false))
    },
    onSelectTag: (tag) => {
      if (viewMode === 'graph') {
        setQuery(`#${tag}`)
        setGraphSelectedId(null)
        return
      }
      setQuery('')
      setNav((prev) =>
        isSameMemoryNav(prev, { kind: 'tag', tag }) ? { kind: 'all' } : { kind: 'tag', tag },
      )
    },
    onJumpToEntry: revealEntry,
    ...(onOpenSession ? { onOpenSession } : {}),
  }

  const openCreate = () =>
    onOpenDialog({
      mode: 'create',
      ...(singleScopedBotId ? { defaultBotId: singleScopedBotId } : {}),
    })

  if (loadError) {
    return <div className="fb-card fb-empty">加载记忆库失败：{loadError}</div>
  }
  if (bots.length === 0) {
    return (
      <div className="fb-card fb-empty">
        还没有智能体，请先在「智能体」页接入飞书应用后再管理记忆库
      </div>
    )
  }

  const selectedEntry = selectedId ? (visibleEntries.find((e) => e.id === selectedId) ?? null) : null
  const predecessors = selectedEntry ? findSupersededPredecessors(selectedEntry.id, entries) : []
  const replacementEntry = selectedEntry?.supersededBy
    ? entriesById.get(selectedEntry.supersededBy)
    : undefined

  const handleSwitchViewMode = (next: MemoryViewMode) => {
    setViewMode(next)
    if (next === 'columns' && graphSelectedId) {
      const target = entriesById.get(graphSelectedId)
      if (target) {
        setNav(target.status === 'active' ? { kind: 'all' } : { kind: 'history' })
        setSelectedId(target.id)
      }
    } else if (next === 'graph' && selectedId) {
      setGraphSelectedId(selectedId)
    }
  }

  return (
    <div className="fb-mem-shell">
      <div className="fb-view-bar">
        <CountSegmentedSwitch<MemoryViewMode>
          label="记忆库视图模式"
          value={viewMode}
          options={[
            { value: 'graph', label: '关系图谱', count: scopedEntries.length },
            { value: 'columns', label: '列表阅读' },
          ]}
          onChange={handleSwitchViewMode}
        />

        {viewMode === 'graph' && (
          <div className="fb-view-bar-right">
            {bots.length > 1 && (
              <SelectMenu
                size="sm"
                align="end"
                value={effectiveBotId}
                options={[
                  { value: '', label: '全部智能体' },
                  ...bots.map((b) => ({ value: b.id, label: b.name })),
                ]}
                onChange={handleBotChange}
              />
            )}
            <div className="fb-mem-col-search fb-mem-graph-search">
              <IconSearchOutlineRegular size={14} className="fb-mem-search-icon" />
              <input
                type="text"
                aria-label="筛选图谱节点或标签"
                placeholder="筛选节点或 #标签…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button
                  type="button"
                  className="fb-mem-search-clear"
                  aria-label="清空搜索"
                  onClick={() => setQuery('')}
                >
                  <IconCloseOutlineRegular size={12} />
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="fb-mem-frame">
        {viewMode === 'graph' ? (
          <MemoryGraphView
            entries={scopedEntries}
            botsById={botsById}
            groups={groups}
            query={query}
            selectedEntryId={graphSelectedId}
            loading={loading}
            onSelectEntryId={(id) => {
              setGraphSelectedId(id)
              if (id) setSelectedId(id)
            }}
            onCreate={openCreate}
            renderDrawerReader={(entry, linkedItems) => {
              const entryPreds = findSupersededPredecessors(entry.id, entries)
              const entryReplacement = entry.supersededBy ? entriesById.get(entry.supersededBy) : undefined
              return (
                <MemoryReaderColumn
                  entry={entry}
                  bot={botsById.get(entry.botId)}
                  groups={groups}
                  replacementEntry={entryReplacement}
                  predecessors={entryPreds}
                  markdownPath={markdownPath}
                  mutating={mutatingId === entry.id}
                  actions={readerActions}
                  onCreate={openCreate}
                  hasAnyEntries={scopedEntries.length > 0}
                  compact
                  linkedItems={linkedItems}
                  extraTool={
                    <button
                      type="button"
                      className="fb-mem-tool-btn"
                      title="在列表阅读模式中精读此记忆"
                      onClick={() => handleSwitchViewMode('columns')}
                    >
                      列表打开
                    </button>
                  }
                  onCloseDrawer={() => setGraphSelectedId(null)}
                />
              )
            }}
          />
        ) : (
          <div className="fb-mem-workspace">
            <MemoryNavColumn
              bots={bots}
              effectiveBotId={effectiveBotId}
              onBotIdChange={handleBotChange}
              nav={nav}
              onSelectNav={(next) => {
                setNav(next)
                if (next.kind === 'history') setHistoryFilter('all')
              }}
              activeCount={activeScoped.length}
              pinnedCount={pinnedCount}
              historyCount={historyScoped.length}
              typeCounts={typeCounts}
              hierarchy={hierarchy}
              topTags={topTags}
            />

            <MemoryListColumn
              heading={resolveNavHeading(nav, groups)}
              nav={nav}
              entries={visibleEntries}
              selectedId={selectedEntry?.id ?? null}
              onSelectId={setSelectedId}
              query={query}
              onQueryChange={setQuery}
              sortBy={sortBy}
              onSortByChange={setSortBy}
              historyFilter={historyFilter}
              onHistoryFilterChange={setHistoryFilter}
              historyCounts={{
                total: historyScoped.length,
                superseded: historyStatusCounts.superseded,
                archived: historyStatusCounts.archived,
              }}
              botsById={botsById}
              showBotName={bots.length > 1 && !effectiveBotId}
              groups={groups}
              loading={loading}
              hasActiveTotal={activeScoped.length > 0}
              onClearToAll={() => {
                setQuery('')
                setHistoryFilter('all')
                setNav({ kind: 'all' })
              }}
              onCreate={openCreate}
            />

            <MemoryReaderColumn
              entry={selectedEntry}
              bot={selectedEntry ? botsById.get(selectedEntry.botId) : undefined}
              groups={groups}
              replacementEntry={replacementEntry}
              predecessors={predecessors}
              markdownPath={markdownPath}
              mutating={Boolean(selectedEntry && mutatingId === selectedEntry.id)}
              actions={readerActions}
              onCreate={openCreate}
              hasAnyEntries={scopedEntries.length > 0}
              extraTool={
                selectedEntry ? (
                  <button
                    type="button"
                    className="fb-mem-tool-btn"
                    title="切换到关系图谱并定位此记忆"
                    onClick={() => {
                      setGraphSelectedId(selectedEntry.id)
                      setViewMode('graph')
                    }}
                  >
                    图谱定位
                  </button>
                ) : undefined
              }
            />
          </div>
        )}
      </div>
    </div>
  )
}
