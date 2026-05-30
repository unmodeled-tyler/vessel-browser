import test from "node:test";
import assert from "node:assert/strict";

import {
  createBrowserCommands,
  getBrowserCommandIdForKeyboardEvent,
  getBrowserCommandShortcutHelp,
} from "../src/renderer/src/lib/browserCommands";
import {
  buildAgentTimelineItems,
  formatAgentActionName,
  formatAgentTimelineDuration,
} from "../src/renderer/src/lib/agentTimeline";
import {
  DETACHED_SIDEBAR_MIN_HEIGHT,
  DETACHED_SIDEBAR_MIN_WIDTH,
  sanitizeSidebarDetachedBounds,
  sanitizeSidebarPanelMode,
} from "../src/shared/sidebar";
import type { AgentRuntimeState } from "../src/shared/types";

function keyEvent(
  key: string,
  modifiers: Partial<KeyboardEvent> = {},
): KeyboardEvent {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target: null,
    ...modifiers,
  } as KeyboardEvent;
}

function makeCommandContext() {
  const run = () => undefined;
  return {
    activeTabTitle: () => "Example",
    createTab: run,
    closeActiveTab: run,
    reopenClosedTab: run,
    openNewWindow: run,
    openPrivateWindow: run,
    reload: run,
    goBack: run,
    goForward: run,
    openBrowserCommandPalette: run,
    openCommandBar: run,
    toggleSidebar: run,
    toggleFocusMode: run,
    openSettings: run,
    openDownloads: run,
    clearBrowsingData: run,
    toggleKeyboardHelp: run,
    toggleDevTools: run,
    zoomIn: run,
    zoomOut: run,
    zoomReset: run,
    print: run,
    printToPdf: run,
    togglePip: run,
    captureHighlight: run,
  };
}

function makeRuntimeState(): AgentRuntimeState {
  return {
    session: null,
    supervisor: {
      paused: false,
      approvalMode: "confirm-dangerous",
      pendingApprovals: [],
    },
    actions: [
      {
        id: "action-1",
        source: "mcp",
        name: "open_url",
        args: {},
        argsSummary: "Open https://example.com",
        status: "completed",
        startedAt: "2026-05-11T20:00:00.000Z",
        finishedAt: "2026-05-11T20:00:03.200Z",
        durationMs: 3200,
        resultSummary: "Loaded Example",
      },
      {
        id: "action-2",
        source: "mcp",
        name: "click_button",
        args: {},
        argsSummary: "Click checkout",
        status: "waiting-approval",
        startedAt: "2026-05-11T20:00:04.000Z",
      },
    ],
    checkpoints: [],
    transcript: [
      {
        id: "message-1",
        source: "assistant",
        kind: "message",
        title: "Assistant",
        text: "Done",
        startedAt: "2026-05-11T20:00:01.000Z",
        updatedAt: "2026-05-11T20:00:05.000Z",
        status: "final",
      },
    ],
    mcpStatus: "stopped",
    flowState: null,
    taskTracker: null,
    canUndo: false,
    undoInfo: null,
  };
}

test("browser command shortcuts and help use the shared command registry", () => {
  assert.equal(
    getBrowserCommandIdForKeyboardEvent(keyEvent("k", { ctrlKey: true })),
    "browser-command-palette",
  );
  assert.equal(
    getBrowserCommandIdForKeyboardEvent(keyEvent("?", { shiftKey: true })),
    "keyboard-help",
  );
  assert.equal(
    getBrowserCommandIdForKeyboardEvent(keyEvent("f", { ctrlKey: true })),
    "find-page",
  );

  const privateHelp = getBrowserCommandShortcutHelp(true).map(
    (shortcut) => shortcut.keys,
  );
  assert.ok(privateHelp.includes("Ctrl+T"));
  assert.ok(!privateHelp.includes("Ctrl+L"));
});

test("browser command palette omits hidden keyboard-only commands", () => {
  const commands = createBrowserCommands(makeCommandContext());
  const ids = commands.map((command) => command.id);

  assert.ok(ids.includes("ask-agent"));
  assert.ok(ids.includes("reload"));
  assert.ok(!ids.includes("find-page"));
  assert.ok(!ids.includes("browser-command-palette"));
});

test("shared sidebar settings sanitizers clamp persisted detached bounds", () => {
  assert.equal(sanitizeSidebarPanelMode("detached"), "detached");
  assert.equal(sanitizeSidebarPanelMode("somewhere-else"), "docked");
  assert.equal(sanitizeSidebarDetachedBounds(null), null);

  assert.deepEqual(
    sanitizeSidebarDetachedBounds({
      x: 12.7,
      y: 9.2,
      width: 1,
      height: 2,
    }),
    {
      x: 13,
      y: 9,
      width: DETACHED_SIDEBAR_MIN_WIDTH,
      height: DETACHED_SIDEBAR_MIN_HEIGHT,
    },
  );
});

test("agent timeline combines transcript and actions with shared formatting", () => {
  const items = buildAgentTimelineItems(makeRuntimeState());

  assert.deepEqual(
    items.map((item) => item.id),
    ["transcript:message-1", "action:action-2", "action:action-1"],
  );
  assert.equal(formatAgentActionName("click_button"), "Click Button");
  assert.equal(formatAgentTimelineDuration(3200), "3.2s");
  assert.equal(items[1].detail, "Click checkout");
});
