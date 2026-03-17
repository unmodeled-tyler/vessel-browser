import { createSignal } from "solid-js";
import type { AIMessage } from "../../../shared/types";

const MAX_RECENT_QUERIES = 5;
const [messages, setMessages] = createSignal<AIMessage[]>([]);
const [streamingText, setStreamingText] = createSignal("");
const [isStreaming, setIsStreaming] = createSignal(false);
const [hasFirstChunk, setHasFirstChunk] = createSignal(false);
const [streamStartedAt, setStreamStartedAt] = createSignal<number | null>(null);
const [recentQueries, setRecentQueries] = createSignal<string[]>([]);

let initialized = false;

function init() {
  if (initialized) return;
  initialized = true;
  window.vessel.ai.onStreamStart((prompt: string) => {
    setMessages((prev) => [...prev, { role: "user", content: prompt }]);
    setStreamingText("");
    setIsStreaming(true);
    setHasFirstChunk(false);
    setStreamStartedAt(Date.now());
  });
  window.vessel.ai.onStreamChunk((chunk: string) => {
    if (!hasFirstChunk()) {
      setHasFirstChunk(true);
    }
    setStreamingText((prev) => prev + chunk);
  });
  window.vessel.ai.onStreamEnd(() => {
    const finalText = streamingText();
    if (finalText) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: finalText },
      ]);
    }
    setStreamingText("");
    setIsStreaming(false);
    setHasFirstChunk(false);
    setStreamStartedAt(null);
  });
}

export function useAI() {
  init();
  return {
    messages,
    streamingText,
    isStreaming,
    hasFirstChunk,
    streamStartedAt,
    recentQueries,
    query: async (prompt: string) => {
      setRecentQueries((prev) => {
        const filtered = prev.filter((q) => q !== prompt);
        return [prompt, ...filtered].slice(0, MAX_RECENT_QUERIES);
      });
      await window.vessel.ai.query(prompt, messages());
    },
    cancel: () => window.vessel.ai.cancel(),
    clearHistory: () => setMessages([]),
  };
}
