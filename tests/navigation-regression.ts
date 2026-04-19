import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import process from "node:process";

import { app, BaseWindow, ipcMain } from "electron";

import { buildScopedContext } from "../src/main/ai/context-builder";
import { extractContent } from "../src/main/content/extractor";
import {
  clickElementBySelector,
  dismissPopup,
  fillFormFields,
  pressKey,
  searchPage,
  setElementValue,
  submitFormBySelector,
  waitForLoad,
} from "../src/main/ai/page-actions";
import {
  capturePageSnapshot,
  schedulePageSnapshotCapture,
} from "../src/main/content/page-diff-monitor";
import { Tab } from "../src/main/tabs/tab";
import { Channels } from "../src/shared/channels";
import {
  buildPageSnapshotKey,
  normalizePageUrl,
} from "../src/shared/page-url";
import { createNavigationHarnessServer } from "./fixtures/navigation-harness";

async function withTab(
  url: string,
  run: (
    tab: Tab,
    window: BaseWindow,
    openedUrls: Array<{ url: string; background: boolean }>,
  ) => Promise<void>,
): Promise<void> {
  const window = new BaseWindow({
    show: false,
    width: 1280,
    height: 900,
    backgroundColor: "#1a1a1e",
  });
  const openedUrls: Array<{ url: string; background: boolean }> = [];
  const tab = new Tab(randomUUID(), url, () => {}, {
    onOpenUrl: ({ url, background }) => {
      openedUrls.push({ url, background });
    },
  });
  window.contentView.addChildView(tab.view);
  tab.view.setBounds({ x: 0, y: 0, width: 1280, height: 900 });

  try {
    await waitForLoad(tab.view.webContents, 8000);
    await run(tab, window, openedUrls);
  } finally {
    try {
      window.contentView.removeChildView(tab.view);
    } catch {
      // ignore cleanup errors
    }
    tab.destroy();
    window.destroy();
  }
}

