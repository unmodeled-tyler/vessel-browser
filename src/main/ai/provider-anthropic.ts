import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider } from "./provider";
import type { AIMessage } from "../../shared/types";
import { isRichToolResult, type RichToolResult } from "./tool-result";
import { getEffectiveMaxIterations } from "../premium/manager";
import type { AgentToolProfile } from "./tool-profile";
import { isClickReadLoop } from "./provider-openai";

export class AnthropicProvider implements AIProvider {
  readonly agentToolProfile: AgentToolProfile = "default";

  private client: Anthropic;
  private model: string;
  private abortController: AbortController | null = null;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model || "claude-sonnet-4-20250514";
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

    try {
      const stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: 4096,
          system: systemPrompt,
          messages,
        },
        { signal: this.abortController.signal },
      );

      for await (const event of stream) {
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
    onToolCall: (name: string, args: Record<string, any>) => Promise<string>,
    onEnd: () => void,
    history?: AIMessage[],
  ): Promise<void> {
    this.abortController = new AbortController();

    const messages: Anthropic.MessageParam[] = [
      ...(history ?? []).map((m) => ({ role: m.role, content: m.content } as Anthropic.MessageParam)),
      { role: "user", content: userMessage },
    ];

    try {
      const maxIterations = getEffectiveMaxIterations();
      let iterationsUsed = 0;
      const recentToolNames: string[] = [];
      let clickReadLoopNudged = false;
      for (let i = 0; i < maxIterations; i++) {
        iterationsUsed = i + 1;
        const stream = this.client.messages.stream(
          {
            model: this.model,
            max_tokens: 4096,
            system: systemPrompt,
            messages,
            tools,
          },
          { signal: this.abortController.signal },
        );

        let textContent = "";
        const toolUseBlocks: Array<{
          id: string;
          name: string;
          input: Record<string, any>;
          _malformedArgs?: string;
        }> = [];
        let currentToolUse: {
          id: string;
          name: string;
          inputJson: string;
        } | null = null;

        // Idle timeout: if no streaming events arrive for 30s, abort.
        // Prevents the agent from hanging indefinitely on slow API responses.
        const STREAM_IDLE_TIMEOUT_MS = 30_000;
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
                toolUseBlocks.push({
                  id: currentToolUse.id,
                  name: currentToolUse.name,
                  input: JSON.parse(currentToolUse.inputJson || "{}"),
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

          const argSummary = tb.input.url || tb.input.text || tb.input.direction || "";
          onChunk(`\n<<tool:${tb.name}${argSummary ? ":" + argSummary : ""}>>\n`);
          let result: string;
          try {
            result = await onToolCall(tb.name, tb.input);
          } catch (toolErr: unknown) {
            const msg = toolErr instanceof Error ? toolErr.message : String(toolErr);
            result = `Error: Tool execution failed — ${msg}. Try a different approach or call read_page to refresh context.`;
          }

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

          // Track tool names for click→read_page loop detection
          recentToolNames.push(tb.name);
          if (recentToolNames.length > 8) recentToolNames.shift();
        }
        messages.push({ role: "user", content: toolResults });

        // Detect click→read_page alternating loop and inject a nudge
        if (
          !clickReadLoopNudged &&
          recentToolNames.length >= 6 &&
          isClickReadLoop(recentToolNames)
        ) {
          clickReadLoopNudged = true;
          messages.push({
            role: "user",
            content:
              `You are alternating between click and read_page without advancing the task. ` +
              `The click result already includes a page snapshot when it navigates — you do not need read_page after every click. ` +
              `If you need detail on a specific element, use inspect_element instead. ` +
              `If you have enough context, proceed with the next action directly.`,
          });
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
