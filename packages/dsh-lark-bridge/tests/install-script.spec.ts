import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const installShPath = join(repoRoot, 'scripts/install.sh')
const installPs1Path = join(repoRoot, 'scripts/install.ps1')

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writeExecutable(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o755 })
  chmodSync(filePath, 0o755)
}

/**
 * Creates a mock `dsh` binary that records every invocation to `logFile`
 * and simulates `dsh plugin --profile <name> add <urls...>` by writing
 * `package.json` + `node_modules/@harryzhz/.../package.json` inside `$DSH_HOME`.
 */
function createMockDsh(binPath: string, version: string, logFile: string): void {
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const logFile = ${JSON.stringify(logFile)};
fs.appendFileSync(logFile, JSON.stringify({ bin: process.argv[1], dshHome: process.env.DSH_HOME, args }) + '\\n');

if (args[0] === '--version' || args[0] === '-V') {
  console.log(${JSON.stringify(version)});
  process.exit(0);
}

if (args[0] === 'plugin') {
  let profile = 'web';
  let idx = 1;
  if (args[idx] === '--profile') {
    profile = args[idx + 1];
    idx += 2;
  }
  const verb = args[idx];
  const specs = args.slice(idx + 1);
  if (verb === 'add') {
    const profileDir = path.join(process.env.DSH_HOME, 'profiles', profile);
    fs.mkdirSync(profileDir, { recursive: true });
    const pkgJsonPath = path.join(profileDir, 'package.json');
    let pkg = {
      name: 'dsh-profile-' + profile,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    };
    if (fs.existsSync(pkgJsonPath)) {
      pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    }
    pkg.dependencies = pkg.dependencies || {};
    pkg.dsh = pkg.dsh || {};
    pkg.dsh.profile = pkg.dsh.profile || {};
    pkg.dsh.profile.bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];

    for (const spec of specs) {
      let name = '';
      let ver = '0.4.16';
      if (spec.includes('dsh-external-agents')) {
        name = '@harryzhz/dsh-external-agents';
        const m = spec.match(/(\\d+\\.\\d+\\.\\d+)\\.tgz/);
        ver = m ? m[1] : '0.4.3';
      } else if (spec.includes('dsh-lark-bridge')) {
        name = '@harryzhz/dsh-lark-bridge';
        const m = spec.match(/(\\d+\\.\\d+\\.\\d+)\\.tgz/);
        ver = m ? m[1] : '0.4.16';
      }
      if (!name) continue;
      pkg.dependencies[name] = spec;
      if (!pkg.dsh.profile.bundles.includes(name)) {
        pkg.dsh.profile.bundles.push(name);
      }
      const modDir = path.join(profileDir, 'node_modules', ...name.split('/'));
      fs.mkdirSync(modDir, { recursive: true });
      fs.writeFileSync(path.join(modDir, 'package.json'), JSON.stringify({ name, version: ver }, null, 2));
    }
    fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2));
    process.exit(0);
  }
}
process.exit(0);
`
  writeExecutable(binPath, script)
}

function createBaseSandbox(options?: {
  unameS?: string
  unameM?: string
  nodeVer?: string
  pnpmVer?: string
  dshVer?: string
  appVer?: string
  initDesktopProfile?: boolean
}) {
  const root = makeTempDir('dsh-install-test-')
  const fakeHome = join(root, 'home')
  const dshHome = join(root, 'dsh-home')
  const binDir = join(root, 'bin')
  const toolBinDir = join(root, 'tools-bin')
  const logFile = join(root, 'dsh-calls.jsonl')

  mkdirSync(fakeHome, { recursive: true })
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(binDir, { recursive: true })
  mkdirSync(toolBinDir, { recursive: true })

  // Mock uname when cross-platform branch testing is requested
  if (options?.unameS || options?.unameM) {
    const s = options.unameS ?? 'Darwin'
    const m = options.unameM ?? 'arm64'
    writeExecutable(
      join(toolBinDir, 'uname'),
      `#!/bin/sh
