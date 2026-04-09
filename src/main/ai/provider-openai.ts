import OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import type { AIProvider } from './provider';
import type { AIMessage, ProviderConfig } from '../../shared/types';
import { PROVIDERS } from './providers';
import { isRichToolResult, type TextBlock } from './tool-result';
import { getEffectiveMaxIterations } from '../premium/manager';
import { normalizeToolAlias } from './tool-aliases';
import {
  resolveAgentToolProfile,
  type AgentToolProfile,
} from './tool-profile';

function shouldDebugAgentLoop(): boolean {
  const value = process.env.VESSEL_DEBUG_AGENT_LOOP;
  return value === '1' || value === 'true';
}

function previewDebugValue(value: string, maxLength = 800): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}…`;
}

function previewToolDebugContent(content: string): string {
  return previewDebugValue(content, 500);
}

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

  const completionSignals = [
    "i found",
    "i chose",
    "i selected",
    "i added",
    "here are",
    "these are",
    "recommendations",
    "reasoning",
    "why i chose",
    "added them to the cart",
  ];
  if (completionSignals.some((pattern) => trimmed.includes(pattern))) {
    return false;
  }

  return [
    "what are you hoping",
    "what would you like",
    "how can i help",
    "let me know",
    "are you looking for",
    "just browsing",
    "i need to",
    "i will",
    "i'll",
    "since i cannot see",
    "since i can't see",
    "cannot see the current page",
    "scroll down to",
    "load more results",
    "as placeholders",
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

export function stableToolSignature(
  name: string,
  args: Record<string, any>,
): string {
  const canonicalArgs = canonicalizeArgsForTool(name, args);
  const sortedEntries = Object.entries(canonicalArgs).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return JSON.stringify([name, sortedEntries]);
}

export function hasRecentDuplicateToolCall(
  recentToolSignatures: string[],
  signature: string,
): boolean {
  return recentToolSignatures.includes(signature);
}

function normalizeToolToken(value: string): string {
  return value.trim().toLowerCase().replace(/[.\s/-]+/g, '_');
}

function canonicalizeUrlLike(value: string): string {
  try {
    const url = new URL(value.trim());
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      url.hostname = url.hostname.replace(/^www\./, '');
      url.hash = '';
      if (url.pathname.endsWith('/') && url.pathname !== '/') {
        url.pathname = url.pathname.replace(/\/+$/, '');
      }
      return url.toString();
    }
  } catch {
    // Fall back to a trimmed raw value below.
  }
  return value.trim();
}

export function coerceToolArgsForExecution(
  name: string,
  args: Record<string, any>,
): Record<string, any> {
  const coerced = { ...args };

  if (name === 'search') {
    if (typeof coerced.query !== 'string' || !coerced.query.trim()) {
      if (typeof coerced.text === 'string' && coerced.text.trim()) {
        coerced.query = coerced.text.trim();
      } else if (typeof coerced.term === 'string' && coerced.term.trim()) {
        coerced.query = coerced.term.trim();
      }
    }
  }

  if (name === 'navigate') {
    if (typeof coerced.url !== 'string' || !coerced.url.trim()) {
      if (typeof coerced.href === 'string' && coerced.href.trim()) {
        coerced.url = coerced.href.trim();
      } else if (typeof coerced.link === 'string' && coerced.link.trim()) {
        coerced.url = coerced.link.trim();
      } else if (
        typeof coerced.text === 'string' &&
        /^https?:\/\//i.test(coerced.text.trim())
      ) {
        coerced.url = coerced.text.trim();
      }
    }
  }

  return coerced;
}

function canonicalizeArgsForTool(
  name: string,
  args: Record<string, any>,
): Record<string, any> {
  const canonical = coerceToolArgsForExecution(name, args);

  if (typeof canonical.url === 'string') {
    canonical.url = canonicalizeUrlLike(canonical.url);
  }

  if (typeof canonical.query === 'string') {
    canonical.query = canonical.query.trim().replace(/\s+/g, ' ').toLowerCase();
    delete canonical.text;
  }

  if (typeof canonical.text === 'string') {
    canonical.text = canonical.text.trim().replace(/\s+/g, ' ');
  }

  return canonical;
}

export function resolveToolCallName(
  rawName: string,
  args: Record<string, any>,
  availableToolNames: Set<string>,
): string {
  const aliased = normalizeToolAlias(rawName);
  if (availableToolNames.has(aliased)) return aliased;

  const normalized = normalizeToolToken(rawName);
  if (availableToolNames.has(normalized)) return normalized;

  const hasUrl = typeof args.url === 'string' && args.url.trim().length > 0;
  if (
    availableToolNames.has('navigate') &&
    (hasUrl || /goto|navigate|open|visit|browser|url|link/.test(normalized))
  ) {
    return 'navigate';
  }

  if (
    availableToolNames.has('search') &&
    (/search|find|lookup|query/.test(normalized) ||
      normalized === 'google' ||
      normalized.startsWith('google_'))
  ) {
    return 'search';
  }

  if (
    availableToolNames.has('scroll') &&
    /scroll|page_?down|page_?up/.test(normalized)
  ) {
    return 'scroll';
  }

  if (
    availableToolNames.has('read_page') &&
    /read|scan|inspect|analy[sz]e|summari[sz]e/.test(normalized)
  ) {
    return 'read_page';
  }

  return aliased;
}

function logAgentLoopDebug(payload: Record<string, unknown>): void {
  if (!shouldDebugAgentLoop()) return;
  try {
    console.log(`[Vessel agent-debug] ${JSON.stringify(payload)}`);
  } catch (err) {
    console.warn('[Vessel agent-debug] Failed to serialize debug payload:', err);
  }
}

export function recoverTextEncodedToolCalls(
  text: string,
  availableToolNames: Set<string>,
): Array<{ id: string; name: string; argsJson: string }> {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const candidates = trimmed.match(
    /([A-Za-z0-9._ -]+)\s*\[ARGS\]\s*(\{[\s\S]*?\})(?=\s*$|\n{2,}|[A-Za-z0-9._ -]+\s*\[ARGS\])/g,
  );
  if (!candidates || candidates.length === 0) return [];

  const recovered: Array<{ id: string; name: string; argsJson: string }> = [];
  for (const candidate of candidates) {
    const match = candidate.match(
      /^\s*([A-Za-z0-9._ -]+)\s*\[ARGS\]\s*(\{[\s\S]*\})\s*$/,
    );
    if (!match) continue;

    const rawName = match[1] ?? '';
    const argsJson = match[2] ?? '{}';
    let parsedArgs: Record<string, any> = {};
    try {
      parsedArgs = JSON.parse(argsJson);
    } catch {
      continue;
    }

    const resolvedName = resolveToolCallName(
      rawName,
      parsedArgs,
      availableToolNames,
    );
    recovered.push({
      id: `recovered_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: resolvedName,
      argsJson,
    });
  }

  return recovered;
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
    const availableToolNames = new Set(tools.map((tool) => tool.name));

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...(history ?? []).map((m) => ({ role: m.role, content: m.content } as OpenAI.Chat.ChatCompletionMessageParam)),
      { role: 'user', content: userMessage },
    ];

    try {
      const maxIterations = getEffectiveMaxIterations();
      let iterationsUsed = 0;
      let compactRecoveryCount = 0;
      let compactCorrectionCount = 0;
      const recentCompactToolSignatures: string[] = [];
      for (let i = 0; i < maxIterations; i++) {
        iterationsUsed = i + 1;
        let textAccum = '';
        const toolCallAccums: Record<number, { id: string; name: string; argsJson: string }> = {};
        let finishReason: string | null = null;
        const hasToolHistory = messages.some((message) => message.role === 'tool');
        const priorToolMessages = messages.filter(
          (message): message is OpenAI.Chat.ChatCompletionToolMessageParam =>
            message.role === 'tool',
        );
        const latestToolMessage =
          priorToolMessages.length > 0
            ? priorToolMessages[priorToolMessages.length - 1]
            : null;
        const debugRoundLabel = hasToolHistory ? 'post_tool' : 'initial';

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

        let toolCalls = Object.values(toolCallAccums);

        // Ensure every tool call has an ID (some providers like Ollama omit them)
        for (const tc of Object.values(toolCallAccums)) {
          if (!tc.id) tc.id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          let parsedArgs: Record<string, any> = {};
          try {
            parsedArgs = JSON.parse(tc.argsJson || '{}');
          } catch {
            parsedArgs = {};
          }
          tc.name = resolveToolCallName(tc.name, parsedArgs, availableToolNames);
        }

        if (toolCalls.length === 0) {
          const recoveredToolCalls = recoverTextEncodedToolCalls(
            textAccum,
            availableToolNames,
          );
          if (recoveredToolCalls.length > 0) {
            toolCalls = recoveredToolCalls;
          }
        }

        logAgentLoopDebug({
          model: this.model,
          profile: this.agentToolProfile,
          iteration: i + 1,
          round: debugRoundLabel,
          priorToolCount: priorToolMessages.length,
          latestToolResultPreview: latestToolMessage
            ? previewToolDebugContent(String(latestToolMessage.content || ''))
            : null,
          finishReason,
          streamedText: previewDebugValue(textAccum),
          recoveredFromText: Object.keys(toolCallAccums).length === 0 && toolCalls.length > 0,
          toolCalls: toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            argsJson: previewDebugValue(tc.argsJson || '{}', 300),
          })),
        });

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
          args = coerceToolArgsForExecution(tc.name, args);
          if (!availableToolNames.has(tc.name)) {
            onChunk(`\n<<tool:unsupported_tool:⚠ unsupported>>\n`);
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content:
                `Error: ${tc.name} is not a supported tool. Choose one of the available browser tools instead.`,
            });
            compactCorrectionCount += 1;
            if (compactCorrectionCount >= 2) {
              messages.push({
                role: 'system',
                content:
                  `You are calling unsupported tools. Stop inventing tool names. ` +
                  `Use the supported tools you were given and take the next concrete step.`,
              });
            }
            continue;
          }
          const toolSignature = stableToolSignature(tc.name, args);
          if (
            this.agentToolProfile === 'compact' &&
            hasRecentDuplicateToolCall(
              recentCompactToolSignatures,
              toolSignature,
            )
          ) {
            onChunk(`\n<<tool:${tc.name}:↻ duplicate suppressed>>\n`);
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content:
                `Error: Repeated the same tool call (${tc.name}) with the same arguments twice in a row. ` +
                `Do not repeat it. Continue with the next logical step for the original task.`,
            });
            compactCorrectionCount += 1;
            if (compactCorrectionCount >= 2) {
              messages.push({
                role: 'system',
                content:
                  `You are stuck repeating the same action. Stop repeating navigate/search. ` +
                  `Use a different supported tool that advances the task, such as click, read_page, or scroll.`,
              });
            }
            continue;
          }
          const argSummary = args.url || args.query || args.text || args.direction || '';
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

          if (this.agentToolProfile === 'compact') {
            recentCompactToolSignatures.push(toolSignature);
            if (recentCompactToolSignatures.length > 4) {
              recentCompactToolSignatures.shift();
            }
          }
          compactCorrectionCount = 0;

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
