import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import {
  resolveDownloadPath,
  sanitizeDownloadFilename,
} from "../src/main/network/downloads";
import { openExternalAllowlisted } from "../src/main/security/external-open";
import {
  getAirGapBlockReason,
  isLocalBaseUrl,
} from "../src/main/config/air-gapped";
import { createCodexFunctionCallOutput } from "../src/main/ai/provider-codex";
import { flushPersist, setSetting } from "../src/main/config/settings";
import { requiresExplicitMcpApproval } from "../src/main/mcp/server";
import {
  assertFeatureUnlocked,
  assertToolUnlocked,
  getPortalUrl,
  isPremium,
  verifyActivationCode,
} from "../src/main/premium/manager";
import { openUpdateDownload } from "../src/main/updates/checker";
import { sanitizeTelemetryProperties } from "../src/main/telemetry/posthog";
import {
  decodeEncryptionKeyFromStorage,
  domainMatches,
  encodeEncryptionKeyForStorage,
  normalizeCredentialHost,
} from "../src/main/vault/shared";
import type { PremiumState, PremiumStatus } from "../src/shared/types";

const DAY_MS = 24 * 60 * 60 * 1000;

function setPremiumStatusForTest(
  status: PremiumStatus,
  validatedAt: string,
): void {
  const state: PremiumState = {
    status,
    customerId: status === "free" ? "" : "cus_test",
    verificationToken: status === "free" ? "" : "token_test",
    email: status === "free" ? "" : "premium@example.com",
    validatedAt,
    expiresAt: "",
  };
  setSetting("premium", state);
}

