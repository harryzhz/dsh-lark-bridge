#!/usr/bin/env bash
# DeepSeek Harness (DSH) + dsh-lark-bridge + dsh-external-agents one-click installer
# Supports macOS (Desktop App & Web) and Linux (Web).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/harryzhz/dsh-lark-bridge/main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/harryzhz/dsh-lark-bridge/main/scripts/install.sh | bash -s -- --mode web
#   curl -fsSL https://raw.githubusercontent.com/harryzhz/dsh-lark-bridge/main/scripts/install.sh | bash -s -- --mode app
#   curl -fsSL https://raw.githubusercontent.com/harryzhz/dsh-lark-bridge/main/scripts/install.sh | bash -s -- --mode both

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
MIN_NODE_VERSION="22.13.0"
MIN_DSH_VERSION="0.2.2-rc.5"
MAX_DSH_VERSION_EXCLUSIVE="0.3.0"

DSH_NPM_PACKAGE="@deepseek-ai/dsh"
DESKTOP_DMG_ARM64_URL="https://download.deepseek.com/desktop/dsh-latest-macos-arm64.dmg"
DESKTOP_DMG_X64_URL="https://download.deepseek.com/desktop/dsh-latest-macos-x64.dmg"

BRIDGE_PKG="@harryzhz/dsh-lark-bridge"
BRIDGE_REPO="harryzhz/dsh-lark-bridge"
BRIDGE_ASSET_PREFIX="harryzhz-dsh-lark-bridge-"
BRIDGE_ALIAS_ASSET="dsh-lark-bridge.tgz"

EXT_PKG="@harryzhz/dsh-external-agents"
EXT_REPO="harryzhz/dsh-external-agents"
EXT_ASSET_PREFIX="harryzhz-dsh-external-agents-"
EXT_ALIAS_ASSET="dsh-external-agents.tgz"

# ---------------------------------------------------------------------------
# Runtime options (can be configured by flags or environment variables)
# ---------------------------------------------------------------------------
MODE="${DSH_INSTALL_MODE:-auto}"
WEB_PROFILE="${DSH_WEB_PROFILE:-web}"
WEB_HOST="${DSH_WEB_HOST:-auto}"
WEB_HOST_EXPLICIT=0
if [ -n "${DSH_WEB_HOST:-}" ]; then
  WEB_HOST_EXPLICIT=1
fi
INSTALL_EXTERNAL_AGENTS=1
BRIDGE_VERSION="${DSH_BRIDGE_VERSION:-}"
EXT_VERSION="${DSH_EXTERNAL_AGENTS_VERSION:-}"
DSH_VERSION="${DSH_VERSION:-latest}"
UPGRADE_DSH=0
FORCE_REINSTALL=0
AUTO_YES=0
DRY_RUN=0
LAUNCH_APP="auto" # auto | yes | no
GITHUB_PROXY="${GITHUB_PROXY:-}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
DSH_CLI_HOME="${DSH_CLI_HOME:-$HOME/.local/share/dsh}"
DSH_BIN_DIR="${DSH_BIN_DIR:-$HOME/.local/bin}"
DSH_DESKTOP_APP_OVERRIDE="${DSH_DESKTOP_APP:-}"

# Runtime detection state
HOST_OS=""
HOST_ARCH=""
DETECTED_NODE_VER=""
DETECTED_PNPM_VER=""
DETECTED_DSH_BIN=""
DETECTED_DSH_VER=""
DETECTED_DSH_IS_DESKTOP=0
DETECTED_APP_PATH=""
DETECTED_APP_VER=""
DETECTED_APP_CLI=""
DETECTED_LAN_IPV4=""
DETECTED_LAN_IPV4_CHECKED=0

# Cleanup tracking
TMP_DIR=""
MOUNTED_DMG_DIR=""
PATH_HINT_NEEDED=0

# Resolved release URLs cache
RESOLVED_BRIDGE_VER=""
RESOLVED_BRIDGE_URL=""
RESOLVED_EXT_VER=""
RESOLVED_EXT_URL=""

# ---------------------------------------------------------------------------
# Logging & formatting
# ---------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'
  C_CYAN=$'\033[36m'
  C_RESET=$'\033[0m'
else
  C_BOLD=""
  C_DIM=""
  C_GREEN=""
  C_YELLOW=""
  C_RED=""
  C_CYAN=""
  C_RESET=""
fi

log_info() {
  printf '%s[INFO]%s %s\n' "$C_CYAN" "$C_RESET" "$*"
}

log_ok() {
  printf '%s[OK]%s   %s\n' "$C_GREEN" "$C_RESET" "$*"
}

log_warn() {
  printf '%s[WARN]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2
}

log_err() {
  printf '%s[ERR]%s  %s\n' "$C_RED" "$C_RESET" "$*" >&2
}

log_step() {
  printf '\n%s==> %s%s\n' "$C_BOLD" "$*" "$C_RESET"
}

die() {
  log_err "$*"
  exit 1
}

cleanup() {
  local rc=$?
  if [ -n "$MOUNTED_DMG_DIR" ] && [ -d "$MOUNTED_DMG_DIR" ]; then
    hdiutil detach "$MOUNTED_DMG_DIR" -quiet >/dev/null 2>&1 || \
      hdiutil detach "$MOUNTED_DMG_DIR" -force -quiet >/dev/null 2>&1 || true
    MOUNTED_DMG_DIR=""
  fi
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR" >/dev/null 2>&1 || true
    TMP_DIR=""
  fi
  return "$rc"
}

trap cleanup EXIT

ensure_tmp_dir() {
  if [ -z "$TMP_DIR" ]; then
    TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dsh-install.XXXXXX")"
  fi
}

usage() {
  cat <<'EOF'
DeepSeek Harness (DSH) + 飞书桥接 & 外部 Agent 运行时 一键安装脚本

用法:
  install.sh [选项]

选项:
  --mode <auto|web|app|both>   安装版本（默认: auto，交互终端下提示选择）
  --web                        等同于 --mode web（独立 DSH Web CLI 服务）
  --app                        等同于 --mode app（DSH Desktop 桌面客户端，仅 macOS）
  --both                       等同于 --mode both（同时安装 Desktop App 与 Web）
  --profile <name>             Web 版目标 profile 名称（默认: web）
  --web-host <auto|loopback|IP> Web 版默认监听地址（默认: auto，启动时自动绑定本机局域网 IPv4，离线回退 127.0.0.1）
  --without-external-agents    仅安装 dsh-lark-bridge，不安装 dsh-external-agents
  --bridge-version <vX.Y.Z>    指定 dsh-lark-bridge 版本（默认最新 Release）
  --external-agents-version <v> 指定 dsh-external-agents 版本（默认最新 Release）
  --dsh-version <ver>          指定 Web 版 @deepseek-ai/dsh 版本（默认: latest）
  --upgrade-dsh                即使已安装兼容版 DSH 也升级/覆盖安装最新版本
  --force                      即使插件已是目标版本也强制重新安装
  --github-proxy <prefix>      可选 GitHub 下载前缀（如 https://mirror.example.com/）
  --dsh-home <path>            指定 DSH_HOME 目录（默认: ~/.dsh）
  --launch                     Desktop App 安装完成后自动打开应用
  --no-launch                  Desktop App 安装完成后不自动打开应用
  -y, --yes                    非交互模式，自动确认所有提示
  --dry-run                    仅检测环境并打印安装计划，不实际下载或修改
  -h, --help                   显示帮助信息

示例:
  # 交互式引导（自动检测并选择 Desktop App / Web / 两版都装）
  curl -fsSL https://raw.githubusercontent.com/harryzhz/dsh-lark-bridge/main/scripts/install.sh | bash

  # 直接安装 Desktop App + 双插件（macOS）
  curl -fsSL https://raw.githubusercontent.com/harryzhz/dsh-lark-bridge/main/scripts/install.sh | bash -s -- --mode app

  # 直接安装 Web 版 + 双插件（macOS / Linux）
  curl -fsSL https://raw.githubusercontent.com/harryzhz/dsh-lark-bridge/main/scripts/install.sh | bash -s -- --mode web

  # 同时安装 Desktop App 与 Web 两版
  curl -fsSL https://raw.githubusercontent.com/harryzhz/dsh-lark-bridge/main/scripts/install.sh | bash -s -- --mode both
EOF
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --mode)
        [ "$#" -ge 2 ] || die "--mode 需要参数: auto | web | app | both"
        MODE="$2"
        shift 2
        ;;
      --mode=*)
        MODE="${1#*=}"
        shift
        ;;
      --web)
        MODE="web"
        shift
        ;;
      --app)
        MODE="app"
        shift
        ;;
      --both)
        MODE="both"
        shift
        ;;
      --profile)
        [ "$#" -ge 2 ] || die "--profile 需要 profile 名称"
        WEB_PROFILE="$2"
        shift 2
        ;;
      --profile=*)
        WEB_PROFILE="${1#*=}"
        shift
        ;;
      --web-host)
        [ "$#" -ge 2 ] || die "--web-host 需要参数: auto | loopback | 具体本机 IPv4/IPv6 地址"
        WEB_HOST="$2"
        WEB_HOST_EXPLICIT=1
        shift 2
        ;;
      --web-host=*)
        WEB_HOST="${1#*=}"
        WEB_HOST_EXPLICIT=1
        shift
        ;;
      --without-external-agents|--no-external-agents)
        INSTALL_EXTERNAL_AGENTS=0
        shift
        ;;
      --bridge-version)
        [ "$#" -ge 2 ] || die "--bridge-version 需要版本号"
        BRIDGE_VERSION="$2"
        shift 2
        ;;
      --bridge-version=*)
        BRIDGE_VERSION="${1#*=}"
        shift
        ;;
      --external-agents-version)
        [ "$#" -ge 2 ] || die "--external-agents-version 需要版本号"
        EXT_VERSION="$2"
        shift 2
        ;;
      --external-agents-version=*)
        EXT_VERSION="${1#*=}"
        shift
        ;;
      --dsh-version)
        [ "$#" -ge 2 ] || die "--dsh-version 需要版本号"
        DSH_VERSION="$2"
        shift 2
        ;;
      --dsh-version=*)
        DSH_VERSION="${1#*=}"
        shift
        ;;
      --upgrade-dsh)
        UPGRADE_DSH=1
        shift
        ;;
      --force)
        FORCE_REINSTALL=1
        shift
        ;;
      --github-proxy)
        [ "$#" -ge 2 ] || die "--github-proxy 需要镜像前缀 URL"
        GITHUB_PROXY="$2"
        shift 2
        ;;
      --github-proxy=*)
        GITHUB_PROXY="${1#*=}"
        shift
        ;;
      --dsh-home)
        [ "$#" -ge 2 ] || die "--dsh-home 需要路径"
        DSH_HOME_DIR="$2"
        shift 2
        ;;
      --dsh-home=*)
        DSH_HOME_DIR="${1#*=}"
        shift
        ;;
      --launch)
        LAUNCH_APP="yes"
        shift
        ;;
      --no-launch)
        LAUNCH_APP="no"
        shift
        ;;
      -y|--yes)
        AUTO_YES=1
        shift
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "未知参数: ${1}（使用 --help 查看用法）"
        ;;
    esac
  done

  case "$MODE" in
    auto|web|app|both) ;;
    *) die "无效的 --mode 值: ${MODE}（可选: auto | web | app | both）" ;;
  esac

  if [ -z "$WEB_PROFILE" ] || [ "$WEB_PROFILE" = "desktop" ]; then
    die "无效的 Web profile: ${WEB_PROFILE:-<empty>}（desktop profile 由 --mode app 托管）"
  fi

  validate_web_host "$WEB_HOST"
}

