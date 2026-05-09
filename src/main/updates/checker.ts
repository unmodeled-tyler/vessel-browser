import { app, shell } from "electron";
import type { UpdateCheckResult } from "../../shared/types";

const NPM_PACKAGE_URL = "https://registry.npmjs.org/@quanta-intellect%2Fvessel-browser/latest";
const RELEASES_URL = "https://github.com/unmodeled-tyler/quanta-vessel-browser/releases/latest";

function normalizeVersion(version: string): number[] {
  return version
    .replace(/^v/i, "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

function compareVersions(a: string, b: string): number {
  const av = normalizeVersion(a);
  const bv = normalizeVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if ((av[i] ?? 0) > (bv[i] ?? 0)) return 1;
    if ((av[i] ?? 0) < (bv[i] ?? 0)) return -1;
  }
  return 0;
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion();
  const checkedAt = new Date().toISOString();

  try {
    const response = await fetch(NPM_PACKAGE_URL, {
      headers: { accept: "application/json", "user-agent": `Vessel/${currentVersion}` },
    });
    if (!response.ok) {
      throw new Error(`Registry responded with ${response.status}`);
    }
    const body = (await response.json()) as { version?: unknown; homepage?: unknown };
    const latestVersion = typeof body.version === "string" ? body.version : null;
    if (!latestVersion) throw new Error("Registry response did not include a version");

    return {
      currentVersion,
      latestVersion,
      updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
      checkedAt,
      releaseUrl: RELEASES_URL,
    };
  } catch (error) {
    return {
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      checkedAt,
      releaseUrl: RELEASES_URL,
      error: error instanceof Error ? error.message : "Update check failed",
    };
  }
}

export async function openUpdateDownload(): Promise<void> {
  await shell.openExternal(RELEASES_URL);
}
