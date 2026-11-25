import type { ReactNode } from 'react'
import { Button, IconCloseOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

export interface ConfigSection<K extends string> {
  readonly key: K
  readonly label: string
  readonly icon?: ReactNode
}

export interface ConfigDialogSubview {
  readonly title: string
  readonly onBack: () => void
  readonly content: ReactNode
}

/**
 * Floating configuration panel shaped like DSH's settings dialog: a section
 * rail on the left, settings rows on the right, and save/cancel at the bottom.
 * Supports an in-place drill-down `subview` inside the same single modal so
 * secondary editors never stack a second backdrop over the parent dialog.
 */
export function ConfigDialog<K extends string>({
  open,
  title,
  sections,
  active,
  onSectionChange,
  onClose,
  onSave,
  saving,
  error,
  subview,
  children,
}: {
  open: boolean
  title: string
  sections: readonly ConfigSection<K>[]
  active: K
  onSectionChange: (key: K) => void
  onClose: () => void
  onSave: () => void
  saving: boolean
  error?: string
  subview?: ConfigDialogSubview | null
  children: ReactNode
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={subview ? subview.title : title}
      headless
      className="fb-dialog"
      onKeyDownCapture={
        subview
          ? (event) => {
              if (
                event.key === 'Escape' &&
                !event.shiftKey &&
                !event.defaultPrevented &&
                !(event.target instanceof Element && event.target.closest('[data-fb-escape-local]'))
              ) {
                event.preventDefault()
                event.stopPropagation()
                subview.onBack()
              }
            }
          : undefined
      }
    >
      {subview ? (
        subview.content
      ) : (
        <>
          <div className="fb-dialog-header">
            <div className="fb-dialog-title" title={title}>
              {title}
            </div>
            <button type="button" className="fb-icon-btn" aria-label="关闭" onClick={onClose}>
              <IconCloseOutlineRegular size={14} />
            </button>
          </div>
          <nav className="fb-dialog-nav" aria-label={title}>
            {sections.map((s) => (
              <button
                key={s.key}
                type="button"
                className="fb-nav-cell"
                aria-current={s.key === active ? 'page' : undefined}
                onClick={() => onSectionChange(s.key)}
              >
                {s.icon && <span className="fb-nav-icon">{s.icon}</span>}
                <span>{s.label}</span>
              </button>
            ))}
          </nav>
          <div className="fb-dialog-options">{children}</div>
          <div className="fb-dialog-footer">
            {error ? <span className="fb-dialog-error">{error}</span> : null}
            <Button variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" disabled={saving} onClick={onSave}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </>
      )}
    </Modal>
  )
}
