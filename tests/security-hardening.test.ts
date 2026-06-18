import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { session } from "electron";

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
import {
  CodexProvider,
  createCodexFunctionCallOutput,
} from "../src/main/ai/provider-codex";
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
import {
  getPrivateWindows,
  openPrivateWindowSafely,
} from "../src/main/private/window";
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

function codexSseResponse(
  events: Array<Record<string, unknown>>,
  headers: Record<string, string> = {},
): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        ...headers,
      },
    },
  );
}

test("private window launch is contained on setup failure", () => {
  const defaultSession = session.defaultSession as Electron.Session & {
    getUserAgent: () => string;
  };
  const originalGetUserAgent = defaultSession.getUserAgent;
  const beforeCount = getPrivateWindows().size;

  defaultSession.getUserAgent = () => {
    throw new Error("boom");
  };

  try {
    assert.equal(openPrivateWindowSafely(), false);
    assert.equal(
      getPrivateWindows().size,
      beforeCount,
      "failed private window setup should not leave a registered private window",
    );
  } finally {
    defaultSession.getUserAgent = originalGetUserAgent;
  }
});

test("private window launch succeeds through the safe entry point", () => {
  const beforeCount = getPrivateWindows().size;

  assert.equal(openPrivateWindowSafely(), true);
  assert.equal(getPrivateWindows().size, beforeCount + 1);
});

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

