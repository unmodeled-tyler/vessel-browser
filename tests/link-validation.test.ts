import assert from "node:assert/strict";
import http from "node:http";
import test, { after, before } from "node:test";

import { validateLinkDestination } from "../src/main/network/link-validation";

function createServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    if (req.url === "/gone") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    if (req.url === "/head-405-get-404") {
      if (req.method === "HEAD") {
        res.writeHead(405, { allow: "GET" });
        res.end();
        return;
      }

      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    res.writeHead(500, { "content-type": "text/plain" });
    res.end("unexpected");
  });

  return new Promise<{ server: http.Server; baseUrl: string }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to bind test server");
      }
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

let serverInfo: { server: http.Server; baseUrl: string };

before(async () => {
  serverInfo = await createServer();
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    serverInfo.server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

test("validateLinkDestination marks HTTP 200 destinations as live", async () => {
  const result = await validateLinkDestination(`${serverInfo.baseUrl}/ok`);

  assert.equal(result.status, "live");
  assert.equal(result.statusCode, 200);
});

test("validateLinkDestination marks HTTP 404 destinations as dead", async () => {
  const result = await validateLinkDestination(`${serverInfo.baseUrl}/gone`);

  assert.equal(result.status, "dead");
  assert.equal(result.statusCode, 404);
});

test("validateLinkDestination falls back to GET when HEAD is unsupported", async () => {
  const result = await validateLinkDestination(
    `${serverInfo.baseUrl}/head-405-get-404`,
  );

  assert.equal(result.status, "dead");
  assert.equal(result.statusCode, 404);
});
