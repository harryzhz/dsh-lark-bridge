import { useState, type CSSProperties, type ReactNode } from 'react'
import {
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconCloseOutlineRegular,
  IconEllipsisOutlineRegular,
  IconPlusOutlineRegular,
  Menu,
  Pill,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Choice } from '../presets.js'
import { RobotTabIcon } from './LarkLogo.js'

export function Avatar({
  src,
  name,
  kind = 'user',
  size = 'md',
}: {
  src?: string | undefined
  name: string
  kind?: 'user' | 'bot' | 'group'
  size?: 'md' | 'sm' | 'chip'
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const cleanSrc = src?.trim()
  const showImage = Boolean(cleanSrc && failedSrc !== cleanSrc)
  const initial = (name.trim().slice(0, 1) || '?').toUpperCase()
  const iconSize = size === 'chip' ? 11 : size === 'sm' ? 14 : 17

  return (
    <span
      className="fb-avatar"
      data-sm={size === 'sm' ? '' : undefined}
      data-chip={size === 'chip' ? '' : undefined}
      data-kind={kind}
      data-has-img={showImage ? '' : undefined}
    >
      {showImage ? (
        <img
          src={cleanSrc}
          alt=""
          referrerPolicy="no-referrer"
          decoding="async"
          onError={() => setFailedSrc(cleanSrc ?? null)}
        />
      ) : kind === 'bot' ? (
        <RobotTabIcon size={iconSize} />
      ) : (
        name.trim().slice(0, 1) || initial
      )}
    </span>
  )
}

/** Settings row: title and description on the left, the control on the right. */
export function SettingRow({
  title,
  desc,
  stack,
  children,
}: {
  title: string
  desc?: ReactNode
  /** Put the control below the text (long text areas, tag lists). */
  stack?: boolean
  children: ReactNode
}) {
  return (
    <div className="fb-row" data-stack={stack ? '' : undefined}>
      <div className="fb-row-text">
        <div className="fb-row-title">{title}</div>
        {desc ? <div className="fb-row-desc">{desc}</div> : null}
      </div>
      {stack ? children : <div className="fb-row-control">{children}</div>}
    </div>
  )
}

export function GroupTitle({ children }: { children: ReactNode }) {
  return <h3 className="fb-group-title">{children}</h3>
}

/** Indented container with a left guide line for cascading child settings. */
export function NestedSettings({ children }: { children: ReactNode }) {
  return <div className="fb-nested">{children}</div>
}

/** Shared hint bar redirecting users to DSH's native automation schedules panel. */
export function ScheduleAutomationHint({
  onOpenScheduleManager,
  inDialog,
}: {
  onOpenScheduleManager?: (() => void) | undefined
  inDialog?: boolean
}) {
  return (
    <div className="fb-schedule-hint" data-dialog={inDialog ? '' : undefined}>
      <span>此处仅配置定时任务的飞书群通知方式，新建或修改自动化配置请前往</span>
      {onOpenScheduleManager ? (
        <button type="button" className="fb-inline-jump" onClick={onOpenScheduleManager}>
          <span>自动化任务</span>
          <IconChevronRightOutlineRegular size={13} />
        </button>
      ) : (
        <span>左侧「自动化任务」</span>
      )}
    </div>
  )
}

export interface CountTabOption<T extends string> {
  readonly value: T
  readonly label: string
  readonly count?: number | undefined
}

/** Segmented view switcher matching DSH SegmentedControl with muted unbracketed counts. */
export function CountSegmentedSwitch<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: readonly CountTabOption<T>[]
  onChange: (next: T) => void
}) {
  const selectedIdx = Math.max(0, options.findIndex((o) => o.value === value))
  const style = {
    '--fb-seg-count': String(options.length),
    '--fb-seg-index': String(selectedIdx),
  } as CSSProperties

  return (
    <div role="tablist" aria-label={label} className="fb-seg" style={style}>
      <span aria-hidden="true" className="fb-seg-indicator" />
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            className="fb-seg-tab"
            onClick={() => {
              if (!active) onChange(opt.value)
            }}
          >
            <span>{opt.label}</span>
            {opt.count !== undefined && <span className="fb-tab-count">{opt.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** Borderless status filter chips matching DSH TaskManagerPage filter tabs. */
export function FilterTabs<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: readonly CountTabOption<T>[]
  onChange: (next: T) => void
}) {
  return (
    <div role="group" aria-label={label} className="fb-filter-tabs">
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            className="fb-filter-tab"
            onClick={() => {
              if (!active) onChange(opt.value)
            }}
          >
            <span>{opt.label}</span>
            {opt.count !== undefined && <span className="fb-tab-count">{opt.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Unified editable scope tag list: renders each active scope once (click label to edit
 * in place, click × to remove), an inline "+ 添加" trigger, and a "恢复默认" action
 * shown only when the list differs from `presets`.
 */
export function EditableScopeList({
  values,
  presets,
  onChange,
  placeholder = '输入范围名称，回车确认',
}: {
  values: readonly string[]
  presets: readonly string[]
  onChange: (next: string[]) => void
  placeholder?: string
}) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [editingText, setEditingText] = useState('')

  const isModified =
    values.length !== presets.length || values.some((v, idx) => v !== presets[idx])

  const commitAdd = (raw: string, keepOpen = false) => {
    const items = raw
      .split(/[\n,，]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (items.length > 0) {
      onChange([...new Set([...values, ...items])])
    }
    setDraft('')
    if (!keepOpen) setAdding(false)
  }

  const commitEdit = (idx: number) => {
    const trimmed = editingText.trim()
    setEditingIdx(null)
    if (!trimmed) {
      onChange(values.filter((_, i) => i !== idx))
      return
    }
    const next = values.map((v, i) => (i === idx ? trimmed : v))
    onChange([...new Set(next)])
  }

  return (
    <div className="fb-scope-items">
      {values.map((item, idx) => {
        const isEditing = editingIdx === idx
        return (
          <span
            key={`${item}-${idx}`}
            className="fb-scope-chip"
            data-editing={isEditing ? '' : undefined}
          >
            {isEditing ? (
              <>
                <input
                  autoFocus
                  value={editingText}
                  style={{ width: `${Math.max(editingText.length + 1, 6)}em` }}
                  onChange={(e) => setEditingText(e.target.value)}
                  onBlur={() => commitEdit(idx)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitEdit(idx)
                    } else if (e.key === 'Escape') {
                      setEditingIdx(null)
                    }
                  }}
                />
                <button
                  type="button"
                  aria-label="保存修改"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => commitEdit(idx)}
                >
                  <IconCheckOutlineRegular size={12} />
                </button>
              </>
            ) : (
              <>
                <span
                  className="fb-scope-chip-text"
                  title="点击直接修改文案"
                  onClick={() => {
                    setAdding(false)
                    setEditingIdx(idx)
                    setEditingText(item)
                  }}
                >
                  {item}
                </span>
                <button
                  type="button"
                  aria-label={`移除 ${item}`}
                  onClick={() => onChange(values.filter((_, i) => i !== idx))}
                >
                  <IconCloseOutlineRegular size={12} />
                </button>
              </>
            )}
          </span>
        )
      })}

      {adding ? (
        <span className="fb-scope-chip" data-editing="">
          <input
            autoFocus
            value={draft}
            placeholder={placeholder}
            style={{ width: `${Math.max(draft.length + 1, 11)}em` }}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => commitAdd(draft, false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitAdd(draft, false)
              } else if (e.key === 'Escape') {
                setDraft('')
                setAdding(false)
              }
            }}
          />
          <button
            type="button"
            aria-label="确认添加"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => commitAdd(draft, false)}
          >
            <IconCheckOutlineRegular size={12} />
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="fb-scope-add-btn"
          onClick={() => {
            setEditingIdx(null)
            setAdding(true)
          }}
        >
          <IconPlusOutlineRegular size={12} />
          <span>添加</span>
        </button>
      )}

      {isModified && (
        <button
          type="button"
          className="fb-link-btn"
          onClick={() => {
            setAdding(false)
            setEditingIdx(null)
            onChange([...presets])
          }}
        >
          恢复默认
        </button>
      )}
    </div>
  )
}

