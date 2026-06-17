import type Anthropic from "@anthropic-ai/sdk";
import type { AIMessage, CodexOAuthTokens } from "../../shared/types";
import type { AIProvider } from "./provider";
import type { AgentToolProfile } from "./tool-profile";
import { refreshAccessToken } from "./codex-oauth";
import { writeStoredCodexTokens, clearStoredCodexTokens } from "../config/settings";
import { createLogger } from "../../shared/logger";
import { getEffectiveMaxIterations } from "../premium/manager";
import { TERMINAL_TOOL_RESULT } from "./tool-control";
import {
  ClickReadLoopGuard,
  classifyClickFailure,
  hasRecentDuplicateToolCall,
} from "./tool-guardrails";
import { isRichToolResult, type TextBlock } from "./tool-result";
import {
  coerceToolArgsForExecution,
  isTargetlessClickArgs,
  parseToolArgsWithRepair,
  recoverAssistantTextToolCalls,
  resolveToolCallName,
  stableToolSignature,
  unsupportedToolHint,
} from "./provider-openai-tools";
import {
  buildFlightPriceEvidenceRecoveryPrompt,
  shouldBlockUnsupportedFlightPriceAnswer,
} from "./flight-price-evidence";
import {
  buildLatestStateReminder,
  buildRepeatedSearchError,
  normalizeSearchToolQuery,
  SearchLoopGuard,
} from "./search-loop-guard";

const logger = createLogger("CodexProvider");

const REFRESH_WINDOW_MS = 5 * 60 * 1000; // refresh if expiring within 5 min
const CODEX_BACKEND_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_CLIENT_VERSION = "0.129.0";

interface CodexResponsesTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface CodexOutputItem {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
}

interface CodexStreamResult {
  text: string;
  items: CodexOutputItem[];
  turnState: string | null;
}

interface CodexResponsesStreamEvent {
  type?: string;
  delta?: string;
  call_id?: string;
  item_id?: string;
  response?: {
    id?: string;
    error?: {
      code?: string;
      message?: string;
      type?: string;
    };
  };
  item?: CodexOutputItem;
}

interface CodexStreamAccumulation {
  text: string;
  items: CodexOutputItem[];
  emittedTextFromDelta: boolean;
  functionCallArgs: Map<string, string>;
}

type CodexInputItem =
  | { type: "message"; role: string; content: Array<{ type: "input_text" | "output_text"; text: string }> }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

interface CodexTerminalToolResult {
  terminal: true;
}

interface PreparedCodexFunctionCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

function createCodexToolOutput(
  callId: string,
  output: string,
): CodexInputItem {
  return {
    type: "function_call_output",
    call_id: callId,
    output,
  };
}

function toolResultTextContent(result: string): string {
  try {
    const parsed = JSON.parse(result);
    if (isRichToolResult(parsed)) {
      return parsed.content
        .filter((block): block is TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n");
    }
  } catch {
    // Not a rich JSON tool result.
  }
  return result;
}

function summarizeToolArg(args: Record<string, unknown>): string {
  const index =
    typeof args.index === "number"
      ? `#${args.index}`
      : typeof args.index === "string" && args.index.trim()
        ? `#${args.index.trim()}`
        : "";
  return [args.url, args.query, args.text, args.selector, index, args.direction]
    .map((value): string => typeof value === "string" ? value : "")
    .find((value) => value.length > 0) ?? "";
}

function normalizeCodexText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"');
}

function looksLikeFailedToolOutput(output: string): boolean {
  const normalized = normalizeCodexText(output);
  return (
    normalized.startsWith("error") ||
    normalized.startsWith("warning") ||
    normalized.startsWith("target") ||
    normalized.startsWith("no active tab") ||
    normalized.includes("same page — results may have loaded dynamically") ||
    normalized.includes("could not ") ||
    normalized.includes("did not ")
  );
}

function looksLikeTravelFareContext(text: string): boolean {
  const normalized = normalizeCodexText(text);
  return (
    /\b(?:flight|flights|fare|fares|airline|airlines|one-way|roundtrip|nonstop|layover|departure|arrival)\b/.test(normalized) ||
    /\b(?:pdx|sfo|oak|sjc)\b/.test(normalized) ||
    /\$[\d,]+/.test(normalized)
  );
}

