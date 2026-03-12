# Contributing to Vessel

Vessel is an agent-first browser runtime in active development. Contributions are welcome, but focused changes are much easier to review than broad refactors.

## Before You Start

- Open an issue first if you want to propose a large feature or architectural change.
- Keep pull requests scoped to one problem when possible.
- Include screenshots or short recordings for visible UI changes.
- Call out any browser behavior changes that could affect agent workflows or MCP tools.

## Local Setup

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm run typecheck
npm run build
```

## Project Notes

- The main Electron process lives in `src/main`.
- The SolidJS UI lives in `src/renderer/src`.
- Shared IPC types and channel constants live in `src/shared`.
- Vessel is built around external agent harnesses controlling the browser through MCP, so changes should preserve that model.

## Pull Request Guidance

- Describe the user-facing problem, not just the code change.
- Mention how you tested the change.
- Update `README.md` when behavior, install steps, or exposed tools change.
- Avoid unrelated cleanup in the same pull request.
