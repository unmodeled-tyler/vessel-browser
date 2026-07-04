import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PageContent } from "../../../shared/types";
import { createLogger } from "../../../shared/logger";
import type { AgentRuntime } from "../../agent/runtime";
import {
  buildScopedContext,
  buildStructuredContext,
  type ExtractMode,
} from "../../ai/context-builder";
import { handleReadPage } from "../../ai/page-actions/handlers/page-reading";
import { getTabByMatch } from "../../ai/page-actions/navigation";
import { MAX_MCP_NAV_CONTENT_LENGTH } from "../../ai/content-limits";
import { extractContent } from "../../content/extractor";
import { captureScreenshot } from "../../content/screenshot";
import * as highlightsManager from "../../highlights/manager";
import {
  captureLiveHighlightSnapshot,
  formatLiveSelectionSection,
} from "../../highlights/live-snapshot";
import type { TabManager } from "../../tabs/tab-manager";
import { resolveSelector } from "../../utils/selector-resolver";
import { waitForLoad } from "../../utils/webcontents-utils";
import {
  asErrorTextResponse,
  asNoActiveTabResponse,
  asTextResponse,
  getPremiumToolGateResponse,
  withAction,
} from "../mcp-helpers";

const logger = createLogger("MCPContentTools");

const EXTRACT_MODES: ExtractMode[] = [
  "full",
  "summary",
  "interactives_only",
  "forms_only",
  "text_only",
  "visible_only",
  "results_only",
];
const READ_PAGE_MODES = [...EXTRACT_MODES, "glance", "debug"] as const;

async function buildExtractResponse(
  pageContent: PageContent,
  mode: ExtractMode,
  adBlockingEnabled: boolean,
  wc?: Electron.WebContents,
): Promise<string> {
  const adBlockLine = `**Ad Blocking:** ${adBlockingEnabled ? "On" : "Off"}`;
  const savedHighlights = highlightsManager.getHighlightsForUrl(
    pageContent.url,
  );
  const liveSelectionSection = wc
    ? formatLiveSelectionSection(
        await captureLiveHighlightSnapshot(wc, savedHighlights),
      )
    : null;
  const livePrefix = liveSelectionSection ? `\n\n${liveSelectionSection}` : "";

  if (mode === "full") {
    const structured = buildStructuredContext(pageContent);
    const truncated =
      pageContent.content.length > MAX_MCP_NAV_CONTENT_LENGTH
        ? pageContent.content.slice(0, MAX_MCP_NAV_CONTENT_LENGTH) +
          "\n[Content truncated...]"
        : pageContent.content;
    return `${adBlockLine}${livePrefix}\n\n${structured}\n\n## PAGE CONTENT\n\n${truncated}`;
  }
  if (mode === "text_only") {
    return `${adBlockLine}${livePrefix}\n\n${buildScopedContext(pageContent, mode)}`;
  }
  return `${adBlockLine}${livePrefix}\n\n${buildScopedContext(pageContent, mode)}`;
}

