import assert from "node:assert/strict";
import test from "node:test";

import { buildScopedContext } from "../src/main/ai/context-builder";
import {
  buildOverlayInventory,
  getBlockingOverlaySignature,
} from "../src/main/content/overlay-inventory";
import type { PageContent } from "../src/shared/types";

function buildPage(overrides: Partial<PageContent>): PageContent {
  return {
    title: "",
    content: "",
    htmlContent: "",
    byline: "",
    excerpt: "",
    url: "",
    headings: [],
    navigation: [],
    interactiveElements: [],
    forms: [],
    viewport: {
      width: 1280,
      height: 720,
      scrollX: 0,
      scrollY: 0,
    },
    overlays: [],
    dormantOverlays: [],
    landmarks: [],
    jsonLd: [],
    microdata: [],
    rdfa: [],
    metaTags: {},
    structuredData: [],
    pageIssues: [],
    ...overrides,
  };
}

test("overlay inventory groups selection modals and correct radio hints", () => {
  const page = buildPage({
    overlays: [
      {
        type: "modal",
        role: "dialog",
        label: "Please Select an Option",
        selector: "#selection-modal",
        text: "Choose the correct answer",
        blocksInteraction: true,
      },
    ],
    interactiveElements: [
      {
        type: "button",
        role: "radio",
        text: "Wrong option",
        labelSource: "value",
        selector: "#option-1",
        parentOverlay: "#selection-modal",
        looksCorrect: false,
        index: 11,
        visible: true,
        inViewport: true,
        fullyInViewport: true,
      },
      {
        type: "button",
        role: "radio",
        text: "Option B - Correct Choice",
        labelSource: "value",
        selector: "#option-2",
        parentOverlay: "#selection-modal",
        looksCorrect: true,
        index: 12,
        visible: true,
        inViewport: true,
        fullyInViewport: true,
      },
      {
        type: "button",
        text: "Submit",
        selector: "#submit-answer",
        parentOverlay: "#selection-modal",
        index: 13,
        visible: true,
        inViewport: true,
        fullyInViewport: true,
      },
    ],
  });

  const inventory = buildOverlayInventory(page);
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].kind, "selection_modal");
  assert.equal(inventory[0].radioOptions.length, 2);
  assert.equal(inventory[0].correctOption?.selector, "#option-2");
  assert.equal(inventory[0].submitAction?.selector, "#submit-answer");
});

test("overlay inventory falls back to overlay-extracted controls", () => {
  const page = buildPage({
    overlays: [
      {
        type: "modal",
        kind: "selection_modal",
        role: "dialog",
        label: "Please Select an Option",
        selector: "#selection-modal",
        text: "Choose the correct answer",
        blocksInteraction: true,
        actions: [
          {
            label: "Submit",
            selector: "#submit-answer",
            kind: "submit",
          },
        ],
        radioOptions: [
          {
            label: "Correct answer",
            selector: "#option-2",
            labelSource: "value",
            looksCorrect: true,
          },
        ],
      },
    ],
  });

  const inventory = buildOverlayInventory(page);
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].correctOption?.selector, "#option-2");
  assert.equal(inventory[0].submitAction?.selector, "#submit-answer");
});

test("blocking overlay signature changes when modal content is replaced", () => {
  const before = buildOverlayInventory(
    buildPage({
      overlays: [
        {
          type: "modal",
          kind: "selection_modal",
          role: "dialog",
          label: "Step 1",
          selector: "#selection-modal",
          text: "Choose the correct answer",
          blocksInteraction: true,
        },
      ],
      interactiveElements: [
        {
          type: "button",
          role: "radio",
          text: "Correct answer",
          labelSource: "value",
          selector: "#option-2",
          parentOverlay: "#selection-modal",
          looksCorrect: true,
          index: 12,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        },
      ],
    }),
  );

  const after = buildOverlayInventory(
    buildPage({
      overlays: [
        {
          type: "modal",
          kind: "alert",
          role: "alertdialog",
          label: "Step 2",
          selector: "#alert-modal",
          text: "A new blocking modal replaced the first one",
          blocksInteraction: true,
        },
      ],
      interactiveElements: [
        {
          type: "button",
          text: "Continue",
          selector: "#continue",
          parentOverlay: "#alert-modal",
          index: 14,
          visible: true,
          inViewport: true,
          fullyInViewport: true,
        },
      ],
    }),
  );

  assert.notEqual(
    getBlockingOverlaySignature(before),
    getBlockingOverlaySignature(after),
  );
});

test("context surfaces structured overlay options and scroll hints", () => {
  const page = buildPage({
    url: "https://example.com/challenge",
    title: "Automation Challenge",
    overlays: [
      {
        type: "modal",
        role: "dialog",
        label: "Please Select an Option",
        selector: "#selection-modal",
        text: "Choose the correct answer",
        blocksInteraction: true,
      },
    ],
    interactiveElements: [
      {
        type: "button",
        role: "radio",
        text: "Option B - Correct Choice",
        labelSource: "value",
        selector: "#option-2",
        parentOverlay: "#selection-modal",
        looksCorrect: true,
        index: 12,
        context: "dialog",
        visible: true,
        inViewport: true,
        fullyInViewport: true,
      },
      {
        type: "button",
        text: "Submit",
        selector: "#submit-answer",
        parentOverlay: "#selection-modal",
        index: 13,
        context: "dialog",
        visible: true,
        inViewport: true,
        fullyInViewport: true,
      },
      {
        type: "input",
        label: "Code input",
        inputType: "text",
        index: 22,
        context: "main",
        visible: true,
        inViewport: false,
        fullyInViewport: false,
        blockedByOverlay: false,
      },
    ],
  });

  const visible = buildScopedContext(page, "visible_only");
  assert.match(visible, /selection_modal/);
  assert.match(
    visible,
    /options: Option B - Correct Choice \(source=value, likely-correct\)/,
  );

  const summary = buildScopedContext(page, "summary");
  assert.match(
    summary,
    /\*\*Scroll Hint:\*\* Scroll to reveal offscreen controls: Code input/,
  );
});