/**
 * Option rendered by {@link SelectMenu}.
 * - `node` overrides both trigger pill and menu row (e.g. emoji + label).
 * - `menuNode` overrides only the dropdown row while keeping `label` on the compact trigger pill.
 * - `group` groups consecutive/matching options under a `MenuLabel` heading separated by hairlines.
 */
export interface SelectOption<T extends string> extends Choice<T> {
  readonly node?: ReactNode
  readonly menuNode?: ReactNode
  readonly group?: string
  readonly disabled?: boolean
}

function renderOptionMenuLabel<T extends string>(o: SelectOption<T>): ReactNode {
  if (o.menuNode) return o.menuNode
  if (o.node) return o.node
  if (o.desc) {
    return (
      <span className="fb-choice-opt">
        <span className="fb-choice-opt-label">{o.label}</span>
        <span className="fb-choice-opt-desc">{o.desc}</span>
      </span>
    )
  }
  return o.label
}

function buildSelectMenuEntries<T extends string>(options: readonly SelectOption<T>[]): MenuEntry[] {
  const hasGroups = options.some((o) => Boolean(o.group))
  if (!hasGroups) {
    return options.map((o) => ({
      id: o.value,
      label: renderOptionMenuLabel(o),
      ...(o.disabled ? { disabled: true } : {}),
    }))
  }

  const groupOrder: string[] = []
  const byGroup = new Map<string, SelectOption<T>[]>()
  for (const opt of options) {
    const g = opt.group ?? ''
    if (!byGroup.has(g)) {
      byGroup.set(g, [])
      groupOrder.push(g)
    }
    byGroup.get(g)!.push(opt)
  }

  const entries: MenuEntry[] = []
  groupOrder.forEach((groupName, idx) => {
    if (idx > 0) {
      entries.push({ type: 'separator', id: `__sep_${idx}` })
    }
    if (groupName) {
      entries.push({ type: 'label', id: `__lbl_${idx}_${groupName}`, text: groupName })
    }
    for (const o of byGroup.get(groupName) ?? []) {
      entries.push({
        id: o.value,
        label: renderOptionMenuLabel(o),
        ...(o.disabled ? { disabled: true } : {}),
      })
    }
  })
  return entries
}

