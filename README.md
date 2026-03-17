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

## Why Vessel?

Most browser automation stacks are either headless, stateless, or designed around a human as the primary operator. Vessel is built around the opposite model: the browser is the agent's operating surface, and the human stays in the loop through a visible interface with clear supervisory controls.

<img width="1280" height="800" alt="vessel_2026-03-16_144201_7545" src="https://github.com/user-attachments/assets/da7b28ea-6c5f-4aa7-909e-0a255c80d508" />

<img width="1280" height="785" alt="vessel_2026-03-16_171108_8677" src="https://github.com/user-attachments/assets/613c285f-0253-4344-b335-f74a64e124ac" />

Vessel is built for persistent web agents that need a real browser, durable state, and a human-visible interface. The agent is the primary operator. The human follows along in the live browser UI, audits what the agent is doing, and steers when needed.

## Features

- **Agent-first browser model** with a visible browser instead of a headless black box
- **Active tab awareness** through `vessel_current_tab` and `vessel://tabs/active`
- **Structured page reads** with headings, forms, overlays, structured data, and annotations
- **Bidirectional highlighting** that is visible in-browser and reflected back into model-facing context
- **Supervisor Sidebar** (`Ctrl+Shift+L`) for approvals, checkpoints, bookmarks, and transcript monitoring
- **Named session persistence** for cookies, localStorage, and tab layout
- **Popup recovery and ad-block controls** for fragile sites and stubborn flows
- **Obsidian memory hooks** for notes, captures, and research breadcrumbs
- **Reader mode, focus mode, and a minimal dark UI** built around the page, not the chrome

## Docs

- [MCP Setup And Harness Integration](./docs/mcp.md)
- [Development Guide](./docs/development.md)
- [Architecture](./docs/architecture.md)
- [Packaging And Releases](./docs/releasing.md)
- [Agent Roadmap](./docs/agent-roadmap.md)

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

## License

MIT

*Developed by Tyler Williams in Portland, Oregon (2026)*
