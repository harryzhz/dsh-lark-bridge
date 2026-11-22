#!/usr/bin/env node
/**
 * Build and pack `@harryzhz/dsh-lark-bridge` into a `.tgz` release tarball.
 * Usage: node scripts/pack-bundle.mjs [--out-dir .local/releases]
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildLarkBridgeRootBundle } from './prepare-root.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rootPackageName = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')).name
const outIdx = process.argv.indexOf('--out-dir')
const outDir = resolve(repoRoot, outIdx >= 0 && process.argv[outIdx + 1] ? process.argv[outIdx + 1] : '.local/releases')

mkdirSync(outDir, { recursive: true })
await buildLarkBridgeRootBundle()

console.log(`\nPacking ${rootPackageName} -> ${outDir}`)
execFileSync('pnpm', ['pack', '--pack-destination', outDir], {
  cwd: repoRoot,
  stdio: 'inherit',
})
