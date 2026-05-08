import OpenAI from "openai";
import type Anthropic from "@anthropic-ai/sdk";
import type { AIMessage, CodexOAuthTokens } from "../../shared/types";
import type { AIProvider } from "./provider";
import type { AgentToolProfile } from "./tool-profile";
import { refreshAccessToken } from "./codex-oauth";
import { readStoredCodexTokens, writeStoredCodexTokens, clearStoredCodexTokens } from "../config/settings";
import { createLogger } from "../../shared/logger";

const logger = createLogger("CodexProvider");

const REFRESH_WINDOW_MS = 5 * 60 * 1000; // refresh if expiring within 5 min

export class CodexProvider implements AIProvider {
  readonly agentToolProfile: AgentToolProfile;
  private tokens: CodexOAuthTokens;
  private model: string;
  private baseUrl: string;
  private abortController: AbortController | null = null;

  constructor(tokens: CodexOAuthTokens, model: string, baseUrl?: string) {
    this.tokens = tokens;
    this.model = model;
    this.baseUrl = baseUrl || "https://api.openai.com/v1";
    this.agentToolProfile = "default";
  }

  private async ensureFreshTokens(): Promise<void> {
    if (Date.now() < this.tokens.expiresAt - REFRESH_WINDOW_MS) return;

    try {
      logger.info("Refreshing Codex access token");
      const fresh = await refreshAccessToken(this.tokens.refreshToken);
      this.tokens = fresh;
      writeStoredCodexTokens(fresh);
    } catch (err) {
      clearStoredCodexTokens();
      throw new Error(
        `Codex token refresh failed — please re-authenticate. ${err instanceof Error ? err.message : ""}`,
      );
    }
  }

  private createClient(): OpenAI {
    return new OpenAI({
      apiKey: this.tokens.accessToken,
      baseURL: this.baseUrl,
    });
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

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
    ];

    if (history) {
      for (const msg of history) {
        messages.push({
          role: msg.role as "user" | "assistant",
          content: msg.content,
        });
      }
    }

    messages.push({ role: "user", content: userMessage });

    try {
      const stream = await this.createClient().chat.completions.create(
        {
          model: this.model,
          messages,
          stream: true,
        },
        { signal: this.abortController.signal },
      );

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) onChunk(delta);
      }

      onEnd();
    } catch (err: unknown) {
      if ((err as { name?: string }).name === "AbortError") {
        onEnd();
        return;
      }
      logger.error("Codex streamQuery error:", err);
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

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
    ];

    if (history) {
      for (const msg of history) {
        messages.push({
          role: msg.role as "user" | "assistant",
          content: msg.content,
        });
      }
    }

    messages.push({ role: "user", content: userMessage });

    const openaiTools: OpenAI.Chat.Completions.ChatCompletionTool[] = tools.map(
      (tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: tool.input_schema as Record<string, unknown>,
        },
      }),
    );

    try {
      let continueLoop = true;
      let currentMessages = [...messages];

      while (continueLoop) {
        const stream = await this.createClient().chat.completions.create(
          {
            model: this.model,
            messages: currentMessages,
            tools: openaiTools,
            stream: true,
          },
          { signal: this.abortController.signal },
        );

        let contentBuffer = "";
        const toolCalls: Map<
          number,
          { id: string; name: string; args: string }
        > = new Map();

        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            contentBuffer += delta.content;
            onChunk(delta.content);
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCalls.has(idx)) {
                toolCalls.set(idx, {
                  id: tc.id || "",
                  name: tc.function?.name || "",
                  args: tc.function?.arguments || "",
                });
              } else {
                const existing = toolCalls.get(idx)!;
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name += tc.function.name;
                if (tc.function?.arguments) existing.args += tc.function.arguments;
              }
            }
          }
        }

        if (toolCalls.size === 0) {
          continueLoop = false;
        } else {
          const assistantMsg: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
            role: "assistant",
            content: contentBuffer || null,
            tool_calls: Array.from(toolCalls.entries()).map(([, tc]) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.args },
            })),
          };
          currentMessages.push(assistantMsg);

          for (const [, tc] of toolCalls) {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.args);
            } catch {
              // pass empty args
            }
            const result = await onToolCall(tc.name, args);
            currentMessages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: result,
            });
          }
        }
      }

      onEnd();
    } catch (err: unknown) {
      if ((err as { name?: string }).name === "AbortError") {
        onEnd();
        return;
      }
      logger.error("Codex streamAgentQuery error:", err);
      onEnd();
    }
  }

  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }
}
