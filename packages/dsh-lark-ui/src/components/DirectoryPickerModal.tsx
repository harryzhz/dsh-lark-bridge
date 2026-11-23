import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button,
  IconChevronRightOutlineRegular,
  IconCloseOutlineRegular,
  IconEyeOffOutlineRegular,
  IconEyeOutlineRegular,
  IconFolderCloseRegular,
  IconFolderOpenOutlineRegular,
  IconPlusOutlineRegular,
  IconSearchOutlineRegular,
  Input,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgeApi } from '../api.js'
import type { DirectoryBrowseResult } from '../types.js'

export function DirectoryField({
  value,
  onChange,
  placeholder,
  browseSeed,
  disabled,
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  browseSeed?: string | undefined
  disabled?: boolean
}) {
  const [pickerOpen, setPickerOpen] = useState(false)

  return (
    <>
      <span className="fb-dir-control">
        <input
          className="fb-dir-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="fb-dir-browse"
          aria-label="选择本地目录"
          title="选择本地目录"
          disabled={disabled}
          onClick={() => setPickerOpen(true)}
        >
          <IconFolderOpenOutlineRegular size={16} />
        </button>
      </span>
      {pickerOpen && (
        <DirectoryPickerModal
          initialPath={value.trim() || browseSeed || '~'}
          onClose={() => setPickerOpen(false)}
          onSelect={(selected) => {
            onChange(selected)
            setPickerOpen(false)
          }}
        />
      )}
    </>
  )
}

export function DirectoryPickerModal({
  initialPath,
  onClose,
  onSelect,
}: {
  initialPath?: string
  onClose: () => void
  onSelect: (selectedPath: string) => void
}) {
  const [listing, setListing] = useState<DirectoryBrowseResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [filter, setFilter] = useState('')
  const [creating, setCreating] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [error, setError] = useState('')

  const loadDir = useCallback(async (targetPath?: string) => {
    setLoading(true)
    setError('')
    try {
      const res = await bridgeApi.browseDirs(targetPath)
      setListing(res)
      setFilter('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadDir(initialPath)
  }, [initialPath, loadDir])

  const visibleEntries = useMemo(() => {
    if (!listing) return []
    const q = filter.trim().toLowerCase()
    return listing.entries.filter((entry) => {
      if (!showHidden && entry.hidden) return false
      if (q && !entry.name.toLowerCase().includes(q)) return false
      return true
    })
  }, [listing, showHidden, filter])

  const submitNewFolder = async () => {
    if (!listing || !newFolderName.trim()) return
    setError('')
    try {
      const createdPath = await bridgeApi.createDir(listing.path, newFolderName.trim())
      setNewFolderName('')
      setCreating(false)
      await loadDir(createdPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Modal open onClose={onClose} title="选择本地工作目录" headless className="fb-schedule-dialog fb-nested-modal">
      <div className="fb-schedule-dialog-head">
        <div style={{ minWidth: 0 }}>
          <div className="fb-schedule-dialog-title">选择本地工作目录</div>
          <div className="fb-schedule-dialog-sub fb-mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {listing?.path ?? initialPath ?? '~'}
          </div>
        </div>
        <button type="button" className="fb-icon-btn" aria-label="关闭" onClick={onClose}>
          <IconCloseOutlineRegular size={14} />
        </button>
      </div>

      <div className="fb-schedule-dialog-body">
        <div className="fb-dir-toolbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Button
              size="sm"
              variant="ghost"
              disabled={loading || !listing}
              onClick={() => listing && void loadDir(listing.home)}
            >
              主目录 (~)
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={showHidden ? <IconEyeOutlineRegular size={14} /> : <IconEyeOffOutlineRegular size={14} />}
              onClick={() => setShowHidden((v) => !v)}
            >
              {showHidden ? '隐藏点目录' : '显示隐藏目录'}
            </Button>
          </div>
          <Button
            size="sm"
            variant="outline"
            icon={<IconPlusOutlineRegular size={14} />}
            disabled={!listing}
            onClick={() => setCreating((v) => !v)}
          >
            新建文件夹
          </Button>
        </div>

        {listing && (
          <div className="fb-dir-crumbs">
            {listing.crumbs.map((crumb, idx) => {
              const isLast = idx === listing.crumbs.length - 1
              return (
                <span key={crumb.path} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                  {idx > 0 && <span className="fb-dir-sep">/</span>}
                  <button
                    type="button"
                    className="fb-dir-crumb"
                    data-current={isLast ? '' : undefined}
                    onClick={() => void loadDir(crumb.path)}
                  >
                    {idx === 0 && crumb.name === '/' ? '根目录' : crumb.name}
                  </button>
                </span>
              )
            })}
          </div>
        )}

        {creating && (
          <div className="fb-scope-add" style={{ marginTop: 8 }}>
            <input
              autoFocus
              className="fb-field fb-mono"
              value={newFolderName}
              placeholder="新文件夹名称"
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void submitNewFolder()
                } else if (e.key === 'Escape') {
                  setCreating(false)
                }
              }}
            />
            <Button size="sm" variant="primary" disabled={!newFolderName.trim()} onClick={() => void submitNewFolder()}>
              创建并进入
            </Button>
          </div>
        )}

        {listing && listing.entries.length > 8 && (
          <div style={{ marginTop: 8 }}>
            <Input
              className="fb-search"
              icon={<IconSearchOutlineRegular size={15} />}
              placeholder="筛选当前目录下的子文件夹…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
        )}

        <div className="fb-dir-list">
          {loading && <div className="fb-empty" style={{ padding: '32px 12px' }}>正在读取目录…</div>}
          {!loading && visibleEntries.length === 0 && (
            <div className="fb-empty" style={{ padding: '32px 12px' }}>
              {filter ? '没有匹配的子目录' : '当前目录下暂无子文件夹，可直接选择当前目录'}
            </div>
          )}
          {!loading &&
            visibleEntries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="fb-dir-entry"
                data-hidden={entry.hidden ? '' : undefined}
                onClick={() => void loadDir(entry.path)}
              >
                <IconFolderCloseRegular size={15} />
                <span className="fb-dir-entry-name">{entry.name}</span>
                <IconChevronRightOutlineRegular size={13} className="fb-select-chevron" />
              </button>
            ))}
        </div>
      </div>

      <div className="fb-schedule-dialog-foot">
        {error ? <span className="fb-dialog-error">{error}</span> : null}
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button
          variant="primary"
          disabled={!listing || loading}
          onClick={() => listing && onSelect(listing.path)}
        >
          选择当前目录
        </Button>
      </div>
    </Modal>
  )
}
