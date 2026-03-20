import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import process from "node:process";

import { app, BaseWindow } from "electron";

import {
  clickElementBySelector,
  pressKey,
  setElementValue,
  submitFormBySelector,
  waitForLoad,
} from "../src/main/ai/page-actions";
import { Tab } from "../src/main/tabs/tab";
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
