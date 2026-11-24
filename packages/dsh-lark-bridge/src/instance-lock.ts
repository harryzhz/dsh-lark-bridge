import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { tightenFileMode } from './storage/database.js'

export const INSTANCE_LOCK_FILENAME = 'bridge.lock'
const HEARTBEAT_INTERVAL_MS = 30_000
const STALE_HEARTBEAT_MS = 120_000

export interface InstanceLockPayload {
  readonly pid: number
  readonly host: string
  readonly instanceId: string
  readonly startedAtMs: number
  readonly heartbeatAtMs: number
  readonly mode: string
}

export interface InstanceLockStatus {
  readonly held: boolean
  readonly lockPath: string
  readonly holder?: InstanceLockPayload
  readonly recoveredStaleLock?: InstanceLockPayload
}

export class InstanceLockConflictError extends Error {
  readonly holder: InstanceLockPayload

  constructor(holder: InstanceLockPayload) {
    super(
      `检测到另一 dsh-lark-bridge 实例正在使用同一数据目录（PID=${holder.pid}, host=${holder.host}, startedAt=${new Date(holder.startedAtMs).toISOString()}）。为避免多进程争抢状态与飞书长连接，已中止重复启动。`,
    )
    this.name = 'InstanceLockConflictError'
    this.holder = holder
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as { code?: string })?.code === 'EPERM'
  }
}

function readLockPayload(lockPath: string): InstanceLockPayload | undefined {
  if (!existsSync(lockPath)) return undefined
  try {
    const raw = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<InstanceLockPayload>
    if (typeof raw.pid !== 'number' || typeof raw.instanceId !== 'string') return undefined
    return {
      pid: raw.pid,
      host: typeof raw.host === 'string' ? raw.host : 'unknown',
      instanceId: raw.instanceId,
      startedAtMs: typeof raw.startedAtMs === 'number' ? raw.startedAtMs : 0,
      heartbeatAtMs: typeof raw.heartbeatAtMs === 'number' ? raw.heartbeatAtMs : raw.startedAtMs ?? 0,
      mode: typeof raw.mode === 'string' ? raw.mode : 'default',
    }
  } catch {
    return undefined
  }
}

/**
 * Local per-dataDir process mutual exclusion lock with PID liveness probe,
 * heartbeat renewal, and automatic stale-lock recovery.
 */
export class InstanceLock {
  readonly lockPath: string
  readonly instanceId = randomUUID()
  private holder?: InstanceLockPayload
  private recoveredStaleLock?: InstanceLockPayload
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private exitHandler?: () => void

  constructor(
    private readonly dataDir: string,
    private readonly mode = 'bridge',
  ) {
    this.lockPath = join(dataDir, INSTANCE_LOCK_FILENAME)
  }

  acquire(nowMs = Date.now()): InstanceLockStatus {
    if (this.holder) return this.status()
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })

    const payload: InstanceLockPayload = {
      pid: process.pid,
      host: hostname(),
      instanceId: this.instanceId,
      startedAtMs: nowMs,
      heartbeatAtMs: nowMs,
      mode: this.mode,
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(this.lockPath, 'wx', 0o600)
        try {
          writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
        } finally {
          closeSync(fd)
        }
        tightenFileMode(this.lockPath, 0o600)
        this.holder = payload
        this.startHeartbeat()
        return this.status()
      } catch (err) {
        if ((err as { code?: string })?.code !== 'EEXIST') throw err
        const existing = readLockPayload(this.lockPath)
        if (existing) {
          const sameHost = existing.host === payload.host
          const pidAlive = sameHost && isPidAlive(existing.pid)
          const heartbeatFresh = nowMs - existing.heartbeatAtMs < STALE_HEARTBEAT_MS
          if (existing.pid !== process.pid && (pidAlive || (!sameHost && heartbeatFresh))) {
            throw new InstanceLockConflictError(existing)
          }
          // Same-PID stale lock or dead PID / expired heartbeat -> reclaim cleanly.
          this.recoveredStaleLock = existing
        }
        rmSync(this.lockPath, { force: true })
      }
    }

    throw new Error(`Unable to acquire instance lock at ${this.lockPath}`)
  }

  /**
   * Acquires the exclusive lock with bounded backoff when a same-host predecessor
   * process is still releasing the lock during a rapid restart (e.g. within DSH's
   * 5s shutdown grace window). Cross-host conflicts fail immediately to prevent split-brain.
   */
  async acquireAsync(
    options: { readonly waitMs?: number; readonly pollMs?: number } = {},
  ): Promise<InstanceLockStatus> {
    const waitMs = Math.max(0, options.waitMs ?? 6_000)
    const pollMs = Math.max(25, Math.min(options.pollMs ?? 150, 1_000))
    const deadline = Date.now() + waitMs
    const localHost = hostname()

    while (true) {
      try {
        return this.acquire()
      } catch (err) {
        if (!(err instanceof InstanceLockConflictError)) throw err
        if (err.holder.host !== localHost || Date.now() >= deadline) {
          throw err
        }
        const remaining = deadline - Date.now()
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(pollMs, Math.max(10, remaining)))
          timer.unref?.()
        })
      }
    }
  }

  status(): InstanceLockStatus {
    return {
      held: Boolean(this.holder),
      lockPath: this.lockPath,
      ...(this.holder ? { holder: this.holder } : {}),
      ...(this.recoveredStaleLock ? { recoveredStaleLock: this.recoveredStaleLock } : {}),
    }
  }

  release(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.exitHandler) {
      process.off('exit', this.exitHandler)
      this.exitHandler = undefined
    }
    if (!this.holder) return
    const current = readLockPayload(this.lockPath)
    if (!current || current.instanceId === this.instanceId) {
      rmSync(this.lockPath, { force: true })
    }
    this.holder = undefined
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.refreshHeartbeat()
    }, HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref?.()

    this.exitHandler = () => {
      try {
        const current = readLockPayload(this.lockPath)
        if (current && current.instanceId === this.instanceId) {
          rmSync(this.lockPath, { force: true })
        }
      } catch {
        // Best-effort process exit cleanup.
      }
    }
    process.on('exit', this.exitHandler)
  }

  private refreshHeartbeat(): void {
    if (!this.holder) return
    const current = readLockPayload(this.lockPath)
    if (current && current.instanceId !== this.instanceId) return
    const next: InstanceLockPayload = {
      ...this.holder,
      heartbeatAtMs: Date.now(),
    }
    try {
      const tmp = `${this.lockPath}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, this.lockPath)
      tightenFileMode(this.lockPath, 0o600)
      this.holder = next
    } catch {
      // Non-fatal heartbeat refresh failure.
    }
  }
}

/**
 * Pluggable coordination seam for future multi-node deployments (e.g. Redis / shared volume)
 * while keeping single-host deployments zero-dependency on local SQLite + InstanceLock.
 */
export interface CoordinationBackend {
  readonly kind: string
  tryClaimMessage(dedupKey: string): boolean
}
