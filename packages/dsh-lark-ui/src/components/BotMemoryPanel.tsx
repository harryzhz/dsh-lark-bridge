import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  IconChevronLeftOutlineRegular,
  IconCloseOutlineRegular,
  IconPlusOutlineRegular,
  SegmentedControl,
  Switch,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgeApi } from '../api.js'
import { formatTime } from '../state.js'
import type {
  MemoryConfidence,
  MemoryEntry,
  MemoryScope,
  MemoryStatus,
  MemoryType,
} from '../types.js'
import {
  GroupTitle,
  NestedSettings,
  SelectMenu,
  SettingRow,
  TagInput,
  TextArea,
  TextField,
  type SelectOption,
} from './fields.js'

const TYPE_OPTIONS: readonly SelectOption<MemoryType>[] = [
  { value: 'feedback', label: '纠偏与规范', desc: '明确纠正、防踩坑约束与已确认的协作规则' },
  { value: 'user', label: '用户偏好', desc: '成员角色、表达偏好与工作习惯' },
  { value: 'project', label: '项目决策', desc: '架构取舍、隐性业务背景与阶段里程碑' },
  { value: 'reference', label: '外部参考', desc: '外部看板、文档、系统与工具入口指针' },
]

const SCOPE_OPTIONS: readonly SelectOption<MemoryScope>[] = [
  { value: 'bot', label: '智能体全局', desc: '该智能体所有群聊与私聊可见' },
  { value: 'chat', label: '指定群聊', desc: '仅在指定 chat_id 群聊或私聊生效' },
  { value: 'workspace', label: '指定工作区', desc: '仅在指定工作目录生效' },
]

const CONFIDENCE_OPTIONS: readonly SelectOption<MemoryConfidence>[] = [
  { value: 'high', label: '高置信度' },
  { value: 'medium', label: '中等置信度' },
]

const TYPE_SHORT_LABEL: Readonly<Record<MemoryType, string>> = {
  feedback: '纠偏',
  user: '用户',
  project: '项目',
  reference: '参考',
}

interface MemoryFormDraft {
  readonly id?: string
  readonly type: MemoryType
  readonly scope: MemoryScope
  readonly scopeId: string
  readonly title: string
  readonly content: string
  readonly tags: readonly string[]
  readonly confidence: MemoryConfidence
  readonly pinned: boolean
  readonly status: MemoryStatus
}

function emptyDraft(): MemoryFormDraft {
  return {
    type: 'feedback',
    scope: 'bot',
    scopeId: '',
    title: '',
    content: '',
    tags: [],
    confidence: 'high',
    pinned: false,
    status: 'active',
  }
}

function draftFromEntry(entry: MemoryEntry): MemoryFormDraft {
  return {
    id: entry.id,
    type: entry.type,
    scope: entry.scope,
    scopeId: entry.scopeId,
    title: entry.title,
    content: entry.content,
    tags: [...entry.tags],
    confidence: entry.confidence,
    pinned: entry.pinned,
    status: entry.status,
  }
}

/**
 * In-place subview inside BotConfigDialog (`ConfigDialog.subview`) for inspecting,
 * searching, creating, editing, pinning, archiving, and deleting Memory entries.
 */
