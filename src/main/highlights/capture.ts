import type { WebContents } from "electron";
import * as highlightsManager from "./manager";
import { highlightOnPage } from "./inject";

const MAX_HIGHLIGHT_TEXT = 5000;

export interface HighlightCaptureResult {
  success: boolean;
  text?: string;
  id?: string;
  message?: string;
}

/**
 * Capture the current text selection from a WebContents, persist it as a
 * highlight, and visually mark it on the page.
 *
 * Shared by: IPC HIGHLIGHT_CAPTURE handler, TabManager.captureHighlightFromPage,
 * and IPC HIGHLIGHT_SELECTION handler.
 */
export async function captureSelectionHighlight(
  wc: WebContents,
): Promise<HighlightCaptureResult> {
  if (wc.isDestroyed()) {
    return { success: false, message: "Tab is not available" };
  }

  const url = wc.getURL();
  if (!url || url === "about:blank") {
    return { success: false, message: "No page loaded" };
  }

  const selectedText: string = await wc.executeJavaScript(`
    (function() {
      var sel = window.getSelection();
      return sel ? sel.toString().trim() : '';
    })()
  `);

  if (!selectedText) {
    return { success: false, message: "No text selected" };
  }

  return persistHighlight(url, selectedText);
}

/**
 * Persist a known text string as a highlight and visually mark it on the page.
 * Used by HIGHLIGHT_SELECTION (text already extracted in-page by highlight mode).
 */
export async function persistAndMarkHighlight(
  wc: WebContents,
  text: string,
): Promise<HighlightCaptureResult> {
  if (wc.isDestroyed()) {
    return { success: false, message: "Tab is not available" };
  }

  const url = wc.getURL();
  if (!url || url === "about:blank") {
    return { success: false, message: "No page loaded" };
  }

  const result = persistHighlight(url, text);

  // Visual marking in highlight mode is already done in-page by the mouseup
  // handler, so we skip the highlightOnPage call here.
  return result;
}

function persistHighlight(
  url: string,
  text: string,
): HighlightCaptureResult {
  const capped =
    text.length > MAX_HIGHLIGHT_TEXT ? text.slice(0, MAX_HIGHLIGHT_TEXT) : text;

  const highlight = highlightsManager.addHighlight(
    url,
    undefined,
    capped,
    undefined,
    "yellow",
    "user",
  );

  return { success: true, text: capped, id: highlight.id };
}
