#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${VESSEL_INSTALL_DIR:-$HOME/.local/share/vessel-browser}"
BIN_DIR="${VESSEL_BIN_DIR:-$HOME/.local/bin}"
CONFIG_DIR="${VESSEL_CONFIG_DIR:-$HOME/.config/vessel}"
STATUS_HELPER_PATH="$BIN_DIR/vessel-browser-status"
LOG_FILE="${VESSEL_LOG_FILE:-/tmp/vessel-browser.log}"
PREFER="auto"
BACKGROUND=1
WAIT_MS=8000
DRY_RUN=0
USED_NO_SANDBOX=0
USED_APPIMAGE_EXTRACT=0

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'error: missing required command: %s\n' "$1" >&2
    exit 1
  }
}

run_status_check() {
  STATUS_HELPER_PATH="" \
  STATUS_SCRIPT_PATH="$SCRIPT_DIR/status-installation.sh" \
  INSTALL_DIR="$INSTALL_DIR" \
  BIN_DIR="$BIN_DIR" \
  CONFIG_DIR="$CONFIG_DIR" \
  WAIT_MS="$WAIT_MS" \
  node <<'NODE'
const { execFileSync } = require("child_process");

const waitMs = Number(process.env.WAIT_MS || 8000);
const sleepMs = 400;
const deadline = Date.now() + waitMs;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readStatus() {
  try {
    if (process.env.STATUS_HELPER_PATH) {
      return JSON.parse(execFileSync(process.env.STATUS_HELPER_PATH, ["--json"], { encoding: "utf8" }));
    }
    return JSON.parse(execFileSync("bash", [process.env.STATUS_SCRIPT_PATH, "--json"], {
      encoding: "utf8",
      env: {
        ...process.env,
        VESSEL_INSTALL_DIR: process.env.INSTALL_DIR,
        VESSEL_BIN_DIR: process.env.BIN_DIR,
        VESSEL_CONFIG_DIR: process.env.CONFIG_DIR,
      },
    }));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

let last = readStatus();
while (!last.mcp_reachable && Date.now() < deadline) {
  sleep(sleepMs);
  last = readStatus();
}

process.stdout.write(JSON.stringify(last));
NODE
}

launch_background() {
  local with_no_sandbox="$1"
  local with_appimage_extract="$2"
  local -a args=()
  if [[ "$with_no_sandbox" == "1" ]]; then
    args+=(--no-sandbox)
  fi

  if [[ "$MODE" == "source" ]]; then
    (
      cd "$INSTALL_DIR"
      nohup "$TARGET_PATH" "${args[@]}" "$INSTALL_DIR" >>"$LOG_FILE" 2>&1 &
    )
  elif [[ "$with_appimage_extract" == "1" ]]; then
    APPIMAGE_EXTRACT_AND_RUN=1 nohup "$TARGET_PATH" "${args[@]}" >>"$LOG_FILE" 2>&1 &
  else
    nohup "$TARGET_PATH" "${args[@]}" >>"$LOG_FILE" 2>&1 &
  fi
}

log_has_sandbox_error() {
  [[ -f "$LOG_FILE" ]] && grep -Eiq 'setuid sandbox|chrome-sandbox|No usable sandbox|sandbox_host_linux\.cc|Operation not permitted' "$LOG_FILE"
}

log_has_appimage_mount_error() {
  [[ -f "$LOG_FILE" ]] && grep -Eiq 'failed to open /dev/fuse|Cannot mount AppImage|APPIMAGE_EXTRACT_AND_RUN' "$LOG_FILE"
}

usage() {
  cat <<'HELP'
Usage: vessel-browser-launch [--background|--foreground] [--log-file PATH] [--prefer auto|source|appimage] [--wait-ms N] [--dry-run] [--help]

Launch Vessel using the best available local install:
- prefer a healthy source install when available
- fall back to the newest AppImage when the source install is likely blocked by Electron sandbox permissions
- wait briefly for the MCP endpoint and report a deterministic result
HELP
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --background)
      BACKGROUND=1
      ;;
    --foreground)
      BACKGROUND=0
      ;;
    --log-file)
      shift
      LOG_FILE="${1:-}"
      ;;
    --log-file=*)
      LOG_FILE="${1#*=}"
      ;;
    --prefer)
      shift
      PREFER="${1:-}"
      ;;
    --prefer=*)
      PREFER="${1#*=}"
      ;;
    --wait-ms)
      shift
      WAIT_MS="${1:-}"
      ;;
    --wait-ms=*)
      WAIT_MS="${1#*=}"
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'error: unknown argument: %s\n' "$1" >&2
      exit 1
      ;;
  esac
  shift
done

case "$PREFER" in
  auto|source|appimage) ;;
  *)
    printf 'error: unsupported launch preference: %s\n' "$PREFER" >&2
    exit 1
    ;;
esac

require_cmd node