export function registerContentTools(
  server: McpServer,
  tabManager: TabManager,
  runtime: AgentRuntime,
): void {
  server.registerTool(
    "publish_transcript",
    {
      title: "Publish Agent Transcript",
      description:
        "Publish or stream agent reasoning/status text into Vessel's in-browser transcript monitor. Intended for external harnesses that want to mirror live thinking into the browser UI.",
      inputSchema: {
        text: z.string().describe("Transcript text chunk to publish"),
        stream_id: z
          .string()
          .optional()
          .describe(
            "Stable stream ID for incremental updates to the same entry",
          ),
        mode: z
          .enum(["append", "replace", "final"])
          .optional()
          .describe(
            "append (default), replace current stream text, or mark the stream final",
          ),
        kind: z
          .enum(["thinking", "message", "status"])
          .optional()
          .describe("Visual style for the transcript entry"),
        title: z
          .string()
          .optional()
          .describe("Optional short label such as Plan, Search, or Summary"),
      },
    },
    async ({ text, stream_id, mode, kind, title }) => {
      const entry = runtime.publishTranscript({
        source: "mcp",
        text,
        streamId: stream_id,
        mode,
        kind,
        title,
      });
      return asTextResponse(
        JSON.stringify(
          {
            ok: true,
            entry_id: entry.id,
            stream_id: entry.streamId ?? entry.id,
            status: entry.status,
            updated_at: entry.updatedAt,
          },
          null,
          2,
        ),
      );
    },
  );

  server.registerTool(
    "clear_transcript",
    {
      title: "Clear Agent Transcript",
      description: "Clear the in-browser transcript monitor state.",
    },
    async () => {
      runtime.clearTranscript();
      return asTextResponse("Cleared browser transcript monitor.");
    },
  );

  server.registerTool(
    "extract_content",
    {
      title: "Extract Page Content",
      description:
        "Extract structured content from the current page. Modes: 'full' (default, everything), 'summary' (title+headings+stats), 'interactives_only' (clickable elements with indices), 'forms_only' (form fields only), 'text_only' (page text, no interactives), 'visible_only' (only currently visible, in-viewport, unobstructed elements plus active overlays), 'results_only' (likely primary search/result links only).",
      inputSchema: {
        mode: z
          .enum(EXTRACT_MODES as [string, ...string[]])
          .optional()
          .describe(
            "Extraction mode: full, summary, interactives_only, forms_only, text_only, visible_only, results_only",
          ),
      },
    },
    async ({ mode }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();

      try {
        const pageContent = await extractContent(tab.view.webContents);
        const effectiveMode = (mode || "full") as ExtractMode;
        return asTextResponse(
          await buildExtractResponse(
            pageContent,
            effectiveMode,
            tab.state.adBlockingEnabled,
            tab.view.webContents,
          ),
        );
      } catch (error) {
        return asTextResponse(
          `Error extracting content: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    },
  );

  server.registerTool(
    "read_page",
    {
      title: "Read Page",
      description:
        "Read the active tab's page content. Includes saved highlights plus any active text selection or visible unsaved highlights on the page. Supports scoped modes plus glance and debug.",
      inputSchema: {
        mode: z
          .enum(READ_PAGE_MODES)
          .optional()
          .describe(
            "Read mode: glance, summary, interactives_only, forms_only, text_only, visible_only, results_only, full, or debug",
          ),
      },
    },
    async ({ mode }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "read_page",
        { mode },
        async () => handleReadPage({ tabManager, runtime }, { mode }),
      );
    },
  );

  server.registerTool(
    "list_tabs",
    {
      title: "List Tabs",
      description:
        "List all open browser tabs with their IDs, titles, and URLs.",
    },
    async () => {
      const activeId = tabManager.getActiveTabId();
      const lines = tabManager.getAllStates().map((tab) => {
        const hlCount = highlightsManager.getHighlightsForUrl(tab.url).length;
        const hlTag = hlCount > 0 ? ` [highlights:${hlCount}]` : "";
        return `${tab.id === activeId ? "->" : "  "} [${tab.id}] ${tab.title} — ${tab.url} [adblock:${tab.adBlockingEnabled ? "on" : "off"}]${hlTag}`;
      });
      return asTextResponse(lines.join("\n") || "No tabs open");
    },
  );

  server.registerTool(
    "set_ad_blocking",
    {
      title: "Set Ad Blocking",
      description:
        "Enable or disable ad blocking for the active tab or a matched tab. Reload after changes unless reload is false.",
      inputSchema: {
        enabled: z
          .boolean()
          .describe("Whether ad blocking should be enabled for the target tab"),
        tabId: z
          .string()
          .optional()
          .describe("Exact tab ID to target instead of the active tab"),
        match: z
          .string()
          .optional()
          .describe("Case-insensitive partial match against tab title or URL"),
        reload: z
          .boolean()
          .optional()
          .describe("Reload the tab after changing the setting (default true)"),
      },
    },
    async ({ enabled, tabId, match, reload }) => {
      const activeTab = tabManager.getActiveTab();
      if (!activeTab && !tabId && !match) {
        return asNoActiveTabResponse();
      }

      return withAction(
        runtime,
        tabManager,
        "set_ad_blocking",
        { enabled, tabId, match, reload },
        async () => {
          let targetId = typeof tabId === "string" ? tabId.trim() : "";
          if (!targetId && typeof match === "string" && match.trim()) {
            targetId = getTabByMatch(tabManager, match.trim())?.id || "";
          }
          if (!targetId) {
            targetId = tabManager.getActiveTabId() || "";
          }
          if (!targetId) return "Error: No target tab found";

          const targetTab = tabManager.getTab(targetId);
          if (!targetTab) return "Error: Target tab not found";

          tabManager.setAdBlockingEnabled(targetId, enabled);

          const shouldReload = reload !== false;
          if (shouldReload) {
            targetTab.reload();
            await waitForLoad(targetTab.view.webContents);
          }

          const state = targetTab.state;
          return `${enabled ? "Enabled" : "Disabled"} ad blocking for "${state.title}"${shouldReload ? " and reloaded the tab" : ""}`;
        },
      );
    },
  );

  server.registerTool(
    "extract_structured_data",
    {
      title: "Extract Structured Data",
      description:
        "Return normalized structured data derived from page JSON-LD, microdata, RDFa, and high-signal meta tags. Useful for recipes, products, articles, events, FAQs, and other schema-rich pages.",
      inputSchema: {
        type: z
          .string()
          .optional()
          .describe(
            "Optional schema type filter, for example Recipe, Product, Article, Event, or FAQPage",
          ),
      },
    },
    async ({ type }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();

      try {
        const pageContent = await extractContent(tab.view.webContents);
        const requestedType =
          typeof type === "string" && type.trim()
            ? type.trim().toLowerCase()
            : "";
        const entities = (pageContent.structuredData ?? []).filter((entity) =>
          requestedType
            ? entity.types.some(
                (entry) => entry.toLowerCase() === requestedType,
              )
            : true,
        );
        const sourceCounts = {
          json_ld: pageContent.jsonLd?.length ?? 0,
          microdata: pageContent.microdata?.length ?? 0,
          rdfa: pageContent.rdfa?.length ?? 0,
          meta_tags: Object.keys(pageContent.metaTags ?? {}).length,
        };
        const usedPageFallback =
          entities.length > 0 &&
          entities.every((entity) => entity.source === "page");
        const hasRawSources =
          sourceCounts.json_ld > 0 ||
          sourceCounts.microdata > 0 ||
          sourceCounts.rdfa > 0;
        const message =
          entities.length > 0
            ? usedPageFallback
              ? hasRawSources
                ? `Raw structured data sources were found (${sourceCounts.json_ld} JSON-LD, ${sourceCounts.microdata} microdata, ${sourceCounts.rdfa} RDFa) but could not be normalized into typed entities. Returning generic page metadata. The raw sources may contain parseable data — check sources_checked counts.`
                : "No richer machine-readable schema was detected. Returning a generic page metadata entity synthesized from the current page."
              : undefined
            : requestedType
              ? `No structured data entities matched type "${type}".`
              : "No structured data entities detected. This page may not expose usable JSON-LD, microdata, RDFa, or high-signal metadata.";

        return asTextResponse(
          JSON.stringify(
            {
              url: pageContent.url,
              title: pageContent.title,
              count: entities.length,
              sources_checked: sourceCounts,
              used_page_fallback: usedPageFallback,
              message,
              entities,
            },
            null,
            2,
          ),
        );
      } catch (error) {
        return asTextResponse(
          `Error extracting structured data: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    },
  );

  server.registerTool(
    "extract_text",
    {
      title: "Extract Element Text",
      description:
        "Extract the text content of a specific element by its index number or CSS selector.",
      inputSchema: {
        index: z
          .number()
          .optional()
          .describe("Element index from the page content listing"),
        selector: z.string().optional().describe("CSS selector as fallback"),
      },
    },
    async ({ index, selector }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      const wc = tab.view.webContents;
      const resolvedSelector = await resolveSelector(wc, index, selector);
      if (!resolvedSelector) {
        return asErrorTextResponse("No index or selector provided");
      }
      const result = await wc.executeJavaScript(`
        (function() {
          try {
            const el = document.querySelector(${JSON.stringify(resolvedSelector)});
            if (!el) return { error: 'Element not found' };

            const tag =
              typeof el.tagName === 'string' ? el.tagName.toLowerCase() : 'unknown';
            const text =
              el instanceof HTMLElement
                ? (el.innerText || el.textContent || '')
                : (el.textContent || '');
            const value =
              el instanceof HTMLInputElement ||
              el instanceof HTMLTextAreaElement ||
              el instanceof HTMLSelectElement
                ? el.value
                : null;
            const attr =
              el.getAttribute('aria-label') ||
              el.getAttribute('title') ||
              el.getAttribute('alt') ||
              null;
            const role = el.getAttribute('role') || null;

            return {
              tag,
              role,
              text: String(text || '').trim(),
              value: value == null ? null : String(value),
              attr: attr == null ? null : String(attr),
            };
          } catch (error) {
            return {
              error:
                error instanceof Error
                  ? error.message
                  : 'Element text extraction failed',
            };
          }
        })()
      `);
      if (!result || typeof result !== "object") {
        return asTextResponse(
          "Error: Element text extraction returned no result",
        );
      }
      if ("error" in result && typeof result.error === "string") {
        return asErrorTextResponse(result.error);
      }
      const parts: string[] = [`<${result.tag}>`];
      if (
        "role" in result &&
        typeof result.role === "string" &&
        result.role.trim()
      ) {
        parts.push(`role: ${result.role}`);
      }
      if (result.value !== null) parts.push(`value: ${result.value}`);
      if (result.text) parts.push(`text: ${result.text}`);
      if (result.attr) parts.push(`label: ${result.attr}`);
      if (parts.length === 1) {
        parts.push("No readable text, value, or label found on this element.");
      }
      return asTextResponse(parts.join("\n"));
    },
  );

  server.registerTool(
    "screenshot",
    {
      title: "Screenshot",
      description:
        "Capture a screenshot of the current page. Returns a base64-encoded PNG image.",
    },
    async () => {
      const premiumGate = getPremiumToolGateResponse("screenshot");
      if (premiumGate) return premiumGate;

      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();

      try {
        const bounds = tab.view.getBounds();
        if (bounds.width <= 0 || bounds.height <= 0) {
          return asTextResponse(
            "Error capturing screenshot: active tab has zero-sized bounds",
          );
        }
        const screenshot = await captureScreenshot(tab.view.webContents);
        if (!screenshot.ok) {
          return asTextResponse(
            `Error capturing screenshot: ${screenshot.error}`,
          );
        }
        const screenshotPath = path.join(
          os.tmpdir(),
          `vessel_screenshot_${Date.now()}.png`,
        );
        fs.writeFileSync(
          screenshotPath,
          Buffer.from(screenshot.base64, "base64"),
        );
        return {
          content: [
            {
              type: "image" as const,
              data: screenshot.base64,
              mimeType: "image/png",
            },
            {
              type: "text" as const,
              text: `Screenshot captured: ${screenshot.width}x${screenshot.height}\nSaved to: ${screenshotPath}\nTo analyze visually, call vision_analyze with image_url="${screenshotPath}"`,
            },
          ],
        };
      } catch (error) {
        return asTextResponse(
          `Error capturing screenshot: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    },
  );

  server.registerTool(
    "suggest",
    {
      title: "What Should I Do?",
      description:
        "Analyze the current page and return the most relevant tools and suggested next actions. Call this when you're unsure what to do next — it reads the page context and tells you the optimal approach.",
    },
    async () => {
      const tab = tabManager.getActiveTab();
      if (!tab) {
        return asTextResponse(
          "No active tab. Use navigate to open a page.",
        );
      }

      const wc = tab.view.webContents;
      let page: PageContent;
      try {
        page = await extractContent(wc);
      } catch (err) {
        logger.warn("Failed to extract page while generating suggestions:", err);
        return asTextResponse(
          "Could not read page. Try navigate to a working URL.",
        );
      }

      const suggestions: string[] = [];
      suggestions.push(`Page: ${page.title || "(untitled)"}`);
      suggestions.push(`URL: ${page.url}`);
      suggestions.push("");

      const flowCtx = runtime.getFlowContext();
      if (flowCtx) {
        suggestions.push(flowCtx);
        suggestions.push("");
      }

      const hasPasswordField = page.forms.some((f) =>
        f.fields.some((el) => el.inputType === "password"),
      );
      const hasSearchInput = page.interactiveElements.some(
        (el) =>
          el.inputType === "search" ||
          el.name === "q" ||
          el.name === "query" ||
          (el.placeholder || "").toLowerCase().includes("search"),
      );
      const formCount = page.forms.length;
      const totalFields = page.forms.reduce((n, f) => n + f.fields.length, 0);
      const linkCount = page.interactiveElements.filter(
        (el) => el.type === "link",
      ).length;
      const hasPagination = page.interactiveElements.some(
        (el) =>
          (el.text || "").toLowerCase() === "next" ||
          el.text === "›" ||
          el.text === "»",
      );
      const hasOverlays = page.overlays.some((o) => o.blocksInteraction);

      if (hasOverlays) {
        suggestions.push("⚠ BLOCKING OVERLAY detected — dismiss it first:");
        suggestions.push("  → clear_overlays for stacked modals");
        suggestions.push("  → or dismiss_popup for a single popup");
        suggestions.push("");
      }

      if (hasPasswordField) {
        suggestions.push("🔑 LOGIN PAGE detected:");
        suggestions.push(
          "  → login(username, password) — handles the full flow",
        );
        suggestions.push(
          "  → Or fill_form + submit_form for manual control",
        );
      } else if (hasSearchInput && linkCount < 10) {
        suggestions.push("🔍 SEARCH PAGE detected:");
        suggestions.push(
          "  → search(query) — finds the box, types, submits",
        );
      } else if (hasSearchInput && linkCount >= 10) {
        suggestions.push("📋 SEARCH RESULTS detected:");
        suggestions.push("  → click on a result link");
        if (hasPagination) {
          suggestions.push("  → paginate('next') for more results");
        }
      } else if (formCount > 0) {
        suggestions.push(`📝 FORM detected (${totalFields} fields):`);
        suggestions.push(
          "  → fill_form(fields) — fill all fields at once",
        );
        suggestions.push("  → Or type for individual fields");
      } else if (hasPagination) {
        suggestions.push("📄 PAGINATED CONTENT:");
        suggestions.push("  → extract_content to read this page");
        suggestions.push("  → paginate('next') for the next page");
      } else if (
        page.content.length > 3000 &&
        page.interactiveElements.length < 10
      ) {
        suggestions.push("📖 ARTICLE/CONTENT page:");
        suggestions.push("  → extract_content for readable text");
        suggestions.push("  → scroll to see more");
      } else {
        suggestions.push("🌐 GENERAL PAGE:");
        suggestions.push(
          "  → extract_content to understand the page structure",
        );
        suggestions.push("  → click on any element by index");
        suggestions.push("  → navigate to go somewhere new");
      }

      suggestions.push("");
      suggestions.push(
        `Available: ${page.interactiveElements.length} interactive elements, ${formCount} forms, ${linkCount} links`,
      );

      return asTextResponse(suggestions.join("\n"));
    },
  );

  server.registerTool(
    "extract_table",
    {
      title: "Extract Table",
      description:
        "Extract a table from the page as structured JSON rows with headers.",
      inputSchema: z.object({
        index: z.number().optional().describe("Element index of the table"),
        selector: z.string().optional().describe("CSS selector for the table"),
      }),
    },
    async ({ index, selector: rawSelector }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "extract_table",
        { index, selector: rawSelector },
        async () => {
          const wc = tab.view.webContents;
          const sel =
            rawSelector ||
            (index != null ? await resolveSelector(wc, index) : null);
          const tableJson = await wc.executeJavaScript(`
            (function() {
              var table = ${sel ? `document.querySelector(${JSON.stringify(sel)})` : "document.querySelector('table')"};
              if (!table) return null;
              var headers = [];
              var headerRow = table.querySelector('thead tr') || table.querySelector('tr');
              if (headerRow) {
                headerRow.querySelectorAll('th, td').forEach(function(cell) {
                  headers.push(cell.textContent.trim());
                });
              }
              var rows = [];
              var bodyRows = table.querySelectorAll('tbody tr');
              if (bodyRows.length === 0) bodyRows = table.querySelectorAll('tr');
              bodyRows.forEach(function(tr, idx) {
                if (idx === 0 && headers.length > 0 && !table.querySelector('thead')) return;
                var row = {};
                tr.querySelectorAll('td, th').forEach(function(cell, ci) {
                  var key = headers[ci] || ("col_" + ci);
                  row[key] = cell.textContent.trim();
                });
                if (Object.keys(row).length > 0) rows.push(row);
              });
              return { headers: headers, rows: rows, rowCount: rows.length };
            })()
          `);
          if (!tableJson) return "Error: No table found on the page.";
          return `Extracted table (${tableJson.rowCount} rows):\n${JSON.stringify(tableJson, null, 2)}`;
        },
      );
    },
  );
}
