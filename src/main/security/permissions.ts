import { app, dialog, session } from "electron";
import path from "node:path";
import { Channels } from "../../shared/channels";
import type { PermissionRecord } from "../../shared/types";
import { createDebouncedJsonPersistence, loadJsonFile } from "../persistence/json-file";

const filePath = () => path.join(app.getPath("userData"), "vessel-permissions.json");
const ALLOWED_PERMISSION_TYPES = new Set([
  "clipboard-read",
  "fullscreen",
  "geolocation",
  "media",
  "midiSysex",
  "notifications",
  "pointerLock",
]);

function parseOrigin(value: string): string | null {
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

function isPermissionRecord(value: unknown): value is PermissionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PermissionRecord>;
  return (
    typeof record.origin === "string" &&
    parseOrigin(record.origin) === record.origin &&
    typeof record.permission === "string" &&
    ALLOWED_PERMISSION_TYPES.has(record.permission) &&
    (record.decision === "allow" || record.decision === "deny") &&
    typeof record.updatedAt === "string"
  );
}

let records = loadJsonFile<PermissionRecord[]>({
  filePath: filePath(),
  fallback: [],
  parse: (raw) => Array.isArray(raw) ? raw.filter(isPermissionRecord) : [],
});
const persistence = createDebouncedJsonPersistence({ debounceMs: 250, filePath: filePath(), getValue: () => records, logLabel: "permissions" });
const sessionDecisions = new Map<string, "allow" | "deny">();
let broadcaster: ((channel: string, payload: unknown) => void) | null = null;

function key(origin: string, permission: string): string { return `${origin}\n${permission}`; }
function snapshot(): PermissionRecord[] { return records.map((record) => ({ ...record })); }
function emit(): void { broadcaster?.(Channels.PERMISSIONS_GET, snapshot()); }
function save(origin: string, permission: string, decision: "allow" | "deny"): void {
  const k = key(origin, permission);
  const existing = records.find((r) => key(r.origin, r.permission) === k);
  const updatedAt = new Date().toISOString();
  if (existing) Object.assign(existing, { decision, updatedAt });
  else records.unshift({ origin, permission, decision, updatedAt });
  persistence.schedule();
  emit();
}

export function listPermissions(): PermissionRecord[] { return snapshot(); }
export function clearPermissions(): void { records = []; sessionDecisions.clear(); persistence.schedule(); emit(); }
export function clearPermissionsForOrigin(origin: string): void {
  if (!parseOrigin(origin)) return;
  records = records.filter((record) => record.origin !== origin);
  for (const storedKey of sessionDecisions.keys()) {
    if (storedKey.startsWith(`${origin}\n`)) sessionDecisions.delete(storedKey);
  }
  persistence.schedule();
  emit();
}
export function setPermissionBroadcaster(fn: (channel: string, payload: unknown) => void): void { broadcaster = fn; }

export function installPermissionHandler(): void {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details: { requestingUrl?: string }) => {
    if (!ALLOWED_PERMISSION_TYPES.has(permission)) { callback(false); return; }
    const origin = parseOrigin(details.requestingUrl || webContents.getURL());
    if (!origin) { callback(false); return; }
    const k = key(origin, permission);
    const existing = records.find((r) => r.origin === origin && r.permission === permission);
    if (existing) { callback(existing.decision === "allow"); return; }
    const sessionDecision = sessionDecisions.get(k);
    if (sessionDecision) { callback(sessionDecision === "allow"); return; }
    const result = dialog.showMessageBoxSync({
      type: "question",
      buttons: ["Deny", "Allow Once", "Allow Until Quit", "Always Allow"],
      defaultId: 0,
      cancelId: 0,
      title: "Site permission request",
      message: `${origin} wants to use ${permission}`,
      detail: "Temporary choices are safer for camera, microphone, location, and clipboard access. Persistent choices can be cleared in Settings > Privacy.",
    });
    if (result === 1) { callback(true); return; }
    if (result === 2) { sessionDecisions.set(k, "allow"); callback(true); return; }
    if (result === 3) { save(origin, permission, "allow"); callback(true); return; }
    save(origin, permission, "deny");
    callback(false);
  });
}