export interface SelectFooterAction {
  readonly id: string
  readonly label: ReactNode
  readonly icon?: ReactNode
  readonly disabled?: boolean
  readonly onSelect: () => void
}

/** Dropdown built on DSH's Menu primitive with the settings-pill trigger. */
export function SelectMenu<T extends string>({
  value,
  options,
  onChange,
  footer,
  placeholder = '请选择',
  size = 'md',
  disabled,
}: {
  value: T
  options: readonly SelectOption<T>[]
  onChange: (next: T) => void
  /** Pinned bottom actions separated by a hairline (e.g. "管理启动配置…"). */
  footer?: readonly SelectFooterAction[]
  placeholder?: string
  size?: 'md' | 'sm'
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)
  const footerEntries: MenuEntry[] | undefined =
    footer && footer.length > 0
      ? footer.map((item) => ({
          id: item.id,
          label: item.label,
          ...(item.icon ? { icon: item.icon } : {}),
          ...(item.disabled ? { disabled: true } : {}),
        }))
      : undefined
  return (
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      items={buildSelectMenuEntries(options)}
      footer={footerEntries}
      selectedId={value}
      onSelect={(id) => {
        const footerItem = footer?.find((item) => item.id === id)
        if (footerItem) {
          setOpen(false)
          footerItem.onSelect()
          return
        }
        setOpen(false)
        if (id !== value) onChange(id as T)
      }}
      align="end"
      portal
      minWidthFromAnchor
      anchor={
        <button
          type="button"
          className="fb-select"
          data-size={size}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="fb-select-label">{selected ? selected.node ?? selected.label : placeholder}</span>
          <IconChevronDownOutlineRegular size={14} className="fb-select-chevron" />
        </button>
      }
    />
  )
}