is_valid_ipv4() {
  local ip="$1"
  [[ "$ip" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  local o1="${BASH_REMATCH[1]}" o2="${BASH_REMATCH[2]}" o3="${BASH_REMATCH[3]}" o4="${BASH_REMATCH[4]}"
  [ "$((10#$o1))" -le 255 ] && [ "$((10#$o2))" -le 255 ] && [ "$((10#$o3))" -le 255 ] && [ "$((10#$o4))" -le 255 ]
}

is_wildcard_ip() {
  local lower
  lower="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in
    0.0.0.0|::|::0|0:0:0:0:0:0:0:0|::ffff:0.0.0.0|::ffff:0:0|0:0:0:0:0:ffff:0.0.0.0|0:0:0:0:0:ffff:0:0)
      return 0
      ;;
  esac
  return 1
}

is_valid_ip_literal() {
  local ip="$1"
  if is_valid_ipv4 "$ip"; then
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    node -e "process.exit(require('node:net').isIP(process.argv[1]) !== 0 ? 0 : 1)" "$ip" 2>/dev/null
    return $?
  fi
  case "$ip" in
    *:*:*)
      [[ "$ip" =~ ^[0-9A-Fa-f:.]+$ ]] && return 0
      ;;
  esac
  return 1
}

validate_web_host() {
  local raw="${1:-}"
  case "$raw" in
    auto|loopback)
      return 0
      ;;
  esac
  if [ -z "$raw" ] || is_wildcard_ip "$raw" || ! is_valid_ip_literal "$raw"; then
    die "无效的 --web-host 值: ${raw:-<empty>}（可选: auto | loopback | 具体本机 IPv4/IPv6 地址，不支持 0.0.0.0 / :: 或域名）"
  fi
}

detect_local_lan_ipv4() {
  if [ "$DETECTED_LAN_IPV4_CHECKED" -eq 1 ]; then
    printf '%s' "$DETECTED_LAN_IPV4"
    return 0
  fi
  DETECTED_LAN_IPV4_CHECKED=1
  if command -v node >/dev/null 2>&1; then
    DETECTED_LAN_IPV4="$(node -e '
const ifaces = require("node:os").networkInterfaces();
const virtRe = /^(lo|utun|tun|tap|wg|docker|br-|veth|virbr|tailscale|zt|awdl|llw|bridge|anpi|ap|gif|stf|ipsec|feth|vethernet|vmware|virtualbox|loopback|clash|mihomo|meta|wintun|openvpn|bluetooth)/i;
const picks = [];
for (const [name, list] of Object.entries(ifaces)) {
  const virt = virtRe.test(name);
  for (const a of list || []) {
    if ((a.family !== "IPv4" && a.family !== 4) || a.internal) continue;
    if (a.address.startsWith("169.254.") || /^198\.(18|19)\./.test(a.address)) continue;
    const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
    picks.push({ ip: a.address, score: (virt ? 2 : 0) + (priv ? 0 : 1) });
  }
}
picks.sort((a, b) => a.score - b.score);
if (picks[0]) process.stdout.write(picks[0].ip);
' 2>/dev/null || true)"
  fi
  printf '%s' "$DETECTED_LAN_IPV4"
}

# ---------------------------------------------------------------------------
# SemVer 2.0.0 comparison helpers (zero-fork pure Bash 3.2)
# ---------------------------------------------------------------------------
normalize_version() {
  local raw="${1:-}"
  raw="${raw//$'\r'/}"
  raw="${raw//$'\n'/ }"
  if [[ "$raw" =~ ([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

# Prints -1 if a < b, 0 if a == b, 1 if a > b
semver_compare() {
  local a="${1#v}" b="${2#v}"
  a="${a#V}"; a="${a%%+*}"
  b="${b#V}"; b="${b%%+*}"

  local acore="$a" apre="" bcore="$b" bpre=""
  case "$a" in
    *-*) acore="${a%%-*}"; apre="${a#*-}" ;;
  esac
  case "$b" in
    *-*) bcore="${b%%-*}"; bpre="${b#*-}" ;;
  esac

  local IFS='.'
  local -a ac bc
  read -r -a ac <<< "$acore"
  read -r -a bc <<< "$bcore"

  local i av bv
  for i in 0 1 2; do
    av="${ac[$i]:-0}"; bv="${bc[$i]:-0}"
    av=$((10#$av)); bv=$((10#$bv))
    if [ "$av" -lt "$bv" ]; then printf '%s' "-1"; return 0; fi
    if [ "$av" -gt "$bv" ]; then printf '%s' "1"; return 0; fi
  done

  if [ -z "$apre" ] && [ -z "$bpre" ]; then printf '%s' "0"; return 0; fi
  if [ -z "$apre" ]; then printf '%s' "1"; return 0; fi
  if [ -z "$bpre" ]; then printf '%s' "-1"; return 0; fi

  local -a ap bp
  read -r -a ap <<< "$apre"
  read -r -a bp <<< "$bpre"

  local na="${#ap[@]}" nb="${#bp[@]}" n an bn
  n="$na"; if [ "$nb" -gt "$n" ]; then n="$nb"; fi

  for ((i = 0; i < n; i++)); do
    if [ "$i" -ge "$na" ]; then printf '%s' "-1"; return 0; fi
    if [ "$i" -ge "$nb" ]; then printf '%s' "1"; return 0; fi

    an=0; bn=0
    case "${ap[$i]}" in ''|*[!0-9]*) ;; *) an=1 ;; esac
    case "${bp[$i]}" in ''|*[!0-9]*) ;; *) bn=1 ;; esac

    if [ "$an" -eq 1 ] && [ "$bn" -eq 1 ]; then
      av=$((10#${ap[$i]})); bv=$((10#${bp[$i]}))
      if [ "$av" -lt "$bv" ]; then printf '%s' "-1"; return 0; fi
      if [ "$av" -gt "$bv" ]; then printf '%s' "1"; return 0; fi
    elif [ "$an" -eq 1 ] && [ "$bn" -eq 0 ]; then
      printf '%s' "-1"; return 0
    elif [ "$an" -eq 0 ] && [ "$bn" -eq 1 ]; then
      printf '%s' "1"; return 0
    else
      if [[ "${ap[$i]}" < "${bp[$i]}" ]]; then printf '%s' "-1"; return 0; fi
      if [[ "${ap[$i]}" > "${bp[$i]}" ]]; then printf '%s' "1"; return 0; fi
    fi
  done

  printf '%s' "0"
}

semver_gte() {
  local cmp
  cmp="$(semver_compare "$1" "$2")"
  [ "$cmp" -ge 0 ]
}

semver_lt() {
  local cmp
  cmp="$(semver_compare "$1" "$2")"
  [ "$cmp" -lt 0 ]
}

dsh_version_compatible() {
  local ver
  ver="$(normalize_version "${1:-}")"
  [ -n "$ver" ] || return 1
  semver_gte "$ver" "$MIN_DSH_VERSION" && semver_lt "$ver" "$MAX_DSH_VERSION_EXCLUSIVE"
}

node_version_compatible() {
  local ver
  ver="$(normalize_version "${1:-}")"
  [ -n "$ver" ] || return 1
  semver_gte "$ver" "$MIN_NODE_VERSION"
}

# ---------------------------------------------------------------------------
# Platform & environment detection
# ---------------------------------------------------------------------------
can_prompt() {
  [ "$AUTO_YES" -eq 0 ] && [ -t 1 ] && [ -r /dev/tty ]
}

prompt_read() {
  local prompt_text="$1"
  local reply=""
  printf '%s' "$prompt_text" >&2
  if ! IFS= read -r reply </dev/tty; then
    reply=""
  fi
  printf '%s' "$reply"
}

detect_platform() {
  local uname_s uname_m
  uname_s="$(uname -s)"
  uname_m="$(uname -m)"

  case "$uname_s" in
    Darwin) HOST_OS="macos" ;;
    Linux)  HOST_OS="linux" ;;
    *)
      die "当前系统 ($uname_s) 不受 install.sh 支持。Windows 用户请使用 PowerShell 脚本 scripts/install.ps1。"
      ;;
  esac

  case "$uname_m" in
    arm64|aarch64) HOST_ARCH="arm64" ;;
    x86_64|amd64)  HOST_ARCH="x64" ;;
    *)
      die "暂不支持当前 CPU 架构: $uname_m"
      ;;
  esac
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少必需命令: $1，请先安装后重试。"
}

