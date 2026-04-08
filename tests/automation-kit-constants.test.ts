import assert from "node:assert/strict";
import test from "node:test";

import { isSafeAutomationKitId } from "../src/shared/automation-kit-constants";

test("isSafeAutomationKitId rejects path separators and null bytes", () => {
  assert.equal(isSafeAutomationKitId("custom-kit"), true);
  assert.equal(isSafeAutomationKitId("nested/kit"), false);
  assert.equal(isSafeAutomationKitId("nested\\kit"), false);
  assert.equal(isSafeAutomationKitId("bad\0kit"), false);
});
