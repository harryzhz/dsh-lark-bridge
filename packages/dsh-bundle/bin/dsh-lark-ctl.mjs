#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../..')
const bundlePatchTemplate = resolve(__dirname, '../cordis.patch.yml')
const larkBridgeCliEntry = resolve(__dirname, './lark-bridge.mjs')
const larkBridgeSkillSource = resolve(repoRoot, 'skills/lark-bridge/SKILL.md')

function detectLanIpv4() {
  const ifaces = networkInterfaces()
  for (const list of Object.values(ifaces)) {
    for (const addr of list ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address
    }
  }
  return '127.0.0.1'
}

function parseArgs(argv) {
  const cmd = argv[0] ?? 'help'
  const flags = {}
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      flags[key] = next
      i += 1
    } else {
      flags[key] = true
    }
  }
  return { cmd, flags }
}

function resolveDshBin(explicitBin) {
  if (explicitBin) return resolve(String(explicitBin))
  const localCandidates = [
    resolve(__dirname, '../node_modules/.bin/dsh'),
    resolve(repoRoot, 'node_modules/.bin/dsh'),
  ]
  for (const candidate of localCandidates) {
    if (existsSync(candidate)) return candidate
  }
  try {
    return execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
  } catch {
    throw new Error(
      'Could not find `dsh` in workspace or PATH. Run `pnpm install` or pass --dsh-bin /path/to/dsh.',
    )
  }
}

function installCliAndSkillAssets(dshHome) {
  const dataDir = join(dshHome, 'lark-bridge')
  const endpointFile = join(dataDir, 'cli-endpoint.json')
  const wrapper = [
    '#!/bin/sh',
    `export LARK_BRIDGE_ENDPOINT_FILE="${endpointFile}"`,
    `exec "${process.execPath}" "${larkBridgeCliEntry}" "$@"`,
    '',
  ].join('\n')

  for (const binDir of [join(dataDir, 'bin'), join(homedir(), '.local', 'bin')]) {
    mkdirSync(binDir, { recursive: true })
    const dest = join(binDir, 'lark-bridge')
    writeFileSync(dest, wrapper, { encoding: 'utf8', mode: 0o755 })
    chmodSync(dest, 0o755)
  }
  console.log(`Installed CLI binary: ${join(homedir(), '.local', 'bin', 'lark-bridge')}`)

  if (existsSync(larkBridgeSkillSource)) {
    const agentsHome = process.env.AGENTS_HOME?.trim() || join(homedir(), '.agents')
    const skillDestDir = join(agentsHome, 'skills', 'lark-bridge')
    mkdirSync(skillDestDir, { recursive: true })
    const skillDest = join(skillDestDir, 'SKILL.md')
    writeFileSync(skillDest, readFileSync(larkBridgeSkillSource, 'utf8'), 'utf8')
    console.log(`Installed Agent skill: ${skillDest}`)
  }
}

function cmdInstallProfile(flags) {
  const dshHome = resolve(
    String(flags['dsh-home'] || process.env.DSH_HOME || join(homedir(), '.dsh')),
  )
  const host = String(flags.host || detectLanIpv4())
  const port = Number(flags.port || 3880)
  const dshBin = resolveDshBin(flags['dsh-bin'])
  const publicBaseUrl = `http://${host}:${port}`

  const env = { ...process.env, DSH_HOME: dshHome }
  const pkgs = [
    `file:${resolve(repoRoot, 'packages/dsh-lark-bridge')}`,
    `file:${resolve(repoRoot, 'packages/dsh-lark-ui')}`,
  ]
  if (flags['external-agents']) {
    const rawSpec = String(flags['external-agents']).trim()
    const maybeLocalPath = resolve(process.cwd(), rawSpec)
    const spec = rawSpec.startsWith('file:') || rawSpec.startsWith('http://') || rawSpec.startsWith('https://')
      ? rawSpec
      : existsSync(maybeLocalPath)
        ? `file:${maybeLocalPath}`
        : rawSpec
    pkgs.push(spec)
  }

  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  rmSync(join(profileDir, 'package.json'), { force: true })
  rmSync(join(profileDir, 'pnpm-lock.yaml'), { force: true })
  rmSync(join(profileDir, 'node_modules'), { recursive: true, force: true })

  for (const pkgSpec of pkgs) {
    console.log(`Installing plugin into web profile: ${pkgSpec}`)
    execFileSync(dshBin, ['plugin', '--profile', 'web', 'add', pkgSpec], {
      env,
      stdio: 'inherit',
    })
  }

  const patchText = readFileSync(bundlePatchTemplate, 'utf8').replace(
    /publicBaseUrl:\s*.+/,
    `publicBaseUrl: ${publicBaseUrl}`,
  )
  const patchDest = join(profileDir, 'cordis.patch.yml')
  writeFileSync(patchDest, patchText, 'utf8')
  installCliAndSkillAssets(dshHome)

  console.log(`\nWrote DSH profile patch: ${patchDest}`)
  console.log(
    `Ready! Start daemon via:\n  DSH_HOME=${dshHome} ${dshBin} --profile web --no-open --host ${host} --port ${port}`,
  )
}

