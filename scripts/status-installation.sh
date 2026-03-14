#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${VESSEL_INSTALL_DIR:-$HOME/.local/share/vessel-browser}"
BIN_DIR="${VESSEL_BIN_DIR:-$HOME/.local/bin}"
CONFIG_DIR="${VESSEL_CONFIG_DIR:-$HOME/.config/vessel}"
SETTINGS_PATH="$CONFIG_DIR/vessel-settings.json"
MCP_HELPER_PATH="$BIN_DIR/vessel-browser-mcp"
UPDATE_HELPER_PATH="$BIN_DIR/vessel-browser-update"
LAUNCHER_PATH="$BIN_DIR/vessel-browser"
STATUS_HELPER_PATH="$BIN_DIR/vessel-browser-status"
DEFAULT_PORT="${VESSEL_MCP_PORT:-3100}"
FORMAT="text"
ELECTRON_PATH="$INSTALL_DIR/node_modules/electron/dist/electron"
CHROME_SANDBOX_PATH="$INSTALL_DIR/node_modules/electron/dist/chrome-sandbox"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'error: missing required command: %s\n' "$1" >&2
    exit 1
  }
}

usage() {
  cat <<'HELP'
Usage: vessel-browser-status [--json] [--help]

Shows a deterministic status summary for a local Vessel install:
- whether the source install exists
- whether launcher/helper binaries exist
- whether ~/.local/bin is on PATH
- current MCP port and endpoint from settings
- whether the MCP endpoint is reachable
- whether a likely Vessel process is running
HELP
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)
      FORMAT="json"
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

require_cmd node

SOURCE_INSTALL=0
[[ -d "$INSTALL_DIR/.git" ]] && SOURCE_INSTALL=1

LAUNCHER_EXISTS=0
[[ -x "$LAUNCHER_PATH" ]] && LAUNCHER_EXISTS=1

MCP_HELPER_EXISTS=0
[[ -x "$MCP_HELPER_PATH" ]] && MCP_HELPER_EXISTS=1

UPDATE_HELPER_EXISTS=0
[[ -x "$UPDATE_HELPER_PATH" ]] && UPDATE_HELPER_EXISTS=1

STATUS_HELPER_EXISTS=0
[[ -x "$STATUS_HELPER_PATH" ]] && STATUS_HELPER_EXISTS=1

PATH_HAS_BIN=0
[[ ":$PATH:" == *":$BIN_DIR:"* ]] && PATH_HAS_BIN=1

RUNNING=0
RUNNING_MATCHES="$(pgrep -af "electron.*vessel-browser|$INSTALL_DIR|Vessel-.*AppImage" || true)"
RUNNING_MATCHES="$(printf '%s\n' "$RUNNING_MATCHES" | grep -Ev 'status-installation\.sh|vessel-browser-status|update-installation\.sh|vessel-browser-update|launch-installation\.sh|vessel-browser-launch|pgrep -af' || true)"
if [[ -n "$RUNNING_MATCHES" ]]; then
  RUNNING=1
fi

APPIMAGE_CANDIDATES=()
for candidate in \
  "$HOME/Downloads"/Vessel-*.AppImage \
  "$HOME/Applications"/Vessel-*.AppImage \
  "$HOME/Desktop"/Vessel-*.AppImage; do
  [[ -e "$candidate" ]] && APPIMAGE_CANDIDATES+=("$candidate")
done

NODE_OUTPUT="$(DEFAULT_PORT="$DEFAULT_PORT" SETTINGS_PATH="$SETTINGS_PATH" node <<'NODE'
const fs = require("fs");

const settingsPath = process.env.SETTINGS_PATH;
const defaultPort = Number(process.env.DEFAULT_PORT) || 3100;

let settingsExists = false;
let port = defaultPort;
let settingsError = null;

try {
  const raw = fs.readFileSync(settingsPath, "utf8");
  settingsExists = true;
  const parsed = JSON.parse(raw);
  const parsedPort = Number(parsed?.mcpPort);
  if (Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
    port = parsedPort;
  }
} catch (error) {
  if (fs.existsSync(settingsPath)) {
    settingsExists = true;
    settingsError = error instanceof Error ? error.message : String(error);
  }
}

