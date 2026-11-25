import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const stub = () => null
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === '__esModule') return true
        if (prop === 'then' || typeof prop === 'symbol') return undefined
        return stub
      },
      has: (_target, prop) => typeof prop === 'string' && prop !== 'then',
      getOwnPropertyDescriptor: (_target, prop) =>
        typeof prop === 'string' && prop !== 'then'
          ? { configurable: true, enumerable: true, value: stub }
          : undefined,
    },
  )
})

import { filterDirectoryEntries } from '../src/components/DirectoryPickerModal.js'
import { ensureLarkUiStyles } from '../src/styles.js'
import type { DirectoryCrumb } from '../src/types.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

const SAMPLE_ENTRIES: readonly DirectoryCrumb[] = [
  { name: '.git', path: '/Users/demo/.git', hidden: true },
  { name: '.config', path: '/Users/demo/.config', hidden: true },
  { name: 'Applications', path: '/Users/demo/Applications', hidden: false },
  { name: 'data-analysis', path: '/Users/demo/data-analysis', hidden: false },
  { name: 'DataGripProjects', path: '/Users/demo/DataGripProjects', hidden: false },
]

describe('DirectoryPickerPanel filtering & layout styles', () => {
  it('hides dot directories by default and reveals them when showHidden is enabled', () => {
    expect(
      filterDirectoryEntries(SAMPLE_ENTRIES, { showHidden: false, query: '' }).map((e) => e.name),
    ).toEqual(['Applications', 'data-analysis', 'DataGripProjects'])

    expect(
      filterDirectoryEntries(SAMPLE_ENTRIES, { showHidden: true, query: '' }).map((e) => e.name),
    ).toEqual(['.git', '.config', 'Applications', 'data-analysis', 'DataGripProjects'])
  })

  it('filters directory names case-insensitively with trimmed query across visible entries', () => {
    expect(
      filterDirectoryEntries(SAMPLE_ENTRIES, { showHidden: false, query: '  DATA ' }).map(
        (e) => e.name,
      ),
    ).toEqual(['data-analysis', 'DataGripProjects'])

    expect(
      filterDirectoryEntries(SAMPLE_ENTRIES, { showHidden: false, query: '.git' }),
    ).toEqual([])

    expect(
      filterDirectoryEntries(SAMPLE_ENTRIES, { showHidden: true, query: 'GIT' }).map((e) => e.name),
    ).toEqual(['.git'])
  })

  it('injects full-width search bar, optical toolbar alignment, and single-column subview styles', () => {
    const appended: Array<{ id?: string; textContent?: string }> = []
    vi.stubGlobal('document', {
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '' }),
      head: {
        appendChild: (node: { id?: string; textContent?: string }) => {
          appended.push(node)
          return node
        },
      },
    })

    ensureLarkUiStyles()
    expect(appended).toHaveLength(1)
    const css = appended[0].textContent ?? ''

    // Full-width search input prevents inline-flex collapse and placeholder truncation.
    expect(css).toContain('.fb-dir-search .fb-search,')
    expect(css).toContain('.fb-picker .fb-search {')
    expect(css).toContain('width: 100%;')
    // Single-column in-place subview spans full ConfigDialog grid without modal stacking.
    expect(css).toContain('.fb-dialog-subview-single {')
    expect(css).toContain('grid-column: 1 / -1;')
    expect(css).toContain('grid-row: 1 / -1;')
    // Single-line path truncation and optical left alignment for ghost toolbar action.
    expect(css).toContain('.fb-dir-path {')
    expect(css).toContain('white-space: nowrap;')
    expect(css).toContain('.fb-dir-toolbar-left > button:first-child {')
  })
})
