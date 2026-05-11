import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_BLOCKED_FRAME_URL,
  getAdBlockDecision,
  hostnameMatches,
  normalizeHostname,
  shouldBlockRequest,
  type AdBlockRequestDetails,
} from "../src/main/network/ad-blocking-rules";

const request = (
  overrides: Partial<AdBlockRequestDetails>,
): AdBlockRequestDetails => ({
  initiator: "https://publisher.example",
  referrer: "https://publisher.example/article",
  resourceType: "script",
  url: "https://cdn.example/script.js",
  ...overrides,
});

test("hostname helpers normalize and match suffixes", () => {
  assert.equal(normalizeHostname(" Example.COM. "), "example.com");
  assert.equal(hostnameMatches("ads.doubleclick.net", "doubleclick.net"), true);
  assert.equal(hostnameMatches("notdoubleclick.net", "doubleclick.net"), false);
});

test("shouldBlockRequest blocks known ad host suffixes", () => {
  assert.equal(
    shouldBlockRequest(request({ url: "https://stats.doubleclick.net/pixel.js" })),
    true,
  );
});

test("shouldBlockRequest blocks third-party ad-like paths", () => {
  assert.equal(
    shouldBlockRequest(request({ url: "https://cdn.example/ads/banner.js" })),
    true,
  );
});

test("shouldBlockRequest allows first-party ad-like paths", () => {
  assert.equal(
    shouldBlockRequest(
      request({
        initiator: "https://publisher.example",
        referrer: "https://publisher.example/article",
        url: "https://publisher.example/ads/site-promo.js",
      }),
    ),
    false,
  );
});

test("shouldBlockRequest treats first-party subdomains as same-site", () => {
  assert.equal(
    shouldBlockRequest(
      request({
        initiator: "https://publisher.example",
        referrer: "https://publisher.example/article",
        url: "https://static.publisher.example/ads/site-promo.js",
      }),
    ),
    false,
  );
});

test("shouldBlockRequest does not treat lookalike domains as first-party", () => {
  assert.equal(
    shouldBlockRequest(
      request({
        initiator: "https://publisher.example",
        referrer: "https://publisher.example/article",
        url: "https://evilpublisher.example/ads/banner.js",
      }),
    ),
    true,
  );
});

test("shouldBlockRequest falls back to initiator when referrer is missing", () => {
  assert.equal(
    shouldBlockRequest(
      request({
        initiator: "https://publisher.example",
        referrer: "",
        url: "https://cdn.example/track/pixel.gif",
      }),
    ),
    true,
  );
});

test("shouldBlockRequest blocks ad-like paths without first-party context", () => {
  assert.equal(
    shouldBlockRequest(
      request({
        initiator: undefined,
        referrer: undefined,
        url: "https://cdn.example/ads/banner.js",
      }),
    ),
    true,
  );
});

test("shouldBlockRequest allows safe paths without first-party context", () => {
  assert.equal(
    shouldBlockRequest(
      request({
        initiator: undefined,
        referrer: undefined,
        url: "https://cdn.example/app.js",
      }),
    ),
    false,
  );
});

test("shouldBlockRequest allows unsupported resource types and non-http protocols", () => {
  assert.equal(shouldBlockRequest(request({ resourceType: "mainFrame" })), false);
  assert.equal(shouldBlockRequest(request({ url: "data:text/javascript,alert(1)" })), false);
  assert.equal(shouldBlockRequest(request({ url: "not a url" })), false);
});

test("getAdBlockDecision redirects blocked sub-frames to the blank marker page", () => {
  assert.deepEqual(
    getAdBlockDecision(
      request({
        resourceType: "subFrame",
        url: "https://ads.doubleclick.net/frame.html",
      }),
    ),
    { redirectURL: EMPTY_BLOCKED_FRAME_URL },
  );
  assert.equal(decodeURIComponent(EMPTY_BLOCKED_FRAME_URL), "data:text/html;charset=utf-8,<!doctype html><html><body><!-- blocked by Vessel ad blocker --></body></html>");
});

test("getAdBlockDecision cancels blocked non-frame resources and explicitly allows safe ones", () => {
  assert.deepEqual(
    getAdBlockDecision(request({ url: "https://ads.doubleclick.net/ad.js" })),
    { cancel: true },
  );
  assert.deepEqual(getAdBlockDecision(request({ url: "https://cdn.example/app.js" })), {
    cancel: false,
  });
});
