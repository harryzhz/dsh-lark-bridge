#!/usr/bin/env node
/**
 * Self-contained bundle builder for root `dsh-lark-bridge` (Host + Web/Desktop Client + CLI).
 * Can run with ONLY root `devDependencies` (`esbuild`) during Git installs (`prepare`)
 * or full workspace builds (`build:bundles`).
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = resolve(repoRoot, 'dist')
const bridgeEntry = resolve(repoRoot, 'packages/dsh-lark-bridge/src/index.ts')
const uiClientEntry = resolve(repoRoot, 'packages/dsh-lark-ui/src/client.tsx')
const larkCoreEntry = resolve(repoRoot, 'packages/lark-core/src/index.ts')
const cliSource = resolve(repoRoot, 'packages/dsh-bundle/bin/lark-bridge.mjs')

const hostOut = resolve(distDir, 'index.js')
const clientOut = resolve(distDir, 'client.js')
const cliOut = resolve(distDir, 'lark-bridge.mjs')

export async function buildLarkBridgeRootBundle() {
  if (!existsSync(bridgeEntry) || !existsSync(uiClientEntry)) {
    if (existsSync(hostOut) && existsSync(clientOut)) {
      return
    }
    throw new Error(`Cannot locate dsh-lark-bridge source entries under ${repoRoot}`)
  }

  mkdirSync(distDir, { recursive: true })

  // 1. Bundle Host plugin (`@dsh-lark/dsh-lark-bridge` + `@dsh-lark/lark-core`)
  await build({
    entryPoints: [bridgeEntry],
    outfile: hostOut,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node22'],
    sourcemap: false,
    plugins: [
      {
        name: 'lark-core-source-alias',
        setup(buildApi) {
          buildApi.onResolve({ filter: /^@dsh-lark\/lark-core$/ }, () => ({
            path: larkCoreEntry,
          }))
        },
      },
    ],
    external: [
      'node:*',
      '@deepseek-ai/*',
      '@larksuiteoapi/node-sdk',
      'qrcode-terminal',
      'zod',
    ],
  })

  // 2. Bundle Client UI for DSH `window.__ModuleLoader__` (matching package name `dsh-lark-bridge`)
  const clientResult = await build({
    entryPoints: [uiClientEntry],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: ['es2022'],
    jsx: 'automatic',
    external: [
      'react',
      'react/jsx-runtime',
      'react-dom',
      'react-dom/client',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-ui-primitives',
      'zod',
    ],
  })

  const bundledCode = clientResult.outputFiles[0]?.text ?? ''
  const wrapped = `window.__ModuleLoader__.load({
  id: 'dsh-lark-bridge',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
${bundledCode}
    return module.exports;
  },
});
`
  writeFileSync(clientOut, wrapped, 'utf8')

  // 3. Copy standalone `lark-bridge` CLI next to `dist/index.js`
  if (existsSync(cliSource)) {
    copyFileSync(cliSource, cliOut)
    if (process.platform !== 'win32') {
      chmodSync(cliOut, 0o755)
    }
  }

  console.log('Built standalone bundle dsh-lark-bridge:', distDir)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildLarkBridgeRootBundle()
}
