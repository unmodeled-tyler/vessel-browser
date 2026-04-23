import assert from "node:assert/strict";
import test from "node:test";

import type { AIMessage, Bookmark, BookmarkFolder } from "../src/shared/types";
import {
  bookmarkMemoryKey,
  buildAndRememberBookmarkContext,
  buildBookmarkContextDraft,
  collectBookmarkConversationCues,
  getBookmarkMemory,
} from "../src/renderer/src/lib/bookmark-context";
import { normalizeBookmarkMetadata } from "../src/main/bookmarks/metadata";

class MemoryStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const bookmark: Bookmark = {
  id: "bookmark-1",
  url: "https://www.newegg.com/p/N82E16814932692",
  title: "RTX 4070 Super",
  note: "Primary GPU candidate for the AI build.",
  folderId: "folder-ai",
  savedAt: "2026-03-20T18:00:00.000Z",
};

const folder: BookmarkFolder = {
  id: "folder-ai",
  name: "AI PC Build",
  summary: "Components and tradeoffs for a fast local AI workstation.",
  createdAt: "2026-03-20T17:00:00.000Z",
};

test("bookmarkMemoryKey normalizes hostnames", () => {
  assert.equal(
    bookmarkMemoryKey("https://www.newegg.com/p/item"),
    "newegg.com",
  );
});

test("collectBookmarkConversationCues pulls recent site-relevant messages", () => {
  const messages: AIMessage[] = [
    { role: "user", content: "Let me compare GPUs on Newegg for this build." },
    {
      role: "assistant",
      content:
        "The RTX 4070 Super is the best fit here because it keeps CUDA performance high without breaking the $1500 total budget.",
    },
    { role: "user", content: "Thanks, now let's look at motherboards." },
  ];

  const cues = collectBookmarkConversationCues(bookmark, messages);
  assert.equal(cues.length, 2);
  assert.match(cues[0], /^Assistant:/);
  assert.match(cues[1], /^You:/);
});

test("buildBookmarkContextDraft keeps the bookmark brief compact and useful", () => {
  const draft = buildBookmarkContextDraft({
    bookmark,
    folder,
    rememberedSummary:
      "You: Compare Newegg GPU options • Assistant: RTX 4070 Super balanced CUDA performance and budget.",
  });

  assert.match(draft, /Saved bookmark context for the next step:/);
  assert.match(draft, /Title: RTX 4070 Super/);
  assert.match(draft, /Folder summary: Components and tradeoffs/);
  assert.match(draft, /Remembered site context:/);
});

test("buildAndRememberBookmarkContext persists a lightweight site memory", () => {
  const storage = new MemoryStorage();
  const messages: AIMessage[] = [
    { role: "user", content: "Newegg had the cleanest 4070 Super listing." },
    {
      role: "assistant",
      content:
        "Keep this Newegg page in mind as the likely GPU pick for the AI build.",
    },
  ];

  const draft = buildAndRememberBookmarkContext({
    bookmark,
    folder,
    messages,
    storage,
  });

  const remembered = getBookmarkMemory(bookmark.url, storage);
  assert.ok(remembered);
  assert.match(remembered!.summary, /Newegg/);
  assert.match(draft, /Remembered site context:/);
});

test("normalizeBookmarkMetadata trims values and drops invalid entries", () => {
  const metadata = normalizeBookmarkMetadata({
    intent: "  expense reporting  ",
    expectedContent: "  monthly receipts  ",
    keyFields: [" receipt_id ", "", 42, "amount"],
    agentHints: {
      team: "  finance  ",
      empty: "   ",
      bad: 123,
      "  ": "ignored",
    },
  });

  assert.deepEqual(metadata, {
    intent: "expense reporting",
    expectedContent: "monthly receipts",
    keyFields: ["receipt_id", "amount"],
    agentHints: {
      team: "finance",
    },
  });
});

test("normalizeBookmarkMetadata returns undefined fields when nothing usable is provided", () => {
  const metadata = normalizeBookmarkMetadata({
    intent: "   ",
    expectedContent: null,
    keyFields: ["   ", 7],
    agentHints: [],
  });

  assert.deepEqual(metadata, {});
});
