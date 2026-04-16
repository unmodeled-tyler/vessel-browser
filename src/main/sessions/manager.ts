import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { app, session } from "electron";
import type {
  NamedSessionData,
  NamedSessionSummary,
  PersistedCookie,
} from "../../shared/types";
import type { TabManager } from "../tabs/tab-manager";
import { waitForLoad } from "../utils/webcontents-utils";

const SESSION_VERSION = 1;

function getSessionsDir(): string {
  return path.join(app.getPath("userData"), "named-sessions");
}

function ensureSessionsDir(): string {
  const dir = getSessionsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function normalizeSessionName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Session name is required");
  }
  return trimmed.slice(0, 120);
}

function sessionFileName(name: string): string {
  const normalized = normalizeSessionName(name).toLowerCase();
  const slug =
    normalized
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "session";
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  return `${slug}-${hash}.json`;
}

function getSessionPath(name: string): string {
  return path.join(ensureSessionsDir(), sessionFileName(name));
}

function writeSessionFile(filePath: string, data: NamedSessionData): void {
  fs.writeFileSync(
    filePath,
    JSON.stringify({ version: SESSION_VERSION, ...data }, null, 2),
    { encoding: "utf-8", mode: 0o600 },
  );
  fs.chmodSync(filePath, 0o600);
}

function readSessionFile(filePath: string): NamedSessionData | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<NamedSessionData> & {
      version?: number;
    };
    if (!parsed || typeof parsed.name !== "string") {
      return null;
    }
    return {
      name: parsed.name,
      createdAt:
        typeof parsed.createdAt === "string"
          ? parsed.createdAt
          : new Date().toISOString(),
      updatedAt:
        typeof parsed.updatedAt === "string"
          ? parsed.updatedAt
          : new Date().toISOString(),
      cookieCount: Array.isArray(parsed.cookies) ? parsed.cookies.length : 0,
      originCount: Array.isArray(parsed.localStorage)
        ? parsed.localStorage.length
        : 0,
      domains: Array.isArray(parsed.domains)
        ? parsed.domains.filter((value): value is string => typeof value === "string")
        : [],
      cookies: Array.isArray(parsed.cookies) ? parsed.cookies : [],
      localStorage: Array.isArray(parsed.localStorage)
        ? parsed.localStorage
            .filter(
              (entry): entry is NamedSessionData["localStorage"][number] =>
                !!entry &&
                typeof entry === "object" &&
                typeof entry.origin === "string" &&
                !!entry.entries &&
                typeof entry.entries === "object",
            )
            .map((entry) => ({
              origin: entry.origin,
              entries: Object.fromEntries(
                Object.entries(entry.entries).filter(
                  (pair): pair is [string, string] =>
                    typeof pair[0] === "string" && typeof pair[1] === "string",
                ),
              ),
            }))
        : [],
      snapshot:
        parsed.snapshot &&
        typeof parsed.snapshot === "object" &&
        Array.isArray(parsed.snapshot.tabs)
          ? parsed.snapshot
          : {
              tabs: [],
              activeIndex: 0,
              capturedAt: new Date().toISOString(),
            },
    };
  } catch {
    return null;
  }
}

function getSerializableCookies(): Promise<PersistedCookie[]> {
  return session.defaultSession.cookies.get({}).then((cookies) =>
    cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      session: cookie.session,
      expirationDate: cookie.expirationDate,
      sameSite: cookie.sameSite,
      url: cookie.url,
    })),
  );
}

function cookieSetDetails(cookie: PersistedCookie): Electron.CookiesSetDetails {
  const host = cookie.domain.replace(/^\./, "") || "localhost";
  const scheme = cookie.secure ? "https" : "http";
  return {
    url: cookie.url || `${scheme}://${host}${cookie.path || "/"}`,
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || "/",
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    expirationDate: cookie.session ? undefined : cookie.expirationDate,
    sameSite: cookie.sameSite,
  };
}

function uniqueOriginsFromTabManager(tabManager: TabManager): string[] {
  const origins = new Set<string>();
  for (const state of tabManager.getAllStates()) {
    try {
      const url = new URL(state.url);
      if (url.protocol === "http:" || url.protocol === "https:") {
        origins.add(url.origin);
      }
    } catch {
      continue;
    }
  }
  return [...origins];
}

