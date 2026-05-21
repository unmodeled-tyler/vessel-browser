import type { AIMessage } from "./types";

export const MAX_PROVIDER_HISTORY_MESSAGES = 24;
export const MAX_PROVIDER_HISTORY_CHARS = 24000;
export const MAX_PROVIDER_HISTORY_MESSAGE_CHARS = 3000;
const MAX_PROVIDER_HISTORY_SUMMARY_CHARS = 2000;

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function normalizeHistoryMessage(message: AIMessage): AIMessage {
  return {
    role: message.role,
    content: truncateText(message.content, MAX_PROVIDER_HISTORY_MESSAGE_CHARS),
  };
}

function totalHistoryChars(history: AIMessage[]): number {
  return history.reduce((total, message) => total + message.content.length, 0);
}

function summarizeOmittedHistory(history: AIMessage[]): AIMessage {
  const snippets = history
    .slice(-12)
    .map((message) => `${message.role}: ${truncateText(message.content.replace(/\s+/g, " ").trim(), 220)}`)
    .filter((line) => line.length > "assistant: ".length);

  const content = truncateText(
    [
      `[Earlier conversation compacted: ${history.length} message${history.length === 1 ? "" : "s"} omitted.]`,
      ...snippets,
    ].join("\n"),
    MAX_PROVIDER_HISTORY_SUMMARY_CHARS,
  );

  return { role: "user", content };
}

export function compactProviderHistory(history: AIMessage[] = []): AIMessage[] {
  const normalized = history.map(normalizeHistoryMessage);
  if (
    normalized.length <= MAX_PROVIDER_HISTORY_MESSAGES &&
    totalHistoryChars(normalized) <= MAX_PROVIDER_HISTORY_CHARS
  ) {
    return normalized;
  }

  const recent: AIMessage[] = [];
  const recentBudget = MAX_PROVIDER_HISTORY_CHARS - MAX_PROVIDER_HISTORY_SUMMARY_CHARS;
  let usedChars = 0;

  for (let index = normalized.length - 1; index >= 0; index--) {
    const message = normalized[index];
    const nextChars = usedChars + message.content.length;
    if (recent.length >= MAX_PROVIDER_HISTORY_MESSAGES || nextChars > recentBudget) {
      break;
    }
    recent.unshift(message);
    usedChars = nextChars;
  }

  if (recent.length === 0 && normalized.length > 0) {
    recent.unshift(normalized[normalized.length - 1]);
  }

  const omitted = normalized.slice(0, normalized.length - recent.length);
  return omitted.length > 0 ? [summarizeOmittedHistory(omitted), ...recent] : recent;
}
