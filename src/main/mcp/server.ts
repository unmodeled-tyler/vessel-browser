import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { PageContent, TabGroupColor } from "../../shared/types";
import { createLogger } from "../../shared/logger";
import { errorResult, getErrorMessage } from "../../shared/result";
import type { AgentRuntime } from "../agent/runtime";
import {
  buildStructuredContext,
  buildScopedContext,
  detectPageType,
  type ExtractMode,
  type PageType,
} from "../ai/context-builder";
import { TOOL_DEFINITIONS } from "../tools/definitions";
import { resolveBookmarkSourceDraft } from "../bookmarks/page-source";
import { extractContent } from "../content/extractor";
import { getRecoverableAccessIssue } from "../content/page-access-issues";
import {
  formatDeadLinkMessage,
  validateLinkDestination,
} from "../network/link-validation";
import {
  clearOverlays,
  clickResolvedSelector,
  composeDuplicateBookmarkResponse,
  composeFolderAwareResponse,
  describeFolder,
  dismissPopup,
  fillFormFields,
  focusElement,
  getBookmarkMetadataFromArgs,
  getTabByMatch,
  hoverElement,
  isDangerousAction,
  pressKeyDirect as pressKey,
  resolveBookmarkFolderTarget,
  scrollPage,
  selectOptionDirect as selectOption,
  setElementValue,
  submitFormDirect as submitForm,
  typeKeystroke,
  waitForConditionDirect as waitForCondition,
} from "../ai/page-actions";
import {
  coerceOptionalNumber,
  coerceStringArray,
  normalizeLooseString,
  normalizedOptionalStringSchema,
  optionalNumberLikeSchema,
  stringArrayLikeSchema,
} from "../tools/input-coercion";
import {
  waitForLoad,
  waitForPotentialNavigation,
} from "../utils/webcontents-utils";
import { resolveSelector } from "../utils/selector-resolver";
import type { TabManager } from "../tabs/tab-manager";
import * as bookmarkManager from "../bookmarks/manager";
import * as highlightsManager from "../highlights/manager";
import { highlightOnPage, clearHighlights } from "../highlights/inject";
import {
  captureLiveHighlightSnapshot,
  formatLiveSelectionSection,
} from "../highlights/live-snapshot";
import * as namedSessionManager from "../sessions/manager";
import {
  appendToMemoryNote,
  capturePageToVault,
  linkBookmarkToMemory,
  listMemoryNotes,
  searchMemoryNotes,
  writeMemoryNote,
} from "../memory/obsidian";
import { getRuntimeHealth, setMcpHealth } from "../health/runtime-health";
import { MAX_MCP_NAV_CONTENT_LENGTH } from "../ai/content-limits";
import { registerDevTools } from "../devtools/tools";
import {
  assertSafeURL,
} from "../network/url-safety";
import { captureScreenshot } from "../content/screenshot";
import * as vaultManager from "../vault/manager";
import { requestConsent } from "../vault/consent";
import { appendAuditEntry } from "../vault/audit";
import * as humanVault from "../vault/human-vault";
import { requestHumanVaultConsent } from "../vault/human-consent";
import { trackVaultAction } from "../telemetry/posthog";
let httpServer: http.Server | null = null;
let mcpAuthToken: string | null = null;
const logger = createLogger("MCP");

// Well-known path where external MCP clients (e.g. Hermes) can read the
// current auth token and endpoint. Written on successful start. The token is
// persisted across restarts so external MCP client configs remain valid.
const MCP_AUTH_FILENAME = "mcp-auth.json";

type McpAuthState = {
  endpoint?: string;
  token?: string;
  pid?: number | null;
};

function getMcpAuthFilePath(): string {
  // Electron stores userData at ~/.config/<appName> on Linux.  We resolve the
  // same directory via the XDG convention without importing `app` (which may
  // not be available during tests).
  const configDir =
    process.env.VESSEL_CONFIG_DIR ||
    path.join(
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
      "vessel",
    );
  return path.join(configDir, MCP_AUTH_FILENAME);
}

function readMcpAuthFile(): McpAuthState | null {
  try {
    const raw = fs.readFileSync(getMcpAuthFilePath(), "utf8");
    const parsed = JSON.parse(raw) as McpAuthState;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

const MIN_TOKEN_LENGTH = 32;

function getPersistentMcpAuthToken(): string {
  const existingToken = readMcpAuthFile()?.token?.trim();
  if (existingToken && existingToken.length >= MIN_TOKEN_LENGTH) {
    return existingToken;
  }
  return crypto.randomBytes(32).toString("hex");
}

function writeMcpAuthFile(endpoint: string, token: string): void {
  try {
    const filePath = getMcpAuthFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({ endpoint, token, pid: process.pid }, null, 2) + "\n",
      { mode: 0o600 },
    );
    fs.chmodSync(filePath, 0o600);
  } catch (err) {
    logger.warn("Failed to write auth file:", err);
  }
}

function clearMcpAuthFile(): void {
  const existingToken = readMcpAuthFile()?.token?.trim();
  if (!existingToken) {
    try {
      fs.unlinkSync(getMcpAuthFilePath());
    } catch {
      // File may not exist — that's fine.
    }
    return;
  }
  try {
    const filePath = getMcpAuthFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        { endpoint: "", token: existingToken, pid: null },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    fs.chmodSync(filePath, 0o600);
  } catch (err) {
    logger.warn("Failed to clear auth file:", err);
  }
}

/** Returns the current MCP auth token. */
export function getMcpAuthToken(): string | null {
  return mcpAuthToken;
}

export function regenerateMcpAuthToken(): { endpoint: string } | null {
  const endpoint = getRuntimeHealth().mcp.endpoint;
  if (!httpServer || !endpoint) return null;
  mcpAuthToken = crypto.randomBytes(32).toString("hex");
  writeMcpAuthFile(endpoint, mcpAuthToken);
  return { endpoint };
}

export interface McpServerStartResult {
  ok: boolean;
  configuredPort: number;
  activePort: number | null;
  endpoint: string | null;
  authToken: string | null;
  error?: string;
}

function asTextResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function asErrorTextResponse(message: string) {
  return asTextResponse(`Error: ${message}`);
}

function asNoActiveTabResponse() {
  return asErrorTextResponse("No active tab");
}


function asPromptResponse(text: string) {
  return {
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text,
        },
      },
    ],
  };
}

function isDangerousMcpAction(name: string): boolean {
  return name === "close_tab" || isDangerousAction(name);
}

export function requiresExplicitMcpApproval(name: string, args: Record<string, unknown>): boolean {
  if (name === "delete_session" || name === "close_tab" || name === "load_session") return true;
  if (name === "remove_bookmark_folder" && args.delete_contents === true) return true;
  return false;
}

function getActiveTabSummary(tabManager: TabManager) {
  const activeTab = tabManager.getActiveTab();
  const activeTabId = tabManager.getActiveTabId();
  if (!activeTab || !activeTabId) return null;
  const state = activeTab.state;
  return {
    tabId: activeTabId,
    title: state.title,
    url: state.url,
    isLoading: state.isLoading,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
    adBlockingEnabled: state.adBlockingEnabled,
    humanFocused: true,
  };
}


async function getPostActionState(
  tabManager: TabManager,
  name: string,
): Promise<string> {
  // Append state context for navigation/interaction actions
  const tab = tabManager.getActiveTab();
  if (!tab) return "";

  const wc = tab.view.webContents;
  const navActions = [
    "navigate",
    "go_back",
    "go_forward",
    "click",
    "submit_form",
    "reload",
    "press_key",
  ];
  const interactActions = [
    "type",
    "type_text",
    "select_option",
    "hover",
    "focus",
  ];
  const tabActions = ["create_tab", "switch_tab", "close_tab"];

  if (navActions.includes(name)) {
    let warning = "";

    try {
      const page = await extractContent(wc);
      const issue = getRecoverableAccessIssue(page);
      if (issue) {
        const blockedUrl = wc.getURL();
        const canRecover =
          [
            "navigate",
            "open_bookmark",
            "click",
            "submit_form",
            "reload",
            "press_key",
          ].includes(name) && tab.canGoBack();

        if (canRecover && tab.goBack()) {
          await waitForLoad(wc);
          warning = `\n[warning: ${issue.summary} ${issue.recommendation ?? ""} Automatically returned to ${wc.getURL()} after landing on ${blockedUrl}.]`;
        } else {
          warning = `\n[warning: ${issue.summary} ${issue.recommendation ?? ""}${tab.canGoBack() ? "" : " No previous page was available for automatic recovery."}]`;
        }
      }
    } catch (err) {
      logger.warn("Failed to compute post-action state warning:", err);
    }

    return `${warning}\n[state: url=${wc.getURL()}, canGoBack=${tab.canGoBack()}, canGoForward=${tab.canGoForward()}, loading=${wc.isLoading()}]`;
  }

  if (interactActions.includes(name)) {
    return `\n[state: url=${wc.getURL()}, title=${JSON.stringify(wc.getTitle() || "")}, tabId=${tabManager.getActiveTabId()}]`;
  }

  if (tabActions.includes(name)) {
    const activeId = tabManager.getActiveTabId();
    const active = getActiveTabSummary(tabManager);
    const count = tabManager.getAllStates().length;
    return `\n[state: activeTab=${activeId}, title=${JSON.stringify(active?.title ?? "")}, url=${active?.url ?? ""}, totalTabs=${count}]`;
  }

  return "";
}

async function withAction(
  runtime: AgentRuntime,
  tabManager: TabManager,
  name: string,
  args: Record<string, unknown>,
  executor: () => Promise<string>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  try {
    const result = await runtime.runControlledAction({
      source: "mcp",
      name,
      args,
      tabId: tabManager.getActiveTabId(),
      dangerous: isDangerousMcpAction(name),
      requiresApproval: requiresExplicitMcpApproval(name, args),
      executor,
    });
    const stateInfo = await getPostActionState(tabManager, name);
    const flowCtx = runtime.getFlowContext();
    return asTextResponse(result + stateInfo + flowCtx);
  } catch (error) {
    return asErrorTextResponse(getErrorMessage(error));
  }
}

async function waitForConditionMcp(
  wc: Electron.WebContents,
  text?: string,
  selector?: string,
  timeoutMs?: number,
): Promise<string> {
  const effectiveTimeout = Math.max(250, timeoutMs || 5000);
  const expectedText = (text || "").trim();
  const expectedSelector = (selector || "").trim();
  const startedAt = Date.now();

  const result = await waitForCondition(
    wc,
    expectedText,
    expectedSelector,
    effectiveTimeout,
  );
  const elapsedMs = Date.now() - startedAt;

  if (result === "Error: wait_for requires text or selector") {
    return JSON.stringify({
      matched: false,
      error: "wait_for requires text or selector",
    });
  }

  if (result.startsWith("Error: Invalid selector ")) {
    return JSON.stringify({
      matched: false,
      error: result.slice("Error: ".length),
    });
  }

  if (result.startsWith("Error: Page is still busy; wait_for timed out")) {
    return JSON.stringify({
      matched: false,
      error: result.slice("Error: ".length),
      elapsed_ms: elapsedMs,
      timeout_ms: effectiveTimeout,
    });
  }

  if (expectedSelector && result === `Matched selector ${expectedSelector}`) {
    return JSON.stringify({
      matched: true,
      type: "selector",
      value: expectedSelector,
      elapsed_ms: elapsedMs,
    });
  }

  const matchedTextPrefix = 'Matched text "';
  if (result.startsWith(matchedTextPrefix) && result.endsWith('"')) {
    return JSON.stringify({
      matched: true,
      type: "text",
      value: result.slice(matchedTextPrefix.length, -1),
      elapsed_ms: elapsedMs,
    });
  }

  const timeoutPayload: {
    matched: false;
    type: "selector" | "text";
    value: string;
    elapsed_ms: number;
    timeout_ms: number;
    diagnostic?: string;
  } = {
    matched: false,
    type: expectedSelector ? "selector" : "text",
    value: expectedSelector || expectedText.slice(0, 80),
    elapsed_ms: elapsedMs,
    timeout_ms: effectiveTimeout,
  };

  if (expectedSelector) {
  const diagnostic = await wc.executeJavaScript(`
      (function() {
        try {
          var count = document.querySelectorAll(${JSON.stringify(expectedSelector)}).length;
          return count > 0 ? 'found ' + count + ' after timeout' : 'not found (page has ' + document.querySelectorAll('*').length + ' elements)';
        } catch (e) {
          return 'selector error: ' + e.message;
        }
      })()
    `).catch((err) => {
      logger.warn("Failed to gather wait_for timeout diagnostic:", err);
      return null;
    });
    if (typeof diagnostic === "string" && diagnostic.trim()) {
      timeoutPayload.diagnostic = diagnostic;
    }
  }

  return JSON.stringify(timeoutPayload);
}


