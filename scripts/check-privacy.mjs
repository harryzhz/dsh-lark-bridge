#!/usr/bin/env node
/**
 * Repository privacy & secret hygiene checker (zero external dependencies).
 *
 * Scans tracked and untracked non-ignored files for:
 *  - forbidden sensitive filenames (`.env`, private keys, runtime credential stores, tarballs)
 *  - common secret/key/token patterns and hardcoded credential assignments
 *  - production-length Lark/Feishu entity IDs (`cli_`, `ou_`, `oc_`, `on_`, `om_`, `t-`, `u-`)
 *  - personal host absolute paths (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`)
 *  - private/intranet host suffixes and non-public npm registry URLs in `pnpm-lock.yaml`
 *  - optional local gitignored denylist (`.local/privacy-denylist.txt` or `PRIVACY_DENYLIST_FILE`)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const selfRelPath = 'scripts/check-privacy.mjs'

const FORBIDDEN_FILE_PATTERNS = [
  { name: 'dotenv file', regex: /(^|\/)\.env(\..+)?$/i, allow: /(^|\/)\.env\.example$/i },
  { name: 'private key or certificate', regex: /\.(pem|key|p12|pfx|jks|keystore)$/i },
  {
    name: 'runtime credential/state cache',
    regex: /(^|\/)(open-platform-session|user-oauth-tokens|cli-endpoint|state|config\.snapshot)\.json$|(^|\/)lark-bridge-state[^/]*\.json$|(^|\/)bridge\.lock$|\.(db|db-wal|db-shm|sqlite|sqlite3)$/i,
  },
  { name: 'release tarball', regex: /\.tgz$/i },
]

const SKIP_CONTENT_FILES = new Set([
  selfRelPath,
  'packages/dsh-lark-ui/src/assets/lark-emoji.ts',
])

const ALLOWED_DEMO_USERS = new Set(['demo', 'user', 'example', 'runner', 'ubuntu', 'vscode', 'test'])

const PLACEHOLDER_SECRET_WORDS =
  /^(?:your|replace|test|mock|dummy|fake|sample|example|placeholder|super|secret|value|token|key|sec)(?:[-_](?:your|replace|test|mock|dummy|fake|sample|example|placeholder|super|secret|value|token|key|sec))*$/i

const CONTENT_RULES = [
  {
    name: 'private key block',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    name: 'provider API key or access token',
    regex: /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{24,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g,
  },
  {
    name: 'JWT token',
    regex: /\beyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g,
  },
  {
    name: 'production-length Lark/Feishu ID',
    regex: /\b(?:cli_[a-f0-9]{12,}|(?:ou|oc|on|om)_[a-f0-9]{20,}|[tu]-[A-Za-z0-9._-]{24,})\b/g,
  },
  {
    name: 'hardcoded credential assignment',
    regex: /\b(?:larkAppSecret|app_secret|client_secret|api_key|access_token|refresh_token|encrypt_key|verification_token)\s*[:=]\s*['"]([A-Za-z0-9+/=._-]{16,})['"]/gi,
    filter: (match) => {
      const val = match[1] || ''
      return !PLACEHOLDER_SECRET_WORDS.test(val)
    },
  },
  {
    name: 'private intranet domain',
    regex: /\b[a-z0-9-]+\.(?:corp|intranet|lan|localdomain)\b/gi,
  },
  {
    name: 'personal host home path',
    regex: /(?:\/Users\/([A-Za-z0-9._-]+)(?:\/|$)|\/home\/([A-Za-z0-9._-]+)(?:\/|$)|[A-Za-z]:\\Users\\([A-Za-z0-9._-]+)(?:\\|$))/g,
    filter: (match) => {
      const user = (match[1] || match[2] || match[3] || '').toLowerCase()
      return Boolean(user) && !ALLOWED_DEMO_USERS.has(user)
    },
  },
]

function collectCandidateFiles() {
  const tracked = execFileSync('git', ['-C', repoRoot, 'ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
  const untracked = execFileSync(
    'git',
    ['-C', repoRoot, 'ls-files', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean)
  return [...new Set([...tracked, ...untracked])].sort()
}

function loadLocalDenylist() {
  const configured = process.env.PRIVACY_DENYLIST_FILE?.trim()
  const filePath = configured ? resolve(repoRoot, configured) : resolve(repoRoot, '.local/privacy-denylist.txt')
  if (!existsSync(filePath)) return []
  const rules = []
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim()
    if (!raw || raw.startsWith('#')) continue
    const regexMatch = /^\/(.+)\/([gimsuy]*)$/.exec(raw)
    if (regexMatch) {
      const flags = regexMatch[2].includes('g') ? regexMatch[2] : `${regexMatch[2]}g`
      rules.push({ name: `local denylist line ${i + 1}`, regex: new RegExp(regexMatch[1], flags) })
    } else {
      const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      rules.push({ name: `local denylist line ${i + 1}`, regex: new RegExp(escaped, 'gi') })
    }
  }
  return rules
}

function checkLockfile(relPath, text, violations) {
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const urlMatches = line.match(/https?:\/\/[^\s'",}]+/g)
    if (!urlMatches) continue
    for (const url of urlMatches) {
      if (!url.startsWith('https://registry.npmjs.org/')) {
        violations.push(`${relPath}:${i + 1} [non-public lockfile registry URL] ${url}`)
      }
    }
  }
}

function scanTextFile(relPath, text, rules, violations) {
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    for (const rule of rules) {
      rule.regex.lastIndex = 0
      let match
      while ((match = rule.regex.exec(line)) !== null) {
        if (rule.filter && !rule.filter(match)) continue
        const preview = match[0].length > 48 ? `${match[0].slice(0, 24)}...` : match[0]
        violations.push(`${relPath}:${i + 1} [${rule.name}] ${preview}`)
        if (match[0].length === 0) break
      }
    }
  }
}

function main() {
  const files = collectCandidateFiles()
  const localRules = loadLocalDenylist()
  const activeRules = [...CONTENT_RULES, ...localRules]
  const violations = []

  for (const relPath of files) {
    for (const rule of FORBIDDEN_FILE_PATTERNS) {
      if (rule.regex.test(relPath) && !(rule.allow && rule.allow.test(relPath))) {
        violations.push(`${relPath} [forbidden file: ${rule.name}]`)
      }
    }
    if (SKIP_CONTENT_FILES.has(relPath)) continue

    const absPath = resolve(repoRoot, relPath)
    if (!existsSync(absPath) || !statSync(absPath).isFile()) continue
    const raw = readFileSync(absPath)
    if (raw.subarray(0, 8192).includes(0)) continue
    const text = raw.toString('utf8')

    if (basename(relPath) === 'pnpm-lock.yaml') {
      checkLockfile(relPath, text, violations)
      continue
    }
    scanTextFile(relPath, text, activeRules, violations)
  }

  if (violations.length > 0) {
    console.error(`Privacy check failed with ${violations.length} finding(s):`)
    for (const item of violations) {
      console.error(`  - ${item}`)
    }
    process.exit(1)
  }

  const localHint = localRules.length > 0 ? ` (+${localRules.length} local denylist rule(s))` : ''
  console.log(`Privacy check passed (${files.length} files scanned${localHint}).`)
}

main()
