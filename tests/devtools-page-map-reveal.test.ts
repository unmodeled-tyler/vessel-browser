import assert from "node:assert/strict";
import test from "node:test";

import { revealPageMapElement } from "../src/main/devtools/page-map-reveal";
import type { TabManager } from "../src/main/tabs/tab-manager";

function createTabManager(options?: {
  destroyed?: boolean;
  execute?: (script: string) => unknown | Promise<unknown>;
}) {
  const scripts: string[] = [];
  const tabManager = {
    getActiveTab: () => ({
      view: {
        webContents: {
          isDestroyed: () => options?.destroyed ?? false,
          executeJavaScript: async (script: string) => {
            scripts.push(script);
            return await options?.execute?.(script);
          },
        },
      },
    }),
  } as unknown as TabManager;
  return { tabManager, scripts };
}

test("revealPageMapElement returns no-active-tab when the page is unavailable", async () => {
  const tabManager = {
    getActiveTab: () => null,
  } as unknown as TabManager;

  assert.equal(await revealPageMapElement(tabManager, "#target"), "no-active-tab");
});

test("revealPageMapElement serializes selectors safely and returns script status", async () => {
  const selector = "#target[data-label=\"quoted\"]";
  const { tabManager, scripts } = createTabManager({
    execute: () => "not-found",
  });

  assert.equal(await revealPageMapElement(tabManager, selector), "not-found");
  assert.equal(scripts.length, 1);
  assert.ok(scripts[0].includes(JSON.stringify(selector)));
});

test("revealPageMapElement normalizes unexpected script results and failures", async () => {
  const unexpected = createTabManager({ execute: () => ({ ok: true }) });
  assert.equal(
    await revealPageMapElement(unexpected.tabManager, "#target"),
    "revealed",
  );

  const failing = createTabManager({
    execute: () => {
      throw new Error("boom");
    },
  });
  assert.equal(
    await revealPageMapElement(failing.tabManager, "#target"),
    "invalid-selector",
  );
});
