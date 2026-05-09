import { app, shell } from "electron";
import type { UpdateCheckResult } from "../../shared/types";

const GITHUB_LATEST_RELEASE_API_URL = "https://api.github.com/repos/unmodeled-tyler/quanta-vessel-browser/releases/latest";
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
    const response = await fetch(GITHUB_LATEST_RELEASE_API_URL, {
      headers: { accept: "application/vnd.github+json", "user-agent": `Vessel/${currentVersion}` },
    });
    if (!response.ok) {
      throw new Error(`GitHub Releases responded with ${response.status}`);
    }
    const body = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
    const latestVersion = typeof body.tag_name === "string" ? body.tag_name : null;
    if (!latestVersion) throw new Error("GitHub release response did not include a tag name");
    const releaseUrl = typeof body.html_url === "string" && body.html_url.startsWith("https://github.com/")
      ? body.html_url
      : RELEASES_URL;

    return {
      currentVersion,
      latestVersion,
      updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
      checkedAt,
      releaseUrl,
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
