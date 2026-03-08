import type { WebContents } from "electron";
import type { AgentCheckpoint } from "../../shared/types";
import type { AgentRuntime } from "../agent/runtime";
import { extractContent } from "../content/extractor";
import type { TabManager } from "../tabs/tab-manager";
import { buildStructuredContext } from "./context-builder";

export interface ActionContext {
  tabManager: TabManager;
  runtime: AgentRuntime;
}

function waitForLoad(wc: WebContents, timeout = 5000): Promise<void> {
  return new Promise((resolve) => {
    if (!wc.isLoading()) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeout);
    wc.once("did-finish-load", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function resolveSelector(
  wc: WebContents,
  index?: number,
  selector?: string,
): Promise<string | null> {
  if (selector) return selector;
  if (index == null) return null;
  return wc.executeJavaScript(
    `window.__vessel?.getElementSelector?.(${index}) || null`,
  );
}

function getTabByMatch(
  tabManager: TabManager,
  match?: string,
): { id: string; title: string; url: string } | null {
  if (!match) return null;
  const lowered = match.toLowerCase();
  return (
    tabManager
      .getAllStates()
      .find(
        (tab) =>
          tab.title.toLowerCase().includes(lowered) ||
          tab.url.toLowerCase().includes(lowered),
      ) || null
  );
}

function isDangerousAction(name: string): boolean {
  return [
    "navigate",
    "click",
    "type_text",
    "create_tab",
    "switch_tab",
    "restore_checkpoint",
  ].includes(name);
}

async function waitForCondition(
  wc: WebContents,
  args: Record<string, any>,
): Promise<string> {
  const timeoutMs = Math.max(250, Number(args.timeoutMs) || 5000);
  const selector =
    typeof args.selector === "string" && args.selector.trim()
      ? args.selector.trim()
      : "";
  const text =
    typeof args.text === "string" && args.text.trim() ? args.text.trim() : "";

  if (!selector && !text) {
    return "Error: wait_for requires text or selector";
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const matched = await wc.executeJavaScript(`
      (function() {
        const selector = ${JSON.stringify(selector)};
        const text = ${JSON.stringify(text)};
        if (selector && document.querySelector(selector)) return true;
        if (text && document.body?.innerText?.includes(text)) return true;
        return false;
      })()
    `);
    if (matched) {
      return selector
        ? `Matched selector ${selector}`
        : `Matched text "${text.slice(0, 80)}"`;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return selector
    ? `Timed out waiting for selector ${selector}`
    : `Timed out waiting for text "${text.slice(0, 80)}"`;
}

function findCheckpoint(
  checkpoints: AgentCheckpoint[],
  args: Record<string, any>,
): AgentCheckpoint | null {
  if (typeof args.checkpointId === "string" && args.checkpointId.trim()) {
    return (
      checkpoints.find((item) => item.id === args.checkpointId.trim()) || null
    );
  }

  if (typeof args.name === "string" && args.name.trim()) {
    const lowered = args.name.trim().toLowerCase();
    return (
      [...checkpoints]
        .reverse()
        .find((item) => item.name.toLowerCase() === lowered) || null
    );
  }

  return null;
}

export async function executeAction(
  name: string,
  args: Record<string, any>,
  ctx: ActionContext,
): Promise<string> {
  const tab = ctx.tabManager.getActiveTab();
  const tabId = ctx.tabManager.getActiveTabId();

  if (!tab && !["list_tabs", "create_tab", "restore_checkpoint"].includes(name)) {
    return "Error: No active tab";
  }

  const wc = tab?.view.webContents;

  return ctx.runtime.runControlledAction({
    source: "ai",
    name,
    args,
    tabId,
    dangerous: isDangerousAction(name),
    executor: async () => {
      switch (name) {
        case "list_tabs": {
          const activeId = ctx.tabManager.getActiveTabId();
          const lines = ctx.tabManager.getAllStates().map((item) => {
            const prefix = item.id === activeId ? "->" : "  ";
            return `${prefix} [${item.id}] ${item.title} — ${item.url}`;
          });
          return lines.join("\n") || "No tabs open";
        }

        case "switch_tab": {
          let targetId =
            typeof args.tabId === "string" ? args.tabId.trim() : "";
          if (!targetId) {
            targetId = getTabByMatch(ctx.tabManager, args.match)?.id || "";
          }
          if (!targetId) return "Error: No matching tab found";
          ctx.tabManager.switchTab(targetId);
          const active = ctx.tabManager.getActiveTab();
          return active
            ? `Switched to ${active.view.webContents.getTitle() || active.view.webContents.getURL()}`
            : `Switched to tab ${targetId}`;
        }

        case "create_tab": {
          const createdId = ctx.tabManager.createTab(
            typeof args.url === "string" && args.url.trim()
              ? args.url.trim()
              : "about:blank",
          );
          const created = ctx.tabManager.getActiveTab();
          if (created) {
            await waitForLoad(created.view.webContents);
          }
          return `Created tab ${createdId}`;
        }

        case "navigate": {
          if (!wc || !tabId) return "Error: No active tab";
          ctx.tabManager.navigateTab(tabId, args.url);
          await waitForLoad(wc);
          return `Navigated to ${wc.getURL()}`;
        }

        case "go_back": {
          if (!wc || !tabId) return "Error: No active tab";
          ctx.tabManager.goBack(tabId);
          await waitForLoad(wc);
          return `Went back to ${wc.getURL()}`;
        }

        case "go_forward": {
          if (!wc || !tabId) return "Error: No active tab";
          ctx.tabManager.goForward(tabId);
          await waitForLoad(wc);
          return `Went forward to ${wc.getURL()}`;
        }

        case "reload": {
          if (!wc || !tabId) return "Error: No active tab";
          ctx.tabManager.reloadTab(tabId);
          await waitForLoad(wc);
          return `Reloaded ${wc.getURL()}`;
        }

        case "click": {
          if (!wc) return "Error: No active tab";
          const selector = await resolveSelector(wc, args.index, args.selector);
          if (!selector) return "Error: No element index or selector provided";
          const result = await wc.executeJavaScript(`
            (function() {
              const el = document.querySelector(${JSON.stringify(selector)});
              if (!el) return 'Element not found with selector: ${selector.replace(/'/g, "\\'")}';
              el.click();
              return 'Clicked: ' + (el.textContent || el.tagName).trim().slice(0, 100);
            })()
          `);
          await new Promise((resolve) => setTimeout(resolve, 150));
          return result;
        }

        case "type_text": {
          if (!wc) return "Error: No active tab";
          const selector = await resolveSelector(wc, args.index, args.selector);
          if (!selector) return "Error: No element index or selector provided";
          return wc.executeJavaScript(`
            (function() {
              const el = document.querySelector(${JSON.stringify(selector)});
              if (!el) return 'Element not found';
              el.focus();
              el.value = ${JSON.stringify(args.text || "")};
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return 'Typed into: ' + (el.getAttribute('aria-label') || el.placeholder || el.name || 'input');
            })()
          `);
        }

        case "scroll": {
          if (!wc) return "Error: No active tab";
          const pixels = args.amount || 500;
          const dir = args.direction === "up" ? -pixels : pixels;
          await wc.executeJavaScript(`window.scrollBy(0, ${dir})`);
          return `Scrolled ${args.direction} by ${pixels}px`;
        }

        case "read_page": {
          if (!wc) return "Error: No active tab";
          const content = await extractContent(wc);
          const structured = buildStructuredContext(content);
          const truncated =
            content.content.length > 20000
              ? content.content.slice(0, 20000) + "\n[Content truncated...]"
              : content.content;
          return `${structured}\n\n## PAGE CONTENT\n\n${truncated}`;
        }

        case "wait_for": {
          if (!wc) return "Error: No active tab";
          return waitForCondition(wc, args);
        }

        case "create_checkpoint": {
          const checkpoint = ctx.runtime.createCheckpoint(args.name, args.note);
          return `Created checkpoint ${checkpoint.name} (${checkpoint.id})`;
        }

        case "restore_checkpoint": {
          const checkpoint = findCheckpoint(
            ctx.runtime.getState().checkpoints,
            args,
          );
          if (!checkpoint) {
            return "Error: No matching checkpoint found";
          }
          ctx.runtime.restoreCheckpoint(checkpoint.id);
          return `Restored checkpoint ${checkpoint.name}`;
        }

        default:
          return `Unknown tool: ${name}`;
      }
    },
  });
}
