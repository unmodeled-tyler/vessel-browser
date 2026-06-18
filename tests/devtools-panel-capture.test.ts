import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { afterEach } from "node:test";

import type { WebContents } from "electron";
import {
  destroyAllSessions,
  getOrCreateSession,
  getSession,
} from "../src/main/devtools/manager";
import {
  disableCaptureForTab,
  enableCaptureForTab,
  setDevToolsPanelListener,
} from "../src/main/devtools/tools";
import type { TabManager } from "../src/main/tabs/tab-manager";
import type { DevToolsPanelState } from "../src/shared/devtools-types";

function createMockWebContents() {
  const debuggerEmitter = new EventEmitter();
  let attachCount = 0;
  let detachCount = 0;
  const wc = {
    isDestroyed: () => false,
    debugger: {
      attach: (_version: string) => {
        attachCount += 1;
      },
      detach: () => {
        detachCount += 1;
      },
      sendCommand: (
        _method: string,
        _params?: Record<string, unknown>,
      ): Promise<Record<string, unknown>> => Promise.resolve({}),
      on: (event: string, listener: (...args: unknown[]) => void) => {
        debuggerEmitter.on(event, listener);
      },
      removeListener: (event: string, listener: (...args: unknown[]) => void) => {
        debuggerEmitter.off(event, listener);
      },
    },
  };
  return {
    wc: wc as unknown as WebContents,
    debuggerEmitter,
    get attachCount() {
      return attachCount;
    },
    get detachCount() {
      return detachCount;
    },
  };
}

function emitCdp(
  debuggerEmitter: EventEmitter,
  method: string,
  params: Record<string, unknown>,
): void {
  debuggerEmitter.emit(
    "message",
    { preventDefault: () => {} } as unknown as Event,
    method,
    params,
  );
}

function createTabManager(
  tabs: Map<string, { view: { webContents: WebContents } }>,
) {
  let activeTabId = tabs.keys().next().value as string;
  const tabManager = {
    getActiveTabId: () => activeTabId,
    getActiveTab: () => tabs.get(activeTabId) ?? null,
  } as unknown as TabManager;
  return {
    tabManager,
    setActiveTabId: (tabId: string) => {
      activeTabId = tabId;
    },
  };
}

afterEach(() => {
  disableCaptureForTab();
  destroyAllSessions();
  setDevToolsPanelListener(null);
});

test("panel-owned capture retargets by destroying the previous panel-created session", async () => {
  const tabA = createMockWebContents();
  const tabB = createMockWebContents();
  const tabs = new Map([
    ["tab-a", { view: { webContents: tabA.wc } }],
    ["tab-b", { view: { webContents: tabB.wc } }],
  ]);
  const { tabManager, setActiveTabId } = createTabManager(tabs);

  await enableCaptureForTab(tabManager);
  assert.ok(getSession("tab-a"));
  assert.equal(tabA.attachCount, 1);

  setActiveTabId("tab-b");
  await enableCaptureForTab(tabManager);

  assert.equal(getSession("tab-a"), undefined);
  assert.equal(tabA.detachCount, 1);
  assert.ok(getSession("tab-b"));
  assert.equal(tabB.attachCount, 1);
});

test("panel close preserves pre-existing devtools sessions and clears panel broadcasts", async () => {
  const tabA = createMockWebContents();
  const tabs = new Map([["tab-a", { view: { webContents: tabA.wc } }]]);
  const { tabManager } = createTabManager(tabs);
  const session = getOrCreateSession(tabManager);
  const states: DevToolsPanelState[] = [];
  setDevToolsPanelListener((state) => states.push(state));

  await enableCaptureForTab(tabManager);
  assert.equal(getSession("tab-a"), session);

  disableCaptureForTab();
  assert.equal(getSession("tab-a"), session);
  assert.equal(tabA.detachCount, 0);
  const broadcastCountAfterClose = states.length;

  emitCdp(tabA.debuggerEmitter, "Runtime.consoleAPICalled", {
    type: "log",
    args: [{ type: "string", value: "after close" }],
  });
  await Promise.resolve();

  assert.equal(states.length, broadcastCountAfterClose);
});
