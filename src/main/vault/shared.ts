import { app, safeStorage } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../../shared/logger";

const logger = createLogger("VaultShared");

// --- AES-256-GCM encryption ---

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_STORAGE_PREFIX = "base64:";

export function encodeEncryptionKeyForStorage(key: Buffer): string {
  return `${KEY_STORAGE_PREFIX}${key.toString("base64")}`;
}

export function decodeEncryptionKeyFromStorage(value: string): Buffer {
  if (value.startsWith(KEY_STORAGE_PREFIX)) {
    return Buffer.from(value.slice(KEY_STORAGE_PREFIX.length), "base64");
  }
  return Buffer.from(value, "utf-8");
}

export function assertSecretStorageAvailable(customMessage?: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      customMessage ??
        "Vault requires OS-backed secret storage (Keychain, DPAPI, or libsecret).",
    );
  }
}

export function getOrCreateEncryptionKey(keyFilename: string): Buffer {
  assertSecretStorageAvailable();
  const keyPath = path.join(app.getPath("userData"), keyFilename);

  if (fs.existsSync(keyPath)) {
    const encryptedKey = fs.readFileSync(keyPath);
    const key = decodeEncryptionKeyFromStorage(
      safeStorage.decryptString(encryptedKey),
    );
    if (key.length !== 32) {
      throw new Error("Stored vault encryption key has an invalid length.");
    }
    return key;
  }

  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  const encrypted = safeStorage.encryptString(encodeEncryptionKeyForStorage(key));
  fs.writeFileSync(keyPath, encrypted, { mode: 0o600 });
  fs.chmodSync(keyPath, 0o600);
  return key;
}

export function createEncryptDecrypt(keyFilename: string) {
  let cachedKey: Buffer | null = null;

  function getKey(): Buffer {
    if (!cachedKey) cachedKey = getOrCreateEncryptionKey(keyFilename);
    return cachedKey;
  }

  function encrypt(plaintext: string): Buffer {
    const key = getKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf-8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]);
  }

  function decrypt(data: Buffer): string {
    const key = getKey();
    const iv = data.subarray(0, IV_LENGTH);
    const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);
    return (
      decipher.update(ciphertext, undefined, "utf-8") + decipher.final("utf-8")
    );
  }

  function resetKey(): void {
    cachedKey = null;
  }

  return { encrypt, decrypt, resetKey };
}

export function createVaultIO<T>(
  vaultFilename: string,
  encrypt: (plaintext: string) => Buffer,
  decrypt: (data: Buffer) => string,
) {
  let cachedEntries: T[] | null = null;

  function getVaultPath(): string {
    return path.join(app.getPath("userData"), vaultFilename);
  }

  function loadVault(): T[] {
    if (cachedEntries) return cachedEntries;

    const vaultPath = getVaultPath();
    if (!fs.existsSync(vaultPath)) {
      cachedEntries = [];
      return cachedEntries;
    }

    try {
      const raw = fs.readFileSync(vaultPath);
      const json = decrypt(raw);
      cachedEntries = JSON.parse(json) as T[];
      return cachedEntries;
    } catch (err) {
      logger.error("Failed to load vault:", err);
      throw new Error("Could not unlock the vault. Check OS secret storage availability.");
    }
  }

  function saveVault(entries: T[]): void {
    const json = JSON.stringify(entries, null, 2);
    const encrypted = encrypt(json);
    const vaultPath = getVaultPath();
    fs.mkdirSync(path.dirname(vaultPath), { recursive: true });
    fs.writeFileSync(vaultPath, encrypted);
    fs.chmodSync(vaultPath, 0o600);
    cachedEntries = entries;
  }

  function resetCache(): void {
    cachedEntries = null;
  }

  return { loadVault, saveVault, resetCache };
}

// --- Domain matching ---

export function normalizeCredentialHost(value: string): string | null {
  try {
    const parsed = new URL(value.includes("://") ? value : `https://${value}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    const normalized = value
      .toLowerCase()
      .trim()
      .replace(/^(https?:\/\/)?(www\.)?/, "")
      .replace(/\/.*$/, "");
    return normalized && !normalized.includes(" ") ? normalized : null;
  }
}

export function domainMatches(pattern: string, hostname: string): boolean {
  const isWildcard = pattern.trim().startsWith("*.");
  const p = normalizeCredentialHost(isWildcard ? pattern.slice(2) : pattern);
  const h = normalizeCredentialHost(hostname);
  if (!p || !h) return false;
  return isWildcard ? h.endsWith("." + p) : p === h;
}

// --- TOTP ---

export function generateTotpCode(secret: string): string {
  const epoch = Math.floor(Date.now() / 1000);
  const counter = Math.floor(epoch / 30);

  const base32Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleanSecret = secret.replace(/[\s=-]/g, "").toUpperCase();
  let bits = "";
  for (const ch of cleanSecret) {
    const val = base32Chars.indexOf(ch);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const keyBytes = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < keyBytes.length; i++) {
    keyBytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }

  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuf.writeUInt32BE(counter & 0xffffffff, 4);

  const hmac = crypto.createHmac("sha1", keyBytes).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return (code % 1000000).toString().padStart(6, "0");
}

// --- Audit logging (JSONL) ---

export function createAuditLog<T extends Record<string, unknown>>(
  filename: string,
  maxEntries: number,
) {
  function getAuditPath(): string {
    return path.join(app.getPath("userData"), filename);
  }

  function appendAudit(entry: T): void {
    try {
      const auditPath = getAuditPath();
      fs.mkdirSync(path.dirname(auditPath), { recursive: true });
      fs.appendFileSync(auditPath, JSON.stringify(entry) + "\n");

      try {
        const lines = fs
          .readFileSync(auditPath, "utf-8")
          .split("\n")
          .filter((l) => l.trim());
        if (lines.length > maxEntries) {
          const trimmed = lines.slice(-maxEntries);
          fs.writeFileSync(auditPath, trimmed.join("\n") + "\n");
        }
      } catch {
        // Non-critical — don't fail the operation
      }
    } catch (err) {
      logger.error("Failed to write audit log:", err);
    }
  }

  function readAuditLog(limit = 100): T[] {
    try {
      const auditPath = getAuditPath();
      if (!fs.existsSync(auditPath)) return [];
      const lines = fs
        .readFileSync(auditPath, "utf-8")
        .split("\n")
        .filter((l) => l.trim());
      return lines
        .slice(-Math.min(limit, maxEntries))
        .map((line) => JSON.parse(line) as T)
        .reverse();
    } catch (err) {
      logger.error("Failed to read audit log:", err);
      return [];
    }
  }

  return { appendAudit, readAuditLog };
}
