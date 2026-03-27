import { app, safeStorage } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { VaultEntry } from "../../shared/types";

/**
 * Agent Credential Vault — encrypted credential storage for agent automation.
 *
 * Security architecture:
 * - Credentials are encrypted at rest using AES-256-GCM
 * - The encryption key is protected by Electron's safeStorage API
 *   (macOS Keychain / Windows DPAPI / Linux libsecret)
 * - Credential values NEVER leave the main process — they are used only
 *   to fill form fields via the content script, never sent to AI providers
 * - Every credential access requires user consent via an Electron dialog
 */

const VAULT_FILENAME = "vessel-vault.enc";
const KEY_FILENAME = "vessel-vault.key";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

let cachedEntries: VaultEntry[] | null = null;

// --- Path helpers ---

function getVaultDir(): string {
  return app.getPath("userData");
}

function getVaultPath(): string {
  return path.join(getVaultDir(), VAULT_FILENAME);
}

function getKeyPath(): string {
  return path.join(getVaultDir(), KEY_FILENAME);
}

// --- Encryption key management via safeStorage ---

function getOrCreateEncryptionKey(): Buffer {
  const keyPath = getKeyPath();

  if (fs.existsSync(keyPath)) {
    const encryptedKey = fs.readFileSync(keyPath);
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString
        ? Buffer.from(safeStorage.decryptString(encryptedKey), "utf-8")
        : encryptedKey;
    }
    // Fallback: key stored as-is (no OS keychain available)
    return encryptedKey;
  }

  // Generate a fresh 256-bit key
  const key = crypto.randomBytes(32);

  fs.mkdirSync(path.dirname(keyPath), { recursive: true });

  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(key.toString("utf-8"));
    fs.writeFileSync(keyPath, encrypted);
  } else {
    // Fallback: store key directly (less secure, but functional)
    fs.writeFileSync(keyPath, key);
    fs.chmodSync(keyPath, 0o600);
  }

  return key;
}

// --- AES-256-GCM encryption/decryption ---

function encrypt(plaintext: string): Buffer {
  const key = getOrCreateEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Format: [iv (12)] [authTag (16)] [ciphertext (...)]
  return Buffer.concat([iv, authTag, encrypted]);
}

function decrypt(data: Buffer): string {
  const key = getOrCreateEncryptionKey();
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  return decipher.update(ciphertext, undefined, "utf-8") + decipher.final("utf-8");
}

// --- Vault file I/O ---

function loadVault(): VaultEntry[] {
  if (cachedEntries) return cachedEntries;

  const vaultPath = getVaultPath();
  if (!fs.existsSync(vaultPath)) {
    cachedEntries = [];
    return cachedEntries;
  }

  try {
    const raw = fs.readFileSync(vaultPath);
    const json = decrypt(raw);
    cachedEntries = JSON.parse(json) as VaultEntry[];
    return cachedEntries;
  } catch (err) {
    console.error("[Vessel Vault] Failed to load vault:", err);
    cachedEntries = [];
    return cachedEntries;
  }
}

function saveVault(entries: VaultEntry[]): void {
  const json = JSON.stringify(entries, null, 2);
  const encrypted = encrypt(json);

  const vaultPath = getVaultPath();
  fs.mkdirSync(path.dirname(vaultPath), { recursive: true });
  fs.writeFileSync(vaultPath, encrypted);
  fs.chmodSync(vaultPath, 0o600);

  cachedEntries = entries;
}

// --- Domain matching ---

/**
 * Match a URL's hostname against a domain pattern.
 * Supports exact match ("github.com") and wildcard ("*.aws.amazon.com").
 */
export function domainMatches(pattern: string, hostname: string): boolean {
  const p = pattern.toLowerCase().trim();
  const h = hostname.toLowerCase().trim();

  if (p === h) return true;

  if (p.startsWith("*.")) {
    const suffix = p.slice(2);
    return h === suffix || h.endsWith("." + suffix);
  }

  return false;
}

// --- Public API ---

export function listEntries(): Omit<VaultEntry, "password" | "totpSecret">[] {
  return loadVault().map(({ password, totpSecret, ...rest }) => rest);
}

export function getEntry(id: string): VaultEntry | undefined {
  return loadVault().find((e) => e.id === id);
}

export function findEntriesForDomain(url: string): Omit<VaultEntry, "password" | "totpSecret">[] {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return [];
  }

  return loadVault()
    .filter((e) => domainMatches(e.domainPattern, hostname))
    .map(({ password, totpSecret, ...rest }) => rest);
}

export function addEntry(
  entry: Omit<VaultEntry, "id" | "createdAt" | "lastUsedAt" | "useCount">,
): VaultEntry {
  const entries = loadVault();
  const newEntry: VaultEntry = {
    ...entry,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    useCount: 0,
  };
  entries.push(newEntry);
  saveVault(entries);
  return newEntry;
}

export function updateEntry(
  id: string,
  updates: Partial<Omit<VaultEntry, "id" | "createdAt">>,
): VaultEntry | null {
  const entries = loadVault();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return null;

  entries[idx] = { ...entries[idx], ...updates };
  saveVault(entries);
  return entries[idx];
}

export function removeEntry(id: string): boolean {
  const entries = loadVault();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return false;

  entries.splice(idx, 1);
  saveVault(entries);
  return true;
}

export function recordUsage(id: string): void {
  const entries = loadVault();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;

  entry.lastUsedAt = new Date().toISOString();
  entry.useCount += 1;
  saveVault(entries);
}

/**
 * Get the raw credential for form filling.
 * This should ONLY be called from the blind-fill flow in the main process.
 * The returned values must NEVER be sent to the AI provider.
 */
export function getCredential(id: string): { username: string; password: string } | null {
  const entry = loadVault().find((e) => e.id === id);
  if (!entry) return null;
  return { username: entry.username, password: entry.password };
}

/**
 * Get the TOTP secret for code generation.
 * Only called from the main process TOTP flow — never exposed to AI.
 */
export function getTotpSecret(id: string): string | null {
  const entry = loadVault().find((e) => e.id === id);
  return entry?.totpSecret ?? null;
}

/** Generate a TOTP code from a base32 secret. */
export function generateTotpCode(secret: string): string {
  const epoch = Math.floor(Date.now() / 1000);
  const counter = Math.floor(epoch / 30);

  // Decode base32 secret
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

  // HMAC-SHA1
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

/** Reset in-memory cache (for testing or settings reset). */
export function resetCache(): void {
  cachedEntries = null;
}
