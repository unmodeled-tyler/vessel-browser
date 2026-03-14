#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${VESSEL_REPO_URL:-https://github.com/unmodeled-tyler/quanta-vessel-browser.git}"
BRANCH="${VESSEL_BRANCH:-main}"
INSTALL_DIR="${VESSEL_INSTALL_DIR:-$HOME/.local/share/vessel-browser}"
BIN_DIR="${VESSEL_BIN_DIR:-$HOME/.local/bin}"
DESKTOP_DIR="${VESSEL_DESKTOP_DIR:-$HOME/.local/share/applications}"
CONFIG_DIR="${VESSEL_CONFIG_DIR:-$HOME/.config/vessel}"
SETTINGS_PATH="$CONFIG_DIR/vessel-settings.json"
MCP_SNIPPET_PATH="$CONFIG_DIR/mcp-http-snippet.json"
HERMES_SNIPPET_PATH="$CONFIG_DIR/mcp-hermes-snippet.yaml"
MCP_PORT="${VESSEL_MCP_PORT:-3100}"

info() {
  printf '\033[1;34m==>\033[0m %s\n' "$1"
}

warn() {
  printf '\033[1;33m==>\033[0m %s\n' "$1"
}

fail() {
  printf '\033[1;31merror:\033[0m %s\n' "$1" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

if [[ "$(uname -s)" != "Linux" ]]; then
  fail "Vessel currently supports Linux installs only."
fi

require_cmd git
require_cmd node
require_cmd npm

mkdir -p "$BIN_DIR" "$DESKTOP_DIR" "$CONFIG_DIR"

if [[ -d "$INSTALL_DIR" && ! -d "$INSTALL_DIR/.git" ]]; then
  fail "Install path exists and is not a git checkout: $INSTALL_DIR"
fi

if [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Updating Vessel in $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
else
  info "Cloning Vessel into $INSTALL_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

info "Installing npm dependencies"
npm --prefix "$INSTALL_DIR" install

info "Building Vessel"
npm --prefix "$INSTALL_DIR" run build

LAUNCHER_PATH="$BIN_DIR/vessel-browser"
MCP_HELPER_PATH="$BIN_DIR/vessel-browser-mcp"
UPDATE_HELPER_PATH="$BIN_DIR/vessel-browser-update"
STATUS_HELPER_PATH="$BIN_DIR/vessel-browser-status"
SMART_LAUNCHER_PATH="$BIN_DIR/vessel-browser-launch"
DESKTOP_ENTRY_PATH="$DESKTOP_DIR/vessel-browser.desktop"

info "Creating launcher at $LAUNCHER_PATH"
cat >"$LAUNCHER_PATH" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$INSTALL_DIR"
exec "$INSTALL_DIR/node_modules/electron/dist/electron" "$INSTALL_DIR" "\$@"
EOF
chmod +x "$LAUNCHER_PATH"

info "Creating update helper at $UPDATE_HELPER_PATH"
cat >"$UPDATE_HELPER_PATH" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export VESSEL_INSTALL_DIR="$INSTALL_DIR"
export VESSEL_BRANCH="$BRANCH"
exec bash "$INSTALL_DIR/scripts/update-installation.sh" "\$@"
EOF
chmod +x "$UPDATE_HELPER_PATH"

info "Creating status helper at $STATUS_HELPER_PATH"
cat >"$STATUS_HELPER_PATH" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export VESSEL_INSTALL_DIR="$INSTALL_DIR"
export VESSEL_BIN_DIR="$BIN_DIR"
export VESSEL_CONFIG_DIR="$CONFIG_DIR"
export VESSEL_MCP_PORT="$MCP_PORT"
exec bash "$INSTALL_DIR/scripts/status-installation.sh" "\$@"
EOF
chmod +x "$STATUS_HELPER_PATH"

info "Creating smart launcher at $SMART_LAUNCHER_PATH"
cat >"$SMART_LAUNCHER_PATH" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export VESSEL_INSTALL_DIR="$INSTALL_DIR"
export VESSEL_BIN_DIR="$BIN_DIR"
export VESSEL_CONFIG_DIR="$CONFIG_DIR"
exec bash "$INSTALL_DIR/scripts/launch-installation.sh" "\$@"
EOF
chmod +x "$SMART_LAUNCHER_PATH"

info "Creating MCP helper at $MCP_HELPER_PATH"
cat >"$MCP_HELPER_PATH" <<EOF
#!/usr/bin/env bash
set -euo pipefail
SETTINGS_PATH="${SETTINGS_PATH}"
DEFAULT_PORT="${MCP_PORT}"
FORMAT="json"

while [[ \$# -gt 0 ]]; do
  case "\$1" in
    --format)
      shift
      FORMAT="\${1:-}"
      ;;
    --format=*)
      FORMAT="\${1#*=}"
      ;;
    --hermes)
      FORMAT="hermes"
      ;;
    --json)
      FORMAT="json"
      ;;
    --url)
      FORMAT="url"
      ;;
    --help|-h)
      cat <<'HELP'
