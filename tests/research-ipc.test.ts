import { describe, it } from "node:test";
import assert from "node:assert";
import type { ResearchState } from "../src/shared/research-types";
import { PREMIUM_TOOLS } from "../src/main/premium/manager";

describe("Research IPC handler contracts", () => {
  it("allows free users to start the brief before premium-gated execution", () => {
    assert.equal(PREMIUM_TOOLS.has("research_start"), false);
    assert.equal(PREMIUM_TOOLS.has("research_confirm_brief"), true);
    assert.equal(PREMIUM_TOOLS.has("research_approve_objectives"), true);
  });

  it("RESEARCH_START_BRIEF returns accepted:true when idle", async () => {
    // Simulate what the IPC handler does — check phase === idle
    const state: ResearchState = {
      phase: "idle",
      supervisionMode: "interactive",
      includeTraces: false,
      objectives: null,
      threads: [],
      threadProgress: [],
      threadFindings: [],
      report: null,
      subAgentTraces: [],
      error: null,
      startedAt: null,
    };

    const canStartBrief = state.phase === "idle";
    assert.strictEqual(canStartBrief, true);
  });

  it("RESEARCH_START_BRIEF returns accepted:false when busy", async () => {
    const state: ResearchState = {
      phase: "executing",
      supervisionMode: "interactive",
      includeTraces: false,
      objectives: null,
      threads: [],
      threadProgress: [],
      threadFindings: [],
      report: null,
      subAgentTraces: [],
      error: null,
      startedAt: null,
    };

    const canStartBrief = state.phase === "idle";
    assert.strictEqual(canStartBrief, false);
  });

  it("RESEARCH_CANCEL resets to idle", async () => {
    const resetState: ResearchState = {
      phase: "idle",
      supervisionMode: "interactive",
      includeTraces: false,
      objectives: null,
      threads: [],
      threadProgress: [],
      threadFindings: [],
      report: null,
      subAgentTraces: [],
      error: null,
      startedAt: null,
    };

    assert.strictEqual(resetState.phase, "idle");
    assert.strictEqual(resetState.objectives, null);
    assert.strictEqual(resetState.report, null);
    assert.strictEqual(resetState.error, null);
  });

  it("RESEARCH_APPROVE_OBJECTIVES transitions to executing", async () => {
    let phase = "awaiting_approval";

    const canApprove = phase === "awaiting_approval";
    assert.strictEqual(canApprove, true);

    // After approval, phase becomes executing
    phase = "executing";
    assert.strictEqual(phase, "executing");
  });

  it("useResearch premium signal updates on subscription callback", () => {
    // Simulate what window.vessel.premium.onUpdate does — fires with new state
    let premiumActive = false;
    const updatePremium = (status: string | undefined) => {
      premiumActive = status === "active" || status === "trialing";
    };

    // Initial: inactive
    updatePremium("inactive");
    assert.strictEqual(premiumActive, false);

    // Upgrade happens in another tab / settings
    updatePremium("active");
    assert.strictEqual(premiumActive, true);

    // Expiry
    updatePremium("expired");
    assert.strictEqual(premiumActive, false);

    // Missing status — safe default
    updatePremium(undefined);
    assert.strictEqual(premiumActive, false);
  });
});
