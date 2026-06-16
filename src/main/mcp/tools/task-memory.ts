import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentRuntime } from "../../agent/runtime";
import type { TabManager } from "../../tabs/tab-manager";
import { asTextResponse } from "../mcp-helpers";

export function registerTaskMemoryTools(
  server: McpServer,
  _tabManager: TabManager,
  runtime: AgentRuntime,
): void {
  server.registerTool(
    "task_start",
    {
      title: "Start Task",
      description:
        "Start tracking a task. Creates a task memory record with a goal that persists across actions and browser navigation. Use this at the beginning of a multi-step task so the human supervisor can see what you are working on.",
      inputSchema: {
        goal: z
          .string()
          .describe("What this task aims to accomplish"),
        nextStep: z
          .string()
          .optional()
          .describe("The first step you plan to take"),
        facts: z
          .record(z.string())
          .optional()
          .describe("Key-value facts relevant to this task (e.g. { username: alice })"),
      },
    },
    async ({ goal, nextStep, facts }) => {
      const task = runtime.startTaskMemory(goal, {
        nextStep: nextStep ?? null,
        facts: facts ?? {},
      });
      return asTextResponse(
        `Task started: ${task.goal}\nStatus: ${task.status}${task.nextStep ? `\nNext step: ${task.nextStep}` : ""}`,
      );
    },
  );

  server.registerTool(
    "task_update",
    {
      title: "Update Task",
      description:
        "Update the current task's next step or facts. Facts are merged with existing facts. Use this to record progress and keep the human supervisor informed.",
      inputSchema: {
        nextStep: z
          .string()
          .optional()
          .describe("The next step you plan to take"),
        facts: z
          .record(z.string())
          .optional()
          .describe("Key-value facts to merge into the task (existing keys are overwritten)"),
      },
    },
    async ({ nextStep, facts }) => {
      const updated = runtime.updateTaskMemory({
        nextStep,
        facts,
      });
      if (!updated) return asTextResponse("No active task to update. Start one with task_start first.");
      return asTextResponse(
        `Task updated: ${updated.goal}\nStatus: ${updated.status}${updated.nextStep ? `\nNext step: ${updated.nextStep}` : ""}${Object.keys(updated.facts).length > 0 ? `\nFacts: ${Object.entries(updated.facts).map(([k, v]) => `${k}=${v}`).join(", ")}` : ""}`,
      );
    },
  );

  server.registerTool(
    "task_note",
    {
      title: "Add Task Note",
      description:
        "Add a note to the current task. Use this to record observations, intermediate results, or context for the human supervisor.",
      inputSchema: {
        text: z
          .string()
          .describe("The note text to add"),
      },
    },
    async ({ text }) => {
      const updated = runtime.addTaskNote(text);
      if (!updated) return asTextResponse("No active task to add a note to. Start one with task_start first.");
      return asTextResponse(`Note added to task: ${updated.goal}`);
    },
  );

  server.registerTool(
    "task_blocker",
    {
      title: "Set or Clear Task Blocker",
      description:
        "Mark the task as blocked with a reason, or clear a blocker to resume. Use this when you are stuck and need human input to continue.",
      inputSchema: {
        blocker: z
          .string()
          .optional()
          .describe("Description of what is blocking progress. Omit or empty string to clear a blocker."),
      },
    },
    async ({ blocker }) => {
      const updated = runtime.setTaskBlocker(blocker?.trim() || null);
      if (!updated) return asTextResponse("No active task. Start one with task_start first.");
      if (updated.blocker) {
        return asTextResponse(`Task blocked: ${updated.blocker}\nStatus: ${updated.status}`);
      }
      return asTextResponse(`Blocker cleared. Task: ${updated.goal}\nStatus: ${updated.status}`);
    },
  );

  server.registerTool(
    "task_resolve",
    {
      title: "Resolve Task",
      description:
        "Mark the current task as completed. Optionally add a summary note. Use this when the task goal has been achieved.",
      inputSchema: {
        summary: z
          .string()
          .optional()
          .describe("Brief summary of the completed task"),
      },
    },
    async ({ summary }) => {
      const resolved = runtime.resolveTaskMemory(summary);
      if (!resolved) return asTextResponse("No active task to resolve. Start one with task_start first.");
      return asTextResponse(
        `Task completed: ${resolved.goal}${resolved.notes.length > 0 ? `\nNotes: ${resolved.notes.length} note(s)` : ""}`,
      );
    },
  );

  server.registerTool(
    "task_abandon",
    {
      title: "Abandon Task",
      description:
        "Mark the current task as abandoned. Use this when the task cannot be completed or is no longer relevant.",
      inputSchema: {
        reason: z
          .string()
          .optional()
          .describe("Reason for abandoning the task"),
      },
    },
    async ({ reason }) => {
      const abandoned = runtime.abandonTaskMemory(reason);
      if (!abandoned) return asTextResponse("No active task to abandon. Start one with task_start first.");
      return asTextResponse(
        `Task abandoned: ${abandoned.goal}${reason ? ` (${reason})` : ""}`,
      );
    },
  );

  server.registerTool(
    "task_status",
    {
      title: "Task Status",
      description: "Check the current task memory status including goal, progress, notes, and blocker.",
    },
    async () => {
      const ctx = runtime.getTaskMemoryContext();
      if (!ctx) return asTextResponse("No active task. Start one with task_start.");
      return asTextResponse(ctx);
    },
  );
}