if [ "$1" = "-s" ]; then echo "${s}"; exit 0; fi
if [ "$1" = "-m" ]; then echo "${m}"; exit 0; fi
echo "${s}"
`,
    )
  }

  // Mock pgrep so Desktop app tests never interact with host processes
  writeExecutable(join(toolBinDir, 'pgrep'), '#!/bin/sh\nexit 1\n')

  if (options?.pnpmVer !== undefined) {
    writeExecutable(
      join(toolBinDir, 'pnpm'),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${options.pnpmVer}"; exit 0; fi\nexit 0\n`,
    )
  }

  if (options?.dshVer) {
    createMockDsh(join(binDir, 'dsh'), options.dshVer, logFile)
  }

  let appPath = ''
  if (options?.appVer) {
    appPath = join(root, 'Apps', 'DeepSeek Harness.app')
    const appCli = join(appPath, 'Contents/Resources/runtime/cli/bin/dsh')
    createMockDsh(appCli, options.appVer, logFile)
    if (options.initDesktopProfile !== false) {
      const deskDir = join(dshHome, 'profiles/desktop')
      mkdirSync(deskDir, { recursive: true })
      writeFileSync(
        join(deskDir, 'package.json'),
        JSON.stringify(
          {
            name: 'dsh-profile-desktop',
            private: true,
            dependencies: {},
            dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
          },
          null,
          2,
        ),
      )
    }
  }

  const nodeDir = dirname(process.execPath)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fakeHome,
    DSH_HOME: dshHome,
    DSH_CLI_HOME: join(root, 'dsh-cli'),
    DSH_BIN_DIR: binDir,
    DSH_DESKTOP_APP: appPath,
    NO_COLOR: '1',
    PATH: `${toolBinDir}:${binDir}:${nodeDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
  }

  return { root, fakeHome, dshHome, binDir, logFile, appPath, env }
}

function readCalls(logFile: string): Array<{ bin: string; dshHome: string; args: string[] }> {
  if (!existsSync(logFile)) return []
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { bin: string; dshHome: string; args: string[] })
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('one-click install scripts (install.sh & install.ps1)', () => {
  it('install.sh passes bash -n syntax check and avoids Bash 4+ constructs', () => {
    const res = spawnSync('bash', ['-n', installShPath], { encoding: 'utf8' })
    expect(res.status).toBe(0)
    expect(res.stderr).toBe('')

    const sh = readFileSync(installShPath, 'utf8')
    expect(sh).not.toMatch(/\bdeclare\s+-[aAn]\b/)
    expect(sh).not.toMatch(/\bmapfile\b|\breadarray\b/)
  })

  it('install.sh and install.ps1 keep version bounds, package names, and download URLs in sync', () => {
    const sh = readFileSync(installShPath, 'utf8')
    const ps1 = readFileSync(installPs1Path, 'utf8')

    for (const token of [
      '22.13.0',
      '0.2.2-rc.5',
      '0.3.0',
      '@deepseek-ai/dsh',
      '@harryzhz/dsh-lark-bridge',
      '@harryzhz/dsh-external-agents',
      'harryzhz/dsh-lark-bridge',
      'harryzhz/dsh-external-agents',
      'harryzhz-dsh-lark-bridge-',
      'harryzhz-dsh-external-agents-',
      'dsh-lark-bridge.tgz',
      'dsh-external-agents.tgz',
    ]) {
      expect(sh).toContain(token)
      expect(ps1).toContain(token)
    }

    expect(sh).toContain('https://download.deepseek.com/desktop/dsh-latest-macos-arm64.dmg')
    expect(sh).toContain('https://download.deepseek.com/desktop/dsh-latest-macos-x64.dmg')
    expect(ps1).toContain('https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe')
    // Ensure top-level iex compatibility (no [CmdletBinding()] before param)
    expect(ps1).not.toContain('[CmdletBinding()]')
  })

  it('supports --help and rejects invalid --mode or desktop web profile', () => {
    const help = spawnSync('bash', [installShPath, '--help'], { encoding: 'utf8' })
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('--mode <auto|web|app|both>')
    expect(help.stdout).toContain('--without-external-agents')

    const badMode = spawnSync('bash', [installShPath, '--mode', 'invalid'], { encoding: 'utf8' })
    expect(badMode.status).not.toBe(0)
    expect(badMode.stderr).toContain('无效的 --mode 值')

    const badProfile = spawnSync('bash', [installShPath, '--profile', 'desktop'], { encoding: 'utf8' })
    expect(badProfile.status).not.toBe(0)
    expect(badProfile.stderr).toContain('desktop')
  })

  it('enforces SemVer 2.0.0 prerelease comparisons accurately', () => {
    const sh = readFileSync(installShPath, 'utf8')
    const harness = `${sh.replace(/\nmain "\$@"\s*$/, '\n')}
