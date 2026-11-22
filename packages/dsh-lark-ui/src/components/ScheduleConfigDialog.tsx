import { useEffect, useMemo, useState } from 'react'
import { Button, IconCloseOutlineRegular, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { SCHEDULE_DELIVERY_MODES, SCHEDULE_NOTIFY_ON, type Choice } from '../presets.js'
import type { BotRecord, GroupView, ScheduleBinding, ScheduleTarget, ScheduleView } from '../types.js'
import { ChipToggles, NestedSettings, ScheduleAutomationHint, SelectMenu, SettingRow } from './fields.js'

function encodeTarget(t: ScheduleTarget): string {
  return `${t.botId}\t${t.chatId}`
}

function decodeTarget(token: string): ScheduleTarget | null {
  const idx = token.indexOf('\t')
  if (idx <= 0) return null
  const botId = token.slice(0, idx)
  const chatId = token.slice(idx + 1)
  return botId && chatId ? { botId, chatId } : null
}

export function ScheduleConfigDialog({
  target,
  groups,
  bots,
  onOpenScheduleManager,
  onClose,
  onSave,
}: {
  target: ScheduleView | null
  groups: readonly GroupView[]
  bots: readonly BotRecord[]
  onOpenScheduleManager?: () => void
  onClose: () => void
  onSave: (scheduleId: string, binding: Omit<ScheduleBinding, 'scheduleId'>) => Promise<void>
}) {
  const [draft, setDraft] = useState<Omit<ScheduleBinding, 'scheduleId'>>({
    enabled: true,
    targets: [],
    deliveryMode: 'chat',
    notifyOn: 'non_empty',
    sendIntermediateMessages: false,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!target) return
    setDraft({
      enabled: target.configured ? target.binding.enabled : true,
      targets: target.binding.targets,
      deliveryMode: target.binding.deliveryMode,
      notifyOn: target.binding.notifyOn,
      sendIntermediateMessages: Boolean(target.binding.sendIntermediateMessages),
    })
    setError('')
  }, [target])

  const groupChoices = useMemo<Choice<string>[]>(() => {
    const multiBot = bots.length > 1
    const known = new Map<string, Choice<string>>()
    for (const g of groups) {
      const val = encodeTarget({ botId: g.botId, chatId: g.chatId })
      known.set(val, { value: val, label: multiBot ? `${g.chatName}（${g.botName}）` : g.chatName })
    }
    if (target?.inferredOrigin) {
      const val = encodeTarget({ botId: target.inferredOrigin.botId, chatId: target.inferredOrigin.chatId })
      if (!known.has(val)) {
        known.set(val, {
          value: val,
          label: multiBot ? `${target.inferredOrigin.chatName}（${target.inferredOrigin.botName}）` : target.inferredOrigin.chatName,
        })
      }
    }
    for (const t of draft.targets) {
      const val = encodeTarget(t)
      if (!known.has(val)) {
        known.set(val, { value: val, label: t.chatId })
      }
    }
    return [...known.values()]
  }, [groups, bots, target, draft.targets])

  if (!target) return null

  const selectedTokens = draft.targets.map(encodeTarget)
  const originHint = target.inferredOrigin

  const submit = async () => {
    if (draft.enabled && draft.targets.length === 0 && !originHint) {
      setError('请至少选择一个通知群聊，或关闭飞书通知')
      return
    }
    setSaving(true)
    setError('')
    try {
      await onSave(target.id, draft)
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
            {target.title}
          </div>
          <div className="fb-schedule-dialog-sub">{target.ruleSummary}</div>
        </div>
        <button type="button" className="fb-icon-btn" aria-label="关闭" onClick={onClose}>
          <IconCloseOutlineRegular size={14} />
        </button>
      </div>

      <div className="fb-schedule-dialog-body">
        <ScheduleAutomationHint
          inDialog
          onOpenScheduleManager={
            onOpenScheduleManager
              ? () => {
                  onClose()
                  onOpenScheduleManager()
                }
              : undefined
          }
        />

        <SettingRow title="启用飞书通知">
          <Switch label="启用飞书通知" checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} />
        </SettingRow>

        {draft.enabled && (
          <NestedSettings>
            <SettingRow
              title="通知群聊"
              desc={originHint ? `未勾选时默认回传至「${originHint.chatName}」` : undefined}
              stack
            >
              {groupChoices.length === 0 ? (
                <div className="fb-row-desc">暂无可选群聊，请先在「群聊」页点击「同步群聊」</div>
              ) : (
                <ChipToggles
                  values={selectedTokens}
                  options={groupChoices}
                  onChange={(next) =>
                    setDraft({
                      ...draft,
                      targets: next.map(decodeTarget).filter((v): v is ScheduleTarget => Boolean(v)),
                    })
                  }
                />
              )}
            </SettingRow>

            <SettingRow title="推送方式">
              <SelectMenu
                value={draft.deliveryMode}
                options={SCHEDULE_DELIVERY_MODES}
                onChange={(deliveryMode) => setDraft({ ...draft, deliveryMode })}
              />
            </SettingRow>

            <SettingRow title="推送时机">
              <SelectMenu
                value={draft.notifyOn}
                options={SCHEDULE_NOTIFY_ON}
                onChange={(notifyOn) => setDraft({ ...draft, notifyOn })}
              />
            </SettingRow>

            <SettingRow title="发送中间过程消息" desc="执行过程中的阶段说明实时推送">
              <Switch
                label="发送中间过程消息"
                checked={Boolean(draft.sendIntermediateMessages)}
                onChange={(sendIntermediateMessages) => setDraft({ ...draft, sendIntermediateMessages })}
              />
            </SettingRow>
          </NestedSettings>
        )}
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
