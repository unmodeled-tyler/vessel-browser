import { ipcMain } from "electron";
import { Channels } from "../../shared/channels";
import { readAuditLog } from "../vault/audit";
import * as vaultManager from "../vault/manager";
import { trackVaultAction } from "../telemetry/posthog";
import { assertOptionalString, assertString, assertTrustedIpcSender } from "./common";

export function registerVaultHandlers(): void {
  ipcMain.handle(Channels.VAULT_LIST, (event) => {
    assertTrustedIpcSender(event);
    return vaultManager.listEntries();
  });

  ipcMain.handle(
    Channels.VAULT_ADD,
    (
      event,
      entry: {
        label: string;
        domainPattern: string;
        username: string;
        password: string;
        totpSecret?: string;
        notes?: string;
      },
    ) => {
      assertTrustedIpcSender(event);
      if (!entry || typeof entry !== "object") {
        throw new Error("Invalid vault entry");
      }
      assertString(entry.label, "label");
      assertString(entry.domainPattern, "domainPattern");
      assertString(entry.username, "username");
      assertString(entry.password, "password");
      if (
        !entry.label.trim() ||
        !entry.domainPattern.trim() ||
        !entry.username.trim() ||
        !entry.password.trim()
      ) {
        throw new Error("Label, domain, username, and password are required");
      }
      assertOptionalString(entry.totpSecret, "totpSecret");
      assertOptionalString(entry.notes, "notes");
      trackVaultAction("credential_added");
      const created = vaultManager.addEntry(entry);
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
    (
      event,
      id: string,
      updates: Partial<{
        label: string;
        domainPattern: string;
        username: string;
        password: string;
        totpSecret: string;
        notes: string;
      }>,
    ) => {
      assertTrustedIpcSender(event);
      assertString(id, "id");
      if (!updates || typeof updates !== "object") {
        throw new Error("Invalid updates");
      }
      return vaultManager.updateEntry(id, updates) !== null;
    },
  );

  ipcMain.handle(Channels.VAULT_REMOVE, (event, id: string) => {
    assertTrustedIpcSender(event);
    assertString(id, "id");
    trackVaultAction("credential_removed");
    return vaultManager.removeEntry(id);
  });

  ipcMain.handle(Channels.VAULT_AUDIT_LOG, (event, limit?: number) => {
    assertTrustedIpcSender(event);
    return readAuditLog(limit);
  });
}
