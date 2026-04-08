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
let pendingDrainScheduled = false;
let listenerCleanups: Array<() => void> = [];
let pendingAutomationActivity:
  | { id: string; title: string; icon?: string }
  | null = null;
let activeAutomationActivityId: string | null = null;

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

function schedulePendingDrain(): void {
  if (pendingDrainScheduled || isStreaming()) return;
  if (pendingQueries().length === 0) {
    setQueueNotice(null);
    return;
  }

  pendingDrainScheduled = true;
  queueMicrotask(() => {
    pendingDrainScheduled = false;
    if (isStreaming()) return;

    const next = dequeuePendingPrompt(pendingQueries());
    setPendingQueries(next.queue);
    setQueueNotice(next.notice);
    if (next.nextPrompt) {
      void dispatchQueuedPrompt(next.nextPrompt);
    }
  });
}

function init() {
  if (initialized) return;
  initialized = true;
  listenerCleanups.push(window.vessel.ai.onStreamStart((prompt: string) => {
    setMessages((prev) => {
      const next = [...prev, { role: "user" as const, content: prompt }];
      return trimMessages(next);
    });
    setStreamingText("");
    setIsStreaming(true);
    setHasFirstChunk(false);
    setStreamStartedAt(Date.now());

    if (pendingAutomationActivity) {
      const activity = pendingAutomationActivity;
      activeAutomationActivityId = activity.id;
      setAutomationActivities((prev) =>
        startAutomationActivity(prev, {
          id: activity.id,
          source: "scheduled",
          title: activity.title,
          icon: activity.icon,
          status: "running",
          startedAt: new Date().toISOString(),
        }),
      );
      pendingAutomationActivity = null;
    }
  }));
  listenerCleanups.push(window.vessel.ai.onStreamChunk((chunk: string) => {
    if (!hasFirstChunk()) {
      setHasFirstChunk(true);
    }
    setStreamingText((prev) => prev + chunk);
    if (activeAutomationActivityId) {
      const activityId = activeAutomationActivityId;
      setAutomationActivities((prev) =>
        appendAutomationActivityChunk(prev, activityId, chunk),
      );
    }
  }));
  listenerCleanups.push(window.vessel.ai.onStreamEnd((status) => {
    const finalText = streamingText();
    if (finalText) {
      setMessages((prev) => {
        const next = [...prev, { role: "assistant" as const, content: finalText }];
        return trimMessages(next);
      });
    }
    if (activeAutomationActivityId) {
      const activityId = activeAutomationActivityId;
      setAutomationActivities((prev) =>
        finishAutomationActivity(
          prev,
          activityId,
          status,
          new Date().toISOString(),
        ),
      );
      activeAutomationActivityId = null;
    }
    pendingAutomationActivity = null;
    setStreamingText("");
    setIsStreaming(false);
    setHasFirstChunk(false);
    setStreamStartedAt(null);
    schedulePendingDrain();
  }));
  listenerCleanups.push(window.vessel.ai.onStreamIdle(() => {
    schedulePendingDrain();
  }));
  listenerCleanups.push(window.vessel.ai.onAutomationActivityStart((entry) => {
    setAutomationActivities((prev) => startAutomationActivity(prev, entry));
  }));
  listenerCleanups.push(window.vessel.ai.onAutomationActivityChunk(({ id, chunk }) => {
    setAutomationActivities((prev) =>
      appendAutomationActivityChunk(prev, id, chunk),
    );
  }));
  listenerCleanups.push(window.vessel.ai.onAutomationActivityEnd(({ id, status, finishedAt }) => {
    setAutomationActivities((prev) =>
      finishAutomationActivity(prev, id, status, finishedAt),
    );
  }));
}

export function resetAIStoreForTests(): void {
  for (const cleanup of listenerCleanups) {
    cleanup();
  }
  listenerCleanups = [];
  initialized = false;
  pendingDrainScheduled = false;
  pendingAutomationActivity = null;
  activeAutomationActivityId = null;
  setMessages([]);
  setStreamingText("");
  setIsStreaming(false);
  setHasFirstChunk(false);
  setStreamStartedAt(null);
  setRecentQueries([]);
  setPendingQueries([]);
  setQueueNotice(null);
  setAutomationActivities([]);
}

export function useAI() {
  init();
  const query = async (prompt: string) => {
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
  };

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
    query,
    runAutomationPrompt: async (
      prompt: string,
      activity: { id: string; title: string; icon?: string },
    ) => {
      pendingAutomationActivity = activity;
      const status = await query(prompt);
      if (status !== "started") {
        pendingAutomationActivity = null;
      }
      return status;
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
