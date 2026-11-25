import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error ESM release script outside tsconfig root
import {
  applyVersionToPackages,
  computeReleasePlan,
  isShippablePath,
} from '../../../scripts/release-plan.mjs'

describe('release-plan auto-release logic', () => {
  it('classifies shippable plugin files vs docs/CI/test-only files', () => {
    expect(isShippablePath('packages/dsh-lark-ui/src/views/MemoryView.tsx')).toBe(true)
    expect(isShippablePath('packages/dsh-lark-bridge/src/index.ts')).toBe(true)
    expect(isShippablePath('skills/lark-bridge/SKILL.md')).toBe(true)
    expect(isShippablePath('package.json')).toBe(true)
    expect(isShippablePath('cordis.patch.yml')).toBe(true)
    expect(isShippablePath('scripts/prepare-root.mjs')).toBe(true)

    expect(isShippablePath('docs/guidelines/ui.md')).toBe(false)
    expect(isShippablePath('.github/workflows/release.yml')).toBe(false)
    expect(isShippablePath('scripts/release-plan.mjs')).toBe(false)
    expect(isShippablePath('packages/dsh-lark-ui/tests/memory-view.spec.ts')).toBe(false)
  })

  it('auto-bumps patch on main merge when shippable files changed since last tag', () => {
    const plan = computeReleasePlan({
      eventName: 'push',
      ref: 'refs/heads/main',
      headSubject: 'feat(ui): redesign Memory Library (#52)',
      headTags: [],
      existingTags: ['v0.3.6', 'v0.4.0'],
      pkgVersion: '0.4.0',
      changedFiles: ['packages/dsh-lark-ui/src/views/MemoryView.tsx', 'docs/guidelines/ui.md'],
      commitMessages: ['feat(ui): redesign Memory Library (#52)'],
    })
    expect(plan).toEqual({
      shouldRelease: true,
      mode: 'auto',
      version: '0.4.1',
      tag: 'v0.4.1',
      prevTag: 'v0.4.0',
      reason: 'auto_main_merge',
    })
  })

  it('supports explicit [minor] and [major] / BREAKING CHANGE overrides', () => {
    expect(
      computeReleasePlan({
        eventName: 'push',
        ref: 'refs/heads/main',
        headSubject: 'feat(ui): milestone [minor]',
        existingTags: ['v0.4.2'],
        pkgVersion: '0.4.2',
        changedFiles: ['packages/dsh-lark-bridge/src/index.ts'],
        commitMessages: ['feat(ui): milestone [minor]'],
      }).tag,
    ).toBe('v0.5.0')

    expect(
      computeReleasePlan({
        eventName: 'push',
        ref: 'refs/heads/main',
        headSubject: 'feat!: drop legacy format',
        existingTags: ['v0.4.2'],
        pkgVersion: '0.4.2',
        changedFiles: ['packages/dsh-lark-bridge/src/index.ts'],
        commitMessages: ['feat!: drop legacy format\n\nBREAKING CHANGE: removed v1 schema'],
      }).tag,
    ).toBe('v1.0.0')
  })

  it('prevents loops on release commits, already-tagged HEAD, [skip release], and docs-only pushes', () => {
    expect(
      computeReleasePlan({
        eventName: 'push',
        ref: 'refs/heads/main',
        headSubject: 'chore(release): v0.4.1 [skip ci]',
        existingTags: ['v0.4.0'],
        pkgVersion: '0.4.1',
        changedFiles: ['package.json'],
      }).shouldRelease,
    ).toBe(false)

    expect(
      computeReleasePlan({
        eventName: 'push',
        ref: 'refs/heads/main',
        headSubject: 'fix(ui): tweak padding [skip release]',
        existingTags: ['v0.4.0'],
        pkgVersion: '0.4.0',
        changedFiles: ['packages/dsh-lark-ui/src/styles.ts'],
      }).shouldRelease,
    ).toBe(false)

    expect(
      computeReleasePlan({
        eventName: 'push',
        ref: 'refs/heads/main',
        headSubject: 'feat(ui): already tagged',
        headTags: ['v0.4.1'],
        existingTags: ['v0.4.1'],
        pkgVersion: '0.4.1',
        changedFiles: ['packages/dsh-lark-ui/src/styles.ts'],
      }).shouldRelease,
    ).toBe(false)

    expect(
      computeReleasePlan({
        eventName: 'push',
        ref: 'refs/heads/main',
        headSubject: 'docs: clarify development guide',
        existingTags: ['v0.4.0'],
        pkgVersion: '0.4.0',
        changedFiles: ['docs/guidelines/development.md', '.github/workflows/ci.yml'],
      }),
    ).toEqual({ shouldRelease: false, mode: 'none', reason: 'no_shippable_changes' })
  })

  it('supports manual tag push and workflow_dispatch bump levels', () => {
    expect(
      computeReleasePlan({
        eventName: 'push',
        ref: 'refs/tags/v0.5.0',
        existingTags: ['v0.4.0', 'v0.5.0'],
        pkgVersion: '0.5.0',
      }),
    ).toEqual({
      shouldRelease: true,
      mode: 'tag',
      version: '0.5.0',
      tag: 'v0.5.0',
      prevTag: 'v0.5.0',
      reason: 'manual_tag',
    })

    expect(
      computeReleasePlan({
        eventName: 'workflow_dispatch',
        ref: 'refs/heads/main',
        manualBump: 'minor',
        existingTags: ['v0.4.3'],
        pkgVersion: '0.4.1',
      }),
    ).toEqual({
      shouldRelease: true,
      mode: 'auto',
      version: '0.5.0',
      tag: 'v0.5.0',
      prevTag: 'v0.4.3',
      reason: 'manual_dispatch',
    })
  })

  it('updates version across root and workspace package.json files cleanly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-plan-test-'))
    try {
      mkdirSync(join(dir, 'packages', 'a'), { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', version: '0.4.0' }, null, 2) + '\n')
      writeFileSync(
        join(dir, 'packages', 'a', 'package.json'),
        JSON.stringify({ name: 'pkg-a', version: '0.2.0' }, null, 2) + '\n',
      )
      const updated = applyVersionToPackages(dir, '0.4.1', ['package.json', 'packages/a/package.json'])
      expect(updated).toEqual(['package.json', 'packages/a/package.json'])
      expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version).toBe('0.4.1')
      expect(JSON.parse(readFileSync(join(dir, 'packages', 'a', 'package.json'), 'utf8')).version).toBe('0.4.1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
