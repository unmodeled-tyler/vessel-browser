# Vessel: Your Agent's Browser

*Vessel Browser is in active development and makes no assurances at this time in regards to security. Use and deploy at your own risk.*

### One-Line Install

```bash
curl -fsSL https://raw.githubusercontent.com/unmodeled-tyler/quanta-vessel-browser/main/scripts/install.sh | bash
```
![vessel-logo-cropped](https://github.com/user-attachments/assets/58887932-26b3-45b5-be5e-21de562d2855)

---


An agent-first web browser for Linux.

<img width="1280" height="800" alt="vessel_2026-03-10_170917_8761" src="https://github.com/user-attachments/assets/ce2c96dc-d1c1-43dc-aba6-19441ca4228d" />

<img width="1280" height="800" alt="vessel_2026-03-10_204143_6698" src="https://github.com/user-attachments/assets/a50ab3ae-08bf-4696-8e49-91c0976e8c68" />


Vessel is built for persistent web agents that need a real browser, durable state, and a human-visible interface. The agent is the primary operator. The human follows along in the live browser UI, audits what the agent is doing, and steers when needed.

Today, Vessel provides the browser shell, page visibility, and supervisory surfaces needed to support that model. The long-term goal is not "a browser with AI features," but a browser runtime for autonomous agents with a clear supervisory experience for humans.

## Features

- **Agent-first browser model** — Vessel is designed around an agent driving the browser while a human watches, intervenes, and redirects
- **Human-visible browser UI** — pages render like a normal browser so agent activity stays legible instead of disappearing into a headless run
- **Command Bar** (`Ctrl+L`) — a secondary operator surface for harness-driven workflows and future runtime commands, not the primary chat interface
- **Supervisor Sidebar** (`Ctrl+Shift+L`) — live supervision split into Supervisor, Bookmarks, and Checkpoints panels
- **Bookmarks for Agents** — save pages into folders, attach one-line folder summaries, and search bookmarks over MCP instead of dumping the entire library
- **Structured Page Visibility Context** — extraction can report in-viewport elements, obscured controls, active overlays, and dormant consent/modal UI
- **Popup Recovery Tools** — agents can explicitly dismiss common popups, newsletter gates, and consent walls instead of brute-forcing generic clicks
- **Per-Tab Ad Blocking Controls** — tabs default to ad blocking on, but agents can selectively disable and re-enable blocking when a page misbehaves
- **Obsidian Memory Hooks** — optional vault path for agent-written markdown notes, page captures, and research breadcrumbs
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
├── MCP server for external agents        ├── AI Sidebar (resizable)
├── Supervision, bookmarks, checkpoints   └── Signal stores (tabs, ai, ui)
└── IPC Handlers ◄──contextBridge──► Preload API
```

Each browser tab is a separate `WebContentsView` managed by the main process. The browser chrome (SolidJS) runs in its own view layered on top. All communication between renderer and main goes through typed IPC channels via `contextBridge`.

## Getting Started

### One-Line Install

```bash
curl -fsSL https://raw.githubusercontent.com/unmodeled-tyler/quanta-vessel-browser/main/scripts/install.sh | bash
```

The installer:

- clones or updates Vessel into `~/.local/share/vessel-browser`
- installs dependencies and builds the app
- creates a `vessel-browser` launcher in `~/.local/bin`
- creates a desktop entry for Linux app launchers
- writes `~/.config/vessel/vessel-settings.json` with MCP port `3100`
- writes `~/.config/vessel/mcp-http-snippet.json`
- prints the exact HTTP MCP snippet to paste into your harness config

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

# Package an unpacked Linux app
npm run dist:dir

# Package a Linux AppImage
npm run dist
```

Notes:

- `npm run dev` still launches the stock Electron binary, so Linux may continue showing the default Electron gear icon in development
- packaged builds created with `npm run dist` / `npm run dist:dir` use the Vessel app icon

### Setting up Vessel for Hermes Agent or OpenClaw

Vessel is designed to act as the browser runtime that your external agent harness drives.

1. Launch Vessel
2. Optional: open Settings (`Ctrl+,`) to set an Obsidian vault path or session preferences
3. If your harness expects a custom port, confirm the MCP port in `~/.config/vessel/vessel-settings.json`
4. Start Hermes Agent or OpenClaw and configure it to connect to Vessel's MCP endpoint at `http://127.0.0.1:<mcpPort>/mcp`
5. Use the Supervisor panel in Vessel's sidebar to pause the agent, change approval mode, review pending approvals, checkpoint, or restore the browser session while the harness runs
6. Use the Bookmarks panel to organize saved pages into folders and expose those bookmarks back to the agent over MCP

Notes:

- Vessel exposes browser control to external agents through its local MCP server
- The default MCP port is `3100`
- Hermes Agent and OpenClaw should treat Vessel as the persistent, human-visible browser rather than launching their own separate browser session
- Vessel does not expose local model or provider configuration in-app
- Approval policy is controlled live from the sidebar Supervisor panel rather than a separate global settings screen
- Agents can selectively disable ad blocking for a problematic tab, reload, retry the flow, and turn blocking back on later
- The intended control plane is an external harness driving Vessel through MCP
- If you set an Obsidian vault path in Settings, harnesses can write markdown notes directly into that vault via Vessel memory MCP tools

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

Notable extraction modes include:

- `visible_only` — only currently visible, in-viewport, unobstructed interactive elements plus active overlays
- `full` / `summary` / `interactives_only` / `forms_only` / `text_only`

The extraction output can distinguish:

- active blocking overlays
- dormant consent/modal UI present in the DOM but not active for the current session or region

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

The installer also writes that snippet to `~/.config/vessel/mcp-http-snippet.json` and installs a helper command:

```bash
vessel-browser-mcp
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+L` | AI Command Bar |
| `Ctrl+Shift+L` | Toggle AI Sidebar |
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
