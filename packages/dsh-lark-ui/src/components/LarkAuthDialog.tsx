import { useEffect, useState } from 'react'
import { Button, IconCloseOutlineRegular, Modal, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { bridgeApi } from '../api.js'
import type { AuthStatusPayload, BotRecord, QrJobView } from '../types.js'
import { GroupTitle, SettingRow } from './fields.js'

export function LarkAuthDialog({
  open,
  auth,
  bots,
  onClose,
  onUpdated,
}: {
  open: boolean
  auth: AuthStatusPayload | null
  bots: readonly BotRecord[]
  onClose: () => void
  onUpdated: () => Promise<void>
}) {
  const [platformJob, setPlatformJob] = useState<QrJobView | null>(null)
  const [userJob, setUserJob] = useState<{ botId: string; job: QrJobView } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) {
      setPlatformJob(null)
      setUserJob(null)
    }
  }, [open])

  useEffect(() => {
    if (!platformJob || !['waiting_scan', 'scanned', 'working'].includes(platformJob.status)) return
    const timer = window.setInterval(async () => {
      try {
        const next = await bridgeApi.pollAuthJob(platformJob.jobId)
        setPlatformJob(next)
        if (next.status === 'succeeded') {
          await onUpdated()
        }
      } catch {
        // Ignore transient poll error.
      }
    }, 1500)
    return () => window.clearInterval(timer)
  }, [platformJob, onUpdated])

  useEffect(() => {
    if (!userJob || !['waiting_scan', 'scanned', 'working'].includes(userJob.job.status)) return
    const timer = window.setInterval(async () => {
      try {
        const next = await bridgeApi.pollAuthJob(userJob.job.jobId)
        setUserJob({ botId: userJob.botId, job: next })
        if (next.status === 'succeeded') {
          await onUpdated()
        }
      } catch {
        // Ignore transient poll error.
      }
    }, 1800)
    return () => window.clearInterval(timer)
  }, [userJob, onUpdated])

  if (!open) return null

  const op = auth?.openPlatform
  const userAuthMap = new Map((auth?.userAuth ?? []).map((u) => [u.botId, u]))

  const startPlatformQr = async () => {
    setBusy(true)
    try {
      setPlatformJob(await bridgeApi.startOpenPlatformLogin())
    } finally {
      setBusy(false)
    }
  }

  const logoutPlatform = async () => {
    setBusy(true)
    try {
      await bridgeApi.logoutOpenPlatform()
      setPlatformJob(null)
      await onUpdated()
    } finally {
      setBusy(false)
    }
  }

  const startBotUserAuth = async (botId: string) => {
    setBusy(true)
    try {
      const job = await bridgeApi.startUserAuthLogin(botId)
      setUserJob({ botId, job })
    } finally {
      setBusy(false)
    }
  }

  const revokeBotUserAuth = async (botId: string) => {
    setBusy(true)
    try {
      await bridgeApi.revokeUserAuth(botId)
      if (userJob?.botId === botId) setUserJob(null)
      await onUpdated()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="飞书登录与授权" headless className="fb-schedule-dialog fb-nested-modal">
      <div className="fb-schedule-dialog-head">
        <div style={{ minWidth: 0 }}>
          <div className="fb-schedule-dialog-title">飞书登录与授权</div>
          <div className="fb-schedule-dialog-sub">用于一键自动创建飞书智能体、同步简介签名与搜索企业通讯录成员</div>
        </div>
        <button type="button" className="fb-icon-btn" aria-label="关闭" onClick={onClose}>
          <IconCloseOutlineRegular size={14} />
        </button>
      </div>

      <div className="fb-schedule-dialog-body">
        <GroupTitle>开放平台登录</GroupTitle>
        <SettingRow
          title={
            op?.authenticated && op.identity
              ? `${op.identity.userName}（${op.identity.tenantName}）`
              : '未登录飞书开放平台'
          }
          desc="用于一键创建自建应用、自动开启长连接及同步名片信息"
        >
          <StateDot state={op?.authenticated ? 'done' : 'idle'} />
          <Button size="sm" variant={op?.authenticated ? 'outline' : 'primary'} disabled={busy} onClick={() => void startPlatformQr()}>
            {op?.authenticated ? '重新扫码' : '扫码登录'}
          </Button>
          {op?.authenticated && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void logoutPlatform()}>
              退出
            </Button>
          )}
        </SettingRow>

        {platformJob && platformJob.status !== 'succeeded' && (
          <div className="fb-qr-panel" style={{ marginBottom: 12 }}>
            {platformJob.qrSvgDataUrl && <img className="fb-qr-img" src={platformJob.qrSvgDataUrl} alt="飞书开放平台登录二维码" />}
            <div className="fb-qr-info">
              <div style={{ fontWeight: 500 }}>开放平台扫码认证</div>
              <div className="fb-row-desc">{platformJob.stepMessage}</div>
              {(platformJob.status === 'expired' || platformJob.status === 'failed') && (
                <div>
                  <Button size="sm" variant="outline" onClick={() => void startPlatformQr()}>
                    刷新二维码
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}

        <GroupTitle>企业通讯录成员搜索授权</GroupTitle>
        {bots.length === 0 ? (
          <div className="fb-row-desc" style={{ padding: '12px 0' }}>
            添加智能体后，可在此按智能体扫码授权全企业成员姓名搜索（未授权时默认可搜索已加入群内的成员）
          </div>
        ) : (
          bots.map((b) => {
            const ua = userAuthMap.get(b.id)
            const activeJob = userJob?.botId === b.id ? userJob.job : null
            return (
              <div key={b.id}>
                <SettingRow
                  title={b.name}
                  desc={ua?.authorized ? '支持搜索全企业通讯录' : '当前仅可搜索已入群成员'}
                >
                  <Tag tone={ua?.authorized ? 'success' : 'quiet'}>{ua?.authorized ? '已授权' : '未授权'}</Tag>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void startBotUserAuth(b.id)}>
                    {ua?.authorized ? '重新授权' : '扫码授权'}
                  </Button>
                  {ua?.authorized && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void revokeBotUserAuth(b.id)}>
                      清除
                    </Button>
                  )}
                </SettingRow>
                {activeJob && activeJob.status !== 'succeeded' && (
                  <div className="fb-qr-panel" style={{ marginBottom: 12 }}>
                    {activeJob.qrSvgDataUrl && <img className="fb-qr-img" src={activeJob.qrSvgDataUrl} alt="通讯录授权二维码" />}
                    <div className="fb-qr-info">
                      <div style={{ fontWeight: 500 }}>{b.name} · 用户授权</div>
                      <div className="fb-row-desc">{activeJob.stepMessage}</div>
                      {activeJob.verificationUrl && (
                        <a href={activeJob.verificationUrl} target="_blank" rel="noreferrer" className="fb-row-desc" style={{ textDecoration: 'underline' }}>
                          在浏览器中打开授权页
                        </a>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      <div className="fb-schedule-dialog-foot">
        <Button variant="primary" onClick={onClose}>
          完成
        </Button>
      </div>
    </Modal>
  )
}
