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
  assistantText?: string,
  latestToolResultPreview?: string | null,
): OpenAI.Chat.ChatCompletionSystemMessageParam | null {
  if (profile !== 'compact') return null;

  const phaseReminder = buildPhaseReminder(userMessage, assistantText || '');
  const stateReminder = buildLatestStateReminder(latestToolResultPreview || '');

  return {
    role: 'system',
    content:
      `Task reminder: Continue working on the user's original request until it is completed: ${userMessage}\n` +
      `Do not ask the user what they want next unless the request is genuinely ambiguous or blocked. ` +
      `After navigation or page reads, keep executing the same task.` +
      (stateReminder ? `\n${stateReminder}` : '') +
      (phaseReminder ? `\n${phaseReminder}` : ''),
  };
}

function extractSingleGoalDomain(goal: string): string | null {
  const matches = goal
    .toLowerCase()
    .match(/\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.(?:com|org|net|io|dev|app|ai|co|edu|gov))\b/g);
  if (!matches || matches.length !== 1) return null;

  return matches[0]
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .toLowerCase();
}

export function buildCompactRecoveryPrompt(
  userMessage: string,
  assistantText: string,
  latestToolResultPreview?: string | null,
): string {
  const phaseReminder = buildPhaseReminder(userMessage, assistantText);
  const stateReminder = buildLatestStateReminder(latestToolResultPreview || '');
  const goalDomain = extractSingleGoalDomain(userMessage);
  const latest = (latestToolResultPreview || '').toLowerCase();
  const assistant = assistantText.toLowerCase();
  const alreadyOnGoalSite =
    !!goalDomain &&
    (latest.includes(goalDomain) ||
      assistant.includes(`https://${goalDomain}`) ||
      assistant.includes(`https://www.${goalDomain}`));

  const lines = [
    `The task is still in progress: ${userMessage}`,
    `Do not ask the user for permission to continue. Choose the next tool now unless the request is fully complete.`,
  ];

  if (alreadyOnGoalSite) {
    lines.push(
      `You are already on the requested site (${goalDomain}). Do not navigate to the homepage again and do not restart discovery from scratch.`,
    );
  }

  if (stateReminder) {
    lines.push(stateReminder);
  }

  if (phaseReminder) {
    lines.push(phaseReminder);
  }

  return lines.join('\n');
}

