import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { VaultAuditEntry } from "../../shared/types";
import { createLogger } from "../../shared/logger";

/**
 * Append-only audit log for credential access.
 * Stored as plaintext JSONL — contains no secrets, only access metadata.
 */

const AUDIT_FILENAME = "vessel-vault-audit.jsonl";
const MAX_ENTRIES = 1000;
const logger = createLogger("VaultAudit");

function getAuditPath(): string {
  return path.join(app.getPath("userData"), AUDIT_FILENAME);
}

export function appendAuditEntry(entry: VaultAuditEntry): void {
  try {
    const auditPath = getAuditPath();
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, JSON.stringify(entry) + "\n");
  } catch (err) {
    logger.error("Failed to write audit log:", err);
  }
}

export function readAuditLog(limit = 100): VaultAuditEntry[] {
  try {
    const auditPath = getAuditPath();
    if (!fs.existsSync(auditPath)) return [];

    const lines = fs
      .readFileSync(auditPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim());

    // Return most recent entries first
    return lines
      .slice(-Math.min(limit, MAX_ENTRIES))
      .map((line) => JSON.parse(line) as VaultAuditEntry)
      .reverse();
  } catch (err) {
    logger.error("Failed to read audit log:", err);
    return [];
  }
}

export function clearAuditLog(): void {
  try {
    const auditPath = getAuditPath();
    if (fs.existsSync(auditPath)) {
      fs.unlinkSync(auditPath);
    }
  } catch (err) {
    logger.error("Failed to clear audit log:", err);
  }
}
