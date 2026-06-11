import { ipcMain } from "electron";
import { z } from "zod";
import { Channels } from "../../shared/channels";
import { assertTrustedIpcSender, parseIpc } from "./common";
import * as vault from "../vault/human-vault";
import type { HumanCredentialEntry } from "../../shared/types";
import { assertFeatureUnlocked } from "../premium/manager";

const IdSchema = z.string().min(1);
const OptionalDomainSchema = z.string().min(1).optional();
const OptionalLimitSchema = z.number().int().min(1).optional();
const CategorySchema = z.enum(["login", "credit_card", "identity", "secure_note"]);
const TagsSchema = z.array(z.string()).optional();
const TrimmedStringSchema = z.string().transform((value) => value.trim());
const RequiredTrimmedStringSchema = z.string().trim().min(1);
const RequiredSecretSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "Required",
});
const OptionalTrimmedStringSchema = z.string().trim().optional();

const CredentialInputSchema = z.object({
  title: RequiredTrimmedStringSchema,
  url: TrimmedStringSchema,
  username: RequiredTrimmedStringSchema,
  password: RequiredSecretSchema,
  totpSecret: OptionalTrimmedStringSchema,
  category: CategorySchema.optional(),
  tags: TagsSchema,
  notes: OptionalTrimmedStringSchema,
});

const CredentialUpdateSchema = z.object({
  title: RequiredTrimmedStringSchema.optional(),
  url: TrimmedStringSchema.optional(),
  username: RequiredTrimmedStringSchema.optional(),
  password: RequiredSecretSchema.optional(),
  totpSecret: OptionalTrimmedStringSchema,
  category: CategorySchema.optional(),
  tags: TagsSchema,
  notes: OptionalTrimmedStringSchema,
});

function assertHumanVaultUnlocked(): void {
  assertFeatureUnlocked("human_vault", "Passwords");
}

/** Trim and deduplicate tags from Zod-validated input. */
function cleanTags(tags: string[] | undefined): string[] | undefined {
  if (!tags) return undefined;
  const cleaned = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
  return cleaned.length > 0 ? cleaned : undefined;
}

export function registerHumanVaultHandlers(): void {
  ipcMain.handle(Channels.HUMAN_VAULT_LIST, (event, domain?: unknown) => {
    assertTrustedIpcSender(event);
    assertHumanVaultUnlocked();
    const validatedDomain = domain != null ? parseIpc(OptionalDomainSchema, domain, "domain") : undefined;
    return validatedDomain ? vault.findForDomain(validatedDomain) : vault.listEntries();
  });

  ipcMain.handle(Channels.HUMAN_VAULT_GET, (event, id: unknown) => {
    assertTrustedIpcSender(event);
    assertHumanVaultUnlocked();
    const validatedId = parseIpc(IdSchema, id, "id");
    return vault.getEntrySafe(validatedId);
  });

  ipcMain.handle(
    Channels.HUMAN_VAULT_SAVE,
    (event, input: unknown) => {
      assertTrustedIpcSender(event);
      assertHumanVaultUnlocked();
      const validated = parseIpc(CredentialInputSchema, input, "credential");

      const entry = vault.saveEntry({
        title: validated.title,
        url: validated.url,
        username: validated.username,
        password: validated.password,
        totpSecret: validated.totpSecret || undefined,
        category: validated.category ?? "login",
        tags: cleanTags(validated.tags),
        notes: validated.notes || undefined,
        lastUsedAt: undefined,
      });

      // Return safe version (no password)
      const { password: _p, totpSecret: _t, ...safe } = entry;
      return safe;
    },
  );

  ipcMain.handle(
    Channels.HUMAN_VAULT_UPDATE,
    (event, id: unknown, updates: unknown) => {
      assertTrustedIpcSender(event);
      assertHumanVaultUnlocked();
      const validatedId = parseIpc(IdSchema, id, "id");
      const validatedUpdates = parseIpc(CredentialUpdateSchema, updates ?? {}, "updates");

      const normalized: Partial<Omit<HumanCredentialEntry, "id" | "createdAt">> = {};
      if (validatedUpdates.title !== undefined) normalized.title = validatedUpdates.title;
      if (validatedUpdates.url !== undefined) normalized.url = validatedUpdates.url;
      if (validatedUpdates.username !== undefined) normalized.username = validatedUpdates.username;
      if (validatedUpdates.password !== undefined) normalized.password = validatedUpdates.password;
      if (validatedUpdates.totpSecret !== undefined) normalized.totpSecret = validatedUpdates.totpSecret || undefined;
      if (validatedUpdates.notes !== undefined) normalized.notes = validatedUpdates.notes || undefined;
      if (validatedUpdates.category !== undefined) normalized.category = validatedUpdates.category;
      if (validatedUpdates.tags !== undefined) normalized.tags = cleanTags(validatedUpdates.tags);

      const result = vault.updateEntry(validatedId, normalized);
      if (!result) return null;
      const { password: _p, totpSecret: _t, ...safe } = result;
      return safe;
    },
  );

  ipcMain.handle(Channels.HUMAN_VAULT_REMOVE, (event, id: unknown) => {
    assertTrustedIpcSender(event);
    assertHumanVaultUnlocked();
    const validatedId = parseIpc(IdSchema, id, "id");
    return vault.removeEntry(validatedId);
  });

  ipcMain.handle(Channels.HUMAN_VAULT_AUDIT_LOG, (event, limit?: unknown) => {
    assertTrustedIpcSender(event);
    assertHumanVaultUnlocked();
    const validatedLimit = limit != null ? parseIpc(OptionalLimitSchema, limit, "limit") : undefined;
    return vault.readAuditLog(validatedLimit);
  });
}
