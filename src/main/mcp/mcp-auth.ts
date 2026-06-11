import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../../shared/logger";
import { getRuntimeHealth } from "../health/runtime-health";
import { mcpRuntimeState } from "./mcp-state";
import { readIfExists, unlinkIfExists, writeFileAtomic } from "../utils/safe-fs";

const logger = createLogger("MCP");

// Well-known path where external MCP clients (e.g. Hermes) can read the
// current auth token and endpoint. Written on successful start. The token is
// persisted across restarts so external MCP client configs remain valid.
export const MCP_AUTH_FILENAME = "mcp-auth.json";

export type McpAuthState = {
  endpoint?: string;
  token?: string;
  pid?: number | null;
};

export function getMcpAuthFilePath(): string {
  // Electron stores userData at ~/.config/<appName> on Linux.  We resolve the
  // same directory via the XDG convention without importing `app` (which may
  // not be available during tests).
  const configDir =
    process.env.VESSEL_CONFIG_DIR ||
    path.join(
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
      "vessel",
    );
  return path.join(configDir, MCP_AUTH_FILENAME);
}

export async function readMcpAuthFile(): Promise<McpAuthState | null> {
  const raw = await readIfExists(getMcpAuthFilePath(), "utf-8");
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as McpAuthState;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export const MIN_TOKEN_LENGTH = 32;

export async function getPersistentMcpAuthToken(): Promise<string> {
  const existingToken = (await readMcpAuthFile())?.token?.trim();
  if (existingToken && existingToken.length >= MIN_TOKEN_LENGTH) {
    return existingToken;
  }
  return crypto.randomBytes(32).toString("hex");
}

export async function writeMcpAuthFile(endpoint: string, token: string): Promise<void> {
  try {
    const filePath = getMcpAuthFilePath();
    const payload = JSON.stringify({ endpoint, token, pid: process.pid }, null, 2) + "\n";
    await writeFileAtomic(filePath, payload, { mode: 0o600 });
  } catch (err) {
    logger.warn("Failed to write auth file:", err);
  }
}

export async function clearMcpAuthFile(): Promise<void> {
  const existingToken = (await readMcpAuthFile())?.token?.trim();
  if (!existingToken) {
    await unlinkIfExists(getMcpAuthFilePath());
    return;
  }
  try {
    const filePath = getMcpAuthFilePath();
    const payload = JSON.stringify(
      { endpoint: "", token: existingToken, pid: null },
      null,
      2,
    ) + "\n";
    await writeFileAtomic(filePath, payload, { mode: 0o600 });
  } catch (err) {
    logger.warn("Failed to clear auth file:", err);
  }
}

/** Returns the current MCP auth token. */
export function getMcpAuthToken(): string | null {
  return mcpRuntimeState.authToken;
}

export function regenerateMcpAuthToken(): { endpoint: string } | null {
  const endpoint = getRuntimeHealth().mcp.endpoint;
  if (!mcpRuntimeState.httpServer || !endpoint) return null;
  mcpRuntimeState.authToken = crypto.randomBytes(32).toString("hex");
  void writeMcpAuthFile(endpoint, mcpRuntimeState.authToken);
  return { endpoint };
}

export interface McpServerStartResult {
  ok: boolean;
  configuredPort: number;
  activePort: number | null;
  endpoint: string | null;
  authToken: string | null;
  error?: string;
}
