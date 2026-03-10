import { app } from "electron";
import path from "path";
import fs from "fs";
import type { VesselSettings } from "../../shared/types";

const defaults: VesselSettings = {
  defaultUrl: "https://start.duckduckgo.com",
  theme: "dark",
  sidebarWidth: 340,
  mcpPort: 3100,
  autoRestoreSession: true,
  clearBookmarksOnLaunch: false,
  approvalMode: "confirm-dangerous",
};

let settings: VesselSettings | null = null;

function getSettingsPath(): string {
  return path.join(app.getPath("userData"), "vessel-settings.json");
}

export function loadSettings(): VesselSettings {
  if (settings) return settings;
  try {
    const raw = fs.readFileSync(getSettingsPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<VesselSettings> & {
      apiKey?: string;
      provider?: unknown;
    };
    delete parsed.apiKey;
    delete parsed.provider;
    settings = {
      ...defaults,
      ...parsed,
    };
  } catch {
    settings = { ...defaults };
  }
  return settings!;
}

function saveSettings(): void {
  fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true });
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2));
}

export function setSetting<K extends keyof VesselSettings>(
  key: K,
  value: VesselSettings[K],
): void {
  loadSettings();
  settings![key] = value;
  saveSettings();
}
