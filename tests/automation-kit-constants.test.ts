import assert from "node:assert/strict";
import test from "node:test";

import { isSafeAutomationKitId } from "../src/shared/automation-kit-constants";
import {
  buildSlashSkillValues,
  getSkillCommandTokens,
  getSkillSlashSuggestionQuery,
  getSkillSlashSuggestions,
  parseSkillSlashInvocation,
} from "../src/renderer/src/lib/automation-kits";
import type { AutomationKit } from "../src/shared/types";

const customSkill: AutomationKit = {
  id: "custom-research-helper",
  name: "Research Helper",
  description: "Research a topic",
  category: "research",
  icon: "Search",
  inputs: [
    {
      key: "topic",
      label: "Topic",
      type: "textarea",
      required: true,
    },
  ],
  promptTemplate: "Research {{topic}}",
};

test("isSafeAutomationKitId rejects path separators and null bytes", () => {
  assert.equal(isSafeAutomationKitId("custom-kit"), true);
  assert.equal(isSafeAutomationKitId("nested/kit"), false);
  assert.equal(isSafeAutomationKitId("nested\\kit"), false);
  assert.equal(isSafeAutomationKitId("bad\0kit"), false);
});

test("skill slash commands match skill ids and name slugs", () => {
  assert.deepEqual(getSkillCommandTokens(customSkill), [
    "research-helper",
    "custom-research-helper",
  ]);

  assert.equal(
    parseSkillSlashInvocation(
      "/custom-research-helper compare sources",
      [customSkill],
    )?.task,
    "compare sources",
  );
  assert.equal(
    parseSkillSlashInvocation("/skill research-helper compare sources", [
      customSkill,
    ])?.kit.id,
    customSkill.id,
  );
  assert.equal(parseSkillSlashInvocation("/unknown compare", [customSkill]), null);
});

test("buildSlashSkillValues fills a task-like required field", () => {
  const { values, missingLabels } = buildSlashSkillValues(
    customSkill,
    "compare sources",
  );

  assert.deepEqual(values, { topic: "compare sources" });
  assert.deepEqual(missingLabels, []);
});

test("skill slash suggestions filter until task text begins", () => {
  assert.equal(getSkillSlashSuggestionQuery("/"), "");
  assert.equal(getSkillSlashSuggestionQuery("/skill research"), "research");
  assert.equal(getSkillSlashSuggestionQuery("/research-helper"), "research-helper");
  assert.equal(getSkillSlashSuggestionQuery("/research-helper compare"), null);

  assert.deepEqual(
    getSkillSlashSuggestions("/rese", [customSkill]).map((kit) => kit.id),
    [customSkill.id],
  );
  assert.deepEqual(
    getSkillSlashSuggestions("/skill helper", [customSkill]).map((kit) => kit.id),
    [customSkill.id],
  );
});
