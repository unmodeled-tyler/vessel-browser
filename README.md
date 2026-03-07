# Vessel

An AI-native, attention-minded web browser for Linux.

Vessel integrates Claude directly into your browsing experience — summarize pages, ask questions about content, and navigate smarter. Built with a minimal, low-strain dark interface designed for extended use.

## Features

- **AI Command Bar** (`Ctrl+L`) — summarize pages, ask questions, search
- **AI Sidebar** (`Ctrl+Shift+L`) — streaming conversation with Claude about your current page
- **Reader Mode** — extract article content into a clean, distraction-free view
- **Focus Mode** (`Ctrl+Shift+F`) — hide all chrome, content fills the screen
- **Resizable Panels** — drag the sidebar edge to resize; width persists across sessions
- **Minimal Dark Theme** — warm palette (`#1a1a1e` bg, muted purple accents), no pure black/white

## Stack

| Layer | Technology |
|-------|-----------|
| Engine | Chromium (Electron 40) |
| UI Framework | SolidJS |
| Language | TypeScript |
| Build | electron-vite + Vite |
| AI | Claude via @anthropic-ai/sdk |
| Content Extraction | @mozilla/readability |

## Architecture

```
Main Process                          Renderer (SolidJS)
├── TabManager (WebContentsView[])    ├── TabBar, AddressBar
├── ClaudeClient (streaming)          ├── CommandBar (Ctrl+L)
├── ContentExtractor (readability)    ├── AI Sidebar (resizable)
├── Settings (JSON persistence)       └── Signal stores (tabs, ai, ui)
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

### Setting up AI

1. Launch Vessel
2. Open Settings (`Ctrl+,`)
3. Paste your Claude API key (from [console.anthropic.com](https://console.anthropic.com))
4. Open the command bar (`Ctrl+L`) or sidebar (`Ctrl+Shift+L`) and start asking

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
│   ├── ai/               # Claude client, context builder, commands
│   ├── tabs/             # Tab + TabManager (WebContentsView)
│   ├── content/          # Readability extraction, reader mode
│   ├── config/           # Settings persistence
│   ├── ipc/              # IPC handler registry
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

- **Content first** — chrome is 110px, everything else is your page
- **Easy on the eyes** — warm dark grays, muted text, no visual noise
- **AI is a tool, not a distraction** — command bar for quick queries, sidebar for deep dives
- **Linux-native** — frameless window, system font fallbacks, XDG conventions

## License

ISC
