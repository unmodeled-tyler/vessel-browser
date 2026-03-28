export const MAX_PENDING_QUERIES = 5;

function formatQueuedNotice(queueLength: number, limit = MAX_PENDING_QUERIES): string | null {
  if (queueLength <= 0) return null;
  return `Queued ${queueLength}/${limit}. I’ll send ${queueLength === 1 ? "it" : "them"} automatically when the current run finishes.`;
}

function formatRemainingNotice(queueLength: number): string | null {
  if (queueLength <= 0) return null;
  return `${queueLength} queued ${queueLength === 1 ? "prompt" : "prompts"} remaining.`;
}

export function enqueuePendingPrompt(
  queue: string[],
  prompt: string,
  options?: { atFront?: boolean; limit?: number },
):
  | { status: "queued"; queue: string[]; notice: string }
  | { status: "rejected"; queue: string[]; notice: string } {
  const limit = options?.limit ?? MAX_PENDING_QUERIES;
  if (queue.length >= limit) {
    return {
      status: "rejected",
      queue,
      notice: `Queue full. Finish or cancel the current run before adding more than ${limit} pending prompts.`,
    };
  }

  const nextQueue = options?.atFront ? [prompt, ...queue] : [...queue, prompt];
  return {
    status: "queued",
    queue: nextQueue,
    notice: formatQueuedNotice(nextQueue.length, limit) ?? "",
  };
}

export function dequeuePendingPrompt(queue: string[]): {
  nextPrompt: string | null;
  queue: string[];
  notice: string | null;
} {
  if (queue.length === 0) {
    return { nextPrompt: null, queue, notice: null };
  }

  const [nextPrompt, ...remaining] = queue;
  return {
    nextPrompt,
    queue: remaining,
    notice: formatRemainingNotice(remaining.length),
  };
}

export function removePendingPrompt(queue: string[], index: number): {
  queue: string[];
  notice: string | null;
} {
  if (index < 0 || index >= queue.length) {
    return { queue, notice: formatQueuedNotice(queue.length) };
  }

  const nextQueue = queue.filter((_, itemIndex) => itemIndex !== index);
  return {
    queue: nextQueue,
    notice: formatQueuedNotice(nextQueue.length),
  };
}

export function clearPendingPromptQueue(): {
  queue: string[];
  notice: null;
} {
  return {
    queue: [],
    notice: null,
  };
}