async function withMockFetch<T>(
  handler: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Response | Promise<Response>,
  fn: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function withAirGappedForTest<T>(value: boolean, fn: () => T): T {
  const original = process.env.VESSEL_AIR_GAPPED;
  process.env.VESSEL_AIR_GAPPED = value ? "1" : "0";
  const restore = () => {
    if (original === undefined) {
      delete process.env.VESSEL_AIR_GAPPED;
    } else {
      process.env.VESSEL_AIR_GAPPED = original;
    }
  };

  try {
    const result = fn();
    if (
      result &&
      typeof (result as Promise<unknown>).finally === "function"
    ) {
      return (result as Promise<unknown>).finally(restore) as T;
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

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

test("air-gapped policy allows only localhost network URLs", () => {
  assert.equal(isLocalBaseUrl("http://localhost:11434/v1"), true);
  assert.equal(isLocalBaseUrl("http://127.0.0.1:8080/v1"), true);
  assert.equal(isLocalBaseUrl("http://[::1]:8080/v1"), true);
  assert.equal(isLocalBaseUrl("https://api.openai.com/v1"), false);

  withAirGappedForTest(true, () => {
    assert.equal(getAirGapBlockReason("http://localhost:11434/v1"), null);
    assert.equal(getAirGapBlockReason("http://127.0.0.1:8080/v1"), null);
    assert.equal(getAirGapBlockReason("file:///tmp/vessel.html"), null);
    assert.match(
      getAirGapBlockReason("https://example.com") || "",
      /Air-gapped mode blocked network access to example\.com/,
    );
  });

  withAirGappedForTest(false, () => {
    assert.equal(getAirGapBlockReason("https://example.com"), null);
  });
});

test("air-gapped mode blocks secondary outbound actions", async () => {
  await withAirGappedForTest(true, async () => {
    await withMockFetch(
      async () => {
        throw new Error("Activation API should not be called in air-gapped mode");
      },
      async () => {
        const result = await verifyActivationCode(
          "premium@example.com",
          "123456",
          "challenge",
        );
        assert.equal(result.ok, false);
        assert.match(result.error || "", /air-gapped mode/);
      },
    );

    await assert.rejects(openUpdateDownload(), /air-gapped mode/);
  });
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

test("premium gate only grants offline grace to recently validated active states", async () => {
  try {
    setPremiumStatusForTest("active", new Date(Date.now() - DAY_MS).toISOString());
    assert.equal(isPremium(), true);

    setPremiumStatusForTest("trialing", new Date(Date.now() - DAY_MS).toISOString());
    assert.equal(isPremium(), true);

    setPremiumStatusForTest("active", new Date(Date.now() - 8 * DAY_MS).toISOString());
    assert.equal(isPremium(), false);

    setPremiumStatusForTest("canceled", new Date(Date.now() - DAY_MS).toISOString());
    assert.equal(isPremium(), false);

    setPremiumStatusForTest("past_due", new Date(Date.now() - DAY_MS).toISOString());
    assert.equal(isPremium(), false);
  } finally {
    setPremiumStatusForTest("free", "");
    await flushPersist();
  }
});

test("premium assertions block gated tools and features for free users", async () => {
  try {
    setPremiumStatusForTest("free", "");

    for (const toolName of [
      "screenshot",
      "save_session",
      "load_session",
      "list_sessions",
      "delete_session",
      "flow_start",
      "flow_advance",
      "flow_status",
      "flow_end",
      "metrics",
      "extract_table",
      "vault_login",
      "vault_status",
      "vault_totp",
      "human_vault_list",
      "human_vault_fill",
      "human_vault_remove",
      "memory_note_create",
      "memory_note_append",
      "memory_note_list",
      "memory_note_search",
      "memory_page_capture",
    ]) {
      assert.throws(
        () => assertToolUnlocked(toolName),
        /requires Vessel Premium/,
      );
    }

    assert.throws(
      () => assertFeatureUnlocked("vault", "Agent Credential Vault"),
      /Agent Credential Vault requires Vessel Premium/,
    );
    assert.throws(
      () => assertFeatureUnlocked("human_vault", "Passwords"),
      /Passwords requires Vessel Premium/,
    );
    assert.throws(
      () => assertFeatureUnlocked("obsidian", "Obsidian memory"),
      /Obsidian memory requires Vessel Premium/,
    );
    assert.throws(
      () => assertFeatureUnlocked("devtools", "DevTools"),
      /DevTools requires Vessel Premium/,
    );
    assert.throws(
      () => assertFeatureUnlocked("automation_kits", "Skills"),
      /Skills requires Vessel Premium/,
    );
    assert.doesNotThrow(() => assertToolUnlocked("navigate"));
  } finally {
    setPremiumStatusForTest("free", "");
    await flushPersist();
  }
});

test("premium assertions allow gated tools and features for active premium users", async () => {
  try {
    setPremiumStatusForTest("active", new Date().toISOString());

    assert.doesNotThrow(() => assertToolUnlocked("screenshot"));
    assert.doesNotThrow(() =>
      assertFeatureUnlocked("vault", "Agent Credential Vault"),
    );
    assert.doesNotThrow(() =>
      assertFeatureUnlocked("human_vault", "Passwords"),
    );
    assert.doesNotThrow(() =>
      assertFeatureUnlocked("obsidian", "Obsidian memory"),
    );
    assert.doesNotThrow(() =>
      assertFeatureUnlocked("devtools", "DevTools"),
    );
    assert.doesNotThrow(() =>
      assertFeatureUnlocked("automation_kits", "Skills"),
    );
  } finally {
    setPremiumStatusForTest("free", "");
    await flushPersist();
  }
});

test("download filenames are flattened and contained in the download directory", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vessel-downloads-"));
  try {
    assert.equal(sanitizeDownloadFilename("../secrets.txt"), "secrets.txt");
    assert.equal(sanitizeDownloadFilename("nested\\report.pdf"), "report.pdf");
    assert.equal(sanitizeDownloadFilename(".."), "download");

    const resolved = resolveDownloadPath(tempDir, "../../.ssh/authorized_keys");
    assert.equal(path.dirname(resolved), path.resolve(tempDir));
    assert.equal(path.basename(resolved), "authorized_keys");

    fs.writeFileSync(path.join(tempDir, "authorized_keys"), "existing");
    const collision = resolveDownloadPath(tempDir, "../../.ssh/authorized_keys");
    assert.equal(path.dirname(collision), path.resolve(tempDir));
    assert.equal(path.basename(collision), "authorized_keys (1)");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("premium billing portal uses the stored verification token", async () => {
  try {
    setSetting("premium", {
      status: "active",
      customerId: "cus_test",
      verificationToken: "signed-token",
      email: "premium@example.com",
      validatedAt: new Date().toISOString(),
      expiresAt: "",
    });

    await withMockFetch(
      async (input, init) => {
        assert.equal(String(input), "https://vesselpremium.quantaintellect.com/portal");
        assert.equal(init?.method, "POST");
        assert.deepEqual(
          JSON.parse(String(init?.body || "{}")),
          { identifier: "signed-token" },
        );
        return new Response(
          JSON.stringify({ url: "https://billing.stripe.test/session" }),
          { status: 200 },
        );
      },
      async () => {
        assert.deepEqual(
          await getPortalUrl(),
          { ok: true, url: "https://billing.stripe.test/session" },
        );
      },
    );
  } finally {
    setPremiumStatusForTest("free", "");
    await flushPersist();
  }
});

test("premium billing portal requires a stored verification token", async () => {
  try {
    setSetting("premium", {
      status: "active",
      customerId: "cus_test",
      verificationToken: "",
      email: "premium@example.com",
      validatedAt: new Date().toISOString(),
      expiresAt: "",
    });

    await withMockFetch(
      async () => {
        throw new Error("Portal API should not be called without a token");
      },
      async () => {
        const result = await getPortalUrl();
        assert.equal(result.ok, false);
        assert.match(result.error || "", /Verify your Premium subscription/);
      },
    );
  } finally {
    setPremiumStatusForTest("free", "");
    await flushPersist();
  }
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

test("Codex function call output rejects malformed arguments without executing", async () => {
  let executed = false;
  const chunks: string[] = [];

  const output = await createCodexFunctionCallOutput(
    {
      type: "function_call",
      call_id: "call_1",
      name: "navigate",
      arguments: "{bad json",
    },
    new Set(["navigate"]),
    (chunk) => chunks.push(chunk),
    async () => {
      executed = true;
      return "should not run";
    },
  );

  assert.equal(executed, false);
  assert.equal(output.type, "function_call_output");
  assert.equal(output.call_id, "call_1");
  assert.match(output.output, /Invalid JSON/);
  assert.equal(chunks.some((chunk) => chunk.includes("invalid args")), true);
});

test("Codex function call output rejects unsupported tools without executing", async () => {
  let executed = false;

  const output = await createCodexFunctionCallOutput(
    {
      type: "function_call",
      call_id: "call_2",
      name: "invented_tool",
      arguments: "{}",
    },
    new Set(["navigate"]),
    () => undefined,
    async () => {
      executed = true;
      return "should not run";
    },
  );

  assert.equal(executed, false);
  assert.equal(output.call_id, "call_2");
  assert.match(output.output, /Unsupported tool: invented_tool/);
});

test("Codex function call output executes valid supported calls", async () => {
  const output = await createCodexFunctionCallOutput(
    {
      type: "function_call",
      call_id: "call_3",
      name: "navigate",
      arguments: JSON.stringify({ url: "https://example.com" }),
    },
    new Set(["navigate"]),
    () => undefined,
    async (name, args) => `${name}:${args.url}`,
  );

  assert.deepEqual(output, {
    type: "function_call_output",
    call_id: "call_3",
    output: "navigate:https://example.com",
  });
});
