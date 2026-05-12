import test from "node:test";
import assert from "node:assert/strict";
import type { AIMessage, AutomationActivityEntry } from "../src/shared/types";
import type { ResearchClarification } from "../src/shared/research-types";

type QueryResult = { accepted: true } | { accepted: false; reason: "busy" };

function createMockAI(results: QueryResult[]) {
  const streamStartListeners = new Set<(prompt: string) => void>();
  const streamChunkListeners = new Set<(chunk: string) => void>();
  const streamEndListeners = new Set<
    (status: "completed" | "failed") => void
  >();
  const streamIdleListeners = new Set<() => void>();
  const automationStartListeners = new Set<
    (entry: AutomationActivityEntry) => void
  >();
  const automationChunkListeners = new Set<
    (payload: { id: string; chunk: string }) => void
  >();
  const automationEndListeners = new Set<
    (payload: {
      id: string;
      status: "completed" | "failed";
      finishedAt: string;
    }) => void
  >();
  const researchClarificationListeners = new Set<
    (payload: ResearchClarification) => void
  >();

  const queryCalls: Array<{ prompt: string; history: AIMessage[] | undefined }> = [];

  return {
    queryCalls,
    api: {
      query: async (prompt: string, history?: AIMessage[]) => {
        queryCalls.push({ prompt, history });
        return results.shift() ?? { accepted: true as const };
      },
      onStreamStart: (cb: (prompt: string) => void) => {
        streamStartListeners.add(cb);
        return () => streamStartListeners.delete(cb);
      },
      onStreamChunk: (cb: (chunk: string) => void) => {
        streamChunkListeners.add(cb);
        return () => streamChunkListeners.delete(cb);
      },
      onStreamEnd: (cb: (status: "completed" | "failed") => void) => {
        streamEndListeners.add(cb);
        return () => streamEndListeners.delete(cb);
      },
      onStreamIdle: (cb: () => void) => {
        streamIdleListeners.add(cb);
        return () => streamIdleListeners.delete(cb);
      },
      onResearchClarification: (cb: (payload: ResearchClarification) => void) => {
        researchClarificationListeners.add(cb);
        return () => researchClarificationListeners.delete(cb);
      },
      onAutomationActivityStart: (cb: (entry: AutomationActivityEntry) => void) => {
        automationStartListeners.add(cb);
        return () => automationStartListeners.delete(cb);
      },
      onAutomationActivityChunk: (
        cb: (payload: { id: string; chunk: string }) => void,
      ) => {
        automationChunkListeners.add(cb);
        return () => automationChunkListeners.delete(cb);
      },
      onAutomationActivityEnd: (
        cb: (payload: {
          id: string;
          status: "completed" | "failed";
          finishedAt: string;
        }) => void,
      ) => {
        automationEndListeners.add(cb);
        return () => automationEndListeners.delete(cb);
      },
      cancel: () => undefined,
    },
    emitStreamStart(prompt: string) {
      for (const listener of streamStartListeners) listener(prompt);
    },
    emitStreamChunk(chunk: string) {
      for (const listener of streamChunkListeners) listener(chunk);
    },
    emitStreamEnd(status: "completed" | "failed" = "completed") {
      for (const listener of streamEndListeners) listener(status);
    },
    emitStreamIdle() {
      for (const listener of streamIdleListeners) listener();
    },
    emitResearchClarification(payload: ResearchClarification) {
      for (const listener of researchClarificationListeners) listener(payload);
    },
  };
}

async function loadAIModule() {
  return import("../src/renderer/src/stores/ai");
}

