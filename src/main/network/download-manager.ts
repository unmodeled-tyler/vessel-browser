import { app, shell } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Channels } from "../../shared/channels";
import { createDebouncedJsonPersistence, loadJsonFile } from "../persistence/json-file";

export interface DownloadRecord {
  id: string;
  filename: string;
  savePath: string;
  totalBytes: number;
  receivedBytes: number;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  startedAt: string;
  updatedAt: string;
}

const filePath = () => path.join(app.getPath("userData"), "vessel-downloads.json");

function parse(raw: unknown): { items: DownloadRecord[] } {
  if (!raw || typeof raw !== "object") return { items: [] };
  const items = Array.isArray((raw as { items?: unknown }).items)
    ? ((raw as { items: DownloadRecord[] }).items)
    : [];
  return { items };
}

let state = loadJsonFile({ filePath: filePath(), fallback: { items: [] }, parse });
const persistence = createDebouncedJsonPersistence({
  debounceMs: 250,
  filePath: filePath(),
  getValue: () => state,
  logLabel: "downloads",
});
let broadcaster: ((channel: string, payload: unknown) => void) | null = null;

function persist(): void {
  state.items = state.items.slice(0, 200);
  persistence.schedule();
}

function emit(): void {
  broadcaster?.(Channels.DOWNLOADS_UPDATE, state.items);
}

export function setDownloadBroadcaster(fn: (channel: string, payload: unknown) => void): void {
  broadcaster = fn;
}

export function listDownloads(): DownloadRecord[] {
  return state.items;
}

export function upsertDownload(input: Omit<DownloadRecord, "id" | "startedAt" | "updatedAt">): DownloadRecord {
  const now = new Date().toISOString();
  const existing = state.items.find((item) => item.savePath === input.savePath);
  if (existing) {
    Object.assign(existing, input, { updatedAt: now });
    persist();
    emit();
    return existing;
  }
  const record: DownloadRecord = { id: randomUUID(), ...input, startedAt: now, updatedAt: now };
  state.items = [record, ...state.items];
  persist();
  emit();
  return record;
}

export function clearDownloads(): void {
  state.items = [];
  persist();
  emit();
}

export async function openDownload(id: string): Promise<boolean> {
  const item = state.items.find((d) => d.id === id);
  if (!item || !fs.existsSync(item.savePath)) return false;
  return (await shell.openPath(item.savePath)) === "";
}

export async function showDownloadInFolder(id: string): Promise<boolean> {
  const item = state.items.find((d) => d.id === id);
  if (!item || !fs.existsSync(item.savePath)) return false;
  shell.showItemInFolder(item.savePath);
  return true;
}