function emitCodexToolChunk(
  onChunk: (text: string) => void,
  name: string,
  args: Record<string, unknown>,
  output: string,
): void {
  const summary = summarizeToolArg(args);
  const argSummary = looksLikeFailedToolOutput(output)
    ? ["⚠ failed", summary].filter(Boolean).join(" ")
    : summary;
  onChunk(`\n<<tool:${name}${argSummary ? ":" + argSummary : ""}>>\n`);
}

function prepareCodexFunctionCall(
  functionCall: CodexOutputItem,
  availableToolNames: ReadonlySet<string>,
  onChunk: (text: string) => void,
): { prepared: PreparedCodexFunctionCall } | { output: CodexInputItem } {
  const callId = functionCall.call_id || functionCall.id || "";
  const rawName = functionCall.name || "";
  const argsJson = functionCall.arguments || "{}";

  if (!callId) {
    return {
      output: createCodexToolOutput(
        callId,
        "Error: Function call was missing a call_id. Please retry the tool call.",
      ),
    };
  }

  const available = new Set(availableToolNames);
  const preliminaryArgs =
    parseToolArgsWithRepair(rawName, argsJson)?.args ?? {};
  const name = resolveToolCallName(rawName, preliminaryArgs, available);

  if (!name || !available.has(name)) {
    onChunk(`\n<<tool:${rawName || "unknown"}:⚠ unsupported>>\n`);
    return {
      output: createCodexToolOutput(
        callId,
        `Error: Unsupported tool${rawName ? `: ${rawName}` : ""}. ${unsupportedToolHint(rawName || name || "unknown")}`,
      ),
    };
  }

  const repaired = parseToolArgsWithRepair(name, argsJson);
  if (!repaired) {
    onChunk(`\n<<tool:${name}:⚠ invalid args>>\n`);
    return {
      output: createCodexToolOutput(
        callId,
        "Error: Invalid JSON in tool arguments. Please retry with a valid JSON object.",
      ),
    };
  }

  const args = coerceToolArgsForExecution(name, repaired.args);
  if (name === "click" && isTargetlessClickArgs(args)) {
    onChunk(`\n<<tool:${name}:⚠ missing target>>\n`);
    return {
      output: createCodexToolOutput(
        callId,
        `Error: click requires an element target. Use click with {"index": N} from the latest read_page result, or {"text": "exact visible link/button text"}. If you do not have a current result index, call read_page(mode="results_only") first and then click exactly one result.`,
      ),
    };
  }

  return {
    prepared: {
      callId,
      name,
      args,
    },
  };
}

async function executePreparedCodexFunctionCall(
  prepared: PreparedCodexFunctionCall,
  onChunk: (text: string) => void,
  onToolCall: (name: string, args: Record<string, unknown>) => Promise<string>,
): Promise<CodexInputItem | CodexTerminalToolResult> {
  let output: string;
  try {
    output = await onToolCall(prepared.name, prepared.args);
  } catch (toolErr: unknown) {
    const msg = toolErr instanceof Error ? toolErr.message : String(toolErr);
    output = `Error: Tool execution failed — ${msg}. Try a different approach or call read_page to refresh context.`;
  }
  if (output === TERMINAL_TOOL_RESULT) {
    return { terminal: true };
  }
  const textOutput = toolResultTextContent(output);
  emitCodexToolChunk(onChunk, prepared.name, prepared.args, textOutput);
  return createCodexToolOutput(prepared.callId, textOutput);
}

export async function createCodexFunctionCallOutput(
  functionCall: CodexOutputItem,
  availableToolNames: ReadonlySet<string>,
  onChunk: (text: string) => void,
  onToolCall: (name: string, args: Record<string, unknown>) => Promise<string>,
): Promise<CodexInputItem | CodexTerminalToolResult> {
  const prepared = prepareCodexFunctionCall(
    functionCall,
    availableToolNames,
    onChunk,
  );
  if ("output" in prepared) return prepared.output;
  return executePreparedCodexFunctionCall(prepared.prepared, onChunk, onToolCall);
}