test("download filenames are flattened and contained in the download directory", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vessel-downloads-"));
  try {
    assert.equal(sanitizeDownloadFilename("../secrets.txt"), "secrets.txt");
    assert.equal(sanitizeDownloadFilename("nested\\report.pdf"), "report.pdf");
    assert.equal(sanitizeDownloadFilename(".."), "download");

    const resolved = await resolveDownloadPath(tempDir, "../../.ssh/authorized_keys");
    assert.equal(path.dirname(resolved), path.resolve(tempDir));
    assert.equal(path.basename(resolved), "authorized_keys");

    fs.writeFileSync(path.join(tempDir, "authorized_keys"), "existing");
    const collision = await resolveDownloadPath(tempDir, "../../.ssh/authorized_keys");
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

test("Codex function call output emits tool chips only after execution completes", async () => {
  const chunks: string[] = [];
  let resolveTool: ((value: string) => void) | null = null;
  let markToolStarted: (() => void) | null = null;
  const started = new Promise<void>((resolve) => {
    markToolStarted = resolve;
  });
  const callPromise = createCodexFunctionCallOutput(
    {
      type: "function_call",
      call_id: "call_delayed",
      name: "type_text",
      arguments: JSON.stringify({ text: "cheap flights" }),
    },
    new Set(["type_text"]),
    (chunk) => chunks.push(chunk),
    async () => {
      markToolStarted?.();
      return new Promise<string>((resolveOutput) => {
        resolveTool = resolveOutput;
      });
    },
  );

  await started;
  assert.deepEqual(chunks, []);

  resolveTool?.("Typed into: Search with DuckDuckGo = cheap flights");
  await callPromise;

  assert.equal(chunks.some((chunk) => chunk.includes("<<tool:type_text:cheap flights>>")), true);
});

test("Codex function call output marks failed executed tools as warning chips", async () => {
  const chunks: string[] = [];
  const output = await createCodexFunctionCallOutput(
    {
      type: "function_call",
      call_id: "call_failed_type",
      name: "type_text",
      arguments: JSON.stringify({ text: "cheap flights" }),
    },
    new Set(["type_text"]),
    (chunk) => chunks.push(chunk),
    async () => "Error: No element index or selector provided, and no focused or visible text input could be found.",
  );

  assert.equal(output.call_id, "call_failed_type");
  assert.match(output.output, /No element index/);
  assert.equal(chunks.some((chunk) => chunk.includes("<<tool:type_text:⚠ failed cheap flights>>")), true);
  assert.equal(chunks.some((chunk) => chunk.includes("<<tool:type_text:cheap flights>>")), false);
});

test("Codex tool chips do not mark successful same-page search as failed", async () => {
  const chunks: string[] = [];
  const output = await createCodexFunctionCallOutput(
    {
      type: "function_call",
      call_id: "call_search_same_page",
      name: "search",
      arguments: JSON.stringify({ query: "science fiction paperback" }),
    },
    new Set(["search"]),
    (chunk) => chunks.push(chunk),
    async () =>
      'Searched "science fiction paperback" (same page — results may have loaded dynamically)',
  );

  assert.equal(output.call_id, "call_search_same_page");
  assert.match(output.output, /Searched/);
  assert.equal(
    chunks.some((chunk) =>
      chunk.includes("<<tool:search:science fiction paperback>>"),
    ),
    true,
  );
  assert.equal(
    chunks.some((chunk) => chunk.includes("<<tool:search:⚠ failed")),
    false,
  );
});

test("Codex tool chips do not mark page content prose as read_page failure", async () => {
  const chunks: string[] = [];
  const output = await createCodexFunctionCallOutput(
    {
      type: "function_call",
      call_id: "call_read_page_content",
      name: "read_page",
      arguments: JSON.stringify({ mode: "results_only" }),
    },
    new Set(["read_page"]),
    (chunk) => chunks.push(chunk),
    async () =>
      [
        "[read_page mode=results_only]",
        "Need more detail? Escalate with read_page(mode=\"debug\") only if needed.",
        "A customer review says the character could not ignore the omen.",
      ].join("\n"),
  );

  assert.equal(output.call_id, "call_read_page_content");
  assert.match(output.output, /read_page mode=results_only/);
  assert.equal(
    chunks.some((chunk) => chunk.includes("<<tool:read_page>>")),
    true,
  );
  assert.equal(
    chunks.some((chunk) => chunk.includes("<<tool:read_page:⚠ failed")),
    false,
  );
});

test("Codex function call output repairs aliased scalar tool calls", async () => {
  const output = await createCodexFunctionCallOutput(
    {
      type: "function_call",
      call_id: "call_alias",
      name: "open",
      arguments: JSON.stringify("news.ycombinator.com"),
    },
    new Set(["navigate"]),
    () => undefined,
    async (name, args) => `${name}:${args.url}`,
  );

  assert.deepEqual(output, {
    type: "function_call_output",
    call_id: "call_alias",
    output: "navigate:https://news.ycombinator.com",
  });
});

test("Codex function call output accepts scalar highlight text", async () => {
  const output = await createCodexFunctionCallOutput(
    {
      type: "function_call",
      call_id: "call_highlight_scalar",
      name: "highlight",
      arguments: JSON.stringify("Solar generates more energy in US than coal for first time"),
    },
    new Set(["highlight"]),
    () => undefined,
    async (name, args) => `${name}:${args.text}`,
  );

  assert.deepEqual(output, {
    type: "function_call_output",
    call_id: "call_highlight_scalar",
    output: "highlight:Solar generates more energy in US than coal for first time",
  });
});

test("Codex function call output returns tool errors to the model", async () => {
  const output = await createCodexFunctionCallOutput(
    {
      type: "function_call",
      call_id: "call_4",
      name: "read_page",
      arguments: "{}",
    },
    new Set(["read_page"]),
    () => undefined,
    async () => {
      throw new Error(
        "Script failed to execute, this normally means an error was thrown. Check the renderer console for the error.",
      );
    },
  );

  assert.equal(output.type, "function_call_output");
  assert.equal(output.call_id, "call_4");
  assert.match(output.output, /Tool execution failed/);
  assert.match(output.output, /Script failed to execute/);
  assert.match(output.output, /read_page to refresh context/);
});

test("Codex agent follow-up pairs function calls with their outputs", async () => {
  const provider = new CodexProvider(
    {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      idToken: "",
      expiresAt: Date.now() + 60 * 60 * 1000,
      accountId: "account-123",
    },
    "gpt-5",
  );
  const requestBodies: Array<Record<string, unknown>> = [];
  let ended = false;

  await withMockFetch(async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    if (requestBodies.length === 1) {
      return codexSseResponse(
        [
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              call_id: "call_abc",
              name: "read_page",
              arguments: "{}",
            },
          },
        ],
        { "x-codex-turn-state": "turn-state-1" },
      );
    }
    return codexSseResponse([
      {
        type: "response.output_text.delta",
        delta: "done",
      },
    ]);
  }, () =>
    provider.streamAgentQuery(
      "system",
      "show me the page",
      [
        {
          name: "read_page",
          description: "Read the current page",
          input_schema: { type: "object", properties: {} },
        },
      ],
      () => undefined,
      async () => "Page text",
      () => {
        ended = true;
      },
    ),
  );

  assert.equal(ended, true);
  assert.equal(requestBodies.length, 2);
  assert.deepEqual(requestBodies[1].input, [
    {
      type: "function_call",
      call_id: "call_abc",
      name: "read_page",
      arguments: "{}",
    },
    {
      type: "function_call_output",
      call_id: "call_abc",
      output: "Page text",
    },
  ]);
});