async function runScenario(
  name: string,
  scenario: () => Promise<void>,
): Promise<void> {
  process.stdout.write(`- ${name}... `);
  await scenario();
  process.stdout.write("ok\n");
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

async function main(): Promise<void> {
  const harness = await createNavigationHarnessServer();
  const completedScenarios: string[] = [];
  await app.whenReady();

  try {
    await runScenario(
      "anchor clicks create stable back/forward history",
      async () => {
        await withTab(`${harness.baseUrl}/anchor-source`, async (tab) => {
          const wc = tab.view.webContents;

          const result = await clickElementBySelector(wc, "#go-anchor");
          assert.match(result, /Clicked: Go to Anchor Dest/);
          assert.equal(wc.getURL(), `${harness.baseUrl}/anchor-dest`);
          assert.equal(tab.canGoBack(), true);
          assert.equal(tab.canGoForward(), false);

          assert.equal(tab.goBack(), true);
          await waitForLoad(wc, 8000);
          assert.equal(wc.getURL(), `${harness.baseUrl}/anchor-source`);
          assert.equal(tab.canGoForward(), true);

          assert.equal(tab.goForward(), true);
          await waitForLoad(wc, 8000);
          assert.equal(wc.getURL(), `${harness.baseUrl}/anchor-dest`);
        });
      },
    );
    completedScenarios.push("anchor clicks create stable back/forward history");

    await runScenario(
      "offscreen anchors auto-scroll before click",
      async () => {
        await withTab(
          `${harness.baseUrl}/offscreen-anchor-source`,
          async (tab) => {
            const wc = tab.view.webContents;

            const result = await clickElementBySelector(
              wc,
              "#go-offscreen-anchor",
            );
            assert.match(result, /Clicked: Go to Anchor Dest/);
            assert.equal(wc.getURL(), `${harness.baseUrl}/anchor-dest`);
            assert.equal(tab.canGoBack(), true);
          },
        );
      },
    );
    completedScenarios.push("offscreen anchors auto-scroll before click");

    await runScenario(
      "JS-driven button navigations survive back/forward",
      async () => {
        await withTab(`${harness.baseUrl}/js-source`, async (tab) => {
          const wc = tab.view.webContents;

          const result = await clickElementBySelector(wc, "#go-js");
          assert.match(result, /Clicked: Go to JS Dest/);
          assert.equal(wc.getURL(), `${harness.baseUrl}/js-dest`);
          assert.equal(tab.canGoBack(), true);
          assert.equal(tab.canGoForward(), false);

          assert.equal(tab.goBack(), true);
          await waitForLoad(wc, 8000);
          assert.equal(wc.getURL(), `${harness.baseUrl}/js-source`);
          assert.equal(tab.canGoForward(), true);

          assert.equal(tab.goForward(), true);
          await waitForLoad(wc, 8000);
          assert.equal(wc.getURL(), `${harness.baseUrl}/js-dest`);
        });
      },
    );
    completedScenarios.push(
      "JS-driven button navigations survive back/forward",
    );

    await runScenario(
      "obstructed links recover via DOM activation fallback",
      async () => {
        await withTab(
          `${harness.baseUrl}/obstructed-anchor-source`,
          async (tab) => {
            const wc = tab.view.webContents;

            const result = await clickElementBySelector(
              wc,
              "#go-obstructed-anchor",
            );
            assert.match(result, /recovered via DOM activation/);
            assert.equal(wc.getURL(), `${harness.baseUrl}/anchor-dest`);
            assert.equal(tab.canGoBack(), true);
          },
        );
      },
    );
    completedScenarios.push(
      "obstructed links recover via DOM activation fallback",
    );

    await runScenario(
      "target blank anchors are surfaced as new tab requests",
      async () => {
        await withTab(
          `${harness.baseUrl}/blank-anchor-source`,
          async (tab, _window, openedUrls) => {
            const wc = tab.view.webContents;

            const result = await clickElementBySelector(wc, "#go-blank-anchor");
            assert.match(result, /Clicked: Open Anchor Dest In New Tab/);
            assert.equal(wc.getURL(), `${harness.baseUrl}/blank-anchor-source`);
            assert.deepEqual(openedUrls, [
              { url: `${harness.baseUrl}/anchor-dest`, background: false },
            ]);
          },
        );
      },
    );
    completedScenarios.push(
      "target blank anchors are surfaced as new tab requests",
    );

    await runScenario(
      "window.open navigations are surfaced as new tab requests",
      async () => {
        await withTab(
          `${harness.baseUrl}/window-open-source`,
          async (tab, _window, openedUrls) => {
            const wc = tab.view.webContents;

            const result = await clickElementBySelector(wc, "#go-window-open");
            assert.match(result, /Clicked: Open JS Dest In New Tab/);
            assert.equal(wc.getURL(), `${harness.baseUrl}/window-open-source`);
            assert.deepEqual(openedUrls, [
              { url: `${harness.baseUrl}/js-dest`, background: false },
            ]);
          },
        );
      },
    );
    completedScenarios.push(
      "window.open navigations are surfaced as new tab requests",
    );

    await runScenario(
      "ghost link clicks recover by following the href directly",
      async () => {
        await withTab(`${harness.baseUrl}/ghost-anchor-source`, async (tab) => {
          const wc = tab.view.webContents;

          const result = await clickElementBySelector(wc, "#go-ghost-anchor");
          assert.match(result, /recovered via href fallback/);
          assert.equal(wc.getURL(), `${harness.baseUrl}/anchor-dest`);
          assert.equal(tab.canGoBack(), true);
        });
      },
    );
    completedScenarios.push(
      "ghost link clicks recover by following the href directly",
    );

    await runScenario(
      "GET form submissions preserve custom history",
      async () => {
        await withTab(`${harness.baseUrl}/get-form`, async (tab) => {
          const wc = tab.view.webContents;

          await setElementValue(wc, 'input[name="q"]', "alpha");
          const result = await submitFormBySelector(wc, "form#search");
          assert.equal(
            result,
            `Submitted form via GET -> ${harness.baseUrl}/get-result?q=alpha`,
          );
          assert.equal(wc.getURL(), `${harness.baseUrl}/get-result?q=alpha`);
          assert.equal(tab.canGoBack(), true);

          assert.equal(tab.goBack(), true);
          await waitForLoad(wc, 8000);
          assert.equal(wc.getURL(), `${harness.baseUrl}/get-form`);

          assert.equal(tab.goForward(), true);
          await waitForLoad(wc, 8000);
          assert.equal(wc.getURL(), `${harness.baseUrl}/get-result?q=alpha`);
        });
      },
    );
    completedScenarios.push("GET form submissions preserve custom history");

    await runScenario(
      "POST form submissions preserve custom history",
      async () => {
        await withTab(`${harness.baseUrl}/post-form`, async (tab) => {
          const wc = tab.view.webContents;

          await setElementValue(wc, 'input[name="q"]', "beta");
          const result = await submitFormBySelector(wc, "form#post-search");
          assert.equal(
            result,
            `Submitted form via POST -> ${harness.baseUrl}/post-result?q=beta`,
          );
          assert.equal(wc.getURL(), `${harness.baseUrl}/post-result?q=beta`);
          assert.equal(tab.canGoBack(), true);

          assert.equal(tab.goBack(), true);
          await waitForLoad(wc, 8000);
          assert.equal(wc.getURL(), `${harness.baseUrl}/post-form`);

          assert.equal(tab.goForward(), true);
          await waitForLoad(wc, 8000);
          assert.equal(wc.getURL(), `${harness.baseUrl}/post-result?q=beta`);
        });
      },
    );
    completedScenarios.push("POST form submissions preserve custom history");

    await runScenario(
      "external form-associated submit buttons preserve custom history",
      async () => {
        await withTab(`${harness.baseUrl}/external-submit`, async (tab) => {
          const wc = tab.view.webContents;

          await setElementValue(wc, 'input[name="topic"]', "gamma");
          const result = await submitFormBySelector(
            wc,
            "button[form='external']",
          );
          assert.equal(
            result,
            `Submitted form via GET -> ${harness.baseUrl}/external-result?topic=gamma`,
          );
          assert.equal(
            wc.getURL(),
            `${harness.baseUrl}/external-result?topic=gamma`,
          );
          assert.equal(tab.canGoBack(), true);

          assert.equal(tab.goBack(), true);
          await waitForLoad(wc, 8000);
          assert.equal(wc.getURL(), `${harness.baseUrl}/external-submit`);

          assert.equal(tab.goForward(), true);
          await waitForLoad(wc, 8000);
          assert.equal(
            wc.getURL(),
            `${harness.baseUrl}/external-result?topic=gamma`,
          );
        });
      },
    );
    completedScenarios.push(
      "external form-associated submit buttons preserve custom history",
    );

    await runScenario(
      "fill_form matches fields by name, label, and placeholder",
      async () => {
        await withTab(`${harness.baseUrl}/named-form`, async (tab) => {
          const wc = tab.view.webContents;

          const results = await fillFormFields(wc, [
            { name: "custname", value: "Test User" },
            { label: "Email Address", value: "test@example.com" },
            { placeholder: "Phone number", value: "555-0100" },
          ]);

          assert.equal(results.length, 3);
          assert.ok(results.every((item) => item.selector));
          assert.ok(
            results.every((item) => !item.result.startsWith("Skipped:")),
            `expected every field to resolve, got: ${results
              .map((item) => item.result)
              .join("; ")}`,
          );

          const values = await wc.executeJavaScript(`
            ({
              name: document.getElementById('custname')?.value || '',
              email: document.getElementById('email-field')?.value || '',
              phone: document.getElementById('phone-field')?.value || '',
            })
          `);

          assert.deepEqual(values, {
            name: "Test User",
            email: "test@example.com",
            phone: "555-0100",
          });
        });
      },
    );
    completedScenarios.push(
      "fill_form matches fields by name, label, and placeholder",
    );

    await runScenario(
      "side cart drawers are treated like modal actions",
      async () => {
        await withTab(`${harness.baseUrl}/cart-drawer`, async (tab) => {
          const wc = tab.view.webContents;

          const page = await extractContent(wc);
          const context = buildScopedContext(page, "visible_only");

          assert.match(context, /### Immediate Overlay Actions/);
          assert.match(
            context,
            /\[#2\] \[Continue Shopping\] button \(context=dialog\)/,
          );
          assert.match(
            context,
            /\[#3\] \[View Basket\] link → .*\/cart \(context=dialog\)/,
          );
          assert.match(
            context,
            /Cart confirmation detected: choose a dialog action such as Continue Shopping, View Cart, or Checkout\. Do not click background Add to Cart again\./,
          );
          assert.doesNotMatch(context, /\[#1\] \[Add to Cart\]/);
        });
      },
    );
    completedScenarios.push("side cart drawers are treated like modal actions");

    await runScenario(
      "click that triggers cart drawer returns overlay hint",
      async () => {
        await withTab(`${harness.baseUrl}/cart-drawer-click`, async (tab) => {
          const wc = tab.view.webContents;

          const result = await clickElementBySelector(wc, "#add-to-cart");
          assert.match(result, /Clicked: Add to Cart/);
          assert.match(result, /cart confirmation dialog appeared/i);
          assert.match(result, /do not click Add to Cart again/i);
        });
      },
    );
    completedScenarios.push(
      "click that triggers cart drawer returns overlay hint",
    );

    await runScenario(
      "absolute-positioned cart drawer detected after click",
      async () => {
        await withTab(
          `${harness.baseUrl}/cart-drawer-absolute`,
          async (tab) => {
            const wc = tab.view.webContents;

            const result = await clickElementBySelector(wc, "#add-to-cart");
            assert.match(result, /Clicked: Add to Cart/);
            assert.match(result, /cart confirmation dialog appeared/i);
            assert.match(result, /do not click Add to Cart again/i);

            // Also verify extraction detects the overlay properly
            const page = await extractContent(wc);
            const context = buildScopedContext(page, "visible_only");
            assert.match(context, /### Immediate Overlay Actions/);
            assert.match(context, /Continue Shopping/);
          },
        );
      },
    );
    completedScenarios.push(
      "absolute-positioned cart drawer detected after click",
    );

    await runScenario(
      "single clicks do not re-activate add-like buttons on the same page",
      async () => {
        await withTab(
          `${harness.baseUrl}/single-click-counter`,
          async (tab) => {
            const wc = tab.view.webContents;

            const result = await clickElementBySelector(wc, "#count-once");
            assert.match(result, /Clicked: Count Once/);

            const count = await wc.executeJavaScript(
              `document.getElementById("count")?.textContent || ""`,
            );
            assert.equal(count, "1");
          },
        );
      },
    );
    completedScenarios.push(
      "single clicks do not re-activate add-like buttons on the same page",
    );

    await runScenario(
      "same-page actions settle without a long fake navigation wait",
      async () => {
        await withTab(`${harness.baseUrl}/same-page-action`, async (tab) => {
          const wc = tab.view.webContents;

          const startedAt = Date.now();
          const result = await clickElementBySelector(wc, "#update-same-page");
          const elapsedMs = Date.now() - startedAt;

          assert.match(result, /Clicked: Update without navigating/);
          assert.equal(wc.getURL(), `${harness.baseUrl}/same-page-action`);
          assert.equal(wc.getTitle(), "same-page-action-updated");
          assert.ok(
            elapsedMs < 1800,
            `expected same-page action to settle quickly, got ${elapsedMs}ms`,
          );
        });
      },
    );
    completedScenarios.push(
      "same-page actions settle without a long fake navigation wait",
    );

    await runScenario(
      "page snapshots emit diffs for changed content on the same normalized URL",
      async () => {
        const pageUrlBase = `${harness.baseUrl}/page-diff`;
        await withTab(`${pageUrlBase}?version=1`, async (tab) => {
          const wc = tab.view.webContents;
          const events: Array<{ channel: string; diff: unknown }> = [];

          await capturePageSnapshot(wc.getURL(), wc, (channel, diff) => {
            events.push({ channel, diff });
          });
          assert.equal(events.length, 0);

          await wc.loadURL(`${pageUrlBase}?version=2`);
          await waitForLoad(wc, 8000);
          await capturePageSnapshot(wc.getURL(), wc, (channel, diff) => {
            events.push({ channel, diff });
          });

          assert.equal(events.length, 1);
          assert.equal(events[0]?.channel, Channels.PAGE_CHANGED);

          const diff = events[0]?.diff as {
            url: string;
            hasChanges: boolean;
            changes: Array<{
              section: string;
              kind: string;
              summary: string;
              before?: string;
              after?: string;
              addedItems?: string[];
              removedItems?: string[];
            }>;
          };
          assert.equal(diff.url, normalizePageUrl(pageUrlBase));
          assert.equal(diff.hasChanges, true);
          const titleChange = diff.changes.find(
            (change) => change.section === "title",
          );
          assert.ok(
            titleChange,
            `expected title change, got: ${JSON.stringify(diff.changes)}`,
          );
          assert.equal(titleChange?.kind, "changed");
          assert.equal(titleChange?.before, "page-diff-original");
          assert.equal(titleChange?.after, "page-diff-updated");

          const headingChange = diff.changes.find(
            (change) => change.section === "headings",
          );
          assert.ok(
            headingChange,
            `expected heading change, got: ${JSON.stringify(diff.changes)}`,
          );
          assert.equal(headingChange?.kind, "changed");
          assert.deepEqual(headingChange?.addedItems, ["## New Features"]);
          assert.deepEqual(headingChange?.removedItems, ["## Overview"]);

          const contentChange = diff.changes.find(
            (change) => change.section === "content",
          );
          assert.ok(
            contentChange,
            `expected content change, got: ${JSON.stringify(diff.changes)}`,
          );
          assert.equal(contentChange?.kind, "changed");
          assert.match(contentChange?.summary || "", /updated section/);
          assert.match(
            contentChange?.before || "",
            /Initial release notes for the navigation harness baseline\./,
          );
          assert.match(
            contentChange?.after || "",
            /Added page diff summaries for returning visits with address-bar visibility\./,
          );

          await capturePageSnapshot(wc.getURL(), wc, (channel, diffAgain) => {
            events.push({ channel, diff: diffAgain });
          });
          assert.equal(
            events.length,
            1,
            `expected no extra diff event after recapturing unchanged content, got: ${JSON.stringify(events)}`,
          );
        });
      },
    );
    completedScenarios.push(
      "page snapshots emit diffs for changed content on the same normalized URL",
    );

    await runScenario(
      "page snapshots keep distinct baselines for query-driven search pages",
      async () => {
        const searchBase = `${harness.baseUrl}/search-diff`;
        await withTab(`${searchBase}?q=alpha`, async (tab) => {
          const wc = tab.view.webContents;
          const events: Array<{ channel: string; diff: unknown }> = [];

          assert.notEqual(
            buildPageSnapshotKey(`${searchBase}?q=alpha`),
            buildPageSnapshotKey(`${searchBase}?q=beta`),
          );

          await capturePageSnapshot(wc.getURL(), wc, (channel, diff) => {
            events.push({ channel, diff });
          });
          assert.equal(events.length, 0);

          await wc.loadURL(`${searchBase}?q=beta`);
          await waitForLoad(wc, 8000);
          await capturePageSnapshot(wc.getURL(), wc, (channel, diff) => {
            events.push({ channel, diff });
          });

          assert.equal(
            events.length,
            0,
            `expected no diff between distinct query baselines, got: ${JSON.stringify(events)}`,
          );
        });
      },
    );
    completedScenarios.push(
      "page snapshots keep distinct baselines for query-driven search pages",
    );

    await runScenario(
      "page diff observer catches same-page DOM mutations",
      async () => {
        await withTab(`${harness.baseUrl}/same-page-action`, async (tab) => {
          const wc = tab.view.webContents;
          const events: Array<{ channel: string; diff: unknown }> = [];

          const onDirty = (event: Electron.IpcMainEvent) => {
            if (event.sender !== wc) return;
            schedulePageSnapshotCapture(wc, (channel, diff) => {
              events.push({ channel, diff });
            });
          };

          ipcMain.on(Channels.PAGE_DIFF_DIRTY, onDirty);
          try {
            await capturePageSnapshot(wc.getURL(), wc, (channel, diff) => {
              events.push({ channel, diff });
            });
            assert.equal(events.length, 0);

            const result = await clickElementBySelector(wc, "#update-same-page");
            assert.match(result, /Clicked: Update without navigating/);

            await waitForCondition(() => events.length > 0, 5000);
            assert.equal(events[0]?.channel, Channels.PAGE_CHANGED);

            const diff = events[0]?.diff as {
              hasChanges: boolean;
              changes: Array<{
                section: string;
                before?: string;
                after?: string;
              }>;
            };
            assert.equal(diff.hasChanges, true);

            const titleChange = diff.changes.find(
              (change) => change.section === "title",
            );
            assert.equal(titleChange?.after, "same-page-action-updated");

            const contentChange = diff.changes.find(
              (change) => change.section === "content",
            );
            assert.ok(contentChange, `expected content diff, got: ${JSON.stringify(diff)}`);
            assert.match(contentChange?.before || "", /idle/);
            assert.match(contentChange?.after || "", /updated/);
          } finally {
            ipcMain.removeListener(Channels.PAGE_DIFF_DIRTY, onDirty);
          }
        });
      },
    );
    completedScenarios.push(
      "page diff observer catches same-page DOM mutations",
    );

    await runScenario(
      "trusted Enter key presses trigger focused input handlers",
      async () => {
        await withTab(
          `${harness.baseUrl}/trusted-enter-source`,
          async (tab) => {
            const wc = tab.view.webContents;

            await setElementValue(wc, "#trusted-search", "rtx 4060 ti");
            const result = await pressKey(wc, {
              key: "Enter",
              selector: "#trusted-search",
            });

            assert.match(result, /Pressed key: Enter/);
            await waitForLoad(wc, 8000);
            assert.equal(
              wc.getURL(),
              `${harness.baseUrl}/trusted-enter-result?q=rtx+4060+ti`,
            );
          },
        );
      },
    );
    completedScenarios.push(
      "trusted Enter key presses trigger focused input handlers",
    );

    await runScenario(
      "search prefers the visible desktop search box and nearby button",
      async () => {
        await withTab(`${harness.baseUrl}/search-visibility`, async (tab) => {
          const wc = tab.view.webContents;
          const query = "Intel Core i5-13600KF";

          const result = await searchPage(wc, { query });

          assert.match(result, /via search button/);
          assert.match(result, /Search results snapshot:/);
          assert.match(result, /\*\*Title:\*\* search-visibility-result/);
          assert.equal(
            wc.getURL(),
            `${harness.baseUrl}/search-visibility-result?term=${encodeURIComponent(query)}`,
          );
        });
      },
    );
    completedScenarios.push(
      "search prefers the visible desktop search box and nearby button",
    );

    await runScenario(
      "search does not synthesize a direct URL when the site search UI does not submit",
      async () => {
        await withTab(
          `${harness.baseUrl}/search-no-shortcut`,
          async (tab) => {
            const wc = tab.view.webContents;

            const result = await searchPage(wc, { query: "rtx 5070" });

            assert.match(result, /same page/);
            assert.equal(wc.getURL(), `${harness.baseUrl}/search-no-shortcut`);
            const status = await wc.executeJavaScript(
              `document.getElementById("status")?.textContent || ""`,
            );
            assert.equal(status, "submit-blocked");
          },
        );
      },
    );
    completedScenarios.push(
      "search does not synthesize a direct URL when the site search UI does not submit",
    );

    await runScenario(
      "popup dismissal avoids locale-switch controls",
      async () => {
        await withTab(`${harness.baseUrl}/language-popup`, async (tab) => {
          const wc = tab.view.webContents;

          const result = await dismissPopup(wc);
          const lang = await wc.executeJavaScript(
            "document.documentElement.lang",
          );
          const state = await wc.executeJavaScript(
            "document.getElementById('language-state')?.textContent || ''",
          );

          assert.match(result, /Dismissed popup using "No thanks"/);
          assert.equal(lang, "en");
          assert.equal(state, "English storefront");
        });
      },
    );
    completedScenarios.push("popup dismissal avoids locale-switch controls");

    console.log(
      `\nNavigation regression suite passed against ${harness.baseUrl}\nScenarios: ${completedScenarios.join("; ")}`,
    );
  } finally {
    await harness.close();
  }
}

main()
  .then(async () => {
    process.exitCode = 0;
    await new Promise((resolve) => setTimeout(resolve, 50));
    app.quit();
  })
  .catch((error) => {
    console.error("\nNavigation regression suite failed.");
    console.error(error);
    process.exitCode = 1;
    app.quit();
  });