function createCodexFunctionCallInput(functionCall: CodexOutputItem): CodexInputItem | null {
  const callId = functionCall.call_id || functionCall.id || "";
  const name = functionCall.name || "";
  if (!callId || !name) return null;
  return {
    type: "function_call",
    call_id: callId,
    name,
    arguments: functionCall.arguments || "{}",
  };
}

function previewToolResult(text: string, maxLength = 800): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function hasBlockingOverlaySignal(text: string | null): boolean {
  if (!text) return false;
  if (/\bno blocking overlays detected\b/i.test(text)) return false;
  return (
    /\bwarning:\s*blocking overlay detected\b/i.test(text) ||
    /\bblocked-by-overlay\b/i.test(text) ||
    /###\s*immediate blockers\b/i.test(text) ||
    /\bblocking overlays\W+[1-9]\d*\b/i.test(text)
  );
}

/**
 * Build a strict, actionable error for a fabricated clear_overlays call
 * (no blocking overlay signal in the system prompt or latest tool result).
 */
function buildCodexUnsupportedClearOverlayError(
  latestToolResultPreview: string | null,
): string {
  const stateReminder = buildLatestStateReminder(latestToolResultPreview);
  const lines = [
    `Error: No blocking overlay signal is present in the latest browser state.`,
    `Do not call clear_overlays unless read_page or the page context explicitly reports a blocking overlay.`,
    `Continue with read_page, inspect_element, click, or provide the final answer. Do not call clear_overlays again.`,
  ];
  if (stateReminder) {
    lines.push(stateReminder);
  }
  return lines.join(" ");
}

/**
 * True if a tool call represents *real forward progress* on the task — i.e.
 * it changes the page state or acts on specific page content. Used to gate
 * whether a successful tool call resets the dedup strike counters.
 *
 * Pure observation tools (read_page, screenshot, current_tab, list_*,
 * metrics) are NOT included: they let a model game the strike counter by
 * alternating `web_search → read_page → web_search` and never actually
 * advancing. A real forward-progress action (click, navigate, type_text,
 * save_bookmark, etc.) means the model has used the prior search result
 * in some way, so a future duplicate search is no longer the same stuck
 * pattern.
 *
 * Source of truth: src/main/ai/page-actions/orchestrator.ts switch.
 */
function isRealProgressTool(name: string): boolean {
  return REAL_PROGRESS_TOOLS.has(name);
}

const REAL_PROGRESS_TOOLS = new Set<string>([
  // Page navigation / state change
  "navigate",
  "go_back",
  "go_forward",
  "reload",
  "create_tab",
  "switch_tab",
  // Page interaction
  "click",
  "inspect_element",
  "type_text",
  "select_option",
  "submit_form",
  "fill_form",
  "press_key",
  "scroll",
  "scroll_to_element",
  "hover",
  "focus",
  "paginate",
  "login",
  "accept_cookies",
  "dismiss_popup",
  "clear_overlays",
  "set_ad_blocking",
  "extract_table",
  // Annotations + bookmarks
  "highlight",
  "clear_highlights",
  "save_bookmark",
  "create_bookmark_folder",
  "organize_bookmark",
  "archive_bookmark",
  "open_bookmark",
  // Wait conditions (the model is waiting for a real state change)
  "wait_for",
  "wait_for_navigation",
  // Session / checkpoint actions are real user intent
  "create_checkpoint",
  "restore_checkpoint",
  "save_session",
  "load_session",
  "delete_session",
  "undo_last_action",
  // Flow + suggest are explicit user-driven actions
  "flow_start",
  "flow_advance",
  "flow_end",
  "suggest",
]);

