import type Anthropic from "@anthropic-ai/sdk";
import type { AIMessage, CodexOAuthTokens } from "../../shared/types";
import type { AIProvider } from "./provider";
import type { AgentToolProfile } from "./tool-profile";
import { refreshAccessToken } from "./codex-oauth";
import { writeStoredCodexTokens, clearStoredCodexTokens } from "../config/settings";
import { createLogger } from "../../shared/logger";

const logger = createLogger("CodexProvider");

const REFRESH_WINDOW_MS = 5 * 60 * 1000; // refresh if expiring within 5 min
const CODEX_BACKEND_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_CLIENT_VERSION = "0.129.0";

interface CodexResponsesStreamEvent {
  type?: string;
  delta?: string;
  response?: {
    error?: {
      code?: string;
      message?: string;
      type?: string;
    };
  };
  item?: {
    content?: Array<{ type?: string; text?: string }>;
  };
}

type CodexInputContent = { type: "input_text" | "output_text"; text: string };

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

  private backendHeaders(): Record<string, string> {
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
    return headers;
  }

  private buildInput(
    userMessage: string,
    history?: AIMessage[],
  ): Array<{ type: "message"; role: string; content: CodexInputContent[] }> {
    const input: Array<{
      type: "message";
      role: string;
      content: CodexInputContent[];
    }> = [];

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
    emittedTextFromDelta: { value: boolean },
  ): void {
    if (!raw.trim() || raw.trim() === "[DONE]") return;

    let event: CodexResponsesStreamEvent;
    try {
      event = JSON.parse(raw) as CodexResponsesStreamEvent;
    } catch {
      return;
    }

    if (event.type === "response.output_text.delta" && event.delta) {
      emittedTextFromDelta.value = true;
      onChunk(event.delta);
      return;
    }

    if (event.type === "response.output_item.done" && !emittedTextFromDelta.value) {
      const text = event.item?.content
        ?.filter((item) => item.type === "output_text" && item.text)
        .map((item) => item.text)
        .join("");
      if (text) onChunk(text);
      return;
    }

    if (event.type === "response.failed") {
      const error = event.response?.error;
      const message = error?.message || error?.code || "Codex response failed";
      throw new Error(message);
    }
  }

  private async streamCodexResponse(
    systemPrompt: string,
    userMessage: string,
    onChunk: (text: string) => void,
    history?: AIMessage[],
  ): Promise<void> {
    const response = await fetch(`${CODEX_BACKEND_BASE_URL}/responses`, {
      method: "POST",
      headers: this.backendHeaders(),
      signal: this.abortController?.signal,
      body: JSON.stringify({
        model: this.model,
        instructions: systemPrompt,
        input: this.buildInput(userMessage, history),
        stream: true,
        store: false,
      }),
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

    const reader = response.body.getReader();
    try {
      const decoder = new TextDecoder();
      let buffer = "";
      const emittedTextFromDelta = { value: false };

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
          this.handleStreamEvent(data, onChunk, emittedTextFromDelta);
        }
      }

      const trailing = buffer.trim();
      if (trailing) {
        const data = trailing
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        this.handleStreamEvent(data, onChunk, emittedTextFromDelta);
      }
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
      await this.streamCodexResponse(systemPrompt, userMessage, onChunk, history);
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
    _tools: Anthropic.Tool[],
    onChunk: (text: string) => void,
    _onToolCall: (name: string, args: Record<string, unknown>) => Promise<string>,
    onEnd: () => void,
    history?: AIMessage[],
  ): Promise<void> {
    // TODO: Codex Responses backend supports tools via FunctionCallOutput items.
    // Wire _tools / _onToolCall into the backend input array for full agent support.
    await this.ensureFreshTokens();
    this.abortController = new AbortController();

    try {
      await this.streamCodexResponse(systemPrompt, userMessage, onChunk, history);
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
