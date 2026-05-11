import assert from "node:assert/strict";
import test from "node:test";

import {
  assertTrustedIpcSender,
  isManagedTabIpcSender,
  registerTrustedIpcSender,
} from "../src/main/ipc/common";
import {
  loadInternalDataURL,
  loadTrustedAppURL,
} from "../src/main/network/url-safety";
import { openExternalAllowlisted } from "../src/main/security/external-open";
import { requiresExplicitMcpApproval } from "../src/main/mcp/server";
import { sanitizeTelemetryProperties } from "../src/main/telemetry/posthog";
import {
  decodeEncryptionKeyFromStorage,
  domainMatches,
  encodeEncryptionKeyForStorage,
  normalizeCredentialHost,
} from "../src/main/vault/shared";

test("trusted IPC guard rejects unregistered renderer senders", () => {
  assert.throws(
    () => assertTrustedIpcSender({ sender: { id: 9001 } } as never),
    /untrusted renderer/,
  );
});

test("trusted IPC guard accepts registered app UI senders", () => {
  registerTrustedIpcSender({ id: 42, once: () => undefined } as never);
  assert.doesNotThrow(() => assertTrustedIpcSender({ sender: { id: 42 } } as never));
});

test("managed tab IPC helper rejects unknown webContents senders", () => {
  const tabManager = {
    findTabByWebContentsId: (id: number) => (id === 7 ? { id: "tab" } : undefined),
  };
  assert.equal(
    isManagedTabIpcSender({ sender: { id: 7 } } as never, tabManager),
    true,
  );
  assert.equal(
    isManagedTabIpcSender({ sender: { id: 8 } } as never, tabManager),
    false,
  );
});

test("credential host normalization removes scheme and www prefix", () => {
  assert.equal(normalizeCredentialHost("https://www.example.com/login"), "example.com");
  assert.equal(normalizeCredentialHost("EXAMPLE.com/path"), "example.com");
});

test("credential wildcard patterns only match subdomains", () => {
  assert.equal(domainMatches("*.example.com", "login.example.com"), true);
  assert.equal(domainMatches("*.example.com", "example.com"), false);
  assert.equal(domainMatches("example.com", "login.example.com"), false);
});

test("external opener blocks unexpected schemes and hosts", async () => {
  await assert.rejects(
    openExternalAllowlisted("javascript:alert(1)", { hosts: ["github.com"] }),
    /Blocked external URL scheme/,
  );
  await assert.rejects(
    openExternalAllowlisted("https://evil.example", { hosts: ["github.com"] }),
    /Blocked external URL host/,
  );
  await assert.rejects(
    openExternalAllowlisted("https://token@github.com/settings", { hosts: ["github.com"] }),
    /embedded credentials/,
  );
});

test("trusted app URL loader only permits file and localhost URLs", async () => {
  const loaded: string[] = [];
  const wc = { loadURL: async (url: string) => { loaded.push(url); } } as never;

  await loadTrustedAppURL(wc, "http://localhost:5173/?view=chrome");
  assert.deepEqual(loaded, ["http://localhost:5173/?view=chrome"]);
  assert.throws(
    () => loadTrustedAppURL(wc, "https://example.com/app"),
    /Blocked unexpected app URL host/,
  );
});

test("internal data URL loader rejects non-html data URLs", async () => {
  const wc = { loadURL: async () => undefined } as never;
  assert.throws(
    () => loadInternalDataURL(wc, "data:text/plain,hello"),
    /Blocked unexpected internal data URL/,
  );
});

test("vault encryption key storage round-trips arbitrary binary keys", () => {
  const key = Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index));
  const encoded = encodeEncryptionKeyForStorage(key);
  assert.deepEqual(decodeEncryptionKeyFromStorage(encoded), key);
});

test("telemetry sanitizer drops sensitive keys and sensitive-looking values", () => {
  assert.deepEqual(
    sanitizeTelemetryProperties({
      action: "save",
      reason: "failed to fetch https://example.com/private",
      status: "ok",
      email: "person@example.com",
      tokenValue: "abc123",
      count: 2,
    }),
    { action: "save", status: "ok", count: 2 },
  );
});

test("telemetry sanitizer can enforce event-specific property allowlists", () => {
  assert.deepEqual(
    sanitizeTelemetryProperties(
      {
        step: "activation_failed",
        status: "free",
        accidental: "should not leave",
      },
      new Set(["step", "status"]),
    ),
    { step: "activation_failed", status: "free" },
  );
});

test("telemetry sanitizer keeps explicitly allowlisted metadata keys", () => {
  assert.deepEqual(
    sanitizeTelemetryProperties(
      { setting_key: "approvalMode", email: "person@example.com" },
      new Set(["setting_key"]),
    ),
    { setting_key: "approvalMode" },
  );
});

test("MCP approval helper flags destructive bookmark folder removal", () => {
  assert.equal(
    requiresExplicitMcpApproval("remove_bookmark_folder", {
      delete_contents: true,
    }),
    true,
  );
  assert.equal(
    requiresExplicitMcpApproval("remove_bookmark_folder", {
      delete_contents: false,
    }),
    false,
  );
});