function shouldRetryCodexToolLoop(
  text: string,
  hasToolHistory: boolean,
): boolean {
  if (!hasToolHistory) return false;

  const trimmed = normalizeCodexText(text);
  if (!trimmed) return true;

  // The previous version of this function treated *any* forward-
  // looking language as a stall signal ("i've navigated", "i'll
  // now", "want me to", "let me know", etc.). That was wrong — a
  // model that just successfully navigated and says "I navigated to
  // the page, now I'll click the result" is doing exactly the right
  // thing, not stalling. Nudging it to "continue the original task"
  // with `<<erase_prev>>` would erase the model's natural progress
  // narrative and confuse it. The new logic only nudges on real
  // stalls: empty text, an explicit user-question, or the model
  // giving up entirely (matching the OpenAI/Ollama provider's
  // `shouldRecoverCompactStall` exit conditions, minus the
  // forward-looking phrase false positives).

  // A short message with a question mark is the model asking the
  // user for permission to continue. That's a real stall.
  if (trimmed.length <= 160 && trimmed.includes("?")) return true;

  // The model is asking the user to choose a direction. Real stall.
  const askingUserForDirection = [
    "what are you hoping",
    "what would you like",
    "how can i help",
    "would you like me to",
    "want me to",
    "are you looking for",
    "any preferences",
    "should i",
  ];
  if (askingUserForDirection.some((signal) => trimmed.includes(signal))) {
    return true;
  }

  const askingUserToContinue = [
    "please let me",
    "let me inspect",
    "let me click",
    "need to continue from",
    "i need to continue",
    "allow me to",
    "can't access or reuse",
    "cant access or reuse",
    "can't access",
    "cant access",
    "visible context",
    "surface it",
    "send me the current",
    "send me the results",
    "send me the pricing",
  ];
  if (askingUserToContinue.some((signal) => trimmed.includes(signal))) {
    return true;
  }

  // The model is saying it cannot proceed (real stall, not a
  // forward-looking phrase).
  const cannotProceed = [
    "i cannot",
    "i can't",
    "i'm unable",
    "i am unable",
    "i don't have",
    "i do not have",
    "since i cannot see",
    "since i can't see",
    "cannot see the current page",
  ];
  if (cannotProceed.some((signal) => trimmed.includes(signal))) {
    return true;
  }

  // Everything else — including "I will now click the result",
  // "I've navigated to the airline site", "next, I'll check the
  // baggage policy", "here are the top 5 results" — is the model
  // doing its job. Don't nudge it; let it finish.
  return false;
}

function buildCodexRecoveryInput(
  userMessage: string,
  assistantText: string,
  latestToolResultPreview: string | null,
): CodexInputItem {
  const stateReminder = buildLatestStateReminder(latestToolResultPreview);
  const lines = [
    `[System] The task is still in progress: ${userMessage}`,
    `Do not ask the user what they want next unless the original request is genuinely ambiguous or blocked.`,
    `Your last response stopped after an intermediate browser action: ${previewToolResult(assistantText, 500) || "(no assistant text)"}`,
    `Continue the original task by choosing the next supported browser tool now.`,
  ];
  if (stateReminder) {
    lines.push(stateReminder);
  }

  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: lines.join("\n") }],
  };
}

function buildCodexFlightPriceEvidenceRecoveryInput(
  userMessage: string,
  assistantText: string,
  latestToolResultPreview: string | null,
): CodexInputItem {
  return {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: `[System] ${buildFlightPriceEvidenceRecoveryPrompt(
          userMessage,
          assistantText,
          latestToolResultPreview,
        )}`,
      },
    ],
  };
}

