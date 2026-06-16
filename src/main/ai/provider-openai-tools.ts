import { normalizeToolAlias } from './tool-aliases';

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

function repeatedToolTokenMatch(value: string, token: string): boolean {
  if (value === token) return true;
  if (token.length === 0 || value.length <= token.length) return false;
  if (value.length % token.length !== 0) return false;
  return token.repeat(value.length / token.length) === value;
}

function resolveRepeatedAvailableToolName(
  normalized: string,
  availableToolNames: Set<string>,
): string | null {
  for (const toolName of availableToolNames) {
    if (repeatedToolTokenMatch(normalized, normalizeToolToken(toolName))) {
      return toolName;
    }
  }
  return null;
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
  if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(trimmed)) {
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

  if (name === 'search' || name === 'web_search') {
    return { query: trimmed.replace(/^["']|["']$/g, '') };
  }

  if (
    name === 'click' ||
    name === 'highlight' ||
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
    // Try splitting on last space - "Title https://..."
    const lastSpace = trimmed.lastIndexOf(' ');
    if (lastSpace > 0) {
      const maybeUrl = toLikelyUrl(trimmed.slice(lastSpace + 1));
      if (maybeUrl) {
        return {
          url: maybeUrl,
          title: trimmed.slice(0, lastSpace).replace(/^["']|["']$/g, ''),
        };
      }
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

  if (name === 'search' || name === 'web_search') {
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

export function unsupportedToolHint(name: string): string {
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

  const repeatedAvailableName = resolveRepeatedAvailableToolName(
    normalized,
    availableToolNames,
  );
  if (repeatedAvailableName) return repeatedAvailableName;

  const hasUrl = typeof args.url === 'string' && args.url.trim().length > 0;
  if (
    availableToolNames.has('navigate') &&
    (hasUrl || /goto|navigate|open|visit|browser|url|link/.test(normalized))
  ) {
    return 'navigate';
  }

  if (
    availableToolNames.has('web_search') &&
    (/web_?search|internet|open_?web|search_?engine|google/.test(normalized) ||
      normalized === 'google' ||
      normalized.startsWith('google_'))
  ) {
    return 'web_search';
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

function findInlineToolMarkerBodies(text: string): string[] {
  const bodies: string[] = [];
  const lowerText = text.toLowerCase();
  let searchIndex = 0;

  while (searchIndex < text.length) {
    const start = lowerText.indexOf('<<tool', searchIndex);
    if (start === -1) break;

    let quote: '"' | "'" | null = null;
    let escaped = false;
    let end = -1;

    for (let index = start + 2; index < text.length - 1; index += 1) {
      const char = text[index];
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }

      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }

      if (char === '>' && text[index + 1] === '>') {
        end = index;
        break;
      }
    }

    if (end === -1) {
      searchIndex = start + 2;
      continue;
    }

    bodies.push(text.slice(start + 2, end));
    searchIndex = end + 2;
  }

  return bodies;
}

/**
 * Recover tool calls that some providers (especially certain OpenRouter models)
 * emit as inline text markers such as `<<tool=highlight:text="...">>` or
 * `<<tool:navigate:url=...>>` instead of using the proper tool_calls API channel.
 */
export function recoverInlineToolMarkerToolCalls(
  text: string,
  availableToolNames: Set<string>,
): Array<{ id: string; name: string; argsJson: string }> {
  const recovered: Array<{ id: string; name: string; argsJson: string }> = [];

  for (const markerBody of findInlineToolMarkerBodies(text)) {
    const match = markerBody
      .trim()
      .match(/^tool[:=]([a-z_][a-z0-9_]*)(?:[:=]([\s\S]*))?$/i);
    if (!match) continue;

    const rawName = match[1] ?? '';
    const rawArgs = (match[2] ?? '').trim();

    const resolvedName = resolveToolCallName(
      rawName,
      {},
      availableToolNames,
    );
    if (!availableToolNames.has(resolvedName)) continue;

    let parsedArgs: Record<string, unknown> | null = null;

    // Try raw JSON object first: <<tool:highlight:{"text":"..."}>>
    if (rawArgs.startsWith('{')) {
      const repaired = parseToolArgsWithRepair(resolvedName, rawArgs);
      if (repaired) {
        parsedArgs = repaired.args;
      }
    }

    // Try key=value pairs: <<tool=highlight:text="...">>
    if (!parsedArgs) {
      const kvArgs: Record<string, string> = {};
      const kvPattern =
        /([a-z_][a-z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\s]*))/gi;
      let kvMatch: RegExpExecArray | null;
      while ((kvMatch = kvPattern.exec(rawArgs)) !== null) {
        const key = kvMatch[1];
        const value = kvMatch[2] ?? kvMatch[3] ?? kvMatch[4] ?? '';
        kvArgs[key] = value;
      }
      if (Object.keys(kvArgs).length > 0) {
        parsedArgs = kvArgs;
      }
    }

    // Fall back to scalar extraction for bare values.
    if (!parsedArgs && rawArgs) {
      const repaired = parseToolArgsWithRepair(resolvedName, rawArgs);
      if (repaired) {
        parsedArgs = repaired.args;
      }
    }

    if (!parsedArgs) {
      parsedArgs = {};
    }

    recovered.push({
      id: `recovered_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: resolvedName,
      argsJson: JSON.stringify(parsedArgs),
    });
  }

  return recovered;
}

export function recoverAssistantTextToolCalls(
  text: string,
  availableToolNames: Set<string>,
): Array<{ id: string; name: string; argsJson: string }> {
  const textEncodedCalls = recoverTextEncodedToolCalls(text, availableToolNames);
  if (textEncodedCalls.length > 0) return textEncodedCalls;

  const inlineMarkerCalls = recoverInlineToolMarkerToolCalls(
    text,
    availableToolNames,
  );
  if (inlineMarkerCalls.length > 0) return inlineMarkerCalls;

  return recoverNarratedActionToolCalls(text, availableToolNames);
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
    if (isSearchAction && quotedValue && (availableToolNames.has('search') || availableToolNames.has('web_search'))) {
      const recoveredSearchName =
        !availableToolNames.has('search') ||
        (availableToolNames.has('web_search') && /\b(web|internet|google|search engine)\b/i.test(line))
          ? 'web_search'
          : 'search';
      recovered.push({
        id: `recovered_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: recoveredSearchName,
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

export function shouldRetryUnexecutedHighlightCompletion(
  userMessage: string,
  assistantText: string,
  successfulToolNames: readonly string[],
): boolean {
  const userAskedForHighlights = /\b(?:highlight|highlights|mark|annotate)\b/i.test(
    userMessage,
  );
  if (!userAskedForHighlights || successfulToolNames.includes('highlight')) {
    return false;
  }

  const normalizedAssistant = assistantText.toLowerCase();
  return (
    /\b(?:highlighted|marked|annotated)\b/.test(normalizedAssistant) ||
    /\b(?:green|yellow|red|blue|purple|orange)\s+highlights?\b/.test(
      normalizedAssistant,
    ) ||
    /\bhighlights?\s+(?:added|shown|applied|visible|on the page)\b/.test(
      normalizedAssistant,
    )
  );
}

export function buildHighlightToolCompletionPrompt(): string {
  return (
    `The user asked you to highlight items on the page, but no highlight tool call succeeded. ` +
    `Do not claim visual highlights are present until you call the supported highlight tool. ` +
    `Use read_page only if you need current page text, then call highlight with {"text":"exact visible title or passage"} for each item you want to mark. ` +
    `Use an element index only when the latest read_page result gives the exact current index for that same item.`
  );
}
