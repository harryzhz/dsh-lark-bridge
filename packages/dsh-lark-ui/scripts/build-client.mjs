import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = resolve(pkgRoot, 'dist')
mkdirSync(distDir, { recursive: true })

// 1. Minimal host stub so Cordis Loader mounts cleanly on host side.
writeFileSync(
  resolve(distDir, 'index.js'),
  `export const name = 'dsh-lark-ui'\nexport function apply() {}\n`,
  'utf8',
)

// 2. Build browser bundle in DSH window.__ModuleLoader__ format.
const result = await build({
  entryPoints: [resolve(pkgRoot, 'src/client.tsx')],
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

const bundledCode = result.outputFiles[0]?.text ?? ''
const wrapped = `window.__ModuleLoader__.load({
  id: '@dsh-lark/dsh-lark-ui',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
${bundledCode}
    return module.exports;
  },
});
`
writeFileSync(resolve(distDir, 'client.js'), wrapped, 'utf8')
console.log('Built @dsh-lark/dsh-lark-ui client bundle:', resolve(distDir, 'client.js'))
