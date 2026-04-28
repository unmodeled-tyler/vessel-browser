import crypto from "node:crypto";
import type { VaultEntry } from "../../shared/types";
import {
  createEncryptDecrypt,
  createVaultIO,
  domainMatches,
  generateTotpCode,
} from "./shared";

/**
 * Agent Credential Vault — encrypted credential storage for agent automation.
 *
 * Security architecture:
 * - Credentials are encrypted at rest using AES-256-GCM
 * - The encryption key is protected by Electron's safeStorage API
 *   (macOS Keychain / Windows DPAPI / Linux libsecret)
 * - If OS-backed secret storage is unavailable, the vault is disabled
 *   rather than downgrading to a weak on-disk key fallback
 * - Credential values NEVER leave the main process — they are used only
 *   to fill form fields via the content script, never sent to AI providers
 * - Every credential access requires user consent via an Electron dialog
 */

const VAULT_FILENAME = "vessel-vault.enc";
const KEY_FILENAME = "vessel-vault.key";

const { encrypt, decrypt } = createEncryptDecrypt(KEY_FILENAME);
const { loadVault, saveVault, resetCache } = createVaultIO<VaultEntry>(
  VAULT_FILENAME,
  encrypt,
  decrypt,
);

// --- Public API ---

/** List all entries (passwords redacted). */
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
export { generateTotpCode };