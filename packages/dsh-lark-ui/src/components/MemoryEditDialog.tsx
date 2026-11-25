import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, IconCloseOutlineRegular, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgeApi } from '../api.js'
import { formatTime } from '../state.js'
import type {
  BotRecord,
  GroupView,
  MemoryConfidence,
  MemoryEntry,
  MemoryScope,
  MemoryType,
} from '../types.js'
import { DirectoryField } from './DirectoryPickerModal.js'
import {
  NestedSettings,
  SelectMenu,
  SettingRow,
  TagInput,
  TextArea,
  TextField,
  type SelectOption,
} from './fields.js'

const CUSTOM_CHAT_VALUE = '__custom_chat__'
const MAX_TITLE_CHARS = 100
const MAX_CONTENT_CHARS = 1200

const TYPE_OPTIONS: readonly SelectOption<MemoryType>[] = [
  { value: 'feedback', label: '纠偏与规范', desc: '明确纠正、防踩坑约束与已确认的协作规则' },
  { value: 'user', label: '用户偏好', desc: '成员角色、表达偏好与工作习惯' },
  { value: 'project', label: '项目决策', desc: '架构取舍、隐性业务背景与阶段里程碑' },
  { value: 'reference', label: '外部参考', desc: '外部看板、文档、系统与工具入口指针' },
]

const SCOPE_OPTIONS: readonly SelectOption<MemoryScope>[] = [
  { value: 'bot', label: '智能体全局', desc: '该智能体所有群聊与私聊可见' },
  { value: 'chat', label: '指定群聊', desc: '仅在指定群聊或私聊生效' },
  { value: 'workspace', label: '指定工作区', desc: '仅在指定工作目录生效' },
]

const CONFIDENCE_OPTIONS: readonly SelectOption<MemoryConfidence>[] = [
  { value: 'high', label: '高置信度' },
  { value: 'medium', label: '中等置信度' },
]

export type MemoryDialogRequest =
  | { readonly mode: 'create'; readonly defaultBotId?: string }
  | { readonly mode: 'edit'; readonly entry: MemoryEntry }
  | { readonly mode: 'supersede'; readonly entry: MemoryEntry }

interface MemoryDraft {
  readonly botId: string
  readonly type: MemoryType
  readonly scope: MemoryScope
  readonly scopeId: string
  readonly title: string
  readonly content: string
  readonly tags: readonly string[]
  readonly confidence: MemoryConfidence
  readonly pinned: boolean
  readonly supersedeReason: string
  readonly createReplacement: boolean
}

function buildInitialDraft(
  request: MemoryDialogRequest,
  bots: readonly BotRecord[],
): MemoryDraft {
  if (request.mode === 'create') {
    const fallbackBotId =
      (request.defaultBotId && bots.some((b) => b.id === request.defaultBotId)
        ? request.defaultBotId
        : bots[0]?.id) ?? ''
    return {
      botId: fallbackBotId,
      type: 'feedback',
      scope: 'bot',
      scopeId: '',
      title: '',
      content: '',
      tags: [],
      confidence: 'high',
      pinned: false,
      supersedeReason: '',
      createReplacement: true,
    }
  }
  const { entry } = request
  return {
    botId: entry.botId,
    type: entry.type,
    scope: entry.scope,
    scopeId: entry.scopeId,
    title: entry.title,
    content: entry.content,
    tags: [...entry.tags],
    confidence: entry.confidence,
    pinned: entry.pinned,
    supersedeReason: '',
    createReplacement: true,
  }
}

function validateMemoryDraft(
  mode: MemoryDialogRequest['mode'],
  draft: MemoryDraft,
): string | null {
  if (mode === 'create' && !draft.botId.trim()) return '请选择所属智能体'
  if (mode === 'supersede' && !draft.supersedeReason.trim()) return '请填写纠偏原因'
  const needsBody = mode !== 'supersede' || draft.createReplacement
  if (!needsBody) return null
  if (!draft.title.trim()) return '请填写记忆标题'
  if (draft.title.trim().length > MAX_TITLE_CHARS) return `标题长度不能超过 ${MAX_TITLE_CHARS} 字`
  if (!draft.content.trim()) return '请填写记忆内容'
  if (draft.content.trim().length > MAX_CONTENT_CHARS) {
    return `记忆内容不能超过 ${MAX_CONTENT_CHARS} 字`
  }
  if (draft.scope !== 'bot' && !draft.scopeId.trim()) {
    return draft.scope === 'chat' ? '请选择目标群聊或填写 Chat ID' : '请选择或填写目标工作目录'
  }
  return null
}

