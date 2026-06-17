import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider } from "./provider";
import type { AIMessage, ReasoningEffortLevel } from "../../shared/types";
import { isRichToolResult, type RichToolResult } from "./tool-result";
import { getEffectiveMaxIterations } from "../premium/manager";
import type { AgentToolProfile } from "./tool-profile";
import { ClickReadLoopGuard } from "./tool-guardrails";
import { AGENT_STREAM_IDLE_TIMEOUT_MS } from "../config/timing";
import { TERMINAL_TOOL_RESULT } from "./tool-control";
import {
  anthropicCachedSystem,
  anthropicCachedTools,
  logAnthropicPromptCacheUsage,
} from "./prompt-cache";

const ANTHROPIC_MAX_TOKENS = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function anthropicModelLikelySupportsThinking(model: string): boolean {
  return /claude-(?:opus|sonnet|haiku)-4/i.test(model.trim());
}

export function toAnthropicThinkingConfig(
  effort: ReasoningEffortLevel | undefined,
  model: string,
): Anthropic.ThinkingConfigParam | undefined {
  if (!effort || effort === "off" || !anthropicModelLikelySupportsThinking(model)) {
    return undefined;
  }

  const budgetByEffort: Record<Exclude<ReasoningEffortLevel, "off">, number> = {
    low: 1024,
    medium: 2048,
    high: 3072,
    max: 3584,
  };

  return {
    type: "enabled",
    budget_tokens: budgetByEffort[effort],
  };
}

export class AnthropicProvider implements AIProvider {
  readonly agentToolProfile: AgentToolProfile = "default";

  private client: Anthropic;
  private model: string;
  private reasoningEffort: ReasoningEffortLevel;
  private abortController: AbortController | null = null;

  constructor(
    apiKey: string,
    model: string,
    reasoningEffort: ReasoningEffortLevel = "off",
  ) {
    this.client = new Anthropic({ apiKey });
    this.model = model || "claude-sonnet-4-20250514";
    this.reasoningEffort = reasoningEffort;
  }

  async streamQuery(
    systemPrompt: string,
    userMessage: string,
    onChunk: (text: string) => void,
    onEnd: () => void,
    history?: AIMessage[],
  ): Promise<void> {
    this.abortController = new AbortController();

    const messages: Anthropic.MessageParam[] = [
      ...(history ?? []).map((m) => ({ role: m.role, content: m.content } as Anthropic.MessageParam)),
      { role: "user", content: userMessage },
    ];
    const thinking = toAnthropicThinkingConfig(this.reasoningEffort, this.model);

    try {
      const stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: ANTHROPIC_MAX_TOKENS,
          system: anthropicCachedSystem(systemPrompt),
          messages,
          ...(thinking ? { thinking } : {}),
        },
        { signal: this.abortController.signal },
      );

      for await (const event of stream) {
        if (event.type === "message_start") {
          logAnthropicPromptCacheUsage(event.message.usage, {
            model: this.model,
            mode: "chat",
          });
        }
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          onChunk(event.delta.text);
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "AbortError") {
        onChunk(`\n\n[Error: ${err.message}]`);
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
    this.abortController = new AbortController();

    const messages: Anthropic.MessageParam[] = [
      ...(history ?? []).map((m) => ({ role: m.role, content: m.content } as Anthropic.MessageParam)),
      { role: "user", content: userMessage },
    ];
    const thinking = toAnthropicThinkingConfig(this.reasoningEffort, this.model);

    try {
      const maxIterations = getEffectiveMaxIterations();
      let iterationsUsed = 0;
      const clickReadLoopGuard = new ClickReadLoopGuard();
      for (let i = 0; i < maxIterations; i++) {
        iterationsUsed = i + 1;
        const stream = this.client.messages.stream(
          {
            model: this.model,
            max_tokens: ANTHROPIC_MAX_TOKENS,
            system: anthropicCachedSystem(systemPrompt),
            messages,
            tools: anthropicCachedTools(tools),
            ...(thinking ? { thinking } : {}),
          },
          { signal: this.abortController.signal },
        );

        let textContent = "";
        const toolUseBlocks: Array<{
          id: string;
          name: string;
          input: Record<string, unknown>;
          _malformedArgs?: string;
        }> = [];
        let currentToolUse: {
          id: string;
          name: string;
          inputJson: string;
        } | null = null;

        // Idle timeout: if no streaming events arrive for 30s, abort.
        // Prevents the agent from hanging indefinitely on slow API responses.
        const STREAM_IDLE_TIMEOUT_MS = AGENT_STREAM_IDLE_TIMEOUT_MS;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        const resetIdleTimer = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            this.abortController?.abort();
          }, STREAM_IDLE_TIMEOUT_MS);
        };
        resetIdleTimer();