# Read "version" field from a package.json without requiring jq or node
read_pkg_json_version() {
  local file="$1"
  [ -f "$file" ] || return 0
  if command -v node >/dev/null 2>&1; then
    node -e "try{const p=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));if(p.version)process.stdout.write(String(p.version))}catch{}" "$file" 2>/dev/null || true
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys
try:
  d=json.load(open(sys.argv[1], encoding="utf-8"))
  if d.get("version"): sys.stdout.write(str(d["version"]))
except Exception: pass' "$file" 2>/dev/null || true
    return 0
  fi
  sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$file" | head -n 1
}

# Check whether package name is listed in dsh.profile.bundles and dependencies
profile_has_bundle() {
  local profile_dir="$1"
  local pkg_name="$2"
  local pkg_json="$profile_dir/package.json"
  [ -f "$pkg_json" ] || return 1

  if command -v node >/dev/null 2>&1; then
    node -e "
      const fs = require('fs');
      const p = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
      const pkg = process.argv[2];
      const hasDep = Boolean(p.dependencies && p.dependencies[pkg]);
      const bundles = Array.isArray(p.dsh && p.dsh.profile && p.dsh.profile.bundles) ? p.dsh.profile.bundles : [];
      process.exit(hasDep && bundles.includes(pkg) ? 0 : 1);
    " "$pkg_json" "$pkg_name" 2>/dev/null
    return $?
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys
p=json.load(open(sys.argv[1], encoding="utf-8"))
pkg=sys.argv[2]
deps=p.get("dependencies") or {}
bundles=((p.get("dsh") or {}).get("profile") or {}).get("bundles") or []
sys.exit(0 if (pkg in deps and pkg in bundles) else 1)' "$pkg_json" "$pkg_name" 2>/dev/null
    return $?
  fi
  grep -Fq "\"$pkg_name\"" "$pkg_json"
}

get_installed_plugin_version() {
  local profile_dir="$1"
  local pkg_name="$2"
  local pkg_file="$profile_dir/node_modules/$pkg_name/package.json"
  if [ -f "$pkg_file" ]; then
    normalize_version "$(read_pkg_json_version "$pkg_file")"
  fi
}

detect_node() {
  DETECTED_NODE_VER=""
  if command -v node >/dev/null 2>&1; then
    DETECTED_NODE_VER="$(normalize_version "$(node -v 2>/dev/null || true)")"
  fi
}

detect_pnpm() {
  DETECTED_PNPM_VER=""
  if command -v pnpm >/dev/null 2>&1; then
    DETECTED_PNPM_VER="$(normalize_version "$(pnpm --version 2>/dev/null || true)")"
  elif [ -x "$DSH_BIN_DIR/pnpm" ]; then
    DETECTED_PNPM_VER="$(normalize_version "$("$DSH_BIN_DIR/pnpm" --version 2>/dev/null || true)")"
  fi
}

detect_desktop_app() {
  DETECTED_APP_PATH=""
  DETECTED_APP_VER=""
  DETECTED_APP_CLI=""

  [ "$HOST_OS" = "macos" ] || return 0

  local candidates=()
  if [ -n "$DSH_DESKTOP_APP_OVERRIDE" ]; then
    candidates+=("$DSH_DESKTOP_APP_OVERRIDE")
  fi
  candidates+=("/Applications/DeepSeek Harness.app")
  candidates+=("$HOME/Applications/DeepSeek Harness.app")

  local app=""
  for app in "${candidates[@]}"; do
    if [ -d "$app" ] && [ -x "$app/Contents/Resources/runtime/cli/bin/dsh" ]; then
      DETECTED_APP_PATH="$app"
      DETECTED_APP_CLI="$app/Contents/Resources/runtime/cli/bin/dsh"
      break
    fi
  done

  if [ -n "$DETECTED_APP_PATH" ]; then
    local plist="$DETECTED_APP_PATH/Contents/Info.plist"
    if [ -f "$plist" ] && command -v defaults >/dev/null 2>&1; then
      DETECTED_APP_VER="$(normalize_version "$(defaults read "$plist" CFBundleShortVersionString 2>/dev/null || true)")"
    fi
    if [ -z "$DETECTED_APP_VER" ] && [ -x "$DETECTED_APP_CLI" ]; then
      DETECTED_APP_VER="$(normalize_version "$("$DETECTED_APP_CLI" --version 2>/dev/null || true)")"
    fi
  fi
}

detect_dsh_cli() {
  DETECTED_DSH_BIN=""
  DETECTED_DSH_VER=""
  DETECTED_DSH_IS_DESKTOP=0

  local candidate=""
  if [ -x "$DSH_BIN_DIR/dsh" ]; then
    candidate="$DSH_BIN_DIR/dsh"
  elif command -v dsh >/dev/null 2>&1; then
    candidate="$(command -v dsh)"
  fi

  if [ -n "$candidate" ]; then
    DETECTED_DSH_BIN="$candidate"
    DETECTED_DSH_VER="$(normalize_version "$("$candidate" --version 2>/dev/null || true)")"
    local resolved="$candidate"
    if [ -L "$candidate" ]; then
      resolved="$(readlink "$candidate" 2>/dev/null || printf '%s' "$candidate")"
    fi
    case "$resolved" in
      *"DeepSeek Harness.app"*) DETECTED_DSH_IS_DESKTOP=1 ;;
    esac
  fi
}