async function loadUseAI(mockAI: ReturnType<typeof createMockAI>) {
  (globalThis as { window?: unknown }).window = {
    vessel: {
      ai: mockAI.api,
    },
  };

  const module = await loadAIModule();
  module.resetAIStoreForTests();
  return module.useAI();
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

test("queued prompt retries when the AI stream becomes idle after a busy response", async () => {
  const mockAI = createMockAI([
    { accepted: false, reason: "busy" },
    { accepted: true },
  ]);
  const store = await loadUseAI(mockAI);

  const result = await store.query("Follow up on that");
  assert.equal(result, "queued");
  assert.equal(store.pendingQueryCount(), 1);
  assert.deepEqual(
    mockAI.queryCalls.map((call) => call.prompt),
    ["Follow up on that"],
  );

  mockAI.emitStreamIdle();
  await flushAsyncWork();

  assert.equal(store.pendingQueryCount(), 0);
  assert.deepEqual(
    mockAI.queryCalls.map((call) => call.prompt),
    ["Follow up on that", "Follow up on that"],
  );
  assert.deepEqual(mockAI.queryCalls[1]?.history, []);
});

test("stream end plus idle only dispatches one queued retry", async () => {
  const mockAI = createMockAI([{ accepted: true }, { accepted: true }]);
  const store = await loadUseAI(mockAI);

  const started = await store.query("Current run");
  assert.equal(started, "started");
  mockAI.emitStreamStart("Current run");
  const firstQueued = await store.query("Queued one");
  const secondQueued = await store.query("Queued two");
  assert.equal(firstQueued, "queued");
  assert.equal(secondQueued, "queued");
  assert.equal(store.pendingQueryCount(), 2);

  mockAI.emitStreamChunk("Done");
  mockAI.emitStreamEnd();
  mockAI.emitStreamIdle();
  await flushAsyncWork();

  assert.deepEqual(
    mockAI.queryCalls.map((call) => call.prompt),
    ["Current run", "Queued one"],
  );
  assert.equal(store.pendingQueryCount(), 1);
});

test("automation prompt activity starts on stream start and keeps failure status", async () => {
  const mockAI = createMockAI([{ accepted: true }]);
  const store = await loadUseAI(mockAI);

  const result = await store.runAutomationPrompt("Run this kit", {
    id: "adhoc:test:1",
    title: "Research & Collect",
    icon: "BookOpen",
  });
  assert.equal(result, "started");
  assert.equal(store.automationActivities().length, 0);

  mockAI.emitStreamStart("Run this kit");
  assert.equal(store.automationActivities()[0]?.id, "adhoc:test:1");
  assert.equal(store.automationActivities()[0]?.status, "running");

  mockAI.emitStreamChunk("First step");
  mockAI.emitStreamChunk("\nSecond step");
  mockAI.emitStreamEnd("failed");

  assert.equal(store.automationActivities()[0]?.output, "First step\nSecond step");
  assert.equal(store.automationActivities()[0]?.status, "failed");
  assert.ok(store.automationActivities()[0]?.finishedAt);
});

test("queued automation prompt does not leak metadata into a later unrelated stream", async () => {
  const mockAI = createMockAI([{ accepted: false, reason: "busy" }]);
  const store = await loadUseAI(mockAI);

  const result = await store.runAutomationPrompt("Run this kit later", {
    id: "adhoc:test:queued",
    title: "Price Scout",
    icon: "Tag",
  });
  assert.equal(result, "queued");
  assert.equal(store.automationActivities().length, 0);

  mockAI.emitStreamStart("Different prompt");
  mockAI.emitStreamChunk("Hello");
  mockAI.emitStreamEnd("completed");

  assert.equal(store.automationActivities().length, 0);
});

test("queued automation prompt starts its activity when the retried prompt actually begins", async () => {
  const mockAI = createMockAI([
    { accepted: false, reason: "busy" },
    { accepted: true },
  ]);
  const store = await loadUseAI(mockAI);

  const result = await store.runAutomationPrompt("Run this kit later", {
    id: "adhoc:test:retry",
    title: "Price Scout",
    icon: "Tag",
  });
  assert.equal(result, "queued");
  assert.equal(store.automationActivities().length, 0);

  mockAI.emitStreamIdle();
  await flushAsyncWork();

  assert.deepEqual(
    mockAI.queryCalls.map((call) => call.prompt),
    ["Run this kit later", "Run this kit later"],
  );

  mockAI.emitStreamStart("Run this kit later");
  mockAI.emitStreamChunk("Found result");
  mockAI.emitStreamEnd("completed");

  assert.equal(store.automationActivities()[0]?.id, "adhoc:test:retry");
  assert.equal(store.automationActivities()[0]?.status, "completed");
  assert.equal(store.automationActivities()[0]?.output, "Found result");
});

test("research clarification event appears as assistant message with options", async () => {
  const mockAI = createMockAI([{ accepted: true }]);
  const store = await loadUseAI(mockAI);

  mockAI.emitResearchClarification({
    id: "clarification:test",
    question: "Which angle should Vessel use?",
    options: [
      { label: "Product comparison", response: "Focus on product comparison." },
    ],
    allowTypedResponse: true,
  });

  assert.deepEqual(store.messages(), [
    { role: "assistant", content: "Which angle should Vessel use?" },
  ]);
  assert.equal(store.researchClarifications()[0]?.options[0]?.label, "Product comparison");
});