export function BotMemoryPanel({
  botId,
  botName,
  onBack,
  onClose,
  onChanged,
}: {
  botId: string
  botName: string
  onBack: () => void
  onClose: () => void
  onChanged?: (activeCount: number) => void
}) {
  const [statusFilter, setStatusFilter] = useState<'active' | 'all'>('active')
  const [searchText, setSearchText] = useState('')
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [markdownPath, setMarkdownPath] = useState('')
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string>('__new__')
  const [draft, setDraft] = useState<MemoryFormDraft>(emptyDraft)
  const [saving, setSaving] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const patch = (p: Partial<MemoryFormDraft>) => setDraft((prev) => ({ ...prev, ...p }))

  const loadMemories = useCallback(
    async (preferredId?: string) => {
      setLoading(true)
      setError('')
      try {
        const res = await bridgeApi.memories({
          botId,
          status: statusFilter,
          ...(searchText.trim() ? { q: searchText.trim() } : {}),
          limit: 150,
        })
        const list = res.entries ?? []
        setEntries(list)
        if (res.markdownPath) setMarkdownPath(res.markdownPath)

        const activeCount =
          statusFilter === 'active' && !searchText.trim()
            ? list.length
            : (await bridgeApi.memories({ botId, status: 'active', limit: 200 })).entries.length
        onChanged?.(activeCount)

        const targetId = preferredId ?? selectedId
        if (targetId && targetId !== '__new__') {
          const hit = list.find((e) => e.id === targetId)
          if (hit) {
            setSelectedId(hit.id)
            setDraft(draftFromEntry(hit))
            return
          }
        }
        if (preferredId === '__new__' || list.length === 0) {
          setSelectedId('__new__')
          setDraft(emptyDraft())
        } else {
          const first = list[0]!
          setSelectedId(first.id)
          setDraft(draftFromEntry(first))
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    },
    [botId, statusFilter, searchText, onChanged, selectedId],
  )

  useEffect(() => {
    void loadMemories()
    // Reload when botId, filter, or search changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId, statusFilter, searchText])

  const selectedEntry = selectedId !== '__new__' ? entries.find((e) => e.id === selectedId) : undefined

  const startNew = () => {
    setError('')
    setNotice('')
    setSelectedId('__new__')
    setDraft(emptyDraft())
  }

  const selectEntry = (entry: MemoryEntry) => {
    setError('')
    setNotice('')
    setSelectedId(entry.id)
    setDraft(draftFromEntry(entry))
  }

  const handleSave = async () => {
    setError('')
    setNotice('')
    const title = draft.title.trim()
    const content = draft.content.trim()
    if (!title) {
      setError('请填写记忆标题')
      return
    }
    if (!content) {
      setError('请填写记忆内容')
      return
    }
    if (draft.scope !== 'bot' && !draft.scopeId.trim()) {
      setError(draft.scope === 'chat' ? '请填写目标群聊 chat_id' : '请填写工作目录路径')
      return
    }

    setSaving(true)
    try {
      const saved =
        selectedId !== '__new__' && draft.id
          ? await bridgeApi.updateMemory(draft.id, {
              type: draft.type,
              scope: draft.scope,
              scopeId: draft.scope === 'bot' ? '' : draft.scopeId.trim(),
              title,
              content,
              tags: [...draft.tags],
              confidence: draft.confidence,
              pinned: draft.pinned,
              status: draft.status,
            })
          : await bridgeApi.upsertMemory({
              botId,
              type: draft.type,
              scope: draft.scope,
              ...(draft.scope !== 'bot' ? { scopeId: draft.scopeId.trim() } : {}),
              title,
              content,
              tags: [...draft.tags],
              confidence: draft.confidence,
              pinned: draft.pinned,
            })
      setNotice(selectedId === '__new__' ? '已保存新记忆' : '已更新记忆')
      await loadMemories(saved.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleArchiveToggle = async () => {
    if (!selectedEntry) return
    setError('')
    setNotice('')
    setMutating(true)
    try {
      if (selectedEntry.status === 'active') {
        await bridgeApi.archiveMemory(selectedEntry.id, '控制台手动归档')
        setNotice('已归档该记忆')
        await loadMemories()
      } else {
        const restored = await bridgeApi.updateMemory(selectedEntry.id, { status: 'active' })
        setNotice('已恢复为有效记忆')
        await loadMemories(restored.id)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setMutating(false)
    }
  }

  const handleDelete = async () => {
    if (!selectedEntry) return
    setError('')
    setNotice('')
    setMutating(true)
    try {
      await bridgeApi.deleteMemory(selectedEntry.id)
      setNotice('已删除该记忆')
      await loadMemories()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setMutating(false)
    }
  }

  const busy = saving || mutating

  return (
    <>
      <div className="fb-dialog-header">
        <div className="fb-dialog-header-main">
          <button
            type="button"
            className="fb-dialog-back"
            aria-label="返回实验性设置"
            onClick={onBack}
          >
            <IconChevronLeftOutlineRegular size={15} />
            <span>实验性</span>
          </button>
          <span className="fb-dialog-header-sep" aria-hidden="true">
            /
          </span>
          <div className="fb-dialog-title">{`${botName} · Memory`}</div>
        </div>
        <button type="button" className="fb-icon-btn" aria-label="关闭" onClick={onClose}>
          <IconCloseOutlineRegular size={14} />
        </button>
      </div>

      <nav className="fb-dialog-nav" aria-label="记忆列表">
        <button
          type="button"
          className="fb-profile-new-btn"
          aria-current={selectedId === '__new__' ? 'page' : undefined}
          onClick={startNew}
        >
          <IconPlusOutlineRegular size={14} />
          <span>新增记忆</span>
        </button>

        <div className="fb-memory-nav-controls">
          <SegmentedControl
            id="fb-memory-status-filter"
            label="记忆状态筛选"
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as 'active' | 'all')}
            options={[
              { value: 'active', label: '有效' },
              { value: 'all', label: '全部' },
            ]}
          />
          <input
            type="text"
            className="fb-field fb-memory-search"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="搜索标题/内容…"
            aria-label="搜索记忆"
          />
        </div>

        {loading && entries.length === 0 ? (
          <div className="fb-memory-nav-empty">加载中…</div>
        ) : entries.length === 0 ? (
          <div className="fb-memory-nav-empty">暂无匹配记忆</div>
        ) : (
          entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="fb-nav-cell fb-profile-nav-item"
              aria-current={selectedId === entry.id ? 'page' : undefined}
              onClick={() => selectEntry(entry)}
            >
              <span className="fb-profile-nav-name" title={entry.title}>
                {entry.pinned ? '★ ' : ''}
                {entry.title}
              </span>
              <Tag
                tone={
                  entry.status !== 'active'
                    ? 'neutral'
                    : entry.type === 'feedback'
                      ? 'warning'
                      : 'info'
                }
              >
                {entry.status === 'superseded'
                  ? '已纠偏'
                  : entry.status === 'archived'
                    ? '归档'
                    : TYPE_SHORT_LABEL[entry.type]}
              </Tag>
            </button>
          ))
        )}
      </nav>

      <div className="fb-dialog-options">
        {selectedEntry && (
          <div className="fb-memory-meta-bar">
            <span className="fb-mono">{selectedEntry.id}</span>
            <span>核验于 {formatTime(selectedEntry.lastVerifiedAtMs)}</span>
            <span>召回 {selectedEntry.recallCount} 次</span>
            {selectedEntry.status !== 'active' && selectedEntry.supersedeReason && (
              <span>原因：{selectedEntry.supersedeReason}</span>
            )}
          </div>
        )}

        <GroupTitle>{selectedEntry ? '编辑记忆' : '新增长期记忆'}</GroupTitle>

        <SettingRow title="记忆分类" desc="按 SOTA 四类语义组织，纠偏与用户偏好享有最高召回优先级">
          <SelectMenu
            value={draft.type}
            options={TYPE_OPTIONS}
            onChange={(type) => patch({ type })}
          />
        </SettingRow>

        <SettingRow title="作用域" desc="隔离群聊与工作区知识，防止跨群串味">
          <SelectMenu
            value={draft.scope}
            options={SCOPE_OPTIONS}
            onChange={(scope) => patch({ scope, ...(scope === 'bot' ? { scopeId: '' } : {}) })}
          />
        </SettingRow>

        {draft.scope !== 'bot' && (
          <NestedSettings>
            <SettingRow
              title={draft.scope === 'chat' ? '目标群聊 ID' : '目标工作目录'}
              desc={draft.scope === 'chat' ? '例如 oc_xxx' : '例如 /path/to/repo'}
            >
              <TextField
                value={draft.scopeId}
                onChange={(scopeId) => patch({ scopeId })}
                placeholder={draft.scope === 'chat' ? 'oc_xxx' : '/path/to/workspace'}
                mono
              />
            </SettingRow>
          </NestedSettings>
        )}

        <SettingRow title="标题" desc="用于首轮渐进披露索引展示（建议 ≤ 40 字）">
          <TextField
            value={draft.title}
            onChange={(title) => patch({ title })}
            placeholder="例如 发布前须核对 P95 指标 10 分钟"
          />
        </SettingRow>

        <SettingRow
          title="记忆内容"
          desc="记录精炼事实、决策依据或防踩坑规则，优先使用绝对日期 YYYY-MM-DD"
          stack
        >
          <TextArea
            value={draft.content}
            onChange={(content) => patch({ content })}
            rows={5}
            placeholder="仅记录值得跨会话保留的隐性认知，避免重复抄录代码或 README 已有静态信息"
          />
        </SettingRow>

        <SettingRow title="标签" desc="回车添加关键词标签，便于精准检索" stack>
          <TagInput
            values={[...draft.tags]}
            onChange={(tags) => patch({ tags })}
            placeholder="回车添加标签，例如 release、ops"
          />
        </SettingRow>

        <SettingRow title="置信度">
          <SelectMenu
            value={draft.confidence}
            options={CONFIDENCE_OPTIONS}
            onChange={(confidence) => patch({ confidence })}
          />
        </SettingRow>

        <SettingRow title="置顶到核心记忆" desc="置顶条目在每次新会话首轮均优先注入">
          <Switch
            label="置顶到核心记忆"
            checked={draft.pinned}
            onChange={(pinned) => patch({ pinned })}
          />
        </SettingRow>

        {markdownPath && (
          <div className="fb-memory-path-hint">
            只读镜像：<span className="fb-mono">{markdownPath}</span>
          </div>
        )}
      </div>

      <div className="fb-dialog-footer">
        {error ? (
          <span className="fb-dialog-error">{error}</span>
        ) : notice ? (
          <span className="fb-dialog-notice">{notice}</span>
        ) : null}
        {selectedEntry && (
          <>
            <Button variant="ghost" disabled={busy} onClick={() => void handleDelete()}>
              删除
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => void handleArchiveToggle()}>
              {selectedEntry.status === 'active' ? '归档' : '恢复有效'}
            </Button>
          </>
        )}
        <Button variant="outline" disabled={busy} onClick={onBack}>
          返回
        </Button>
        <Button variant="primary" disabled={busy} onClick={() => void handleSave()}>
          {saving ? '保存中…' : '保存'}
        </Button>
      </div>
    </>
  )
}
