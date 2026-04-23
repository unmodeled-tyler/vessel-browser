import { safeStorage } from "electron";
import fs from "fs";
import path from "path";
import { createLogger } from "../../shared/logger";

const logger = createLogger("JsonPersistence");

interface LoadJsonFileOptions<T> {
  filePath: string;
  fallback: T;
  parse: (raw: unknown) => T;
  secure?: boolean;
}

interface DebouncedJsonPersistenceOptions<T> {
  debounceMs: number;
  filePath: string;
  getValue: () => T | null | undefined;
  logLabel: string;
  resetOnSchedule?: boolean;
  secure?: boolean;
  serialize?: (value: T) => unknown;
}

function canUseSafeStorage(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function decodeStoredData(data: Buffer, secure: boolean): string {
  if (secure && canUseSafeStorage() && safeStorage.decryptString) {
    return safeStorage.decryptString(data);
  }
  return data.toString("utf-8");
}

function encodeStoredData(payload: string, secure: boolean): Buffer | string {
  if (secure && canUseSafeStorage() && safeStorage.encryptString) {
    return safeStorage.encryptString(payload);
  }
  return payload;
}

export function loadJsonFile<T>({
  filePath,
  fallback,
  parse,
  secure = false,
}: LoadJsonFileOptions<T>): T {
  try {
    const raw = fs.readFileSync(filePath);
    const decoded = decodeStoredData(raw, secure);
    return parse(JSON.parse(decoded));
  } catch {
    return fallback;
  }
}

export function createDebouncedJsonPersistence<T>({
  debounceMs,
  filePath,
  getValue,
  logLabel,
  resetOnSchedule = false,
  secure = false,
  serialize,
}: DebouncedJsonPersistenceOptions<T>) {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let saveDirty = false;

  const persistNow = async (): Promise<void> => {
    saveDirty = false;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }

    const value = getValue();
    if (value == null) return;

    const payload = JSON.stringify(
      serialize ? serialize(value) : value,
      null,
      2,
    );
    const data = encodeStoredData(payload, secure);

    await fs.promises
      .mkdir(path.dirname(filePath), { recursive: true })
      .then(() =>
        fs.promises.writeFile(
          filePath,
          data,
          typeof data === "string"
            ? { encoding: "utf-8", mode: 0o600 }
            : { mode: 0o600 },
        ),
      )
      .catch((err) => logger.error(`Failed to save ${logLabel}:`, err));
  };

  const schedule = (): void => {
    saveDirty = true;
    if (saveTimer) {
      if (!resetOnSchedule) return;
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (saveDirty) void persistNow();
    }, debounceMs);
  };

  const flush = (): Promise<void> => {
    return saveDirty ? persistNow() : Promise.resolve();
  };

  return {
    persistNow,
    schedule,
    flush,
  };
}
