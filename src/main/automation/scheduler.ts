import fs from "node:fs";
import path from "node:path";
import { app, ipcMain } from "electron";
import { Channels } from "../../shared/channels";
import type { ScheduleConfig, ScheduledJob } from "../../shared/types";
import { loadSettings } from "../config/settings";
import { createProvider } from "../ai/provider";
import { handleAIQuery } from "../ai/commands";
import type { WindowState } from "../window";
import type { AgentRuntime } from "../agent/runtime";

let jobs: ScheduledJob[] = [];
let pollInterval: ReturnType<typeof setInterval> | null = null;
let broadcastFn: ((channel: string, ...args: unknown[]) => void) | null = null;

function getJobsPath(): string {
  return path.join(app.getPath("userData"), "scheduled-jobs.json");
}

function loadJobs(): void {
  try {
    const raw = fs.readFileSync(getJobsPath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      jobs = parsed as ScheduledJob[];
    }
  } catch {
    jobs = [];
  }
}

function saveJobs(): void {
  try {
    fs.writeFileSync(getJobsPath(), JSON.stringify(jobs, null, 2), "utf-8");
  } catch (err) {
    console.warn("[scheduler] Failed to save jobs:", err);
  }
}

export function computeNextRun(schedule: ScheduleConfig, from: Date = new Date()): Date {
  switch (schedule.type) {
    case "once":
      return new Date(schedule.runAt!);
    case "hourly": {
      const next = new Date(from);
      next.setMinutes(0, 0, 0);
      next.setHours(next.getHours() + 1);
      return next;
    }
    case "daily": {
      const next = new Date(from);
      next.setHours(schedule.hour!, schedule.minute!, 0, 0);
      if (next <= from) next.setDate(next.getDate() + 1);
      return next;
    }
    case "weekly": {
      const next = new Date(from);
      next.setHours(schedule.hour!, schedule.minute!, 0, 0);
      const daysUntil = (schedule.dayOfWeek! - next.getDay() + 7) % 7;
      if (daysUntil === 0 && next <= from) {
        next.setDate(next.getDate() + 7);
      } else {
        next.setDate(next.getDate() + (daysUntil || 7));
      }
      return next;
    }
  }
}

function isValidScheduleConfig(s: unknown): s is ScheduleConfig {
  if (!s || typeof s !== "object") return false;
  const sc = s as Record<string, unknown>;
  if (!["once", "hourly", "daily", "weekly"].includes(sc.type as string)) return false;
  if (sc.type === "once" && typeof sc.runAt !== "string") return false;
  if (
    (sc.type === "daily" || sc.type === "weekly") &&
    (typeof sc.hour !== "number" || typeof sc.minute !== "number")
  )
    return false;
  if (sc.type === "weekly" && typeof sc.dayOfWeek !== "number") return false;
  return true;
}

function isValidJobData(
  v: unknown,
): v is Omit<ScheduledJob, "id" | "createdAt" | "nextRunAt"> {
  if (!v || typeof v !== "object") return false;
  const j = v as Record<string, unknown>;
  return (
    typeof j.kitId === "string" &&
    j.kitId.length > 0 &&
    typeof j.kitName === "string" &&
    j.kitName.length > 0 &&
    typeof j.kitIcon === "string" &&
    typeof j.renderedPrompt === "string" &&
    j.renderedPrompt.length > 0 &&
    isValidScheduleConfig(j.schedule) &&
    typeof j.enabled === "boolean"
  );
}