async function captureLocalStorageForOrigin(
  tabManager: TabManager,
  origin: string,
): Promise<Record<string, string>> {
  const matchingTab = tabManager
    .getAllStates()
    .find((state) => {
      try {
        return new URL(state.url).origin === origin;
      } catch {
        return false;
      }
    });
  const tab = matchingTab ? tabManager.getTab(matchingTab.id) : undefined;
  if (!tab) return {};

  await waitForLoad(tab.view.webContents, 2000);
  try {
    const result = await tab.view.webContents.executeJavaScript(`
      (function() {
        try {
          return Object.fromEntries(
            Array.from({ length: window.localStorage.length }, (_, index) => {
              const key = window.localStorage.key(index);
              return key == null ? null : [key, window.localStorage.getItem(key) ?? ""];
            }).filter(Boolean)
          );
        } catch (error) {
          return { __vessel_error__: error instanceof Error ? error.message : "Storage access failed" };
        }
      })()
    `);
    if (
      result &&
      typeof result === "object" &&
      !("__vessel_error__" in result)
    ) {
      return Object.fromEntries(
        Object.entries(result).filter(
          (pair): pair is [string, string] =>
            typeof pair[0] === "string" && typeof pair[1] === "string",
        ),
      );
    }
  } catch {
    return {};
  }
  return {};
}

async function restoreLocalStorageForOrigin(
  tabManager: TabManager,
  origin: string,
  entries: Record<string, string>,
): Promise<void> {
  const tempId = tabManager.createTab(origin, { background: true });
  const tempTab = tabManager.getTab(tempId);
  if (!tempTab) return;

  try {
    await waitForLoad(tempTab.view.webContents, 5000);
    await tempTab.view.webContents.executeJavaScript(`
      (function() {
        try {
          window.localStorage.clear();
          const entries = ${JSON.stringify(entries)};
          for (const [key, value] of Object.entries(entries)) {
            window.localStorage.setItem(key, String(value));
          }
        } catch (error) {
          return error instanceof Error ? error.message : "Storage restore failed";
        }
        return "";
      })()
    `);
  } finally {
    tabManager.closeTab(tempId);
  }
}

export function listNamedSessions(): NamedSessionSummary[] {
  const dir = ensureSessionsDir();
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readSessionFile(path.join(dir, entry.name)))
    .filter((entry): entry is NamedSessionData => entry != null)
    .map((entry) => ({
      name: entry.name,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      cookieCount: entry.cookieCount,
      originCount: entry.originCount,
      domains: entry.domains,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return entries;
}

export function getNamedSession(name: string): NamedSessionData | null {
  return readSessionFile(getSessionPath(name));
}

export async function saveNamedSession(
  tabManager: TabManager,
  name: string,
): Promise<NamedSessionSummary> {
  const normalizedName = normalizeSessionName(name);
  const existing = getNamedSession(normalizedName);
  const cookies = await getSerializableCookies();
  const origins = uniqueOriginsFromTabManager(tabManager);
  const localStorage = [];

  for (const origin of origins) {
    const entries = await captureLocalStorageForOrigin(tabManager, origin);
    localStorage.push({ origin, entries });
  }

  const snapshot = tabManager.snapshotSession(`Named session: ${normalizedName}`);
  const domains = [...new Set(cookies.map((cookie) => cookie.domain))].sort();
  const now = new Date().toISOString();
  const data: NamedSessionData = {
    name: normalizedName,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    cookieCount: cookies.length,
    originCount: localStorage.length,
    domains,
    cookies,
    localStorage,
    snapshot,
  };

  writeSessionFile(getSessionPath(normalizedName), data);
  return {
    name: data.name,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    cookieCount: data.cookieCount,
    originCount: data.originCount,
    domains: data.domains,
  };
}

export async function loadNamedSession(
  tabManager: TabManager,
  name: string,
): Promise<NamedSessionSummary> {
  const normalizedName = normalizeSessionName(name);
  const saved = getNamedSession(normalizedName);
  if (!saved) {
    throw new Error(`Session "${normalizedName}" not found`);
  }

  await session.defaultSession.clearStorageData({
    storages: ["cookies", "localstorage"],
  });

  for (const cookie of saved.cookies) {
    try {
      await session.defaultSession.cookies.set(cookieSetDetails(cookie));
    } catch {
      continue;
    }
  }

  for (const origin of saved.localStorage) {
    await restoreLocalStorageForOrigin(tabManager, origin.origin, origin.entries);
  }

  if (saved.snapshot.tabs.length > 0) {
    tabManager.restoreSession(saved.snapshot);
  }

  return {
    name: saved.name,
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
    cookieCount: saved.cookieCount,
    originCount: saved.originCount,
    domains: saved.domains,
  };
}

export function deleteNamedSession(name: string): boolean {
  const filePath = getSessionPath(name);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}