function buildCodexFailedClickRecoveryInput(
  attemptedTarget: string,
  latestToolResultPreview: string | null,
  failedClickCount = 1,
  errorOutput = "",
): CodexInputItem {
  const stateReminder = buildLatestStateReminder(latestToolResultPreview);
  // Keep the message short: the click did not complete, here's the
  // current state, take the next step. The previous version
  // over-prescribed which targets to avoid (filters, sort controls,
  // snippets, timestamps, non-link text) and which to prefer
  // (Primary Results, [#N] indexes) — but the model already knows
  // what it's clicking on. Excessive negative guidance was making
  // the model spiral through failed clicks in our transcripts.
  const clickFailureKind = classifyClickFailure(errorOutput);
  const lines = [
    `[System] The previous click did not complete${attemptedTarget ? ` for ${attemptedTarget}` : ""}.`,
  ];
  if (clickFailureKind === "hidden") {
    // The target exists in the DOM but has no layout box — collapsed,
    // lazy-loaded, or virtual-scroll content. "Try a different target" feeds
    // the loop here (the model re-picks a similar hidden neighbor); scrolling
    // toward the element first is what actually reveals it. Lead with that
    // remedy, matching the tool's own error guidance and the circuit-breaker's
    // strike-2 nudge.
    lines.push(
      `The click target was hidden / not laid out (collapsed, lazy-loaded, or virtual-scroll). Call scroll or scroll_to_element toward it to reveal it, then read_page to refresh visible elements, before clicking again — or inspect_element on the intended index, or answer from the results already visible. Do not ask the user to inspect or click the result for you.`,
    );
  } else if (clickFailureKind === "stale") {
    lines.push(
      `The click target was stale — the page changed since the last snapshot. Call read_page to refresh current indexes, then choose a currently listed target, inspect_element on the intended element, or answer from the results already visible. Do not ask the user to inspect or click the result for you.`,
    );
  } else {
    lines.push(
      `Take the next step yourself: try a different target, refresh the page state with read_page, call inspect_element on the intended element, or answer from the results already visible in the conversation. Do not ask the user to inspect or click the result for you.`,
    );
  }
  if (failedClickCount >= 2) {
    lines.push(
      `You have already had multiple failed clicks without making page progress. Do not keep clicking similar search result titles. Use the latest read_page/search result text to answer, or inspect a specific indexed result/control only if essential.`,
    );
  }
  if (looksLikeTravelFareContext(`${attemptedTarget}\n${latestToolResultPreview || ""}`)) {
    lines.push(
      `For flight-price tasks, visible fare snippets are enough to compare candidates. If the results show prices, stops, airlines, or route names, report the cheapest visible option with caveats instead of trying to open every aggregator result.`,
    );
  }
  if (stateReminder) {
    lines.push(stateReminder);
  }
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: lines.join("\n") }],
  };
}

export class CodexProvider implements AIProvider {
  readonly agentToolProfile: AgentToolProfile;
  private tokens: CodexOAuthTokens;
  private model: string;
  private abortController: AbortController | null = null;

  constructor(tokens: CodexOAuthTokens, model: string) {
    this.tokens = tokens;
    this.model = model;
    this.agentToolProfile = "compact";
  }

  private async ensureFreshTokens(): Promise<void> {
    if (Date.now() < this.tokens.expiresAt - REFRESH_WINDOW_MS) return;

    try {
      logger.info("Refreshing Codex access token");
      const fresh = await refreshAccessToken(this.tokens);
      this.tokens = fresh;
      writeStoredCodexTokens(fresh);
    } catch (err) {
      clearStoredCodexTokens();
      throw new Error(
        `Codex token refresh failed — please re-authenticate. ${err instanceof Error ? err.message : ""}`,
      );
    }
  }

