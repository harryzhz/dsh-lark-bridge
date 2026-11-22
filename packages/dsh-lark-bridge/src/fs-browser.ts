import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, parse, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { expandWorkingDir } from '@dsh-lark/lark-core'

export interface DirectoryCrumb {
  readonly name: string
  readonly path: string
  readonly hidden: boolean
}

export interface DirectoryBrowseResult {
  readonly path: string
  readonly home: string
  readonly crumbs: readonly DirectoryCrumb[]
  readonly entries: readonly DirectoryCrumb[]
  readonly truncated: boolean
}

interface HostDirectoryPickerLike {
  capability?: () =>
    | {
        readonly kind: 'browse'
        list(path?: string): Promise<DirectoryBrowseResult>
        createDirectory(path: string, name: string): Promise<string>
      }
    | { readonly kind: string }
}

const MAX_DIR_ENTRIES = 500

/**
 * Validates that a configured working directory exists on disk and is a directory,
 * returning the expanded absolute path. Prevents saving invalid paths that later
 * fail child-process `spawn(..., { cwd })` with ENOENT/ENOTDIR.
 */
export function assertExistingWorkingDirectory(rawPath: string, label = '工作目录'): string {
  const trimmed = rawPath.trim()
  if (!trimmed) {
    throw new Error(`${label}不能为空`)
  }
  const expanded = expandWorkingDir(trimmed)
  if (!expanded || !existsSync(expanded)) {
    throw new Error(`${label}不存在：${expanded || trimmed}`)
  }
  let isDir = false
  try {
    isDir = statSync(expanded).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) {
    throw new Error(`${label}路径不是文件夹：${expanded}`)
  }
  return expanded
}

function buildBreadcrumbs(targetPath: string): DirectoryCrumb[] {
  const normalized = resolve(targetPath)
  const parsed = parse(normalized)
  const crumbs: DirectoryCrumb[] = []
  const stack: string[] = []
  let cur = normalized
  while (cur !== parsed.root) {
    stack.unshift(cur)
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  crumbs.push({ name: parsed.root || '/', path: parsed.root || '/', hidden: false })
  for (const segmentPath of stack) {
    crumbs.push({ name: basename(segmentPath), path: segmentPath, hidden: false })
  }
  return crumbs
}

function resolveInitialBrowsePath(rawPath?: string): string {
  const home = homedir()
  const trimmed = rawPath?.trim()
  if (!trimmed) return home
  const expanded = expandWorkingDir(trimmed)
  if (!expanded) return home
  let candidate = resolve(expanded)
  // Walk up if user had typed a not-yet-created subdirectory path
  while (!existsSync(candidate)) {
    const parent = dirname(candidate)
    if (parent === candidate) return home
    candidate = parent
  }
  try {
    if (statSync(candidate).isDirectory()) return candidate
    const parent = dirname(candidate)
    return statSync(parent).isDirectory() ? parent : home
  } catch {
    return home
  }
}

export async function browseHostDirectories(
  ctx: Context,
  rawPath?: string,
): Promise<DirectoryBrowseResult> {
  const targetPath = resolveInitialBrowsePath(rawPath)
  const hostPicker = ctx.get('directoryPicker' as never) as HostDirectoryPickerLike | undefined
  const cap = hostPicker?.capability?.()
  if (cap && cap.kind === 'browse' && 'list' in cap && typeof cap.list === 'function') {
    try {
      return await cap.list(targetPath)
    } catch {
      // Fall back to direct POSIX listing below.
    }
  }

  const home = homedir()
  const dirents = readdirSync(targetPath, { withFileTypes: true })
  const dirs: DirectoryCrumb[] = []
  for (const d of dirents) {
    const fullPath = join(targetPath, d.name)
    let isDir = d.isDirectory()
    if (!isDir && d.isSymbolicLink()) {
      try {
        isDir = statSync(fullPath).isDirectory()
      } catch {
        isDir = false
      }
    }
    if (!isDir) continue
    dirs.push({
      name: d.name,
      path: fullPath,
      hidden: d.name.startsWith('.'),
    })
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  const truncated = dirs.length > MAX_DIR_ENTRIES
  const entries = truncated ? dirs.slice(0, MAX_DIR_ENTRIES) : dirs

  return {
    path: targetPath,
    home,
    crumbs: buildBreadcrumbs(targetPath),
    entries,
    truncated,
  }
}

export async function createHostSubdirectory(
  ctx: Context,
  rawParentPath: string,
  rawName: string,
): Promise<string> {
  const name = rawName.trim()
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
    throw new Error('文件夹名称无效（不能包含路径分隔符）')
  }
  const parentPath = expandWorkingDir(rawParentPath.trim())
  if (!parentPath || !existsSync(parentPath) || !statSync(parentPath).isDirectory()) {
    throw new Error('上级目录不存在')
  }

  const hostPicker = ctx.get('directoryPicker' as never) as HostDirectoryPickerLike | undefined
  const cap = hostPicker?.capability?.()
  if (cap && cap.kind === 'browse' && 'createDirectory' in cap && typeof cap.createDirectory === 'function') {
    return cap.createDirectory(resolve(parentPath), name)
  }

  const target = join(resolve(parentPath), name)
  if (existsSync(target)) {
    throw new Error(`目录「${name}」已存在`)
  }
  mkdirSync(target, { recursive: false })
  return target
}
