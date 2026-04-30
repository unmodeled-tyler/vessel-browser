<div align="center">
  
![quanta-intellect-logo-transparent](https://cdn-uploads.huggingface.co/production/uploads/686c460ba3fc457ad14ab6f8/gB6J60f9Yeyb3Thop2dUa.png)

<a href="https://snapcraft.io/vessel-browser">
    <img alt="Get it from the Snap Store" src=https://snapcraft.io/en/dark/install.svg />
  </a>
  <a href="https://www.producthunt.com/products/quanta-intellect?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-vessel-browser-from-quanta-intellect" target="_blank" rel="noopener noreferrer"><img alt="Vessel Browser from Quanta Intellect - The browser where agents drive and humans supervise | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1107491&amp;theme=dark&amp;t=1774779141692"></a>

# Vessel: Your Agent's Browser
</div>


Open source chromium-based browser for persistent web agents. Linux is the most mature install target today, and macOS release packaging is available from source.

Vessel gives external agent harnesses a real browser with durable state, MCP control, and a human-visible supervisory UI. It is built for long-running workflows where the agent drives and the human audits, intervenes, and redirects when needed.

- **Built for agent harnesses** such as Hermes Agent, OpenClaw, and other MCP clients
- **Keeps browser state alive** with named sessions, pinned tabs, editable/exportable bookmarks, annotated checkpoints, action undo, and structured page visibility
- **Keeps humans in the loop** with approvals, runtime controls, and a visible browser instead of a headless black box

*Vessel is in active development and currently makes no security assurances. Use and deploy it with care.*



https://github.com/user-attachments/assets/0a72b48a-873a-4eb0-b8f2-23e34d8472c4



## Quick Start

Want the full agent toolkit from day one? [Start a 7-Day Free Trial of Vessel Premium — $5.99/mo](https://vesselpremium.quantaintellect.com/checkout).

### Fastest Install Today

Linux AppImage from GitHub Releases:

1. Download the latest `Vessel-<version>-x64.AppImage`
2. Mark it executable: `chmod +x Vessel-*.AppImage`
3. Launch it: `./Vessel-*.AppImage`
4. Open Settings (`Ctrl+,`) and confirm the MCP endpoint shown there

### Install via npm

```bash
npm install -g @quanta-intellect/vessel-browser
vessel-browser
```

Or run it directly without installing:

```bash
npx @quanta-intellect/vessel-browser
```

### Source Install

```bash
curl -fsSL https://raw.githubusercontent.com/unmodeled-tyler/quanta-vessel-browser/main/scripts/install.sh | bash
```

### Development From Source

Vessel development uses Node.js 22. If you use `fnm`, run `fnm use` from the repo root to pick up `.node-version`.

```bash
npm install
npm run dev
```

If you want extra local AI tracing in development, create an optional `src/main/telemetry/trace-logger.local.cjs` file. Vessel will load it only in local dev builds, and packaged production builds ignore it.

### Why Vessel?

Most browser automation stacks are either headless, stateless, or designed around a human as the primary operator. Vessel is built around the opposite model: the browser is the agent's operating surface, and the human stays in the loop through a visible interface with clear supervisory controls.

<img width="1280" height="800" alt="@quanta-intellectvessel-browser_2026-03-17_200224_6613" src="https://github.com/user-attachments/assets/8e208ee1-cb89-4318-87a2-9561a7d9aecf" />
<img width="1280" height="800" alt="vessel_2026-03-16_144201_7545" src="https://github.com/user-attachments/assets/da7b28ea-6c5f-4aa7-909e-0a255c80d508" />
<img width="1280" height="800" alt="@quanta-intellectvessel-browser_2026-03-17_195754_6624" src="https://github.com/user-attachments/assets/3b3d2033-5a59-4806-bbc1-359efb7b43a9" />



<img width="1280" height="800" alt="vessel_2026-03-17_145154_5389" src="https://github.com/user-attachments/assets/b1c08d6c-bcdf-4c9a-8429-a71a23a61903" />

Vessel is built for persistent web agents that need a real browser, durable state, and a human-visible interface. The agent is the primary operator. The human follows along in the live browser UI, audits what the agent is doing, and steers when needed.

Today, Vessel provides the browser shell, page visibility, and supervisory surfaces needed to support that model. The long-term goal is not "a browser with AI features," but a browser runtime for autonomous agents with a clear supervisory experience for humans.

## Features

- **Agent-first browser model** — Vessel is designed around an agent driving the browser while a human watches, intervenes, and redirects
- **Human-visible browser UI** — pages render like a normal browser so agent activity stays legible instead of disappearing into a headless run
- **Command Bar** (`Ctrl+L`) — a secondary operator surface for harness-driven workflows and future runtime commands
- **Supervisor Sidebar** (`Ctrl+Shift+L`) — live supervision across seven tabs: Supervisor, Bookmarks, Checkpoints, Chat, Automate, History, and Changes
- **Chat Assistant** — built-in conversational AI in the sidebar Chat tab; supports Anthropic, OpenAI, Ollama, llama.cpp, Mistral, xAI, Google Gemini, OpenRouter, and any OpenAI-compatible endpoint; reads the current page automatically; has full access to the same browser tools as external agents; multi-turn session history; configure provider, model, and API key in Settings
- **Automation Kits** (Premium) — parameterized workflow templates in the sidebar Automate tab; fill in a short form and the built-in agent executes the workflow autonomously; bundled kits include Research & Collect (multi-source research with bookmark saving) and Price Scout (cross-retailer price comparison); designed for a future kit marketplace
- **Dev Tools Panel** (`F12`) — inspect console output, network requests, and MCP/agent activity in a resizable panel at the bottom of the window; export logs by category and date range as JSON
- **Browser Basics For Long Runs** — pinned tabs stay compact at the front of the tab strip and are protected from accidental close; tab groups can be color-coded and collapsed; audible tabs show audio indicators with mute controls; open additional browser windows with `Ctrl+N`; print the active page with `Ctrl+P` or save it directly as PDF with `Ctrl+Shift+P`
- **Action Undo / Rollback** — restore the browser to the session snapshot captured immediately before the last successful mutating agent action; available from the Supervisor tab and through the `undo_last_action` tool
- **Agent-Meaningful Bookmarks** — bookmarks carry structured context the agent can read and act on: `intent` (what the page is for), `expectedContent` (what to expect on the page), `keyFields` (important form fields), `agentHints` (arbitrary directives), and a stored `pageSchema`; humans can create and edit this metadata directly in the Bookmarks tab, and all fields are searchable
- **Portable Bookmark Export** — export browser-compatible Netscape HTML for import into Chrome, Firefox, Safari, Edge, Brave, and other browsers; optionally include Vessel notes/agent metadata, or export a full-fidelity Vessel JSON archive
- **Page Schema Inference** — Vessel automatically infers a typed schema for every page: `pageType` (article, product, form, search, checkout, login, dashboard), `primaryEntity` (structured fields for products and articles), `formFields` (with names, types, labels, selectors), and `actionButtons` (with inferred intents: submit, addToCart, login, etc.); schema is attached to every content extraction result
- **Bookmarks for Agents** — save pages into folders, attach one-line folder summaries, and search bookmarks over MCP instead of dumping the entire library
- **Named Session Persistence** — save cookies, localStorage, and current tab layout under a reusable name, then reload it after a restart
- **Annotated Checkpoints** — capture and restore short-lived browser recovery points with names and editable notes, so humans and agents can mark why a checkpoint matters before risky flows
- **Page Highlights** — agents can visually highlight text or elements on any page with labeled, color-coded markers that persist across navigation; highlight count and navigation controls appear in the sidebar; cleared explicitly or via tool call
- **Agent Transcript Dock** — floating transcript overlay anchored to the browser chrome; configurable display modes (off, summary, full) set in Settings; shows live agent thinking and status updates without occupying sidebar space
- **Workflow Flow Tracking** — agents can declare a named multi-step workflow at runtime using `flow_start`; progress is tracked step-by-step with `flow_advance` and visible in the sidebar throughout execution
- **Structured Page Visibility Context** — extraction can report in-viewport elements, obscured controls, active overlays, and dormant consent/modal UI
- **Popup Recovery Tools** — agents can explicitly dismiss common popups, newsletter gates, and consent walls instead of brute-forcing generic clicks
- **Form Autofill Profiles** — save reusable personal or work profiles in Settings and fill common contact, address, and organization fields on the current page; Vessel matches fields using labels, names, placeholders, and autocomplete hints
- **Page Diff / "What Changed?"** — Vessel remembers the last snapshot of a page and surfaces a `Changed` badge in the address bar when the title, headings, or main content differ on a later visit; expand it to see a compact summary of what changed since the last snapshot
- **What Changed Timeline** (Premium) — the sidebar Changes tab keeps a per-page history of recent change bursts, showing when each update was detected and a compact summary of what changed
- **Per-Tab Ad Blocking Controls** — tabs default to ad blocking on, but agents can selectively disable and re-enable blocking when a page misbehaves
- **Domain Policy** — allowlist or blocklist domains globally in Settings; agents cannot navigate to blocked domains
- **Agent Credential Vault** (Premium) — encrypted credential storage for agent-driven logins; credentials are filled directly into login forms via a "blind fill" pattern and are never sent to AI providers; user consent dialog before every use; TOTP 2FA support; domain-scoped access; append-only audit log
- **Screenshot & Visual Analysis** (Premium) — take a full-page screenshot and pass the image directly to the AI for visual layout analysis; useful when text extraction fails on heavy or canvas-rendered pages
- **Obsidian Memory Hooks** (Premium) — optional vault path for agent-written markdown notes, page captures, and research breadcrumbs
- **Runtime Health Checks** — startup warnings for MCP port conflicts, unreadable settings, and user-data write failures
- **Reader Mode** — extract article content into a clean, distraction-free view; toggle on and off from the address bar
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
| AI Control | External agent harnesses (Hermes Agent, OpenClaw, MCP clients) + built-in chat (Anthropic, OpenAI, Ollama, llama.cpp, and any OAI-compatible endpoint) |
| Content Extraction | @mozilla/readability |

## Architecture

```
Main Process                              Renderer (SolidJS)
├── TabManager (WebContentsView[])        ├── TabBar, AddressBar
├── AgentRuntime (session + supervision)  ├── CommandBar (secondary surface)
├── MCP server for external agents        ├── AI Sidebar (Supervisor/Bookmarks/Checkpoints/Chat/Automate)
├── AI providers (Anthropic + OAI-compat) ├── DevTools Panel (Console/Network/Activity)
├── Supervision, bookmarks, checkpoints   ├── Agent Transcript Dock
└── IPC Handlers ◄──contextBridge──► ──► └── Signal stores (tabs, ai, ui)
└── IPC Handlers ◄──contextBridge──► Preload API
```

Each browser tab is a separate `WebContentsView` managed by the main process. The browser chrome (SolidJS) runs in its own view layered on top. All communication between renderer and main goes through typed IPC channels via `contextBridge`.

The sidebar Automate tab renders kit forms entirely in the renderer and passes the rendered prompt to the built-in agent via the same `query()` path used by the Chat tab — no additional IPC surface is needed. The Changes tab reads the current page's diff timeline through IPC and unlocks persisted history for Premium users.

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
- writes `~/.config/vessel/mcp-stdio-snippet.json`
- writes `~/.config/vessel/mcp-http-snippet.json`
- installs a `vessel-browser-mcp` helper that can run as a stdio-to-HTTP proxy (`--stdio`) or print config snippets
- prints the exact recommended stdio MCP snippet to paste into your harness config

The packaged AppImage path:

- does not require a local Node/Electron toolchain
- uses the packaged Vessel app icon and metadata
- is the recommended path for early adopters who just want to run Vessel

After install:

```bash
vessel-browser
```

```bash
# Use the pinned Node.js 22 runtime
fnm use

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

# Package an unpacked macOS app bundle (run on macOS)
npm run dist:mac:dir

# Package macOS DMG + ZIP artifacts (run on macOS)
npm run dist:mac

# Package signed macOS DMG + ZIP artifacts (run on macOS with signing set up)
npm run dist:mac:signed
```

Notes:

- `npm run dev` still launches the stock Electron binary, so Linux may continue showing the default Electron gear icon in development
- packaged builds created with `npm run dist` / `npm run dist:dir` use the Vessel app icon
- `npm run build:icon:mac` regenerates `resources/vessel-icon.icns` from `resources/vessel-icon.png` for macOS packaging
- `npm run dist:mac` and `npm run dist:mac:dir` intentionally disable auto-signing so local packaging works on any Mac without keychain setup
- `npm run dist:mac:signed` and `npm run dist:mac:dir:signed` use normal `electron-builder` signing discovery; if your login keychain has duplicate Apple certs, clean those up or use a dedicated keychain before running the signed path
- signed builds are still not notarized by this repo out of the box, so Gatekeeper warnings remain until notarization is added for release publishing
- the tracked smoke test runs typecheck, build, the MCP stdio proxy regression check, and the Electron navigation regression harness
- for headless CI, run the smoke test under `xvfb-run -a npm run smoke:test`

### Setting up Vessel for Hermes Agent or OpenClaw

Vessel is designed to act as the browser runtime that your external agent harness drives.

1. Launch Vessel
2. Open Settings (`Ctrl+,`) to confirm MCP status, copy the endpoint, or change the MCP port
3. Optional: set an Obsidian vault path, create autofill profiles, or adjust session preferences
4. Start Hermes Agent or OpenClaw and point it at Vessel — the easiest way is `vessel-browser-mcp --stdio` as the MCP command (auth is resolved automatically), or connect directly to `http://127.0.0.1:<mcpPort>/mcp` with the bearer token from `~/.config/vessel/mcp-auth.json`
5. Use the Supervisor panel in Vessel's sidebar to pause the agent, change approval mode, review pending approvals, checkpoint, undo the last mutating action, or restore the browser session while the harness runs
6. Use the Bookmarks panel to organize saved pages into folders, edit agent-facing bookmark metadata, export bookmarks for other browsers, and expose saved pages back to the agent over MCP

Notes:

- Vessel exposes browser control to external agents through its local MCP server
- The default MCP port is `3100`
- Hermes Agent and OpenClaw should treat Vessel as the persistent, human-visible browser rather than launching their own separate browser session
- Vessel supports a built-in Chat tab with configurable AI provider; open Settings (`Ctrl+,`) and enable Chat Assistant to set a provider and model
- `llama.cpp (Local)` is a first-class chat provider in Settings and targets `http://localhost:8080/v1` by default; Vessel auto-fetches the active model from `llama-server`
- For `llama-server`, use `--ctx-size 16384` minimum and `32768` recommended for reliable Vessel agent loops; lower values often fail once prompt, tool schema, and tool history accumulate
- Approval policy is controlled live from the sidebar Supervisor panel rather than a separate global settings screen
- Settings now show MCP runtime status, active endpoint, startup warnings, and allow changing the MCP port with an immediate server restart
- Settings also include reusable Form Autofill profiles for one-click filling of common contact and address forms on the active page
- The address bar can also show a `Changed` badge when Vessel detects that a previously visited page has meaningfully changed since the last saved snapshot
- Premium users can open the sidebar Changes tab for the full What Changed timeline for the active page
- The Bookmarks tab can export browser-compatible HTML, HTML with Vessel notes, or a full Vessel JSON archive with agent metadata intact
- Agents can selectively disable ad blocking for a problematic tab, reload, retry the flow, and turn blocking back on later
- Agents can persist authenticated state with named sessions, for example `github-logged-in`, and reload that state in later runs
- The intended control plane is an external harness driving Vessel through MCP
- If you set an Obsidian vault path in Settings, harnesses can write markdown notes directly into that vault via Vessel memory MCP tools

### Using llama.cpp as the built-in chat provider

Vessel can talk directly to a local `llama-server` through its OpenAI-compatible API.

Example:

```bash
llama-server -m /path/to/model.gguf --port 8080 --ctx-size 32768
```

Then in Vessel:

1. Open Settings (`Ctrl+,`)
2. Enable Chat Assistant
3. Choose `llama.cpp (Local)` as the provider
4. Click refresh if needed; Vessel will auto-detect the active model from `http://localhost:8080/v1`

Notes:

- `--ctx-size 16384` is the minimum practical setting for Vessel agent loops
- `--ctx-size 32768` is the recommended default for longer browsing sessions
- Vessel will warn in Settings if it detects a `llama-server` context size below the recommended floor, or if it cannot detect the ctx size from the running server

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

- `vessel_extract_content`
- `vessel_read_page`
- `vessel_scroll`
- `vessel_dismiss_popup`
- `vessel_set_ad_blocking`
- `vessel_wait_for`
- `vessel_screenshot` (Premium) — capture the full page as an image for visual AI analysis
- `undo_last_action` — restore the browser to the snapshot captured before the last successful mutating agent action

Page highlight tools:

- `vessel_highlight` — visually mark text or an element on the page with a labeled, color-coded overlay; persists until cleared
- `vessel_clear_highlights` — remove all highlights from the current page

Workflow tracking tools:

- `vessel_flow_start` — begin a named multi-step workflow and declare its steps upfront; progress appears in the sidebar throughout execution
- `vessel_flow_advance` — mark the current step complete and advance to the next
- `vessel_flow_status` — check current workflow progress
- `vessel_flow_end` — clear the active workflow tracker

Data extraction tools (Premium):

- `vessel_extract_table` — extract a page table as structured JSON rows with column headers

Named session tools exposed today include:

- `vessel_save_session`
- `vessel_load_session`
- `vessel_list_sessions`
- `vessel_delete_session`

Session files are sensitive because they may contain login cookies and tokens. Vessel stores them under the app user-data directory with restrictive file permissions.

Agent Credential Vault tools (Premium):

- `vessel_vault_status` — check whether stored credentials exist for a domain (returns labels/usernames, never passwords)
- `vessel_vault_login` — fill a login form using stored credentials (blind fill — credentials go directly into the page, never into the AI conversation)
- `vessel_vault_totp` — generate and fill a TOTP 2FA code from a stored secret

Session performance tools (Premium):

- `vessel_metrics` — show per-tool call counts, average durations, error rates, and total session stats

Vault security model:

- Credentials are encrypted at rest using AES-256-GCM with a key protected by the OS keychain (Electron safeStorage)
- Credential values are **never** sent to AI providers — they flow only through the main process to the content script
- Every credential use triggers a user consent dialog ("Allow Once" / "Allow for Session" / "Deny")
- All credential access is recorded in an append-only audit log
- Credentials are domain-scoped — they can only be used on matching domains
- Users manage credentials in Settings > Agent Credential Vault

Notable extraction modes include:

- `visible_only` — only currently visible, in-viewport, unobstructed interactive elements plus active overlays
- `results_only` — likely primary search/result links only
- `full` / `summary` / `interactives_only` / `forms_only` / `text_only`

The extraction output can distinguish:

- active blocking overlays
- dormant consent/modal UI present in the DOM but not active for the current session or region

Stdio proxy MCP config (recommended — resolves auth automatically):

```json
{
  "mcpServers": {
    "vessel": {
      "command": "vessel-browser-mcp",
      "args": ["--stdio"]
    }
  }
}
```

The stdio proxy reads the bearer token from `~/.config/vessel/mcp-auth.json` at connection time, so no manual token management is needed.
Vessel must already be running when your MCP client connects, and `~/.config/vessel/mcp-auth.json` must exist from install or first launch.

Generic HTTP MCP config (requires copying the token manually):

```json
{
  "mcpServers": {
    "vessel": {
      "type": "http",
      "url": "http://127.0.0.1:3100/mcp",
      "headers": {
        "Authorization": "Bearer <token from ~/.config/vessel/mcp-auth.json>"
      }
    }
  }
}
```

Hermes Agent `config.yaml` MCP config:

```yaml
mcp_servers:
  vessel:
    url: "http://127.0.0.1:3100/mcp"
    headers:
      Authorization: "Bearer <token from ~/.config/vessel/mcp-auth.json>"
    timeout: 180
    connect_timeout: 30
```

## Configuration 

The installer writes three snippets to:

- `~/.config/vessel/mcp-stdio-snippet.json`
- `~/.config/vessel/mcp-http-snippet.json`
- `~/.config/vessel/mcp-hermes-snippet.yaml`

It also installs a helper command:

```bash
vessel-browser-mcp
```

Helper examples:

```bash
# Run as stdio-to-HTTP proxy (for MCP client integration)
vessel-browser-mcp --stdio

# Recommended stdio MCP snippet
vessel-browser-mcp

# Generic JSON snippet with Authorization header
vessel-browser-mcp --format json

# Hermes-ready YAML snippet with Authorization header
vessel-browser-mcp --format hermes

# Raw MCP endpoint URL
vessel-browser-mcp --format url

# Raw MCP bearer token
vessel-browser-mcp --format token
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
| `Ctrl+Shift+L` | Toggle AI Sidebar |
| `Ctrl+Shift+F` | Toggle Focus Mode |
| `F12` | Toggle Dev Tools Panel |
| `Ctrl+N` | New Window |
| `Ctrl+T` | New Tab |
| `Ctrl+W` | Close Tab |
| `Ctrl+Shift+T` | Reopen Closed Tab |
| `Ctrl+Shift+N` | New Private Window |
| `Ctrl+F` | Find in Page |
| `Ctrl++` / `Ctrl+=` | Zoom In |
| `Ctrl+-` | Zoom Out |
| `Ctrl+0` | Reset Zoom |
| `Ctrl+P` | Print Active Page |
| `Ctrl+Shift+P` | Save Active Page as PDF |
| `Ctrl+,` | Settings |

## Project Structure

```
src/
├── main/                 # Electron main process
│   ├── ai/               # Agent tools, query flow, and AI provider implementations
│   ├── tabs/             # Tab + TabManager (WebContentsView)
│   ├── agent/            # Agent runtime, checkpoints, supervision, flow tracking
│   ├── content/          # Readability extraction, reader mode, screenshot, page snapshots/diff
│   ├── config/           # Settings persistence
│   ├── autofill/         # Autofill profile persistence and form-field matching
│   ├── ipc/              # IPC handler registry
│   ├── vault/            # Agent Credential Vault (encrypted storage, consent, audit)
│   ├── mcp/              # MCP server for external agent control
│   ├── devtools/         # CDP session management for Dev Tools panel
│   ├── highlights/       # Page highlight capture, injection, and persistence
│   ├── health/           # Runtime health monitoring (MCP, settings, ports)
│   ├── premium/          # Subscription management, feature gating, Stripe integration
│   ├── bookmarks/        # Bookmark and folder persistence
│   ├── history/          # Browse history
│   ├── memory/           # Obsidian vault hooks
│   ├── network/          # Ad blocking, URL safety, link validation, downloads
│   ├── sessions/         # Named session save/load/delete
│   ├── startup/          # App initialization, menu, shortcuts, renderer bootstrap
│   ├── telemetry/        # PostHog analytics (opt-in)
│   ├── tools/            # Tool definitions, input coercion, pruning
│   ├── window.ts         # Window layout manager
│   └── index.ts          # App entry point
├── preload/              # contextBridge scripts
│   ├── index.ts          # Chrome UI preload
│   └── content-script.ts # Web page preload (readability)
├── renderer/             # SolidJS browser UI
│   └── src/
│       ├── components/
│       │   ├── chrome/   # TitleBar, TabBar, AddressBar, AgentTranscriptDock
│       │   ├── ai/       # CommandBar, Sidebar (Supervisor/Bookmarks/Checkpoints/Chat/Automate/History/Changes)
│       │   ├── devtools/ # DevTools panel (Console, Network, Activity)
│       │   └── shared/   # Settings panel
│       ├── stores/       # SolidJS signal stores (tabs, ai, ui, runtime, bookmarks, etc.)
│       ├── styles/       # Theme, global CSS
│       └── lib/          # Keybindings, markdown, automation kits registry
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
