import http from "node:http";
import type { AddressInfo } from "node:net";

export interface NavigationHarness {
  baseUrl: string;
  close: () => Promise<void>;
}

function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body>
    <nav>
      <a href="/">Home</a>
      <a href="/anchor-source">Anchor test</a>
      <a href="/offscreen-anchor-source">Offscreen anchor</a>
      <a href="/js-source">JS test</a>
      <a href="/obstructed-anchor-source">Obstructed anchor</a>
      <a href="/blank-anchor-source">Target blank</a>
      <a href="/window-open-source">Window open</a>
      <a href="/get-form">GET form</a>
      <a href="/post-form">POST form</a>
      <a href="/external-submit">External submit</a>
      <a href="/same-page-action">Same-page action</a>
      <a href="/trusted-enter-source">Trusted Enter</a>
    </nav>
    <main>
      ${body}
    </main>
  </body>
</html>`;
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendHtml(
  res: http.ServerResponse,
  html: string,
  statusCode = 200,
): void {
  res.writeHead(statusCode, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function sendRedirect(
  res: http.ServerResponse,
  location: string,
  statusCode = 303,
): void {
  res.writeHead(statusCode, { location });
  res.end();
}

export async function createNavigationHarnessServer(): Promise<NavigationHarness> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const method = (req.method || "GET").toUpperCase();

    if (method === "GET" && url.pathname === "/") {
      sendHtml(
        res,
        renderPage(
          "home",
          `
            <h1>Vessel MCP Navigation Test Home</h1>
            <p>Use the links above to exercise anchor clicks, JS redirects, and form submissions.</p>
          `,
        ),
      );
      return;
    }

    if (method === "GET" && url.pathname === "/anchor-source") {
      sendHtml(
        res,
        renderPage(
          "anchor-source",
          `
            <h1>Anchor Source</h1>
            <a id="go-anchor" href="/anchor-dest">Go to Anchor Dest</a>
          `,
        ),
      );
      return;
    }

    if (method === "GET" && url.pathname === "/anchor-dest") {
      sendHtml(
        res,
        renderPage(
          "anchor-dest",
          `
            <h1>Anchor Dest</h1>
            <p>Reached the anchor destination.</p>
          `,
        ),
      );
      return;
    }

    if (method === "GET" && url.pathname === "/offscreen-anchor-source") {
      sendHtml(
        res,
        renderPage(
          "offscreen-anchor-source",
          `
            <h1>Offscreen Anchor Source</h1>
            <p>The target link starts below the fold and should be auto-scrolled before clicking.</p>
            <div style="height: 1600px;"></div>
            <a id="go-offscreen-anchor" href="/anchor-dest">Go to Anchor Dest</a>
          `,
        ),
      );
      return;
    }

    if (method === "GET" && url.pathname === "/js-source") {
      sendHtml(
        res,
        renderPage(
          "js-source",
          `
            <h1>JS Source</h1>
            <button id="go-js" type="button" onclick="window.location.href='/js-dest'">Go to JS Dest</button>
          `,
        ),
      );
      return;
    }

    if (method === "GET" && url.pathname === "/js-dest") {
      sendHtml(
        res,
        renderPage(
          "js-dest",
          `
            <h1>JS Dest</h1>
            <p>Reached the JS destination.</p>
          `,
        ),
      );
      return;
    }

    if (method === "GET" && url.pathname === "/obstructed-anchor-source") {
      sendHtml(
        res,
        renderPage(
          "obstructed-anchor-source",
          `
            <h1>Obstructed Anchor Source</h1>
            <p>The visible link is covered by a transparent overlay that steals pointer clicks.</p>
            <div style="position: relative; width: 320px; height: 72px;">
              <a
                id="go-obstructed-anchor"
                href="/anchor-dest"
                style="position: absolute; inset: 0; display: flex; align-items: center; padding: 0 16px; background: #eef3ff; color: #17325c; text-decoration: none;"
              >
                Go to Anchor Dest Through Overlay
              </a>
              <div
                aria-hidden="true"
                style="position: absolute; inset: 0; background: rgba(255, 255, 255, 0.01); z-index: 2;"
              ></div>
            </div>
          `,
        ),
      );
      return;
    }

    if (method === "GET" && url.pathname === "/blank-anchor-source") {
      sendHtml(
        res,
        renderPage(
          "blank-anchor-source",
          `
            <h1>Target Blank Source</h1>
            <a id="go-blank-anchor" href="/anchor-dest" target="_blank" rel="noopener noreferrer">
              Open Anchor Dest In New Tab
            </a>
          `,
        ),
      );
      return;
    }

    if (method === "GET" && url.pathname === "/window-open-source") {
      sendHtml(
        res,
        renderPage(
          "window-open-source",
          `
            <h1>Window Open Source</h1>
            <button
              id="go-window-open"
              type="button"
              onclick="window.open('/js-dest', '_blank', 'noopener')"
            >
              Open JS Dest In New Tab
            </button>
          `,
        ),
      );
      return;
    }

    if (method === "GET" && url.pathname === "/get-form") {
      sendHtml(
        res,
        renderPage(
          "get-form",
          `
            <h1>GET Form</h1>
            <form id="search" action="/get-result" method="GET">
              <label>Query <input name="q" /></label>
              <button id="submit-get" type="submit">Submit GET</button>
            </form>
          `,
        ),
      );
      return;
    }

    if (method === "GET" && url.pathname === "/get-result") {
      const value = url.searchParams.get("q") || "";
      sendHtml(
        res,
        renderPage(
          "get-result",
          `
            <h1>GET Result</h1>
            <p id="get-value">${value}</p>
          `,
        ),
      );
      return;
    }

    if (method === "GET" && url.pathname === "/post-form") {
      sendHtml(
        res,
        renderPage(
          "post-form",
          `
            <h1>POST Form</h1>
            <form id="post-search" action="/post-result" method="POST">
              <label>Query <input name="q" /></label>
              <button id="submit-post" type="submit">Submit POST</button>
            </form>
          `,
        ),
      );
      return;
    }

    if (method === "POST" && url.pathname === "/post-result") {
      const body = await readRequestBody(req);
      const params = new URLSearchParams(body);
      const target = new URL("/post-result", "http://127.0.0.1");
      if (params.get("q")) {
        target.searchParams.set("q", params.get("q") || "");
      }
      sendRedirect(res, `${target.pathname}${target.search}`);
      return;
    }

    if (method === "GET" && url.pathname === "/post-result") {
      const value = url.searchParams.get("q") || "";
      sendHtml(
        res,
        renderPage(
          "post-result",
          `
            <h1>POST Result</h1>
            <p id="post-value">${value}</p>
          `,
        ),
      );
      return;
    }

    if (method === "GET" && url.pathname === "/external-submit") {
      sendHtml(
        res,
        renderPage(
          "external-submit",
          `
            <h1>External Submit</h1>
            <form id="search" action="/wrong-target" method="GET">
              <label>Wrong <input name="wrong" value="wrong" /></label>
              <button type="submit">Go Bare</button>
            </form>
            <form id="external" action="/external-result" method="GET">
              <label>Topic <input name="topic" /></label>
            </form>
            <button id="external-submit-button" form="external">External Bare Submit</button>
          `,
        ),
      );
      return;
    }

    if (method === "GET" && url.pathname === "/external-result") {
      const value = url.searchParams.get("topic") || "";
      sendHtml(
        res,
        renderPage(
          "external-result",
          `
            <h1>External Result</h1>
            <p id="external-value">${value}</p>
          `,
        ),
      );
      return;
    }

    if (method === "GET" && url.pathname === "/same-page-action") {
      sendHtml(
        res,
        renderPage(
          "same-page-action",
          `
            <h1>Same Page Action</h1>
            <p id="status">idle</p>
            <button
              id="update-same-page"
              type="button"
              onclick="
                document.title = 'same-page-action-updated';
                document.getElementById('status').textContent = 'updated';
              "
            >
              Update without navigating
            </button>
          `,
        ),
      );
      return;
    }

    if (method === "GET" && url.pathname === "/trusted-enter-source") {
      sendHtml(
        res,
        renderPage(
          "trusted-enter-source",
          `
            <h1>Trusted Enter Source</h1>
            <label>
              Search
              <input id="trusted-search" name="q" />
            </label>
            <script>
              const input = document.getElementById('trusted-search');
              input?.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' && event.isTrusted) {
                  window.location.href = '/trusted-enter-result?q=' + encodeURIComponent(input.value);
                }
              });
            </script>
          `,
        ),
      );
      return;
    }

    if (method === "GET" && url.pathname === "/trusted-enter-result") {
      const value = url.searchParams.get("q") || "";
      sendHtml(
        res,
        renderPage(
          "trusted-enter-result",
          `
            <h1>Trusted Enter Result</h1>
            <p id="trusted-enter-value">${value}</p>
          `,
        ),
      );
      return;
    }

    sendHtml(
      res,
      renderPage(
        "not-found",
        `
          <h1>Not Found</h1>
          <p>${method} ${url.pathname}</p>
        `,
      ),
      404,
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
