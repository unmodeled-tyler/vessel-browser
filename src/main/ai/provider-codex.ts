import type Anthropic from "@anthropic-ai/sdk";
import type { AIMessage, CodexOAuthTokens } from "../../shared/types";
import type { AIProvider } from "./provider";
import type { AgentToolProfile } from "./tool-profile";
import { refreshAccessToken } from "./codex-oauth";
import { writeStoredCodexTokens, clearStoredCodexTokens } from "../config/settings";
import { createLogger } from "../../shared/logger";
import { getEffectiveMaxIterations } from "../premium/manager";

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
  | { type: "function_call_output"; call_id: string; output: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function createCodexFunctionCallOutput(
  functionCall: CodexOutputItem,
  availableToolNames: ReadonlySet<string>,
  onChunk: (text: string) => void,
  onToolCall: (name: string, args: Record<string, unknown>) => Promise<string>,
): Promise<CodexInputItem> {
  const callId = functionCall.call_id || functionCall.id || "";
  const name = functionCall.name || "";

  if (!callId) {
    return {
      type: "function_call_output",
      call_id: callId,
      output: "Error: Function call was missing a call_id. Please retry the tool call.",
    };
  }

  if (!name || !availableToolNames.has(name)) {
    onChunk(`\n<<tool:${name || "unknown"}:⚠ unsupported>>\n`);
    return {
      type: "function_call_output",
      call_id: callId,
      output: `Error: Unsupported tool${name ? `: ${name}` : ""}. Use one of the provided tools.`,
    };
  }

  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(functionCall.arguments || "{}");
    if (!isRecord(parsed)) throw new Error("Tool arguments must be a JSON object");
    args = parsed;
  } catch {
    onChunk(`\n<<tool:${name}:⚠ invalid args>>\n`);
    return {
      type: "function_call_output",
      call_id: callId,
      output: "Error: Invalid JSON in tool arguments. Please retry with a valid JSON object.",
    };
  }

  const output = await onToolCall(name, args);
  return {
    type: "function_call_output",
    call_id: callId,
    output,
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
    this.agentToolProfile = "default";
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

        const functionCalls = result.items.filter(
          (item): item is CodexOutputItem & { type: "function_call" } =>
            item.type === "function_call",
        );

        if (functionCalls.length === 0) {
          break;
        }

        // The Codex backend tracks conversation state via x-codex-turn-state,
        // so follow-up requests only need to supply the function_call_output items.
        currentInput = [];
        for (const fc of functionCalls) {
          currentInput.push(
            await createCodexFunctionCallOutput(
              fc,
              availableToolNames,
              onChunk,
              onToolCall,
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
