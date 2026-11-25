#!/usr/bin/env node
/**
 * Release planner & version bumper for `@harryzhz/dsh-lark-bridge`.
 *
 * Usage:
 *   node scripts/release-plan.mjs --event push --ref refs/heads/main [--bump patch] [--github-output "$GITHUB_OUTPUT"]
 *   node scripts/release-plan.mjs --apply 0.4.1
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const VERSIONED_PACKAGE_PATHS = [
  'package.json',
  'packages/dsh-lark-bridge/package.json',
  'packages/dsh-lark-ui/package.json',
  'packages/dsh-bundle/package.json',
  'packages/lark-core/package.json',
]

const SHIPPABLE_EXACT = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'cordis.patch.yml',
  'icon.svg',
  'scripts/prepare-root.mjs',
  'scripts/pack-bundle.mjs',
])

const SHIPPABLE_PREFIXES = ['packages/', 'skills/', 'locale/']

export function parseSemver(raw) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(raw ?? '').trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

export function formatSemver(v) {
  return `${v.major}.${v.minor}.${v.patch}`
}

export function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  return a.patch - b.patch
}

export function bumpSemver(v, level) {
  if (level === 'major') return { major: v.major + 1, minor: 0, patch: 0 }
  if (level === 'minor') return { major: v.major, minor: v.minor + 1, patch: 0 }
  return { major: v.major, minor: v.minor, patch: v.patch + 1 }
}

export function findHighestSemverTag(tags) {
  let bestTag = null
  let bestVer = null
  for (const tag of tags) {
    const parsed = parseSemver(tag)
    if (!parsed) continue
    if (!bestVer || compareSemver(parsed, bestVer) > 0) {
      bestVer = parsed
      bestTag = tag
    }
  }
  return bestTag ? { tag: bestTag, version: bestVer } : null
}

export function isShippablePath(filePath) {
  const clean = String(filePath ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
  if (!clean) return false
  if (SHIPPABLE_EXACT.has(clean)) return true
  if (!SHIPPABLE_PREFIXES.some((p) => clean.startsWith(p))) return false
  if (/(^|\/)tests\//.test(clean) || /\.spec\.(?:ts|tsx|js|mjs|cjs)$/.test(clean)) {
    return false
  }
  return true
}

export function detectBumpLevel(commitMessages) {
  for (const msg of commitMessages) {
    if (/\[major\]/i.test(msg) || /\bBREAKING CHANGE:/i.test(msg)) return 'major'
  }
  for (const msg of commitMessages) {
    if (/\[minor\]/i.test(msg)) return 'minor'
  }
  return 'patch'
}

export function computeReleasePlan(ctx) {
  const {
    eventName,
    ref,
    manualBump = '',
    headSubject = '',
    headTags = [],
    existingTags = [],
    pkgVersion = '0.0.0',
    changedFiles = [],
    commitMessages = [],
  } = ctx

  const highest = findHighestSemverTag(existingTags)
  const pkgVer = parseSemver(pkgVersion) ?? { major: 0, minor: 0, patch: 0 }
  const baseVer =
    highest && compareSemver(highest.version, pkgVer) > 0 ? highest.version : pkgVer

  if (eventName === 'push' && ref.startsWith('refs/tags/v')) {
    const tag = ref.slice('refs/tags/'.length)
    const parsed = parseSemver(tag)
    if (!parsed) {
      return { shouldRelease: false, mode: 'none', reason: 'invalid_tag_semver' }
    }
    return {
      shouldRelease: true,
      mode: 'tag',
      version: formatSemver(parsed),
      tag,
      prevTag: highest?.tag ?? '',
      reason: 'manual_tag',
    }
  }

  if (eventName === 'workflow_dispatch') {
    const bump = ['patch', 'minor', 'major'].includes(manualBump) ? manualBump : 'patch'
    const next = formatSemver(bumpSemver(baseVer, bump))
    return {
      shouldRelease: true,
      mode: 'auto',
      version: next,
      tag: `v${next}`,
      prevTag: highest?.tag ?? '',
      reason: 'manual_dispatch',
    }
  }

  if (eventName === 'push' && ref === 'refs/heads/main') {
    if (
      /^chore\(release\):\s*v\d+\.\d+\.\d+/i.test(headSubject.trim()) ||
      /\[skip release\]/i.test(headSubject)
    ) {
      return { shouldRelease: false, mode: 'none', reason: 'release_commit_or_skipped' }
    }
    if (headTags.some((t) => parseSemver(t) !== null)) {
      return { shouldRelease: false, mode: 'none', reason: 'already_tagged' }
    }
    if (highest && !changedFiles.some((f) => isShippablePath(f))) {
      return { shouldRelease: false, mode: 'none', reason: 'no_shippable_changes' }
    }
    const next =
      highest && compareSemver(pkgVer, highest.version) > 0
        ? formatSemver(pkgVer)
        : formatSemver(bumpSemver(baseVer, detectBumpLevel(commitMessages)))
    return {
      shouldRelease: true,
      mode: 'auto',
      version: next,
      tag: `v${next}`,
      prevTag: highest?.tag ?? '',
      reason: 'auto_main_merge',
    }
  }

  return { shouldRelease: false, mode: 'none', reason: 'unsupported_event' }
}

export function applyVersionToPackages(repoRoot, version, packagePaths = VERSIONED_PACKAGE_PATHS) {
  if (!parseSemver(version)) {
    throw new Error(`Invalid SemVer version: ${version}`)
  }
  const updated = []
  for (const rel of packagePaths) {
    const full = resolve(repoRoot, rel)
    if (!existsSync(full)) continue
    const raw = readFileSync(full, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed.version === version) continue
    parsed.version = version
    writeFileSync(full, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
    updated.push(rel)
  }
  return updated
}

function runGit(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}

function parseArg(argv, flag) {
  const idx = argv.indexOf(flag)
  return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : ''
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const argv = process.argv.slice(2)

  const applyVersion = parseArg(argv, '--apply')
  if (applyVersion) {
    const updated = applyVersionToPackages(repoRoot, applyVersion)
    console.log(JSON.stringify({ version: applyVersion, updated }))
    return
  }

  const eventName = parseArg(argv, '--event') || process.env.GITHUB_EVENT_NAME || 'push'
  const ref = parseArg(argv, '--ref') || process.env.GITHUB_REF || 'refs/heads/main'
  const manualBump = parseArg(argv, '--bump')
  const ghOutput = parseArg(argv, '--github-output')

  const rootPkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))
  const existingTags = runGit(repoRoot, ['tag', '--list', 'v*'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  const headTags = runGit(repoRoot, ['tag', '--points-at', 'HEAD', 'v*'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  const headSubject = runGit(repoRoot, ['log', '-1', '--pretty=%s'])
  const highest = findHighestSemverTag(existingTags)
  const range = highest ? `${highest.tag}..HEAD` : 'HEAD'
  const changedFiles = highest
    ? runGit(repoRoot, ['diff', '--name-only', range])
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    : ['package.json']
  const commitMessages = runGit(repoRoot, ['log', range, '--pretty=%s%n%b---END---'])
    .split('---END---')
    .map((s) => s.trim())
    .filter(Boolean)

  const plan = computeReleasePlan({
    eventName,
    ref,
    manualBump,
    headSubject,
    headTags,
    existingTags,
    pkgVersion: rootPkg.version,
    changedFiles,
    commitMessages,
  })

  console.log(JSON.stringify(plan, null, 2))
  if (ghOutput) {
    const lines = [
      `should_release=${plan.shouldRelease ? 'true' : 'false'}`,
      `mode=${plan.mode ?? 'none'}`,
      `version=${plan.version ?? ''}`,
      `tag=${plan.tag ?? ''}`,
      `prev_tag=${plan.prevTag ?? ''}`,
      `reason=${plan.reason ?? ''}`,
    ]
    appendFileSync(ghOutput, `${lines.join('\n')}\n`, 'utf8')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