async function submitMemoryDialogRequest(
  request: MemoryDialogRequest,
  draft: MemoryDraft,
): Promise<{ readonly message: string; readonly focusId?: string; readonly botId: string }> {
  const cleanScopeId = draft.scope === 'bot' ? '' : draft.scopeId.trim()
  if (request.mode === 'create') {
    const saved = await bridgeApi.upsertMemory({
      botId: draft.botId,
      type: draft.type,
      scope: draft.scope,
      ...(cleanScopeId ? { scopeId: cleanScopeId } : {}),
      title: draft.title.trim(),
      content: draft.content.trim(),
      tags: [...draft.tags],
      confidence: draft.confidence,
      pinned: draft.pinned,
    })
    return { message: '已保存新记忆', focusId: saved.id, botId: saved.botId }
  }
  if (request.mode === 'edit') {
    const saved = await bridgeApi.updateMemory(request.entry.id, {
      type: draft.type,
      scope: draft.scope,
      scopeId: cleanScopeId,
      title: draft.title.trim(),
      content: draft.content.trim(),
      tags: [...draft.tags],
      confidence: draft.confidence,
      pinned: draft.pinned,
    })
    return { message: '已更新记忆', focusId: saved.id, botId: saved.botId }
  }
  const res = await bridgeApi.supersedeMemory(request.entry.id, {
    reason: draft.supersedeReason.trim(),
    ...(draft.createReplacement
      ? {
          type: draft.type,
          scope: draft.scope,
          scopeId: cleanScopeId,
          title: draft.title.trim(),
          content: draft.content.trim(),
          tags: [...draft.tags],
          confidence: draft.confidence,
          pinned: draft.pinned,
        }
      : {}),
  })
  return {
    message: res.replacementEntry ? '已纠偏原记忆并写入新结论' : '已将原记忆标记为已纠偏',
    ...(res.replacementEntry ? { focusId: res.replacementEntry.id } : {}),
    botId: request.entry.botId,
  }
}

function MemoryScopeFields({
  draft,
  botGroups,
  defaultWorkingDir,
  onPatch,
}: {
  draft: MemoryDraft
  botGroups: readonly GroupView[]
  defaultWorkingDir: string
  onPatch: (p: Partial<MemoryDraft>) => void
}) {
  const [manualChat, setManualChat] = useState(false)

  useEffect(() => {
    if (draft.scope !== 'chat') {
      setManualChat(false)
      return
    }
    const matched = Boolean(draft.scopeId && botGroups.some((g) => g.chatId === draft.scopeId))
    if (draft.scopeId && !matched && botGroups.length > 0) {
      setManualChat(true)
    }
  }, [draft.scope, draft.scopeId, botGroups])

  const chatSelectOptions = useMemo<SelectOption<string>[]>(
    () => [
      ...botGroups.map((g) => ({ value: g.chatId, label: g.chatName, desc: g.chatId })),
      { value: CUSTOM_CHAT_VALUE, label: '手动输入 Chat ID' },
    ],
    [botGroups],
  )

  const selectedChatOption =
    manualChat || (draft.scopeId && !botGroups.some((g) => g.chatId === draft.scopeId))
      ? CUSTOM_CHAT_VALUE
      : draft.scopeId

  return (
    <>
      <SettingRow title="作用域" desc="隔离群聊与工作区知识，防止跨群串味">
        <SelectMenu
          value={draft.scope}
          options={SCOPE_OPTIONS}
          onChange={(scope) => {
            if (scope === 'bot') {
              onPatch({ scope, scopeId: '' })
            } else if (scope === 'workspace') {
              onPatch({
                scope,
                scopeId: draft.scope === 'workspace' ? draft.scopeId : defaultWorkingDir,
              })
            } else {
              onPatch({
                scope,
                scopeId: draft.scope === 'chat' ? draft.scopeId : (botGroups[0]?.chatId ?? ''),
              })
            }
          }}
        />
      </SettingRow>

      {draft.scope === 'chat' && (
        <NestedSettings>
          {botGroups.length > 0 ? (
            <>
              <SettingRow title="目标群聊">
                <SelectMenu
                  value={selectedChatOption}
                  options={chatSelectOptions}
                  placeholder="选择已同步群聊"
                  onChange={(next) => {
                    if (next === CUSTOM_CHAT_VALUE) {
                      setManualChat(true)
                      if (botGroups.some((g) => g.chatId === draft.scopeId)) {
                        onPatch({ scopeId: '' })
                      }
                    } else {
                      setManualChat(false)
                      onPatch({ scopeId: next })
                    }
                  }}
                />
              </SettingRow>
              {selectedChatOption === CUSTOM_CHAT_VALUE && (
                <SettingRow title="群聊 Chat ID" desc="填写飞书群聊或会话 ID">
                  <TextField
                    value={draft.scopeId}
                    onChange={(scopeId) => onPatch({ scopeId })}
                    placeholder="oc_xxx"
                    mono
                  />
                </SettingRow>
              )}
            </>
          ) : (
            <SettingRow title="群聊 Chat ID" desc="填写飞书群聊或会话 ID">
              <TextField
                value={draft.scopeId}
                onChange={(scopeId) => onPatch({ scopeId })}
                placeholder="oc_xxx"
                mono
              />
            </SettingRow>
          )}
        </NestedSettings>
      )}

      {draft.scope === 'workspace' && (
        <NestedSettings>
          <SettingRow title="目标工作目录" desc="仅在对应仓库目录的会话中召回">
            <DirectoryField
              value={draft.scopeId}
              onChange={(scopeId) => onPatch({ scopeId })}
              placeholder={defaultWorkingDir || '/path/to/workspace'}
            />
          </SettingRow>
        </NestedSettings>
      )}
    </>
  )
}

