import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import process from "node:process";

import { app, BaseWindow } from "electron";

import {
  clickElementBySelector,
  setElementValue,
  submitFormBySelector,
  waitForLoad,
} from "../src/main/ai/page-actions";
import { Tab } from "../src/main/tabs/tab";
import { createNavigationHarnessServer } from "./fixtures/navigation-harness";

async function withTab(
  url: string,
  run: (tab: Tab, window: BaseWindow) => Promise<void>,
): Promise<void> {
  const window = new BaseWindow({
    show: false,
    width: 1280,
    height: 900,
    backgroundColor: "#1a1a1e",
  });
  const tab = new Tab(randomUUID(), url, () => {});
  window.contentView.addChildView(tab.view);
  tab.view.setBounds({ x: 0, y: 0, width: 1280, height: 900 });

  try {
    await waitForLoad(tab.view.webContents, 8000);
    await run(tab, window);
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

async function runScenario(name: string, scenario: () => Promise<void>): Promise<void> {
  process.stdout.write(`- ${name}... `);
  await scenario();
  process.stdout.write("ok\n");
}

async function main(): Promise<void> {
  const harness = await createNavigationHarnessServer();
  await app.whenReady();

  try {
    await runScenario("anchor clicks create stable back/forward history", async () => {
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
    });

    await runScenario("JS-driven button navigations survive back/forward", async () => {
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
    });

    await runScenario("GET form submissions preserve custom history", async () => {
      await withTab(`${harness.baseUrl}/get-form`, async (tab) => {
        const wc = tab.view.webContents;

        await setElementValue(wc, 'input[name="q"]', "alpha");
        const result = await submitFormBySelector(wc, "form#search");
        assert.equal(result, `Submitted form via GET -> ${harness.baseUrl}/get-result?q=alpha`);
        assert.equal(wc.getURL(), `${harness.baseUrl}/get-result?q=alpha`);
        assert.equal(tab.canGoBack(), true);

        assert.equal(tab.goBack(), true);
        await waitForLoad(wc, 8000);
        assert.equal(wc.getURL(), `${harness.baseUrl}/get-form`);

        assert.equal(tab.goForward(), true);
        await waitForLoad(wc, 8000);
        assert.equal(wc.getURL(), `${harness.baseUrl}/get-result?q=alpha`);
      });
    });

    await runScenario("POST form submissions preserve custom history", async () => {
      await withTab(`${harness.baseUrl}/post-form`, async (tab) => {
        const wc = tab.view.webContents;

        await setElementValue(wc, 'input[name="q"]', "beta");
        const result = await submitFormBySelector(wc, "form#post-search");
        assert.equal(result, `Submitted form via POST -> ${harness.baseUrl}/post-result?q=beta`);
        assert.equal(wc.getURL(), `${harness.baseUrl}/post-result?q=beta`);
        assert.equal(tab.canGoBack(), true);

        assert.equal(tab.goBack(), true);
        await waitForLoad(wc, 8000);
        assert.equal(wc.getURL(), `${harness.baseUrl}/post-form`);

        assert.equal(tab.goForward(), true);
        await waitForLoad(wc, 8000);
        assert.equal(wc.getURL(), `${harness.baseUrl}/post-result?q=beta`);
      });
    });

    await runScenario("external form-associated submit buttons preserve custom history", async () => {
      await withTab(`${harness.baseUrl}/external-submit`, async (tab) => {
        const wc = tab.view.webContents;

        await setElementValue(wc, 'input[name="topic"]', "gamma");
        const result = await submitFormBySelector(wc, "button[form='external']");
        assert.equal(
          result,
          `Submitted form via GET -> ${harness.baseUrl}/external-result?topic=gamma`,
        );
        assert.equal(wc.getURL(), `${harness.baseUrl}/external-result?topic=gamma`);
        assert.equal(tab.canGoBack(), true);

        assert.equal(tab.goBack(), true);
        await waitForLoad(wc, 8000);
        assert.equal(wc.getURL(), `${harness.baseUrl}/external-submit`);

        assert.equal(tab.goForward(), true);
        await waitForLoad(wc, 8000);
        assert.equal(wc.getURL(), `${harness.baseUrl}/external-result?topic=gamma`);
      });
    });

    console.log(`\nNavigation regression suite passed against ${harness.baseUrl}`);
  } finally {
    await harness.close();
  }
}

main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error("\nNavigation regression suite failed.");
    console.error(error);
    app.exit(1);
  });