test("Codex agent recovers text-encoded tool calls", async () => {
  const provider = new CodexProvider(
    {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      idToken: "",
      expiresAt: Date.now() + 60 * 60 * 1000,
      accountId: "account-123",
    },
    "gpt-5",
  );
  const requestBodies: Array<Record<string, unknown>> = [];
  const chunks: string[] = [];
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  await withMockFetch(async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    if (requestBodies.length === 1) {
      return codexSseResponse([
        {
          type: "response.output_text.delta",
          delta: 'read_page [ARGS] {"mode":"visible_only"}',
        },
      ]);
    }
    return codexSseResponse([
      {
        type: "response.output_text.delta",
        delta: "done",
      },
    ]);
  }, () =>
    provider.streamAgentQuery(
      "system",
      "read the current page",
      [
        {
          name: "read_page",
          description: "Read the current page",
          input_schema: { type: "object", properties: {} },
        },
      ],
      (chunk) => chunks.push(chunk),
      async (name, args) => {
        calls.push({ name, args });
        return "Page text";
      },
      () => undefined,
    ),
  );

  assert.deepEqual(calls, [{ name: "read_page", args: { mode: "visible_only" } }]);
  assert.equal(chunks.includes("<<erase_prev>>"), true);
  assert.equal(requestBodies.length, 2);
  assert.deepEqual(requestBodies[1].input, [
    {
      type: "function_call",
      call_id: (requestBodies[1].input as Array<{ call_id?: string }>)[0].call_id,
      name: "read_page",
      arguments: '{"mode":"visible_only"}',
    },
    {
      type: "function_call_output",
      call_id: (requestBodies[1].input as Array<{ call_id?: string }>)[0].call_id,
      output: "Page text",
    },
  ]);
});