for pair in "0.2.2-rc.4:0.2.2-rc.5" "0.2.2-rc.5:0.2.2-rc.5" "0.2.2-rc.10:0.2.2-rc.5" "0.2.2:0.2.2-rc.5" "0.2.9:0.3.0" "0.3.0:0.3.0"; do
  a="\${pair%%:*}"
  b="\${pair##*:}"
  echo "\${a}|\${b}=$(semver_compare "$a" "$b")"
done
for v in "0.2.1-rc.4" "0.2.2-rc.4" "0.2.2-rc.5" "0.2.2-rc.10" "0.2.2" "0.2.9" "0.3.0-alpha.1" "0.3.0"; do
  if dsh_version_compatible "$v"; then echo "compat:$v=1"; else echo "compat:$v=0"; fi
done
`
    const out = execFileSync('bash', ['-c', harness], { encoding: 'utf8' })
    expect(out).toContain('0.2.2-rc.4|0.2.2-rc.5=-1')
    expect(out).toContain('0.2.2-rc.5|0.2.2-rc.5=0')
    expect(out).toContain('0.2.2-rc.10|0.2.2-rc.5=1')
    expect(out).toContain('0.2.2|0.2.2-rc.5=1')
    expect(out).toContain('0.2.9|0.3.0=-1')
    expect(out).toContain('0.3.0|0.3.0=0')

    expect(out).toContain('compat:0.2.1-rc.4=0')
    expect(out).toContain('compat:0.2.2-rc.4=0')
    expect(out).toContain('compat:0.2.2-rc.5=1')
    expect(out).toContain('compat:0.2.2-rc.10=1')
    expect(out).toContain('compat:0.2.2=1')
    expect(out).toContain('compat:0.2.9=1')
    expect(out).toContain('compat:0.3.0=0')
  })

  it('installs both plugins into web profile and skips cleanly on idempotent re-run', { timeout: 20_000 }, () => {
    const sb = createBaseSandbox({
      unameS: 'Linux',
      unameM: 'x86_64',
      pnpmVer: '10.12.0',
      dshVer: '0.2.2-rc.5',
    })

    const first = spawnSync(
      'bash',
      [
        installShPath,
        '--mode',
        'web',
        '--yes',
        '--bridge-version',
        '0.4.16',
        '--external-agents-version',
        '0.4.3',
      ],
      { env: sb.env, encoding: 'utf8' },
    )
    expect(first.status, first.stderr + first.stdout).toBe(0)

    const addCallsFirst = readCalls(sb.logFile).filter((c) => c.args[0] === 'plugin')
    expect(addCallsFirst).toHaveLength(1)
    expect(addCallsFirst[0]?.args).toEqual([
      'plugin',
      '--profile',
      'web',
      'add',
      'https://github.com/harryzhz/dsh-external-agents/releases/download/v0.4.3/harryzhz-dsh-external-agents-0.4.3.tgz',
      'https://github.com/harryzhz/dsh-lark-bridge/releases/download/v0.4.16/harryzhz-dsh-lark-bridge-0.4.16.tgz',
    ])

    // Re-run with identical target versions: should detect both up-to-date and skip plugin add
    const second = spawnSync(
      'bash',
      [
        installShPath,
        '--mode',
        'web',
        '--yes',
        '--bridge-version',
        '0.4.16',
        '--external-agents-version',
        '0.4.3',
      ],
      { env: sb.env, encoding: 'utf8' },
    )
    expect(second.status, second.stderr + second.stdout).toBe(0)
    expect(second.stdout).toContain('已是最新')
    const addCallsAfter = readCalls(sb.logFile).filter((c) => c.args[0] === 'plugin')
    expect(addCallsAfter).toHaveLength(1)

    // Upgrade bridge only: should only add bridge 0.4.17, skipping external-agents 0.4.3
    const upgrade = spawnSync(
      'bash',
      [
        installShPath,
        '--mode',
        'web',
        '--yes',
        '--bridge-version',
        '0.4.17',
        '--external-agents-version',
        '0.4.3',
      ],
      { env: sb.env, encoding: 'utf8' },
    )
    expect(upgrade.status, upgrade.stderr + upgrade.stdout).toBe(0)
    const addCallsUpgrade = readCalls(sb.logFile).filter((c) => c.args[0] === 'plugin')
    expect(addCallsUpgrade).toHaveLength(2)
    expect(addCallsUpgrade[1]?.args).toEqual([
      'plugin',
      '--profile',
      'web',
      'add',
      'https://github.com/harryzhz/dsh-lark-bridge/releases/download/v0.4.17/harryzhz-dsh-lark-bridge-0.4.17.tgz',
    ])
  })

  it('supports --without-external-agents, --github-proxy, and --dry-run', { timeout: 20_000 }, () => {
    const sb = createBaseSandbox({
      unameS: 'Linux',
      unameM: 'x86_64',
      pnpmVer: '10.12.0',
      dshVer: '0.2.2-rc.5',
    })

    const dry = spawnSync(
      'bash',
      [
        installShPath,
        '--mode',
        'web',
        '--yes',
        '--dry-run',
        '--without-external-agents',
        '--github-proxy',
        'https://mirror.example.com/',
        '--bridge-version',
        '0.4.16',
      ],
      { env: sb.env, encoding: 'utf8' },
    )
    expect(dry.status, dry.stderr + dry.stdout).toBe(0)
    expect(dry.stdout).toContain('[DRY-RUN]')
    expect(dry.stdout).toContain(
      'https://mirror.example.com/https://github.com/harryzhz/dsh-lark-bridge/releases/download/v0.4.16/harryzhz-dsh-lark-bridge-0.4.16.tgz',
    )
    expect(dry.stdout).not.toContain('dsh-external-agents/releases')
    expect(readCalls(sb.logFile).filter((c) => c.args[0] === 'plugin')).toHaveLength(0)

    const real = spawnSync(
      'bash',
      [
        installShPath,
        '--mode',
        'web',
        '--yes',
        '--without-external-agents',
        '--github-proxy',
        'https://mirror.example.com',
        '--bridge-version',
        '0.4.16',
      ],
      { env: sb.env, encoding: 'utf8' },
    )
    expect(real.status, real.stderr + real.stdout).toBe(0)
    const calls = readCalls(sb.logFile).filter((c) => c.args[0] === 'plugin')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual([
      'plugin',
      '--profile',
      'web',
      'add',
      'https://mirror.example.com/https://github.com/harryzhz/dsh-lark-bridge/releases/download/v0.4.16/harryzhz-dsh-lark-bridge-0.4.16.tgz',
    ])
  })

  it('rejects --mode app on Linux and installs via Desktop bundled CLI on macOS (app & both)', { timeout: 20_000 }, () => {
    const linuxSb = createBaseSandbox({
      unameS: 'Linux',
      unameM: 'x86_64',
      pnpmVer: '10.12.0',
      dshVer: '0.2.2-rc.5',
    })
    const linuxApp = spawnSync('bash', [installShPath, '--mode', 'app', '--yes'], {
      env: linuxSb.env,
      encoding: 'utf8',
    })
    expect(linuxApp.status).not.toBe(0)
    expect(linuxApp.stderr).toContain('Linux')

    const macSb = createBaseSandbox({
      unameS: 'Darwin',
      unameM: 'arm64',
      pnpmVer: '10.12.0',
      dshVer: '0.2.2-rc.5',
      appVer: '0.2.2-rc.5',
      initDesktopProfile: true,
    })

    const both = spawnSync(
      'bash',
      [
        installShPath,
        '--mode',
        'both',
        '--yes',
        '--no-launch',
        '--bridge-version',
        '0.4.16',
        '--external-agents-version',
        '0.4.3',
      ],
      { env: macSb.env, encoding: 'utf8' },
    )
    expect(both.status, both.stderr + both.stdout).toBe(0)

    const calls = readCalls(macSb.logFile).filter((c) => c.args[0] === 'plugin')
    expect(calls).toHaveLength(2)
    expect(calls[0]?.bin).toContain('DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh')
    expect(calls[0]?.args.slice(0, 4)).toEqual(['plugin', '--profile', 'desktop', 'add'])
    expect(calls[1]?.bin).toBe(join(macSb.binDir, 'dsh'))
    expect(calls[1]?.args.slice(0, 4)).toEqual(['plugin', '--profile', 'web', 'add'])
  })

  it('idempotently records protobufjs: false in pnpm-workspace.yaml for pnpm 11 compatibility', () => {
    const dir = makeTempDir('dsh-ws-allowbuilds-')
    const sh = readFileSync(installShPath, 'utf8').replace(/\nmain "\$@"\s*$/, '\n')

    // Case 1: no allowBuilds block yet -> appends block
    const p1 = join(dir, 'case1')
    mkdirSync(p1, { recursive: true })
    writeFileSync(join(p1, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\n')

    // Case 2: existing allowBuilds block -> inserts under it without duplicating
    const p2 = join(dir, 'case2')
    mkdirSync(p2, { recursive: true })
    writeFileSync(
      join(p2, 'pnpm-workspace.yaml'),
      "packages:\n  - .\n\nallowBuilds:\n  '@harryzhz/dsh-lark-bridge': true\n",
    )

    // Case 3: already configured protobufjs -> untouched
    const p3 = join(dir, 'case3')
    mkdirSync(p3, { recursive: true })
    const orig3 = 'packages:\n  - .\n\nallowBuilds:\n  protobufjs: true\n'
    writeFileSync(join(p3, 'pnpm-workspace.yaml'), orig3)

    const harness = `${sh}
ensure_profile_pnpm_allow_builds ${JSON.stringify(p1)}
ensure_profile_pnpm_allow_builds ${JSON.stringify(p1)}
ensure_profile_pnpm_allow_builds ${JSON.stringify(p2)}
ensure_profile_pnpm_allow_builds ${JSON.stringify(p2)}
ensure_profile_pnpm_allow_builds ${JSON.stringify(p3)}
`
    execFileSync('bash', ['-c', harness], { encoding: 'utf8' })

    const out1 = readFileSync(join(p1, 'pnpm-workspace.yaml'), 'utf8')
    expect(out1).toContain('allowBuilds:\n  protobufjs: false\n')
    expect(out1.match(/protobufjs:/g)).toHaveLength(1)

    const out2 = readFileSync(join(p2, 'pnpm-workspace.yaml'), 'utf8')
    expect(out2).toContain("allowBuilds:\n  protobufjs: false\n  '@harryzhz/dsh-lark-bridge': true\n")
    expect(out2.match(/protobufjs:/g)).toHaveLength(1)

    const out3 = readFileSync(join(p3, 'pnpm-workspace.yaml'), 'utf8')
    expect(out3).toBe(orig3)
  })
})