if [[ -x "$STATUS_HELPER_PATH" ]]; then
  STATUS_JSON="$("$STATUS_HELPER_PATH" --json)"
else
  STATUS_JSON="$(VESSEL_INSTALL_DIR="$INSTALL_DIR" VESSEL_BIN_DIR="$BIN_DIR" VESSEL_CONFIG_DIR="$CONFIG_DIR" bash "$SCRIPT_DIR/status-installation.sh" --json)"
fi

if ! printf '%s' "$STATUS_JSON" | grep -q '"launch_recommendation"'; then
  STATUS_JSON="$(VESSEL_INSTALL_DIR="$INSTALL_DIR" VESSEL_BIN_DIR="$BIN_DIR" VESSEL_CONFIG_DIR="$CONFIG_DIR" bash "$SCRIPT_DIR/status-installation.sh" --json)"
fi

status_value() {
  local key="$1"
  STATUS_JSON_INPUT="$STATUS_JSON" STATUS_KEY="$key" node <<'NODE'
const data = JSON.parse(process.env.STATUS_JSON_INPUT || "{}");
const value = data[process.env.STATUS_KEY];
if (value == null) {
  process.exit(0);
}
if (typeof value === "string") {
  process.stdout.write(value);
} else {
  process.stdout.write(JSON.stringify(value));
}
NODE
}

MCP_REACHABLE="$(status_value mcp_reachable)"
MCP_ENDPOINT="$(status_value mcp_endpoint)"
SOURCE_INSTALL="$(status_value source_install)"
SOURCE_ELECTRON_PATH="$(status_value source_electron_path)"
SOURCE_LAUNCH_READY="$(status_value source_launch_ready)"
SOURCE_LAUNCH_ISSUE="$(status_value source_launch_issue)"
PREFERRED_APPIMAGE="$(status_value preferred_appimage)"
LAUNCH_RECOMMENDATION="$(status_value launch_recommendation)"

if [[ "$MCP_REACHABLE" == "true" ]]; then
  printf 'Vessel MCP is already reachable at %s\n' "$MCP_ENDPOINT"
  exit 0
fi

MODE=""
TARGET_PATH=""

case "$PREFER" in
  source)
    if [[ "$SOURCE_INSTALL" != "true" || -z "$SOURCE_ELECTRON_PATH" ]]; then
      printf 'error: requested source launch, but no source install was detected\n' >&2
      exit 1
    fi
    MODE="source"
    TARGET_PATH="$SOURCE_ELECTRON_PATH"
    ;;
  appimage)
    if [[ -z "$PREFERRED_APPIMAGE" ]]; then
      printf 'error: requested AppImage launch, but no AppImage candidate was found\n' >&2
      exit 1
    fi
    MODE="appimage"
    TARGET_PATH="$PREFERRED_APPIMAGE"
    ;;
  auto)
    case "$LAUNCH_RECOMMENDATION" in
      source|source-with-warning)
        MODE="source"
        TARGET_PATH="$SOURCE_ELECTRON_PATH"
        ;;
      appimage)
        MODE="appimage"
        TARGET_PATH="$PREFERRED_APPIMAGE"
        ;;
    esac
    if [[ -z "$MODE" ]]; then
      if [[ "$SOURCE_INSTALL" == "true" && -n "$SOURCE_ELECTRON_PATH" ]]; then
        MODE="source"
        TARGET_PATH="$SOURCE_ELECTRON_PATH"
      elif [[ -n "$PREFERRED_APPIMAGE" ]]; then
        MODE="appimage"
        TARGET_PATH="$PREFERRED_APPIMAGE"
      fi
    fi
    ;;
esac

if [[ -z "$MODE" || -z "$TARGET_PATH" ]]; then
  printf 'error: no launchable Vessel install was found\n' >&2
  exit 1
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  printf 'mode=%s\n' "$MODE"
  printf 'target=%s\n' "$TARGET_PATH"
  printf 'endpoint=%s\n' "$MCP_ENDPOINT"
  exit 0
fi

if [[ "$BACKGROUND" -eq 0 ]]; then
  if [[ "$MODE" == "source" && "$SOURCE_LAUNCH_ISSUE" == "sandbox-permissions" ]]; then
    USED_NO_SANDBOX=1
  fi
  if [[ "$MODE" == "source" ]]; then
    cd "$INSTALL_DIR"
    if [[ "$USED_NO_SANDBOX" -eq 1 ]]; then
      exec "$TARGET_PATH" --no-sandbox "$INSTALL_DIR"
    fi
    exec "$TARGET_PATH" "$INSTALL_DIR"
  fi
  if [[ "$USED_APPIMAGE_EXTRACT" -eq 1 ]]; then
    if [[ "$USED_NO_SANDBOX" -eq 1 ]]; then
      exec env APPIMAGE_EXTRACT_AND_RUN=1 "$TARGET_PATH" --no-sandbox
    fi
    exec env APPIMAGE_EXTRACT_AND_RUN=1 "$TARGET_PATH"
  fi
  if [[ "$USED_NO_SANDBOX" -eq 1 ]]; then
    exec "$TARGET_PATH" --no-sandbox
  fi
  exec "$TARGET_PATH"