test("Codex agent recovers narrated action tool calls", async () => {
  const provider = new CodexProvider(
    {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      idToken: "",
      expiresAt: Date.now() + 60 * 60 * 1000,
      accountId: "account-123",
    },
    "gpt-5",
  );
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  await withMockFetch(async () => {
    if (calls.length === 0) {
      return codexSseResponse([
        {
          type: "response.output_text.delta",
          delta: 'Action: search "Hacker News"',
        },
      ]);
    }
    return codexSseResponse([
      {
        type: "response.output_text.delta",
        delta: "done",
      },
    ]);
  }, () =>
    provider.streamAgentQuery(
      "system",
      "search Hacker News",
      [
        {
          name: "search",
          description: "Search the web",
          input_schema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
      () => undefined,
      async (name, args) => {
        calls.push({ name, args });
        return "Search complete";
      },
      () => undefined,
    ),
  );

  assert.deepEqual(calls, [{ name: "search", args: { query: "Hacker News" } }]);
});

test("Codex agent suppresses current-page re-search after successful web search", async () => {
  const provider = new CodexProvider(
    {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      idToken: "",
      expiresAt: Date.now() + 60 * 60 * 1000,
      accountId: "account-123",
    },
    "gpt-5",
  );
  const chunks: string[] = [];
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const query = "cheapest flight tomorrow from Portland to San Francisco";
  let requestCount = 0;

  await withMockFetch(async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return codexSseResponse([
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "call_web_search",
            name: "web_search",
            arguments: JSON.stringify({ query }),
          },
        },
      ]);
    }
    if (requestCount === 2) {
      return codexSseResponse([
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "call_site_search",
            name: "search",
            arguments: JSON.stringify({ query }),
          },
        },
      ]);
    }
    return codexSseResponse([
      {
        type: "response.output_text.delta",
        delta: "I found the current search results and will continue from them.",
      },
    ]);
  }, () =>
    provider.streamAgentQuery(
      "system",
      "can you help me find the cheapest flight for tomorrow from portland to san francisco?",
      [
        {
          name: "web_search",
          description: "Search the open web",
          input_schema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
        {
          name: "search",
          description: "Search within current site",
          input_schema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
        {
          name: "read_page",
          description: "Read current page",
          input_schema: { type: "object", properties: {} },
        },
      ],
      (chunk) => chunks.push(chunk),
      async (name, args) => {
        calls.push({ name, args });
        return `Web searched "${query}" via default search engine → https://duckduckgo.com/?q=cheapest%20flight%20tomorrow%20from%20Portland%20to%20San%20Francisco
[state: url=https://duckduckgo.com/?q=cheapest%20flight%20tomorrow%20from%20Portland%20to%20San%20Francisco, title="DuckDuckGo Search"]`;
      },
      () => undefined,
    ),
  );

  assert.deepEqual(calls, [{ name: "web_search", args: { query } }]);
  assert.equal(
    chunks.some((chunk) => chunk.includes("<<tool:search:↻ duplicate suppressed>>")),
    true,
  );
});

test("Codex agent suppresses query-drifted web search after successful web search", async () => {
  const provider = new CodexProvider(
    {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      idToken: "",
      expiresAt: Date.now() + 60 * 60 * 1000,
      accountId: "account-123",
    },
    "gpt-5",
  );
  const chunks: string[] = [];
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const requestBodies: Array<Record<string, unknown>> = [];
  let requestCount = 0;

  await withMockFetch(async (_input, init) => {
    requestCount += 1;
    requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    if (requestCount === 1) {
      return codexSseResponse([
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "call_web_search",
            name: "web_search",
            arguments: JSON.stringify({
              query: "cheapest flight tomorrow Portland to San Francisco",
            }),
          },
        },
      ]);
    }
    if (requestCount === 2) {
      return codexSseResponse([
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "call_drifted_search",
            name: "web_search",
            arguments: JSON.stringify({
              query: "Portland to San Francisco flights tomorrow cheapest",
            }),
          },
        },
      ]);
    }
    return codexSseResponse([
      {
        type: "response.output_text.delta",
        delta: "I will continue from the existing search results.",
      },
    ]);
  }, () =>
    provider.streamAgentQuery(
      "system",
      "can you help me find the cheapest flight for tomorrow from portland to san francisco?",
      [
        {
          name: "web_search",
          description: "Search the open web",
          input_schema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
        {
          name: "read_page",
          description: "Read current page",
          input_schema: { type: "object", properties: {} },
        },
      ],
      (chunk) => chunks.push(chunk),
      async (name, args) => {
        calls.push({ name, args });
        return `Web searched "cheapest flight tomorrow Portland to San Francisco" via default search engine → https://duckduckgo.com/?q=cheapest+flight+tomorrow+Portland+to+San+Francisco
[state: url=https://duckduckgo.com/?q=cheapest+flight+tomorrow+Portland+to+San+Francisco, title="DuckDuckGo Search"]`;
      },
      () => undefined,
    ),
  );

  assert.deepEqual(calls, [
    {
      name: "web_search",
      args: { query: "cheapest flight tomorrow Portland to San Francisco" },
    },
  ]);
  assert.equal(
    chunks.some((chunk) => chunk.includes("<<tool:web_search:↻ duplicate suppressed>>")),
    true,
  );
  assert.match(
    JSON.stringify(requestBodies[2]?.input ?? []),
    /already performed web_search successfully/,
  );
});

