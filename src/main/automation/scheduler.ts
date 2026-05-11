import fs from "node:fs";
import path from "node:path";
import { app, ipcMain } from "electron";
import { Channels } from "../../shared/channels";
import type {
  AutomationActivityEntry,
  ScheduleConfig,
  ScheduledJob,
} from "../../shared/types";
import { loadSettings } from "../config/settings";
import { createProvider } from "../ai/provider";
import { handleAIQuery } from "../ai/commands";
import {
  endAIStream,
  isAIStreamActive,
  onAIStreamIdle,
  tryBeginAIStream,
} from "../ai/stream-lock";
import { createLogger } from "../../shared/logger";
import type { WindowState } from "../window";
import type { AgentRuntime } from "../agent/runtime";
import { assertTrustedIpcSender } from "../ipc/common";

const logger = createLogger("Scheduler");

let jobs: ScheduledJob[] = [];
let pollInterval: ReturnType<typeof setInterval> | null = null;
let alignStartTimeout: ReturnType<typeof setTimeout> | null = null;
let removeIdleListener: (() => void) | null = null;
let broadcastFn: ((channel: string, ...args: unknown[]) => void) | null = null;

export function getScheduledKitIds(): ReadonlySet<string> {
  return new Set(jobs.filter((j) => j.enabled).map((j) => j.kitId));
}

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
    const jobsPath = getJobsPath();
    fs.mkdirSync(path.dirname(jobsPath), { recursive: true });
    fs.writeFileSync(jobsPath, JSON.stringify(jobs, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    fs.chmodSync(jobsPath, 0o600);
  } catch (err) {
    logger.warn("Failed to save jobs:", err);
  }
}

function normalizeJob(job: ScheduledJob, now: Date = new Date()): boolean {
  if (!job.enabled) return false;

  if (job.schedule.type === "once") {
    const runAt = job.schedule.runAt ? new Date(job.schedule.runAt) : null;
    if (!runAt || Number.isNaN(runAt.getTime()) || runAt <= now) {
      job.enabled = false;
      return true; // disabled stale job — persist the change
    }
    const nextRunAt = runAt.toISOString();
    if (job.nextRunAt !== nextRunAt) {
      job.nextRunAt = nextRunAt;
      return true;
    }
    return false;
  }

  const nextRunAt = computeNextRun(job.schedule, now).toISOString();
  if (job.nextRunAt !== nextRunAt) {
    job.nextRunAt = nextRunAt;
    return true;
  }
  return false;
}

function normalizeJobs(now: Date = new Date()): boolean {
  let changed = false;
  for (const job of jobs) {
    changed = normalizeJob(job, now) || changed;
  }
  return changed;
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
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

export function isValidScheduleConfig(s: unknown): s is ScheduleConfig {
  if (!s || typeof s !== "object") return false;
  const sc = s as Record<string, unknown>;
  if (!["once", "hourly", "daily", "weekly"].includes(sc.type as string)) return false;
  if (sc.type === "once") {
    if (typeof sc.runAt !== "string") return false;
    if (Number.isNaN(new Date(sc.runAt).getTime())) return false;
  }
  if (
    (sc.type === "daily" || sc.type === "weekly") &&
    (!isIntegerInRange(sc.hour, 0, 23) || !isIntegerInRange(sc.minute, 0, 59))
  )
    return false;
  if (sc.type === "weekly" && !isIntegerInRange(sc.dayOfWeek, 0, 6)) return false;
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
    (j.fieldValues === undefined || isStringRecord(j.fieldValues)) &&
    isValidScheduleConfig(j.schedule) &&
    typeof j.enabled === "boolean"
  );
}

