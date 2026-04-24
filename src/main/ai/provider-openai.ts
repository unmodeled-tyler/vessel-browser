import OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import type { AIProvider } from './provider';
import type { AIMessage, ProviderConfig } from '../../shared/types';
import { PROVIDERS } from "../../shared/providers";
import { isRichToolResult, type TextBlock } from './tool-result';
import { getEffectiveMaxIterations } from '../premium/manager';
import { normalizeToolAlias } from './tool-aliases';
import {
  resolveAgentToolProfile,
  type AgentToolProfile,
} from './tool-profile';
import type { ProviderId } from '../../shared/types';
import { isClickReadLoop, hasRecentDuplicateToolCall } from './tool-guardrails';
import { LLAMA_CPP_MIN_CTX_TOKENS, LLAMA_CPP_RECOMMENDED_CTX_TOKENS } from './content-limits';
import { createLogger } from '../../shared/logger';

const logger = createLogger("OpenAIProvider");

export { hasRecentDuplicateToolCall } from './tool-guardrails';

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
): OpenAI.Chat.ChatCompletionUserMessageParam | null {
  if (profile !== 'compact') return null;

  const phaseReminder = buildPhaseReminder(userMessage, assistantText || '');
  const stateReminder = buildLatestStateReminder(latestToolResultPreview || '');

  return {
    role: 'user',
    content:
      `[System] Task reminder: Continue working on the user's original request until it is completed: ${userMessage}\n` +
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
  const missedResultsSignals =
    /visible_only mode did not return specific book titles|did not yield a book title link|did not yield specific book titles|navigation links rather than book titles|inspect elements did not yield|inspect the page to find a specific book title|inspect the page to locate a book title|book title link from the search results/.test(
      text,
    );
  const falseCartSuccessSignals =
    /added\s+to\s+the\s+cart\s*:\s*["“”'a-z0-9 ,:&-]+|added\s+to\s+cart\s*:\s*["“”'a-z0-9 ,:&-]+|added\s+["“”'a-z0-9 ,:&-]+\s+to the cart|added\s+["“”'a-z0-9 ,:&-]+\s+to cart|added\s+.*\s+by\s+.*\s+to the cart/.test(
      text,
    ) &&
    !/(cart confirmation|view cart|shopping cart|checkout|continue shopping)/.test(
      text,
    );
  const skippedSingleResultSignals =
    /did not yield a direct match|no direct match|no matches|unavailable on powell|out of stock or unavailable/.test(
      text,
    ) &&
    /proceed to (?:add|search for) the next book|move on to the next book|next book from my list/.test(
      text,
    );
  const selectedItemsRestartSignals =
    /navigate back to the search results page|search for ".*" directly in the search box|search for .* directly|page structure has shifted|refresh the page|restart search/.test(
      text,
    );
  const multiClickSelectionSignals =
    /i(?:'| a)?ll start by clicking on the following books|i will start by clicking on the following books|i will click on the following books|clicked on five different book titles|clicked on \d+ different book titles|clicking through the selected titles|click each of the selected titles/.test(
      text,
    );
  const staleSelectionSignals =
    /cannot locate the elements to click|page structure is not being reliably captured|specific titles failed|page may have changed|stale-index|no visible area|not visible/.test(
      text,
    );
  const intermediateCartDialogSignals =
    /(added to cart|has been added to the cart|cart confirmation)/.test(text) &&
    /(continue shopping|search results page|return to the search results page|back button|go back)/.test(
      text,
    ) &&
    !/(all requested books are now in the cart|all 5 books are now in the cart|5 of 5 requested books are now in the cart)/.test(
      text,
    );

  if (wantsCart && wantsBookRecommendations && !selectedItems && !cartDone && listingLoopSignals) {
    return (
      `Progress reminder: If product results or primary results are already visible, do not keep rereading or rescrolling the same listing page. ` +
      `Open one promising result now. On the detail page, add that item to the cart before returning for the next unseen result.`
    );
  }

  if (wantsCart && wantsBookRecommendations && !selectedItems && !cartDone && missedResultsSignals) {
    return (
      `Progress reminder: On a results page, do not use visible_only or generic inspect_element to hunt product results. ` +
      `Call read_page(mode="results_only") once. If Primary Results are shown, click a listed result directly.`
    );
  }

  if (wantsCart && falseCartSuccessSignals && !selectedItems && !explanationDone) {
    return (
      `Progress reminder: Do not assume an item was added just because its product page is open or you inspected it. ` +
      `Only treat the cart step as complete after a successful Add to Cart click followed by cart confirmation, View Cart, Continue Shopping, or the cart page itself.`
    );
  }

  if (wantsCart && skippedSingleResultSignals && !selectedItems) {
    return (
      `Progress reminder: Do not skip to a new query just because the match is not exact. ` +
      `If the results page shows even one plausible product result, inspect or click that result before concluding there is no match.`
    );
  }

  if (wantsCart && intermediateCartDialogSignals && !explanationDone) {
    return (
      `Progress reminder: After an Add to Cart success, prefer the cart-confirmation dialog action Continue Shopping while more items remain. ` +
      `Do not click View Cart or Go to Basket yet, and do not use the browser back button while the dialog is still open.`
    );
  }

  if (wantsCart && selectedItems && !cartDone && selectedItemsRestartSignals) {
    return (
      `Progress reminder: The chosen items are already decided. Do not restart search, refresh the results page, or navigate back to browse again unless a specific saved link fails. ` +
      `Use the current results page or the chosen result links you already have: open one chosen result, add it to the cart, confirm success, then continue to the next chosen result.`
    );
  }

  if (wantsCart && wantsBookRecommendations && !cartDone && (multiClickSelectionSignals || staleSelectionSignals)) {
    return (
      `Progress reminder: Do not batch-click multiple results from a listing or category page. ` +
      `Open exactly one visible result, finish that item's Add to Cart flow, confirm success, then use Continue Shopping or go back once to choose the next unseen result. ` +
      `If a remembered label or index fails, trust the latest page state and refresh it with one read_page call before continuing.`
    );
  }

  if (wantsCart && selectedItems && (intendsCart || !cartDone)) {
    return (
      `Progress reminder: You already selected the requested items. ` +
      `Do not restart browsing or searching unless a specific cart step fails. ` +
      `Continue adding the selected items to the cart one by one. ` +
      `Use the chosen result links you already have, add one selected item to the cart, confirm success, then continue to the next one. Do not click multiple chosen results in a row from the same listing page.`
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
    "i have clicked on five different book titles",
    "clicked on five different book titles",
    "i'll begin with",
    "if the selection is unclear",
  ];
  if (repetitivePlanningSignals.some((pattern) => trimmed.includes(pattern))) {
    return true;
  }

  const falseCartSuccessWithoutConfirmation =
    /added\s+to\s+the\s+cart\s*:\s*["“”'a-z0-9 ,:&-]+|added\s+to\s+cart\s*:\s*["“”'a-z0-9 ,:&-]+|added\s+["“”'a-z0-9 ,:&-]+\s+to the cart|added\s+["“”'a-z0-9 ,:&-]+\s+to cart|added\s+.*\s+by\s+.*\s+to the cart/.test(
      trimmed,
    ) &&
    !/(cart confirmation|view cart|continue shopping|shopping cart|checkout|why i chose|here is why i chose|here are my reasons)/.test(
      trimmed,
    );
  if (falseCartSuccessWithoutConfirmation) {
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
  args: Record<string, unknown>,
): string {
  const canonicalArgs = canonicalizeArgsForTool(name, args);
  const sortedEntries = Object.entries(canonicalArgs).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return JSON.stringify([name, sortedEntries]);
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
): Record<string, unknown> | null {
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

  if (name === 'save_bookmark') {
    // Model may send a bare URL or "title url" as a single string
    const url = toLikelyUrl(trimmed);
    if (url) return { url };
    // Try splitting on last space — "Title https://..."
    const lastSpace = trimmed.lastIndexOf(' ');
    if (lastSpace > 0) {
      const maybeUrl = toLikelyUrl(trimmed.slice(lastSpace + 1));
      if (maybeUrl) return { url: maybeUrl, title: trimmed.slice(0, lastSpace).replace(/^["']|["']$/g, '') };
    }
  }

  return null;
}

function firstStringArg(
  args: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function normalizeElementTargetArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...args };

  if (typeof normalized.index === 'string' && /^\d+$/.test(normalized.index.trim())) {
    normalized.index = Number(normalized.index.trim());
  }

  if (typeof normalized.selector !== 'string' || !normalized.selector.trim()) {
    const selector = firstStringArg(normalized, [
      'cssSelector',
      'css_selector',
      'querySelector',
      'query_selector',
    ]);
    if (selector) normalized.selector = selector;
  }

  if (typeof normalized.text !== 'string' || !normalized.text.trim()) {
    const text = firstStringArg(normalized, [
      'label',
      'title',
      'name',
      'target',
      'element',
      'linkText',
      'link_text',
      'ariaLabel',
      'aria_label',
    ]);
    if (text) normalized.text = text;
  }

  return normalized;
}

function hasElementTarget(args: Record<string, unknown>): boolean {
  return (
    typeof args.index === 'number' ||
    (typeof args.selector === 'string' && args.selector.trim().length > 0) ||
    (typeof args.text === 'string' && args.text.trim().length > 0)
  );
}

export function isTargetlessClickArgs(args: Record<string, unknown>): boolean {
  return !hasElementTarget(normalizeElementTargetArgs(args));
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
): { args: Record<string, unknown>; repaired: boolean } | null {
  const trimmed = (argsJson || '').trim();
  if (!trimmed) return { args: {}, repaired: false };

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown>, repaired: false };
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
      return { args: repaired as Record<string, unknown>, repaired: true };
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
  args: Record<string, unknown>,
): Record<string, unknown> {
  let coerced = { ...args };

  if (
    name === 'click' ||
    name === 'inspect_element' ||
    name === 'scroll_to_element'
  ) {
    coerced = normalizeElementTargetArgs(coerced);
  }

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

  if (name === 'save_bookmark') {
    // Normalize common alternate arg names from small models
    if (typeof coerced.url !== 'string' || !coerced.url.trim()) {
      if (typeof coerced.link === 'string' && coerced.link.trim()) {
        coerced.url = coerced.link.trim();
      } else if (typeof coerced.href === 'string' && coerced.href.trim()) {
        coerced.url = coerced.href.trim();
      }
    }
    if (typeof coerced.folderName !== 'string' || !coerced.folderName.trim()) {
      if (typeof coerced.folder === 'string' && coerced.folder.trim()) {
        coerced.folderName = coerced.folder.trim();
      } else if (typeof coerced.category === 'string' && coerced.category.trim()) {
        coerced.folderName = coerced.category.trim();
      }
    }
    // Ensure createFolderIfMissing is boolean when folderName is set
    if (coerced.folderName && typeof coerced.createFolderIfMissing === 'undefined') {
      coerced.createFolderIfMissing = true;
    }
  }

  return coerced;
}

function canonicalizeArgsForTool(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
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

function unsupportedToolHint(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/[.\s/-]+/g, '_');
  const BOOKMARK_NAMES = [
    'organize_bookmark', 'organize_bookmarks', 'manage_bookmark',
    'manage_bookmarks', 'add_to_bookmarks', 'save_to_bookmarks',
    'bookmark_link', 'save_link', 'store_bookmark',
  ];
  if (BOOKMARK_NAMES.includes(normalized) || /bookmark|save.*link|organize/.test(normalized)) {
    return (
      `Error: "${name}" is not a supported tool. ` +
      `Use save_bookmark to save a page as a bookmark, or create_bookmark_folder to create a folder. ` +
      `Example: save_bookmark with {"url": "...", "title": "...", "folderName": "..."}`
    );
  }
  return (
    `Error: ${name} is not a supported tool. Choose one of the available browser tools instead.`
  );
}

export function resolveToolCallName(
  rawName: string,
  args: Record<string, unknown>,
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
    logger.info(`[agent-debug] ${JSON.stringify(payload)}`);
  } catch (err) {
    logger.warn("Failed to serialize debug payload:", err);
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
    let parsedArgs: Record<string, unknown> = {};
    try {
      const raw = JSON.parse(argsJson);
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        parsedArgs = raw as Record<string, unknown>;
      }
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

export function formatOpenAICompatErrorMessage(
  providerId: ProviderId,
  message: string,
): string {
  if (
    providerId === 'llama_cpp' &&
    /(available context size|context size exceeded|exceeds the available context size|try increasing it)/i.test(
      message,
    )
  ) {
    return (
      `${message} ` +
      `llama.cpp sets context size at server startup, not per request. ` +
      `Vessel's agent prompt plus tool schema is about 6.5k tokens before browsing history, so run llama-server with ` +
      `--ctx-size ${LLAMA_CPP_MIN_CTX_TOKENS} minimum (${LLAMA_CPP_RECOMMENDED_CTX_TOKENS} recommended).`
    );
  }

  return message;
}

export class OpenAICompatProvider implements AIProvider {
  readonly agentToolProfile: AgentToolProfile;

  private client: OpenAI;
  private model: string;
  private providerId: ProviderId;
  private abortController: AbortController | null = null;

  constructor(config: ProviderConfig) {
    const meta = PROVIDERS[config.id];
    const baseURL =
      config.baseUrl || meta?.defaultBaseUrl || 'https://api.openai.com/v1';

    const isOpenRouter = baseURL.includes('openrouter.ai');
    this.client = new OpenAI({
      apiKey: config.apiKey || 'ollama',
      baseURL,
      ...(isOpenRouter && {
        defaultHeaders: {
          'HTTP-Referer': 'https://github.com/unmodeled/vessel-browser',
          'X-Title': 'Vessel',
        },
      }),
    });
    this.providerId = config.id;
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
          max_tokens: 4096,
          stream: true,
          messages,
        },
        { signal: this.abortController.signal },
      );

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta;

        // Surface reasoning/thinking tokens (e.g. Qwen 3.5, DeepSeek) so the
        // user sees the model is actively thinking rather than appearing stalled.
        // Providers like llama.cpp expose this as `reasoning_content` on the delta.
        const reasoning = (delta as { reasoning_content?: string })?.reasoning_content;
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          onChunk(reasoning);
        }

        if (delta.content) {
          onChunk(delta.content);
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') {
        onChunk(
          `\n\n[Error: ${formatOpenAICompatErrorMessage(this.providerId, err.message)}]`,
        );
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
      const recentToolNames: string[] = [];
      let clickReadLoopNudged = false;
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
            max_tokens: 4096,
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

          // Surface reasoning/thinking tokens so the user can see the model
          // is actively thinking. We track the reasoning separately from
          // textAccum so it doesn't pollute the assistant's "spoken" text.
          const reasoning = (delta as { reasoning_content?: string })?.reasoning_content;
          if (typeof reasoning === 'string' && reasoning.length > 0) {
            onChunk(reasoning);
          }

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
          let parsedArgs: Record<string, unknown> = {};
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
            // The raw text containing tool-call JSON was already streamed to
            // the UI. Emit a signal so the renderer collapses it.
            if (textAccum.trim()) onChunk('<<erase_prev>>');
          } else {
            const narratedToolCalls = recoverNarratedActionToolCalls(
              textAccum,
              availableToolNames,
            );
            if (narratedToolCalls.length > 0) {
              toolCalls = narratedToolCalls;
              if (textAccum.trim()) onChunk('<<erase_prev>>');
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
            // Use 'user' role, not 'system' — many models (Qwen, Llama, etc.)
            // require system messages only at position 0 and reject mid-conversation
            // system messages with Jinja template errors.
            messages.push({
              role: 'user',
              content: `[System] ${buildCompactRecoveryPrompt(
                userMessage,
                textAccum,
                latestToolMessage
                  ? String(latestToolMessage.content || '')
                  : null,
              )}`,
            });
            continue;
          }
          break;
        }
        compactRecoveryCount = 0;

        const iterationToolResultPreviews: string[] = [];

        // Execute each tool and collect results
        for (const tc of toolCalls) {
          // Check for unsupported tool names FIRST — even if args are
          // malformed, a clear "tool does not exist" message with the
          // correct tool suggestion is more actionable than "invalid JSON".
          if (!availableToolNames.has(tc.name)) {
            const hint = unsupportedToolHint(tc.name);
            onChunk(`\n<<tool:${tc.name}:⚠ unsupported>>\n`);
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: hint,
            });
            compactCorrectionCount += 1;
            if (compactCorrectionCount >= 2) {
              messages.push({
                role: 'user',
                content: `[System] You are calling unsupported tools. Stop inventing tool names. Use the supported tools you were given and take the next concrete step.`,
              });
            }
            continue;
          }

          // Parse/repair args — handle malformed JSON from small models
          if (malformedToolCalls.has(tc.id)) {
            onChunk(`\n<<tool:${tc.name}:⚠ invalid args>>\n`);
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: `Error: Invalid JSON in tool arguments. The arguments could not be parsed. Please retry with valid JSON.`,
            });
            continue;
          }

          let args: Record<string, unknown> = {};
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

          const toolSignature = stableToolSignature(tc.name, args);
          if (
            this.agentToolProfile === 'compact' &&
            tc.name === 'click' &&
            isTargetlessClickArgs(args)
          ) {
            onChunk(`\n<<tool:${tc.name}:⚠ missing target>>\n`);
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content:
                `Error: click requires an element target. Use click with {"index": N} from the latest read_page result, or {"text": "exact visible link/button text"}. ` +
                `If you do not have a current result index, call read_page(mode="results_only") first and then click one listed result.`,
            });
            messages.push({
              role: 'user',
              content:
                `[System] Your last click had no target. Do not call click with empty arguments. ` +
                `Refresh the page state with read_page(mode="results_only") if needed, then click exactly one result by index or exact visible text.`,
            });
            compactCorrectionCount += 1;
            continue;
          }
          // These tools must never be suppressed as duplicates:
          // - Read-only lookups: page state may have changed since last call
          // - go_back/go_forward: each call pops the history stack
          // - click: needs to be retryable (clicks often don't work the first
          //   time due to obstructions, overlays, timing). Cart dedup and
          //   click streak warnings handle the pathological cases separately.
          const neverSuppressDuplicate = [
            'read_page', 'current_tab', 'inspect_element', 'screenshot',
            'go_back', 'go_forward', 'click',
          ].includes(tc.name);
          if (
            this.agentToolProfile === 'compact' &&
            !neverSuppressDuplicate &&
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
                role: 'user',
                content: `[System] You are stuck repeating the same action. Stop repeating navigate/search. Use a different supported tool that advances the task, such as click, read_page, or scroll.`,
              });
            }
            continue;
          }
          const argSummary = [args.url, args.query, args.text, args.direction]
            .map((v): string => typeof v === 'string' ? v : '')
            .find((v) => v.length > 0) ?? '';
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

          // Detect click→read_page alternating loop: the model clicks, reads
          // the result, clicks again, reads again, etc. without making progress.
          recentToolNames.push(tc.name);
          if (recentToolNames.length > 8) recentToolNames.shift();
          if (
            !clickReadLoopNudged &&
            recentToolNames.length >= 6 &&
            isClickReadLoop(recentToolNames)
          ) {
            clickReadLoopNudged = true;
            messages.push({
              role: 'user',
              content:
                `[System] You are alternating between click and read_page without advancing the task. ` +
                `The click result already includes a page snapshot when it navigates — you do not need read_page after every click. ` +
                `If you need detail on a specific element, use inspect_element instead. ` +
                `If you have enough context, proceed with the next action directly.`,
            });
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
        onChunk(
          `\n\n[Error: ${formatOpenAICompatErrorMessage(this.providerId, err.message)}]`,
        );
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
