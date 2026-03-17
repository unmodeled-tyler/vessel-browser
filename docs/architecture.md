# Architecture

## Positioning

Most browsers treat automation as secondary and assume a human is the primary actor. Vessel is the opposite: it is the browser for the agent, with a visible interface that keeps the human in the loop.

That means the product optimizes for:

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

## High-Level Layout

```text
Main Process                              Renderer (SolidJS)
├── TabManager (WebContentsView[])        ├── TabBar, AddressBar
├── AgentRuntime (session + supervision)  ├── CommandBar (secondary surface)
├── MCP server for external agents        ├── Supervisor Sidebar (resizable)
├── Supervision, bookmarks, checkpoints   └── Signal stores (tabs, ai, ui)
└── IPC Handlers ◄──contextBridge──► Preload API
```

Each browser tab is a separate `WebContentsView` managed by the main process. The browser chrome runs in its own view layered on top. Communication between renderer and main goes through typed IPC channels via `contextBridge`.

## Project Structure

```text
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
│   └── content-script.ts # Web page preload and readability hooks
├── renderer/             # SolidJS browser UI
│   └── src/
│       ├── components/
│       │   ├── chrome/   # TitleBar, TabBar, AddressBar
│       │   ├── ai/       # CommandBar, Sidebar
│       │   └── shared/   # Settings panel
│       ├── stores/       # SolidJS signal stores
│       ├── styles/       # Theme and global CSS
│       └── lib/          # Keybindings
└── shared/               # Types and IPC channel constants
```

## Design Principles

- **Agent first**: the browser is the agent's operating surface, not a human tool with automation bolted on
- **Human visible**: the UI should make agent behavior easy to follow, audit, and steer
- **Persistent by default**: browser state should survive long-running workflows and repeated sessions
- **Content first**: chrome is lightweight so the page remains the primary surface
- **Easy on the eyes**: warm dark grays, muted text, and low visual noise
- **Linux-native**: frameless window, system font fallbacks, and XDG conventions