function MemoryFormFields({
  draft,
  botGroups,
  defaultWorkingDir,
  onPatch,
}: {
  draft: MemoryDraft
  botGroups: readonly GroupView[]
  defaultWorkingDir: string
  onPatch: (p: Partial<MemoryDraft>) => void
}) {
  const titleLen = draft.title.trim().length
  const contentLen = draft.content.trim().length

  return (
    <>
      <SettingRow title="记忆分类" desc="纠偏与用户偏好享有最高首轮召回优先级">
        <SelectMenu
          value={draft.type}
          options={TYPE_OPTIONS}
          onChange={(type) => onPatch({ type })}
        />
      </SettingRow>

      <MemoryScopeFields
        draft={draft}
        botGroups={botGroups}
        defaultWorkingDir={defaultWorkingDir}
        onPatch={onPatch}
      />

      <SettingRow
        title="标题"
        desc={
          titleLen > 60
            ? `用于首轮索引展示（${titleLen} / ${MAX_TITLE_CHARS}）`
            : '用于首轮索引展示（建议 ≤ 40 字）'
        }
      >
        <TextField
          value={draft.title}
          onChange={(title) => onPatch({ title })}
          placeholder="例如 发布前须核对 P95 指标 10 分钟"
        />
      </SettingRow>

      <SettingRow
        title="记忆内容"
        desc="记录精炼事实、决策依据或防踩坑规则，优先使用绝对日期 YYYY-MM-DD"
        stack
        headerAction={
          <span
            className="fb-mem-char-count fb-num"
            data-over={contentLen > MAX_CONTENT_CHARS ? '' : undefined}
          >
            {contentLen} / {MAX_CONTENT_CHARS}
          </span>
        }
      >
        <TextArea
          value={draft.content}
          onChange={(content) => onPatch({ content })}
          rows={6}
          placeholder="仅记录值得跨会话保留的隐性认知，避免重复抄录代码或 README 已有静态信息"
        />
      </SettingRow>

      <SettingRow title="标签" desc="回车添加关键词标签（最多 8 个），便于精准召回与筛选" stack>
        <TagInput
          values={[...draft.tags]}
          onChange={(tags) => onPatch({ tags: tags.slice(0, 8) })}
          placeholder="回车添加标签，例如 release、ops"
        />
      </SettingRow>

      <SettingRow title="置信度">
        <SelectMenu
          value={draft.confidence}
          options={CONFIDENCE_OPTIONS}
          onChange={(confidence) => onPatch({ confidence })}
        />
      </SettingRow>

      <SettingRow title="置顶到核心记忆" desc="置顶条目在每次新会话首轮均优先注入">
        <Switch
          label="置顶到核心记忆"
          checked={draft.pinned}
          onChange={(pinned) => onPatch({ pinned })}
        />
      </SettingRow>
    </>
  )
}