async function fireJob(
  job: ScheduledJob,
  windowState: WindowState,
  runtime: AgentRuntime,
): Promise<void> {
  const { chromeView, sidebarView, devtoolsPanelView, tabManager } = windowState;

  const send = (channel: string, ...args: unknown[]) => {
    if (!chromeView.webContents.isDestroyed())
      chromeView.webContents.send(channel, ...args);
    if (!sidebarView.webContents.isDestroyed())
      sidebarView.webContents.send(channel, ...args);
    if (!devtoolsPanelView.webContents.isDestroyed())
      devtoolsPanelView.webContents.send(channel, ...args);
  };

  const settings = loadSettings();
  if (!settings.chatProvider) {
    console.warn(`[scheduler] Job "${job.kitName}" skipped — no chat provider configured`);
    return;
  }

  console.log(`[scheduler] Firing scheduled job: ${job.kitName} (${job.id})`);
  send(Channels.AI_STREAM_START, job.renderedPrompt);
  try {
    const provider = createProvider(settings.chatProvider);
    const activeTab = tabManager.getActiveTab();
    await handleAIQuery(
      job.renderedPrompt,
      provider,
      activeTab?.view.webContents,
      (chunk) => send(Channels.AI_STREAM_CHUNK, chunk),
      () => send(Channels.AI_STREAM_END),
      tabManager,
      runtime,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    send(Channels.AI_STREAM_CHUNK, `\n[Scheduled Kit Error: ${msg}]`);
    send(Channels.AI_STREAM_END);
  }
}

function tick(windowState: WindowState, runtime: AgentRuntime): void {
  const now = new Date();
  let changed = false;

  for (const job of jobs) {
    if (!job.enabled) continue;
    if (now < new Date(job.nextRunAt)) continue;

    void fireJob(job, windowState, runtime);
    job.lastRunAt = now.toISOString();

    if (job.schedule.type === "once") {
      job.enabled = false;
    } else {
      job.nextRunAt = computeNextRun(job.schedule, now).toISOString();
    }
    changed = true;
  }

  if (changed) {
    saveJobs();
    broadcastFn?.(Channels.SCHEDULE_JOBS_UPDATE, jobs);
  }
}

export function registerScheduleHandlers(
  windowState: WindowState,
  runtime: AgentRuntime,
  sendToAll: (channel: string, ...args: unknown[]) => void,
): void {
  broadcastFn = sendToAll;
  loadJobs();
  pollInterval = setInterval(() => tick(windowState, runtime), 60_000);

  ipcMain.handle(Channels.SCHEDULE_GET_ALL, () => jobs);

  ipcMain.handle(Channels.SCHEDULE_CREATE, (_, rawJob: unknown) => {
    if (!isValidJobData(rawJob)) {
      throw new Error(
        "Invalid job data. Required: kitId, kitName, kitIcon, renderedPrompt, schedule, enabled.",
      );
    }
    const newJob: ScheduledJob = {
      ...(rawJob as Omit<ScheduledJob, "id" | "createdAt" | "nextRunAt">),
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      nextRunAt: computeNextRun(rawJob.schedule).toISOString(),
    };
    jobs.push(newJob);
    saveJobs();
    sendToAll(Channels.SCHEDULE_JOBS_UPDATE, jobs);
    return newJob;
  });

  ipcMain.handle(Channels.SCHEDULE_UPDATE, (_, id: unknown, updates: unknown) => {
    if (typeof id !== "string") throw new Error("id must be a string");
    const job = jobs.find((j) => j.id === id);
    if (!job) return null;
    if (updates && typeof updates === "object") {
      const u = updates as Partial<Pick<ScheduledJob, "enabled" | "schedule">>;
      if (u.enabled !== undefined) job.enabled = u.enabled;
      if (u.schedule !== undefined && isValidScheduleConfig(u.schedule)) {
        job.schedule = u.schedule;
        job.nextRunAt = computeNextRun(u.schedule).toISOString();
      }
    }
    saveJobs();
    sendToAll(Channels.SCHEDULE_JOBS_UPDATE, jobs);
    return job;
  });

  ipcMain.handle(Channels.SCHEDULE_DELETE, (_, id: unknown) => {
    if (typeof id !== "string") throw new Error("id must be a string");
    const before = jobs.length;
    jobs = jobs.filter((j) => j.id !== id);
    if (jobs.length === before) return false;
    saveJobs();
    sendToAll(Channels.SCHEDULE_JOBS_UPDATE, jobs);
    return true;
  });
}

export function stopScheduler(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}
