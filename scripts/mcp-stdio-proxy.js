#!/usr/bin/env node
// Stdio-to-HTTP proxy for Vessel's MCP server.
//
// Reads newline-delimited JSON-RPC messages from stdin, forwards them as MCP
// Streamable HTTP POST requests to Vessel (with bearer auth resolved from
// mcp-auth.json), and writes newline-delimited JSON-RPC responses/notifications
// back to stdout.
//
// Usage:
//   node scripts/mcp-stdio-proxy.js
//
// MCP client config:
//   { "command": "vessel-browser-mcp", "args": ["--stdio"] }

"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const readline = require("readline");

const CONFIG_DIR =
  process.env.VESSEL_CONFIG_DIR ||
  path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "vessel",
  );
const AUTH_PATH = path.join(CONFIG_DIR, "mcp-auth.json");
const SETTINGS_PATH = path.join(CONFIG_DIR, "vessel-settings.json");
const DEFAULT_PORT = 3100;

let sessionId = null;
let negotiatedProtocolVersion = null;
let requestQueue = Promise.resolve();

function loadAuth() {
  try {
    const auth = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
    const token = (auth.token || "").trim();
    const endpoint = (auth.endpoint || "").trim();
    if (token && endpoint) return { token, endpoint };
    // Endpoint may have been cleared on shutdown; reconstruct from settings.
    if (token) return { token, endpoint: buildEndpoint() };
  } catch {}
  return null;
}

function buildEndpoint() {
  let port = DEFAULT_PORT;
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    const parsedPort = Number(settings.mcpPort);
    if (
      Number.isInteger(parsedPort) &&
      parsedPort >= 1 &&
      parsedPort <= 65535
    ) {
      port = parsedPort;
    }
  } catch {}
  return `http://127.0.0.1:${port}/mcp`;
}

function createJsonRpcError(id, message, code = -32000, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

function writeMessage(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function emitHttpError(id, status, body) {
  const fallbackMessage =
    status != null
      ? `Vessel MCP proxy error: upstream HTTP ${status}`
      : "Vessel MCP proxy error";

  let parsed;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    parsed = null;
  }

  if (
    parsed &&
    typeof parsed === "object" &&
    parsed.jsonrpc === "2.0" &&
    Object.prototype.hasOwnProperty.call(parsed, "error")
  ) {
    writeMessage(parsed);
    return;
  }

  const message =
    parsed &&
    typeof parsed === "object" &&
    typeof parsed.error === "string" &&
    parsed.error.trim()
      ? parsed.error.trim()
      : fallbackMessage;

  writeMessage(createJsonRpcError(id, message, -32000, { status, body }));
}

function tryTrackProtocolVersion(message) {
  if (
    message &&
    typeof message === "object" &&
    message.jsonrpc === "2.0" &&
    message.id != null &&
    message.result &&
    typeof message.result === "object"
  ) {
    const version = message.result.protocolVersion;
    if (typeof version === "string" && version.trim()) {
      negotiatedProtocolVersion = version.trim();
    }
  }
}

function emitJsonResponseBody(body) {
  if (!body || !body.trim()) return;

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    writeMessage(
      createJsonRpcError(
        null,
        "Vessel MCP proxy error: invalid JSON response from upstream",
        -32000,
        { body },
      ),
    );
    return;
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];
  for (const message of messages) {
    tryTrackProtocolVersion(message);
    writeMessage(message);
  }
}

function createSseParser(onEvent) {
  let buffer = "";
  let eventName = "message";
  let dataLines = [];

  const flushEvent = () => {
    if (dataLines.length === 0) {
      eventName = "message";
      return;
    }
    onEvent({
      event: eventName || "message",
      data: dataLines.join("\n"),
    });
    eventName = "message";
    dataLines = [];
  };

  return (chunk) => {
    buffer += chunk;

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);

      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }

      if (!line) {
        flushEvent();
        continue;
      }

      if (line.startsWith(":")) {
        continue;
      }

      const separatorIndex = line.indexOf(":");
      const field =
        separatorIndex === -1 ? line : line.slice(0, separatorIndex);
      let value =
        separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      if (field === "event") {
        eventName = value || "message";
      } else if (field === "data") {
        dataLines.push(value);
      }
    }
  };
}

function emitSseEventData(event) {
  if (!event.data || event.event !== "message") return;

  let parsed;
  try {
    parsed = JSON.parse(event.data);
  } catch {
    return;
  }

  tryTrackProtocolVersion(parsed);
  writeMessage(parsed);
}

function postJsonRpc(endpoint, token, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const payload = Buffer.from(JSON.stringify(body));
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Content-Length": payload.length,
      Authorization: `Bearer ${token}`,
    };

    if (sessionId) {
      headers["mcp-session-id"] = sessionId;
    }

    if (negotiatedProtocolVersion) {
      headers["mcp-protocol-version"] = negotiatedProtocolVersion;
    }

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers,
      },
      (res) => {
        const contentType = String(res.headers["content-type"] || "");
        const nextSessionId = res.headers["mcp-session-id"];
        if (typeof nextSessionId === "string" && nextSessionId.trim()) {
          sessionId = nextSessionId.trim();
        }

        const chunks = [];
        const parser = createSseParser(emitSseEventData);

        res.on("data", (chunk) => {
          chunks.push(chunk);
          if (contentType.includes("text/event-stream")) {
            parser(chunk.toString("utf8"));
          }
        });

        res.on("end", () => {
          const rawBody = Buffer.concat(chunks).toString("utf8");

          if (res.statusCode && res.statusCode >= 400) {
            emitHttpError(body.id ?? null, res.statusCode, rawBody);
            resolve();
            return;
          }

          if (contentType.includes("application/json")) {
            emitJsonResponseBody(rawBody);
          }

          resolve();
        });
      },
    );

    req.on("error", reject);
    req.end(payload);
  });
}

async function handleLine(endpoint, token, line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  try {
    await postJsonRpc(endpoint, token, message);
  } catch (error) {
    writeMessage(
      createJsonRpcError(
        message && typeof message === "object" ? message.id ?? null : null,
        `Vessel MCP proxy error: ${error.message}`,
      ),
    );
  }
}

async function main() {
  const auth = loadAuth();
  if (!auth) {
    process.stderr.write(
      "Vessel MCP stdio proxy: no auth token found.\n" +
        "Launch Vessel or run the installer to generate one.\n",
    );
    process.exit(1);
  }

  const { token, endpoint } = auth;
  const rl = readline.createInterface({ input: process.stdin });

  rl.on("line", (line) => {
    requestQueue = requestQueue
      .then(() => handleLine(endpoint, token, line))
      .catch((error) => {
        writeMessage(
          createJsonRpcError(
            null,
            `Vessel MCP proxy error: ${error.message}`,
          ),
        );
      });
  });

  rl.on("close", () => {
    requestQueue.finally(() => {
      process.exit(0);
    });
  });
}

main();