print_detection_summary() {
  log_step "环境检测结果"
  printf '  系统平台       : %s (%s)\n' "$HOST_OS" "$HOST_ARCH"
  printf '  DSH 数据目录   : %s\n' "$DSH_HOME_DIR"

  if [ -n "$DETECTED_NODE_VER" ]; then
    if node_version_compatible "$DETECTED_NODE_VER"; then
      printf '  Node.js        : %sv%s%s (兼容 >= %s)\n' "$C_GREEN" "$DETECTED_NODE_VER" "$C_RESET" "$MIN_NODE_VERSION"
    else
      printf '  Node.js        : %sv%s%s (低于最低要求 %s)\n' "$C_YELLOW" "$DETECTED_NODE_VER" "$C_RESET" "$MIN_NODE_VERSION"
    fi
  else
    printf '  Node.js        : %s未安装%s (仅 Web 版需要)\n' "$C_DIM" "$C_RESET"
  fi

  if [ -n "$DETECTED_PNPM_VER" ]; then
    printf '  pnpm           : %sv%s%s\n' "$C_GREEN" "$DETECTED_PNPM_VER" "$C_RESET"
  else
    printf '  pnpm           : %s未安装%s (仅 Web 版需要)\n' "$C_DIM" "$C_RESET"
  fi

  if [ -n "$DETECTED_DSH_BIN" ]; then
    local dsh_src=""
    if [ "$DETECTED_DSH_IS_DESKTOP" -eq 1 ]; then
      dsh_src=" [Desktop 内置]"
    fi
    if dsh_version_compatible "$DETECTED_DSH_VER"; then
      printf '  DSH Web CLI    : %s%s%s (%s)%s\n' "$C_GREEN" "${DETECTED_DSH_VER:-unknown}" "$C_RESET" "$DETECTED_DSH_BIN" "$dsh_src"
    else
      printf '  DSH Web CLI    : %s%s%s (%s，需 >= %s)%s\n' "$C_YELLOW" "${DETECTED_DSH_VER:-unknown}" "$C_RESET" "$DETECTED_DSH_BIN" "$MIN_DSH_VERSION" "$dsh_src"
    fi
  else
    printf '  DSH Web CLI    : %s未安装%s\n' "$C_DIM" "$C_RESET"
  fi

  if [ "$HOST_OS" = "macos" ]; then
    if [ -n "$DETECTED_APP_PATH" ]; then
      if dsh_version_compatible "$DETECTED_APP_VER"; then
        printf '  DSH Desktop App: %s%s%s (%s)\n' "$C_GREEN" "${DETECTED_APP_VER:-unknown}" "$C_RESET" "$DETECTED_APP_PATH"
      else
        printf '  DSH Desktop App: %s%s%s (%s，需 >= %s)\n' "$C_YELLOW" "${DETECTED_APP_VER:-unknown}" "$C_RESET" "$DETECTED_APP_PATH" "$MIN_DSH_VERSION"
      fi
    else
      printf '  DSH Desktop App: %s未安装%s\n' "$C_DIM" "$C_RESET"
    fi
  else
    printf '  DSH Desktop App: %sLinux 暂不提供桌面端，将使用 Web 版%s\n' "$C_DIM" "$C_RESET"
  fi

  local web_dir="$DSH_HOME_DIR/profiles/$WEB_PROFILE"
  local desk_dir="$DSH_HOME_DIR/profiles/desktop"
  local wb we db de
  wb="$(get_installed_plugin_version "$web_dir" "$BRIDGE_PKG")"
  we="$(get_installed_plugin_version "$web_dir" "$EXT_PKG")"
  printf '  Web 插件状态   : 飞书桥接=%s  外部运行时=%s\n' "${wb:-未安装}" "${we:-未安装}"
  if [ "$HOST_OS" = "macos" ]; then
    db="$(get_installed_plugin_version "$desk_dir" "$BRIDGE_PKG")"
    de="$(get_installed_plugin_version "$desk_dir" "$EXT_PKG")"
    printf '  App 插件状态   : 飞书桥接=%s  外部运行时=%s\n' "${db:-未安装}" "${de:-未安装}"
  fi
}

select_mode() {
  if [ "$HOST_OS" = "linux" ]; then
    if [ "$MODE" = "app" ]; then
      die "DeepSeek Harness Desktop 目前仅官方提供 macOS 与 Windows 版本，Linux 请改用 --mode web。"
    fi
    if [ "$MODE" = "both" ]; then
      log_warn "Linux 暂无官方 Desktop 客户端，已自动切换为 Web 版安装。"
    fi
    MODE="web"
    return 0
  fi

  if [ "$MODE" != "auto" ]; then
    return 0
  fi

  # Determine smart default on macOS
  local default_choice="1"
  local default_mode="app"
  if [ -n "$DETECTED_APP_PATH" ] && [ -n "$DETECTED_DSH_BIN" ] && [ "$DETECTED_DSH_IS_DESKTOP" -eq 0 ]; then
    default_choice="3"
    default_mode="both"
  elif [ -z "$DETECTED_APP_PATH" ] && [ -n "$DETECTED_DSH_BIN" ]; then
    default_choice="2"
    default_mode="web"
  fi

  if ! can_prompt; then
    MODE="$default_mode"
    log_info "非交互模式自动选择: $MODE"
    return 0
  fi

  printf '\n请选择要安装的 DSH 版本:\n' >&2
  printf '  1) Desktop App 版（桌面客户端，自带 Node/pnpm 运行时，开箱即用）\n' >&2
  printf '  2) Web 版（命令行 / 局域网 / 服务器后台常驻）\n' >&2
  printf '  3) 两版都安装（Desktop App + Web）\n' >&2
  local ans
  ans="$(prompt_read "请输入选项 [1-3]（默认 ${default_choice}）: ")"
  ans="${ans:-$default_choice}"
  case "$ans" in
    1|app|desktop) MODE="app" ;;
    2|web)         MODE="web" ;;
    3|both|all)    MODE="both" ;;
    *)             die "无效选项: $ans" ;;
  esac
}

# ---------------------------------------------------------------------------
# GitHub Release URL resolution (redirect-first to avoid GitHub API rate limits)
# ---------------------------------------------------------------------------
apply_github_proxy() {
  local url="$1"
  if [ -z "$GITHUB_PROXY" ]; then
    printf '%s' "$url"
    return 0
  fi
  local prefix="${GITHUB_PROXY%/}/"
  printf '%s%s' "$prefix" "$url"
}

resolve_github_latest_version() {
  local repo="$1"
  local latest_url="https://github.com/${repo}/releases/latest"
  local loc="" tag="" ver=""

  # Strategy 1: HEAD redirect (does not consume GitHub REST API rate limit)
  loc="$(curl -fsSI --max-time 15 "$latest_url" 2>/dev/null | awk 'BEGIN{IGNORECASE=1} /^location:/{print $2}' | tr -d '\r\n' | tail -n 1 || true)"
  if [ -n "$loc" ]; then
    tag="${loc##*/}"
    ver="$(normalize_version "$tag")"
    if [ -n "$ver" ]; then
      printf '%s' "$ver"
      return 0
    fi
  fi

  # Strategy 2: GitHub REST API fallback
  local api_json=""
  api_json="$(curl -fsSL --max-time 15 -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/${repo}/releases/latest" 2>/dev/null || true)"
  if [ -n "$api_json" ]; then
    tag="$(printf '%s' "$api_json" | sed -nE 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n 1)"
    ver="$(normalize_version "$tag")"
    if [ -n "$ver" ]; then
      printf '%s' "$ver"
      return 0
    fi
  fi

  return 1
}

resolve_plugin_releases() {
  if [ -n "$RESOLVED_BRIDGE_URL" ]; then
    return 0
  fi

  log_step "解析插件最新版本"
  local bver="" ever=""

  if [ -n "$BRIDGE_VERSION" ]; then
    bver="$(normalize_version "$BRIDGE_VERSION")"
    [ -n "$bver" ] || die "无效的 --bridge-version: $BRIDGE_VERSION"
    RESOLVED_BRIDGE_VER="$bver"
    RESOLVED_BRIDGE_URL="$(apply_github_proxy "https://github.com/${BRIDGE_REPO}/releases/download/v${bver}/${BRIDGE_ASSET_PREFIX}${bver}.tgz")"
  else
    bver="$(resolve_github_latest_version "$BRIDGE_REPO" || true)"
    if [ -n "$bver" ]; then
      RESOLVED_BRIDGE_VER="$bver"
      RESOLVED_BRIDGE_URL="$(apply_github_proxy "https://github.com/${BRIDGE_REPO}/releases/download/v${bver}/${BRIDGE_ASSET_PREFIX}${bver}.tgz")"
    else
      log_warn "未能解析 ${BRIDGE_REPO} 最新版本号，回退至 latest 固定链接。"
      RESOLVED_BRIDGE_VER="latest"
      RESOLVED_BRIDGE_URL="$(apply_github_proxy "https://github.com/${BRIDGE_REPO}/releases/latest/download/${BRIDGE_ALIAS_ASSET}")"
    fi
  fi
  log_info "飞书桥接 (${BRIDGE_PKG}): v${RESOLVED_BRIDGE_VER}"

  if [ "$INSTALL_EXTERNAL_AGENTS" -eq 1 ]; then
    if [ -n "$EXT_VERSION" ]; then
      ever="$(normalize_version "$EXT_VERSION")"
      [ -n "$ever" ] || die "无效的 --external-agents-version: $EXT_VERSION"
      RESOLVED_EXT_VER="$ever"
      RESOLVED_EXT_URL="$(apply_github_proxy "https://github.com/${EXT_REPO}/releases/download/v${ever}/${EXT_ASSET_PREFIX}${ever}.tgz")"
    else
      ever="$(resolve_github_latest_version "$EXT_REPO" || true)"
      if [ -n "$ever" ]; then
        RESOLVED_EXT_VER="$ever"
        RESOLVED_EXT_URL="$(apply_github_proxy "https://github.com/${EXT_REPO}/releases/download/v${ever}/${EXT_ASSET_PREFIX}${ever}.tgz")"
      else
        log_warn "未能解析 ${EXT_REPO} 最新版本号，回退至 latest 固定链接。"
        RESOLVED_EXT_VER="latest"
        RESOLVED_EXT_URL="$(apply_github_proxy "https://github.com/${EXT_REPO}/releases/latest/download/${EXT_ALIAS_ASSET}")"
      fi
    fi
    log_info "外部运行时 (${EXT_PKG}): v${RESOLVED_EXT_VER}"
  else
    log_info "已按参数跳过外部运行时插件 (${EXT_PKG})"
  fi
}

