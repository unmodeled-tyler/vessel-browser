# Development Guide

## Install Paths

The packaged AppImage path:

- does not require a local Node or Electron toolchain
- uses the packaged Vessel app icon and metadata
- is the recommended path for early adopters who just want to run Vessel

The source installer:

- clones or updates Vessel into `~/.local/share/vessel-browser`
- installs dependencies and builds the app
- creates a `vessel-browser` launcher in `~/.local/bin`
- creates a `vessel-browser-launch` helper in `~/.local/bin`
- creates a `vessel-browser-update` helper in `~/.local/bin`
- creates a `vessel-browser-status` helper in `~/.local/bin`
- creates a desktop entry for Linux app launchers
- writes `~/.config/vessel/vessel-settings.json` with MCP port `3100`
- writes `~/.config/vessel/mcp-http-snippet.json`
- prints the exact HTTP MCP snippet to paste into your harness config

After a source install:

```bash
vessel-browser
```

## Local Development

```bash
# Install dependencies
npm install

# If Electron download fails, use a mirror
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm install

# Development (with HMR)
npm run dev

# Production build
npm run build

# Smoke-test the MVP release path
npm run smoke:test
```

Notes:

- `npm run dev` still launches the stock Electron binary, so Linux may continue showing the default Electron gear icon in development
- packaged builds created with `npm run dist` or `npm run dist:dir` use the Vessel app icon
- the tracked smoke test runs typecheck, build, and the Electron navigation regression harness
- for headless CI, run the smoke test under `xvfb-run -a npm run smoke:test`

## Helper Commands

The installer writes both MCP snippets to:

- `~/.config/vessel/mcp-http-snippet.json`
- `~/.config/vessel/mcp-hermes-snippet.yaml`

It also installs a helper command:

```bash
vessel-browser-mcp
```

Helper examples:

```bash
# Generic JSON snippet
vessel-browser-mcp

# Hermes-ready YAML snippet
vessel-browser-mcp --format hermes

# Raw MCP endpoint URL
vessel-browser-mcp --format url
```

Source install update helpers:

```bash
# Check whether a source-install update is available
vessel-browser-update --check

# Fetch, rebuild, and update the local source install
vessel-browser-update
```

Status helper:

```bash
# Human-readable local install + MCP status
vessel-browser-status

# Machine-readable status for harnesses
vessel-browser-status --json
```

Smart launch helper:

```bash
# Launch Vessel using the best available local install
vessel-browser-launch

# Show the chosen launch path without starting anything
vessel-browser-launch --dry-run
```

`vessel-browser-launch` prefers a healthy source install and falls back to the newest local AppImage when the source install is likely blocked by Electron sandbox permissions.
