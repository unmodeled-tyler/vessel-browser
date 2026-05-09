import { app, dialog, session } from "electron";
import path from "node:path";
import { Channels } from "../../shared/channels";
import type { PermissionRecord } from "../../shared/types";
import { createDebouncedJsonPersistence, loadJsonFile } from "../persistence/json-file";

const filePath = () => path.join(app.getPath("userData"), "vessel-permissions.json");
let records = loadJsonFile<PermissionRecord[]>({
  filePath: filePath(),
  fallback: [],
  parse: (raw) => Array.isArray(raw) ? raw as PermissionRecord[] : [],
});
const persistence = createDebouncedJsonPersistence({ debounceMs: 250, filePath: filePath(), getValue: () => records, logLabel: "permissions" });
let broadcaster: ((channel: string, payload: unknown) => void) | null = null;

function key(origin: string, permission: string): string { return `${origin}\n${permission}`; }
function emit(): void { broadcaster?.(Channels.PERMISSIONS_GET, records); }
function save(origin: string, permission: string, decision: "allow" | "deny"): void {
  const k = key(origin, permission);
  const existing = records.find((r) => key(r.origin, r.permission) === k);
  const updatedAt = new Date().toISOString();
  if (existing) Object.assign(existing, { decision, updatedAt });
  else records.unshift({ origin, permission, decision, updatedAt });
  persistence.schedule();
  emit();
}

export function listPermissions(): PermissionRecord[] { return records; }
export function clearPermissions(): void { records = []; persistence.schedule(); emit(); }
export function clearPermissionsForOrigin(origin: string): void {
  records = records.filter((record) => record.origin !== origin);
  persistence.schedule();
  emit();
}
export function setPermissionBroadcaster(fn: (channel: string, payload: unknown) => void): void { broadcaster = fn; }

export function installPermissionHandler(): void {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details: { requestingUrl?: string }) => {
    const origin = new URL(details.requestingUrl || webContents.getURL()).origin;
    const existing = records.find((r) => r.origin === origin && r.permission === permission);
    if (existing) { callback(existing.decision === "allow"); return; }
    const result = dialog.showMessageBoxSync({
      type: "question",
      buttons: ["Deny", "Allow"],
      defaultId: 0,
      cancelId: 0,
      title: "Site permission request",
      message: `${origin} wants to use ${permission}`,
      detail: "Vessel will remember your choice. You can clear saved permissions in Settings > Privacy.",
    });
    const decision = result === 1 ? "allow" : "deny";
    save(origin, permission, decision);
    callback(decision === "allow");
  });
}
