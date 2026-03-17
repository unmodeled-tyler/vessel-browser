import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider } from "./provider";
import type { AIMessage } from "../../shared/types";

const MAX_AGENT_ITERATIONS = 15;

export class AnthropicProvider implements AIProvider {
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
    } catch (err: any) {
      if (err.name !== "AbortError") {
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
  ): Promise<void> {
    this.abortController = new AbortController();

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: userMessage },
    ];

    try {
      for (let i = 0; i < MAX_AGENT_ITERATIONS; i++) {
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
        }> = [];
        let currentToolUse: {
          id: string;
          name: string;
          inputJson: string;
        } | null = null;

        for await (const event of stream) {
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
              toolUseBlocks.push({
                id: currentToolUse.id,
                name: currentToolUse.name,
                input: {},
              });
            }
            currentToolUse = null;
          }
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
        if (
          finalMessage.stop_reason !== "tool_use" ||
          toolUseBlocks.length === 0
        ) {
          break;
        }

        // Execute tools and build tool_result messages
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const tb of toolUseBlocks) {
          const argSummary = tb.input.url || tb.input.text || tb.input.direction || "";
          onChunk(`\n\`[${tb.name}${argSummary ? ": " + argSummary : ""}]\` `);
          const result = await onToolCall(tb.name, tb.input);
          toolResults.push({
            type: "tool_result",
            tool_use_id: tb.id,
            content: result,
          });
        }
        messages.push({ role: "user", content: toolResults });
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
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
