import OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import type { AIProvider } from './provider';
import type { AIMessage, ProviderConfig } from '../../shared/types';
import { PROVIDERS } from './providers';
import { loadSettings } from '../config/settings';
import { isRichToolResult } from './tool-result';

const DEFAULT_MAX_ITERATIONS = 200;

function toOpenAITools(tools: Anthropic.Tool[]): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}

export class OpenAICompatProvider implements AIProvider {
  private client: OpenAI;
  private model: string;
  private abortController: AbortController | null = null;

  constructor(config: ProviderConfig) {
    const meta = PROVIDERS[config.id];
    const baseURL =
      config.baseUrl || meta?.defaultBaseUrl || 'https://api.openai.com/v1';

    this.client = new OpenAI({
      apiKey: config.apiKey || 'ollama',
      baseURL,
    });
    this.model = config.model || meta?.defaultModel || 'gpt-4o';
  }

  async streamQuery(
    systemPrompt: string,
    userMessage: string,
    onChunk: (text: string) => void,
    onEnd: () => void,
    history?: AIMessage[],
  ): Promise<void> {
    this.abortController = new AbortController();

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...(history ?? []).map((m) => ({ role: m.role, content: m.content } as OpenAI.Chat.ChatCompletionMessageParam)),
      { role: 'user', content: userMessage },
    ];

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          stream: true,
          messages,
        },
        { signal: this.abortController.signal },
      );

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          onChunk(delta);
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
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
    const openAITools = toOpenAITools(tools);

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...(history ?? []).map((m) => ({ role: m.role, content: m.content } as OpenAI.Chat.ChatCompletionMessageParam)),
      { role: 'user', content: userMessage },
    ];

    try {
      const maxIterations = loadSettings().maxToolIterations || DEFAULT_MAX_ITERATIONS;
      let iterationsUsed = 0;
      for (let i = 0; i < maxIterations; i++) {
        iterationsUsed = i + 1;
        const msgTokenEstimate = JSON.stringify(messages).length;
        console.log(`[Vessel Agent OpenAI] iteration=${i} messages=${messages.length} msgChars=${msgTokenEstimate} tools=${openAITools.length}`);
        const streamStartTime = Date.now();
        // Accumulate text and tool calls across streamed chunks
        let textAccum = '';
        const toolCallAccums: Record<number, { id: string; name: string; argsJson: string }> = {};
        let finishReason: string | null = null;

        const stream = await this.client.chat.completions.create(
          {
            model: this.model,
            stream: true,
            messages,
            tools: openAITools,
            tool_choice: 'auto',
          },
          { signal: this.abortController.signal },
        );

        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          if (!choice) continue;

          const delta = choice.delta;
          if (choice.finish_reason) finishReason = choice.finish_reason;

          if (delta.content) {
            textAccum += delta.content;
            onChunk(delta.content);
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCallAccums[idx]) {
                toolCallAccums[idx] = { id: '', name: '', argsJson: '' };
              }
              if (tc.id) toolCallAccums[idx].id = tc.id;
              if (tc.function?.name) toolCallAccums[idx].name += tc.function.name;
              if (tc.function?.arguments) toolCallAccums[idx].argsJson += tc.function.arguments;
            }
          }
        }

        console.log(`[Vessel Agent OpenAI] stream complete in ${Date.now() - streamStartTime}ms, toolCalls=${Object.keys(toolCallAccums).length} textLen=${textAccum.length} finishReason=${finishReason}`);
        const toolCalls = Object.values(toolCallAccums);

        // Ensure every tool call has an ID (some providers like Ollama omit them)
        for (const tc of Object.values(toolCallAccums)) {
          if (!tc.id) tc.id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        }

        // Sanitize tool call arguments — ensure valid JSON for message history
        // (malformed args from the model would cause a 400 on the next API call)
        for (const tc of toolCalls) {
          try {
            JSON.parse(tc.argsJson || '{}');
          } catch {
            tc.argsJson = '{}';
          }
        }

        // Build assistant message for history
        const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: textAccum || '',
          ...(toolCalls.length > 0 && {
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: tc.argsJson },
            })),
          }),
        };
        messages.push(assistantMsg);

        // If no tool calls were requested, we're done
        // (Some providers like Ollama send finish_reason "stop" even with tool calls)
        if (toolCalls.length === 0) break;

        // Execute each tool and collect results
        for (const tc of toolCalls) {
          let args: Record<string, any> = {};
          try {
            args = JSON.parse(tc.argsJson || '{}');
          } catch {
            // Malformed tool arguments — send error back to model for retry
            onChunk(`\n<<tool:${tc.name}:⚠ invalid args>>\n`);
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: `Error: Invalid JSON in tool arguments. Please retry with valid JSON. Raw: ${tc.argsJson}`,
            });
            continue;
          }
          const argSummary = args.url || args.text || args.direction || '';
          onChunk(`\n<<tool:${tc.name}${argSummary ? ':' + argSummary : ''}>>\n`);
          let result: string;
          const toolStartTime = Date.now();
          console.log(`[Vessel Agent OpenAI] executing tool: ${tc.name}`);
          try {
            result = await onToolCall(tc.name, args);
          } catch (toolErr: any) {
            result = `Error: Tool execution failed — ${toolErr.message || toolErr}. Try a different approach or call read_page to refresh context.`;
          }
          console.log(`[Vessel Agent OpenAI] tool ${tc.name} completed in ${Date.now() - toolStartTime}ms, resultLen=${result.length}`);

          // OpenAI doesn't support image content in tool results — extract text only
          let toolContent = result;
          try {
            const parsed = JSON.parse(result);
            if (isRichToolResult(parsed)) {
              toolContent = parsed.content
                .filter((b: any) => b.type === 'text')
                .map((b: any) => b.text)
                .join('\n');
            }
          } catch {
            // Not JSON — use as-is
          }

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: toolContent,
          });
        }
      }
      if (iterationsUsed >= maxIterations) {
        onChunk(`\n\n[Reached maximum tool call limit (${maxIterations} steps). You can adjust this in Settings → Max Tool Iterations, or continue by sending another message.]`);
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
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
