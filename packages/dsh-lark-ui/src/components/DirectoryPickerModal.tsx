import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button,
  IconChevronLeftOutlineRegular,
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
import type { DirectoryBrowseResult, DirectoryCrumb } from '../types.js'

export function filterDirectoryEntries(
  entries: readonly DirectoryCrumb[],
  options: { showHidden: boolean; query: string },
): DirectoryCrumb[] {
  const q = options.query.trim().toLowerCase()
  return entries.filter((entry) => {
    if (!options.showHidden && entry.hidden) return false
    if (q && !entry.name.toLowerCase().includes(q)) return false
    return true
  })
}

export function DirectoryField({
  value,
  onChange,
  placeholder,
  browseSeed,
  disabled,
  onBrowse,
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  browseSeed?: string | undefined
  disabled?: boolean
  onBrowse?: (initialPath: string) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const resolvedInitialPath = value.trim() || browseSeed || '~'

  const handleBrowse = () => {
    if (onBrowse) {
      onBrowse(resolvedInitialPath)
      return
    }
    setPickerOpen(true)
  }

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
          onClick={handleBrowse}
        >
          <IconFolderOpenOutlineRegular size={16} />
        </button>
      </span>
      {!onBrowse && pickerOpen && (
        <DirectoryPickerModal
          initialPath={resolvedInitialPath}
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

export function DirectoryPickerPanel({
  initialPath,
  backLabel,
  onBack,
  onClose,
  onSelect,
}: {
  initialPath?: string
  backLabel?: string
  onBack?: () => void
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

  const visibleEntries = useMemo(
    () => (listing ? filterDirectoryEntries(listing.entries, { showHidden, query: filter }) : []),
    [listing, showHidden, filter],
  )

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

  const currentPath = listing?.path ?? initialPath ?? '~'

  return (
    <>
      <div className="fb-schedule-dialog-head fb-dir-head">
        <div className="fb-dir-head-main">
          {onBack ? (
            <div className="fb-dialog-header-main">
              <button
                type="button"
                className="fb-dialog-back"
                onClick={onBack}
                aria-label={backLabel ? `返回${backLabel}` : '返回'}
              >
                <IconChevronLeftOutlineRegular size={15} />
                <span>{backLabel || '返回'}</span>
              </button>
              <span className="fb-dialog-header-sep" aria-hidden="true">
                /
              </span>
              <div className="fb-schedule-dialog-title">选择本地工作目录</div>
            </div>
          ) : (
            <div className="fb-schedule-dialog-title">选择本地工作目录</div>
          )}
          <div className="fb-dir-path fb-mono" title={currentPath}>
            {currentPath}
          </div>
        </div>
        <button type="button" className="fb-icon-btn" aria-label="关闭" onClick={onClose}>
          <IconCloseOutlineRegular size={14} />
        </button>
      </div>

      <div className="fb-dir-body">
        <div className="fb-dir-toolbar">
          <div className="fb-dir-toolbar-left">
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
              className="fb-dir-toggle"
              aria-pressed={showHidden}
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
              data-fb-escape-local=""
              className="fb-field fb-mono"
              value={newFolderName}
              placeholder="新文件夹名称"
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void submitNewFolder()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  setCreating(false)
                }
              }}
            />
            <Button size="sm" variant="primary" disabled={!newFolderName.trim()} onClick={() => void submitNewFolder()}>
              创建并进入
            </Button>
          </div>
        )}

        <div className="fb-dir-search">
          <Input
            className="fb-search"
            icon={<IconSearchOutlineRegular size={15} />}
            placeholder="筛选当前目录下的子文件夹…"
            value={filter}
            disabled={!listing}
            data-fb-escape-local={filter ? '' : undefined}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && filter) {
                e.preventDefault()
                e.stopPropagation()
                setFilter('')
              }
            }}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>

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
                <IconFolderCloseRegular size={15} className="fb-dir-entry-icon" />
                <span className="fb-dir-entry-name">{entry.name}</span>
                <IconChevronRightOutlineRegular size={13} className="fb-select-chevron" />
              </button>
            ))}
        </div>
      </div>

      <div className="fb-schedule-dialog-foot">
        {error ? <span className="fb-dialog-error">{error}</span> : null}
        <Button variant="outline" onClick={onBack ?? onClose}>
          {onBack ? '返回' : '取消'}
        </Button>
        <Button
          variant="primary"
          disabled={!listing || loading}
          onClick={() => listing && onSelect(listing.path)}
        >
          选择当前目录
        </Button>
      </div>
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
  return (
    <Modal open onClose={onClose} title="选择本地工作目录" headless className="fb-schedule-dialog fb-dir-modal fb-nested-modal">
      <DirectoryPickerPanel initialPath={initialPath} onClose={onClose} onSelect={onSelect} />
    </Modal>
  )
}
