import crypto from "node:crypto";
import type { HumanCredentialEntry, HumanVaultAuditEntry } from "../../shared/types";
import {
  createEncryptDecrypt,
  createVaultIO,
  createAuditLog,
  domainMatches,
  generateTotpCode,
} from "./shared";

/**
 * Human Password Manager — encrypted credential storage for the human user.
 *
 * Shares the same encryption architecture as the agent vault:
 * - AES-256-GCM encryption at rest
 * - Encryption key protected by Electron's safeStorage (OS Keychain/DPAPI/libsecret)
 * - Vault disabled if OS secret storage is unavailable
 *
 * Key differences from the agent vault:
 * - Separate vault file and encryption key
 * - Richer entry type (title, url, domain, category, tags)
 * - No agent access by default — consent gate before any programmatic fill
 */

const VAULT_FILENAME = "vessel-human-vault.enc";
const KEY_FILENAME = "vessel-human-vault.key";
const AUDIT_MAX_ENTRIES = 2000;

const { encrypt, decrypt } = createEncryptDecrypt(KEY_FILENAME);
const { loadVault, saveVault, resetCache } = createVaultIO<HumanCredentialEntry>(
  VAULT_FILENAME,
  encrypt,
  decrypt,
);
const auditLog = createAuditLog<HumanVaultAuditEntry>(
  "vessel-human-vault-audit.jsonl",
  AUDIT_MAX_ENTRIES,
);

// --- Domain extraction ---

function extractDomain(url: string): string {
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    return parsed.hostname.toLowerCase();
  } catch {
    return url.toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, "").replace(/\/.*$/, "");
  }
}

// --- Public API ---

/** List all entries (passwords redacted). */
export function listEntries(): Omit<HumanCredentialEntry, "password" | "totpSecret">[] {
  return loadVault().map(({ password, totpSecret, ...rest }) => rest);
}

/** Get a single entry by ID (includes password — use carefully). */
export function getEntry(id: string): HumanCredentialEntry | undefined {
  return loadVault().find((e) => e.id === id);
}

/** Get a single entry by ID (passwords redacted). */
export function getEntrySafe(id: string): Omit<HumanCredentialEntry, "password" | "totpSecret"> | undefined {
  const entry = loadVault().find((e) => e.id === id);
  if (!entry) return undefined;
  const { password, totpSecret, ...rest } = entry;
  return rest;
}

/** Find entries matching a domain (passwords redacted). */
export function findForDomain(url: string): Omit<HumanCredentialEntry, "password" | "totpSecret">[] {
  const domain = extractDomain(url);
  return loadVault()
    .filter((e) => domainMatches(e.domain, domain))
    .map(({ password, totpSecret, ...rest }) => rest);
}

export function recordListAccess(domain: string, source: HumanVaultAuditEntry["source"]): void {
  auditLog.appendAudit({
    timestamp: new Date().toISOString(),
    credentialId: "list",
    credentialTitle: "Password list",
    domain,
    action: "human_list",
    approved: true,
    source,
  });
}

export function entryMatchesUrl(id: string, url: string): boolean {
  const entry = loadVault().find((e) => e.id === id);
  return !!entry && domainMatches(entry.domain, extractDomain(url));
}

/** Save a new credential. */
export function saveEntry(
  input: Omit<HumanCredentialEntry, "id" | "domain" | "createdAt" | "updatedAt" | "useCount">,
): HumanCredentialEntry {
  const entries = loadVault();
  const now = new Date().toISOString();
  const entry: HumanCredentialEntry = {
    ...input,
    id: crypto.randomUUID(),
    domain: extractDomain(input.url),
    createdAt: now,
    updatedAt: now,
    useCount: 0,
  };
  entries.push(entry);
  saveVault(entries);

  auditLog.appendAudit({
    timestamp: now,
    credentialId: entry.id,
    credentialTitle: entry.title,
    domain: entry.domain,
    action: "human_create",
    approved: true,
    source: "settings_ui",
  });

  return entry;
}

/** Update an existing credential. */
export function updateEntry(
  id: string,
  updates: Partial<Omit<HumanCredentialEntry, "id" | "createdAt">>,
): HumanCredentialEntry | null {
  const entries = loadVault();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return null;

  entries[idx] = {
    ...entries[idx],
    ...updates,
    domain: updates.url ? extractDomain(updates.url) : entries[idx].domain,
    updatedAt: new Date().toISOString(),
  };
  saveVault(entries);

  auditLog.appendAudit({
    timestamp: entries[idx].updatedAt,
    credentialId: id,
    credentialTitle: entries[idx].title,
    domain: entries[idx].domain,
    action: "human_update",
    approved: true,
    source: "settings_ui",
  });

  return entries[idx];
}

/** Remove a credential. */
export function removeEntry(id: string, source: HumanVaultAuditEntry["source"] = "settings_ui"): boolean {
  const entries = loadVault();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return false;

  const filtered = entries.filter((e) => e.id !== id);
  saveVault(filtered);

  auditLog.appendAudit({
    timestamp: new Date().toISOString(),
    credentialId: id,
    credentialTitle: entry.title,
    domain: entry.domain,
    action: "human_delete",
    approved: true,
    source,
  });

  return true;
}

/** Record a credential usage (autofill, copy, etc.). */
export function recordUsage(id: string, source: HumanVaultAuditEntry["source"]): void {
  const entries = loadVault();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;

  entry.lastUsedAt = new Date().toISOString();
  entry.useCount += 1;
  saveVault(entries);

  auditLog.appendAudit({
    timestamp: entry.lastUsedAt,
    credentialId: id,
    credentialTitle: entry.title,
    domain: entry.domain,
    action: "human_autofill",
    approved: true,
    source,
  });
}

/** Get raw credential for form filling (main process only — never send to AI). */
export function getCredential(id: string): { username: string; password: string } | null {
  const entry = loadVault().find((e) => e.id === id);
  if (!entry) return null;
  return { username: entry.username, password: entry.password };
}

/** Get TOTP secret for code generation (main process only). */
export function getTotpSecret(id: string): string | null {
  const entry = loadVault().find((e) => e.id === id);
  return entry?.totpSecret ?? null;
}

/** Generate a TOTP code from a base32 secret. */
export { generateTotpCode };

/** Read audit log entries (most recent first). */
export function readAuditLog(limit = 100): HumanVaultAuditEntry[] {
  return auditLog.readAuditLog(limit);
}