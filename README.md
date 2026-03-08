# Vessel Agent Browser

An agent-first web browser for Linux.

Vessel is built for persistent web agents that need a real browser, durable state, and a human-visible interface. The agent is the primary operator. The human follows along in the live browser UI, audits what the agent is doing, and steers when needed.

Today, Vessel provides the browser shell, page visibility, and AI surfaces needed to support that model. The long-term goal is not "a browser with AI features," but a browser runtime for autonomous agents with a clear supervisory experience for humans.

## Features

- **Agent-first browser model** — Vessel is designed around an agent driving the browser while a human watches, intervenes, and redirects
- **Human-visible browser UI** — pages render like a normal browser so agent activity stays legible instead of disappearing into a headless run
- **AI Command Bar** (`Ctrl+L`) — issue page-aware commands, summarize pages, ask questions, search
- **AI Sidebar** (`Ctrl+Shift+L`) — streaming conversation about the current page and browsing context
- **Reader Mode** — extract article content into a clean, distraction-free view
- **Focus Mode** (`Ctrl+Shift+F`) — hide all chrome, content fills the screen
- **Resizable Panels** — drag the sidebar edge to resize; width persists across sessions
- **Minimal Dark Theme** — warm palette (`#1a1a1e` bg, muted purple accents), no pure black/white

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
| AI | Multi-provider agent layer (Anthropic + OpenAI-compatible providers) |
| Content Extraction | @mozilla/readability |

## Architecture

```
Main Process                              Renderer (SolidJS)
├── TabManager (WebContentsView[])        ├── TabBar, AddressBar
├── AgentRuntime (session + supervision)  ├── CommandBar (Ctrl+L)
├── Provider adapters (streaming)         ├── AI Sidebar (resizable)
├── MCP server for external agents        └── Signal stores (tabs, ai, ui)
└── IPC Handlers ◄──contextBridge──► Preload API
```

Each browser tab is a separate `WebContentsView` managed by the main process. The browser chrome (SolidJS) runs in its own view layered on top. All communication between renderer and main goes through typed IPC channels via `contextBridge`.

## Getting Started

```bash
# Install dependencies
npm install

# If Electron download fails, use a mirror:
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm install

# Development (with HMR)
npm run dev

# Production build
npm run build
```

### Setting up Vessel for Hermes Agent or OpenClaw

Vessel is designed to act as the browser runtime that your external agent harness drives.

1. Launch Vessel
2. Open Settings (`Ctrl+,`)
3. Choose the model provider your harness will use for in-browser reasoning
4. Enter the provider credentials or base URL required for that provider
5. Confirm the MCP port setting in `vessel-settings.json` if your harness expects a specific port
6. Start Hermes Agent or OpenClaw and configure it to connect to Vessel's MCP endpoint at `http://127.0.0.1:<mcpPort>/mcp`
7. Use Vessel's sidebar supervisor controls to pause, approve, checkpoint, or restore the browser session while the harness runs

Notes:

- Vessel exposes browser control to external agents through its local MCP server
- The default MCP port is `3100`
- Hermes Agent and OpenClaw should treat Vessel as the persistent, human-visible browser rather than launching their own separate browser session
- If you want to use the built-in sidebar directly, you can still configure any supported provider in Settings and query the current page without an external harness

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
│   ├── ai/               # Provider adapters, context builder, commands
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