function registerTools(
  server: McpServer,
  tabManager: TabManager,
  runtime: AgentRuntime,
): void {
  server.registerPrompt(
    "vessel-supervisor-brief",
    {
      title: "Vessel Supervisor Brief",
      description:
        "A reusable prompt for reviewing the current Vessel runtime state.",
    },
    async () => {
      const state = runtime.getState();
      const activeTab = getActiveTabSummary(tabManager);
      return asPromptResponse(
        [
          "Review the current Vessel runtime state.",
          `Paused: ${state.supervisor.paused ? "yes" : "no"}`,
          `Approval mode: ${state.supervisor.approvalMode}`,
          `Pending approvals: ${state.supervisor.pendingApprovals.length}`,
          `Open tabs: ${state.session?.tabs.length || 0}`,
          `Human-focused tab: ${activeTab ? `${activeTab.title || "(untitled)"} — ${activeTab.url} [${activeTab.tabId}]` : "none"}`,
          `Recent actions: ${
            state.actions
              .slice(-5)
              .map((action) => action.name)
              .join(", ") || "none"
          }`,
        ].join("\n"),
      );
    },
  );

  server.registerResource(
    "vessel-runtime-state",
    "vessel://runtime/state",
    {
      title: "Vessel Runtime State",
      description:
        "Current supervisor, session, and checkpoint state for the Vessel browser runtime.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "vessel://runtime/state",
          text: JSON.stringify(runtime.getState(), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "vessel-active-tab",
    "vessel://tabs/active",
    {
      title: "Vessel Active Tab",
      description:
        "The tab currently visible to the human user, with URL and title.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "vessel://tabs/active",
          text: JSON.stringify(getActiveTabSummary(tabManager), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "vessel-recommended-tools",
    "vessel://context/recommended-tools",
    {
      title: "Recommended Tools for Current Page",
      description:
        "Context-aware tool recommendations based on the current page type (login, search, form, article, etc.). Returns tools sorted by relevance with contextual hints.",
      mimeType: "application/json",
    },
    async () => {
      const activeTab = tabManager.getActiveTab();
      let pageType: PageType = "GENERAL";
      let pageUrl = "";
      let pageTitle = "";

      if (activeTab) {
        try {
          const wc = activeTab.view.webContents;
          pageUrl = wc.getURL();
          pageTitle = wc.getTitle();
          const page = await extractContent(wc);
          pageType = detectPageType(page);
        } catch (err) {
          logger.warn("Failed to detect page type for tool scoring, falling back to GENERAL:", err);
        }
      }

      // Score and sort tools by relevance for this page type
      const scored = TOOL_DEFINITIONS.map((def) => {
        const tier = def.tier ?? 1;
        const isRelevant = !def.relevance || def.relevance.includes(pageType);
        let score: number;
        if (tier === 0) score = 0;
        else if (tier === 1 && isRelevant) score = 10;
        else if (tier === 2 && isRelevant) score = 20;
        else if (tier === 1) score = 30;
        else score = 40;
        return {
          name: def.name,
          title: def.title,
          description: def.description,
          tier,
          relevance: isRelevant ? "high" : "low",
          score,
        };
      });

      scored.sort((a, b) => a.score - b.score);

      const result = {
        pageType,
        pageUrl,
        pageTitle,
        recommended: scored
          .filter((t) => t.score <= 20)
          .map(({ name, title, description, relevance }) => ({
            name,
            title,
            description,
            relevance,
          })),
        available: scored
          .filter((t) => t.score > 20)
          .map(({ name, title, relevance }) => ({ name, title, relevance })),
      };

      return {
        contents: [
          {
            uri: "vessel://context/recommended-tools",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "current_tab",
    {
      title: "Get Active Tab",
      description:
        "Return the browser tab the human is actively looking at right now. Use this instead of list_tabs when you only need the focused tab.",
    },
    async () => {
      const activeTab = getActiveTabSummary(tabManager);
      if (!activeTab) return asNoActiveTabResponse();
      return asTextResponse(JSON.stringify(activeTab, null, 2));
    },
  );

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

  const EXTRACT_MODES: ExtractMode[] = [
    "full",
    "summary",
    "interactives_only",
    "forms_only",
    "text_only",
    "visible_only",
    "results_only",
  ];

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
    const livePrefix = liveSelectionSection
      ? `\n\n${liveSelectionSection}`
      : "";

    if (mode === "full") {
      const structured = buildStructuredContext(pageContent);
      const truncated =
        pageContent.content.length > MAX_MCP_NAV_CONTENT_LENGTH
          ? pageContent.content.slice(0, MAX_MCP_NAV_CONTENT_LENGTH) + "\n[Content truncated...]"
          : pageContent.content;
      return `${adBlockLine}${livePrefix}\n\n${structured}\n\n## PAGE CONTENT\n\n${truncated}`;
    }
    if (mode === "text_only") {
      return `${adBlockLine}${livePrefix}\n\n${buildScopedContext(pageContent, mode)}`;
    }
    return `${adBlockLine}${livePrefix}\n\n${buildScopedContext(pageContent, mode)}`;
  }

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
        "Read the active tab's page content. Includes saved highlights plus any active text selection or visible unsaved highlights on the page. Supports modes: full (default — includes highlights section), summary, interactives_only, forms_only, text_only, visible_only, results_only.",
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
    "navigate",
    {
      title: "Navigate",
      description:
        "Navigate the active browser tab to a URL. Use postBody to submit data via POST request (e.g. form submissions).",
      inputSchema: {
        url: z.string().describe("The URL to navigate to"),
        postBody: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Optional form fields to submit via POST (application/x-www-form-urlencoded). Only supported on http/https URLs.",
          ),
      },
    },
    async ({ url, postBody }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      const preCheck = await validateLinkDestination(url);
      if (preCheck.status === "dead") {
        return asTextResponse(
          `Navigation blocked: ${url} returned ${preCheck.detail || "dead link"}. Try a different URL or go back and choose another link.`,
        );
      }
      // Block unsafe URL schemes (javascript:, file:, data:, etc.)
      try {
        assertSafeURL(url);
      } catch (err) {
        return asTextResponse(
          `Navigation blocked: ${err instanceof Error ? err.message : "Unsafe URL scheme"}`,
        );
      }
      return withAction(runtime, tabManager, "navigate", { url }, async () => {
        const id = tabManager.getActiveTabId()!;
        const navError = tabManager.navigateTab(id, url, postBody);
        if (navError) return navError;
        const { httpStatus } = await waitForLoadWithStatus(
          tab.view.webContents,
        );
        const finalUrl = tab.view.webContents.getURL();
        const statusNote =
          httpStatus !== null && httpStatus >= 400
            ? ` [HTTP ${httpStatus} — page may be missing or unavailable, consider navigating back and trying a different link]`
            : "";
        return `Navigated to ${finalUrl}${statusNote}`;
      });
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
    "go_back",
    {
      title: "Go Back",
      description: "Go back in browser history.",
    },
    async () => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(runtime, tabManager, "go_back", {}, async () => {
        if (!tab.canGoBack()) {
          return "No previous page in history";
        }
        const beforeUrl = tab.view.webContents.getURL();
        tabManager.goBack(tabManager.getActiveTabId()!);
        await waitForLoad(tab.view.webContents);
        const afterUrl = tab.view.webContents.getURL();
        return afterUrl !== beforeUrl
          ? `Went back to ${afterUrl}`
          : `Back action completed but page stayed on ${afterUrl}`;
      });
    },
  );

  server.registerTool(
    "go_forward",
    {
      title: "Go Forward",
      description: "Go forward in browser history.",
    },
    async () => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(runtime, tabManager, "go_forward", {}, async () => {
        if (!tab.canGoForward()) {
          return "No forward page in history";
        }
        const beforeUrl = tab.view.webContents.getURL();
        tabManager.goForward(tabManager.getActiveTabId()!);
        await waitForLoad(tab.view.webContents);
        const afterUrl = tab.view.webContents.getURL();
        return afterUrl !== beforeUrl
          ? `Went forward to ${afterUrl}`
          : `Forward action completed but page stayed on ${afterUrl}`;
      });
    },
  );

  server.registerTool(
    "reload",
    {
      title: "Reload",
      description: "Reload the current page.",
    },
    async () => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(runtime, tabManager, "reload", {}, async () => {
        tabManager.reloadTab(tabManager.getActiveTabId()!);
        await waitForLoad(tab.view.webContents);
        return `Reloaded ${tab.view.webContents.getURL()}`;
      });
    },
  );

  server.registerTool(
    "click",
    {
      title: "Click Element",
      description:
        "Click an element on the page by its index number or CSS selector.",
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
      return withAction(
        runtime,
        tabManager,
        "click",
        { index, selector },
        async () => {
          const wc = tab.view.webContents;
          const resolvedSelector =
            typeof selector === "string" && selector.trim()
              ? await resolveSelector(wc, undefined, selector)
              : typeof index === "number"
                ? `__vessel_idx:${index}`
                : await resolveSelector(wc, index, selector);
          if (!resolvedSelector) {
            return "Error: No index or selector provided";
          }
          return clickResolvedSelector(wc, resolvedSelector);
        },
      );
    },
  );

  server.registerTool(
    "hover",
    {
      title: "Hover Element",
      description:
        "Move the mouse pointer over an element to trigger hover states, tooltips, or dropdown menus.",
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
      return withAction(
        runtime,
        tabManager,
        "hover",
        { index, selector },
        async () => {
          const wc = tab.view.webContents;
          const resolvedSelector = await resolveSelector(wc, index, selector);
          if (!resolvedSelector) {
            return "Error: No index or selector provided";
          }
          return hoverElement(wc, resolvedSelector);
        },
      );
    },
  );

  server.registerTool(
    "focus",
    {
      title: "Focus Element",
      description:
        "Focus an input, button, or interactive element. Useful before pressing keys or to trigger focus-dependent UI.",
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
      return withAction(
        runtime,
        tabManager,
        "focus",
        { index, selector },
        async () => {
          const wc = tab.view.webContents;
          const resolvedSelector = await resolveSelector(wc, index, selector);
          if (!resolvedSelector) {
            return "Error: No index or selector provided";
          }
          return focusElement(wc, resolvedSelector);
        },
      );
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
    "type",
    {
      title: "Type Text",
      description:
        "Type text into an input field or textarea. Clears existing content first.",
      inputSchema: {
        index: z
          .number()
          .optional()
          .describe("Element index from the page content listing"),
        selector: z.string().optional().describe("CSS selector as fallback"),
        text: z.string().describe("The text to type"),
        mode: z
          .enum(["default", "keystroke"])
          .optional()
          .describe(
            '"default" sets value directly and fires input+change events. "keystroke" simulates character-by-character key events for apps that validate on keypress.',
          ),
      },
    },
    async ({ index, selector, text, mode }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "type",
        { index, selector, text, mode },
        async () => {
          const resolvedSelector = await resolveSelector(
            tab.view.webContents,
            index,
            selector,
          );
          if (!resolvedSelector) {
            return "Error: No index or selector provided";
          }
          if (mode === "keystroke") {
            return typeKeystroke(tab.view.webContents, resolvedSelector, text);
          }
          return setElementValue(tab.view.webContents, resolvedSelector, text);
        },
      );
    },
  );

  server.registerTool(
    "type_text",
    {
      title: "Type Text",
      description:
        "Alias for type. Type text into an input field or textarea.",
      inputSchema: {
        index: z
          .number()
          .optional()
          .describe("Element index from the page content listing"),
        selector: z.string().optional().describe("CSS selector as fallback"),
        text: z.string().describe("The text to type"),
        mode: z
          .enum(["default", "keystroke"])
          .optional()
          .describe(
            '"default" sets value directly and fires input+change events. "keystroke" simulates character-by-character key events for apps that validate on keypress.',
          ),
      },
    },
    async ({ index, selector, text, mode }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "type_text",
        { index, selector, text, mode },
        async () => {
          const resolvedSelector = await resolveSelector(
            tab.view.webContents,
            index,
            selector,
          );
          if (!resolvedSelector) {
            return "Error: No index or selector provided";
          }
          if (mode === "keystroke") {
            return typeKeystroke(tab.view.webContents, resolvedSelector, text);
          }
          return setElementValue(tab.view.webContents, resolvedSelector, text);
        },
      );
    },
  );

  server.registerTool(
    "select_option",
    {
      title: "Select Option",
      description: "Select an option in a dropdown by label or value.",
      inputSchema: {
        index: z
          .number()
          .optional()
          .describe("Select element index from extracted content"),
        selector: z.string().optional().describe("CSS selector as fallback"),
        label: z.string().optional().describe("Visible option label"),
        value: z.string().optional().describe("Option value"),
      },
    },
    async ({ index, selector, label, value }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "select_option",
        { index, selector, label, value },
        async () =>
          selectOption(tab.view.webContents, index, selector, label, value),
      );
    },
  );

  server.registerTool(
    "submit_form",
    {
      title: "Submit Form",
      description:
        "Submit a form using a field index, submit button index, form selector, or button selector.",
      inputSchema: {
        index: z
          .number()
          .optional()
          .describe("Index of a form field or submit button"),
        selector: z
          .string()
          .optional()
          .describe("Form or submit button selector"),
      },
    },
    async ({ index, selector }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "submit_form",
        { index, selector },
        async () => submitForm(tab.view.webContents, index, selector),
      );
    },
  );

  server.registerTool(
    "press_key",
    {
      title: "Press Key",
      description:
        "Press a keyboard key, optionally after focusing an element.",
      inputSchema: {
        key: z.string().describe("Keyboard key such as Enter or Escape"),
        index: z.number().optional().describe("Element index to focus first"),
        selector: z.string().optional().describe("CSS selector to focus first"),
      },
    },
    async ({ key, index, selector }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "press_key",
        { key, index, selector },
        async () => {
          const wc = tab.view.webContents;
          const beforeUrl = wc.getURL();
          const result = await pressKey(wc, key, index, selector);
          // Enter can trigger form submission or navigation
          if (key === "Enter") {
            await waitForPotentialNavigation(wc, beforeUrl, 3000);
            const afterUrl = wc.getURL();
            if (afterUrl !== beforeUrl) {
              return `${result} -> ${afterUrl}`;
            }
          }
          return result;
        },
      );
    },
  );

  server.registerTool(
    "scroll",
    {
      title: "Scroll Page",
      description: "Scroll the page up or down.",
      inputSchema: {
        direction: z.enum(["up", "down"]).describe("Scroll direction"),
        amount: optionalNumberLikeSchema().describe(
          "Pixels to scroll (default 500)",
        ),
      },
    },
    async ({ direction, amount }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "scroll",
        { direction, amount },
        async () => {
          const pixels = coerceOptionalNumber(amount) ?? 500;
          const dir = direction === "up" ? -pixels : pixels;
          const result = await scrollPage(tab.view.webContents, dir);
          return `Scrolled ${direction} by ${pixels}px (moved ${Math.abs(result.movedY)}px, now at y=${Math.round(result.afterY)})`;
        },
      );
    },
  );

  server.registerTool(
    "dismiss_popup",
    {
      title: "Dismiss Popup",
      description:
        "Dismiss a modal, popup, newsletter gate, cookie banner, or blocking overlay using common close and decline actions.",
    },
    async () => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(runtime, tabManager, "dismiss_popup", {}, async () =>
        dismissPopup(tab.view.webContents),
      );
    },
  );

  server.registerTool(
    "clear_overlays",
    {
      title: "Clear Overlays",
      description:
        "Work through blocking overlays and modals until the page is unblocked, using overlay-specific heuristics for consent banners and radio-selection dialogs.",
      inputSchema: {
        strategy: z
          .enum(["auto", "interactive"])
          .optional()
          .describe(
            'How aggressively to clear overlays. "auto" uses heuristics; "interactive" stops earlier when human judgment may be needed.',
          ),
      },
    },
    async ({ strategy }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "clear_overlays",
        { strategy: strategy || "auto" },
        async () =>
          clearOverlays(
            tab.view.webContents,
            strategy === "interactive" ? "interactive" : "auto",
          ),
      );
    },
  );

  server.registerTool(
    "wait_for",
    {
      title: "Wait For",
      description: "Wait for text or a selector to appear on the current page.",
      inputSchema: {
        text: z.string().optional().describe("Text expected in the page body"),
        selector: z
          .string()
          .optional()
          .describe("CSS selector expected on the page"),
        timeoutMs: z
          .number()
          .optional()
          .describe("Maximum wait in milliseconds"),
      },
    },
    async ({ text, selector, timeoutMs }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "wait_for",
        { text, selector, timeoutMs },
        async () =>
          waitForConditionMcp(tab.view.webContents, text, selector, timeoutMs),
      );
    },
  );

  server.registerTool(
    "create_tab",
    {
      title: "Create Tab",
      description: "Open a new browser tab, optionally navigating to a URL.",
      inputSchema: {
        url: z
          .string()
          .optional()
          .describe("URL to open (defaults to about:blank)"),
      },
    },
    async ({ url }) =>
      withAction(runtime, tabManager, "create_tab", { url }, async () => {
        const id = tabManager.createTab(url || "about:blank");
        const tab = tabManager.getActiveTab();
        if (tab) {
          await waitForLoad(tab.view.webContents);
        }
        return `Created tab ${id}`;
      }),
  );

  server.registerTool(
    "switch_tab",
    {
      title: "Switch Tab",
      description:
        "Switch to a different browser tab by ID or title/URL match.",
      inputSchema: {
        tabId: z.string().optional().describe("The tab ID to switch to"),
        match: z
          .string()
          .optional()
          .describe("Case-insensitive match against title or URL"),
      },
    },
    async ({ tabId, match }) =>
      withAction(
        runtime,
        tabManager,
        "switch_tab",
        { tabId, match },
        async () => {
          const targetId =
            tabId || (match ? getTabByMatch(tabManager, match)?.id : "");
          if (!targetId) {
            return "Error: No matching tab found";
          }
          tabManager.switchTab(targetId);
          return `Switched to tab ${targetId}`;
        },
      ),
  );

  server.registerTool(
    "close_tab",
    {
      title: "Close Tab",
      description: "Close a browser tab by its ID.",
      inputSchema: {
        tabId: z.string().describe("The tab ID to close"),
      },
    },
    async ({ tabId }) =>
      withAction(runtime, tabManager, "close_tab", { tabId }, async () => {
        tabManager.closeTab(tabId);
        return `Closed tab ${tabId}`;
      }),
  );

  server.registerTool(
    "list_groups",
    {
      title: "List Tab Groups",
      description:
        "List all tab groups with their IDs, names, colors, collapsed state, and member tab count.",
    },
    async () => {
      const groups = tabManager.getGroups();
      const tabs = tabManager.getAllStates();
      if (groups.length === 0) {
        return asTextResponse("No tab groups");
      }
      const lines = groups.map((g) => {
        const count = tabs.filter((t) => t.groupId === g.id).length;
        return `[${g.id}] ${g.name} — color:${g.color} collapsed:${g.collapsed} tabs:${count}`;
      });
      return asTextResponse(lines.join("\n"));
    },
  );

  server.registerTool(
    "create_group",
    {
      title: "Create Tab Group",
      description:
        "Create a new tab group from the active tab or a specified tab. Optionally provide a name and color.",
      inputSchema: {
        tabId: z
          .string()
          .optional()
          .describe("Tab ID to group (defaults to active tab)"),
        name: z.string().optional().describe("Optional group name"),
        color: z
          .enum(["blue", "green", "yellow", "orange", "red", "purple", "gray"])
          .optional()
          .describe("Optional group color"),
      },
    },
    async ({ tabId, name, color }) =>
      withAction(runtime, tabManager, "create_group", { tabId, name, color }, async () => {
        const targetId = tabId || tabManager.getActiveTabId();
        if (!targetId) {
          return "Error: No active tab";
        }
        const groupId = tabManager.createGroupFromTab(targetId, {
          name: name || undefined,
          color: color || undefined,
        });
        if (!groupId) {
          return "Error: Could not create group";
        }
        return `Created group ${groupId}`;
      }),
  );

  server.registerTool(
    "assign_to_group",
    {
      title: "Assign Tab to Group",
      description:
        "Move a tab into an existing group by ID. Defaults to the active tab.",
      inputSchema: {
        groupId: z.string().describe("Group ID to assign the tab to"),
        tabId: z
          .string()
          .optional()
          .describe("Tab ID to move (defaults to active tab)"),
      },
    },
    async ({ groupId, tabId }) =>
      withAction(runtime, tabManager, "assign_to_group", { groupId, tabId }, async () => {
        const targetId = tabId || tabManager.getActiveTabId();
        if (!targetId) {
          return "Error: No active tab";
        }
        tabManager.assignTabToGroup(targetId, groupId);
        return `Assigned tab ${targetId} to group ${groupId}`;
      }),
  );

  server.registerTool(
    "remove_from_group",
    {
      title: "Remove Tab from Group",
      description: "Ungroup a tab. Defaults to the active tab.",
      inputSchema: {
        tabId: z
          .string()
          .optional()
          .describe("Tab ID to ungroup (defaults to active tab)"),
      },
    },
    async ({ tabId }) =>
      withAction(runtime, tabManager, "remove_from_group", { tabId }, async () => {
        const targetId = tabId || tabManager.getActiveTabId();
        if (!targetId) {
          return "Error: No active tab";
        }
        tabManager.removeTabFromGroup(targetId);
        return `Removed tab ${targetId} from group`;
      }),
  );

  server.registerTool(
    "toggle_group",
    {
      title: "Toggle Group Collapsed",
      description: "Collapse or expand a tab group.",
      inputSchema: {
        groupId: z.string().describe("Group ID to toggle"),
      },
    },
    async ({ groupId }) =>
      withAction(runtime, tabManager, "toggle_group", { groupId }, async () => {
        const collapsed = tabManager.toggleGroupCollapsed(groupId);
        if (collapsed === null) {
          return "Error: Group not found";
        }
        return collapsed ? `Collapsed group ${groupId}` : `Expanded group ${groupId}`;
      }),
  );

  server.registerTool(
    "set_group_color",
    {
      title: "Set Group Color",
      description: "Change the color of a tab group.",
      inputSchema: {
        groupId: z.string().describe("Group ID"),
        color: z
          .enum(["blue", "green", "yellow", "orange", "red", "purple", "gray"])
          .describe("New color"),
      },
    },
    async ({ groupId, color }) =>
      withAction(runtime, tabManager, "set_group_color", { groupId, color }, async () => {
        tabManager.setGroupColor(groupId, color as TabGroupColor);
        return `Set group ${groupId} color to ${color}`;
      }),
  );

  server.registerTool(
    "checkpoint_create",
    {
      title: "Create Checkpoint",
      description: "Capture the current session as a named checkpoint.",
      inputSchema: {
        name: z.string().optional().describe("Optional checkpoint name"),
        note: z.string().optional().describe("Optional note"),
      },
    },
    async ({ name, note }) =>
      withAction(
        runtime,
        tabManager,
        "create_checkpoint",
        { name, note },
        async () => {
          const checkpoint = runtime.createCheckpoint(name, note);
          return `Created checkpoint ${checkpoint.name} (${checkpoint.id})`;
        },
      ),
  );


  server.registerTool(
    "checkpoint_restore",
    {
      title: "Restore Checkpoint",
      description: "Restore a saved checkpoint by ID or exact name.",
      inputSchema: {
        checkpointId: z.string().optional().describe("Checkpoint ID"),
        name: z.string().optional().describe("Exact checkpoint name"),
      },
    },
    async ({ checkpointId, name }) =>
      withAction(
        runtime,
        tabManager,
        "restore_checkpoint",
        { checkpointId, name },
        async () => {
          const state = runtime.getState();
          const checkpoint =
            state.checkpoints.find((item) => item.id === checkpointId) ||
            state.checkpoints.find((item) => item.name === name);
          if (!checkpoint) {
            return "Error: No matching checkpoint found";
          }
          runtime.restoreCheckpoint(checkpoint.id);
          return `Restored checkpoint ${checkpoint.name}`;
        },
      ),
  );


  server.registerTool(
    "save_session",
    {
      title: "Save Session",
      description:
        "Persist the current cookies, localStorage, and tab layout under a reusable session name.",
      inputSchema: {
        name: z.string().describe("Session name such as github-logged-in"),
      },
    },
    async ({ name }) =>
      withAction(runtime, tabManager, "save_session", { name }, async () => {
        const saved = await namedSessionManager.saveNamedSession(
          tabManager,
          name,
        );
        return `Saved session "${saved.name}" (${saved.cookieCount} cookies, ${saved.originCount} localStorage origins)`;
      }),
  );

  server.registerTool(
    "load_session",
    {
      title: "Load Session",
      description:
        "Load a previously saved named session, restoring cookies, localStorage, and saved tabs.",
      inputSchema: {
        name: z.string().describe("Previously saved session name"),
      },
    },
    async ({ name }) =>
      withAction(runtime, tabManager, "load_session", { name }, async () => {
        const loaded = await namedSessionManager.loadNamedSession(
          tabManager,
          name,
        );
        return `Loaded session "${loaded.name}" (${loaded.cookieCount} cookies, ${loaded.originCount} localStorage origins)`;
      }),
  );

  server.registerTool(
    "list_sessions",
    {
      title: "List Sessions",
      description:
        "List previously saved named browser sessions with cookie and storage counts.",
    },
    async () =>
      withAction(runtime, tabManager, "list_sessions", {}, async () => {
        const sessions = namedSessionManager.listNamedSessions();
        if (sessions.length === 0) return "No saved sessions";
        return sessions
          .map(
            (item) =>
              `- ${item.name} | updated=${item.updatedAt} | cookies=${item.cookieCount} | origins=${item.originCount}${item.domains.length ? ` | domains=${item.domains.slice(0, 6).join(", ")}${item.domains.length > 6 ? ", ..." : ""}` : ""}`,
          )
          .join("\n");
      }),
  );

  server.registerTool(
    "delete_session",
    {
      title: "Delete Session",
      description: "Delete a previously saved named browser session.",
      inputSchema: {
        name: z.string().describe("Saved session name to delete"),
      },
    },
    async ({ name }) =>
      withAction(runtime, tabManager, "delete_session", { name }, async () =>
        namedSessionManager.deleteNamedSession(name)
          ? `Deleted session "${name}"`
          : `Session "${name}" not found`,
      ),
  );

  server.registerTool(
    "screenshot",
    {
      title: "Screenshot",
      description:
        "Capture a screenshot of the current page. Returns a base64-encoded PNG image.",
    },
    async () => {
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
    "highlight",
    {
      title: "Highlight Element",
      description:
        "Visually highlight an element or text on the page for the user. Use to draw attention to specific parts of the page. Highlights persist until cleared. Set persist=true to save the highlight so it re-appears when the user revisits this page.",
      inputSchema: {
        index: z
          .number()
          .optional()
          .describe("Element index from extracted content to highlight"),
        selector: z
          .string()
          .optional()
          .describe("CSS selector of element to highlight"),
        text: normalizedOptionalStringSchema().describe(
          "Text to find and highlight on the page (highlights all occurrences)",
        ),
        label: z
          .string()
          .optional()
          .describe("Optional annotation label to display near the highlight"),
        durationMs: z
          .number()
          .optional()
          .describe(
            "Auto-clear after this many milliseconds (omit for permanent)",
          ),
        persist: z
          .boolean()
          .optional()
          .describe(
            "If true, save this highlight so it re-appears automatically when the user revisits the page. Ignored when durationMs is set.",
          ),
        color: z
          .enum(["yellow", "red", "green", "blue", "purple", "orange"])
          .optional()
          .describe(
            "Highlight color. Use red for problems/errors, green for targets/success, blue for informational, purple for important, orange for warnings. Defaults to yellow.",
          ),
      },
    },
    async ({ index, selector, text, label, durationMs, persist, color }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      const normalizedText = normalizeLooseString(text);
      return withAction(
        runtime,
        tabManager,
        "highlight",
        {
          index,
          selector,
          text: normalizedText,
          label,
          durationMs,
          persist,
          color,
        },
        async () => {
          const wc = tab.view.webContents;
          const resolvedSelector = await resolveSelector(wc, index, selector);
          const result = await highlightOnPage(
            wc,
            resolvedSelector,
            normalizedText,
            label,
            durationMs,
            color,
          );

          if (
            persist &&
            !durationMs &&
            !result.startsWith("Error") &&
            !result.includes("not found")
          ) {
            const url = highlightsManager.normalizeUrl(wc.getURL());
            highlightsManager.addHighlight(
              url,
              resolvedSelector ?? undefined,
              normalizedText,
              label,
              color,
              "agent",
            );
          }

          return result;
        },
      );
    },
  );

  server.registerTool(
    "clear_highlights",
    {
      title: "Clear Highlights",
      description:
        "Remove all visual highlights from the current page, including any saved persistent highlights for this URL.",
    },
    async () => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "clear_highlights",
        {},
        async () => {
          const wc = tab.view.webContents;
          const url = highlightsManager.normalizeUrl(wc.getURL());
          highlightsManager.clearHighlightsForUrl(url);
          return clearHighlights(wc);
        },
      );
    },
  );

  server.registerTool(
    "list_highlights",
    {
      title: "List Highlights",
      description:
        "List highlights related to the current browsing session. Includes saved persistent highlights plus the active tab's live text selection and any visible unsaved highlight marks. IMPORTANT: When the user says they highlighted or selected text, call this tool before falling back to screenshots or vision.",
      inputSchema: {
        url: z
          .string()
          .optional()
          .describe(
            "URL to list highlights for. Omit to see active tab highlights first, then all others.",
          ),
      },
    },
    async ({ url }) => {
      const state = highlightsManager.getState();
      const activeTab = tabManager.getActiveTab();
      const activeUrl = activeTab
        ? highlightsManager.normalizeUrl(activeTab.view.webContents.getURL())
        : null;
      const activeSavedHighlights = activeUrl
        ? state.highlights.filter((highlight) => highlight.url === activeUrl)
        : [];
      const liveSnapshot =
        activeTab && activeUrl
          ? await captureLiveHighlightSnapshot(
              activeTab.view.webContents,
              activeSavedHighlights,
            )
          : { pageHighlights: [] };
      const unsavedLiveHighlights = liveSnapshot.pageHighlights.filter(
        (highlight) => !highlight.persisted,
      );

      if (url) {
        const filtered = state.highlights.filter(
          (h) => h.url === highlightsManager.normalizeUrl(url),
        );
        const normalizedUrl = highlightsManager.normalizeUrl(url);
        const sections: string[] = [];
        if (activeUrl && activeUrl === normalizedUrl) {
          if (liveSnapshot.activeSelection) {
            sections.push(
              `## Active selection (${activeUrl})\n${JSON.stringify(liveSnapshot.activeSelection, null, 2)}`,
            );
          }
          if (unsavedLiveHighlights.length > 0) {
            sections.push(
              `## Visible unsaved highlights (${activeUrl})\n${JSON.stringify(unsavedLiveHighlights, null, 2)}`,
            );
          }
        }
        if (filtered.length > 0) {
          sections.push(
            `## Saved highlights (${normalizedUrl})\n${JSON.stringify(filtered, null, 2)}`,
          );
        }
        if (sections.length === 0) {
          return asTextResponse(`No highlights or active selection for ${url}`);
        }
        return asTextResponse(sections.join("\n\n"));
      }

      // No URL filter — show active tab's highlights prominently first
      const activeHighlights = activeSavedHighlights;
      const otherHighlights = activeUrl
        ? state.highlights.filter((h) => h.url !== activeUrl)
        : state.highlights;

      const sections: string[] = [];

      if (liveSnapshot.activeSelection) {
        sections.push(
          `## Active selection (${activeUrl})\n${JSON.stringify(liveSnapshot.activeSelection, null, 2)}`,
        );
      }

      if (unsavedLiveHighlights.length > 0) {
        sections.push(
          `## Visible unsaved highlights on active tab (${activeUrl})\n${JSON.stringify(unsavedLiveHighlights, null, 2)}`,
        );
      }

      if (activeHighlights.length > 0) {
        sections.push(
          `## Saved highlights on active tab (${activeUrl})\n${JSON.stringify(activeHighlights, null, 2)}`,
        );
      } else if (activeUrl) {
        sections.push(
          `## Active tab (${activeUrl})\nNo saved highlights on this page.`,
        );
      }

      if (otherHighlights.length > 0) {
        sections.push(
          `## Other saved highlights\n${JSON.stringify(otherHighlights, null, 2)}`,
        );
      }

      if (sections.length === 0) {
        return asTextResponse("No saved or live highlights");
      }

      return asTextResponse(sections.join("\n\n"));
    },
  );

  server.registerTool(
    "remove_highlight",
    {
      title: "Remove Persistent Highlight",
      description:
        "Remove a persistent highlight by ID and clear it from any open tab. Use list_highlights to find IDs.",
      inputSchema: {
        id: z.string().describe("ID of the highlight to remove"),
      },
    },
    async ({ id }) => {
      const removed = highlightsManager.removeHighlight(id);
      if (!removed) {
        return asTextResponse(`No highlight found with id ${id}`);
      }

      // Clear visual highlights and re-apply remaining ones on matching tabs
      const remaining = highlightsManager.getHighlightsForUrl(removed.url);
      for (const tabState of tabManager.getAllStates()) {
        if (highlightsManager.normalizeUrl(tabState.url) !== removed.url) {
          continue;
        }
        const tab = tabManager.getTab(tabState.id);
        if (!tab) continue;
        const wc = tab.view.webContents;
        await clearHighlights(wc);
        for (const h of remaining) {
          if (!h.selector && !h.text) continue;
          void highlightOnPage(
            wc,
            h.selector ?? null,
            h.text,
            h.label,
            undefined,
            h.color,
          ).catch((err) =>
            logger.warn("Failed to restore highlight after removal:", err),
          );
        }
      }

      return asTextResponse(`Removed highlight ${id}`);
    },
  );

  // --- Bookmark tools ---

  server.registerTool(
    "create_folder",
    {
      title: "Create Bookmark Folder",
      description:
        "Create a named folder for organizing bookmarks. If a folder with the same name already exists, return it instead of duplicating it.",
      inputSchema: {
        name: z.string().describe("Name for the new folder"),
        summary: z
          .string()
          .optional()
          .describe("Optional one-sentence summary shown in the UI"),
      },
    },
    async ({ name, summary }) => {
      return withAction(
        runtime,
        tabManager,
        "create_bookmark_folder",
        { name, summary },
        async () => {
          const existing = bookmarkManager.findFolderByName(name);
          if (existing) {
            return composeFolderAwareResponse(
              `Folder "${existing.name}" already exists (id=${existing.id})`,
            );
          }

          const folder = bookmarkManager.createFolderWithSummary(name, summary);
          return composeFolderAwareResponse(
            `Created folder "${folder.name}" (id=${folder.id})`,
          );
        },
      );
    },
  );

  server.registerTool(
    "bookmark_save",
    {
      title: "Save Bookmark",
      description:
        "Save the current page, a specific URL, or a link target from the current page into a bookmark folder. You can provide folder_id or folder_name; missing folder names can be created automatically.",
      inputSchema: {
        url: z
          .string()
          .optional()
          .describe(
            "URL to bookmark. Omit to use the current page or provide index/selector to bookmark a link target from the page",
          ),
        title: z
          .string()
          .optional()
          .describe(
            "Human-readable title for the bookmark. Omit to use the page or link text",
          ),
        index: z
          .number()
          .optional()
          .describe(
            "Element index of a link on the current page to bookmark without opening it",
          ),
        selector: z
          .string()
          .optional()
          .describe(
            "CSS selector of a link on the current page to bookmark without opening it",
          ),
        folder_id: z
          .string()
          .optional()
          .describe("Folder ID to save into (omit for Unsorted)"),
        folder_name: z
          .string()
          .optional()
          .describe(
            "Folder name to save into. Created automatically if missing",
          ),
        folder_summary: z
          .string()
          .optional()
          .describe("Optional one-sentence summary if a new folder is created"),
        create_folder_if_missing: z
          .boolean()
          .optional()
          .describe("Create folder_name automatically when it does not exist"),
        note: z
          .string()
          .optional()
          .describe("Optional note about why this was bookmarked"),
        on_duplicate: z
          .enum(["ask", "update", "duplicate"])
          .optional()
          .describe(
            'How to handle an existing bookmark with the same URL in the same folder: "ask" (default), "update", or "duplicate"',
          ),
        intent: z
          .string()
          .optional()
          .describe(
            "Human-readable description of what this bookmark is for",
          ),
        expected_content: z
          .string()
          .optional()
          .describe(
            "Brief description of the content the agent should expect to find here",
          ),
        key_fields: z
          .array(z.string())
          .optional()
          .describe("Important form field names for this page"),
        agent_hints: z
          .record(z.string(), z.string())
          .optional()
          .describe("Arbitrary key-value hints for the agent"),
      },
    },
    async ({
      url,
      title,
      index,
      selector,
      folder_id,
      folder_name,
      folder_summary,
      create_folder_if_missing,
      note,
      on_duplicate,
      intent,
      expected_content,
      key_fields,
      agent_hints,
    }) => {
      return withAction(
        runtime,
        tabManager,
        "save_bookmark",
        {
          url,
          title,
          index,
          selector,
          folder_id,
          folder_name,
          folder_summary,
          create_folder_if_missing,
          note,
          intent,
          expected_content,
          key_fields,
          agent_hints,
        },
        async () => {
          const currentTab = tabManager.getActiveTab();
          const resolvedSelector =
            currentTab &&
            (typeof index === "number" || typeof selector === "string")
              ? await resolveSelector(
                  currentTab.view.webContents,
                  index,
                  selector,
                )
              : null;
          const source = await resolveBookmarkSourceDraft(
            currentTab?.view.webContents,
            {
              explicitUrl: url,
              explicitTitle: title,
              resolvedSelector,
            },
          );
          if ("error" in source) return `Error: ${source.error}`;

          const target = resolveBookmarkFolderTarget({
            folder_id,
            folder_name,
            folder_summary,
            create_folder_if_missing,
          });
          if (target.error) return target.error;

          const result = bookmarkManager.saveBookmarkWithPolicy(
            source.url,
            source.title,
            target.folderId,
            note,
            {
              onDuplicate: on_duplicate ?? "ask",
              extra: getBookmarkMetadataFromArgs({
                intent,
                expected_content,
                key_fields,
                agent_hints,
              }),
            },
          );
          if (result.status === "conflict" && result.existing) {
            return composeFolderAwareResponse(
              composeDuplicateBookmarkResponse({
                url: source.url,
                folderName: describeFolder(target.folderId),
                bookmarkId: result.existing.id,
              }),
              target.createdFolder,
            );
          }

          const bookmark = result.bookmark;
          if (!bookmark) {
            return "Error: Bookmark save failed";
          }

          const verb = result.status === "updated" ? "Updated" : "Saved";
          return composeFolderAwareResponse(
            `${verb} "${bookmark.title}" (${bookmark.url}) in "${describeFolder(bookmark.folderId)}" (id=${bookmark.id})`,
            target.createdFolder,
          );
        },
      );
    },
  );

  server.registerTool(
    "bookmark_list",
    {
      title: "List Bookmarks",
      description:
        "List all bookmark folders and their contents. Optionally filter by folder.",
      inputSchema: {
        folder_id: z
          .string()
          .optional()
          .describe("Filter to a specific folder ID (omit for all)"),
        folder_name: z
          .string()
          .optional()
          .describe("Filter to a specific folder name (omit for all)"),
      },
    },
    async ({ folder_id, folder_name }) => {
      return withAction(
        runtime,
        tabManager,
        "list_bookmarks",
        { folder_id, folder_name },
        async () => {
          const state = bookmarkManager.getState();
          const resolvedFolderId =
            folder_id ||
            (typeof folder_name === "string" && folder_name.trim()
              ? (bookmarkManager.findFolderByName(folder_name)?.id ?? "")
              : "");
          if (folder_name && !resolvedFolderId) {
            return `Folder "${folder_name}" not found`;
          }

          const folders = [
            { id: "unsorted", name: "Unsorted" },
            ...state.folders,
          ];
          const lines: string[] = [];
          for (const folder of folders) {
            if (resolvedFolderId && folder.id !== resolvedFolderId) continue;
            const items = state.bookmarks.filter(
              (b) => b.folderId === folder.id,
            );
            lines.push(
              `\n[${folder.name}] (id=${folder.id}, ${items.length} items)`,
            );
            if ("summary" in folder && typeof folder.summary === "string") {
              lines.push(`  summary: ${folder.summary}`);
            }
            for (const b of items) {
              lines.push(
                `  - ${b.title} | ${b.url} | id=${b.id}${b.note ? ` | note: ${b.note}` : ""}`,
              );
            }
          }
          return lines.length
            ? lines.join("\n").trim()
            : "No bookmarks saved yet.";
        },
      );
    },
  );

  server.registerTool(
    "bookmark_organize",
    {
      title: "Organize Bookmark",
      description:
        "Organize a bookmark by intent: save or move a bookmark into a folder, creating the folder if needed. Works with bookmark_id, url, a link target from the current page, or the current page itself.",
      inputSchema: {
        bookmark_id: z
          .string()
          .optional()
          .describe("Existing bookmark ID to move or update"),
        url: z
          .string()
          .optional()
          .describe(
            "URL to organize. Omit to use the current page or provide index/selector to target a link",
          ),
        title: z
          .string()
          .optional()
          .describe("Optional title when saving a new bookmark"),
        index: z
          .number()
          .optional()
          .describe(
            "Element index of a link on the current page to organize without opening it",
          ),
        selector: z
          .string()
          .optional()
          .describe(
            "CSS selector of a link on the current page to organize without opening it",
          ),
        folder_id: z.string().optional().describe("Folder ID to organize into"),
        folder_name: z
          .string()
          .optional()
          .describe("Folder name to organize into"),
        folder_summary: z
          .string()
          .optional()
          .describe("Optional summary used if a new folder is created"),
        create_folder_if_missing: z
          .boolean()
          .optional()
          .describe("Create folder_name automatically when it does not exist"),
        note: z
          .string()
          .optional()
          .describe("Optional note to attach or update on the bookmark"),
        archive: z
          .boolean()
          .optional()
          .describe('If true, organize into the default "Archive" folder'),
        intent: z
          .string()
          .optional()
          .describe("Human-readable description of what this bookmark is for"),
        expected_content: z
          .string()
          .optional()
          .describe("Brief description of content the agent should expect"),
        key_fields: z
          .array(z.string())
          .optional()
          .describe("Important form field names for this page"),
        agent_hints: z
          .record(z.string(), z.string())
          .optional()
          .describe("Arbitrary key-value hints for the agent"),
      },
    },
    async (args) => {
      return withAction(
        runtime,
        tabManager,
        "organize_bookmark",
        args,
        async () => {
          const target = resolveBookmarkFolderTarget(args);
          if (target.error) return target.error;

          const bookmarkId =
            typeof args.bookmark_id === "string" ? args.bookmark_id.trim() : "";
          const currentTab = tabManager.getActiveTab();
          const note =
            typeof args.note === "string" && args.note.trim()
              ? args.note.trim()
              : undefined;
          const resolvedSelector =
            currentTab &&
            (typeof args.index === "number" ||
              typeof args.selector === "string")
              ? await resolveSelector(
                  currentTab.view.webContents,
                  args.index,
                  args.selector,
                )
              : null;
          const source = await resolveBookmarkSourceDraft(
            currentTab?.view.webContents,
            {
              explicitUrl: args.url,
              explicitTitle: args.title,
              resolvedSelector,
            },
          );

          const existing = bookmarkId
            ? bookmarkManager.getBookmark(bookmarkId)
            : "error" in source
              ? undefined
              : bookmarkManager.getBookmarkByUrl(source.url);
          if (bookmarkId && !existing) {
            return `Bookmark ${bookmarkId} not found`;
          }

          if (existing) {
            const updated = bookmarkManager.updateBookmark(existing.id, {
              folderId: target.folderId,
              title:
                typeof args.title === "string" && args.title.trim()
                  ? args.title.trim()
                  : undefined,
              note,
              ...getBookmarkMetadataFromArgs(args),
            });
            if (!updated) {
              return `Bookmark ${existing.id} not found`;
            }
            return composeFolderAwareResponse(
              `Organized existing bookmark "${updated.title}" into "${describeFolder(updated.folderId)}" (id=${updated.id})`,
              target.createdFolder,
            );
          }

          if ("error" in source) return `Error: ${source.error}`;

          const result = bookmarkManager.saveBookmarkWithPolicy(
            source.url,
            source.title,
            target.folderId,
            note,
            {
              onDuplicate: "update",
              extra: getBookmarkMetadataFromArgs(args),
            },
          );
          const bookmark = result.bookmark;
          if (!bookmark) return "Error: Bookmark save failed";
          return composeFolderAwareResponse(
            `Saved and organized "${bookmark.title}" (${bookmark.url}) into "${describeFolder(bookmark.folderId)}" (id=${bookmark.id})`,
            target.createdFolder,
          );
        },
      );
    },
  );

  server.registerTool(
    "bookmark_search",
    {
      title: "Search Bookmarks",
      description:
        "Search bookmarks by title, URL, note, folder name, or folder summary.",
      inputSchema: {
        query: z.string().describe("Search term to match against bookmarks"),
      },
    },
    async ({ query }) => {
      return withAction(
        runtime,
        tabManager,
        "search_bookmarks",
        { query },
        async () => {
          const matches = bookmarkManager.searchBookmarks(query);
          if (matches.length === 0) {
            return `No bookmarks matched "${query}"`;
          }

          const lines = matches.map(({ bookmark, folder, matchedFields }) => {
            const folderLabel =
              bookmark.folderId === "unsorted"
                ? "Unsorted"
                : (folder?.name ?? bookmark.folderId);
            return `- ${bookmark.title} | ${bookmark.url} | folder=${folderLabel} | matched=${matchedFields.join(",")} | id=${bookmark.id}${bookmark.note ? ` | note: ${bookmark.note}` : ""}`;
          });
          return [`Matches for "${query}" (${matches.length})`, ...lines].join(
            "\n",
          );
        },
      );
    },
  );

  server.registerTool(
    "bookmark_remove",
    {
      title: "Remove Bookmark",
      description: "Remove a specific bookmark by its ID.",
      inputSchema: {
        bookmark_id: z.string().describe("ID of the bookmark to remove"),
      },
    },
    async ({ bookmark_id }) => {
      return withAction(
        runtime,
        tabManager,
        "remove_bookmark",
        { bookmark_id },
        async () => {
          const removed = bookmarkManager.removeBookmark(bookmark_id);
          return removed
            ? `Removed bookmark ${bookmark_id}`
            : `Bookmark ${bookmark_id} not found`;
        },
      );
    },
  );

  server.registerTool(
    "bookmark_archive",
    {
      title: "Archive Bookmark",
      description:
        'Archive the current page, a URL, a link target from the current page, or an existing bookmark into the default "Archive" folder.',
      inputSchema: {
        bookmark_id: z
          .string()
          .optional()
          .describe("Existing bookmark ID to archive"),
        url: z
          .string()
          .optional()
          .describe(
            "URL to archive. Omit to use the current page or provide index/selector to target a link",
          ),
        title: z
          .string()
          .optional()
          .describe("Optional title when saving a new archived bookmark"),
        index: z
          .number()
          .optional()
          .describe(
            "Element index of a link on the current page to archive without opening it",
          ),
        selector: z
          .string()
          .optional()
          .describe(
            "CSS selector of a link on the current page to archive without opening it",
          ),
        note: z
          .string()
          .optional()
          .describe("Optional note to store with the archived bookmark"),
      },
    },
    async ({ bookmark_id, url, title, index, selector, note }) => {
      return withAction(
        runtime,
        tabManager,
        "archive_bookmark",
        { bookmark_id, url, title, index, selector, note },
        async () => {
          const currentTab = tabManager.getActiveTab();
          const trimmedBookmarkId =
            typeof bookmark_id === "string" ? bookmark_id.trim() : "";
          const trimmedNote =
            typeof note === "string" && note.trim() ? note.trim() : undefined;
          const target = resolveBookmarkFolderTarget({ archive: true });
          if (target.error) return target.error;
          const resolvedSelector =
            currentTab &&
            (typeof index === "number" || typeof selector === "string")
              ? await resolveSelector(
                  currentTab.view.webContents,
                  index,
                  selector,
                )
              : null;
          const source = await resolveBookmarkSourceDraft(
            currentTab?.view.webContents,
            {
              explicitUrl: url,
              explicitTitle: title,
              resolvedSelector,
            },
          );

          const existing = trimmedBookmarkId
            ? bookmarkManager.getBookmark(trimmedBookmarkId)
            : "error" in source
              ? undefined
              : bookmarkManager.getBookmarkByUrl(source.url);
          if (trimmedBookmarkId && !existing) {
            return `Bookmark ${trimmedBookmarkId} not found`;
          }

          if (existing) {
            const updated = bookmarkManager.updateBookmark(existing.id, {
              folderId: target.folderId,
              title:
                typeof title === "string" && title.trim()
                  ? title.trim()
                  : undefined,
              note: trimmedNote,
            });
            if (!updated) {
              return `Bookmark ${existing.id} not found`;
            }
            return composeFolderAwareResponse(
              `Archived bookmark "${updated.title}" into "${describeFolder(updated.folderId)}" (id=${updated.id})`,
              target.createdFolder,
            );
          }

          if ("error" in source) {
            return `Error: ${source.error}`;
          }

          const bookmark = bookmarkManager.saveBookmark(
            source.url,
            source.title,
            target.folderId,
            trimmedNote,
            undefined,
            undefined,
            undefined,
            undefined,
          );
          return composeFolderAwareResponse(
            `Saved and archived "${bookmark.title}" (${bookmark.url}) into "${describeFolder(bookmark.folderId)}" (id=${bookmark.id})`,
            target.createdFolder,
          );
        },
      );
    },
  );

  server.registerTool(
    "bookmark_open",
    {
      title: "Open Bookmark",
      description:
        "Open a saved bookmark by bookmark ID. Optionally open it in a new tab.",
      inputSchema: {
        bookmark_id: z.string().describe("ID of the bookmark to open"),
        new_tab: z
          .boolean()
          .optional()
          .describe("Open the bookmark in a new tab"),
      },
    },
    async ({ bookmark_id, new_tab }) => {
      return withAction(
        runtime,
        tabManager,
        "open_bookmark",
        { bookmark_id, new_tab },
        async () => {
          const bookmark = bookmarkManager.getBookmark(bookmark_id);
          if (!bookmark) {
            return `Bookmark ${bookmark_id} not found`;
          }

          const validation = await validateLinkDestination(bookmark.url);
          if (validation.status === "dead") {
            return formatDeadLinkMessage(bookmark.title, validation);
          }

          if (new_tab || !tabManager.getActiveTabId()) {
            const createdId = tabManager.createTab(bookmark.url);
            const created = tabManager.getActiveTab();
            if (created) {
              await waitForLoad(created.view.webContents);
            }
            return `Opened bookmark "${bookmark.title}" in new tab ${createdId}`;
          }

          const activeId = tabManager.getActiveTabId()!;
          const activeTab = tabManager.getActiveTab();
          tabManager.navigateTab(activeId, bookmark.url);
          if (activeTab) {
            await waitForLoad(activeTab.view.webContents);
          }
          return `Opened bookmark "${bookmark.title}" in current tab`;
        },
      );
    },
  );

  server.registerTool(
    "folder_remove",
    {
      title: "Remove Bookmark Folder",
      description:
        "Remove a folder. By default bookmarks in it are moved to Unsorted. Set delete_contents to true to delete them with the folder.",
      inputSchema: {
        folder_id: z.string().describe("ID of the folder to remove"),
        delete_contents: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If true, delete all bookmarks in the folder. If false (default), move them to Unsorted.",
          ),
      },
    },
    async ({ folder_id, delete_contents }) => {
      return withAction(
        runtime,
        tabManager,
        "remove_bookmark_folder",
        { folder_id, delete_contents },
        async () => {
          const removed = bookmarkManager.removeFolder(
            folder_id,
            delete_contents,
          );
          if (!removed) return `Folder ${folder_id} not found`;
          return composeFolderAwareResponse(
            delete_contents
              ? `Removed folder ${folder_id} and deleted its bookmarks.`
              : `Removed folder ${folder_id}. Bookmarks moved to Unsorted.`,
          );
        },
      );
    },
  );

  server.registerTool(
    "folder_rename",
    {
      title: "Rename Bookmark Folder",
      description: "Rename an existing bookmark folder.",
      inputSchema: {
        folder_id: z.string().describe("ID of the folder to rename"),
        new_name: z.string().describe("New name for the folder"),
        summary: z
          .string()
          .optional()
          .describe("Optional one-sentence summary for the folder"),
      },
    },
    async ({ folder_id, new_name, summary }) => {
      return withAction(
        runtime,
        tabManager,
        "rename_bookmark_folder",
        { folder_id, new_name, summary },
        async () => {
          const existing = bookmarkManager.findFolderByName(new_name);
          if (existing && existing.id !== folder_id) {
            return composeFolderAwareResponse(
              `Folder "${existing.name}" already exists (id=${existing.id})`,
            );
          }

          const folder = bookmarkManager.renameFolder(
            folder_id,
            new_name,
            summary,
          );
          return folder
            ? composeFolderAwareResponse(`Renamed folder to "${folder.name}"`)
            : `Folder ${folder_id} not found`;
        },
      );
    },
  );

  // --- Memory tools ---

  server.registerTool(
    "memory_note_create",
    {
      title: "Create Memory Note",
      description:
        "Write a markdown note into the configured Obsidian vault for research notes, breadcrumbs, or synthesis.",
      inputSchema: {
        title: z.string().describe("Title of the note"),
        body: z.string().describe("Markdown body for the note"),
        folder: z
          .string()
          .optional()
          .describe(
            "Relative folder inside the vault (default: Vessel/Research)",
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe("Optional tags to store in frontmatter"),
      },
    },
    async ({ title, body, folder, tags }) => {
      return withAction(
        runtime,
        tabManager,
        "memory_note_create",
        { title, folder, tags },
        async () => {
          const saved = writeMemoryNote({ title, body, folder, tags });
          return `Saved memory note "${saved.title}" to ${saved.relativePath}`;
        },
      );
    },
  );

  server.registerTool(
    "memory_append",
    {
      title: "Append Memory Note",
      description:
        "Append markdown content to an existing note in the configured Obsidian vault.",
      inputSchema: {
        note_path: z
          .string()
          .describe("Relative path to an existing note inside the vault"),
        content: z.string().describe("Markdown content to append"),
        heading: z
          .string()
          .optional()
          .describe("Optional section heading to add before the content"),
      },
    },
    async ({ note_path, content, heading }) => {
      return withAction(
        runtime,
        tabManager,
        "memory_note_append",
        { note_path, heading },
        async () => {
          const saved = appendToMemoryNote({
            notePath: note_path,
            content,
            heading,
          });
          return `Appended memory note at ${saved.relativePath}`;
        },
      );
    },
  );

  server.registerTool(
    "memory_list",
    {
      title: "List Memory Notes",
      description:
        "List recent markdown notes in the configured Obsidian vault.",
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe("Optional relative folder inside the vault"),
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe("Maximum number of notes to return"),
      },
    },
    async ({ folder, limit }) => {
      return withAction(
        runtime,
        tabManager,
        "memory_note_list",
        { folder, limit },
        async () => {
          const notes = listMemoryNotes({ folder, limit });
          if (notes.length === 0) {
            return "No memory notes found.";
          }
          return notes
            .map(
              (note) =>
                `- ${note.title} | path=${note.relativePath} | modified=${note.modifiedAt}${note.tags.length ? ` | tags=${note.tags.join(",")}` : ""}`,
            )
            .join("\n");
        },
      );
    },
  );

  server.registerTool(
    "memory_search",
    {
      title: "Search Memory Notes",
      description:
        "Search markdown notes in the configured Obsidian vault by title, path, body, and optional tags.",
      inputSchema: {
        query: z.string().describe("Search query"),
        folder: z
          .string()
          .optional()
          .describe("Optional relative folder inside the vault"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Optional tags that matching notes must contain"),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Maximum number of matching notes to return"),
      },
    },
    async ({ query, folder, tags, limit }) => {
      return withAction(
        runtime,
        tabManager,
        "memory_note_search",
        { query, folder, tags, limit },
        async () => {
          const notes = searchMemoryNotes({ query, folder, tags, limit });
          if (notes.length === 0) {
            return `No memory notes matched "${query}".`;
          }
          return notes
            .map(
              (note) =>
                `- ${note.title} | path=${note.relativePath} | modified=${note.modifiedAt}${note.tags.length ? ` | tags=${note.tags.join(",")}` : ""}`,
            )
            .join("\n");
        },
      );
    },
  );

  server.registerTool(
    "memory_page_capture",
    {
      title: "Capture Page To Memory",
      description:
        "Capture the current page into the configured Obsidian vault as a markdown note with URL, excerpt, and content snapshot.",
      inputSchema: {
        title: z.string().optional().describe("Optional note title override"),
        folder: z
          .string()
          .optional()
          .describe("Relative folder inside the vault (default: Vessel/Pages)"),
        summary: z
          .string()
          .optional()
          .describe("Optional summary written into the note"),
        note: z
          .string()
          .optional()
          .describe("Optional research note or breadcrumb"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Optional tags to store in frontmatter"),
      },
    },
    async ({ title, folder, summary, note, tags }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "memory_page_capture",
        { title, folder, tags },
        async () => {
          const page = await extractContent(tab.view.webContents);
          const saved = capturePageToVault({
            page,
            title,
            folder,
            summary,
            note,
            tags,
          });
          return `Captured page "${saved.title}" to ${saved.relativePath}`;
        },
      );
    },
  );

  server.registerTool(
    "memory_link_bookmark",
    {
      title: "Link Bookmark To Memory",
      description:
        "Create a note for a bookmark or append bookmark details into an existing memory note.",
      inputSchema: {
        bookmark_id: z.string().describe("Bookmark ID to link"),
        note_path: z
          .string()
          .optional()
          .describe("Existing relative note path to append into"),
        title: z
          .string()
          .optional()
          .describe("Optional title when creating a new note"),
        folder: z
          .string()
          .optional()
          .describe("Relative folder when creating a new note"),
        note: z
          .string()
          .optional()
          .describe(
            "Optional rationale or breadcrumb to store with the bookmark",
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe("Optional tags when creating a new note"),
      },
    },
    async ({ bookmark_id, note_path, title, folder, note, tags }) => {
      return withAction(
        runtime,
        tabManager,
        "memory_link_bookmark",
        { bookmark_id, note_path, title, folder, tags },
        async () => {
          const bookmark = bookmarkManager.getBookmark(bookmark_id);
          if (!bookmark) {
            return `Bookmark ${bookmark_id} not found`;
          }
          const saved = linkBookmarkToMemory({
            bookmark,
            notePath: note_path,
            title,
            folder,
            note,
            tags,
          });
          return `Linked bookmark "${bookmark.title}" to memory note ${saved.relativePath}`;
        },
      );
    },
  );

  // ═══════════════════════════════════════════════════════════════
  // Speedee System — Flow State & Composable Macros
  // ═══════════════════════════════════════════════════════════════

  server.registerTool(
    "flow_start",
    {
      title: "Start Workflow",
      description:
        "Begin tracking a multi-step web workflow. Vessel will show progress after every action so you always know where you are in the flow.",
      inputSchema: {
        goal: z
          .string()
          .describe(
            "What this workflow accomplishes (e.g. 'Purchase item from Amazon')",
          ),
        steps: stringArrayLikeSchema().describe(
          "Ordered list of step labels (e.g. ['Log in', 'Search', 'Select item', 'Checkout'])",
        ),
      },
    },
    async ({ goal, steps }) => {
      const normalizedSteps = coerceStringArray(steps) ?? [];
      const tab = tabManager.getActiveTab();
      const flow = runtime.startFlow(
        goal,
        normalizedSteps,
        tab?.view.webContents.getURL(),
      );
      return asTextResponse(
        `Flow started: ${flow.goal}\n${flow.steps.map((s, i) => `  ${i === 0 ? "→" : " "} ${s.label}`).join("\n")}`,
      );
    },
  );

  server.registerTool(
    "flow_advance",
    {
      title: "Advance Workflow Step",
      description:
        "Mark the current workflow step as done and move to the next one. Call this after completing each step.",
      inputSchema: {
        detail: z
          .string()
          .optional()
          .describe("Brief note about what was accomplished"),
      },
    },
    async ({ detail }) => {
      const flow = runtime.advanceFlow(detail);
      if (!flow) return asTextResponse("No active flow to advance");
      const ctx = runtime.getFlowContext();
      return asTextResponse(`Step completed.${ctx}`);
    },
  );

  server.registerTool(
    "flow_status",
    {
      title: "Workflow Status",
      description: "Check the current workflow progress.",
    },
    async () => {
      const flow = runtime.getFlowState();
      if (!flow) return asTextResponse("No active workflow.");
      return asTextResponse(runtime.getFlowContext());
    },
  );

  server.registerTool(
    "flow_end",
    {
      title: "End Workflow",
      description: "Clear the active workflow tracker.",
    },
    async () => {
      runtime.clearFlow();
      return asTextResponse("Workflow ended.");
    },
  );

  server.registerTool(
    "undo_last_action",
    {
      title: "Undo Last Action",
      description:
        "Undo the most recent agent action by restoring the browser to its state before that action ran. Works for click, type, submit, navigate, and similar mutating actions.",
    },
    async () => {
      const undone = runtime.undoLastAction();
      if (!undone)
        return asTextResponse(
          "Nothing to undo. No undo snapshots available.",
        );
      return asTextResponse(
        `Undid action: ${undone}. Browser restored to state before that action.`,
      );
    },
  );

  // --- Speedee Suggestion Engine ---

  server.registerTool(
    "suggest",
    {
      title: "What Should I Do?",
      description:
        "Analyze the current page and return the most relevant tools and suggested next actions. Call this when you're unsure what to do next — it reads the page context and tells you the optimal approach.",
    },
    async () => {
      const tab = tabManager.getActiveTab();
      if (!tab)
        return asTextResponse(
          "No active tab. Use navigate to open a page.",
        );

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

      // Flow context
      const flowCtx = runtime.getFlowContext();
      if (flowCtx) {
        suggestions.push(flowCtx);
        suggestions.push("");
      }

      // Page intent analysis
      const url = page.url.toLowerCase();
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

      // Priority suggestions
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

  // --- Composable Macros ---

  server.registerTool(
    "fill_form",
    {
      title: "Fill Form",
      description:
        "Fill multiple form fields at once. Provide a map of field identifiers to values. Fields are matched by index, name, label, or placeholder. Much faster than calling type for each field individually.",
      inputSchema: {
        fields: z
          .array(
            z.object({
              index: z
                .number()
                .optional()
                .describe("Element index from page content"),
              selector: z.string().optional().describe("CSS selector fallback"),
              name: z
                .string()
                .optional()
                .describe("Field name or id, such as custname"),
              label: z
                .string()
                .optional()
                .describe("Visible label or aria-label text"),
              placeholder: z
                .string()
                .optional()
                .describe("Placeholder text shown in the field"),
              value: z.string().describe("Value to enter"),
            }),
          )
          .describe(
            "Fields to fill, matched by index, selector, name, label, or placeholder",
          ),
        submit: z
          .boolean()
          .optional()
          .describe("Submit the form after filling (default false)"),
      },
    },
    async ({ fields, submit }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "fill_form",
        { fieldCount: fields.length, submit },
        async () => {
          const wc = tab.view.webContents;
          const fillResults = await fillFormFields(wc, fields);
          const results = fillResults.map((item) => item.result);
          if (submit) {
            // Find and submit the form containing the first field
            const firstSel =
              fillResults.find((item) => item.selector)?.selector ?? null;
            if (firstSel) {
              const beforeUrl = wc.getURL();
              const submitResult = await submitForm(wc, undefined, firstSel);
              await waitForPotentialNavigation(wc, beforeUrl);
              const afterUrl = wc.getURL();
              results.push(
                afterUrl !== beforeUrl
                  ? `Submitted → ${afterUrl}`
                  : submitResult,
              );
            }
          }
          return `Filled ${results.length} field(s):\n${results.join("\n")}`;
        },
      );
    },
  );

  server.registerTool(
    "login",
    {
      title: "Login",
      description:
        "Compound action: navigate to a login page, fill credentials, and submit. Handles the full login flow in one call.",
      inputSchema: {
        url: z
          .string()
          .optional()
          .describe("Login page URL (skip if already on login page)"),
        username: z.string().describe("Username or email"),
        password: z.string().describe("Password"),
        username_selector: z
          .string()
          .optional()
          .describe(
            "CSS selector for username field (auto-detected if omitted)",
          ),
        password_selector: z
          .string()
          .optional()
          .describe(
            "CSS selector for password field (auto-detected if omitted)",
          ),
        submit_selector: z
          .string()
          .optional()
          .describe(
            "CSS selector for submit button (auto-detected if omitted)",
          ),
      },
    },
    async ({
      url,
      username,
      password,
      username_selector,
      password_selector,
      submit_selector,
    }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "login",
        { url, username: username.slice(0, 3) + "***" },
        async () => {
          const wc = tab.view.webContents;
          const steps: string[] = [];

          // Step 1: Navigate if URL provided
          if (url) {
            const id = tabManager.getActiveTabId()!;
            tabManager.navigateTab(id, url);
            await waitForLoad(wc);
            steps.push(`Navigated to ${wc.getURL()}`);
          }

          // Step 2: Find form fields
          const userSel =
            username_selector ||
            (await wc.executeJavaScript(`
              (function() {
                var el = document.querySelector('input[type="email"], input[name="email"], input[name="username"], input[name="user"], input[autocomplete="username"], input[autocomplete="email"], input[type="text"]:not([name="search"]):not([name="q"])');
                return el ? (el.id ? '#' + CSS.escape(el.id) : el.name ? 'input[name="' + el.name + '"]' : null) : null;
              })()
            `));
          if (!userSel)
            return "Error: Could not find username/email field. Try providing username_selector.";

          const passSel =
            password_selector ||
            (await wc.executeJavaScript(`
              (function() {
                var el = document.querySelector('input[type="password"]');
                return el ? (el.id ? '#' + CSS.escape(el.id) : el.name ? 'input[name="' + el.name + '"]' : null) : null;
              })()
            `));
          if (!passSel)
            return "Error: Could not find password field. Try providing password_selector.";

          // Step 3: Fill credentials
          const userResult = await setElementValue(wc, userSel, username);
          steps.push(userResult);
          const passResult = await setElementValue(wc, passSel, password);
          steps.push(passResult);

          // Step 4: Submit
          const beforeUrl = wc.getURL();
          if (submit_selector) {
            await clickResolvedSelector(wc, submit_selector);
          } else {
            // Try to find and click a submit button
            const clicked = await wc.executeJavaScript(`
              (function() {
                var btn = document.querySelector('button[type="submit"], input[type="submit"], form button:not([type="button"])');
                if (btn) { btn.click(); return true; }
                var form = document.querySelector('input[type="password"]')?.closest('form');
                if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); return true; }
                return false;
              })()
            `);
            if (!clicked)
              return (
                steps.join("\n") +
                "\nWarning: Could not find submit button. Credentials filled but form not submitted."
              );
          }

          await waitForPotentialNavigation(wc, beforeUrl);
          const afterUrl = wc.getURL();
          steps.push(
            afterUrl !== beforeUrl
              ? `Submitted → ${afterUrl}`
              : "Form submitted (same page)",
          );

          return `Login flow complete:\n${steps.join("\n")}`;
        },
      );
    },
  );

  server.registerTool(
    "search",
    {
      title: "Search",
      description:
        "Compound action: find a search box on the current page, type a query, and submit. Returns the resulting page state.",
      inputSchema: {
        query: z.string().describe("Search query text"),
        selector: z
          .string()
          .optional()
          .describe("CSS selector for search input (auto-detected if omitted)"),
      },
    },
    async ({ query, selector }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();

      // Guard: reject queries that look like button/UI labels, not search terms
      const qLower = query.toLowerCase().trim();
      const buttonLabels = [
        "add to cart",
        "add to bag",
        "add to basket",
        "buy now",
        "buy it now",
        "purchase",
        "continue shopping",
        "keep shopping",
        "view cart",
        "view bag",
        "view basket",
        "go to cart",
        "go to checkout",
        "checkout",
        "check out",
        "proceed to checkout",
        "place order",
        "submit",
        "subscribe",
        "sign up",
        "sign in",
        "log in",
        "register",
        "continue",
      ];
      if (buttonLabels.some((p) => qLower.includes(p))) {
        return asTextResponse(
          `Error: "${query}" looks like a button label, not a search query. Use the click tool to interact with this element instead.`,
        );
      }

      return withAction(runtime, tabManager, "search", { query }, async () => {
        const wc = tab.view.webContents;

        // Find search input
        const searchSel =
          selector ||
          (await wc.executeJavaScript(`
              (function() {
                var el = document.querySelector('input[type="search"], input[name="q"], input[name="query"], input[name="search"], input[role="searchbox"], input[aria-label*="search" i], input[placeholder*="search" i]');
                if (!el) {
                  var inputs = document.querySelectorAll('input[type="text"]');
                  for (var i = 0; i < inputs.length; i++) {
                    var form = inputs[i].closest('form');
                    if (form && (form.getAttribute('role') === 'search' || form.action?.includes('search'))) {
                      el = inputs[i];
                      break;
                    }
                  }
                }
                return el ? (el.id ? '#' + CSS.escape(el.id) : el.name ? 'input[name="' + el.name + '"]' : null) : null;
              })()
            `));
        if (!searchSel)
          return "Error: Could not find search input. Try providing a selector.";

        // Type query
        await setElementValue(wc, searchSel, query);

        // Focus input and press Enter via native Chromium input events
        // (JS dispatchEvent doesn't work on sites like Google that use custom handlers)
        await wc.executeJavaScript(`
            (function() {
              var el = document.querySelector(${JSON.stringify(searchSel)});
              if (el) el.focus();
            })()
          `);
        await new Promise((r) => setTimeout(r, 50));
        const beforeUrl = wc.getURL();
        wc.sendInputEvent({ type: "keyDown", keyCode: "Return" });
        await new Promise((r) => setTimeout(r, 16));
        wc.sendInputEvent({ type: "keyUp", keyCode: "Return" });

        await waitForPotentialNavigation(wc, beforeUrl);
        const afterUrl = wc.getURL();
        return afterUrl !== beforeUrl
          ? `Searched "${query}" → ${afterUrl}`
          : `Searched "${query}" (same page — results may have loaded dynamically)`;
      });
    },
  );

  server.registerTool(
    "paginate",
    {
      title: "Paginate",
      description:
        "Navigate to the next or previous page of results. Auto-detects pagination controls.",
      inputSchema: {
        direction: z.enum(["next", "prev"]).describe("Pagination direction"),
        selector: z
          .string()
          .optional()
          .describe(
            "CSS selector for the pagination link (auto-detected if omitted)",
          ),
      },
    },
    async ({ direction, selector }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "paginate",
        { direction },
        async () => {
          const wc = tab.view.webContents;
          const beforeUrl = wc.getURL();

          if (selector) {
            return clickResolvedSelector(wc, selector);
          }

          // Auto-detect pagination
          const isNext = direction === "next";
          const clicked = await wc.executeJavaScript(`
            (function() {
              var patterns = ${
                isNext
                  ? '["next", "Next", "›", "»", "→", ">", "Next Page", "Load More"]'
                  : '["prev", "Prev", "Previous", "‹", "«", "←", "<", "Previous Page"]'
              };
              var links = document.querySelectorAll('a, button');
              for (var i = 0; i < links.length; i++) {
                var el = links[i];
                var text = (el.textContent || '').trim();
                var ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
                var rel = (el.getAttribute('rel') || '').toLowerCase();
                if (rel === '${isNext ? "next" : "prev"}') { el.click(); return true; }
                for (var j = 0; j < patterns.length; j++) {
                  if (text === patterns[j] || ariaLabel.includes(patterns[j].toLowerCase())) {
                    el.click();
                    return true;
                  }
                }
              }
              return false;
            })()
          `);

          if (!clicked)
            return `Error: Could not find ${direction} pagination control. Try providing a selector.`;

          await waitForPotentialNavigation(wc, beforeUrl);
          const afterUrl = wc.getURL();
          return afterUrl !== beforeUrl
            ? `Paginated ${direction} → ${afterUrl}`
            : `Clicked ${direction} (page may have updated dynamically)`;
        },
      );
    },
  );

  // --- Speedee: accept_cookies ---
  server.registerTool(
    "accept_cookies",
    {
      title: "Accept Cookies",
      description:
        "Dismiss cookie consent banners (OneTrust, CookieBot, GDPR popups, etc.).",
      inputSchema: z.object({}),
    },
    async () => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "accept_cookies",
        {},
        async () => {
          const wc = tab.view.webContents;
          const dismissed = await wc.executeJavaScript(`
            (function() {
              var selectors = [
                '#onetrust-accept-btn-handler',
                '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
                '[data-cookiefirst-action="accept"]',
                '.cookie-consent-accept-all',
                '#accept-cookies',
                '.cc-accept',
                '.cc-btn.cc-allow',
                '[aria-label="Accept cookies"]',
                '[aria-label="Accept all cookies"]',
                '[data-testid="cookie-accept"]',
              ];
              var textPatterns = ['accept all', 'accept cookies', 'allow all', 'allow cookies', 'agree', 'got it', 'ok', 'i agree', 'consent'];
              for (var i = 0; i < selectors.length; i++) {
                var el = document.querySelector(selectors[i]);
                if (el && el instanceof HTMLElement) { el.click(); return "Dismissed cookie banner via: " + selectors[i]; }
              }
              var buttons = document.querySelectorAll('button, a[role="button"], [type="submit"]');
              for (var j = 0; j < buttons.length; j++) {
                var btn = buttons[j];
                var text = (btn.textContent || '').trim().toLowerCase();
                for (var k = 0; k < textPatterns.length; k++) {
                  if (text === textPatterns[k] || text.startsWith(textPatterns[k])) {
                    btn.click();
                    return "Dismissed cookie banner via text match: " + text;
                  }
                }
              }
              return null;
            })()
          `);
          return (
            dismissed ||
            "No cookie consent banner detected. Try dismiss_popup for other overlays."
          );
        },
      );
    },
  );

  // --- Speedee: extract_table ---
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

  // --- Speedee: scroll_to_element ---
  server.registerTool(
    "scroll_to_element",
    {
      title: "Scroll To Element",
      description: "Scroll a specific element into view by index or selector.",
      inputSchema: z.object({
        index: z.number().optional().describe("Element index to scroll to"),
        selector: z.string().optional().describe("CSS selector to scroll to"),
        position: z
          .enum(["center", "top", "bottom"])
          .optional()
          .describe("Viewport position (default center)"),
      }),
    },
    async ({ index, selector: rawSelector, position }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "scroll_to_element",
        { index, selector: rawSelector, position },
        async () => {
          const wc = tab.view.webContents;
          const sel =
            rawSelector ||
            (index != null ? await resolveSelector(wc, index) : null);
          if (!sel) return "Error: Provide an index or selector.";
          const block =
            position === "top"
              ? "start"
              : position === "bottom"
                ? "end"
                : "center";

          if (sel.startsWith("__vessel_idx:")) {
            const idx = Number(sel.slice("__vessel_idx:".length));
            return wc.executeJavaScript(`
              (function() {
                var refs = window.__vessel;
                if (!refs || !refs.interactByIndex) return "Error: __vessel not available";
                // Use stored ref directly
                var el = document.querySelector('[data-vessel-idx="${idx}"]');
                if (!el) return "Error: Element #${idx} not found";
                el.scrollIntoView({ behavior: "smooth", block: "${block}" });
                return "Scrolled to element #${idx}";
              })()
            `);
          }

          if (sel.includes(" >>> ")) {
            return wc.executeJavaScript(`
              (function() {
                var el = window.__vessel?.resolveShadowSelector?.(${JSON.stringify(sel)});
                if (!el) return "Error: Shadow DOM element not found";
                el.scrollIntoView({ behavior: "smooth", block: "${block}" });
                return "Scrolled to shadow DOM element";
              })()
            `);
          }

          return wc.executeJavaScript(`
            (function() {
              var el = document.querySelector(${JSON.stringify(sel)});
              if (!el) return "Error: Element not found";
              el.scrollIntoView({ behavior: "smooth", block: "${block}" });
              return "Scrolled to element";
            })()
          `);
        },
      );
    },
  );
  // --- wait_for_navigation ---
  server.registerTool(
    "wait_for_navigation",
    {
      title: "Wait For Navigation",
      description:
        "Wait for the current page to finish loading after a click or form submission.",
      inputSchema: z.object({
        timeoutMs: z
          .number()
          .optional()
          .describe("Max wait in milliseconds (default 10000)"),
      }),
    },
    async ({ timeoutMs }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "wait_for_navigation",
        { timeoutMs },
        async () => {
          const wc = tab.view.webContents;
          const timeout = timeoutMs || 10000;
          const beforeUrl = wc.getURL();
          if (wc.isLoading()) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, timeout);
              wc.once("did-stop-loading", () => {
                clearTimeout(timer);
                resolve();
              });
            });
          } else {
            await new Promise<void>((resolve) => {
              let navigated = false;
              const timer = setTimeout(
                () => {
                  if (!navigated) resolve();
                },
                Math.min(timeout, 2000),
              );
              wc.once("did-start-loading", () => {
                navigated = true;
                clearTimeout(timer);
                const loadTimer = setTimeout(resolve, timeout);
                wc.once("did-stop-loading", () => {
                  clearTimeout(loadTimer);
                  resolve();
                });
              });
            });
          }
          const afterUrl = wc.getURL();
          const title = wc.getTitle();
          return afterUrl !== beforeUrl
            ? `Navigation complete: ${title} (${afterUrl})`
            : `Page loaded: ${title} (${afterUrl})`;
        },
      );
    },
  );

  // --- Agent Credential Vault ---
  // These tools implement the "blind fill" pattern: credential values NEVER
  // enter the AI conversation. The agent requests a fill, the main process
  // shows a consent dialog, and fills the form directly via the content script.

  server.registerTool(
    "vault_status",
    {
      title: "Check Vault Credentials",
      description:
        "Check whether stored credentials exist for a domain. Returns credential labels and usernames but NEVER password values. Use this before vault_login to verify credentials are available.",
      inputSchema: {
        domain: z
          .string()
          .describe(
            "The domain to check credentials for (e.g. 'github.com'). If omitted, checks the active tab's domain.",
          )
          .optional(),
      },
    },
    async ({ domain }) => {
      let targetDomain = domain;
      if (!targetDomain) {
        const tab = tabManager.getActiveTab();
        if (!tab) return asErrorTextResponse("No active tab and no domain specified");
        try {
          targetDomain = new URL(tab.state.url).hostname;
        } catch (err) {
          logger.warn("Failed to parse active tab URL for vault_status:", err);
          return asErrorTextResponse("Could not parse active tab URL");
        }
      }

      const matches = vaultManager.findEntriesForDomain(
        targetDomain.includes("://") ? targetDomain : `https://${targetDomain}`,
      );

      if (matches.length === 0) {
        return asTextResponse(
          `No stored credentials found for ${targetDomain}. The user needs to add credentials in Settings > Agent Credential Vault before the agent can log in.`,
        );
      }

      appendAuditEntry({
        timestamp: new Date().toISOString(),
        credentialId: matches[0].id,
        credentialLabel: matches[0].label,
        domain: targetDomain,
        action: "status_check",
        approved: true,
      });

      const summary = matches
        .map((m) => `  - "${m.label}" (${m.username})`)
        .join("\n");

      return asTextResponse(
        `Found ${matches.length} credential(s) for ${targetDomain}:\n${summary}\n\nUse vault_login to fill the login form. Credentials are filled directly — you will NOT see the password values.`,
      );
    },
  );

  server.registerTool(
    "vault_login",
    {
      title: "Fill Login with Vault Credentials",
      description:
        "Fill a login form on the current page using stored credentials from the Agent Credential Vault. The credential values are filled directly into the page — they are NEVER returned in this response. The user will see a consent dialog before credentials are used.",
      inputSchema: {
        credential_label: z
          .string()
          .optional()
          .describe(
            "Label of the credential to use. If omitted, uses the first matching credential for the current domain.",
          ),
        username_index: z
          .number()
          .optional()
          .describe(
            "Element index of the username/email input field from read_page.",
          ),
        password_index: z
          .number()
          .optional()
          .describe(
            "Element index of the password input field from read_page.",
          ),
        submit_after: z
          .boolean()
          .optional()
          .describe(
            "Whether to click the submit button after filling credentials. Defaults to false.",
          ),
        submit_index: z
          .number()
          .optional()
          .describe(
            "Element index of the submit button. Required if submit_after is true.",
          ),
      },
    },
    async ({
      credential_label,
      username_index,
      password_index,
      submit_after,
      submit_index,
    }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();

      const wc = tab.view.webContents;
      let hostname: string;
      try {
        hostname = new URL(tab.state.url).hostname;
      } catch (err) {
        logger.warn("Failed to parse active tab URL for vault_login:", err);
        return asErrorTextResponse("Could not parse active tab URL");
      }

      // Find matching credentials
      const matches = vaultManager.findEntriesForDomain(`https://${hostname}`);
      if (matches.length === 0) {
        return asTextResponse(
          `No stored credentials for ${hostname}. The user needs to add credentials in Settings > Agent Credential Vault.`,
        );
      }

      const match = credential_label
        ? matches.find(
            (m) => m.label.toLowerCase() === credential_label.toLowerCase(),
          )
        : matches[0];

      if (!match) {
        return asTextResponse(
          `No credential named "${credential_label}" found for ${hostname}. Available: ${matches.map((m) => m.label).join(", ")}`,
        );
      }

      // Request user consent
      const consent = await requestConsent({
        credentialLabel: match.label,
        username: match.username,
        domain: hostname,
      });

      appendAuditEntry({
        timestamp: new Date().toISOString(),
        credentialId: match.id,
        credentialLabel: match.label,
        domain: hostname,
        action: "login_fill",
        approved: consent.approved,
      });

      if (!consent.approved) {
        return asTextResponse(
          `User denied credential access for ${hostname}. The agent should not retry without being asked.`,
        );
      }

      // Get raw credentials (NEVER sent to AI — used only for form fill)
      const creds = vaultManager.getCredential(match.id);
      if (!creds) {
        return asErrorTextResponse("Credential not found in vault");
      }

      // Fill username field
      const results: string[] = [];
      if (username_index != null) {
        const usernameResult = await wc.executeJavaScript(
          `window.__vessel?.interactByIndex?.(${username_index}, "value", ${JSON.stringify(creds.username)}) || "Error: interactByIndex not available"`,
        );
        results.push(`Username: ${usernameResult}`);
      }

      // Fill password field
      if (password_index != null) {
        const passwordResult = await wc.executeJavaScript(
          `window.__vessel?.interactByIndex?.(${password_index}, "value", ${JSON.stringify(creds.password)}) || "Error: interactByIndex not available"`,
        );
        results.push(`Password: ${passwordResult.replace(/Typed into:.*/, "Typed into: [password field]")}`);
      }

      // Record usage
      vaultManager.recordUsage(match.id);
      trackVaultAction("login_fill");

      // Optionally submit
      if (submit_after && submit_index != null) {
        const submitResult = await wc.executeJavaScript(
          `window.__vessel?.interactByIndex?.(${submit_index}, "click") || "Error: interactByIndex not available"`,
        );
        results.push(`Submit: ${submitResult}`);
      }

      // Clear credential references from this scope
      // (they exist briefly in memory only during the fill)

      return asTextResponse(
        [
          `Login form filled for ${hostname} using credential "${match.label}".`,
          ...results,
          "",
          "Note: Credential values were filled directly into the page. They are NOT included in this response.",
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "vault_totp",
    {
      title: "Fill TOTP Code from Vault",
      description:
        "Generate a TOTP 2FA code from a stored secret and fill it into a code input field. The TOTP secret and generated code are NEVER returned — only filled directly into the page.",
      inputSchema: {
        credential_label: z
          .string()
          .optional()
          .describe(
            "Label of the credential whose TOTP secret to use. If omitted, uses the first matching credential with a TOTP secret.",
          ),
        code_index: z
          .number()
          .describe(
            "Element index of the TOTP/2FA code input field from read_page.",
          ),
        submit_after: z
          .boolean()
          .optional()
          .describe("Whether to click submit after filling the code."),
        submit_index: z
          .number()
          .optional()
          .describe("Element index of the submit button."),
      },
    },
    async ({ credential_label, code_index, submit_after, submit_index }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();

      const wc = tab.view.webContents;
      let hostname: string;
      try {
        hostname = new URL(tab.state.url).hostname;
      } catch (err) {
        logger.warn("Failed to parse active tab URL for vault_totp:", err);
        return asErrorTextResponse("Could not parse active tab URL");
      }

      const matches = vaultManager.findEntriesForDomain(`https://${hostname}`);
      const match = credential_label
        ? matches.find(
            (m) => m.label.toLowerCase() === credential_label.toLowerCase(),
          )
        : matches.find((m) => {
            const secret = vaultManager.getTotpSecret(m.id);
            return secret != null;
          });

      if (!match) {
        return asTextResponse(
          `No credential with TOTP secret found for ${hostname}.`,
        );
      }

      const secret = vaultManager.getTotpSecret(match.id);
      if (!secret) {
        return asTextResponse(
          `Credential "${match.label}" does not have a TOTP secret configured.`,
        );
      }

      // Request user consent
      const consent = await requestConsent({
        credentialLabel: match.label,
        username: match.username,
        domain: hostname,
      });

      appendAuditEntry({
        timestamp: new Date().toISOString(),
        credentialId: match.id,
        credentialLabel: match.label,
        domain: hostname,
        action: "totp_generate",
        approved: consent.approved,
      });

      if (!consent.approved) {
        return asTextResponse(
          `User denied TOTP access for ${hostname}.`,
        );
      }

      // Generate TOTP code (NEVER sent to AI)
      const code = vaultManager.generateTotpCode(secret);

      // Fill the code field
      const fillResult = await wc.executeJavaScript(
        `window.__vessel?.interactByIndex?.(${code_index}, "value", ${JSON.stringify(code)}) || "Error: interactByIndex not available"`,
      );

      vaultManager.recordUsage(match.id);
      trackVaultAction("totp_fill");

      const results = [`2FA code filled: ${fillResult.replace(/Typed into:.*/, "Typed into: [2FA field]")}`];

      if (submit_after && submit_index != null) {
        const submitResult = await wc.executeJavaScript(
          `window.__vessel?.interactByIndex?.(${submit_index}, "click") || "Error: interactByIndex not available"`,
        );
        results.push(`Submit: ${submitResult}`);
      }

      return asTextResponse(
        [
          `TOTP code filled for ${hostname} using credential "${match.label}".`,
          ...results,
          "",
          "Note: The TOTP code was filled directly into the page. It is NOT included in this response.",
        ].join("\n"),
      );
    },
  );

  // --- Human Password Manager ---

  server.registerTool(
    "human_vault_list",
    {
      title: "List Human Passwords",
      description:
        "List saved human passwords for a domain, or all passwords. " +
        "Returns metadata only (never passwords). Use human_vault_fill to fill credentials into a page. " +
        "Requires user consent.",
      inputSchema: z.object({
        domain: z
          .string()
          .optional()
          .describe("Filter by domain (e.g. 'github.com'). Omit for all."),
      }),
    },
    async ({ domain }) => {
      const consent = await requestHumanVaultConsent({
        action: "list",
        domain: domain ?? "all",
      });
      if (!consent.approved) {
        return asTextResponse("User denied access to password list.");
      }

      humanVault.recordListAccess(domain ?? "all", "mcp_tool");

      const entries = domain
        ? humanVault.findForDomain(domain)
        : humanVault.listEntries();

      if (entries.length === 0) {
        return asTextResponse(
          domain
            ? `No saved passwords for ${domain}.`
            : "No saved passwords.",
        );
      }

      const lines = entries.map((e, i) => {
        const parts = [
          `${i + 1}. "${e.title}"`,
          `   URL: ${e.url}`,
          `   Username: ${e.username || "(none)"}`,
        ];
        if (e.category) parts.push(`   Category: ${e.category}`);
        if (e.tags?.length) parts.push(`   Tags: ${e.tags.join(", ")}`);
        parts.push(
          `   Last used: ${e.lastUsedAt ? new Date(e.lastUsedAt).toLocaleDateString() : "never"}`,
        );
        return parts.join("\n");
      });

      return asTextResponse(
        [
          `Saved passwords${domain ? ` for ${domain}` : ""} (${entries.length}):`,
          "",
          ...lines,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "human_vault_fill",
    {
      title: "Fill Human Password",
      description:
        "Fill saved credentials into the active page's login form. " +
        "Requires user consent. The password is filled directly into the page -- " +
        "it is NEVER included in the response.",
      inputSchema: z.object({
        entry_id: z
          .string()
          .optional()
          .describe("Specific entry ID to fill. Omit to auto-detect by domain."),
        username_index: z
          .number()
          .optional()
          .describe("Element index of the username/email field."),
        password_index: z
          .number()
          .optional()
          .describe("Element index of the password field."),
        submit_after: z
          .boolean()
          .optional()
          .describe("Whether to click submit after filling (default: false)."),
        submit_index: z
          .number()
          .optional()
          .describe("Element index of the submit button (required if submit_after is true)."),
      }),
    },
    async ({ entry_id, username_index, password_index, submit_after, submit_index }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();

      let hostname: string;
      try {
        hostname = new URL(tab.state.url).hostname;
      } catch {
        return asErrorTextResponse("Could not parse active tab URL.");
      }

      // Find the entry
      if (username_index == null && password_index == null) {
        return asErrorTextResponse("Provide at least one field index to fill.");
      }
      if (submit_after && submit_index == null) {
        return asErrorTextResponse("submit_index is required when submit_after is true.");
      }

      let entry;
      if (entry_id) {
        entry = humanVault.getEntry(entry_id);
        if (!entry) {
          return asErrorTextResponse(`No entry found with ID ${entry_id}.`);
        }
        if (!humanVault.entryMatchesUrl(entry.id, `https://${hostname}`)) {
          return asErrorTextResponse(
            `Credential "${entry.title}" is not saved for ${hostname}. Refusing to fill it on this site.`,
          );
        }
      } else {
        const matches = humanVault.findForDomain(`https://${hostname}`);
        if (matches.length === 0) {
          return asTextResponse(
            `No saved passwords for ${hostname}. Add one in Settings > Passwords first.`,
          );
        }
        entry = humanVault.getEntry(matches[0].id);
        if (!entry) {
          return asErrorTextResponse("Matched credential could not be loaded.");
        }
      }

      // Request consent
      const consent = await requestHumanVaultConsent({
        action: "fill",
        entryId: entry.id,
        title: entry.title,
        username: entry.username,
        domain: hostname,
      });
      if (!consent.approved) {
        return asTextResponse("User denied filling credentials.");
      }

      // Decrypt the password (never sent to AI)
      const decrypted = humanVault.getCredential(entry.id);
      if (!decrypted) {
        return asErrorTextResponse("Failed to decrypt password.");
      }

      const wc = tab.view.webContents;
      const results: string[] = [];

      // Fill username
      if (username_index != null) {
        const usernameResult = await wc.executeJavaScript(
          `window.__vessel?.interactByIndex?.(${username_index}, "value", ${JSON.stringify(entry.username)}) || "Error: interactByIndex not available"`,
        );
        results.push(`Username filled: ${usernameResult.replace(/Typed into:.*/, "Typed into: [username field]")}`);
      }

      // Fill password (NEVER included in response text)
      if (password_index != null) {
        const passwordResult = await wc.executeJavaScript(
          `window.__vessel?.interactByIndex?.(${password_index}, "value", ${JSON.stringify(decrypted.password)}) || "Error: interactByIndex not available"`,
        );
        results.push(`Password filled: ${passwordResult.replace(/Typed into:.*/, "Typed into: [password field]")}`);
      }

      // Submit if requested
      if (submit_after && submit_index != null) {
        const submitResult = await wc.executeJavaScript(
          `window.__vessel?.interactByIndex?.(${submit_index}, "click") || "Error: interactByIndex not available"`,
        );
        results.push(`Submit: ${submitResult}`);
      }

      humanVault.recordUsage(entry.id, "mcp_tool");

      return asTextResponse(
        [
          `Credentials filled for ${hostname} using "${entry.title}".`,
          ...results,
          "",
          "Note: The password was filled directly into the page. It is NOT included in this response.",
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "human_vault_remove",
    {
      title: "Remove Human Password",
      description:
        "Delete a saved password. Requires user consent. This cannot be undone.",
      inputSchema: z.object({
        entry_id: z.string().describe("ID of the entry to remove."),
      }),
    },
    async ({ entry_id }) => {
      const entry = humanVault.getEntry(entry_id);
      if (!entry) {
        return asErrorTextResponse(`No entry found with ID ${entry_id}.`);
      }

      const consent = await requestHumanVaultConsent({
        action: "remove",
        entryId: entry.id,
        title: entry.title,
      });
      if (!consent.approved) {
        return asTextResponse("User denied removing this password.");
      }

      humanVault.removeEntry(entry_id, "mcp_tool");
      return asTextResponse(`Password "${entry.title}" removed.`);
    },
  );

  // --- Speedee: metrics ---
  server.registerTool(
    "metrics",
    {
      title: "Session Metrics",
      description:
        "Show performance metrics: total tool calls, average duration, per-tool breakdown.",
      inputSchema: z.object({}),
    },
    async () => {
      const m = runtime.getMetrics();
      const lines = [
        `Session Metrics:`,
        `  Total actions: ${m.totalActions}`,
        `  Completed: ${m.completedActions}`,
        `  Failed: ${m.failedActions}`,
        `  Average duration: ${m.averageDurationMs}ms`,
        ``,
        `Tool breakdown:`,
      ];
      for (const [name, stats] of Object.entries(m.toolBreakdown)) {
        lines.push(
          `  ${name}: ${stats.count} calls, avg ${stats.avgMs}ms${stats.errors > 0 ? `, ${stats.errors} errors` : ""}`,
        );
      }
      return asTextResponse(lines.join("\n"));
    },
  );
}

function waitForLoadWithStatus(
  wc: Electron.WebContents,
  timeout = 10000,
): Promise<{ httpStatus: number | null }> {
  return new Promise((resolve) => {
    let httpStatus: number | null = null;
    const onNavigate = (_: Electron.Event, _url: string, code: number) => {
      if (code > 0) httpStatus = code;
    };
    wc.on("did-navigate", onNavigate);
    const finish = () => {
      wc.removeListener("did-navigate", onNavigate);
      resolve({ httpStatus });
    };
    if (!wc.isLoading()) {
      finish();
      return;
    }
    const timer = setTimeout(finish, timeout);
    wc.once("did-stop-loading", () => {
      clearTimeout(timer);
      finish();
    });
  });
}

function createMcpServer(
  tabManager: TabManager,
  runtime: AgentRuntime,
): McpServer {
  const server = new McpServer({
    name: "vessel-browser",
    version: "0.1.0",
  });
  registerTools(server, tabManager, runtime);
  registerDevTools(server, tabManager, runtime);
  return server;
}

export function startMcpServer(
  tabManager: TabManager,
  runtime: AgentRuntime,
  port: number,
): Promise<McpServerStartResult> {
  setMcpHealth({
    configuredPort: port,
    activePort: null,
    endpoint: null,
    status: "starting",
    message: `Starting MCP server on port ${port}.`,
  });

  mcpAuthToken = getPersistentMcpAuthToken();

  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`);

      if (url.pathname !== "/mcp") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      // Only allow CORS from localhost origins (defense-in-depth alongside auth token)
      const origin = req.headers.origin;
      if (
        origin &&
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      ) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader(
          "Access-Control-Allow-Methods",
          "POST, GET, DELETE, OPTIONS",
        );
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, mcp-session-id, Authorization",
        );
      }

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Validate bearer token on all non-OPTIONS requests (constant-time
      // comparison to prevent timing side-channel attacks on persistent tokens).
      const authHeader = req.headers.authorization;
      const expected = `Bearer ${mcpAuthToken}`;
      const headerBuf = Buffer.from(authHeader ?? "");
      const expectedBuf = Buffer.from(expected);
      const tokenValid =
        headerBuf.length === expectedBuf.length &&
        crypto.timingSafeEqual(headerBuf, expectedBuf);
      if (!authHeader || !tokenValid) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized — missing or invalid bearer token" }));
        return;
      }

      try {
        const mcpServer = createMcpServer(tabManager, runtime);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res);
      } catch (error) {
        logger.error("Error handling request:", error);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : "Unknown error",
            }),
          );
        }
      }
    });

    let settled = false;
    const finish = (result: McpServerStartResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    server.once("error", (error: NodeJS.ErrnoException) => {
      const message =
        error.code === "EADDRINUSE"
          ? `Port ${port} is already in use. MCP server not started.`
          : error.message;
      logger.error("Server error:", error);
      clearMcpAuthFile();
      setMcpHealth({
        configuredPort: port,
        activePort: null,
        endpoint: null,
        status: "error",
        message,
      });
      if (httpServer === server) {
        httpServer = null;
      }
      finish(errorResult(message, {
        configuredPort: port,
        activePort: null,
        endpoint: null,
        authToken: null,
      }));
    });

    server.listen(port, "127.0.0.1", () => {
      httpServer = server;
      const address = server.address();
      const actualPort =
        address && typeof address === "object" ? address.port : port;
      const endpoint = `http://127.0.0.1:${actualPort}/mcp`;
      setMcpHealth({
        configuredPort: port,
        activePort: actualPort,
        endpoint,
        status: "ready",
        message: `MCP server listening on ${endpoint}.`,
      });
      if (process.env.VESSEL_DEBUG_MCP === '1' || process.env.VESSEL_DEBUG_MCP === 'true') {
        logger.info(`Server listening on ${endpoint} (auth enabled)`);
      }
      if (mcpAuthToken) {
        writeMcpAuthFile(endpoint, mcpAuthToken);
      }
      finish({
        ok: true,
        configuredPort: port,
        activePort: actualPort,
        endpoint,
        authToken: mcpAuthToken,
      });
    });
  });
}

export function stopMcpServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!httpServer) {
      setMcpHealth({
        activePort: null,
        endpoint: null,
        status: "stopped",
        message: "MCP server is stopped.",
      });
      resolve();
      return;
    }

    const server = httpServer;
    httpServer = null;
    mcpAuthToken = null;
    clearMcpAuthFile();
    server.close(() => {
      setMcpHealth({
        activePort: null,
        endpoint: null,
        status: "stopped",
        message: "MCP server is stopped.",
      });
      if (process.env.VESSEL_DEBUG_MCP === '1' || process.env.VESSEL_DEBUG_MCP === 'true') {
        logger.info("Server stopped");
      }
      resolve();
    });
  });
}