process.stdout.write(JSON.stringify({
  settingsExists,
  port,
  settingsError,
}));
NODE
)"

SETTINGS_EXISTS="$(printf '%s' "$NODE_OUTPUT" | node -e 'const data=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(data.settingsExists ? "1" : "0");')"
MCP_PORT="$(printf '%s' "$NODE_OUTPUT" | node -e 'const data=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(data.port));')"
SETTINGS_ERROR="$(printf '%s' "$NODE_OUTPUT" | node -e 'const data=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(data.settingsError || "");')"
MCP_ENDPOINT="http://127.0.0.1:${MCP_PORT}/mcp"

MCP_CHECK="$(MCP_ENDPOINT="$MCP_ENDPOINT" node <<'NODE'
const endpoint = process.env.MCP_ENDPOINT;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 1500);

(async () => {
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timer);
    process.stdout.write(JSON.stringify({
      reachable: true,
      status: response.status,
      statusText: response.statusText,
    }));
  } catch (error) {
    clearTimeout(timer);
    process.stdout.write(JSON.stringify({
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
})();
NODE
)"

MCP_REACHABLE="$(printf '%s' "$MCP_CHECK" | node -e 'const data=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(data.reachable ? "1" : "0");')"
MCP_STATUS="$(printf '%s' "$MCP_CHECK" | node -e 'const data=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(data.status != null ? String(data.status) : "");')"
MCP_ERROR="$(printf '%s' "$MCP_CHECK" | node -e 'const data=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(data.error || "");')"

INSTALL_KIND="unknown"
if [[ "$SOURCE_INSTALL" -eq 1 ]]; then
  INSTALL_KIND="source"
elif [[ ${#APPIMAGE_CANDIDATES[@]} -gt 0 ]]; then
  INSTALL_KIND="appimage"
fi

PREFERRED_APPIMAGE=""
PREFERRED_APPIMAGE_MTIME=0
for candidate in "${APPIMAGE_CANDIDATES[@]}"; do
  candidate_mtime="$(stat -c '%Y' "$candidate" 2>/dev/null || printf '0')"
  if (( candidate_mtime >= PREFERRED_APPIMAGE_MTIME )); then
    PREFERRED_APPIMAGE="$candidate"
    PREFERRED_APPIMAGE_MTIME="$candidate_mtime"
  fi
done

SOURCE_LAUNCH_READY=0
SOURCE_LAUNCH_ISSUE=""
CHROME_SANDBOX_EXISTS=0
CHROME_SANDBOX_OWNER=""
CHROME_SANDBOX_MODE=""
CHROME_SANDBOX_SETUID=0

if [[ -e "$CHROME_SANDBOX_PATH" ]]; then
  CHROME_SANDBOX_EXISTS=1
  CHROME_SANDBOX_OWNER="$(stat -c '%u' "$CHROME_SANDBOX_PATH" 2>/dev/null || true)"
  CHROME_SANDBOX_MODE="$(stat -c '%a' "$CHROME_SANDBOX_PATH" 2>/dev/null || true)"
  if [[ -u "$CHROME_SANDBOX_PATH" ]]; then
    CHROME_SANDBOX_SETUID=1
  fi
fi

if [[ "$SOURCE_INSTALL" -eq 1 && -x "$ELECTRON_PATH" ]]; then
  if [[ "$CHROME_SANDBOX_EXISTS" -eq 1 && "$CHROME_SANDBOX_OWNER" == "0" && "$CHROME_SANDBOX_SETUID" -eq 1 ]]; then
    SOURCE_LAUNCH_READY=1
  else
    SOURCE_LAUNCH_ISSUE="sandbox-permissions"
  fi
fi

LAUNCH_RECOMMENDATION="unknown"
if [[ "$MCP_REACHABLE" -eq 1 ]]; then
  LAUNCH_RECOMMENDATION="already-running"
elif [[ "$SOURCE_INSTALL" -eq 1 && "$SOURCE_LAUNCH_READY" -eq 1 ]]; then
  LAUNCH_RECOMMENDATION="source"
elif [[ -n "$PREFERRED_APPIMAGE" ]]; then
  LAUNCH_RECOMMENDATION="appimage"
elif [[ "$SOURCE_INSTALL" -eq 1 && -x "$ELECTRON_PATH" ]]; then
  LAUNCH_RECOMMENDATION="source-with-warning"
fi

if [[ "$FORMAT" == "json" ]]; then
  APPIMAGE_JSON="$(printf '%s\n' "${APPIMAGE_CANDIDATES[@]:-}" | node -e 'const fs=require("fs"); const items=fs.readFileSync(0,"utf8").split(/\n/).map(s=>s.trim()).filter(Boolean); process.stdout.write(JSON.stringify(items));')"
  MATCHES_JSON="$(printf '%s\n' "$RUNNING_MATCHES" | node -e 'const fs=require("fs"); const items=fs.readFileSync(0,"utf8").split(/\n/).map(s=>s.trim()).filter(Boolean); process.stdout.write(JSON.stringify(items));')"
  cat <<JSON
{
  "install_kind": "$INSTALL_KIND",
  "install_dir": "$INSTALL_DIR",
  "source_install": $( [[ "$SOURCE_INSTALL" -eq 1 ]] && printf 'true' || printf 'false' ),
  "launcher_exists": $( [[ "$LAUNCHER_EXISTS" -eq 1 ]] && printf 'true' || printf 'false' ),
  "mcp_helper_exists": $( [[ "$MCP_HELPER_EXISTS" -eq 1 ]] && printf 'true' || printf 'false' ),
  "update_helper_exists": $( [[ "$UPDATE_HELPER_EXISTS" -eq 1 ]] && printf 'true' || printf 'false' ),
  "status_helper_exists": $( [[ "$STATUS_HELPER_EXISTS" -eq 1 ]] && printf 'true' || printf 'false' ),
  "bin_dir": "$BIN_DIR",
  "bin_dir_on_path": $( [[ "$PATH_HAS_BIN" -eq 1 ]] && printf 'true' || printf 'false' ),
  "settings_path": "$SETTINGS_PATH",
  "settings_exists": $( [[ "$SETTINGS_EXISTS" -eq 1 ]] && printf 'true' || printf 'false' ),
  "settings_error": $(printf '%s' "$SETTINGS_ERROR" | node -e 'const fs=require("fs"); process.stdout.write(JSON.stringify(fs.readFileSync(0,"utf8")));'),
  "mcp_port": $MCP_PORT,
  "mcp_endpoint": "$MCP_ENDPOINT",
  "mcp_reachable": $( [[ "$MCP_REACHABLE" -eq 1 ]] && printf 'true' || printf 'false' ),
  "mcp_status": $( [[ -n "$MCP_STATUS" ]] && printf '%s' "$MCP_STATUS" || printf 'null' ),
  "mcp_error": $(printf '%s' "$MCP_ERROR" | node -e 'const fs=require("fs"); process.stdout.write(JSON.stringify(fs.readFileSync(0,"utf8")));'),
  "running": $( [[ "$RUNNING" -eq 1 ]] && printf 'true' || printf 'false' ),
  "running_matches": $MATCHES_JSON,
  "source_electron_path": $(printf '%s' "$ELECTRON_PATH" | node -e 'const fs=require("fs"); process.stdout.write(JSON.stringify(fs.readFileSync(0,"utf8")));'),
  "source_launch_ready": $( [[ "$SOURCE_LAUNCH_READY" -eq 1 ]] && printf 'true' || printf 'false' ),
  "source_launch_issue": $(printf '%s' "$SOURCE_LAUNCH_ISSUE" | node -e 'const fs=require("fs"); process.stdout.write(JSON.stringify(fs.readFileSync(0,"utf8")));'),
  "launch_recommendation": "$LAUNCH_RECOMMENDATION",
  "chrome_sandbox_path": $(printf '%s' "$CHROME_SANDBOX_PATH" | node -e 'const fs=require("fs"); process.stdout.write(JSON.stringify(fs.readFileSync(0,"utf8")));'),
  "chrome_sandbox_exists": $( [[ "$CHROME_SANDBOX_EXISTS" -eq 1 ]] && printf 'true' || printf 'false' ),
  "chrome_sandbox_owner_uid": $( [[ -n "$CHROME_SANDBOX_OWNER" ]] && printf '%s' "$CHROME_SANDBOX_OWNER" || printf 'null' ),
  "chrome_sandbox_mode": $(printf '%s' "$CHROME_SANDBOX_MODE" | node -e 'const fs=require("fs"); process.stdout.write(JSON.stringify(fs.readFileSync(0,"utf8")));'),
  "chrome_sandbox_setuid": $( [[ "$CHROME_SANDBOX_SETUID" -eq 1 ]] && printf 'true' || printf 'false' ),
  "preferred_appimage": $(printf '%s' "$PREFERRED_APPIMAGE" | node -e 'const fs=require("fs"); process.stdout.write(JSON.stringify(fs.readFileSync(0,"utf8")));'),
  "appimage_candidates": $APPIMAGE_JSON
}
JSON
  exit 0
fi

printf 'Install kind: %s\n' "$INSTALL_KIND"
printf 'Source install: %s\n' "$( [[ "$SOURCE_INSTALL" -eq 1 ]] && printf 'yes' || printf 'no' )"
printf 'Launcher present: %s (%s)\n' "$( [[ "$LAUNCHER_EXISTS" -eq 1 ]] && printf 'yes' || printf 'no' )" "$LAUNCHER_PATH"
printf 'MCP helper present: %s (%s)\n' "$( [[ "$MCP_HELPER_EXISTS" -eq 1 ]] && printf 'yes' || printf 'no' )" "$MCP_HELPER_PATH"
printf 'Update helper present: %s (%s)\n' "$( [[ "$UPDATE_HELPER_EXISTS" -eq 1 ]] && printf 'yes' || printf 'no' )" "$UPDATE_HELPER_PATH"
printf 'PATH contains %s: %s\n' "$BIN_DIR" "$( [[ "$PATH_HAS_BIN" -eq 1 ]] && printf 'yes' || printf 'no' )"
printf 'Settings file: %s (%s)\n' "$SETTINGS_PATH" "$( [[ "$SETTINGS_EXISTS" -eq 1 ]] && printf 'present' || printf 'missing' )"
if [[ -n "$SETTINGS_ERROR" ]]; then
  printf 'Settings parse issue: %s\n' "$SETTINGS_ERROR"
fi
printf 'Configured MCP endpoint: %s\n' "$MCP_ENDPOINT"
if [[ "$MCP_REACHABLE" -eq 1 ]]; then
  printf 'MCP reachable: yes'
  [[ -n "$MCP_STATUS" ]] && printf ' (HTTP %s)' "$MCP_STATUS"
  printf '\n'
else
  printf 'MCP reachable: no'
  [[ -n "$MCP_ERROR" ]] && printf ' (%s)' "$MCP_ERROR"
  printf '\n'
fi
printf 'Likely Vessel process running: %s\n' "$( [[ "$RUNNING" -eq 1 ]] && printf 'yes' || printf 'no' )"
if [[ -n "$RUNNING_MATCHES" ]]; then
  printf 'Process matches:\n%s\n' "$RUNNING_MATCHES"
fi
if [[ "$SOURCE_INSTALL" -eq 1 ]]; then
  printf 'Source launch ready: %s\n' "$( [[ "$SOURCE_LAUNCH_READY" -eq 1 ]] && printf 'yes' || printf 'no' )"
  if [[ -n "$SOURCE_LAUNCH_ISSUE" ]]; then
    printf 'Source launch issue: %s\n' "$SOURCE_LAUNCH_ISSUE"
  fi
fi
printf 'Launch recommendation: %s\n' "$LAUNCH_RECOMMENDATION"
if [[ -n "$PREFERRED_APPIMAGE" ]]; then
  printf 'Preferred AppImage: %s\n' "$PREFERRED_APPIMAGE"
fi
if [[ ${#APPIMAGE_CANDIDATES[@]} -gt 0 ]]; then
  printf 'AppImage candidates:\n'
  printf '  %s\n' "${APPIMAGE_CANDIDATES[@]}"
fi