# ---------------------------------------------------------------------------
# Plugin installation helper (shared by Web & Desktop profiles)
# ---------------------------------------------------------------------------
# pnpm 11 (bundled in DSH Desktop) fails with ERR_PNPM_IGNORED_BUILDS when a
# transitive dependency such as protobufjs has an unreviewed build script.
# Explicitly recording `protobufjs: false` under allowBuilds denies executing
# its build script while satisfying pnpm 10/11 cleanly without touching other rules.
ensure_profile_pnpm_allow_builds() {
  local profile_dir="$1"
  local ws_file="$profile_dir/pnpm-workspace.yaml"
  [ -f "$ws_file" ] || return 0

  # Already configured (allowBuilds or ignoredBuiltDependencies or onlyBuiltDependencies mentioning protobufjs)
  if grep -Eq "^[[:space:]]*['\"]?protobufjs['\"]?[[:space:]]*:" "$ws_file" \
    || grep -Eq "^[[:space:]]*-[[:space:]]*['\"]?protobufjs['\"]?[[:space:]]*$" "$ws_file"; then
    return 0
  fi

  if grep -Eq "^allowBuilds:[[:space:]]*$" "$ws_file"; then
    local tmp_ws="${ws_file}.tmp.$$"
    awk '
      BEGIN { inserted = 0 }
      {
        print
        if (!inserted && $0 ~ /^allowBuilds:[[:space:]]*$/) {
          print "  protobufjs: false"
          inserted = 1
        }
      }
    ' "$ws_file" > "$tmp_ws"
    mv "$tmp_ws" "$ws_file"
  else
    printf '\nallowBuilds:\n  protobufjs: false\n' >> "$ws_file"
  fi
}

install_plugins_into_profile() {
  local dsh_bin="$1"
  local profile_name="$2"
  local label="$3"
  local profile_dir="$DSH_HOME_DIR/profiles/$profile_name"

  resolve_plugin_releases

  local specs=()
  local expected_pkgs=()

  if [ "$INSTALL_EXTERNAL_AGENTS" -eq 1 ]; then
    expected_pkgs+=("$EXT_PKG")
    local cur_ext=""
    cur_ext="$(get_installed_plugin_version "$profile_dir" "$EXT_PKG")"
    if [ "$FORCE_REINSTALL" -eq 0 ] \
      && [ "$RESOLVED_EXT_VER" != "latest" ] \
      && [ "$cur_ext" = "$RESOLVED_EXT_VER" ] \
      && profile_has_bundle "$profile_dir" "$EXT_PKG"; then
      log_ok "[${label}] ${EXT_PKG} 已是最新 v${cur_ext}，跳过。"
    else
      if [ -n "$cur_ext" ]; then
        log_info "[${label}] 将升级 ${EXT_PKG}: v${cur_ext} -> v${RESOLVED_EXT_VER}"
      else
        log_info "[${label}] 将安装 ${EXT_PKG}: v${RESOLVED_EXT_VER}"
      fi
      specs+=("$RESOLVED_EXT_URL")
    fi
  fi

  expected_pkgs+=("$BRIDGE_PKG")
  local cur_bridge=""
  cur_bridge="$(get_installed_plugin_version "$profile_dir" "$BRIDGE_PKG")"
  if [ "$FORCE_REINSTALL" -eq 0 ] \
    && [ "$RESOLVED_BRIDGE_VER" != "latest" ] \
    && [ "$cur_bridge" = "$RESOLVED_BRIDGE_VER" ] \
    && profile_has_bundle "$profile_dir" "$BRIDGE_PKG"; then
    log_ok "[${label}] ${BRIDGE_PKG} 已是最新 v${cur_bridge}，跳过。"
  else
    if [ -n "$cur_bridge" ]; then
      log_info "[${label}] 将升级 ${BRIDGE_PKG}: v${cur_bridge} -> v${RESOLVED_BRIDGE_VER}"
    else
      log_info "[${label}] 将安装 ${BRIDGE_PKG}: v${RESOLVED_BRIDGE_VER}"
    fi
    specs+=("$RESOLVED_BRIDGE_URL")
  fi

  if [ "${#specs[@]}" -eq 0 ]; then
    log_ok "[${label}] 插件均为最新版本，无需变更。"
    return 0
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[DRY-RUN] DSH_HOME=\"$DSH_HOME_DIR\" \"$dsh_bin\" plugin --profile \"$profile_name\" add ${specs[*]}"
    return 0
  fi

  ensure_profile_pnpm_allow_builds "$profile_dir"

  log_info "[${label}] 正在向 profile '${profile_name}' 安装插件..."
  if ! DSH_HOME="$DSH_HOME_DIR" "$dsh_bin" plugin --profile "$profile_name" add "${specs[@]}"; then
    # If the profile was just initialized by `dsh plugin`, ensure pnpm-workspace.yaml
    # marks protobufjs build scripts as explicitly disabled (required by pnpm 11) and retry once.
    local ws_file="$profile_dir/pnpm-workspace.yaml"
    if [ -f "$ws_file" ] && ! grep -Eq "protobufjs" "$ws_file"; then
      log_info "[${label}] 为 pnpm 11 补充 protobufjs 构建脚本豁免声明后重试一次..."
      ensure_profile_pnpm_allow_builds "$profile_dir"
      DSH_HOME="$DSH_HOME_DIR" "$dsh_bin" plugin --profile "$profile_name" add "${specs[@]}"
    else
      die "[${label}] 向 profile '${profile_name}' 安装插件失败。"
    fi
  fi

  local pkg
  for pkg in "${expected_pkgs[@]}"; do
    if ! profile_has_bundle "$profile_dir" "$pkg"; then
      die "[${label}] 校验失败: $profile_dir/package.json 中未激活插件 $pkg"
    fi
  done
  log_ok "[${label}] 插件安装并激活完成（profile: ${profile_name}）"
}

