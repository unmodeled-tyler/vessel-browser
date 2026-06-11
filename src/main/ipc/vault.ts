import { ipcMain } from "electron";
import { z } from "zod";
import { Channels } from "../../shared/channels";
import { readAuditLog } from "../vault/audit";
import * as vaultManager from "../vault/manager";
import { trackVaultAction } from "../telemetry/posthog";
import { assertTrustedIpcSender, parseIpc } from "./common";
import { assertFeatureUnlocked } from "../premium/manager";

const IdSchema = z.string().min(1);
const OptionalLimitSchema = z.number().int().min(1).optional();
const RequiredTrimmedStringSchema = z.string().trim().min(1);
const RequiredSecretSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "Required",
});
const OptionalTrimmedStringSchema = z.string().trim().optional();

const VaultEntrySchema = z.object({
  label: RequiredTrimmedStringSchema,
  domainPattern: RequiredTrimmedStringSchema,
  username: RequiredTrimmedStringSchema,
  password: RequiredSecretSchema,
  totpSecret: OptionalTrimmedStringSchema,
  notes: OptionalTrimmedStringSchema,
});

const VaultUpdateSchema = z.object({
  label: RequiredTrimmedStringSchema.optional(),
  domainPattern: RequiredTrimmedStringSchema.optional(),
  username: RequiredTrimmedStringSchema.optional(),
  password: RequiredSecretSchema.optional(),
  totpSecret: OptionalTrimmedStringSchema,
  notes: OptionalTrimmedStringSchema,
});

function assertVaultUnlocked(): void {
  assertFeatureUnlocked("vault", "Agent Credential Vault");
}

export function registerVaultHandlers(): void {
  ipcMain.handle(Channels.VAULT_LIST, (event) => {
    assertTrustedIpcSender(event);
    assertVaultUnlocked();
    return vaultManager.listEntries();
  });

  ipcMain.handle(
    Channels.VAULT_ADD,
    (event, entry: unknown) => {
      assertTrustedIpcSender(event);
      assertVaultUnlocked();
      const validated = parseIpc(VaultEntrySchema, entry, "entry");
      trackVaultAction("credential_added");
      const created = vaultManager.addEntry(validated);
      return {
        id: created.id,
        label: created.label,
        domainPattern: created.domainPattern,
        username: created.username,
      };
    },
  );

  ipcMain.handle(
    Channels.VAULT_UPDATE,
    (event, id: unknown, updates: unknown) => {
      assertTrustedIpcSender(event);
      assertVaultUnlocked();
      const validatedId = parseIpc(IdSchema, id, "id");
      const validatedUpdates = parseIpc(VaultUpdateSchema, updates ?? {}, "updates");
      return vaultManager.updateEntry(validatedId, validatedUpdates) !== null;
    },
  );

  ipcMain.handle(Channels.VAULT_REMOVE, (event, id: unknown) => {
    assertTrustedIpcSender(event);
    assertVaultUnlocked();
    const validatedId = parseIpc(IdSchema, id, "id");
    trackVaultAction("credential_removed");
    return vaultManager.removeEntry(validatedId);
  });

  ipcMain.handle(Channels.VAULT_AUDIT_LOG, (event, limit?: unknown) => {
    assertTrustedIpcSender(event);
    assertVaultUnlocked();
    const validatedLimit = limit != null ? parseIpc(OptionalLimitSchema, limit, "limit") : undefined;
    return readAuditLog(validatedLimit);
  });
}