function cmdInstallLaunchAgent(flags) {
  const dshHome = resolve(
    String(flags['dsh-home'] || process.env.DSH_HOME || join(homedir(), '.dsh')),
  )
  const host = String(flags.host || detectLanIpv4())
  const port = Number(flags.port || 3880)
  const dshBin = resolveDshBin(flags['dsh-bin'])
  const label = String(flags.label || 'io.dsh.lark-bridge')
  const logDir = join(dshHome, 'logs')
  mkdirSync(logDir, { recursive: true })

  const pathParts = [
    join(dshHome, 'lark-bridge', 'bin'),
    join(homedir(), '.local', 'bin'),
    dirname(process.execPath),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ]
  const pathEnv = [...new Set(pathParts)].join(':')

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${dshBin}</string>
    <string>--profile</string>
    <string>web</string>
    <string>--no-open</string>
    <string>--host</string>
    <string>${host}</string>
    <string>--port</string>
    <string>${port}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DSH_HOME</key>
    <string>${dshHome}</string>
    <key>HOME</key>
    <string>${homedir()}</string>
    <key>PATH</key>
    <string>${pathEnv}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(logDir, 'dsh-web.stdout.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(logDir, 'dsh-web.stderr.log')}</string>
</dict>
</plist>
`

  const agentsDir = join(homedir(), 'Library', 'LaunchAgents')
  mkdirSync(agentsDir, { recursive: true })
  const plistPath = join(agentsDir, `${label}.plist`)
  writeFileSync(plistPath, plist, 'utf8')
  installCliAndSkillAssets(dshHome)
  console.log(`Wrote LaunchAgent plist: ${plistPath}`)
  console.log(`Target URL: http://${host}:${port}`)
  console.log(`Logs: ${join(logDir, 'dsh-web.stdout.log')}`)

  if (flags.load) {
    const uid = process.getuid?.()
    if (uid !== undefined) {
      try {
        execFileSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' })
      } catch {
        // Not previously loaded.
      }
      execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'inherit' })
      console.log('LaunchAgent loaded and started.')
    }
  } else {
    console.log(`\nTo load now:\n  launchctl bootstrap gui/$(id -u) "${plistPath}"`)
  }
}

const { cmd, flags } = parseArgs(process.argv.slice(2))
try {
  if (cmd === 'install-profile') {
    cmdInstallProfile(flags)
  } else if (cmd === 'install-launchagent') {
    cmdInstallLaunchAgent(flags)
  } else if (cmd === 'install-cli') {
    const dshHome = resolve(
      String(flags['dsh-home'] || process.env.DSH_HOME || join(homedir(), '.dsh')),
    )
    installCliAndSkillAssets(dshHome)
  } else if (cmd === 'db' || cmd === 'doctor') {
    execFileSync(process.execPath, [larkBridgeCliEntry, ...process.argv.slice(2)], {
      stdio: 'inherit',
    })
  } else {
    console.log(`Usage: dsh-lark-ctl <command> [options]

Commands:
  install-profile      Install plugins, CLI, skill & cordis.patch.yml into DSH web profile
                       [--dsh-home ~/.dsh] [--dsh-bin /path/to/dsh] [--host <ipv4>] [--port 3880]
                       [--external-agents <@harryzhz/dsh-external-agents-or-path>]
  install-launchagent  Generate macOS LaunchAgent plist for always-on DSH web daemon
                       [--dsh-home ~/.dsh] [--dsh-bin /path/to/dsh] [--host <ipv4>] [--port 3880] [--label io.dsh.lark-bridge] [--load]
  install-cli          Install or refresh the lark-bridge CLI wrapper & Agent skill only
                       [--dsh-home ~/.dsh]
  db                   SQLite storage status, migration, verify, backup, export, rollback & compact
  doctor               Run storage, lock & bridge health diagnostics
`)
  }
} catch (err) {
  console.error('Error:', err instanceof Error ? err.message : String(err))
  process.exit(1)
}