# ---------------------------------------------------------------------------
# Web edition: Node.js, pnpm, @deepseek-ai/dsh, and plugins
# ---------------------------------------------------------------------------
ensure_node_for_web() {
  detect_node
  if node_version_compatible "$DETECTED_NODE_VER"; then
    return 0
  fi

  log_warn "Web 版需要 Node.js >= ${MIN_NODE_VERSION}（当前: ${DETECTED_NODE_VER:-未安装}）。"

  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[DRY-RUN] 将检测 fnm / nvm / brew 自动安装 Node.js 22 LTS"
    return 0
  fi

  if command -v fnm >/dev/null 2>&1; then
    log_info "检测到 fnm，正在安装 Node.js 22 LTS..."
    fnm install 22
    eval "$(fnm env --shell bash)"
    fnm use 22
    detect_node
  elif [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    log_info "检测到 nvm，正在安装 Node.js 22 LTS..."
    # shellcheck disable=SC1091
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    nvm install 22
    nvm use 22
    detect_node
  elif [ "$HOST_OS" = "macos" ] && command -v brew >/dev/null 2>&1; then
    log_info "检测到 Homebrew，正在安装 node@22..."
    brew install node@22
    local brew_node_bin
    brew_node_bin="$(brew --prefix node@22)/bin"
    export PATH="$brew_node_bin:$PATH"
    detect_node
  fi

  if ! node_version_compatible "$DETECTED_NODE_VER"; then
    die "未找到兼容的 Node.js (>= ${MIN_NODE_VERSION})。请先安装 Node.js 22 LTS（https://nodejs.org 或 fnm/nvm/Homebrew），然后重新运行本脚本。"
  fi
  log_ok "Node.js 就绪: v${DETECTED_NODE_VER}"
}

ensure_pnpm_for_web() {
  detect_pnpm
  if [ -n "$DETECTED_PNPM_VER" ]; then
    if ! command -v pnpm >/dev/null 2>&1 && [ -x "$DSH_BIN_DIR/pnpm" ]; then
      export PATH="$DSH_BIN_DIR:$PATH"
    fi
    return 0
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[DRY-RUN] 将通过 corepack 或独立用户目录安装 pnpm"
    return 0
  fi

  log_info "未检测到 pnpm，正在自动准备 pnpm..."
  if command -v corepack >/dev/null 2>&1; then
    if corepack enable >/dev/null 2>&1 && corepack prepare pnpm@10 --activate >/dev/null 2>&1; then
      detect_pnpm
      if [ -n "$DETECTED_PNPM_VER" ]; then
        log_ok "已通过 corepack 启用 pnpm v${DETECTED_PNPM_VER}"
        return 0
      fi
    fi
  fi

  # Fallback: install pnpm into an isolated user-local directory without sudo
  require_cmd npm
  local pnpm_home="$DSH_CLI_HOME/pnpm-runtime"
  mkdir -p "$pnpm_home" "$DSH_BIN_DIR"
  if [ ! -f "$pnpm_home/package.json" ]; then
    printf '{"name":"dsh-pnpm-runtime","private":true}\n' > "$pnpm_home/package.json"
  fi
  npm --prefix "$pnpm_home" install --no-audit --no-fund pnpm@10
  cat > "$DSH_BIN_DIR/pnpm" <<EOF
#!/bin/sh
exec "${pnpm_home}/node_modules/.bin/pnpm" "\$@"
EOF
  chmod +x "$DSH_BIN_DIR/pnpm"
  export PATH="$DSH_BIN_DIR:$PATH"
  PATH_HINT_NEEDED=1
  detect_pnpm
  [ -n "$DETECTED_PNPM_VER" ] || die "自动安装 pnpm 失败，请手动安装 pnpm 后重试。"
  log_ok "已安装用户级 pnpm v${DETECTED_PNPM_VER} -> $DSH_BIN_DIR/pnpm"
}

install_standalone_dsh_cli() {
  ensure_node_for_web
  ensure_pnpm_for_web

  local spec="${DSH_NPM_PACKAGE}@${DSH_VERSION}"
  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[DRY-RUN] 将在 $DSH_CLI_HOME 安装 $spec 并生成 $DSH_BIN_DIR/dsh"
    DETECTED_DSH_BIN="$DSH_BIN_DIR/dsh"
    return 0
  fi

  log_info "正在安装 ${spec} 到 ${DSH_CLI_HOME}（免 sudo）..."
  mkdir -p "$DSH_CLI_HOME" "$DSH_BIN_DIR"
  if [ ! -f "$DSH_CLI_HOME/package.json" ]; then
    printf '{"name":"dsh-standalone-host","private":true}\n' > "$DSH_CLI_HOME/package.json"
  fi
  if [ ! -f "$DSH_CLI_HOME/pnpm-workspace.yaml" ]; then
    cat > "$DSH_CLI_HOME/pnpm-workspace.yaml" <<'EOF'
packages:
  - .

allowBuilds:
  '@deepseek-ai/dsh-subprocess-local': true
  koffi: true
  node-pty: true
  protobufjs: false
EOF
  fi

  if command -v pnpm >/dev/null 2>&1; then
    (cd "$DSH_CLI_HOME" && pnpm add "$spec")
  else
    npm --prefix "$DSH_CLI_HOME" install --no-audit --no-fund "$spec"
  fi

  [ -x "$DSH_CLI_HOME/node_modules/.bin/dsh" ] || die "安装 ${spec} 后未找到可执行文件 $DSH_CLI_HOME/node_modules/.bin/dsh"

  cat > "$DSH_BIN_DIR/dsh" <<EOF
#!/bin/sh
exec "${DSH_CLI_HOME}/node_modules/.bin/dsh" "\$@"
EOF
  chmod +x "$DSH_BIN_DIR/dsh"
  export PATH="$DSH_BIN_DIR:$PATH"

  case ":$PATH:" in
    *":$DSH_BIN_DIR:"*) ;;
    *) PATH_HINT_NEEDED=1 ;;
  esac
  # Check original user shell PATH hint separately
  if ! printf '%s' "${ORIGINAL_PATH:-$PATH}" | tr ':' '\n' | grep -Fxq "$DSH_BIN_DIR"; then
    PATH_HINT_NEEDED=1
  fi

  DETECTED_DSH_BIN="$DSH_BIN_DIR/dsh"
  DETECTED_DSH_IS_DESKTOP=0
  DETECTED_DSH_VER="$(normalize_version "$("$DETECTED_DSH_BIN" --version 2>/dev/null || true)")"
  if ! dsh_version_compatible "$DETECTED_DSH_VER"; then
    die "已安装的 DSH CLI 版本 (${DETECTED_DSH_VER:-unknown}) 不满足插件兼容范围 >= ${MIN_DSH_VERSION} < ${MAX_DSH_VERSION_EXCLUSIVE}。"
  fi
  log_ok "DSH CLI 安装完成: v${DETECTED_DSH_VER} -> ${DETECTED_DSH_BIN}"
}

install_web() {
  log_step "安装 Web 版（DSH CLI + 插件）"

  local need_install_dsh=0
  if [ -z "$DETECTED_DSH_BIN" ]; then
    need_install_dsh=1
  elif [ "$UPGRADE_DSH" -eq 1 ]; then
    need_install_dsh=1
  elif ! dsh_version_compatible "$DETECTED_DSH_VER"; then
    log_warn "检测到现有 DSH CLI 版本 (${DETECTED_DSH_VER:-unknown}) 低于 ${MIN_DSH_VERSION}，将安装独立兼容版。"
    need_install_dsh=1
  fi

  if [ "$need_install_dsh" -eq 1 ]; then
    install_standalone_dsh_cli
  else
    log_ok "复用现有 DSH CLI: v${DETECTED_DSH_VER} (${DETECTED_DSH_BIN})"
    if [ "$DETECTED_DSH_IS_DESKTOP" -eq 0 ]; then
      ensure_node_for_web
      ensure_pnpm_for_web
    fi
  fi

  # Warn gently if an existing bridge instance is actively running on this DSH_HOME
  if [ -f "$DSH_HOME_DIR/lark-bridge/bridge.lock" ]; then
    log_warn "检测到 $DSH_HOME_DIR 下可能有正在运行的飞书桥接实例；安装完成后请先优雅排空（lark-bridge lifecycle drain --wait）再重启 Web 服务，或日常升级直接运行 lark-bridge plugin update all 免重启热更新。"
  fi

  install_plugins_into_profile "$DETECTED_DSH_BIN" "$WEB_PROFILE" "Web"
  configure_web_bind_host "$WEB_PROFILE"
}