export function MemoryEditDialog({
  request,
  bots,
  groups,
  onClose,
  onSaved,
}: {
  request: MemoryDialogRequest | null
  bots: readonly BotRecord[]
  groups: readonly GroupView[]
  onClose: () => void
  onSaved: (message: string, focusId?: string, botId?: string) => Promise<void>
}) {
  const [draft, setDraft] = useState<MemoryDraft>(() =>
    request ? buildInitialDraft(request, bots) : buildInitialDraft({ mode: 'create' }, bots),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const botsRef = useRef(bots)
  botsRef.current = bots

  useEffect(() => {
    if (!request) return
    setDraft(buildInitialDraft(request, botsRef.current))
    setError('')
  }, [request])

  const targetBot = useMemo(() => bots.find((b) => b.id === draft.botId), [bots, draft.botId])
  const botGroups = useMemo(
    () => groups.filter((g) => g.botId === draft.botId),
    [groups, draft.botId],
  )

  if (!request) return null

  const patch = (p: Partial<MemoryDraft>) => setDraft((prev) => ({ ...prev, ...p }))
  const dialogTitle =
    request.mode === 'create'
      ? '新增长期记忆'
      : request.mode === 'supersede'
        ? '纠偏并替代记忆'
        : '编辑长期记忆'
  const dialogSubtitle =
    request.mode === 'create'
      ? targetBot
        ? `所属智能体：${targetBot.name} · 跨会话持久化并同步只读镜像`
        : '跨会话持久化并同步只读镜像'
      : [
          targetBot?.name ?? request.entry.botId,
          request.entry.id,
          `核验于 ${formatTime(request.entry.lastVerifiedAtMs)}`,
          `召回 ${request.entry.recallCount} 次`,
        ].join(' · ')

  const submit = async () => {
    const validationError = validateMemoryDraft(request.mode, draft)
    if (validationError) {
      setError(validationError)
      return
    }
    setSaving(true)
    setError('')
    try {
      const outcome = await submitMemoryDialogRequest(request, draft)
      await onSaved(outcome.message, outcome.focusId, outcome.botId)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={dialogTitle}
      headless
      className="fb-schedule-dialog fb-memory-dialog"
    >
      <div className="fb-schedule-dialog-head">
        <div style={{ minWidth: 0 }}>
          <div className="fb-schedule-dialog-title">{dialogTitle}</div>
          <div className="fb-schedule-dialog-sub">{dialogSubtitle}</div>
        </div>
        <button type="button" className="fb-icon-btn" aria-label="关闭" onClick={onClose}>
          <IconCloseOutlineRegular size={14} />
        </button>
      </div>

      <div className="fb-schedule-dialog-body">
        {request.mode === 'create' && bots.length > 1 && (
          <SettingRow title="所属智能体">
            <SelectMenu
              value={draft.botId}
              options={bots.map((b) => ({ value: b.id, label: b.name }))}
              onChange={(botId) => patch({ botId, ...(draft.scope === 'chat' ? { scopeId: '' } : {}) })}
            />
          </SettingRow>
        )}

        {request.mode === 'supersede' && (
          <>
            <div className="fb-mem-supersede-ref">
              <div className="fb-mem-supersede-ref-label">原记忆（将标记为已纠偏并保留审计记录）</div>
              <div className="fb-mem-supersede-ref-title">{request.entry.title}</div>
              <div className="fb-mem-supersede-ref-body">{request.entry.content}</div>
            </div>
            <SettingRow title="纠偏原因" desc="记录旧结论失效或被推翻的依据">
              <TextField
                value={draft.supersedeReason}
                onChange={(supersedeReason) => patch({ supersedeReason })}
                placeholder="例如 2026-11-25 架构调整后旧规范不再适用"
              />
            </SettingRow>
            <SettingRow title="写入替代新记忆" desc="原子创建新条目并建立双时态替代关联">
              <Switch
                label="写入替代新记忆"
                checked={draft.createReplacement}
                onChange={(createReplacement) => patch({ createReplacement })}
              />
            </SettingRow>
          </>
        )}

        {(request.mode !== 'supersede' || draft.createReplacement) && (
          <MemoryFormFields
            draft={draft}
            botGroups={botGroups}
            defaultWorkingDir={targetBot?.defaultWorkingDir ?? ''}
            onPatch={patch}
          />
        )}
      </div>

      <div className="fb-schedule-dialog-foot">
        {error ? <span className="fb-dialog-error">{error}</span> : null}
        <Button variant="outline" disabled={saving} onClick={onClose}>
          取消
        </Button>
        <Button variant="primary" disabled={saving} onClick={() => void submit()}>
          {saving
            ? '保存中…'
            : request.mode === 'supersede'
              ? draft.createReplacement
                ? '确认纠偏并保存'
                : '标记已纠偏'
              : '保存'}
        </Button>
      </div>
    </Modal>
  )
}
