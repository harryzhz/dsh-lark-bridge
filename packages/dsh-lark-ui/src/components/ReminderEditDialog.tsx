import { useEffect, useState } from 'react'
import { Button, IconCloseOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReminderItem } from '../types.js'
import { SettingRow, TextArea, TextField } from './fields.js'

function toLocalDateTimeInput(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function ReminderEditDialog({
  target,
  onClose,
  onSave,
}: {
  target: ReminderItem | null
  onClose: () => void
  onSave: (
    id: string,
    patch: { title: string; at: string; reason: string; prompt: string },
  ) => Promise<void>
}) {
  const [title, setTitle] = useState('')
  const [at, setAt] = useState('')
  const [reason, setReason] = useState('')
  const [prompt, setPrompt] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!target) return
    setTitle(target.title)
    setAt(toLocalDateTimeInput(target.scheduledAt))
    setReason(target.reason ?? '')
    setPrompt(target.prompt)
    setError('')
  }, [target])

  if (!target) return null

  const originLabel =
    target.origin.chatType === 'p2p'
      ? `私聊 · ${target.origin.userName || target.origin.userOpenId || '用户'}`
      : target.origin.deliveryMode === 'thread'
        ? `群话题 · ${target.origin.chatName || target.origin.chatId || '飞书群'}`
        : `群聊 · ${target.origin.chatName || target.origin.chatId || '飞书群'}`

  const submit = async () => {
    if (!title.trim() || !at.trim() || !prompt.trim()) {
      setError('请填写提醒标题、触发时间与唤醒指令')
      return
    }
    setSaving(true)
    setError('')
    try {
      await onSave(target.id, {
        title: title.trim(),
        at: at.trim(),
        reason: reason.trim(),
        prompt: prompt.trim(),
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={target.title} headless className="fb-schedule-dialog">
      <div className="fb-schedule-dialog-head">
        <div style={{ minWidth: 0 }}>
          <div className="fb-schedule-dialog-title" title={target.title}>
            编辑提醒事项
          </div>
          <div className="fb-schedule-dialog-sub">
            {`投递目标：${originLabel} · 仅触发一次，触发后自动归档`}
          </div>
        </div>
        <button type="button" className="fb-icon-btn" aria-label="关闭" onClick={onClose}>
          <IconCloseOutlineRegular size={14} />
        </button>
      </div>

      <div className="fb-schedule-dialog-body">
        <SettingRow title="提醒标题">
          <TextField value={title} onChange={setTitle} placeholder="例如 核查下午发版是否已执行" />
        </SettingRow>
        <SettingRow title="触发时间" desc="本地时间 YYYY-MM-DD HH:mm">
          <TextField value={at} onChange={setAt} placeholder="2026-11-23 10:00" mono />
        </SettingRow>
        <SettingRow title="背景说明">
          <TextField value={reason} onChange={setReason} placeholder="选填，记录触发缘由" />
        </SettingRow>
        <SettingRow
          title="唤醒指令"
          desc="到期唤醒执行的指令；输出 <no_reminder_needed/> 时静默归档"
          stack
        >
          <TextArea value={prompt} onChange={setPrompt} rows={6} />
        </SettingRow>
      </div>

      <div className="fb-schedule-dialog-foot">
        {error ? <span className="fb-dialog-error">{error}</span> : null}
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button variant="primary" disabled={saving} onClick={() => void submit()}>
          {saving ? '保存中…' : '保存'}
        </Button>
      </div>
    </Modal>
  )
}
