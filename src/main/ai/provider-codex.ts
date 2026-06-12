import type Anthropic from "@anthropic-ai/sdk";
import type { AIMessage, CodexOAuthTokens } from "../../shared/types";
import type { AIProvider } from "./provider";
import type { AgentToolProfile } from "./tool-profile";
import { refreshAccessToken } from "./codex-oauth";
import { writeStoredCodexTokens, clearStoredCodexTokens } from "../config/settings";
import { createLogger } from "../../shared/logger";
import { getEffectiveMaxIterations } from "../premium/manager";
import { TERMINAL_TOOL_RESULT } from "./tool-control";
import { isClickReadLoop, hasRecentDuplicateToolCall } from "./tool-guardrails";
import { isRichToolResult, type TextBlock } from "./tool-result";
import {
  coerceToolArgsForExecution,
  isTargetlessClickArgs,
  parseToolArgsWithRepair,
  recoverNarratedActionToolCalls,
  recoverTextEncodedToolCalls,
  resolveToolCallName,
  stableToolSignature,
  unsupportedToolHint,
} from "./provider-openai-tools";

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
  return [args.url, args.query, args.text, args.direction]
    .map((value): string => typeof value === "string" ? value : "")
    .find((value) => value.length > 0) ?? "";
}

function looksLikeFailedToolOutput(output: string): boolean {
  const normalized = output.trim().toLowerCase();
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

function emitCodexToolChunk(
  onChunk: (text: string) => void,
  name: string,
  args: Record<string, unknown>,
  output: string,
): void {
  const argSummary = looksLikeFailedToolOutput(output)
    ? "⚠ failed"
    : summarizeToolArg(args);
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

function buildCodexLatestStateReminder(toolResultPreview: string | null): string {
  const text = (toolResultPreview || "").trim();
  if (!text) return "";

  const stateMatch = text.match(
    /\[state:\s+url=([^,\]\n]+),\s+title=(?:"([^"]*)"|([^,\]\n]+))/i,
  );
  if (stateMatch) {
    const url = stateMatch[1]?.trim();
    const title = (stateMatch[2] ?? stateMatch[3] ?? "").trim();
    if (url) {
      return `Latest browser state: URL ${url}${title ? `, title "${title}"` : ""}. Trust the latest tool result over the initial page context.`;
    }
  }

  const navigatedUrl = text.match(/\b(?:navigated to|went back to|went forward to|searched "[^"]+"(?: \(via search button\))? ->)\s+([^\s\n]+)/i)?.[1]?.trim();
  const pageTitle = text.match(/\bPage title:\s*([^\n]+)/i)?.[1]?.trim();
  if (navigatedUrl) {
    return `Latest browser state: URL ${navigatedUrl}${pageTitle ? `, title "${pageTitle}"` : ""}. Trust the latest tool result over the initial page context.`;
  }

  return "";
}

function wantsHighlightCompletion(userMessage: string): boolean {
  return /\b(highlight|mark|annotate)\b/i.test(userMessage);
}

function shouldRetryCodexToolLoop(
  text: string,
  hasToolHistory: boolean,
  options: { requiresHighlight: boolean; hasHighlighted: boolean },
): boolean {
  if (!hasToolHistory) return false;

  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return true;

  if (options.requiresHighlight && !options.hasHighlighted) {
    return true;
  }

  const handoffSignals = [
    "if you want",
    "if helpful",
    "would you like",
    "what would you like",
    "want me to",
    "let me know",
    "i can:",
    "i could:",
  ];
  const navigationOnlySignals = [
    "i've navigated",
    "i have navigated",
    "i’ve navigated",
    "i navigated",
  ];
  const futureActionSignals = [
    "i'll now",
    "i will now",
    "next, i'll",
    "next, i will",
  ];
  const completionSignals = [
    "i highlighted",
    "i've highlighted",
    "i have highlighted",
    "highlighted them",
    "here are",
    "i found",
    "i identified",
    "summary:",
    "\n1.",
    "\n- ",
  ];

  const looksComplete = completionSignals.some((signal) => trimmed.includes(signal));
  if (looksComplete) return false;

  return (
    handoffSignals.some((signal) => trimmed.includes(signal)) ||
    navigationOnlySignals.some((signal) => trimmed.includes(signal)) ||
    futureActionSignals.some((signal) => trimmed.includes(signal))
  );
}

function buildCodexRecoveryInput(
  userMessage: string,
  assistantText: string,
  latestToolResultPreview: string | null,
  options: { requiresHighlight: boolean; hasHighlighted: boolean },
): CodexInputItem {
  const stateReminder = buildCodexLatestStateReminder(latestToolResultPreview);
  const lines = [
    `[System] The task is still in progress: ${userMessage}`,
    `Do not ask the user what they want next unless the original request is genuinely ambiguous or blocked.`,
    `Your last response stopped after an intermediate browser action: ${previewToolResult(assistantText, 500) || "(no assistant text)"}`,
    `Continue the original task by choosing the next supported browser tool now.`,
  ];
  if (options.requiresHighlight && !options.hasHighlighted) {
    lines.push(
      `The user explicitly asked you to highlight items. Do not finish until you have called the highlight tool on the selected page items.`,
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

function buildCodexHighlightFollowUpInput(
  userMessage: string,
  latestToolResultPreview: string | null,
): CodexInputItem {
  const stateReminder = buildCodexLatestStateReminder(latestToolResultPreview);
  const lines = [
    `[System] Continue the highlight task: ${userMessage}`,
    `The next step is to choose the highest-signal visible/reported items and call the highlight tool for them.`,
    `Do not ask the user what to open next. Do not summarize instead of highlighting.`,
    `If you need the visible story titles or element indexes, call read_page with a narrow mode first; otherwise call highlight now.`,
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

function cleanHighlightCandidate(text: string): string {
  return text
    .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
    .replace(/^\s*\[#\d+\]\s*/, "")
    .replace(/^\[([^\]]+)\]$/, "$1")
    .replace(/\s+\((?:link|button|input|select|text input|checkbox|radio)\)(?:\s*->\s*\S+)?\s*$/i, "")
    .replace(/\s*->\s*\S+\s*$/i, "")
    .replace(/\s*\(\d+\s+points?\)\s*$/i, "")
    .replace(/\s*-\s*\d+\s+points?\s*$/i, "")
    .replace(/^["'“”]+|["'“”.,:;]+$/g, "")
    .trim();
}

function isLowValueHighlightCandidate(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return true;

  return (
    /^\d+\s+(?:minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)\s+ago$/.test(normalized) ||
    /^\d+\s+comments?$/.test(normalized) ||
    /^(?:discuss|hide|past|favorite|flag|parent|next|more|reply|login|submit)$/.test(normalized) ||
    /^by\s+[a-z0-9_-]{2,}$/i.test(text.trim())
  );
}

function extractHighlightCandidates(text: string, limit = 5): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const addCandidate = (raw: string) => {
    const candidate = cleanHighlightCandidate(raw);
    if (candidate.length < 8 || candidate.length > 180) return;
    if (isLowValueHighlightCandidate(candidate)) return;
    const key = candidate.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  for (const line of text.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const pointsMatch = trimmed.match(/^(.+?)\s*\((\d+)\s+points?\)\s*$/i);
    if (pointsMatch?.[1]) {
      addCandidate(pointsMatch[1]);
      if (candidates.length >= limit) return candidates;
      continue;
    }

    const rankedPointsMatch = trimmed.match(/^\s*(?:[-*•]|\d+[.)])\s*(.+?)\s+-\s+\d+\s+points?\s*$/i);
    if (rankedPointsMatch?.[1]) {
      addCandidate(rankedPointsMatch[1]);
      if (candidates.length >= limit) return candidates;
      continue;
    }

    const indexedResultMatch = trimmed.match(/^\s*[-*•]?\s*(\[#\d+\]\s+.+)$/);
    if (indexedResultMatch?.[1]) {
      addCandidate(indexedResultMatch[1]);
      if (candidates.length >= limit) return candidates;
      continue;
    }

    const bracketedTitleMatch = trimmed.match(/^\s*[-*•]?\s*\[#\d+\]\s*\[([^\]]+)\]/);
    if (bracketedTitleMatch?.[1]) {
      addCandidate(bracketedTitleMatch[1]);
      if (candidates.length >= limit) return candidates;
    }

    const linkLineMatch = trimmed.match(/^\s*[-*•]?\s*(.+?\s+\((?:link|article|story)\)\s*->\s*\S+)\s*$/i);
    if (linkLineMatch?.[1]) {
      addCandidate(linkLineMatch[1]);
      if (candidates.length >= limit) return candidates;
    }
  }

  if (candidates.length === 0) {
    const resultsMatch = text.match(/\b(?:items?|stories|results):\s*([^\n]+)/i);
    const rawResults = (resultsMatch?.[1] ?? "").replace(/\s*\[state:.*$/i, "");
    for (const item of rawResults.split(/\s*;\s*/)) {
      addCandidate(item);
      if (candidates.length >= limit) return candidates;
    }
  }

  return candidates;
}

async function forceHighlightCandidates(
  sourceText: string,
  onChunk: (text: string) => void,
  onToolCall: (name: string, args: Record<string, unknown>) => Promise<string>,
): Promise<boolean> {
  const candidates = extractHighlightCandidates(sourceText, 5);
  if (candidates.length === 0) return false;

  let highlighted = 0;
  for (const candidate of candidates) {
    const output = await onToolCall("highlight", { text: candidate });
    emitCodexToolChunk(onChunk, "highlight", { text: candidate }, output);
    if (!looksLikeFailedToolOutput(output)) {
      highlighted += 1;
    }
  }
  if (highlighted === 0) return false;
  onChunk(
    `\nHighlighted ${highlighted} high-signal ${highlighted === 1 ? "story" : "stories"}.`,
  );
  return true;
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
    let correctionCount = 0;
    const recentToolSignatures: string[] = [];
    const recentToolNames: string[] = [];
    let consecutiveReadPageSignature: string | null = null;
    let consecutiveReadPageCount = 0;
    let readPageCount = 0;
    let clickReadLoopNudged = false;
    let latestToolResultPreview: string | null = null;
    let accumulatedReadPageResults = "";
    const requiresHighlight = wantsHighlightCompletion(userMessage);
    let hasHighlighted = false;
    let completedByFallback = false;

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
          const recoveredTextCalls = recoverTextEncodedToolCalls(
            result.text,
            availableToolNames,
          );
          const recoveredCalls =
            recoveredTextCalls.length > 0
              ? recoveredTextCalls
              : recoverNarratedActionToolCalls(result.text, availableToolNames);
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
            requiresHighlight &&
            !hasHighlighted &&
            availableToolNames.has("highlight")
          ) {
            const highlighted = await forceHighlightCandidates(
              `${latestToolResultPreview || ""}\n${result.text}`,
              onChunk,
              onToolCall,
            );
            if (highlighted) {
              hasHighlighted = true;
              break;
            }
          }
          if (
            recoveryCount < 2 &&
            shouldRetryCodexToolLoop(result.text, toolHistoryCount > 0, {
              requiresHighlight,
              hasHighlighted,
            })
          ) {
            recoveryCount += 1;
            if (result.text.trim()) onChunk("<<erase_prev>>");
            currentInput = [
              buildCodexRecoveryInput(
                userMessage,
                result.text,
                latestToolResultPreview,
                { requiresHighlight, hasHighlighted },
              ),
            ];
            continue;
          }
          break;
        }
        recoveryCount = 0;

        currentInput = [];
        let iterationHasHighlight = false;
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
          const isRepeatedReadPageBySignature =
            prepared.prepared.name === "read_page" &&
            consecutiveReadPageSignature === toolSignature &&
            consecutiveReadPageCount >= 2;
          const isOverHighlightReadBudget =
            requiresHighlight &&
            !hasHighlighted &&
            prepared.prepared.name === "read_page" &&
            readPageCount >= 2;
          const isNonHighlightAfterReadBudget =
            requiresHighlight &&
            !hasHighlighted &&
            readPageCount >= 2 &&
            prepared.prepared.name !== "highlight";
          if (
            isRepeatedReadPageBySignature ||
            isOverHighlightReadBudget ||
            isNonHighlightAfterReadBudget
          ) {
            if (
              requiresHighlight &&
              !hasHighlighted &&
              availableToolNames.has("highlight") &&
              await forceHighlightCandidates(
                `${accumulatedReadPageResults}\n${latestToolResultPreview || ""}`,
                onChunk,
                onToolCall,
              )
            ) {
              hasHighlighted = true;
              completedByFallback = true;
              break;
            }
            onChunk(`\n<<tool:${prepared.prepared.name}:↻ duplicate suppressed>>\n`);
            const output = createCodexToolOutput(
              prepared.prepared.callId,
              requiresHighlight
                ? `Error: You have enough page context for the highlight task. Do not call ${prepared.prepared.name} now. Choose the highest-signal visible items from the current page results and call highlight now.`
                : `Error: You have already read the same page state twice in a row. Do not call read_page again with the same arguments. Use the current page results to take the next requested action, such as highlight, click, inspect_element, or provide the final answer.`,
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
          if (prepared.prepared.name === "highlight") {
            hasHighlighted = true;
            iterationHasHighlight = true;
          }
          latestToolResultPreview = previewToolResult(output.output);
          if (prepared.prepared.name === "read_page") {
            readPageCount += 1;
            accumulatedReadPageResults = `${accumulatedReadPageResults}\n${output.output}`.trim();
            if (consecutiveReadPageSignature === toolSignature) {
              consecutiveReadPageCount += 1;
            } else {
              consecutiveReadPageSignature = toolSignature;
              consecutiveReadPageCount = 1;
            }
          } else {
            consecutiveReadPageSignature = null;
            consecutiveReadPageCount = 0;
          }
          recentToolSignatures.push(toolSignature);
          if (recentToolSignatures.length > 4) {
            recentToolSignatures.shift();
          }
          recentToolNames.push(prepared.prepared.name);
          if (recentToolNames.length > 8) recentToolNames.shift();
          if (
            !clickReadLoopNudged &&
            recentToolNames.length >= 6 &&
            isClickReadLoop(recentToolNames)
          ) {
            clickReadLoopNudged = true;
            currentInput.push({
              type: "message",
              role: "user",
              content: [{
                type: "input_text",
                text:
                  `[System] You are alternating between click and read_page without advancing the task. ` +
                  `The click result already includes a page snapshot when it navigates, so do not read_page after every click. ` +
                  `If you need detail on a specific element, use inspect_element. Otherwise continue the original task directly.`,
              }],
            });
          }
          correctionCount = 0;
        }
        if (completedByFallback) break;
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
        if (
          requiresHighlight &&
          !hasHighlighted &&
          !iterationHasHighlight &&
          availableToolNames.has("highlight")
        ) {
          currentInput.push(
            buildCodexHighlightFollowUpInput(
              userMessage,
              latestToolResultPreview,
            ),
          );
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
