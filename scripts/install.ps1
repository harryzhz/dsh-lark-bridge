#Requires -Version 5.1
<#
.SYNOPSIS
  DeepSeek Harness (DSH) + dsh-lark-bridge + dsh-external-agents Windows one-click installer.
  Supports Desktop App and Web editions.

.EXAMPLE
  irm https://raw.githubusercontent.com/harryzhz/dsh-lark-bridge/main/scripts/install.ps1 | iex

.EXAMPLE
  $env:DSH_INSTALL_MODE = 'web'; irm https://raw.githubusercontent.com/harryzhz/dsh-lark-bridge/main/scripts/install.ps1 | iex

.EXAMPLE
  .\install.ps1 -Mode both
#>
param(
  [ValidateSet('auto', 'web', 'app', 'both')]
  [string]$Mode = $(if ($env:DSH_INSTALL_MODE) { $env:DSH_INSTALL_MODE } else { 'auto' }),

  [string]$Profile = $(if ($env:DSH_WEB_PROFILE) { $env:DSH_WEB_PROFILE } else { 'web' }),

  [switch]$WithoutExternalAgents,

  [string]$BridgeVersion = $(if ($env:DSH_BRIDGE_VERSION) { $env:DSH_BRIDGE_VERSION } else { '' }),

  [string]$ExternalAgentsVersion = $(if ($env:DSH_EXTERNAL_AGENTS_VERSION) { $env:DSH_EXTERNAL_AGENTS_VERSION } else { '' }),

  [string]$DshVersion = $(if ($env:DSH_VERSION) { $env:DSH_VERSION } else { 'latest' }),

  [switch]$UpgradeDsh,

  [switch]$Force,

  [string]$GithubProxy = $(if ($env:GITHUB_PROXY) { $env:GITHUB_PROXY } else { '' }),

  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }),

  [switch]$Launch,

  [switch]$NoLaunch,

  [switch]$Yes,

  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
} catch {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

if ($env:DSH_WITHOUT_EXTERNAL_AGENTS -eq '1') { $WithoutExternalAgents = $true }
if ($env:DSH_UPGRADE -eq '1') { $UpgradeDsh = $true }
if ($env:DSH_FORCE -eq '1') { $Force = $true }
if ($env:DSH_YES -eq '1') { $Yes = $true }
if ($env:DSH_DRY_RUN -eq '1') { $DryRun = $true }

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
$MIN_NODE_VERSION = '22.13.0'
$MIN_DSH_VERSION = '0.2.2-rc.5'
$MAX_DSH_VERSION_EXCLUSIVE = '0.3.0'

$DSH_NPM_PACKAGE = '@deepseek-ai/dsh'
$DESKTOP_WIN_EXE_URL = 'https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe'

$BRIDGE_PKG = '@harryzhz/dsh-lark-bridge'
$BRIDGE_REPO = 'harryzhz/dsh-lark-bridge'
$BRIDGE_ASSET_PREFIX = 'harryzhz-dsh-lark-bridge-'
$BRIDGE_ALIAS_ASSET = 'dsh-lark-bridge.tgz'

$EXT_PKG = '@harryzhz/dsh-external-agents'
$EXT_REPO = 'harryzhz/dsh-external-agents'
$EXT_ASSET_PREFIX = 'harryzhz-dsh-external-agents-'
$EXT_ALIAS_ASSET = 'dsh-external-agents.tgz'

$DSH_CLI_HOME = if ($env:DSH_CLI_HOME) { $env:DSH_CLI_HOME } else { Join-Path $env:LOCALAPPDATA 'dsh-cli' }
$DSH_BIN_DIR = if ($env:DSH_BIN_DIR) { $env:DSH_BIN_DIR } else { Join-Path $DSH_CLI_HOME 'bin' }

if ([string]::IsNullOrWhiteSpace($Profile) -or $Profile -eq 'desktop') {
  throw "Invalid Web profile '$Profile'. Desktop profile is managed by -Mode app."
}

# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------
function Write-Info([string]$Msg) { Write-Host "[INFO] $Msg" -ForegroundColor Cyan }
function Write-Ok([string]$Msg)   { Write-Host "[OK]   $Msg" -ForegroundColor Green }
function Write-Warn([string]$Msg) { Write-Host "[WARN] $Msg" -ForegroundColor Yellow }
function Write-Step([string]$Msg) { Write-Host "`n==> $Msg" -ForegroundColor White }

# ---------------------------------------------------------------------------
# SemVer 2.0.0 helpers
# ---------------------------------------------------------------------------
function Normalize-Version([string]$Raw) {
  if ([string]::IsNullOrWhiteSpace($Raw)) { return '' }
  $trimmed = $Raw.Trim()
  if ($trimmed -match '(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)') {
    return $Matches[1]
  }
  return ''
}

function Compare-SemVer([string]$A, [string]$B) {
  $aClean = ($A -replace '^[vV]', '') -replace '\+.*$', ''
  $bClean = ($B -replace '^[vV]', '') -replace '\+.*$', ''

  $aParts = $aClean.Split('-', 2)
  $bParts = $bClean.Split('-', 2)
  $aCore = $aParts[0].Split('.')
  $bCore = $bParts[0].Split('.')

  for ($i = 0; $i -lt 3; $i++) {
    $av = if ($i -lt $aCore.Length -and $aCore[$i]) { [int]$aCore[$i] } else { 0 }
    $bv = if ($i -lt $bCore.Length -and $bCore[$i]) { [int]$bCore[$i] } else { 0 }
    if ($av -lt $bv) { return -1 }
    if ($av -gt $bv) { return 1 }
  }

  $aPre = if ($aParts.Length -gt 1) { $aParts[1] } else { '' }
  $bPre = if ($bParts.Length -gt 1) { $bParts[1] } else { '' }
  if (-not $aPre -and -not $bPre) { return 0 }
  if (-not $aPre) { return 1 }
  if (-not $bPre) { return -1 }

  $ap = $aPre.Split('.')
  $bp = $bPre.Split('.')
  $maxLen = [Math]::Max($ap.Length, $bp.Length)
  for ($i = 0; $i -lt $maxLen; $i++) {
    if ($i -ge $ap.Length) { return -1 }
    if ($i -ge $bp.Length) { return 1 }
    $aNum = $ap[$i] -match '^\d+$'
    $bNum = $bp[$i] -match '^\d+$'
    if ($aNum -and $bNum) {
      $av = [int]$ap[$i]; $bv = [int]$bp[$i]
      if ($av -lt $bv) { return -1 }
      if ($av -gt $bv) { return 1 }
    } elseif ($aNum -and -not $bNum) {
      return -1
    } elseif (-not $aNum -and $bNum) {
      return 1
    } else {
      $c = [String]::CompareOrdinal($ap[$i], $bp[$i])
      if ($c -ne 0) { return [Math]::Sign($c) }
    }
  }
  return 0
}

function Test-DshVersionCompatible([string]$Ver) {
  $v = Normalize-Version $Ver
  if (-not $v) { return $false }
  return ((Compare-SemVer $v $MIN_DSH_VERSION) -ge 0) -and ((Compare-SemVer $v $MAX_DSH_VERSION_EXCLUSIVE) -lt 0)
}

function Test-NodeVersionCompatible([string]$Ver) {
  $v = Normalize-Version $Ver
  if (-not $v) { return $false }
  return (Compare-SemVer $v $MIN_NODE_VERSION) -ge 0
}

# ---------------------------------------------------------------------------
# Detection helpers
# ---------------------------------------------------------------------------
function Get-InstalledPluginVersion([string]$ProfileDir, [string]$PkgName) {
  $pkgPath = Join-Path $ProfileDir ("node_modules\" + ($PkgName -replace '/', '\') + "\package.json")
  if (-not (Test-Path -LiteralPath $pkgPath)) { return '' }
  try {
    $pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    return Normalize-Version ([string]$pkg.version)
  } catch {
    return ''
  }
}

function Test-ProfileHasBundle([string]$ProfileDir, [string]$PkgName) {
  $pkgPath = Join-Path $ProfileDir 'package.json'
  if (-not (Test-Path -LiteralPath $pkgPath)) { return $false }
  try {
    $pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $hasDep = $null -ne $pkg.dependencies -and ($pkg.dependencies.PSObject.Properties.Name -contains $PkgName)
    $bundles = @()
    if ($pkg.dsh -and $pkg.dsh.profile -and $pkg.dsh.profile.bundles) {
      $bundles = @($pkg.dsh.profile.bundles)
    }
    return $hasDep -and ($bundles -contains $PkgName)
  } catch {
    return $false
  }
}

function Find-DesktopApp {
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($env:DSH_DESKTOP_APP) { $candidates.Add($env:DSH_DESKTOP_APP) }
  if ($env:LOCALAPPDATA) {
    $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'))
    $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\dsh-desktop'))
  }

  # Also check per-user uninstall registry keys for actual InstallLocation
  $regPaths = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($rp in $regPaths) {
    try {
      Get-ItemProperty -Path $rp -ErrorAction SilentlyContinue | Where-Object {
        $_.DisplayName -like '*DeepSeek Harness*' -and $_.InstallLocation
      } | ForEach-Object {
        $candidates.Add($_.InstallLocation)
      }
    } catch {}
  }

  foreach ($cand in $candidates) {
    if (-not $cand) { continue }
    $dir = $cand
    if ($dir -like '*.exe' -and (Test-Path -LiteralPath $dir)) {
      $dir = Split-Path -Parent $dir
    }
    $exe = Join-Path $dir 'DeepSeek Harness.exe'
    $cli = Join-Path $dir 'resources\runtime\cli\bin\dsh.cmd'
    if ((Test-Path -LiteralPath $exe) -and (Test-Path -LiteralPath $cli)) {
      $ver = ''
      try {
        $ver = Normalize-Version ((& $cli --version 2>$null | Select-Object -First 1) -as [string])
      } catch {}
      return [PSCustomObject]@{
        Dir = $dir
        Exe = $exe
        Cli = $cli
        Version = $ver
      }
    }
  }
  return $null
}

function Find-DshCli {
  $candidate = ''
  $localCmd = Join-Path $DSH_BIN_DIR 'dsh.cmd'
  if (Test-Path -LiteralPath $localCmd) {
    $candidate = $localCmd
  } else {
    $cmd = Get-Command dsh -ErrorAction SilentlyContinue
    if ($cmd) { $candidate = $cmd.Source }
  }

  if (-not $candidate) { return $null }
  $ver = ''
  try {
    $ver = Normalize-Version ((& $candidate --version 2>$null | Select-Object -First 1) -as [string])
  } catch {}
  $isDesktop = $candidate -like '*DeepSeek Harness*'
  return [PSCustomObject]@{
    Bin = $candidate
    Version = $ver
    IsDesktop = $isDesktop
  }
}

function Get-NodeVersion {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return '' }
  try {
    return Normalize-Version ((& node -v 2>$null | Select-Object -First 1) -as [string])
  } catch {
    return ''
  }
}

function Get-PnpmVersion {
  $cmd = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($cmd) {
    try { return Normalize-Version ((& pnpm --version 2>$null | Select-Object -First 1) -as [string]) } catch {}
  }
  $localPnpm = Join-Path $DSH_BIN_DIR 'pnpm.cmd'
  if (Test-Path -LiteralPath $localPnpm) {
    try { return Normalize-Version ((& $localPnpm --version 2>$null | Select-Object -First 1) -as [string]) } catch {}
  }
  return ''
}

function Add-ToUserPath([string]$Dir) {
  $currentProcess = $env:PATH -split ';'
  if (-not ($currentProcess -contains $Dir)) {
    $env:PATH = "$Dir;$env:PATH"
  }
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = if ($userPath) { $userPath -split ';' | Where-Object { $_ } } else { @() }
  if (-not ($entries -contains $Dir)) {
    $newPath = (@($Dir) + $entries) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Ok "已将 $Dir 加入当前用户 PATH（新开终端生效）"
  }
}

# ---------------------------------------------------------------------------
# GitHub Release URL resolution
# ---------------------------------------------------------------------------
function Apply-GithubProxy([string]$Url) {
  if ([string]::IsNullOrWhiteSpace($GithubProxy)) { return $Url }
  $prefix = $GithubProxy.TrimEnd('/') + '/'
  return "$prefix$Url"
}

function Resolve-GithubLatestVersion([string]$Repo) {
  $latestUrl = "https://github.com/$Repo/releases/latest"

  # Strategy 1: HEAD redirect (no API rate limit)
  try {
    $req = [System.Net.HttpWebRequest]::Create($latestUrl)
    $req.Method = 'HEAD'
    $req.AllowAutoRedirect = $false
    $req.Timeout = 15000
    $req.UserAgent = 'dsh-lark-bridge-installer'
    $resp = $req.GetResponse()
    $loc = $resp.Headers['Location']
    $resp.Close()
    if ($loc) {
      $tag = ($loc.TrimEnd('/') -split '/')[-1]
      $ver = Normalize-Version $tag
      if ($ver) { return $ver }
    }
  } catch [System.Net.WebException] {
    if ($_.Exception.Response) {
      $loc = $_.Exception.Response.Headers['Location']
      $_.Exception.Response.Close()
      if ($loc) {
        $tag = ($loc.TrimEnd('/') -split '/')[-1]
        $ver = Normalize-Version $tag
        if ($ver) { return $ver }
      }
    }
  } catch {}

  # Strategy 2: GitHub REST API fallback
  try {
    $api = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{
      'Accept' = 'application/vnd.github+json'
      'User-Agent' = 'dsh-lark-bridge-installer'
    } -TimeoutSec 15
    if ($api.tag_name) {
      $ver = Normalize-Version ([string]$api.tag_name)
      if ($ver) { return $ver }
    }
  } catch {}

  return ''
}

$script:ResolvedPlugins = $null
function Resolve-PluginReleases {
  if ($script:ResolvedPlugins) { return $script:ResolvedPlugins }

  Write-Step '解析插件最新版本'

  $bVer = if ($BridgeVersion) { Normalize-Version $BridgeVersion } else { Resolve-GithubLatestVersion $BRIDGE_REPO }
  if ($BridgeVersion -and -not $bVer) { throw "无效的 -BridgeVersion: $BridgeVersion" }
  if ($bVer) {
    $bUrl = Apply-GithubProxy "https://github.com/$BRIDGE_REPO/releases/download/v$bVer/$BRIDGE_ASSET_PREFIX$bVer.tgz"
  } else {
    Write-Warn "未能解析 $BRIDGE_REPO 最新版本号，回退至 latest 固定链接。"
    $bVer = 'latest'
    $bUrl = Apply-GithubProxy "https://github.com/$BRIDGE_REPO/releases/latest/download/$BRIDGE_ALIAS_ASSET"
  }
  Write-Info "飞书桥接 ($BRIDGE_PKG): v$bVer"

  $eVer = ''
  $eUrl = ''
  if (-not $WithoutExternalAgents) {
    $eVer = if ($ExternalAgentsVersion) { Normalize-Version $ExternalAgentsVersion } else { Resolve-GithubLatestVersion $EXT_REPO }
    if ($ExternalAgentsVersion -and -not $eVer) { throw "无效的 -ExternalAgentsVersion: $ExternalAgentsVersion" }
    if ($eVer) {
      $eUrl = Apply-GithubProxy "https://github.com/$EXT_REPO/releases/download/v$eVer/$EXT_ASSET_PREFIX$eVer.tgz"
    } else {
      Write-Warn "未能解析 $EXT_REPO 最新版本号，回退至 latest 固定链接。"
      $eVer = 'latest'
      $eUrl = Apply-GithubProxy "https://github.com/$EXT_REPO/releases/latest/download/$EXT_ALIAS_ASSET"
    }
    Write-Info "外部运行时 ($EXT_PKG): v$eVer"
  } else {
    Write-Info "已按参数跳过外部运行时插件 ($EXT_PKG)"
  }

  $script:ResolvedPlugins = [PSCustomObject]@{
    BridgeVersion = $bVer
    BridgeUrl = $bUrl
    ExtVersion = $eVer
    ExtUrl = $eUrl
  }
  return $script:ResolvedPlugins
}

function Ensure-ProfilePnpmAllowBuilds([string]$ProfileDir) {
  $wsFile = Join-Path $ProfileDir 'pnpm-workspace.yaml'
  if (-not (Test-Path -LiteralPath $wsFile)) { return }
  $content = Get-Content -LiteralPath $wsFile -Raw -Encoding UTF8
  if ($content -match "(?m)^\s*['""]?protobufjs['""]?\s*:" -or $content -match "(?m)^\s*-\s*['""]?protobufjs['""]?\s*$") {
    return
  }
  if ($content -match '(?m)^allowBuilds:\s*$') {
    $updated = [regex]::Replace($content, '(?m)^allowBuilds:\s*$', "allowBuilds:`n  protobufjs: false", 1)
    Set-Content -LiteralPath $wsFile -Value $updated -Encoding UTF8 -NoNewline
  } else {
    $suffix = if ($content.EndsWith("`n")) { "allowBuilds:`n  protobufjs: false`n" } else { "`nallowBuilds:`n  protobufjs: false`n" }
    Add-Content -LiteralPath $wsFile -Value $suffix -Encoding UTF8 -NoNewline
  }
}

function Install-PluginsIntoProfile([string]$DshBin, [string]$ProfileName, [string]$Label) {
  $profileDir = Join-Path (Join-Path $DshHome 'profiles') $ProfileName
  $rel = Resolve-PluginReleases

  $specs = New-Object System.Collections.Generic.List[string]
  $expected = New-Object System.Collections.Generic.List[string]

  if (-not $WithoutExternalAgents) {
    $expected.Add($EXT_PKG)
    $curExt = Get-InstalledPluginVersion $profileDir $EXT_PKG
    if (-not $Force -and $rel.ExtVersion -ne 'latest' -and $curExt -eq $rel.ExtVersion -and (Test-ProfileHasBundle $profileDir $EXT_PKG)) {
      Write-Ok "[$Label] $EXT_PKG 已是最新 v${curExt}，跳过。"
    } else {
      if ($curExt) { Write-Info "[$Label] 将升级 ${EXT_PKG}: v$curExt -> v$($rel.ExtVersion)" }
      else { Write-Info "[$Label] 将安装 ${EXT_PKG}: v$($rel.ExtVersion)" }
      $specs.Add($rel.ExtUrl)
    }
  }

  $expected.Add($BRIDGE_PKG)
  $curBridge = Get-InstalledPluginVersion $profileDir $BRIDGE_PKG
  if (-not $Force -and $rel.BridgeVersion -ne 'latest' -and $curBridge -eq $rel.BridgeVersion -and (Test-ProfileHasBundle $profileDir $BRIDGE_PKG)) {
    Write-Ok "[$Label] $BRIDGE_PKG 已是最新 v${curBridge}，跳过。"
  } else {
    if ($curBridge) { Write-Info "[$Label] 将升级 ${BRIDGE_PKG}: v$curBridge -> v$($rel.BridgeVersion)" }
    else { Write-Info "[$Label] 将安装 ${BRIDGE_PKG}: v$($rel.BridgeVersion)" }
    $specs.Add($rel.BridgeUrl)
  }

  if ($specs.Count -eq 0) {
    Write-Ok "[$Label] 插件均为最新版本，无需变更。"
    return
  }

  if ($DryRun) {
    Write-Info "[DRY-RUN] DSH_HOME='$DshHome' `"$DshBin`" plugin --profile $ProfileName add $($specs -join ' ')"
    return
  }

  Ensure-ProfilePnpmAllowBuilds $profileDir

  Write-Info "[$Label] 正在向 profile '$ProfileName' 安装插件..."
  $prevDshHome = $env:DSH_HOME
  try {
    $env:DSH_HOME = $DshHome
    & $DshBin plugin --profile $ProfileName add @specs
    if ($LASTEXITCODE -ne 0) {
      $wsFile = Join-Path $profileDir 'pnpm-workspace.yaml'
      $wsText = if (Test-Path -LiteralPath $wsFile) { Get-Content -LiteralPath $wsFile -Raw -Encoding UTF8 } else { '' }
      if ($wsText -and ($wsText -notmatch 'protobufjs')) {
        Write-Info "[$Label] 为 pnpm 11 补充 protobufjs 构建脚本豁免声明后重试一次..."
        Ensure-ProfilePnpmAllowBuilds $profileDir
        & $DshBin plugin --profile $ProfileName add @specs
      }
      if ($LASTEXITCODE -ne 0) {
        throw "[$Label] dsh plugin add 退出码非零 ($LASTEXITCODE)"
      }
    }
  } finally {
    if ($null -eq $prevDshHome) { Remove-Item Env:\DSH_HOME -ErrorAction SilentlyContinue }
    else { $env:DSH_HOME = $prevDshHome }
  }

  foreach ($pkg in $expected) {
    if (-not (Test-ProfileHasBundle $profileDir $pkg)) {
      throw "[$Label] 校验失败: $profileDir\package.json 中未激活插件 $pkg"
    }
  }
  Write-Ok "[$Label] 插件安装并激活完成（profile: ${ProfileName}）"
}

# ---------------------------------------------------------------------------
# Web edition (Windows)
# ---------------------------------------------------------------------------
function Ensure-NodeForWeb {
  $nodeVer = Get-NodeVersion
  if (Test-NodeVersionCompatible $nodeVer) { return }

  Write-Warn "Web 版需要 Node.js >= ${MIN_NODE_VERSION}（当前: $(if ($nodeVer) { "v$nodeVer" } else { '未安装' })）。"
  if ($DryRun) {
    Write-Info '[DRY-RUN] 将通过 winget / fnm 安装 Node.js 22 LTS'
    return
  }

  if (Get-Command fnm -ErrorAction SilentlyContinue) {
    Write-Info '检测到 fnm，正在安装 Node.js 22 LTS...'
    & fnm install 22
    & fnm env --use-on-cd --shell power-shell | Out-String | Invoke-Expression
    & fnm use 22
    $nodeVer = Get-NodeVersion
  } elseif (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Info '检测到 winget，正在安装 Node.js LTS (OpenJS.NodeJS.LTS)...'
    & winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    $env:PATH = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $nodeVer = Get-NodeVersion
  }

  if (-not (Test-NodeVersionCompatible $nodeVer)) {
    throw "未找到兼容的 Node.js (>= $MIN_NODE_VERSION)。请先安装 Node.js 22 LTS（https://nodejs.org 或 winget install OpenJS.NodeJS.LTS），重开终端后再运行本脚本。"
  }
  Write-Ok "Node.js 就绪: v$nodeVer"
}

function Ensure-PnpmForWeb {
  $pnpmVer = Get-PnpmVersion
  if ($pnpmVer) {
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
      $env:PATH = "$DSH_BIN_DIR;$env:PATH"
    }
    return
  }

  if ($DryRun) {
    Write-Info '[DRY-RUN] 将通过 corepack 或用户目录安装 pnpm'
    return
  }

  Write-Info '未检测到 pnpm，正在自动准备 pnpm...'
  if (Get-Command corepack -ErrorAction SilentlyContinue) {
    try {
      & corepack enable 2>$null
      & corepack prepare pnpm@10 --activate 2>$null
      $pnpmVer = Get-PnpmVersion
      if ($pnpmVer) {
        Write-Ok "已通过 corepack 启用 pnpm v$pnpmVer"
        return
      }
    } catch {}
  }

  $pnpmHome = Join-Path $DSH_CLI_HOME 'pnpm-runtime'
  New-Item -ItemType Directory -Force -Path $pnpmHome, $DSH_BIN_DIR | Out-Null
  $pkgFile = Join-Path $pnpmHome 'package.json'
  if (-not (Test-Path -LiteralPath $pkgFile)) {
    '{"name":"dsh-pnpm-runtime","private":true}' | Set-Content -LiteralPath $pkgFile -Encoding UTF8
  }
  & npm --prefix $pnpmHome install --no-audit --no-fund pnpm@10
  if ($LASTEXITCODE -ne 0) { throw '自动安装 pnpm 失败，请手动安装 pnpm 后重试。' }

  $pnpmTarget = Join-Path $pnpmHome 'node_modules\.bin\pnpm.cmd'
  $pnpmWrapper = Join-Path $DSH_BIN_DIR 'pnpm.cmd'
  "@echo off`r`ncall `"$pnpmTarget`" %*`r`n" | Set-Content -LiteralPath $pnpmWrapper -Encoding ASCII
  Add-ToUserPath $DSH_BIN_DIR

  $pnpmVer = Get-PnpmVersion
  if (-not $pnpmVer) { throw '自动安装 pnpm 失败，请手动安装 pnpm 后重试。' }
  Write-Ok "已安装用户级 pnpm v$pnpmVer -> $pnpmWrapper"
}

function Install-StandaloneDshCli {
  Ensure-NodeForWeb
  Ensure-PnpmForWeb

  $spec = "$DSH_NPM_PACKAGE@$DshVersion"
  if ($DryRun) {
    Write-Info "[DRY-RUN] 将在 $DSH_CLI_HOME 安装 $spec 并生成 $DSH_BIN_DIR\dsh.cmd"
    return [PSCustomObject]@{ Bin = (Join-Path $DSH_BIN_DIR 'dsh.cmd'); Version = $MIN_DSH_VERSION; IsDesktop = $false }
  }

  Write-Info "正在安装 $spec 到 $DSH_CLI_HOME..."
  New-Item -ItemType Directory -Force -Path $DSH_CLI_HOME, $DSH_BIN_DIR | Out-Null
  $pkgFile = Join-Path $DSH_CLI_HOME 'package.json'
  if (-not (Test-Path -LiteralPath $pkgFile)) {
    '{"name":"dsh-standalone-host","private":true}' | Set-Content -LiteralPath $pkgFile -Encoding UTF8
  }
  $wsFile = Join-Path $DSH_CLI_HOME 'pnpm-workspace.yaml'
  if (-not (Test-Path -LiteralPath $wsFile)) {
    @"
packages:
  - .

allowBuilds:
  '@deepseek-ai/dsh-subprocess-local': true
  koffi: true
  node-pty: true
  protobufjs: false
"@ | Set-Content -LiteralPath $wsFile -Encoding UTF8
  }

  Push-Location $DSH_CLI_HOME
  try {
    & pnpm add $spec
    if ($LASTEXITCODE -ne 0) { throw "pnpm add $spec 失败 ($LASTEXITCODE)" }
  } finally {
    Pop-Location
  }

  $dshTarget = Join-Path $DSH_CLI_HOME 'node_modules\.bin\dsh.cmd'
  if (-not (Test-Path -LiteralPath $dshTarget)) {
    throw "安装 $spec 后未找到 $dshTarget"
  }

  $dshWrapper = Join-Path $DSH_BIN_DIR 'dsh.cmd'
  "@echo off`r`ncall `"$dshTarget`" %*`r`n" | Set-Content -LiteralPath $dshWrapper -Encoding ASCII
  Add-ToUserPath $DSH_BIN_DIR

  $ver = Normalize-Version ((& $dshWrapper --version 2>$null | Select-Object -First 1) -as [string])
  if (-not (Test-DshVersionCompatible $ver)) {
    throw "已安装的 DSH CLI 版本 ($ver) 不满足插件兼容范围 >= ${MIN_DSH_VERSION} < ${MAX_DSH_VERSION_EXCLUSIVE}。"
  }
  Write-Ok "DSH CLI 安装完成: v$ver -> $dshWrapper"
  return [PSCustomObject]@{ Bin = $dshWrapper; Version = $ver; IsDesktop = $false }
}

function Install-WebEdition($DshInfo) {
  Write-Step '安装 Web 版（DSH CLI + 插件）'

  $needInstall = $false
  if (-not $DshInfo) { $needInstall = $true }
  elseif ($UpgradeDsh) { $needInstall = $true }
  elseif (-not (Test-DshVersionCompatible $DshInfo.Version)) {
    Write-Warn "检测到现有 DSH CLI 版本 ($($DshInfo.Version)) 低于 ${MIN_DSH_VERSION}，将安装独立兼容版。"
    $needInstall = $true
  }

  if ($needInstall) {
    $DshInfo = Install-StandaloneDshCli
  } else {
    Write-Ok "复用现有 DSH CLI: v$($DshInfo.Version) ($($DshInfo.Bin))"
    if (-not $DshInfo.IsDesktop) {
      Ensure-NodeForWeb
      Ensure-PnpmForWeb
    }
  }

  $lockFile = Join-Path $DshHome 'lark-bridge\bridge.lock'
  if (Test-Path -LiteralPath $lockFile) {
    Write-Warn "检测到 $DshHome 下可能有正在运行的飞书桥接实例；安装完成后请先优雅排空（lark-bridge lifecycle drain --wait）再重启 Web 服务，日常升级可直接运行 lark-bridge plugin update all。"
  }

  Install-PluginsIntoProfile $DshInfo.Bin $Profile 'Web'
}

# ---------------------------------------------------------------------------
# Desktop App edition (Windows)
# ---------------------------------------------------------------------------
function Stop-DesktopAppGracefully {
  $procs = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) { return }

  Write-Info '正在优雅退出运行中的 DeepSeek Harness Desktop...'
  if ($DryRun) {
    Write-Info '[DRY-RUN] 关闭 DeepSeek Harness 进程'
    return
  }

  foreach ($p in $procs) {
    try { $null = $p.CloseMainWindow() } catch {}
  }
  for ($i = 0; $i -lt 20; $i++) {
    $alive = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
    if ($alive.Count -eq 0) {
      Write-Ok 'DeepSeek Harness Desktop 已退出。'
      return
    }
    Start-Sleep -Seconds 1
  }

  if (-not $Yes) {
    Write-Warn 'DeepSeek Harness Desktop 仍在运行，请先从系统托盘右键退出应用后按回车继续。'
    Read-Host '退出完成后按回车继续' | Out-Null
    if (@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count -eq 0) {
      return
    }
  }
  throw 'DeepSeek Harness Desktop 仍在运行，请先完全退出应用后再重试。'
}

function Download-AndInstallDesktopAppWindows {
  if ($DryRun) {
    Write-Info "[DRY-RUN] 将下载 $DESKTOP_WIN_EXE_URL 并静默安装 DeepSeek Harness Desktop"
    $defaultDir = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'
    return [PSCustomObject]@{
      Dir = $defaultDir
      Exe = Join-Path $defaultDir 'DeepSeek Harness.exe'
      Cli = Join-Path $defaultDir 'resources\runtime\cli\bin\dsh.cmd'
      Version = $MIN_DSH_VERSION
    }
  }

  Stop-DesktopAppGracefully

  $tmpDir = Join-Path ([IO.Path]::GetTempPath()) ("dsh-install-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
  $exeFile = Join-Path $tmpDir 'dsh-latest-windows-x64.exe'
  try {
    Write-Info "正在下载 DeepSeek Harness Desktop (Windows): $DESKTOP_WIN_EXE_URL"
    Invoke-WebRequest -Uri $DESKTOP_WIN_EXE_URL -OutFile $exeFile -UseBasicParsing

    Write-Info '正在静默安装 DeepSeek Harness Desktop...'
    $proc = Start-Process -FilePath $exeFile -ArgumentList '/S' -Wait -PassThru
    if ($proc.ExitCode -ne 0) {
      Write-Warn "静默安装退出码 $($proc.ExitCode)，尝试以图形向导继续安装..."
      $proc = Start-Process -FilePath $exeFile -Wait -PassThru
      if ($proc.ExitCode -ne 0) { throw "DeepSeek Harness Desktop 安装失败（退出码 $($proc.ExitCode)）" }
    }
  } finally {
    Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  }

  $app = Find-DesktopApp
  if (-not $app) {
    throw '安装程序已结束，但未找到 DeepSeek Harness.exe。请确认安装目录或通过 $env:DSH_DESKTOP_APP 指定路径后重试。'
  }
  Write-Ok "DeepSeek Harness Desktop 安装完成: v$($app.Version) ($($app.Dir))"
  return $app
}

function Ensure-DesktopProfileInitialized($AppInfo) {
  $desktopPkg = Join-Path $DshHome 'profiles\desktop\package.json'
  if (Test-Path -LiteralPath $desktopPkg) { return }

  Write-Info '首次检测到 Desktop profile 尚未初始化，正在自动启动一次应用完成初始化...'
  if ($DryRun) {
    Write-Info "[DRY-RUN] 启动 $($AppInfo.Exe) -> 等待 $desktopPkg 生成 -> 退出应用"
    return
  }

  $prevDshHome = $env:DSH_HOME
  try {
    $env:DSH_HOME = $DshHome
    Start-Process -FilePath $AppInfo.Exe | Out-Null
  } finally {
    if ($null -eq $prevDshHome) { Remove-Item Env:\DSH_HOME -ErrorAction SilentlyContinue }
    else { $env:DSH_HOME = $prevDshHome }
  }

  for ($i = 0; $i -lt 45; $i++) {
    if (Test-Path -LiteralPath $desktopPkg) { break }
    Start-Sleep -Seconds 1
  }
  if (-not (Test-Path -LiteralPath $desktopPkg)) {
    throw '等待 Desktop 初始化 profile 超时（45s）。请手动打开一次 DeepSeek Harness 并从托盘退出后重试。'
  }

  Start-Sleep -Seconds 2
  Write-Ok 'Desktop profile 初始化完成。'
  Stop-DesktopAppGracefully
}

function Install-AppEdition($AppInfo) {
  Write-Step '安装 Desktop App 版（DeepSeek Harness + 插件）'

  $needInstall = $false
  if (-not $AppInfo) { $needInstall = $true }
  elseif ($UpgradeDsh) { $needInstall = $true }
  elseif (-not (Test-DshVersionCompatible $AppInfo.Version)) {
    Write-Warn "检测到现有 Desktop App 版本 ($($AppInfo.Version)) 低于 ${MIN_DSH_VERSION}，将下载最新安装包更新。"
    $needInstall = $true
  }

  if ($needInstall) {
    $AppInfo = Download-AndInstallDesktopAppWindows
  } else {
    Write-Ok "复用现有 DeepSeek Harness Desktop: v$($AppInfo.Version) ($($AppInfo.Dir))"
  }

  if (-not $DryRun) {
    if (-not (Test-DshVersionCompatible $AppInfo.Version)) {
      throw "当前安装的 Desktop App 版本 ($($AppInfo.Version)) 不满足插件最低版本要求 (>= $MIN_DSH_VERSION < $MAX_DSH_VERSION_EXCLUSIVE)。请升级 Desktop App 或改用 -Mode web。"
    }
  }

  Ensure-DesktopProfileInitialized $AppInfo
  Stop-DesktopAppGracefully
  Install-PluginsIntoProfile $AppInfo.Cli 'desktop' 'Desktop App'
  return $AppInfo
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
$nodeVer = Get-NodeVersion
$pnpmVer = Get-PnpmVersion
$dshInfo = Find-DshCli
$appInfo = Find-DesktopApp

Write-Step '环境检测结果'
Write-Host "  系统平台       : Windows ($env:PROCESSOR_ARCHITECTURE)"
Write-Host "  DSH 数据目录   : $DshHome"
Write-Host "  Node.js        : $(if ($nodeVer) { "v$nodeVer" } else { '未安装 (仅 Web 版需要)' })"
Write-Host "  pnpm           : $(if ($pnpmVer) { "v$pnpmVer" } else { '未安装 (仅 Web 版需要)' })"
Write-Host "  DSH Web CLI    : $(if ($dshInfo) { "$($dshInfo.Version) ($($dshInfo.Bin))" } else { '未安装' })"
Write-Host "  DSH Desktop App: $(if ($appInfo) { "$($appInfo.Version) ($($appInfo.Dir))" } else { '未安装' })"

$webDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$deskDir = Join-Path (Join-Path $DshHome 'profiles') 'desktop'
$wb = Get-InstalledPluginVersion $webDir $BRIDGE_PKG
$we = Get-InstalledPluginVersion $webDir $EXT_PKG
$db = Get-InstalledPluginVersion $deskDir $BRIDGE_PKG
$de = Get-InstalledPluginVersion $deskDir $EXT_PKG
Write-Host "  Web 插件状态   : 飞书桥接=$(if ($wb) { $wb } else { '未安装' })  外部运行时=$(if ($we) { $we } else { '未安装' })"
Write-Host "  App 插件状态   : 飞书桥接=$(if ($db) { $db } else { '未安装' })  外部运行时=$(if ($de) { $de } else { '未安装' })"

if ($Mode -eq 'auto') {
  $defaultChoice = '1'
  $defaultMode = 'app'
  if ($appInfo -and $dshInfo -and -not $dshInfo.IsDesktop) {
    $defaultChoice = '3'; $defaultMode = 'both'
  } elseif (-not $appInfo -and $dshInfo) {
    $defaultChoice = '2'; $defaultMode = 'web'
  }

  if ($Yes) {
    $Mode = $defaultMode
    Write-Info "非交互模式自动选择: $Mode"
  } else {
    Write-Host ''
    Write-Host '请选择要安装的 DSH 版本:'
    Write-Host '  1) Desktop App 版（桌面客户端，自带 Node/pnpm 运行时，开箱即用）'
    Write-Host '  2) Web 版（命令行 / 局域网 / 服务器后台常驻）'
    Write-Host '  3) 两版都安装（Desktop App + Web）'
    $ans = Read-Host "请输入选项 [1-3]（默认 ${defaultChoice}）"
    if ([string]::IsNullOrWhiteSpace($ans)) { $ans = $defaultChoice }
    switch ($ans.Trim().ToLowerInvariant()) {
      '1'       { $Mode = 'app' }
      'app'     { $Mode = 'app' }
      'desktop' { $Mode = 'app' }
      '2'       { $Mode = 'web' }
      'web'     { $Mode = 'web' }
      '3'       { $Mode = 'both' }
      'both'    { $Mode = 'both' }
      'all'     { $Mode = 'both' }
      default   { throw "无效选项: $ans" }
    }
  }
}

switch ($Mode) {
  'web' {
    Install-WebEdition $dshInfo
  }
  'app' {
    $appInfo = Install-AppEdition $appInfo
  }
  'both' {
    $appInfo = Install-AppEdition $appInfo
    Install-WebEdition $dshInfo
  }
}

Write-Step '安装完成'
if ($DryRun) {
  Write-Info '以上为 -DryRun 演练结果，未对系统执行实际修改。'
  exit 0
}

if ($Mode -eq 'app' -or $Mode -eq 'both') {
  Write-Host ''
  Write-Host '[Desktop App 版]' -ForegroundColor White
  Write-Host "  1. 启动应用: `"$($appInfo.Exe)`""
  Write-Host '  2. 在左侧边栏点击「飞书桥接」，按引导扫码创建飞书智能体即可使用。'
  if (-not $WithoutExternalAgents) {
    Write-Host '  3. 已自动安装外部运行时插件（Codex / Antigravity / Claude Code / TRAE），启动后可直接选用。'
  }
  $shouldLaunch = $false
  if ($Launch) { $shouldLaunch = $true }
  elseif (-not $NoLaunch -and -not $Yes) {
    $ans = Read-Host '是否立即启动 DeepSeek Harness Desktop？[Y/n]'
    if ([string]::IsNullOrWhiteSpace($ans) -or $ans -match '^[yY]') { $shouldLaunch = $true }
  }
  if ($shouldLaunch -and $appInfo -and (Test-Path -LiteralPath $appInfo.Exe)) {
    Write-Info '正在启动 DeepSeek Harness Desktop...'
    Start-Process -FilePath $appInfo.Exe | Out-Null
  }
}

if ($Mode -eq 'web' -or $Mode -eq 'both') {
  Write-Host ''
  Write-Host '[Web 版]' -ForegroundColor White
  if ($Profile -eq 'web') {
    Write-Host '  1. 本机启动  : dsh web'
    Write-Host '  2. 局域网常驻: dsh --profile web --no-open --host <本机IPv4> --port 3880'
  } else {
    Write-Host "  1. 启动命令  : dsh --profile $Profile"
  }
  Write-Host '  3. 后续免重启热更新插件: lark-bridge plugin update all'
}
