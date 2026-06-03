import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../../shared/logger";
import { getRuntimeHealth } from "../health/runtime-health";
import { mcpRuntimeState } from "./mcp-state";

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

export function readMcpAuthFile(): McpAuthState | null {
  try {
    const raw = fs.readFileSync(getMcpAuthFilePath(), "utf8");
    const parsed = JSON.parse(raw) as McpAuthState;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export const MIN_TOKEN_LENGTH = 32;

export function getPersistentMcpAuthToken(): string {
  const existingToken = readMcpAuthFile()?.token?.trim();
  if (existingToken && existingToken.length >= MIN_TOKEN_LENGTH) {
    return existingToken;
  }
  return crypto.randomBytes(32).toString("hex");
}

export function writeMcpAuthFile(endpoint: string, token: string): void {
  try {
    const filePath = getMcpAuthFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({ endpoint, token, pid: process.pid }, null, 2) + "\n",
      { mode: 0o600 },
    );
    fs.chmodSync(filePath, 0o600);
  } catch (err) {
    logger.warn("Failed to write auth file:", err);
  }
}

export function clearMcpAuthFile(): void {
  const existingToken = readMcpAuthFile()?.token?.trim();
  if (!existingToken) {
    try {
      fs.unlinkSync(getMcpAuthFilePath());
    } catch {
      // File may not exist — that's fine.
    }
    return;
  }
  try {
    const filePath = getMcpAuthFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        { endpoint: "", token: existingToken, pid: null },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    fs.chmodSync(filePath, 0o600);
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
  writeMcpAuthFile(endpoint, mcpRuntimeState.authToken);
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
