# Contributing to Vessel

Vessel is an agent-first browser runtime in active development. Contributions are welcome, but focused changes are much easier to review than broad refactors.

## Before You Start

- Open an issue first if you want to propose a large feature or architectural change.
- Keep pull requests scoped to one problem when possible.
- Include screenshots or short recordings for visible UI changes.
- Call out any browser behavior changes that could affect agent workflows or MCP tools.

## Local Setup

Vessel development uses Node.js 22. If you use `fnm`, run `fnm use` from the repo root to pick up `.node-version`.

```bash
fnm use
npm install
npm run dev
```

Useful checks:

```bash
npm run typecheck      # tsc --noEmit across main + renderer
npm run lint           # eslint src/ tests/
npm run lint:fix        # eslint --fix
npm run test:coverage   # tsx --test + c8 coverage report
npm run check:cleanup   # typecheck + git diff --check + deadcode (knip)
npm run build           # electron-vite build (main + preload + renderer)
```

A pre-commit hook (`.husky/pre-commit`) runs `npm run typecheck` and `lint-staged` automatically. `lint-staged` runs `eslint --fix` and `prettier --write` on staged files.

## Project Notes

- The main Electron process lives in `src/main`.
- The SolidJS UI lives in `src/renderer/src`.
- Shared IPC types and channel constants live in `src/shared`.
- Vessel is built around external agent harnesses controlling the browser through MCP, so changes should preserve that model.

## Adding an IPC Handler

IPC handlers live in `src/main/ipc/`. Every handler must follow two rules:

1. **Trust the sender.** Start every `ipcMain.handle` callback with `assertTrustedIpcSender(event)` — this rejects IPC from untrusted renderers. Trusted WebContents are registered via `registerTrustedIpcSender(wc)` at window creation time.

2. **Validate inputs with zod.** Use `parseIpc(Schema, value, "label")` for every renderer-supplied argument. The TypeScript annotation on the parameter is not runtime-checked; only `parseIpc` enforces the shape. Define the schema as a module-level `const` so it's reused.

```ts
import { z } from "zod";
import { assertTrustedIpcSender, parseIpc } from "./common";

const TabIdSchema = z.string().min(1);

ipcMain.handle(Channels.TAB_CLOSE, (event, id: unknown) => {
  assertTrustedIpcSender(event);
  const validated = parseIpc(TabIdSchema, id, "tabId");
  // ... use validated
});
```

Add new channel constants to the relevant file in `src/shared/channels/`, then export them through `src/shared/channels/index.ts`. The flat `Channels` export from `src/shared/channels.ts` is kept as the compatibility entry point for IPC channel names.

## Adding an MCP Tool

MCP tools live in `src/main/mcp/tools/`. Each tool module exports a `register*Tools(server, tabManager, runtime)` function that calls `server.registerTool(name, meta, handler)`:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerMyTools(server: McpServer /* deps */): void {
  server.registerTool(
    "my_tool",
    {
      title: "My Tool",
      description: "What it does, for the agent.",
      inputSchema: { query: z.string().describe("The query") },
    },
    async ({ query }) => {
      // ... return a string or MCP response
    },
  );
}
```

Then wire it into `registerTools()` in `src/main/mcp/server.ts` by importing and calling the new `register*Tools` function. Use the existing tool modules (`navigation.ts`, `content.ts`, etc.) as templates.

## Pull Request Guidance

- Describe the user-facing problem, not just the code change.
- Mention how you tested the change.
- Update `README.md` when behavior, install steps, or exposed tools change.
- Avoid unrelated cleanup in the same pull request.
