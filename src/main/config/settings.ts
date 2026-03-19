import { app } from "electron";
import path from "path";
import fs from "fs";
import type { RuntimeHealthIssue, VesselSettings } from "../../shared/types";

const defaults: VesselSettings = {
  defaultUrl: "https://start.duckduckgo.com",
  theme: "dark",
  sidebarWidth: 340,
  mcpPort: 3100,
  autoRestoreSession: true,
  clearBookmarksOnLaunch: false,
  obsidianVaultPath: "",
  approvalMode: "confirm-dangerous",
  agentTranscriptMode: "summary",
  chatProvider: null,
  maxToolIterations: 200,
};

let settings: VesselSettings | null = null;
let settingsIssues: RuntimeHealthIssue[] = [];

export function getSettingsPath(): string {
  return path.join(app.getPath("userData"), "vessel-settings.json");
}

export function getSettingsLoadIssues(): RuntimeHealthIssue[] {
  return settingsIssues.map((issue) => ({ ...issue }));
}

function sanitizePort(value: unknown): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
    return parsed;
  }
  settingsIssues.push({
    code: "settings-invalid-mcp-port",
    severity: "warning",
    title: "Invalid MCP port in settings",
    detail: `Expected an integer between 1 and 65535 but found ${JSON.stringify(value)}.`,
    action: `Using default port ${defaults.mcpPort} instead.`,
  });
  return defaults.mcpPort;
}

export function loadSettings(): VesselSettings {
  if (settings) return settings;
  settingsIssues = [];
  try {
    const raw = fs.readFileSync(getSettingsPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<VesselSettings> & {
      apiKey?: string;
      provider?: unknown;
      showAgentTranscript?: unknown;
      agentTranscriptMode?: unknown;
    };
    delete parsed.apiKey;
    delete parsed.provider;
    settings = {
      ...defaults,
      ...parsed,
      mcpPort: sanitizePort(parsed.mcpPort ?? defaults.mcpPort),
      agentTranscriptMode:
        parsed.agentTranscriptMode === "off" ||
        parsed.agentTranscriptMode === "summary" ||
        parsed.agentTranscriptMode === "full"
          ? parsed.agentTranscriptMode
          : parsed.showAgentTranscript === false
            ? "off"
            : defaults.agentTranscriptMode,
    };
  } catch (error) {
    if (fs.existsSync(getSettingsPath())) {
      settingsIssues.push({
        code: "settings-read-failed",
        severity: "warning",
        title: "Could not read Vessel settings",
        detail:
          error instanceof Error ? error.message : "Unknown settings error.",
        action: "Falling back to built-in defaults for this launch.",
      });
    }
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
): VesselSettings {
  loadSettings();
  if (key === "mcpPort") {
    settings!.mcpPort = sanitizePort(value);
  } else {
    settings![key] = value;
  }
  saveSettings();
  return { ...settings! };
}
