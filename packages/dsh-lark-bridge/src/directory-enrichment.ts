import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type {
  LarkBotConfig,
  LarkDirectoryUserHit,
  LarkPlatformManager,
} from '@dsh-lark/lark-core'

const DIRECTORY_CACHE_TTL_MS = 6 * 60 * 60_000
const CLI_MISS_COOLDOWN_MS = 5 * 60_000
const MAX_CONCURRENCY = 4

interface CachedDirectoryEntry {
  readonly hits: readonly LarkDirectoryUserHit[]
  readonly cachedAtMs: number
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function resolveLarkCliPath(): string | null {
  const home = homedir()
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const candidates = [
    ...pathDirs.map((dir) => join(dir, 'lark-cli')),
    join(home, '.npm-global', 'bin', 'lark-cli'),
    join(home, '.local', 'bin', 'lark-cli'),
    '/opt/homebrew/bin/lark-cli',
    '/usr/local/bin/lark-cli',
  ]
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate
  }
  return null
}

function parseDirectoryUsersPayload(payload: unknown): LarkDirectoryUserHit[] {
  if (!payload || typeof payload !== 'object') return []
  const root = payload as {
    data?: {
      users?: Array<{
        open_id?: string
        user_id?: string
        name?: string
        en_name?: string
        email?: string
        avatar?: { avatar_72?: string; avatar_240?: string; avatar_origin?: string }
      }>
    }
  }
  const out: LarkDirectoryUserHit[] = []
  for (const u of root.data?.users ?? []) {
    const openId = u.open_id?.trim()
    if (!openId) continue
    const userId = u.user_id?.trim() || undefined
    const avatarUrl = u.avatar?.avatar_72 || u.avatar?.avatar_240 || u.avatar?.avatar_origin
    out.push({
      openId,
      ...(userId ? { userId } : {}),
      name: u.name || u.en_name || openId,
      ...(u.en_name ? { enName: u.en_name } : {}),
      ...(u.email ? { email: u.email } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
    })
  }
  return out
}

async function queryViaHttpToken(query: string, accessToken: string): Promise<LarkDirectoryUserHit[]> {
  const url = new URL('https://open.feishu.cn/open-apis/search/v1/user')
  url.searchParams.set('query', query)
  url.searchParams.set('page_size', '20')
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
    },
  })
  if (!res.ok) return []
  return parseDirectoryUsersPayload(await res.json().catch(() => null))
}

function queryViaLarkCli(cliBin: string, query: string): Promise<LarkDirectoryUserHit[] | null> {
  return new Promise((resolve) => {
    execFile(
      cliBin,
      [
        'api',
        'GET',
        '/open-apis/search/v1/user',
        '--params',
        JSON.stringify({ query, page_size: 20 }),
        '--as',
        'user',
      ],
      { timeout: 6_000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(null)
          return
        }
        try {
          const parsed = JSON.parse(stdout) as { ok?: boolean }
          if (parsed.ok === false) {
            resolve(null)
            return
          }
          resolve(parseDirectoryUsersPayload(parsed))
        } catch {
          resolve(null)
        }
      },
    )
  })
}

/**
 * Resolves colleague profiles (especially avatars for members outside an app's Contact Scope)
 * using any authorized User OAuth token in {@link LarkPlatformManager}, degrading cleanly to
 * the official `lark-cli` user session when installed on the host.
 */
export class LarkDirectoryEnricher {
  private readonly queryCache = new Map<string, CachedDirectoryEntry>()
  private readonly inFlight = new Map<string, Promise<readonly LarkDirectoryUserHit[]>>()
  private readonly appAvatarCache = new Map<string, string | null>()
  private cliBinCheckedAtMs = 0
  private cachedCliBin: string | null = null
  private cliUnavailableUntilMs = 0

  constructor(
    private readonly platform: LarkPlatformManager,
    private readonly listBots: () => readonly LarkBotConfig[],
  ) {}

  async searchByQueries(
    queries: readonly string[],
    preferredBotId?: string,
  ): Promise<readonly LarkDirectoryUserHit[]> {
    const normalized = [...new Set(queries.map((q) => q.trim()).filter(Boolean))]
    if (normalized.length === 0) return []

    const results: LarkDirectoryUserHit[] = []
    for (let i = 0; i < normalized.length; i += MAX_CONCURRENCY) {
      const slice = normalized.slice(i, i + MAX_CONCURRENCY)
      const batch = await Promise.all(slice.map((q) => this.lookupSingleQuery(q, preferredBotId)))
      for (const items of batch) results.push(...items)
    }
    return results
  }

  async resolveAppAvatar(larkAppId?: string): Promise<string | undefined> {
    const appId = larkAppId?.trim()
    if (!appId) return undefined
    if (this.appAvatarCache.has(appId)) {
      return this.appAvatarCache.get(appId) ?? undefined
    }
    const info = await this.platform.fetchBotAppProfile(appId)
    const avatarUrl = info?.avatarUrl?.trim() || null
    this.appAvatarCache.set(appId, avatarUrl)
    return avatarUrl ?? undefined
  }

  private async lookupSingleQuery(
    query: string,
    preferredBotId?: string,
  ): Promise<readonly LarkDirectoryUserHit[]> {
    const now = Date.now()
    const cached = this.queryCache.get(query)
    if (cached && now - cached.cachedAtMs < DIRECTORY_CACHE_TTL_MS) {
      return cached.hits
    }
    const existing = this.inFlight.get(query)
    if (existing) return existing

    const task = this.fetchQueryUncached(query, preferredBotId).finally(() => {
      this.inFlight.delete(query)
    })
    this.inFlight.set(query, task)
    return task
  }

  private async fetchQueryUncached(
    query: string,
    preferredBotId?: string,
  ): Promise<readonly LarkDirectoryUserHit[]> {
    const oauth = await this.platform.getAnyValidUserAccessToken(this.listBots(), preferredBotId)
    if (oauth) {
      const hits = await queryViaHttpToken(query, oauth.accessToken).catch(() => [])
      if (hits.length > 0) {
        this.queryCache.set(query, { hits, cachedAtMs: Date.now() })
        return hits
      }
    }

    const now = Date.now()
    if (now >= this.cliUnavailableUntilMs) {
      const cliBin = this.getCliBin(now)
      if (cliBin) {
        const cliHits = await queryViaLarkCli(cliBin, query)
        if (cliHits === null) {
          this.cliUnavailableUntilMs = Date.now() + CLI_MISS_COOLDOWN_MS
        } else {
          this.queryCache.set(query, { hits: cliHits, cachedAtMs: Date.now() })
          return cliHits
        }
      }
    }

    return []
  }

  private getCliBin(now: number): string | null {
    if (this.cachedCliBin || now - this.cliBinCheckedAtMs < CLI_MISS_COOLDOWN_MS) {
      return this.cachedCliBin
    }
    this.cliBinCheckedAtMs = now
    this.cachedCliBin = resolveLarkCliPath()
    return this.cachedCliBin
  }
}
