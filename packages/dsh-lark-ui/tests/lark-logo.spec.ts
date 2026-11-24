import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LarkSidebarIcon, LarkTitleIcon } from '../src/components/LarkLogo.js'
import { ensureLarkUiStyles } from '../src/styles.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Hex Terminal Core plugin & UI icons', () => {
  it('defines plugin icon.svg with the group avatar Hex Terminal Core palette and mask-free geometry', () => {
    const iconSvg = readFileSync(resolve(import.meta.dirname, '../../../icon.svg'), 'utf8')
    expect(iconSvg).toContain('viewBox="0 0 64 64"')
    expect(iconSvg).toContain('fill="#F6F2EA"')
    expect(iconSvg).toContain('fill="#141518"')
    expect(iconSvg).toContain('fill="#D96B43"')
    // Pure vector paths avoid <mask> ID collisions across embedded or scaled contexts.
    expect(iconSvg).not.toContain('<mask')
  })

  it('renders LarkSidebarIcon as monochrome currentColor split-hex geometry without hardcoded colors', () => {
    const svg = LarkSidebarIcon({ size: 16 }) as ReactElement<{
      width: number
      height: number
      viewBox: string
      children: ReactElement<{ d: string; fill: string }>[]
    }>
    expect(svg.type).toBe('svg')
    expect(svg.props.width).toBe(16)
    expect(svg.props.height).toBe(16)
    expect(svg.props.viewBox).toBe('0 0 24 24')

    const paths = svg.props.children
    expect(Array.isArray(paths)).toBe(true)
    expect(paths).toHaveLength(2)
    for (const p of paths) {
      expect(p.type).toBe('path')
      expect(p.props.fill).toBe('currentColor')
    }
    // Outer ring consists of 3 distinct geometric subpaths (upper-left, lower-left, right bracket).
    expect(paths[0].props.d.match(/Z/g)?.length).toBe(3)
    // Center core is a closed hexagon subpath.
    expect(paths[1].props.d.match(/Z/g)?.length).toBe(1)
  })

  it('renders LarkTitleIcon wrapping LarkSidebarIcon with 3D flip wrapper classes', () => {
    const wrapper = LarkTitleIcon({ size: 24, className: 'extra' }) as ReactElement<{
      className: string
      'aria-hidden': string
      children: ReactElement<{
        className: string
        children: ReactElement<{ size: number }>
      }>
    }>
    expect(wrapper.type).toBe('span')
    expect(wrapper.props.className).toBe('fb-title-icon extra')
    expect(wrapper.props['aria-hidden']).toBe('true')

    const glyph = wrapper.props.children
    expect(glyph.type).toBe('span')
    expect(glyph.props.className).toBe('fb-title-icon-glyph')
    expect(glyph.props.children.type).toBe(LarkSidebarIcon)
    expect(glyph.props.children.props.size).toBe(24)
  })

  it('injects Y-axis flip-and-restore keyframes and reduced-motion override for the title icon', () => {
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
    expect(css).toContain('.fb-title-icon {')
    expect(css).toContain('.fb-title-icon-glyph {')
    expect(css).toContain('@keyframes fb-title-icon-flip')
    expect(css).toContain('rotateY(180deg)')
    expect(css).toContain('rotateY(0deg)')
    expect(css).toContain('.fb-title-icon-glyph { animation: none; }')
  })
})