test("Codex agent suppresses clear_overlays without an overlay signal", async () => {
  const provider = new CodexProvider(
    {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      idToken: "",
      expiresAt: Date.now() + 60 * 60 * 1000,
      accountId: "account-123",
    },
    "gpt-5",
  );
  const chunks: string[] = [];
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const requestBodies: Array<Record<string, unknown>> = [];
  let requestCount = 0;

  await withMockFetch(async (_input, init) => {
    requestCount += 1;
    requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    if (requestCount === 1) {
      return codexSseResponse([
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "call_clear",
            name: "clear_overlays",
            arguments: "{}",
          },
        },
      ]);
    }
    return codexSseResponse([
      {
        type: "response.output_text.delta",
        delta: "I will use the page state instead.",
      },
    ]);
  }, () =>
    provider.streamAgentQuery(
      "system",
      "can you help me find the cheapest flight for tomorrow from portland to san francisco?",
      [
        {
          name: "clear_overlays",
          description: "Clear blocking overlays",
          input_schema: { type: "object", properties: {} },
        },
        {
          name: "read_page",
          description: "Read current page",
          input_schema: { type: "object", properties: {} },
        },
      ],
      (chunk) => chunks.push(chunk),
      async (name, args) => {
        calls.push({ name, args });
        return "No blocking overlays detected";
      },
      () => undefined,
    ),
  );

  assert.deepEqual(calls, []);
  assert.equal(
    chunks.some((chunk) => chunk.includes("<<tool:clear_overlays:↻ duplicate suppressed>>")),
    true,
  );
  assert.match(
    JSON.stringify(requestBodies[1]?.input ?? []),
    /No blocking overlay signal is present/,
  );
});

test("Codex agent recovers after a failed result click", async () => {
  const provider = new CodexProvider(
    {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      idToken: "",
      expiresAt: Date.now() + 60 * 60 * 1000,
      accountId: "account-123",
    },
    "gpt-5",
  );
  const chunks: string[] = [];
  const requestBodies: Array<Record<string, unknown>> = [];

  await withMockFetch(async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    if (requestBodies.length === 1) {
      return codexSseResponse([
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "call_click",
            name: "click",
            arguments: JSON.stringify({ index: 12 }),
          },
        },
      ]);
    }
    return codexSseResponse([
      {
        type: "response.output_text.delta",
        delta: "I will recover from the failed click.",
      },
    ]);
  }, () =>
    provider.streamAgentQuery(
      "system",
      "open the cheapest flight result",
      [
        {
          name: "click",
          description: "Click an element",
          input_schema: {
            type: "object",
            properties: { index: { type: "number" } },
            required: ["index"],
          },
        },
        {
          name: "read_page",
          description: "Read current page",
          input_schema: { type: "object", properties: {} },
        },
      ],
      (chunk) => chunks.push(chunk),
      async () =>
        "Clicked: Result snippet (clicked)\nNote: Page did not change after click. The element may need a different interaction method. Consider read_page or inspect_element.",
      () => undefined,
    ),
  );

  assert.equal(chunks.some((chunk) => chunk.includes("<<tool:click:⚠ failed #12>>")), true);
  const followUpInput = JSON.stringify(requestBodies[1]?.input ?? []);
  assert.match(followUpInput, /previous click did not complete for #12/);
  // The recovery message gives the model options, including
  // answering from already-visible results, without handing control
  // back to the user.
  assert.match(followUpInput, /take the next step/i);
  assert.match(followUpInput, /read_page/);
  assert.match(followUpInput, /answer from the results already visible/i);
  assert.match(followUpInput, /do not ask the user to inspect or click/i);
});
