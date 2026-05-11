import { ipcMain } from "electron";
import { Channels } from "../../shared/channels";
import { assertString, assertOptionalString, assertTrustedIpcSender } from "./common";
import * as vault from "../vault/human-vault";
import type { HumanCredentialEntry } from "../../shared/types";

const HUMAN_VAULT_CATEGORIES = new Set([
  "login",
  "credit_card",
  "identity",
  "secure_note",
]);

function normalizeCategory(value: unknown): HumanCredentialEntry["category"] {
  return typeof value === "string" && HUMAN_VAULT_CATEGORIES.has(value)
    ? (value as HumanCredentialEntry["category"])
    : "login";
}

function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = value
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

export function registerHumanVaultHandlers(): void {
  ipcMain.handle(Channels.HUMAN_VAULT_LIST, (event, domain?: string) => {
    assertTrustedIpcSender(event);
    if (domain !== undefined) assertString(domain, "domain");
    return domain ? vault.findForDomain(domain) : vault.listEntries();
  });

  ipcMain.handle(Channels.HUMAN_VAULT_GET, (event, id: string) => {
    assertTrustedIpcSender(event);
    assertString(id, "id");
    return vault.getEntrySafe(id);
  });

  ipcMain.handle(
    Channels.HUMAN_VAULT_SAVE,
    (
      event,
      input: {
        title: string;
        url: string;
        username: string;
        password: string;
        totpSecret?: string;
        category?: "login" | "credit_card" | "identity" | "secure_note";
        tags?: string[];
        notes?: string;
      },
    ) => {
      assertTrustedIpcSender(event);
      if (!input || typeof input !== "object") {
        throw new Error("Invalid credential entry");
      }
      assertString(input.title, "title");
      assertString(input.url, "url");
      assertString(input.username, "username");
      assertString(input.password, "password");
      if (!input.title.trim() || !input.username.trim() || !input.password.trim()) {
        throw new Error("Title, username, and password are required");
      }
      assertOptionalString(input.totpSecret, "totpSecret");
      assertOptionalString(input.notes, "notes");

      const entry = vault.saveEntry({
        title: input.title.trim(),
        url: input.url.trim(),
        username: input.username.trim(),
        password: input.password,
        totpSecret: input.totpSecret?.trim() || undefined,
        category: normalizeCategory(input.category),
        tags: normalizeTags(input.tags),
        notes: input.notes?.trim() || undefined,
        lastUsedAt: undefined,
      });

      // Return safe version (no password)
      const { password: _p, totpSecret: _t, ...safe } = entry;
      return safe;
    },
  );

  ipcMain.handle(
    Channels.HUMAN_VAULT_UPDATE,
    (
      event,
      id: string,
      updates: Partial<{
        title: string;
        url: string;
        username: string;
        password: string;
        totpSecret: string;
        category: "login" | "credit_card" | "identity" | "secure_note";
        tags: string[];
        notes: string;
      }>,
    ) => {
      assertTrustedIpcSender(event);
      assertString(id, "id");
      if (!updates || typeof updates !== "object") {
        throw new Error("Invalid updates");
      }
      const normalized: Partial<Omit<HumanCredentialEntry, "id" | "createdAt">> = {};
      if (updates.title !== undefined) {
        assertString(updates.title, "title");
        normalized.title = updates.title.trim();
      }
      if (updates.url !== undefined) {
        assertString(updates.url, "url");
        normalized.url = updates.url.trim();
      }
      if (updates.username !== undefined) {
        assertString(updates.username, "username");
        normalized.username = updates.username.trim();
      }
      if (updates.password !== undefined) {
        assertString(updates.password, "password");
        normalized.password = updates.password;
      }
      if (updates.totpSecret !== undefined) {
        assertOptionalString(updates.totpSecret, "totpSecret");
        normalized.totpSecret = updates.totpSecret.trim() || undefined;
      }
      if (updates.notes !== undefined) {
        assertOptionalString(updates.notes, "notes");
        normalized.notes = updates.notes.trim() || undefined;
      }
      if (updates.category !== undefined) {
        normalized.category = normalizeCategory(updates.category);
      }
      if (updates.tags !== undefined) {
        normalized.tags = normalizeTags(updates.tags);
      }
      const result = vault.updateEntry(id, normalized);
      if (!result) return null;
      const { password: _p, totpSecret: _t, ...safe } = result;
      return safe;
    },
  );

  ipcMain.handle(Channels.HUMAN_VAULT_REMOVE, (event, id: string) => {
    assertTrustedIpcSender(event);
    assertString(id, "id");
    return vault.removeEntry(id);
  });

  ipcMain.handle(Channels.HUMAN_VAULT_AUDIT_LOG, (event, limit?: number) => {
    assertTrustedIpcSender(event);
    return vault.readAuditLog(limit);
  });
}