has_webserver_patch_entry() {
  local patch_file="$1"
  [ -f "$patch_file" ] || return 1
  awk '
    function check_item(    k) {
      if (!in_item) return
      for (k = 1; k <= n; k++) {
        if (buf[k] ~ /^-[[:space:]]+id:[[:space:]]*('\''|")?webserver('\''|")?[[:space:]]*(#.*)?$/ \
          || buf[k] ~ /^[[:space:]]{2}id:[[:space:]]*('\''|")?webserver('\''|")?[[:space:]]*(#.*)?$/) {
          found = 1
          return
        }
      }
    }
    BEGIN { in_item = 0; n = 0; found = 0 }
    {
      sub(/\r$/, "")
      if ($0 ~ /^-([[:space:]]|$)/) {
        check_item()
        in_item = 1
        n = 1
        buf[1] = $0
      } else if (in_item) {
        n++
        buf[n] = $0
      }
    }
    END {
      check_item()
      exit(found ? 0 : 1)
    }
  ' "$patch_file"
}

strip_webserver_patch_entry() {
  local src_file="$1"
  local dst_file="$2"
  awk '
    function is_managed_comment(line) {
      return line ~ /^#[[:space:]]*Managed by dsh-lark-bridge installer:/
    }
    function is_webserver_item(    k) {
      for (k = 1; k <= item_n; k++) {
        if (item[k] ~ /^-[[:space:]]+id:[[:space:]]*('\''|")?webserver('\''|")?[[:space:]]*(#.*)?$/ \
          || item[k] ~ /^[[:space:]]{2}id:[[:space:]]*('\''|")?webserver('\''|")?[[:space:]]*(#.*)?$/) {
          return 1
        }
      }
      return 0
    }
    function emit_line(line) {
      out_n++
      out[out_n] = line
    }
    function flush_item(    k, keep_lead_end) {
      if (!in_item) return
      if (is_webserver_item()) {
        keep_lead_end = lead_n
        while (keep_lead_end > 0 && (lead[keep_lead_end] ~ /^[[:space:]]*$/ || is_managed_comment(lead[keep_lead_end]))) {
          keep_lead_end--
        }
        for (k = 1; k <= keep_lead_end; k++) emit_line(lead[k])
      } else {
        for (k = 1; k <= lead_n; k++) emit_line(lead[k])
        for (k = 1; k <= item_n; k++) emit_line(item[k])
      }
      in_item = 0
      item_n = 0
      lead_n = 0
      for (k = 1; k <= trail_n; k++) {
        lead_n++
        lead[lead_n] = trail[k]
      }
      trail_n = 0
    }
    BEGIN { in_item = 0; item_n = 0; lead_n = 0; trail_n = 0; out_n = 0 }
    {
      sub(/\r$/, "")
      if (!in_item && $0 ~ /^[[:space:]]*\[\][[:space:]]*$/) {
        next
      }
      if ($0 ~ /^-([[:space:]]|$)/) {
        flush_item()
        in_item = 1
        item_n = 1
        item[1] = $0
        next
      }
      if (!in_item) {
        lead_n++
        lead[lead_n] = $0
        next
      }
      if ($0 ~ /^[[:space:]]*$/ || $0 ~ /^#/) {
        trail_n++
        trail[trail_n] = $0
      } else {
        for (i = 1; i <= trail_n; i++) {
          item_n++
          item[item_n] = trail[i]
        }
        trail_n = 0
        item_n++
        item[item_n] = $0
      }
    }
    END {
      flush_item()
      for (i = 1; i <= lead_n; i++) emit_line(lead[i])
      while (out_n > 0 && out[out_n] ~ /^[[:space:]]*$/) out_n--
      for (i = 1; i <= out_n; i++) print out[i]
    }
  ' "$src_file" > "$dst_file"
}

render_webserver_patch_block() {
  local mode="$1"
  if [ "$mode" = "auto" ]; then
    cat <<'EOF'
# Managed by dsh-lark-bridge installer: bind local LAN IPv4 by default (override with --host).
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: !!js |-
      ctx.webStartup.host ?? (() => {
        const ifaces = process.getBuiltinModule?.('node:os')?.networkInterfaces?.() ?? {};
        const virtRe = /^(lo|utun|tun|tap|wg|docker|br-|veth|virbr|tailscale|zt|awdl|llw|bridge|anpi|ap|gif|stf|ipsec|feth|vethernet|vmware|virtualbox|loopback|clash|mihomo|meta|wintun|openvpn|bluetooth)/i;
        const picks = [];
        for (const [name, list] of Object.entries(ifaces)) {
          const virt = virtRe.test(name);
          for (const a of list ?? []) {
            if ((a.family !== 'IPv4' && a.family !== 4) || a.internal) continue;
            if (a.address.startsWith('169.254.') || /^198\.(18|19)\./.test(a.address)) continue;
            const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
            picks.push({ ip: a.address, score: (virt ? 2 : 0) + (priv ? 0 : 1) });
          }
        }
        picks.sort((a, b) => a.score - b.score);
        return picks[0]?.ip ?? '127.0.0.1';
      })()
    port: !!js ctx.webStartup.port ?? 3080
    tls: !!js ctx.webStartup.tls
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
EOF
    return 0
  fi

  local resolved_host="$mode"
  if [ "$resolved_host" = "loopback" ]; then
    resolved_host="127.0.0.1"
  fi
  cat <<EOF
# Managed by dsh-lark-bridge installer: default Web bind host (override with --host).
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: !!js ctx.webStartup.host ?? '${resolved_host}'
    port: !!js ctx.webStartup.port ?? 3080
    tls: !!js ctx.webStartup.tls
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
EOF
}

configure_web_bind_host() {
  local profile_name="$1"
  local profile_dir="$DSH_HOME_DIR/profiles/$profile_name"
  local patch_file="$profile_dir/cordis.patch.yml"

  if [ -f "$patch_file" ] && has_webserver_patch_entry "$patch_file"; then
    if [ "$WEB_HOST_EXPLICIT" -eq 0 ] && [ "$FORCE_REINSTALL" -eq 0 ]; then
      log_ok "[Web] cordis.patch.yml 已包含 webserver 监听配置，保留现有设置（如需修改请传 --web-host <auto|loopback|IP>）。"
      return 0
    fi
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    if [ "$WEB_HOST" = "auto" ]; then
      log_info "[DRY-RUN] 将在 $patch_file 配置 Web 默认绑定本机局域网 IPv4（离线回退 127.0.0.1，支持 --host 覆盖）"
    else
      local dry_host="$WEB_HOST"
      [ "$dry_host" = "loopback" ] && dry_host="127.0.0.1"
      log_info "[DRY-RUN] 将在 $patch_file 配置 Web 默认监听地址: ${dry_host}（支持 --host 覆盖）"
    fi
    return 0
  fi

  mkdir -p "$profile_dir"
  local tmp_patch="${patch_file}.tmp.$$"

  if [ -f "$patch_file" ]; then
    strip_webserver_patch_entry "$patch_file" "$tmp_patch"
    if [ -s "$tmp_patch" ]; then
      printf '\n' >> "$tmp_patch"
    fi
  else
    cat > "$tmp_patch" <<'EOF'
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).

EOF
  fi

  render_webserver_patch_block "$WEB_HOST" >> "$tmp_patch"
  mv "$tmp_patch" "$patch_file"

  if [ "$WEB_HOST" = "auto" ]; then
    detect_local_lan_ipv4 >/dev/null
    if [ -n "$DETECTED_LAN_IPV4" ]; then
      log_ok "[Web] 已配置默认绑定本机局域网 IPv4（当前本机 IP: ${DETECTED_LAN_IPV4}，离线自动回退 127.0.0.1，启动时可用 --host 覆盖）-> $patch_file"
    else
      log_ok "[Web] 已配置默认绑定本机局域网 IPv4（离线自动回退 127.0.0.1，启动时可用 --host 覆盖）-> $patch_file"
    fi
  else
    local final_host="$WEB_HOST"
    [ "$final_host" = "loopback" ] && final_host="127.0.0.1"
    log_ok "[Web] 已配置默认监听地址: ${final_host}（启动时可用 --host 覆盖）-> $patch_file"
  fi
}

# ---------------------------------------------------------------------------
# Desktop App edition (macOS): DMG download, install, init profile, plugins
# ---------------------------------------------------------------------------
is_desktop_app_running() {
  pgrep -x "DeepSeek Harness" >/dev/null 2>&1
}

quit_desktop_app_gracefully() {
  if ! is_desktop_app_running; then
    return 0
  fi

  log_info "正在优雅退出运行中的 DeepSeek Harness Desktop..."
  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[DRY-RUN] osascript -e 'tell application \"DeepSeek Harness\" to quit'"
    return 0
  fi

  osascript -e 'tell application "DeepSeek Harness" to quit' >/dev/null 2>&1 || true

  local i=0
  while [ "$i" -lt 25 ]; do
    if ! is_desktop_app_running; then
      log_ok "DeepSeek Harness Desktop 已退出。"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done

  if can_prompt; then
    log_warn "DeepSeek Harness Desktop 仍在运行（可能有未确认的退出弹窗）。请在桌面端按 ⌘Q 完全退出后按回车继续。"
    prompt_read "退出完成后按回车继续..." >/dev/null
    if ! is_desktop_app_running; then
      return 0
    fi
  fi

  die "DeepSeek Harness Desktop 仍在运行，为避免破坏 profile 写锁，请先完全退出应用（⌘Q）后重试。"
}

extract_dmg_mount_point() {
  local plist_xml="$1"
  if command -v python3 >/dev/null 2>&1; then
    printf '%s\n' "$plist_xml" | python3 -c 'import plistlib,sys
data=plistlib.loads(sys.stdin.buffer.read())
for ent in data.get("system-entities", []):
  mp=ent.get("mount-point")
  if mp:
    print(mp)
    break'
    return 0
  fi
  printf '%s\n' "$plist_xml" | awk '
    /<key>mount-point<\/key>/ { found=1; next }
    found && /<string>/ {
      sub(/.*<string>/, ""); sub(/<\/string>.*/, "");
      print; exit
    }'
}

download_and_install_desktop_app_macos() {
  local dmg_url=""
  if [ "$HOST_ARCH" = "arm64" ]; then
    dmg_url="$DESKTOP_DMG_ARM64_URL"
  else
    dmg_url="$DESKTOP_DMG_X64_URL"
  fi

  local target_dir="/Applications"
  if [ ! -w "$target_dir" ]; then
    target_dir="$HOME/Applications"
  fi
  local target_app="$target_dir/DeepSeek Harness.app"

  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[DRY-RUN] 将下载 ${dmg_url} 并安装至 ${target_app}"
    DETECTED_APP_PATH="$target_app"
    DETECTED_APP_CLI="$target_app/Contents/Resources/runtime/cli/bin/dsh"
    return 0
  fi

  quit_desktop_app_gracefully

  ensure_tmp_dir
  local dmg_file="$TMP_DIR/dsh-desktop.dmg"
  log_info "正在下载 DeepSeek Harness Desktop (${HOST_ARCH}): ${dmg_url}"
  curl -fL --retry 3 --progress-bar -o "$dmg_file" "$dmg_url"

  log_info "正在挂载安装包..."
  local attach_xml=""
  attach_xml="$(hdiutil attach -nobrowse -readonly -plist "$dmg_file")"
  MOUNTED_DMG_DIR="$(extract_dmg_mount_point "$attach_xml")"
  [ -n "$MOUNTED_DMG_DIR" ] && [ -d "$MOUNTED_DMG_DIR" ] || die "挂载 DMG 失败，未解析到挂载目录。"

  local src_app="$MOUNTED_DMG_DIR/DeepSeek Harness.app"
  if [ ! -d "$src_app" ]; then
    src_app="$(find "$MOUNTED_DMG_DIR" -maxdepth 2 -name '*.app' -type d | head -n 1 || true)"
  fi
  [ -n "$src_app" ] && [ -d "$src_app" ] || die "DMG 中未找到 DeepSeek Harness.app。"

  mkdir -p "$target_dir"
  local staging_app="$target_dir/.DeepSeek Harness.app.installing.$$"
  rm -rf "$staging_app"
  log_info "正在复制应用到 ${target_app}..."
  ditto "$src_app" "$staging_app"

  rm -rf "$target_app"
  mv "$staging_app" "$target_app"

  hdiutil detach "$MOUNTED_DMG_DIR" -quiet >/dev/null 2>&1 || true
  MOUNTED_DMG_DIR=""

  DETECTED_APP_PATH="$target_app"
  DETECTED_APP_CLI="$target_app/Contents/Resources/runtime/cli/bin/dsh"
  DETECTED_APP_VER="$(normalize_version "$("$DETECTED_APP_CLI" --version 2>/dev/null || true)")"
  log_ok "DeepSeek Harness Desktop 安装完成: v${DETECTED_APP_VER:-unknown} (${DETECTED_APP_PATH})"
}

ensure_desktop_profile_initialized() {
  local desktop_pkg_json="$DSH_HOME_DIR/profiles/desktop/package.json"
  if [ -f "$desktop_pkg_json" ]; then
    return 0
  fi

  log_info "首次检测到 Desktop profile 尚未初始化，正在自动启动一次应用完成初始化..."
  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "[DRY-RUN] open -a \"$DETECTED_APP_PATH\" -> 等待 $desktop_pkg_json 生成 -> 优雅退出"
    return 0
  fi

  DSH_HOME="$DSH_HOME_DIR" open -a "$DETECTED_APP_PATH" || \
    die "无法自动打开 ${DETECTED_APP_PATH}。请手动打开一次 DeepSeek Harness 完成初始化并退出（⌘Q）后重跑本脚本。"

  local waited=0
  while [ "$waited" -lt 45 ]; do
    if [ -f "$desktop_pkg_json" ]; then
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done

  if [ ! -f "$desktop_pkg_json" ]; then
    die "等待 Desktop 初始化 profile 超时（45s）。请手动打开一次 DeepSeek Harness，待主界面出现后按 ⌘Q 退出，再重新运行本脚本。"
  fi

  # Allow initial manifest/patch files to flush completely before quitting
  sleep 2
  log_ok "Desktop profile 初始化完成。"
  quit_desktop_app_gracefully
}

install_app() {
  log_step "安装 Desktop App 版（DeepSeek Harness + 插件）"

  if [ "$HOST_OS" != "macos" ]; then
    die "Desktop App 安装仅支持 macOS（Windows 请运行 scripts/install.ps1，Linux 请使用 --mode web）。"
  fi

  local need_install_app=0
  if [ -z "$DETECTED_APP_PATH" ]; then
    need_install_app=1
  elif [ "$UPGRADE_DSH" -eq 1 ]; then
    need_install_app=1
  elif ! dsh_version_compatible "$DETECTED_APP_VER"; then
    log_warn "检测到现有 Desktop App 版本 (${DETECTED_APP_VER:-unknown}) 低于 ${MIN_DSH_VERSION}，将下载最新安装包更新。"
    need_install_app=1
  fi

  if [ "$need_install_app" -eq 1 ]; then
    download_and_install_desktop_app_macos
  else
    log_ok "复用现有 DeepSeek Harness Desktop: v${DETECTED_APP_VER} (${DETECTED_APP_PATH})"
  fi

  if [ "$DRY_RUN" -eq 0 ]; then
    [ -x "$DETECTED_APP_CLI" ] || die "未找到 Desktop 内置 CLI: $DETECTED_APP_CLI"
    if ! dsh_version_compatible "$DETECTED_APP_VER"; then
      die "当前安装的 Desktop App 版本 (${DETECTED_APP_VER:-unknown}) 不满足插件最低版本要求 (>= ${MIN_DSH_VERSION} < ${MAX_DSH_VERSION_EXCLUSIVE})。请在应用内检查更新，或改用 --mode web 安装最新 Web 版。"
    fi
  fi

  ensure_desktop_profile_initialized
  quit_desktop_app_gracefully

  install_plugins_into_profile "$DETECTED_APP_CLI" "desktop" "Desktop App"
}

# ---------------------------------------------------------------------------
# Post-install summary
# ---------------------------------------------------------------------------
print_next_steps() {
  log_step "安装完成"

  if [ "$DRY_RUN" -eq 1 ]; then
    log_info "以上为 --dry-run 演练结果，未对系统执行实际修改。"
    return 0
  fi

  if [ "$MODE" = "app" ] || [ "$MODE" = "both" ]; then
    printf '\n%s[Desktop App 版]%s\n' "$C_BOLD" "$C_RESET"
    printf '  1. 打开应用：open -a "%s"\n' "$DETECTED_APP_PATH"
    printf '  2. 在左侧边栏点击「飞书桥接」，按引导扫码创建飞书智能体即可使用。\n'
    if [ "$INSTALL_EXTERNAL_AGENTS" -eq 1 ]; then
      printf '  3. 已自动安装外部运行时插件（Codex / Antigravity / Claude Code / TRAE），启动后可直接选用。\n'
    fi

    local should_launch=0
    if [ "$LAUNCH_APP" = "yes" ]; then
      should_launch=1
    elif [ "$LAUNCH_APP" = "auto" ] && can_prompt; then
      local ans
      ans="$(prompt_read "是否立即启动 DeepSeek Harness Desktop？[Y/n]: ")"
      case "${ans:-Y}" in
        y|Y|yes|YES) should_launch=1 ;;
      esac
    fi
    if [ "$should_launch" -eq 1 ] && [ -d "$DETECTED_APP_PATH" ]; then
      log_info "正在启动 DeepSeek Harness Desktop..."
      DSH_HOME="$DSH_HOME_DIR" open -a "$DETECTED_APP_PATH" || true
    fi
  fi

  if [ "$MODE" = "web" ] || [ "$MODE" = "both" ]; then
    printf '\n%s[Web 版]%s\n' "$C_BOLD" "$C_RESET"
    if [ "$PATH_HINT_NEEDED" -eq 1 ]; then
      printf '  %s提示%s: 请将 %s 加入 PATH（例如写入 ~/.zshrc 或 ~/.bashrc）：\n' "$C_YELLOW" "$C_RESET" "$DSH_BIN_DIR"
      printf '    export PATH="%s:$PATH"\n' "$DSH_BIN_DIR"
    fi
    local bind_note=""
    if [ "$WEB_HOST" = "auto" ]; then
      detect_local_lan_ipv4 >/dev/null
      if [ -n "$DETECTED_LAN_IPV4" ]; then
        bind_note="（已默认绑定本机 IPv4，当前: ${DETECTED_LAN_IPV4}；离线自动回退 127.0.0.1）"
      else
        bind_note="（已默认绑定本机局域网 IPv4，离线自动回退 127.0.0.1）"
      fi
    else
      local effective_host="$WEB_HOST"
      [ "$effective_host" = "loopback" ] && effective_host="127.0.0.1"
      bind_note="（已默认绑定 ${effective_host}）"
    fi
    if [ "$WEB_PROFILE" = "web" ]; then
      printf '  1. 启动服务  : dsh web  %s\n' "$bind_note"
      printf '  2. 后台常驻  : dsh --profile web --no-open --port 3880（如需指定或仅本机回环可追加 --host <IP>）\n'
    else
      printf '  1. 启动命令  : dsh --profile %s  %s\n' "$WEB_PROFILE" "$bind_note"
    fi
    printf '  3. 后续免重启热更新插件: lark-bridge plugin update all\n'
  fi
}

main() {
  ORIGINAL_PATH="$PATH"
  parse_args "$@"
  require_cmd curl
  detect_platform

  detect_node
  detect_pnpm
  detect_desktop_app
  detect_dsh_cli

  print_detection_summary
  select_mode

  case "$MODE" in
    web)
      install_web
      ;;
    app)
      install_app
      ;;
    both)
      install_app
      install_web
      ;;
  esac

  print_next_steps
}

main "$@"