export function normalizeScheduledJob(
  job: ScheduledJob,
  now: Date = new Date(),
): boolean {
  return normalizeJob(job, now);
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
  const activityId = `scheduled:${job.id}:${Date.now()}`;
  const startActivity = () => {
    const entry: AutomationActivityEntry = {
      id: activityId,
      source: "scheduled",
      title: job.kitName,
      icon: job.kitIcon,
      status: "running",
      startedAt: new Date().toISOString(),
      output: "",
    };
    send(Channels.AUTOMATION_ACTIVITY_START, entry);
  };
  const appendActivity = (chunk: string) => {
    send(Channels.AUTOMATION_ACTIVITY_CHUNK, { id: activityId, chunk });
  };
  const finishActivity = (status: "completed" | "failed") => {
    send(Channels.AUTOMATION_ACTIVITY_END, {
      id: activityId,
      status,
      finishedAt: new Date().toISOString(),
    });
  };

  startActivity();
  if (!settings.chatProvider) {
    logger.warn(`Job "${job.kitName}" skipped — no chat provider configured`);
    appendActivity(
      "Chat provider not configured. Open Settings (Ctrl+,) to choose a provider.",
    );
    finishActivity("failed");
    return;
  }

  if (process.env.VESSEL_DEBUG_SCHEDULER === '1' || process.env.VESSEL_DEBUG_SCHEDULER === 'true') {
    logger.info(`Firing scheduled job: ${job.kitName} (${job.id})`);
  }
  try {
    const provider = createProvider(settings.chatProvider);
    const activeTab = tabManager.getActiveTab();
    await handleAIQuery(
      job.renderedPrompt,
      provider,
      activeTab?.view.webContents,
      (chunk) => appendActivity(chunk),
      () => finishActivity("completed"),
      tabManager,
      runtime,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    appendActivity(`\n[Scheduled Kit Error: ${msg}]`);
    finishActivity("failed");
  }
}

function tick(windowState: WindowState, runtime: AgentRuntime): void {
  if (isAIStreamActive()) return;

  const dueIds = jobs
    .filter((job) => job.enabled && new Date() >= new Date(job.nextRunAt))
    .map((job) => job.id);

  if (dueIds.length === 0) return;
  if (!tryBeginAIStream("scheduled")) return;

  let idx = 0;

  const fireNext = (): void => {
    if (idx >= dueIds.length) {
      endAIStream("scheduled");
      queueMicrotask(() => tick(windowState, runtime));
      return;
    }

    const jobId = dueIds[idx++];
    const job = jobs.find((candidate) => candidate.id === jobId);
    if (!job || !job.enabled) {
      fireNext();
      return;
    }

    const firedAt = new Date();
    if (firedAt < new Date(job.nextRunAt)) {
      fireNext();
      return;
    }

    job.lastRunAt = firedAt.toISOString();

    if (job.schedule.type === "once") {
      job.enabled = false;
    } else {
      job.nextRunAt = computeNextRun(job.schedule, firedAt).toISOString();
    }

    saveJobs();
    broadcastFn?.(Channels.SCHEDULE_JOBS_UPDATE, jobs);

    void fireJob(job, windowState, runtime)
      .catch((err) => {
        logger.warn("Unexpected error firing job:", err);
      })
      .finally(fireNext);
  };

  fireNext();
}

export function registerScheduleHandlers(
  windowState: WindowState,
  runtime: AgentRuntime,
  sendToAll: (channel: string, ...args: unknown[]) => void,
): void {
  broadcastFn = sendToAll;
  loadJobs();
  if (normalizeJobs()) {
    saveJobs();
  }

  removeIdleListener?.();
  removeIdleListener = onAIStreamIdle(() => tick(windowState, runtime));

  // Align the first tick to the top of the next minute so jobs fire at :00 seconds.
  const now = new Date();
  const msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
  alignStartTimeout = setTimeout(() => {
    alignStartTimeout = null;
    tick(windowState, runtime);
    pollInterval = setInterval(() => tick(windowState, runtime), 60_000);
  }, msToNextMinute);

  ipcMain.handle(Channels.SCHEDULE_GET_ALL, (event) => {
    assertTrustedIpcSender(event);
    return jobs;
  });

  ipcMain.handle(Channels.SCHEDULE_CREATE, (event, rawJob: unknown) => {
    assertTrustedIpcSender(event);
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

  ipcMain.handle(Channels.SCHEDULE_UPDATE, (event, id: unknown, updates: unknown) => {
    assertTrustedIpcSender(event);
    if (typeof id !== "string") throw new Error("id must be a string");
    const job = jobs.find((j) => j.id === id);
    if (!job) return null;
    if (updates && typeof updates === "object") {
      const u = updates as Partial<Pick<ScheduledJob, "enabled" | "schedule" | "renderedPrompt" | "fieldValues">>;
      const wasEnabled = job.enabled;
      if (u.enabled !== undefined) job.enabled = u.enabled;
      if (u.schedule !== undefined && isValidScheduleConfig(u.schedule)) {
        job.schedule = u.schedule;
        job.nextRunAt = computeNextRun(u.schedule).toISOString();
      }
      if (typeof u.renderedPrompt === "string" && u.renderedPrompt.length > 0) {
        job.renderedPrompt = u.renderedPrompt;
      }
      if (u.fieldValues !== undefined && isStringRecord(u.fieldValues)) {
        job.fieldValues = u.fieldValues;
      }
      if ((u.schedule !== undefined || (u.enabled === true && !wasEnabled)) && job.enabled) {
        normalizeJob(job);
      }
    }
    saveJobs();
    sendToAll(Channels.SCHEDULE_JOBS_UPDATE, jobs);
    return job;
  });

  ipcMain.handle(Channels.SCHEDULE_DELETE, (event, id: unknown) => {
    assertTrustedIpcSender(event);
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
  if (removeIdleListener) {
    removeIdleListener();
    removeIdleListener = null;
  }
  if (alignStartTimeout) {
    clearTimeout(alignStartTimeout);
    alignStartTimeout = null;
  }
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}
