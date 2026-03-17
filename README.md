![vessel-logo-cropped](https://github.com/user-attachments/assets/58887932-26b3-45b5-be5e-21de562d2855)

# Vessel: Your Agent's Browser

Open-source browser runtime for persistent web agents on Linux.

Vessel gives external agent harnesses a real browser with durable state, MCP control, and a human-visible supervisory UI. It is built for long-running workflows where the agent drives and the human audits, intervenes, and redirects when needed.

- **Built for agent harnesses** such as Hermes Agent, OpenClaw, and other MCP clients
- **Keeps browser state alive** with named sessions, bookmarks, checkpoints, and structured page visibility
- **Keeps humans in the loop** with approvals, runtime controls, and a visible browser instead of a headless black box

*Vessel is in active development and currently makes no security assurances. Use and deploy it with care.*

## What Vessel Gives a Harness

When you point an MCP-capable agent at Vessel, it gets more than generic browser automation:

- **A persistent browser runtime** with cookies, localStorage, tab layout, named sessions, and checkpoints
- **Human-focused tab awareness** so the agent can cheaply tell which tab the human is currently looking at
- **Structured page context** with headings, interactives, overlays, forms, and article metadata instead of raw DOM soup
- **Bidirectional highlights and annotations** that show up both in the visible browser and in model-facing page context
- **A visible supervisory surface** for approvals, runtime state, bookmarks, checkpoints, and transcript monitoring

In practice, Vessel is meant to be the shared browser surface between the harness and the human, not just a remote-controlled renderer.

## Quick Start

### Fastest Install Today

The preferred MVP install path is the Linux AppImage from GitHub Releases:

1. Download the latest `Vessel-<version>-x64.AppImage`
2. Mark it executable: `chmod +x Vessel-*.AppImage`
3. Launch it: `./Vessel-*.AppImage`
4. Open Settings (`Ctrl+,`) and confirm the MCP endpoint shown there

### Source Install

```bash
curl -fsSL https://raw.githubusercontent.com/unmodeled-tyler/quanta-vessel-browser/main/scripts/install.sh | bash
```

### Development From Source

```bash
npm install
npm run dev
```

### Why Vessel?

Most browser automation stacks are either headless, stateless, or designed around a human as the primary operator. Vessel is built around the opposite model: the browser is the agent's operating surface, and the human stays in the loop through a visible interface with clear supervisory controls.

<img width="1280" height="800" alt="vessel_2026-03-10_170917_8761" src="https://github.com/user-attachments/assets/ce2c96dc-d1c1-43dc-aba6-19441ca4228d" />

<img width="1280" height="800" alt="vessel_2026-03-10_204143_6698" src="https://github.com/user-attachments/assets/a50ab3ae-08bf-4696-8e49-91c0976e8c68" />

Vessel is built for persistent web agents that need a real browser, durable state, and a human-visible interface. The agent is the primary operator. The human follows along in the live browser UI, audits what the agent is doing, and steers when needed.

Today, Vessel provides the browser shell, page visibility, and supervisory surfaces needed to support that model. The long-term goal is not "a browser with AI features," but a browser runtime for autonomous agents with a clear supervisory experience for humans.

## Features

- **Agent-first browser model** — Vessel is designed around an agent driving the browser while a human watches, intervenes, and redirects
- **Human-visible browser UI** — pages render like a normal browser so agent activity stays legible instead of disappearing into a headless run
- **Active tab awareness** — MCP clients can ask for the current human-focused tab directly instead of inferring context from the full tab list
- **Structured page reads** — `read_page` and extraction modes provide a model-friendly view of the current page, including headings, forms, overlays, structured data, and annotations
- **Bidirectional highlighting** — saved highlights and current-page annotations are visible in-browser and reflected back into model-facing page context
- **Transcript monitor** — external harnesses can publish status or reasoning updates directly into Vessel's in-browser transcript dock
- **Command Bar** (`Ctrl+L`) — a secondary operator surface for harness-driven workflows and future runtime commands, not the primary chat interface
- **Supervisor Sidebar** (`Ctrl+Shift+L`) — live supervision split into Supervisor, Bookmarks, and Checkpoints panels
- **Bookmarks for Agents** — save pages into folders, attach one-line folder summaries, and search bookmarks over MCP instead of dumping the entire library
- **Named Session Persistence** — save cookies, localStorage, and current tab layout under a reusable name, then reload it after a restart
- **Structured Page Visibility Context** — extraction can report in-viewport elements, obscured controls, active overlays, and dormant consent/modal UI
- **Popup Recovery Tools** — agents can explicitly dismiss common popups, newsletter gates, and consent walls instead of brute-forcing generic clicks
- **Per-Tab Ad Blocking Controls** — tabs default to ad blocking on, but agents can selectively disable and re-enable blocking when a page misbehaves
- **Obsidian Memory Hooks** — optional vault path for agent-written markdown notes, page captures, and research breadcrumbs
- **Runtime Health Checks** — startup warnings for MCP port conflicts, unreadable settings, and user-data write failures
- **Reader Mode** — extract article content into a clean, distraction-free view
- **Focus Mode** (`Ctrl+Shift+F`) — hide all chrome, content fills the screen
- **Resizable Panels** — drag the sidebar edge to resize; width persists across sessions
- **Minimal Dark Theme** — warm dark grays, restrained accent color, and no pure black/white

## Positioning

Most browsers treat automation as secondary and assume a human is the primary actor. Vessel is the opposite: it is the browser for the agent, with a visible interface that keeps the human in the loop.

That means the product should optimize for:

- persistent browser state across tasks and sessions
- clear visibility into what the agent is doing right now
- lightweight human intervention instead of constant manual driving
- a browser runtime that can serve long-lived agent systems such as Hermes Agent or OpenClaw-style harnesses

## Stack

| Layer | Technology |
|-------|-----------|
| Engine | Chromium (Electron 40) |
| UI Framework | SolidJS |
| Language | TypeScript |
| Build | electron-vite + Vite |
| AI Control | External agent harnesses (Hermes Agent, OpenClaw, MCP clients) |
| Content Extraction | @mozilla/readability |

## Architecture

```
Main Process                              Renderer (SolidJS)
├── TabManager (WebContentsView[])        ├── TabBar, AddressBar
├── AgentRuntime (session + supervision)  ├── CommandBar (secondary surface)
├── MCP server for external agents        ├── Supervisor Sidebar (resizable)
├── Supervision, bookmarks, checkpoints   └── Signal stores (tabs, ai, ui)
└── IPC Handlers ◄──contextBridge──► Preload API
```

Each browser tab is a separate `WebContentsView` managed by the main process. The browser chrome (SolidJS) runs in its own view layered on top. All communication between renderer and main goes through typed IPC channels via `contextBridge`.

## Getting Started

The installer:

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

The packaged AppImage path:

- does not require a local Node/Electron toolchain
- uses the packaged Vessel app icon and metadata
- is the recommended path for early adopters who just want to run Vessel

After install:

```bash
vessel-browser
```

```bash
# Install dependencies
npm install

# If Electron download fails, use a mirror:
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm install

# Development (with HMR)
npm run dev

# Production build
npm run build

# Smoke-test the MVP release path
npm run smoke:test

# Package an unpacked Linux app
npm run dist:dir

# Package a Linux AppImage
npm run dist
```

Notes:

- `npm run dev` still launches the stock Electron binary, so Linux may continue showing the default Electron gear icon in development
- packaged builds created with `npm run dist` / `npm run dist:dir` use the Vessel app icon
- the tracked smoke test runs typecheck, build, and the Electron navigation regression harness
- for headless CI, run the smoke test under `xvfb-run -a npm run smoke:test`

### Setting up Vessel for Hermes Agent or OpenClaw

Vessel is designed to act as the browser runtime that your external agent harness drives.

1. Launch Vessel
2. Open Settings (`Ctrl+,`) to confirm MCP status, copy the endpoint, or change the MCP port
3. Optional: set an Obsidian vault path or session preferences
4. Start Hermes Agent or OpenClaw and configure it to connect to Vessel's MCP endpoint at `http://127.0.0.1:<mcpPort>/mcp`
5. Use the Supervisor panel in Vessel's sidebar to pause the agent, change approval mode, review pending approvals, checkpoint, or restore the browser session while the harness runs
6. Use the Bookmarks panel to organize saved pages into folders and expose those bookmarks back to the agent over MCP

Notes:

- Vessel exposes browser control to external agents through its local MCP server
- The default MCP port is `3100`
- Hermes Agent and OpenClaw should treat Vessel as the persistent, human-visible browser rather than launching their own separate browser session
- Vessel does not expose local model or provider configuration in-app
- Approval policy is controlled live from the sidebar Supervisor panel rather than a separate global settings screen
- Settings now show MCP runtime status, active endpoint, startup warnings, and allow changing the MCP port with an immediate server restart
- Agents can selectively disable ad blocking for a problematic tab, reload, retry the flow, and turn blocking back on later
- Agents can persist authenticated state with named sessions, for example `github-logged-in`, and reload that state in later runs
- The intended control plane is an external harness driving Vessel through MCP
- If you set an Obsidian vault path in Settings, harnesses can write markdown notes directly into that vault via Vessel memory MCP tools

Two especially useful MCP surfaces for grounding agent context are:

- `vessel_current_tab` and the `vessel://tabs/active` resource for the tab currently visible to the human user
- `vessel_read_page` for structured, model-facing page context that includes highlights and annotations

Initial memory tools:

- `vessel_memory_note_create`
- `vessel_memory_append`
- `vessel_memory_list`
- `vessel_memory_search`
- `vessel_memory_page_capture`
- `vessel_memory_link_bookmark`

Bookmark and folder tools exposed today include:

- `vessel_bookmark_list`
- `vessel_bookmark_search`
- `vessel_bookmark_open`
- `vessel_bookmark_save`
- `vessel_bookmark_remove`
- `vessel_create_folder`
- `vessel_folder_rename`
- `vessel_folder_remove`

Page interaction and recovery tools exposed today include:

- `vessel_current_tab`
- `vessel_extract_content`
- `vessel_read_page`
- `vessel_list_highlights`
- `vessel_highlight`
- `vessel_clear_highlights`
- `vessel_scroll`
- `vessel_dismiss_popup`
- `vessel_set_ad_blocking`
- `vessel_wait_for`

Named session tools exposed today include:

- `vessel_save_session`
- `vessel_load_session`
- `vessel_list_sessions`
- `vessel_delete_session`

Session files are sensitive because they may contain login cookies and tokens. Vessel stores them under the app user-data directory with restrictive file permissions.

Notable extraction modes include:

- `visible_only` — only currently visible, in-viewport, unobstructed interactive elements plus active overlays
- `results_only` — likely primary search/result links only
- `full` / `summary` / `interactives_only` / `forms_only` / `text_only`

The extraction output can distinguish:

- active blocking overlays
- dormant consent/modal UI present in the DOM but not active for the current session or region
- saved highlights plus live page annotations that the agent should consider part of the visible context

MCP resources exposed today include:

- `vessel://tabs/active`
- `vessel://runtime/state`

Generic Codex / HTTP MCP config:

```toml
[mcp_servers.vessel]
url = "http://127.0.0.1:3100/mcp"
```

Generic HTTP MCP config:

```json
{
  "mcpServers": {
    "vessel": {
      "type": "http",
      "url": "http://127.0.0.1:3100/mcp"
    }
  }
}
```

Hermes Agent `config.yaml` MCP config:

```yaml
mcp_servers:
  vessel:
    url: "http://127.0.0.1:3100/mcp"
    timeout: 180
    connect_timeout: 30
```

## Packaging And Releases

For the current MVP, the supported packaged target is:

- Linux x64 AppImage

Repo commands:

- `npm run smoke:test` — typecheck, production build, and Electron navigation regression
- `npm run dist` — package the Linux AppImage
- `npm run dist:dir` — package an unpacked Linux build

Release automation lives in:

- [ci.yml](./.github/workflows/ci.yml)
- [preview-build.yml](./.github/workflows/preview-build.yml)
- [promote-dev-to-main.yml](./.github/workflows/promote-dev-to-main.yml)
- [release.yml](./.github/workflows/release.yml)
- [release-checklist.md](./docs/release-checklist.md)

Recommended branch flow:

- `dev` is the day-to-day branch for active work
- every push to `dev` runs the preview AppImage workflow and updates the rolling `edge` prerelease
- `main` stays stable for users
- a scheduled workflow on `main` opens or refreshes a `dev -> main` PR once per day, waits for PR checks, and merges only if they pass
- `v*` tags on `main` still produce official stable releases

Recommended GitHub settings:

- create the `dev` branch in the remote repository
- enable branch protection on `main` if you want extra safety against manual direct pushes

The installer writes both snippets to:

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

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+L` | AI Command Bar |
| `Ctrl+H` | Capture current text selection as a highlight |
| `Ctrl+Shift+L` | Toggle Supervisor Sidebar |
| `Ctrl+Shift+F` | Toggle Focus Mode |
| `Ctrl+T` | New Tab |
| `Ctrl+W` | Close Tab |
| `Ctrl+,` | Settings |

## Project Structure

```
src/
├── main/                 # Electron main process
│   ├── ai/               # Agent tool definitions and query flow
│   ├── tabs/             # Tab + TabManager (WebContentsView)
│   ├── agent/            # Agent runtime, checkpoints, supervision
│   ├── content/          # Readability extraction, reader mode
│   ├── config/           # Settings persistence
│   ├── ipc/              # IPC handler registry
│   ├── mcp/              # MCP server for external agent control
│   ├── window.ts         # Window layout manager
│   └── index.ts          # App entry point
├── preload/              # contextBridge scripts
│   ├── index.ts          # Chrome UI preload
│   └── content-script.ts # Web page preload (readability)
├── renderer/             # SolidJS browser UI
│   └── src/
│       ├── components/
│       │   ├── chrome/   # TitleBar, TabBar, AddressBar
│       │   ├── ai/       # CommandBar, Sidebar
│       │   └── shared/   # Settings panel
│       ├── stores/       # SolidJS signal stores
│       ├── styles/       # Theme, global CSS
│       └── lib/          # Keybindings
└── shared/               # Types + IPC channel constants
```

## Design Principles

- **Agent first** — the browser is the agent's operating surface, not just a human tool with automation bolted on
- **Human visible** — the UI should make agent behavior easy to follow, audit, and steer
- **Persistent by default** — browser state should survive long-running workflows and repeated sessions
- **Content first** — chrome is 110px, everything else is your page
- **Easy on the eyes** — warm dark grays, muted text, no visual noise
- **Linux-native** — frameless window, system font fallbacks, XDG conventions

## License

MIT

*Developed by Tyler Williams in Portland, Oregon (2026)*