Usage: vessel-browser-mcp [--format json|hermes|url]

Formats:
  json    Generic MCP JSON snippet (default)
  hermes  Hermes config.yaml snippet
  url     Raw MCP endpoint URL
HELP
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "\$1" >&2
      exit 1
      ;;
  esac
  shift
done

PORT="\$DEFAULT_PORT"
if [[ -f "\$SETTINGS_PATH" ]]; then
  PARSED_PORT=\$(SETTINGS_PATH="\$SETTINGS_PATH" DEFAULT_PORT="\$DEFAULT_PORT" node <<'NODE'
const fs = require("fs");

const settingsPath = process.env.SETTINGS_PATH;
const defaultPort = Number(process.env.DEFAULT_PORT) || 3100;

try {
  const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const port = Number(parsed?.mcpPort);
  if (Number.isInteger(port) && port >= 1 && port <= 65535) {
    process.stdout.write(String(port));
  } else {
    process.stdout.write(String(defaultPort));
  }
} catch {
  process.stdout.write(String(defaultPort));
}
NODE
)
  PORT="\${PARSED_PORT:-\$DEFAULT_PORT}"
fi

case "\$FORMAT" in
  json)
    cat <<JSON
{
  "mcpServers": {
    "vessel": {
      "type": "http",
      "url": "http://127.0.0.1:\${PORT}/mcp"
    }
  }
}
JSON
    ;;
  hermes)
    cat <<YAML
mcp_servers:
  vessel:
    url: "http://127.0.0.1:\${PORT}/mcp"
    timeout: 180
    connect_timeout: 30
YAML
    ;;
  url)
    printf 'http://127.0.0.1:%s/mcp\n' "\$PORT"
    ;;
  *)
    printf 'Unsupported format: %s\n' "\$FORMAT" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$MCP_HELPER_PATH"

info "Creating desktop entry at $DESKTOP_ENTRY_PATH"
cat >"$DESKTOP_ENTRY_PATH" <<EOF
[Desktop Entry]
Type=Application
Name=Vessel Browser
Comment=Agent-first browser runtime
Exec=$LAUNCHER_PATH %U
Terminal=false
Categories=Network;WebBrowser;Development;
StartupNotify=true
EOF

info "Writing default Vessel settings"
SETTINGS_PATH="$SETTINGS_PATH" MCP_PORT="$MCP_PORT" node <<'EOF'
const fs = require("fs");
const path = require("path");

const settingsPath = process.env.SETTINGS_PATH;
const port = Number(process.env.MCP_PORT) || 3100;
const defaults = {
  defaultUrl: "https://start.duckduckgo.com",
  theme: "dark",
  sidebarWidth: 340,
  mcpPort: port,
  autoRestoreSession: true,
  clearBookmarksOnLaunch: false,
  obsidianVaultPath: "",
  approvalMode: "confirm-dangerous",
};

let parsed = {};
try {
  parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
} catch {}

delete parsed.provider;
delete parsed.apiKey;

const merged = {
  ...defaults,
  ...parsed,
  mcpPort: port,
};

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
EOF

info "Writing MCP snippet to $MCP_SNIPPET_PATH"
cat >"$MCP_SNIPPET_PATH" <<EOF
{
  "mcpServers": {
    "vessel": {
      "type": "http",
      "url": "http://127.0.0.1:${MCP_PORT}/mcp"
    }
  }
}
EOF

info "Writing Hermes MCP snippet to $HERMES_SNIPPET_PATH"
cat >"$HERMES_SNIPPET_PATH" <<EOF
mcp_servers:
  vessel:
    url: "http://127.0.0.1:${MCP_PORT}/mcp"
    timeout: 180
    connect_timeout: 30
EOF

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  warn "$BIN_DIR is not on your PATH."
  warn "Add this line to your shell profile if needed:"
  printf 'export PATH="%s:$PATH"\n' "$BIN_DIR"
fi

cat <<EOF

Vessel install complete.

Launch Vessel:
  $LAUNCHER_PATH

Default MCP endpoint:
  http://127.0.0.1:${MCP_PORT}/mcp

Generic HTTP MCP snippet:
$(cat "$MCP_SNIPPET_PATH")

Hermes config.yaml snippet:
$(cat "$HERMES_SNIPPET_PATH")

You can print the snippet any time with:
  $MCP_HELPER_PATH
  $MCP_HELPER_PATH --format hermes

To check for source-install updates:
  $UPDATE_HELPER_PATH --check

To update Vessel from source:
  $UPDATE_HELPER_PATH

To inspect Vessel install and MCP status:
  $STATUS_HELPER_PATH
  $STATUS_HELPER_PATH --json

To launch Vessel using the best available local install:
  $SMART_LAUNCHER_PATH
  $SMART_LAUNCHER_PATH --dry-run

Notes:
  - Vessel must be running before your harness connects.
  - Settings live at $SETTINGS_PATH
  - Bookmarks persist by default.
EOF