export function TextField({
  value,
  onChange,
  placeholder,
  disabled,
  secret,
  mono,
  wide,
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  disabled?: boolean
  secret?: boolean
  mono?: boolean
  wide?: boolean
}) {
  return (
    <input
      className={mono ? 'fb-field fb-mono' : 'fb-field'}
      data-wide={wide ? '' : undefined}
      type={secret ? 'password' : 'text'}
      autoComplete={secret ? 'new-password' : 'off'}
      spellCheck={false}
      value={value}
      title={!secret && value ? value : undefined}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

export function NumberField({
  value,
  onChange,
  suffix,
  min = 0,
  disabled,
}: {
  value: number
  onChange: (next: number) => void
  suffix: string
  min?: number
  disabled?: boolean
}) {
  return (
    <span className="fb-field-suffix">
      <input
        className="fb-field fb-num"
        type="number"
        min={min}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Math.max(min, Number(e.target.value) || 0))}
      />
      {suffix}
    </span>
  )
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows,
  readOnly,
  disabled,
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  rows?: number
  readOnly?: boolean
  disabled?: boolean
}) {
  return (
    <textarea
      className="fb-textarea"
      value={value}
      rows={rows}
      placeholder={placeholder}
      readOnly={readOnly}
      disabled={disabled}
      onChange={(e) => {
        if (!readOnly && !disabled) onChange(e.target.value)
      }}
    />
  )
}

/** Free-form token list: Enter or comma commits, Backspace on empty removes the last. */
export function TagInput({
  values,
  onChange,
  placeholder,
  mono,
}: {
  values: readonly string[]
  onChange: (next: string[]) => void
  placeholder?: string
  mono?: boolean
}) {
  const [draft, setDraft] = useState('')
  const commit = (raw: string) => {
    const tokens = raw.split(/[\n,，]+/).map((s) => s.trim()).filter(Boolean)
    if (tokens.length === 0) return
    onChange([...new Set([...values, ...tokens])])
    setDraft('')
  }
  return (
    <div className="fb-tags">
      {values.map((tag) => (
        <span key={tag} className={mono ? 'fb-tag-chip fb-mono' : 'fb-tag-chip'}>
          {tag}
          <button type="button" aria-label={`移除 ${tag}`} onClick={() => onChange(values.filter((v) => v !== tag))}>
            <IconCloseOutlineRegular size={12} />
          </button>
        </span>
      ))}
      <input
        className={mono ? 'fb-mono' : undefined}
        value={draft}
        placeholder={values.length === 0 ? placeholder : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            commit(draft)
          } else if (e.key === 'Backspace' && !draft && values.length > 0) {
            onChange(values.slice(0, -1))
          }
        }}
      />
    </div>
  )
}

/** Multi-select rendered as DSH pills. */
export function ChipToggles<T extends string>({
  values,
  options,
  onChange,
}: {
  values: readonly T[]
  options: readonly Choice<T>[]
  onChange: (next: T[]) => void
}) {
  return (
    <div className="fb-chips">
      {options.map((o) => {
        const active = values.includes(o.value)
        return (
          <Pill
            key={o.value}
            active={active}
            aria-pressed={active}
            onClick={() => onChange(active ? values.filter((v) => v !== o.value) : [...values, o.value])}
          >
            {o.label}
          </Pill>
        )
      })}
    </div>
  )
}

/** "More" button that opens a native DSH menu of secondary actions. */
export function OverflowMenu({ label, items }: { label: string; items: readonly (MenuEntry & { onSelect?: () => void })[] }) {
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      items={items}
      onSelect={(id) => {
        setOpen(false)
        const item = items.find((i) => i.id === id)
        item?.onSelect?.()
      }}
      align="end"
      portal
      anchor={
        <button type="button" className="fb-icon-btn" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <IconEllipsisOutlineRegular size={16} />
        </button>
      }
    />
  )
}
