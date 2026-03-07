import { createSignal } from 'solid-js';
import type { AIMessage } from '../../../shared/types';

const [messages, setMessages] = createSignal<AIMessage[]>([]);
const [streamingText, setStreamingText] = createSignal('');
const [isStreaming, setIsStreaming] = createSignal(false);

let initialized = false;

function init() {
  if (initialized) return;
  initialized = true;
  window.vessel.ai.onStreamChunk((chunk: string) => {
    setStreamingText((prev) => prev + chunk);
  });
  window.vessel.ai.onStreamEnd(() => {
    const finalText = streamingText();
    if (finalText) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: finalText },
      ]);
    }
    setStreamingText('');
    setIsStreaming(false);
  });
}

export function useAI() {
  init();
  return {
    messages,
    streamingText,
    isStreaming,
    query: async (prompt: string) => {
      setMessages((prev) => [...prev, { role: 'user', content: prompt }]);
      setStreamingText('');
      setIsStreaming(true);
      await window.vessel.ai.query(prompt);
    },
    cancel: () => window.vessel.ai.cancel(),
    clearHistory: () => setMessages([]),
  };
}