        try {
          for await (const event of stream) {
            resetIdleTimer();
            if (event.type === "message_start") {
              logAnthropicPromptCacheUsage(event.message.usage, {
                model: this.model,
                mode: "agent",
              });
            }
            if (event.type === "content_block_start") {
              if (event.content_block.type === "tool_use") {
                currentToolUse = {
                  id: event.content_block.id,
                  name: event.content_block.name,
                  inputJson: "",
                };
              }
            } else if (event.type === "content_block_delta") {
              if (event.delta.type === "text_delta") {
                textContent += event.delta.text;
                onChunk(event.delta.text);
              } else if (
                event.delta.type === "input_json_delta" &&
                currentToolUse
              ) {
                currentToolUse.inputJson += event.delta.partial_json;
              }
            } else if (event.type === "content_block_stop" && currentToolUse) {
              try {
                const input = JSON.parse(currentToolUse.inputJson || "{}");
                if (!isRecord(input)) {
                  throw new Error("Tool input must be a JSON object");
                }
                toolUseBlocks.push({
                  id: currentToolUse.id,
                  name: currentToolUse.name,
                  input,
                });
              } catch {
                // Track the malformed args so we can send an error result
                // instead of executing the tool with empty args
                toolUseBlocks.push({
                  id: currentToolUse.id,
                  name: currentToolUse.name,
                  input: {},
                  _malformedArgs: currentToolUse.inputJson,
                });
              }
              currentToolUse = null;
            }
          }
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
        }

        const finalMessage = await stream.finalMessage();

        // Build assistant message content for history
        const assistantContent: Anthropic.ContentBlockParam[] = [];
        for (const block of finalMessage.content) {
          if (block.type === "thinking") {
            assistantContent.push({
              type: "thinking",
              thinking: block.thinking,
              signature: block.signature,
            });
          } else if (block.type === "redacted_thinking") {
            assistantContent.push({
              type: "redacted_thinking",
              data: block.data,
            });
          }
        }
        if (textContent) {
          assistantContent.push({ type: "text", text: textContent });
        }
        for (const tb of toolUseBlocks) {
          assistantContent.push({
            type: "tool_use",
            id: tb.id,
            name: tb.name,
            input: tb.input,
          });
        }
        messages.push({ role: "assistant", content: assistantContent });

        // If no tool calls, we're done
        if (toolUseBlocks.length === 0) {
          break;
        }

        // Execute tools and build tool_result messages
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        const loopNudges: string[] = [];
        for (const tb of toolUseBlocks) {
          // If the model sent malformed JSON args, send an error instead of executing
          if (tb._malformedArgs !== undefined) {
            onChunk(`\n<<tool:${tb.name}:⚠ invalid args>>\n`);
            toolResults.push({
              type: "tool_result",
              tool_use_id: tb.id,
              content: `Error: Invalid JSON in tool arguments — could not parse. Please retry with valid JSON. Raw input: ${tb._malformedArgs.slice(0, 200)}`,
              is_error: true,
            });
            continue;
          }

          const clickLoopPreflight = clickReadLoopGuard.beforeTool(tb.name);
          if (clickLoopPreflight?.kind === "suppress") {
            onChunk(`\n<<tool:click:↻ loop suppressed>>\n`);
            toolResults.push({
              type: "tool_result",
              tool_use_id: tb.id,
              content: clickLoopPreflight.message,
              is_error: true,
            });
            continue;
          }

          const argSummary = [tb.input.url, tb.input.query, tb.input.text, tb.input.direction]
            .map((v): string => typeof v === "string" ? v : "")
            .find((v) => v.length > 0) ?? "";
          onChunk(`\n<<tool:${tb.name}${argSummary ? ":" + argSummary : ""}>>\n`);
          let result: string;
          try {
            result = await onToolCall(tb.name, tb.input);
          } catch (toolErr: unknown) {
            const msg = toolErr instanceof Error ? toolErr.message : String(toolErr);
            result = `Error: Tool execution failed — ${msg}. Try a different approach or call read_page to refresh context.`;
          }
          if (result === TERMINAL_TOOL_RESULT) {
            return;
          }

          const toolSucceeded = !/^Error:/i.test(result.trim());

          // Check if the result contains rich content (images)
          let parsedRich: RichToolResult | null = null;
          try {
            const parsed = JSON.parse(result);
            if (isRichToolResult(parsed)) parsedRich = parsed;
          } catch {
            // Not JSON — plain string result
          }

          if (parsedRich) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: tb.id,
              content: parsedRich.content.map((block) => {
                if (block.type === "image") {
                  return {
                    type: "image" as const,
                    source: {
                      type: "base64" as const,
                      media_type: block.mediaType,
                      data: block.base64,
                    },
                  };
                }
                return { type: "text" as const, text: block.text };
              }),
            });
          } else {
            toolResults.push({
              type: "tool_result",
              tool_use_id: tb.id,
              content: result,
            });
          }

          const clickLoopIntervention = clickReadLoopGuard.afterToolResult(
            tb.name,
            result,
            toolSucceeded,
          );
          if (clickLoopIntervention?.kind === "nudge") {
            loopNudges.push(clickLoopIntervention.message);
          }
        }
        messages.push({ role: "user", content: toolResults });
        for (const nudge of loopNudges) {
          messages.push({ role: "user", content: nudge });
        }
      }
      if (iterationsUsed >= maxIterations) {
        onChunk(`\n\n[Reached maximum tool call limit (${maxIterations} steps). You can adjust this in Settings → Max Tool Iterations, or continue by sending another message.]`);
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "AbortError") {
        onChunk(`\n\n[Error: ${err.message}]`);
      }
    } finally {
      this.abortController = null;
      onEnd();
    }
  }

  cancel(): void {
    this.abortController?.abort();
  }
}
