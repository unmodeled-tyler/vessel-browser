import { randomUUID } from "node:crypto";
import type { TaskMemory, TaskMemoryNote, TaskMemoryStatus } from "../../shared/types";

const MAX_NOTES = 50;

export interface TaskMemoryStartOptions {
  nextStep?: string | null;
  facts?: Record<string, string>;
}

export function createTaskMemory(
  goal: string,
  options: TaskMemoryStartOptions = {},
): TaskMemory {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    goal: goal.trim(),
    status: "active",
    blocker: null,
    notes: [],
    nextStep: options.nextStep?.trim() || null,
    facts: { ...(options.facts ?? {}) },
    startedAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

export function updateTaskMemory(
  task: TaskMemory,
  patch: {
    nextStep?: string | null;
    facts?: Record<string, string>;
  },
): TaskMemory {
  const updated: TaskMemory = {
    ...task,
    nextStep: patch.nextStep !== undefined ? patch.nextStep : task.nextStep,
    facts: {
      ...task.facts,
      ...(patch.facts ?? {}),
    },
    updatedAt: new Date().toISOString(),
  };
  return updated;
}

export function addTaskNote(task: TaskMemory, text: string): TaskMemory {
  const note: TaskMemoryNote = {
    id: randomUUID(),
    text: text.trim(),
    createdAt: new Date().toISOString(),
  };
  const notes = [...task.notes, note].slice(-MAX_NOTES);
  return {
    ...task,
    notes,
    updatedAt: new Date().toISOString(),
  };
}

export function setTaskBlocker(task: TaskMemory, blocker: string | null): TaskMemory {
  const status: TaskMemoryStatus = blocker ? "blocked" : task.status === "blocked" ? "active" : task.status;
  return {
    ...task,
    status,
    blocker,
    updatedAt: new Date().toISOString(),
  };
}

export function resolveTaskMemory(task: TaskMemory, summary?: string): TaskMemory {
  const now = new Date().toISOString();
  let notes = task.notes;
  if (summary?.trim()) {
    const note: TaskMemoryNote = {
      id: randomUUID(),
      text: summary.trim(),
      createdAt: now,
    };
    notes = [...task.notes, note].slice(-MAX_NOTES);
  }
  return {
    ...task,
    status: "completed",
    blocker: null,
    notes,
    completedAt: now,
    updatedAt: now,
  };
}

export function abandonTaskMemory(task: TaskMemory, reason?: string): TaskMemory {
  const now = new Date().toISOString();
  let notes = task.notes;
  if (reason?.trim()) {
    const note: TaskMemoryNote = {
      id: randomUUID(),
      text: `Abandoned: ${reason.trim()}`,
      createdAt: now,
    };
    notes = [...task.notes, note].slice(-MAX_NOTES);
  }
  return {
    ...task,
    status: "abandoned",
    blocker: null,
    notes,
    completedAt: now,
    updatedAt: now,
  };
}

export function formatTaskMemory(task: TaskMemory | null): string {
  if (!task) return "";

  const lines = [
    "--- Task Memory ---",
    `Goal: ${task.goal}`,
    `Status: ${task.status}${task.blocker ? ` (blocked: ${task.blocker})` : ""}`,
  ];

  if (task.nextStep) {
    lines.push(`Next step: ${task.nextStep}`);
  }

  if (Object.keys(task.facts).length > 0) {
    lines.push("Facts:");
    for (const [key, value] of Object.entries(task.facts)) {
      lines.push(`  ${key}: ${value}`);
    }
  }

  if (task.notes.length > 0) {
    lines.push("Notes:");
    for (const note of task.notes.slice(-10)) {
      const time = note.createdAt.slice(11, 16);
      lines.push(`  [${time}] ${note.text}`);
    }
  }

  lines.push("---");
  return lines.join("\n");
}
