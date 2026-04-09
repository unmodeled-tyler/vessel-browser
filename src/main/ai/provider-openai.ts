import OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import type { AIProvider } from './provider';
import type { AIMessage, ProviderConfig } from '../../shared/types';
import { PROVIDERS } from './providers';
import { isRichToolResult, type TextBlock } from './tool-result';
import { getEffectiveMaxIterations } from '../premium/manager';
import {
  resolveAgentToolProfile,
  type AgentToolProfile,
} from './tool-profile';

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

function agentTemperatureForProfile(
  profile: AgentToolProfile,
): number | undefined {
  return profile === 'compact' ? 0.2 : undefined;
}

function followUpReminderForProfile(
  profile: AgentToolProfile,
  userMessage: string,
): OpenAI.Chat.ChatCompletionSystemMessageParam | null {
  if (profile !== 'compact') return null;

  return {
    role: 'system',
    content:
      `Task reminder: Continue working on the user's original request until it is completed: ${userMessage}\n` +
      `Do not ask the user what they want next unless the request is genuinely ambiguous or blocked. ` +
      `After navigation or page reads, keep executing the same task.`,
  };
}

function shouldRecoverCompactStall(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return true;
  if (trimmed.length <= 160 && trimmed.includes("?")) return true;

  return [
    "what are you hoping",
    "what would you like",
    "how can i help",
    "let me know",
    "are you looking for",
    "just browsing",
  ].some((pattern) => trimmed.includes(pattern));
}

export function shouldRetryCompactToolLoop(
  profile: AgentToolProfile,
  text: string,
  hasToolHistory: boolean,
): boolean {
  return (
    profile === 'compact' &&
    hasToolHistory &&
    shouldRecoverCompactStall(text)
  );
}

export class OpenAICompatProvider implements AIProvider {
  readonly agentToolProfile: AgentToolProfile;

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
    this.agentToolProfile = resolveAgentToolProfile(config);
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
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') {
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
      const maxIterations = getEffectiveMaxIterations();
      let iterationsUsed = 0;
      let compactRecoveryCount = 0;
      for (let i = 0; i < maxIterations; i++) {
        iterationsUsed = i + 1;
        let textAccum = '';
        const toolCallAccums: Record<number, { id: string; name: string; argsJson: string }> = {};
        let finishReason: string | null = null;
        const hasToolHistory = messages.some((message) => message.role === 'tool');

        const stream = await this.client.chat.completions.create(
          {
            model: this.model,
            stream: true,
            messages,
            tools: openAITools,
            tool_choice: 'auto',
            temperature: agentTemperatureForProfile(this.agentToolProfile),
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

        const toolCalls = Object.values(toolCallAccums);

        // Ensure every tool call has an ID (some providers like Ollama omit them)
        for (const tc of Object.values(toolCallAccums)) {
          if (!tc.id) tc.id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        }

        // Sanitize tool call arguments — ensure valid JSON for message history
        // (malformed args from the model would cause a 400 on the next API call)
        // Track which ones were malformed so we can send errors instead of executing
        const malformedToolCalls = new Set<string>();
        for (const tc of toolCalls) {
          try {
            JSON.parse(tc.argsJson || '{}');
          } catch {
            malformedToolCalls.add(tc.id);
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
        if (toolCalls.length === 0) {
          if (
            compactRecoveryCount < 2 &&
            shouldRetryCompactToolLoop(
              this.agentToolProfile,
              textAccum,
              hasToolHistory,
            )
          ) {
            compactRecoveryCount += 1;
            messages.push({
              role: 'system',
              content:
                `The task is still in progress: ${userMessage}\n` +
                `Do not stop after a partial step. Choose the next tool now unless the request is fully complete.`,
            });
            continue;
          }
          break;
        }
        compactRecoveryCount = 0;

        // Execute each tool and collect results
        for (const tc of toolCalls) {
          // If this tool call had malformed args (sanitized above), send error to model
          if (malformedToolCalls.has(tc.id)) {
            onChunk(`\n<<tool:${tc.name}:⚠ invalid args>>\n`);
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: `Error: Invalid JSON in tool arguments. The arguments could not be parsed. Please retry with valid JSON.`,
            });
            continue;
          }

          let args: Record<string, any> = {};
          try {
            args = JSON.parse(tc.argsJson || '{}');
          } catch {
            // Shouldn't reach here after sanitization, but handle gracefully
            onChunk(`\n<<tool:${tc.name}:⚠ invalid args>>\n`);
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: `Error: Invalid JSON in tool arguments. Please retry with valid JSON.`,
            });
            continue;
          }
          const argSummary = args.url || args.text || args.direction || '';
          onChunk(`\n<<tool:${tc.name}${argSummary ? ':' + argSummary : ''}>>\n`);
          let result: string;
          try {
            result = await onToolCall(tc.name, args);
          } catch (toolErr: unknown) {
            const msg = toolErr instanceof Error ? toolErr.message : String(toolErr);
            result = `Error: Tool execution failed — ${msg}. Try a different approach or call read_page to refresh context.`;
          }

          // OpenAI doesn't support image content in tool results — extract text only
          let toolContent = result;
          try {
            const parsed = JSON.parse(result);
            if (isRichToolResult(parsed)) {
              toolContent = parsed.content
                .filter((b): b is TextBlock => b.type === 'text')
                .map((b) => b.text)
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

        const followUpReminder = followUpReminderForProfile(
          this.agentToolProfile,
          userMessage,
        );
        if (followUpReminder) {
          messages.push(followUpReminder);
        }
      }
      if (iterationsUsed >= maxIterations) {
        onChunk(`\n\n[Reached maximum tool call limit (${maxIterations} steps). You can adjust this in Settings → Max Tool Iterations, or continue by sending another message.]`);
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') {
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