fi

mkdir -p "$(dirname "$LOG_FILE")"
: >"$LOG_FILE"

launch_background 0 0
WAIT_RESULT="$(run_status_check)"

MCP_READY="$(WAIT_RESULT_JSON="$WAIT_RESULT" node -e 'const data=JSON.parse(process.env.WAIT_RESULT_JSON || "{}"); process.stdout.write(data.mcp_reachable ? "true" : "false");')"

if [[ "$MCP_READY" != "true" ]] && log_has_sandbox_error; then
  : >"$LOG_FILE"
  USED_NO_SANDBOX=1
  launch_background 1 "$USED_APPIMAGE_EXTRACT"
  WAIT_RESULT="$(run_status_check)"
  MCP_READY="$(WAIT_RESULT_JSON="$WAIT_RESULT" node -e 'const data=JSON.parse(process.env.WAIT_RESULT_JSON || "{}"); process.stdout.write(data.mcp_reachable ? "true" : "false");')"
fi

if [[ "$MCP_READY" != "true" && "$MODE" == "appimage" ]] && log_has_appimage_mount_error; then
  : >"$LOG_FILE"
  USED_APPIMAGE_EXTRACT=1
  launch_background "$USED_NO_SANDBOX" 1
  WAIT_RESULT="$(run_status_check)"
  MCP_READY="$(WAIT_RESULT_JSON="$WAIT_RESULT" node -e 'const data=JSON.parse(process.env.WAIT_RESULT_JSON || "{}"); process.stdout.write(data.mcp_reachable ? "true" : "false");')"
fi

if [[ "$MCP_READY" != "true" && "$USED_NO_SANDBOX" -eq 0 ]] && log_has_sandbox_error; then
  : >"$LOG_FILE"
  USED_NO_SANDBOX=1
  launch_background 1 "$USED_APPIMAGE_EXTRACT"
  WAIT_RESULT="$(run_status_check)"
  MCP_READY="$(WAIT_RESULT_JSON="$WAIT_RESULT" node -e 'const data=JSON.parse(process.env.WAIT_RESULT_JSON || "{}"); process.stdout.write(data.mcp_reachable ? "true" : "false");')"
fi

if [[ "$MCP_READY" == "true" ]]; then
  FINAL_ENDPOINT="$(WAIT_RESULT_JSON="$WAIT_RESULT" node -e 'const data=JSON.parse(process.env.WAIT_RESULT_JSON || "{}"); process.stdout.write(data.mcp_endpoint || "");')"
  EXTRA_FLAGS=()
  [[ "$USED_APPIMAGE_EXTRACT" -eq 1 ]] && EXTRA_FLAGS+=("APPIMAGE_EXTRACT_AND_RUN=1")
  [[ "$USED_NO_SANDBOX" -eq 1 ]] && EXTRA_FLAGS+=("--no-sandbox")
  if [[ ${#EXTRA_FLAGS[@]} -gt 0 ]]; then
    printf 'Vessel launched via %s with %s and MCP is reachable at %s\n' "$MODE" "$(IFS=' '; printf '%s' "${EXTRA_FLAGS[*]}")" "$FINAL_ENDPOINT"
  else
    printf 'Vessel launched via %s and MCP is reachable at %s\n' "$MODE" "$FINAL_ENDPOINT"
  fi
  exit 0
fi

if log_has_sandbox_error; then
  if [[ "$MODE" == "source" && -n "$PREFERRED_APPIMAGE" && "$PREFER" == "auto" && "$USED_NO_SANDBOX" -eq 0 ]]; then
    printf 'error: source launch hit an Electron sandbox issue; use the AppImage at %s or rerun with --prefer appimage\n' "$PREFERRED_APPIMAGE" >&2
  else
    printf 'error: Vessel launch hit an Electron sandbox issue. See %s\n' "$LOG_FILE" >&2
  fi
  exit 1
fi

if [[ "$MODE" == "appimage" ]] && log_has_appimage_mount_error; then
  printf 'error: Vessel AppImage could not mount cleanly. See %s\n' "$LOG_FILE" >&2
  exit 1
fi

if [[ "$MODE" == "source" && "$SOURCE_LAUNCH_READY" != "true" && -n "$SOURCE_LAUNCH_ISSUE" ]]; then
  printf 'error: source launch is likely unhealthy (%s). See %s\n' "$SOURCE_LAUNCH_ISSUE" "$LOG_FILE" >&2
  exit 1
fi

printf 'error: Vessel did not reach MCP in time. See %s\n' "$LOG_FILE" >&2
exit 1
