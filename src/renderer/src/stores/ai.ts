import { createSignal } from "solid-js";
import type { AIMessage, AutomationActivityEntry } from "../../../shared/types";
import {
  appendAutomationActivityChunk,
  finishAutomationActivity,
  startAutomationActivity,
} from "./ai-activity";
import {
  clearPendingPromptQueue,
  dequeuePendingPrompt,
  enqueuePendingPrompt,
  MAX_PENDING_QUERIES,
  removePendingPrompt,
} from "./ai-queue";

const MAX_RECENT_QUERIES = 5;
const MAX_MESSAGE_HISTORY = 200;
const [messages, setMessages] = createSignal<AIMessage[]>([]);
const [streamingText, setStreamingText] = createSignal("");
const [isStreaming, setIsStreaming] = createSignal(false);
const [hasFirstChunk, setHasFirstChunk] = createSignal(false);
const [streamStartedAt, setStreamStartedAt] = createSignal<number | null>(null);
const [recentQueries, setRecentQueries] = createSignal<string[]>([]);
const [pendingQueries, setPendingQueries] = createSignal<string[]>([]);
const [queueNotice, setQueueNotice] = createSignal<string | null>(null);
const [automationActivities, setAutomationActivities] = createSignal<
  AutomationActivityEntry[]
>([]);

let initialized = false;

function trimMessages(next: AIMessage[]): AIMessage[] {
  return next.length > MAX_MESSAGE_HISTORY ? next.slice(-MAX_MESSAGE_HISTORY) : next;
}

function recordRecentQuery(prompt: string): void {
  setRecentQueries((prev) => {
    const filtered = prev.filter((q) => q !== prompt);
    return [prompt, ...filtered].slice(0, MAX_RECENT_QUERIES);
  });
}

function buildHistory(): AIMessage[] {
  return messages().map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

async function dispatchQuery(prompt: string): Promise<boolean> {
  const result = await window.vessel.ai.query(prompt, buildHistory());
  return result.accepted;
}

async function dispatchQueuedPrompt(prompt: string): Promise<void> {
  const accepted = await dispatchQuery(prompt);
  if (!accepted) {
    const queued = enqueuePendingPrompt(pendingQueries(), prompt, { atFront: true });
    setPendingQueries(queued.queue);
    setQueueNotice(queued.notice);
  }
}

function init() {
  if (initialized) return;
  initialized = true;
  window.vessel.ai.onStreamStart((prompt: string) => {
    setMessages((prev) => {
      const next = [...prev, { role: "user" as const, content: prompt }];
      return trimMessages(next);
    });
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
      setMessages((prev) => {
        const next = [...prev, { role: "assistant" as const, content: finalText }];
        return trimMessages(next);
      });
    }
    setStreamingText("");
    setIsStreaming(false);
    setHasFirstChunk(false);
    setStreamStartedAt(null);

    const pending = pendingQueries();
    if (pending.length === 0) {
      setQueueNotice(null);
      return;
    }

    const next = dequeuePendingPrompt(pending);
    setPendingQueries(next.queue);
    setQueueNotice(next.notice);
    queueMicrotask(() => {
      if (next.nextPrompt) {
        void dispatchQueuedPrompt(next.nextPrompt);
      }
    });
  });
  window.vessel.ai.onAutomationActivityStart((entry) => {
    setAutomationActivities((prev) => startAutomationActivity(prev, entry));
  });
  window.vessel.ai.onAutomationActivityChunk(({ id, chunk }) => {
    setAutomationActivities((prev) =>
      appendAutomationActivityChunk(prev, id, chunk),
    );
  });
  window.vessel.ai.onAutomationActivityEnd(({ id, status, finishedAt }) => {
    setAutomationActivities((prev) =>
      finishAutomationActivity(prev, id, status, finishedAt),
    );
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
    automationActivities,
    pendingQueries,
    pendingQueryCount: () => pendingQueries().length,
    pendingQueryLimit: MAX_PENDING_QUERIES,
    queueNotice,
    query: async (prompt: string) => {
      recordRecentQuery(prompt);

      if (isStreaming()) {
        const queued = enqueuePendingPrompt(pendingQueries(), prompt);
        setPendingQueries(queued.queue);
        setQueueNotice(queued.notice);
        return queued.status;
      }

      setQueueNotice(null);
      const accepted = await dispatchQuery(prompt);
      if (!accepted) {
        const queued = enqueuePendingPrompt(pendingQueries(), prompt, { atFront: true });
        setPendingQueries(queued.queue);
        setQueueNotice(queued.notice);
        return queued.status;
      }
      return "started" as const;
    },
    cancel: () => window.vessel.ai.cancel(),
    removePendingQuery: (index: number) => {
      const next = removePendingPrompt(pendingQueries(), index);
      setPendingQueries(next.queue);
      setQueueNotice(next.notice);
    },
    clearPendingQueries: () => {
      const next = clearPendingPromptQueue();
      setPendingQueries(next.queue);
      setQueueNotice(next.notice);
    },
    clearHistory: () => {
      setMessages([]);
      const next = clearPendingPromptQueue();
      setPendingQueries(next.queue);
      setQueueNotice(next.notice);
    },
  };
}