  private backendHeaders(turnState?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.tokens.accessToken}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      originator: "codex_cli_rs",
      "User-Agent": `codex_cli_rs/${CODEX_CLIENT_VERSION} Vessel`,
    };
    if (this.tokens.accountId) {
      headers["ChatGPT-Account-ID"] = this.tokens.accountId;
    }
    if (turnState) {
      headers["x-codex-turn-state"] = turnState;
    }
    return headers;
  }

  private buildInput(
    userMessage: string,
    history?: AIMessage[],
  ): CodexInputItem[] {
    const input: CodexInputItem[] = [];

    for (const msg of history ?? []) {
      input.push({
        type: "message",
        role: msg.role,
        content: [{ type: msg.role === "assistant" ? "output_text" : "input_text", text: msg.content }],
      });
    }

    input.push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: userMessage }],
    });

    return input;
  }

  private handleStreamEvent(
    raw: string,
    onChunk: (text: string) => void,
    acc: CodexStreamAccumulation,
  ): void {
    if (!raw.trim() || raw.trim() === "[DONE]") return;

    let event: CodexResponsesStreamEvent;
    try {
      event = JSON.parse(raw) as CodexResponsesStreamEvent;
    } catch {
      return;
    }

    if (event.type === "response.output_text.delta" && event.delta) {
      acc.emittedTextFromDelta = true;
      acc.text += event.delta;
      onChunk(event.delta);
      return;
    }

    if (event.type === "response.function_call_arguments.delta" && event.delta) {
      const key = event.call_id || event.item_id || "";
      if (key) {
        acc.functionCallArgs.set(key, (acc.functionCallArgs.get(key) || "") + event.delta);
      }
      return;
    }

    if (event.type === "response.output_item.done" && event.item) {
      const item = event.item;
      if (item.type === "function_call") {
        const key = item.call_id || item.id || "";
        const args = acc.functionCallArgs.get(key) || item.arguments || "";
        acc.functionCallArgs.delete(key);
        acc.items.push({ ...item, arguments: args });
      } else if (item.type === "message") {
        acc.items.push(item);
      }
      return;
    }

    if (event.type === "response.failed") {
      const error = event.response?.error;
      const message = error?.message || error?.code || "Codex response failed";
      throw new Error(message);
    }
  }

  private async streamCodexResponse(
    requestBody: Record<string, unknown>,
    onChunk: (text: string) => void,
    turnState?: string,
  ): Promise<CodexStreamResult> {
    const response = await fetch(`${CODEX_BACKEND_BASE_URL}/responses`, {
      method: "POST",
      headers: this.backendHeaders(turnState),
      signal: this.abortController?.signal,
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Codex backend request failed: ${response.status}${text ? ` ${text}` : ""}`,
      );
    }

    if (!response.body) {
      throw new Error("Codex backend returned an empty response stream");
    }

    const newTurnState = response.headers.get("x-codex-turn-state") || null;
    const reader = response.body.getReader();

    try {
      const decoder = new TextDecoder();
      let buffer = "";
      const acc: CodexStreamAccumulation = {
        text: "",
        items: [],
        emittedTextFromDelta: false,
        functionCallArgs: new Map(),
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let separatorIndex: number;
        while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          this.handleStreamEvent(data, onChunk, acc);
        }
      }

      const trailing = buffer.trim();
      if (trailing) {
        const data = trailing
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        this.handleStreamEvent(data, onChunk, acc);
      }

      return { text: acc.text, items: acc.items, turnState: newTurnState };
    } finally {
      reader.releaseLock();
    }
  }

  async streamQuery(
    systemPrompt: string,
    userMessage: string,
    onChunk: (text: string) => void,
    onEnd: () => void,
    history?: AIMessage[],
  ): Promise<void> {
    await this.ensureFreshTokens();
    this.abortController = new AbortController();

    try {
      await this.streamCodexResponse(
        {
          model: this.model,
          instructions: systemPrompt,
          input: this.buildInput(userMessage, history),
          stream: true,
          store: false,
        },
        onChunk,
      );
    } catch (err: unknown) {
      if ((err as { name?: string }).name !== "AbortError") {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Codex streamQuery error:", err);
        onChunk(`\n\n[Error: ${msg}]`);
      }
    } finally {
      this.abortController = null;
      onEnd();
    }
  }

  async streamAgentQuery(
    systemPrompt: string,
    userMessage: string,
    tools: Anthropic.Tool[],
    onChunk: (text: string) => void,
    onToolCall: (name: string, args: Record<string, unknown>) => Promise<string>,
    onEnd: () => void,
    history?: AIMessage[],
  ): Promise<void> {
    await this.ensureFreshTokens();
    this.abortController = new AbortController();
    const maxIterations = getEffectiveMaxIterations();
    const availableToolNames = new Set(tools.map((tool) => tool.name));
    let iterationsUsed = 0;

    const convertedTools: CodexResponsesTool[] = tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema as Record<string, unknown>,
    }));

    let currentInput = this.buildInput(userMessage, history);
    let turnState: string | null = null;
    let toolHistoryCount = 0;
    let recoveryCount = 0;
    let flightPriceEvidenceRecoveryCount = 0;
    let correctionCount = 0;
    const recentToolSignatures: string[] = [];
    const clickReadLoopGuard = new ClickReadLoopGuard();
    let latestToolResultPreview: string | null = null;
    let failedClickCountSinceProgress = 0;
    const searchLoopGuard = new SearchLoopGuard(isRealProgressTool);

    try {
      for (let i = 0; i < maxIterations; i++) {
        iterationsUsed = i + 1;
        const result = await this.streamCodexResponse(
          {
            model: this.model,
            instructions: systemPrompt,
            input: currentInput,
            tools: convertedTools,
            stream: true,
            store: false,
          },
          onChunk,
          turnState || undefined,
        );

        turnState = result.turnState || turnState;

        let functionCalls: CodexOutputItem[] = result.items.filter(
          (item): item is CodexOutputItem & { type: "function_call" } =>
            item.type === "function_call",
        );

        if (functionCalls.length === 0) {
          const recoveredCalls = recoverAssistantTextToolCalls(
            result.text,
            availableToolNames,
          );
          if (recoveredCalls.length > 0) {
            if (result.text.trim()) onChunk("<<erase_prev>>");
            functionCalls = recoveredCalls.map((toolCall) => ({
              type: "function_call",
              call_id: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.argsJson,
            }));
          }
        }

        if (functionCalls.length === 0) {
          if (
            flightPriceEvidenceRecoveryCount < 2 &&
            shouldBlockUnsupportedFlightPriceAnswer(
              userMessage,
              result.text,
              latestToolResultPreview,
            )
          ) {
            flightPriceEvidenceRecoveryCount += 1;
            if (result.text.trim()) onChunk("<<erase_prev>>");
            currentInput = [
              buildCodexFlightPriceEvidenceRecoveryInput(
                userMessage,
                result.text,
                latestToolResultPreview,
              ),
            ];
            continue;
          }
          if (
            recoveryCount < 1 &&
            shouldRetryCodexToolLoop(result.text, toolHistoryCount > 0)
          ) {
            recoveryCount += 1;
            if (result.text.trim()) onChunk("<<erase_prev>>");
            currentInput = [
              buildCodexRecoveryInput(
                userMessage,
                result.text,
                latestToolResultPreview,
              ),
            ];
            continue;
          }
          break;
        }
        recoveryCount = 0;
        flightPriceEvidenceRecoveryCount = 0;

        currentInput = [];
        for (const fc of functionCalls) {
          const functionCallInput = createCodexFunctionCallInput(fc);
          if (functionCallInput) {
            currentInput.push(functionCallInput);
          }
          const prepared = prepareCodexFunctionCall(
            fc,
            availableToolNames,
            onChunk,
          );
          if ("output" in prepared) {
            currentInput.push(prepared.output);
            latestToolResultPreview = previewToolResult(prepared.output.output);
            correctionCount += 1;
            continue;
          }

          const toolSignature = stableToolSignature(
            prepared.prepared.name,
            prepared.prepared.args,
          );
          const searchToolQuery = normalizeSearchToolQuery(
            prepared.prepared.name,
            prepared.prepared.args,
          );
          const searchLoopCheck = searchLoopGuard.check(
            prepared.prepared.name,
            searchToolQuery,
          );
          const isUnsupportedClearOverlay =
            prepared.prepared.name === "clear_overlays" &&
            !hasBlockingOverlaySignal(
              `${systemPrompt}\n${latestToolResultPreview || ""}`,
            );
          if (searchLoopCheck) {
            onChunk(`\n<<tool:${prepared.prepared.name}:↻ duplicate suppressed>>\n`);
            const output = createCodexToolOutput(
              prepared.prepared.callId,
              buildRepeatedSearchError(
                searchLoopCheck.previousTool,
                searchLoopCheck.previousQuery,
                latestToolResultPreview,
                searchLoopCheck.mode,
              ),
            );
            currentInput.push(output);
            latestToolResultPreview = previewToolResult(output.output);
            correctionCount += 1;
            continue;
          }
          if (isUnsupportedClearOverlay) {
            onChunk(`\n<<tool:${prepared.prepared.name}:↻ duplicate suppressed>>\n`);
            const output = createCodexToolOutput(
              prepared.prepared.callId,
              buildCodexUnsupportedClearOverlayError(latestToolResultPreview),
            );
            currentInput.push(output);
            latestToolResultPreview = previewToolResult(output.output);
            correctionCount += 1;
            continue;
          }
          if (
            ![
              "read_page",
              "current_tab",
              "inspect_element",
              "screenshot",
              "go_back",
              "go_forward",
              "click",
            ].includes(prepared.prepared.name) &&
            hasRecentDuplicateToolCall(recentToolSignatures, toolSignature)
          ) {
            onChunk(`\n<<tool:${prepared.prepared.name}:↻ duplicate suppressed>>\n`);
            const output = createCodexToolOutput(
              prepared.prepared.callId,
              `Error: Repeated the same tool call (${prepared.prepared.name}) with the same arguments twice in a row. Do not repeat it. Continue with the next logical step for the original task.`,
            );
            currentInput.push(output);
            latestToolResultPreview = previewToolResult(output.output);
            correctionCount += 1;
            continue;
          }

          const clickLoopPreflight = clickReadLoopGuard.beforeTool(
            prepared.prepared.name,
          );
          if (clickLoopPreflight?.kind === "suppress") {
            onChunk(`\n<<tool:click:↻ loop suppressed>>\n`);
            const suppressed = createCodexToolOutput(
              prepared.prepared.callId,
              clickLoopPreflight.message,
            );
            currentInput.push(suppressed);
            latestToolResultPreview = previewToolResult(suppressed.output);
            correctionCount += 1;
            continue;
          }

          const output = await executePreparedCodexFunctionCall(
            prepared.prepared,
            onChunk,
            onToolCall,
          );
          if ("terminal" in output) {
            return;
          }
          currentInput.push(output);
          toolHistoryCount += 1;
          latestToolResultPreview = previewToolResult(output.output);
          const outputText = toolResultTextContent(output.output);
          // A real-progress tool call clears the dedup strikes for that
          // category — but ONLY for tools that actually change or act on
          // the page. Pure observation tools (read_page, screenshot,
          // current_tab) do not reset, because the model can otherwise
          // game the strike counter by alternating
          //   web_search → (suppressed) → read_page → web_search
          // and never actually advance. A real forward-progress action
          // (click, navigate, inspect_element, highlight, save_bookmark,
          // etc.) means the model has used the prior search result in
          // some way, so a future duplicate search is no longer the same
          // stuck pattern. The search-loop guard clears the drift anchor
          // when a real-progress tool succeeds, so a fresh web_search several
          // turns after the original (with intervening clicks/navigates/inspects)
          // is NOT treated as drift.
          const toolSucceeded = !looksLikeFailedToolOutput(outputText);
          if (toolSucceeded && isRealProgressTool(prepared.prepared.name)) {
            // A real-progress tool (navigate, click, inspect, etc.) means the
            // model has used the prior search result in some way, so a future
            // duplicate search is no longer the same stuck pattern.
            failedClickCountSinceProgress = 0;
          }
          searchLoopGuard.recordSuccess(
            prepared.prepared.name,
            searchToolQuery,
            toolSucceeded,
          );
          if (
            prepared.prepared.name === "click" &&
            looksLikeFailedToolOutput(outputText)
          ) {
            failedClickCountSinceProgress += 1;
            // Push a recovery hint so the model knows the click did not
            // complete and is steered toward a different target. The
            // model is free to retry the same target if it really
            // wants to — we just don't terminate the loop on retries,
            // matching the OpenAI/Ollama provider's "tell the model
            // it's wrong and let it try again" philosophy.
            currentInput.push(
              buildCodexFailedClickRecoveryInput(
                summarizeToolArg(prepared.prepared.args),
                latestToolResultPreview,
                failedClickCountSinceProgress,
                outputText,
              ),
            );
          }
          recentToolSignatures.push(toolSignature);
          if (recentToolSignatures.length > 4) {
            recentToolSignatures.shift();
          }
          const clickLoopIntervention = clickReadLoopGuard.afterToolResult(
            prepared.prepared.name,
            outputText,
            toolSucceeded,
          );
          if (clickLoopIntervention?.kind === "nudge") {
            currentInput.push({
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: clickLoopIntervention.message }],
            });
          }
          correctionCount = 0;
        }
        if (correctionCount >= 2) {
          currentInput.push({
            type: "message",
            role: "user",
            content: [{
              type: "input_text",
              text:
                `[System] You are calling unsupported, malformed, or repeated tools. Stop inventing tool names or repeating actions. Use the supported browser tools to take the next concrete step for the original task.`,
            }],
          });
        }
      }
      if (iterationsUsed >= maxIterations) {
        onChunk(`\n\n[Reached maximum tool call limit (${maxIterations} steps). You can adjust this in Settings → Max Tool Iterations, or continue by sending another message.]`);
      }
    } catch (err: unknown) {
      if ((err as { name?: string }).name !== "AbortError") {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Codex streamAgentQuery error:", err);
        onChunk(`\n\n[Error: ${msg}]`);
      }
    } finally {
      this.abortController = null;
      onEnd();
    }
  }

  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }
}
