import assert from "node:assert/strict";
import test from "node:test";
import type { WebContents } from "electron";
import { parseHTML } from "linkedom";

import { formatLiveSelectionSection } from "../src/main/highlights/live-snapshot";
import { highlightOnPage } from "../src/main/highlights/inject";
import { generateStableSelector } from "../src/shared/dom/selectors";

test("generateStableSelector uniquely targets form-associated external submit buttons", () => {
  const { document } = parseHTML(`
    <!doctype html>
    <html>
      <body>
        <form id="search">
          <label>Query <input name="q" /></label>
          <button>Go Bare</button>
        </form>
        <form id="external">
          <label>Topic <input name="topic" /></label>
        </form>
        <button form="external">External Bare Submit</button>
      </body>
    </html>
  `);

  const target = document.querySelector("button[form='external']");
  assert.ok(target, "expected external submit button");

  const selector = generateStableSelector(target);

  assert.notEqual(selector, "button");
  assert.equal(document.querySelectorAll(selector).length, 1);
  assert.equal(document.querySelector(selector), target);
});

test("generateStableSelector does not collapse top-level buttons to a bare tag selector", () => {
  const { document } = parseHTML(`
    <!doctype html>
    <html>
      <body>
        <form>
          <button>Nested First</button>
        </form>
        <button>Top Level Target</button>
      </body>
    </html>
  `);

  const buttons = document.querySelectorAll("button");
  const target = buttons[1];
  assert.ok(target, "expected top-level target button");

  const selector = generateStableSelector(target);

  assert.notEqual(selector, "button");
  assert.equal(document.querySelectorAll(selector).length, 1);
  assert.equal(document.querySelector(selector), target);
});

test("highlightOnPage marks selected text that spans inline nodes", async () => {
  const { window } = parseHTML(`
    <!doctype html>
    <html>
      <head></head>
      <body>
        <main>
          <p>OpenAI <strong>announces</strong> a new model for developers.</p>
        </main>
      </body>
    </html>
  `);

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    NodeFilter: globalThis.NodeFilter,
    getComputedStyle: globalThis.getComputedStyle,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };

  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    NodeFilter: window.NodeFilter ?? {
      SHOW_TEXT: 4,
      FILTER_ACCEPT: 1,
      FILTER_REJECT: 2,
    },
    getComputedStyle: () =>
      ({
        display: "block",
        visibility: "visible",
        opacity: "1",
      }) as CSSStyleDeclaration,
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    },
  });
  window.getComputedStyle = globalThis.getComputedStyle;

  Object.defineProperties(window.HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: () => 10 },
    offsetHeight: { configurable: true, get: () => 10 },
  });
  window.HTMLElement.prototype.scrollIntoView = () => {};

  const wc = {
    executeJavaScript: async (script: string) => (0, eval)(script),
  } as unknown as WebContents;

  try {
    const result = await highlightOnPage(
      wc,
      null,
      "OpenAI announces a new model",
      undefined,
      undefined,
      "yellow",
    );

    assert.match(result, /Highlighted 1 occurrence/);
    assert.equal(
      window.document.querySelectorAll(
        "mark.__vessel-highlight-text[data-vessel-highlight]",
      ).length,
      3,
    );
    assert.equal(
      Array.from(
        window.document.querySelectorAll(
          "mark.__vessel-highlight-text[data-vessel-highlight]",
        ),
      )
        .map((mark) => mark.textContent)
        .join(""),
      "OpenAI announces a new model",
    );
    assert.deepEqual(
      Array.from(
        window.document.querySelectorAll(
          "mark.__vessel-highlight-text[data-vessel-highlight]",
        ),
      ).map((mark) => mark.getAttribute("data-vessel-highlight-text")),
      [
        "OpenAI announces a new model",
        "OpenAI announces a new model",
        "OpenAI announces a new model",
      ],
    );
  } finally {
    Object.assign(globalThis, previous);
  }
});

test("formatLiveSelectionSection surfaces saved visible highlights prominently", () => {
  const section = formatLiveSelectionSection({
    activeSelection: "More personalized responses and controls",
    pageHighlights: [
      {
        text: "More personalized responses and controls",
        color: "rgb(240, 198, 54)",
        persisted: true,
      },
    ],
  });

  assert.ok(section);
  assert.match(section, /Active User Selection/);
  assert.match(section, /Visible Highlights On Screen/);
  assert.match(section, /Treat this as authoritative before searching or inspecting/);
  assert.match(section, /More personalized responses and controls/);
  assert.match(section, /saved/);
});