export function buildPhaseReminder(
  userMessage: string,
  assistantText: string,
): string {
  const goal = userMessage.toLowerCase();
  const text = assistantText.toLowerCase();
  if (!goal || !text) return '';

  const wantsCart = /\b(cart|bag|basket|checkout)\b/.test(goal);
  const wantsExplanation = /\b(explain|reason|why)\b/.test(goal);
  const wantsBookRecommendations =
    /\b(book|books|recommend|recommended|interesting|novel|fiction|nonfiction)\b/.test(
      goal,
    );
  const hasFiveItemList =
    /(?:^|\n)\s*1\./.test(assistantText) &&
    /(?:^|\n)\s*2\./.test(assistantText) &&
    /(?:^|\n)\s*3\./.test(assistantText) &&
    /(?:^|\n)\s*4\./.test(assistantText) &&
    /(?:^|\n)\s*5\./.test(assistantText);
  const selectedItems =
    hasFiveItemList ||
    /i(?:'| a)?ve chosen/.test(text) ||
    /i have chosen/.test(text) ||
    /i selected/.test(text) ||
    /here are the books/i.test(assistantText) ||
    /here are the items/i.test(assistantText);
  const intendsCart =
    /next[, ]+i will add/.test(text) ||
    /i(?:'| a)?ll start with the first/.test(text) ||
    /proceed systematically/.test(text) ||
    /add (these|the chosen|the selected).*(cart|bag|basket)/.test(text);
  const cartDone =
    /(added to cart|added them to the cart|cart confirmation|view cart|checkout)/.test(
      text,
    );
  const explanationDone =
    /here is why i chose/.test(text) ||
    /here are my reasons/.test(text) ||
    /reason:/.test(text) ||
    /reasons:/.test(text) ||
    /why i chose/.test(text);
  const listingLoopSignals =
    /page contains a list of books|book listings|book cards|visible book|load more results|scroll further|scroll down|inspect the visible|focus on the book listings|targeting the book images|limited to interactive elements|identify the book cards|click one of the visible book/.test(
      text,
    );

  if (wantsCart && wantsBookRecommendations && !selectedItems && !cartDone && listingLoopSignals) {
    return (
      `Progress reminder: If book titles or primary results are already visible, do not keep rereading or rescrolling the same listing page. ` +
      `Click one promising book title now. On the detail page, add it to the cart before returning for the next unseen title.`
    );
  }

  if (wantsCart && selectedItems && (intendsCart || !cartDone)) {
    return (
      `Progress reminder: You already selected the requested items. ` +
      `Do not restart browsing or searching unless a specific cart step fails. ` +
      `Continue adding the selected items to the cart one by one.`
    );
  }

  if (wantsCart && wantsExplanation && cartDone && !explanationDone) {
    return (
      `Progress reminder: The cart step appears complete. ` +
      `Do not resume browsing. Finish by explaining why the chosen items were recommended.`
    );
  }

  return '';
}

export function buildLatestStateReminder(toolResultPreview: string): string {
  const text = toolResultPreview.trim();
  if (!text) return '';

  const stateMatch = text.match(
    /\[state:\s+url=([^,\]\n]+),\s+title=(?:"([^"]*)"|([^,\]\n]+))/i,
  );
  if (stateMatch) {
    const url = stateMatch[1]?.trim();
    const title = (stateMatch[2] ?? stateMatch[3] ?? '').trim();
    if (url) {
      return `Latest browser state: URL ${url}${title ? `, title "${title}"` : ''}. Trust the latest tool result over the initial page context.`;
    }
  }

  const structuredUrl = text.match(/\*\*URL:\*\*\s*([^\n]+)/i)?.[1]?.trim();
  const structuredTitle = text.match(/\*\*Title:\*\*\s*([^\n]+)/i)?.[1]?.trim();
  if (structuredUrl) {
    return `Latest browser state: URL ${structuredUrl}${structuredTitle ? `, title "${structuredTitle}"` : ''}. Trust the latest tool result over the initial page context.`;
  }

  const navigatedUrl = text.match(/\b(?:navigated to|went back to|went forward to|searched "[^"]+"(?: \(via search button\))? →)\s+([^\s\n]+)/i)?.[1]?.trim();
  const pageTitle = text.match(/\bPage title:\s*([^\n]+)/i)?.[1]?.trim();
  if (navigatedUrl) {
    return `Latest browser state: URL ${navigatedUrl}${pageTitle ? `, title "${pageTitle}"` : ''}. Trust the latest tool result over the initial page context.`;
  }

  return '';
}

function shouldRecoverCompactStall(
  text: string,
  userMessage?: string,
): boolean {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return true;
  if (trimmed.length <= 160 && trimmed.includes("?")) return true;

  if (userMessage && buildPhaseReminder(userMessage, text)) {
    return true;
  }

  const repetitivePlanningSignals = [
    "next step:",
    "i will now inspect",
    "i will now read",
    "i will now click",
    "i'll use readpage",
    'i\'ll use read_page',
    "i'll start by clicking",
    "i'll begin with",
    "if the selection is unclear",
  ];
  if (repetitivePlanningSignals.some((pattern) => trimmed.includes(pattern))) {
    return true;
  }

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
    "would you like me to proceed",
    "action:",
    "one moment",
    "i will now navigate",
    "navigating to ",
    "this will take me",
    "i will use the browser",
  ].some((pattern) => trimmed.includes(pattern));
}

export function shouldRetryCompactToolLoop(
  profile: AgentToolProfile,
  text: string,
  hasToolHistory: boolean,
  userMessage?: string,
): boolean {
  return (
    profile === 'compact' &&
    hasToolHistory &&
    shouldRecoverCompactStall(text, userMessage)
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

function toLikelyUrl(value: string): string | null {
  const trimmed = value.trim().replace(/^["']|["']$/g, '');
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z0-9-]+\.(com|org|net|io|dev|app|ai|co|edu|gov)(\/\S*)?$/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return null;
}

function scalarArgsForTool(
  name: string,
  scalar: string,
): Record<string, any> | null {
  const trimmed = scalar.trim();
  if (!trimmed) return null;

  if (name === 'navigate') {
    const url = toLikelyUrl(trimmed);
    return url ? { url } : null;
  }

  if (name === 'search') {
    return { query: trimmed.replace(/^["']|["']$/g, '') };
  }

  if (
    name === 'click' ||
    name === 'inspect_element' ||
    name === 'scroll_to_element'
  ) {
    return { text: trimmed.replace(/^["']|["']$/g, '') };
  }

  if (name === 'read_page') {
    const mode = trimmed.replace(/^["']|["']$/g, '').toLowerCase();
    if (mode) return { mode };
  }

  return null;
}

function tryParseJsonWithCommonRepairs(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  const candidates = new Set<string>([trimmed]);
  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch?.[0]) candidates.add(objectMatch[0]);
  if (!trimmed.startsWith('{') && trimmed.includes(':')) {
    candidates.add(`{${trimmed}}`);
  }

  for (const candidate of candidates) {
    const normalized = candidate
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    if (!normalized) continue;

    const repaired = normalized
      .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3')
      .replace(/([{,]\s*)'([^']+)'(\s*:)/g, '$1"$2"$3')
      .replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_match, value: string) =>
        `: ${JSON.stringify(value)}`,
      )
      .replace(/,\s*([}\]])/g, '$1');

    try {
      return JSON.parse(repaired);
    } catch {
      // Try next repair candidate.
    }
  }

  throw new Error('invalid-json');
}

export function parseToolArgsWithRepair(
  name: string,
  argsJson: string,
): { args: Record<string, any>; repaired: boolean } | null {
  const trimmed = (argsJson || '').trim();
  if (!trimmed) return { args: {}, repaired: false };

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, any>, repaired: false };
    }
    if (typeof parsed === 'string') {
      const scalarArgs = scalarArgsForTool(name, parsed);
      return scalarArgs ? { args: scalarArgs, repaired: true } : null;
    }
    return null;
  } catch {
    // Fall through to common repair handling below.
  }

  try {
    const repaired = tryParseJsonWithCommonRepairs(trimmed);
    if (repaired && typeof repaired === 'object' && !Array.isArray(repaired)) {
      return { args: repaired as Record<string, any>, repaired: true };
    }
    if (typeof repaired === 'string') {
      const scalarArgs = scalarArgsForTool(name, repaired);
      return scalarArgs ? { args: scalarArgs, repaired: true } : null;
    }
  } catch {
    // Fall through to tool-specific scalar extraction below.
  }

  const scalarArgs = scalarArgsForTool(name, trimmed);
  return scalarArgs ? { args: scalarArgs, repaired: true } : null;
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

export function recoverNarratedActionToolCalls(
  text: string,
  availableToolNames: Set<string>,
): Array<{ id: string; name: string; argsJson: string }> {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const recovered: Array<{ id: string; name: string; argsJson: string }> = [];
  const actionLines = trimmed.match(/^action:\s+.+$/gim) ?? [];

  for (const rawLine of actionLines) {
    const line = rawLine.replace(/^action:\s*/i, '').trim();
    if (!line) continue;

    const quotedValue =
      line.match(/"([^"]+)"/)?.[1]?.trim() ??
      line.match(/'([^']+)'/)?.[1]?.trim() ??
      '';

    const navigateMatch = line.match(
      /\b(?:navigate|open|go)\b(?:\s+(?:to|the url))?\s+(https?:\/\/[^\s)]+)\.?/i,
    );
    if (navigateMatch?.[1]) {
      const argsJson = JSON.stringify({ url: navigateMatch[1].replace(/\.$/, '') });
      recovered.push({
        id: `recovered_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: resolveToolCallName('navigate', { url: navigateMatch[1] }, availableToolNames),
        argsJson,
      });
      continue;
    }

    const isSearchAction =
      /\bsearch\b/i.test(line) ||
      (/\btype\b/i.test(line) && /\bsearch box\b/i.test(line));
    if (isSearchAction && quotedValue && availableToolNames.has('search')) {
      recovered.push({
        id: `recovered_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: 'search',
        argsJson: JSON.stringify({ query: quotedValue }),
      });
      continue;
    }

    if (
      /\b(?:read|scan)\b.*\bpage\b/i.test(line) &&
      availableToolNames.has('read_page')
    ) {
      recovered.push({
        id: `recovered_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: 'read_page',
        argsJson: JSON.stringify({ mode: 'visible_only' }),
      });
      continue;
    }

    const toolRefMatch = line.match(
      /\b(?:use|call)\s+([a-z_][a-z0-9_]*)(?:\s+tool)?\b/i,
    );
    if (toolRefMatch?.[1]) {
      const toolName = resolveToolCallName(toolRefMatch[1], {}, availableToolNames);
      recovered.push({
        id: `recovered_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: toolName,
        argsJson: '{}',
      });
    }
  }

  const inlineReadMatch = trimmed.match(
    /\bread_?page\b\s*\(\s*mode\s*=\s*["']?([a-z_]+)["']?\s*\)/i,
  ) ?? trimmed.match(
    /\breadpage\b\s*\(\s*mode\s*=\s*["']?([a-z_]+)["']?\s*\)/i,
  );
  if (inlineReadMatch && availableToolNames.has('read_page')) {
    const rawMode = (inlineReadMatch[1] || '').trim().toLowerCase();
    const normalizedMode =
      rawMode === 'visibleonly'
        ? 'visible_only'
        : rawMode === 'resultsonly'
          ? 'results_only'
          : rawMode;
    if (normalizedMode) {
      recovered.push({
        id: `recovered_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: 'read_page',
        argsJson: JSON.stringify({ mode: normalizedMode }),
      });
      return recovered;
    }
  }

  const inlineInspectMatch = trimmed.match(
    /\binspect_?element\b(?:\s+tool)?\b/i,
  ) ?? trimmed.match(/\binspectelement\b\b/i);
  if (inlineInspectMatch && availableToolNames.has('inspect_element')) {
    recovered.push({
      id: `recovered_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: 'inspect_element',
      argsJson: '{}',
    });
    return recovered;
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
          const repairedArgs = parseToolArgsWithRepair(tc.name, tc.argsJson || '{}');
          if (repairedArgs) {
            parsedArgs = repairedArgs.args;
            if (repairedArgs.repaired) {
              tc.argsJson = JSON.stringify(parsedArgs);
            }
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
          } else {
            const narratedToolCalls = recoverNarratedActionToolCalls(
              textAccum,
              availableToolNames,
            );
            if (narratedToolCalls.length > 0) {
              toolCalls = narratedToolCalls;
            }
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
          const repairedArgs = parseToolArgsWithRepair(tc.name, tc.argsJson || '{}');
          if (!repairedArgs) {
            malformedToolCalls.add(tc.id);
            tc.argsJson = '{}';
            continue;
          }
          if (repairedArgs.repaired) {
            tc.argsJson = JSON.stringify(repairedArgs.args);
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
              userMessage,
            )
          ) {
            compactRecoveryCount += 1;
            messages.push({
              role: 'system',
              content: buildCompactRecoveryPrompt(
                userMessage,
                textAccum,
                latestToolMessage
                  ? String(latestToolMessage.content || '')
                  : null,
              ),
            });
            continue;
          }
          break;
        }
        compactRecoveryCount = 0;

        const iterationToolResultPreviews: string[] = [];

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
          const repairedArgs = parseToolArgsWithRepair(tc.name, tc.argsJson || '{}');
          if (!repairedArgs) {
            onChunk(`\n<<tool:${tc.name}:⚠ invalid args>>\n`);
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: `Error: Invalid JSON in tool arguments. Please retry with valid JSON.`,
            });
            continue;
          }
          args = repairedArgs.args;
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
          iterationToolResultPreviews.push(toolContent);

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: toolContent,
          });
        }

        const followUpReminder = followUpReminderForProfile(
          this.agentToolProfile,
          userMessage,
          textAccum,
          iterationToolResultPreviews.length > 0
            ? iterationToolResultPreviews[iterationToolResultPreviews.length - 1]
            : null,
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
