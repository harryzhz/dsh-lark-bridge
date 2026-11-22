import { useEffect, useState } from 'react'
import {
  IconCloseOutlineRegular,
  IconSearchOutlineRegular,
  Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgeApi } from '../api.js'
import type { SubstituteTarget, UserSearchHit } from '../types.js'
import { Avatar } from './fields.js'

export function UserSearchPicker({
  botId,
  values,
  onChange,
  placeholder = '输入姓名、邮箱或 ou_xxx 搜索成员…',
}: {
  botId: string | null
  values: readonly SubstituteTarget[]
  onChange: (next: SubstituteTarget[]) => void
  placeholder?: string
}) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<UserSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!botId || !focused) return
    let cancelled = false
    const timer = window.setTimeout(async () => {
      setSearching(true)
      try {
        const res = await bridgeApi.searchUsers(botId, query)
        if (!cancelled) setHits(res)
      } catch {
        if (!cancelled) setHits([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [botId, query, focused])

  const addUser = (user: SubstituteTarget) => {
    if (values.some((v) => v.openId === user.openId)) return
    onChange([...values, user])
    setQuery('')
  }

  const removeUser = (openId: string) => {
    onChange(values.filter((v) => v.openId !== openId))
  }

  return (
    <>
      {values.length > 0 && (
        <div className="fb-chips">
          {values.map((u) => (
            <span
              key={u.openId}
              className="fb-tag-chip"
              title={u.email ? `${u.email} (${u.openId})` : u.openId}
            >
              {u.avatarUrl ? <Avatar src={u.avatarUrl} name={u.name} kind="user" size="chip" /> : null}
              <span>{u.name}</span>
              <button
                type="button"
                aria-label={`移除 ${u.name}`}
                onClick={() => removeUser(u.openId)}
              >
                <IconCloseOutlineRegular size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      {botId ? (
        <div className="fb-picker">
          <Input
            className="fb-search"
            icon={<IconSearchOutlineRegular size={16} />}
            placeholder={placeholder}
            value={query}
            onFocus={() => setFocused(true)}
            onBlur={() => window.setTimeout(() => setFocused(false), 180)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && query.trim().startsWith('ou_')) {
                e.preventDefault()
                const openId = query.trim()
                const matched = hits.find((h) => h.openId === openId)
                addUser(
                  matched
                    ? {
                        openId: matched.openId,
                        name: matched.name,
                        ...(matched.email ? { email: matched.email } : {}),
                        ...(matched.avatarUrl ? { avatarUrl: matched.avatarUrl } : {}),
                      }
                    : { openId, name: openId },
                )
              }
            }}
            onChange={(e) => setQuery(e.target.value)}
          />
          {focused && (searching || hits.length > 0 || query.trim().length > 0) && (
            <div className="fb-picker-results">
              {searching && (
                <div className="fb-row-desc" style={{ padding: '8px 10px' }}>
                  搜索中…
                </div>
              )}
              {!searching && hits.length === 0 && (
                <div className="fb-row-desc" style={{ padding: '8px 10px' }}>
                  未找到匹配的成员
                </div>
              )}
              {!searching &&
                hits.map((u) => {
                  const already = values.some((v) => v.openId === u.openId)
                  return (
                    <button
                      key={u.openId}
                      type="button"
                      className="fb-picker-item"
                      disabled={already}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() =>
                        addUser({
                          openId: u.openId,
                          name: u.name,
                          ...(u.email ? { email: u.email } : {}),
                          ...(u.avatarUrl ? { avatarUrl: u.avatarUrl } : {}),
                        })
                      }
                    >
                      <Avatar src={u.avatarUrl} name={u.name} kind="user" size="sm" />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13.5 }}>{u.name}</div>
                        <div className="fb-picker-meta">{u.email || u.openId}</div>
                      </div>
                      <span className="fb-picker-meta">{already ? '已添加' : '选择'}</span>
                    </button>
                  )
                })}
            </div>
          )}
        </div>
      ) : null}
    </>
  )
}
