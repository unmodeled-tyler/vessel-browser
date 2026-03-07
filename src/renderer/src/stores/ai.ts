import { createSignal } from "solid-js";
import type { AIMessage } from "../../../shared/types";

const [messages, setMessages] = createSignal<AIMessage[]>([]);
const [streamingText, setStreamingText] = createSignal("");
const [isStreaming, setIsStreaming] = createSignal(false);
const [hasFirstChunk, setHasFirstChunk] = createSignal(false);
const [streamStartedAt, setStreamStartedAt] = createSignal<number | null>(null);

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
    query: async (prompt: string) => {
      await window.vessel.ai.query(prompt);
    },
    cancel: () => window.vessel.ai.cancel(),
    clearHistory: () => setMessages([]),
  };
}
