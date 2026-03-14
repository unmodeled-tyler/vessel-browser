import type { WebContents } from "electron";

export interface BookmarkSourceDraft {
  url: string;
  title: string;
  source: "page" | "link" | "explicit";
}

interface ResolveBookmarkSourceOptions {
  explicitUrl?: string;
  explicitTitle?: string;
  resolvedSelector?: string | null;
}

function trimText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function resolveBookmarkSourceDraft(
  wc: WebContents | undefined,
  options: ResolveBookmarkSourceOptions,
): Promise<BookmarkSourceDraft | { error: string }> {
  const explicitUrl = trimText(options.explicitUrl);
  const explicitTitle = trimText(options.explicitTitle);

  if (explicitUrl) {
    return {
      url: explicitUrl,
      title: explicitTitle || explicitUrl,
      source: "explicit",
    };
  }

  if (wc && options.resolvedSelector) {
    const result = await wc.executeJavaScript(`
      (function() {
        const el = document.querySelector(${JSON.stringify(options.resolvedSelector)});
        if (!el) return { error: "Element not found" };

        const anchor =
          el instanceof HTMLAnchorElement ? el : el.closest("a[href]");
        if (!(anchor instanceof HTMLAnchorElement) || !anchor.href) {
          return { error: "Selected element is not a link" };
        }

        const text = String(
          anchor.getAttribute("aria-label") ||
            anchor.getAttribute("title") ||
            anchor.textContent ||
            "",
        ).trim();

        const fallbackTitle = (() => {
          try {
            const url = new URL(anchor.href);
            const tail = url.pathname.replace(/\\/+$/, "").split("/").pop();
            return tail ? decodeURIComponent(tail).replace(/[-_]+/g, " ") : url.hostname;
          } catch {
            return anchor.href;
          }
        })();

        return {
          url: anchor.href,
          title: text || fallbackTitle,
        };
      })()
    `);

    if (!result || typeof result !== "object") {
      return { error: "Could not inspect selected element" };
    }
    if ("error" in result && typeof result.error === "string") {
      return { error: result.error };
    }

    const url = "url" in result && typeof result.url === "string"
      ? result.url.trim()
      : "";
    const title = "title" in result && typeof result.title === "string"
      ? result.title.trim()
      : "";

    if (!url) {
      return { error: "Selected link has no destination URL" };
    }

    return {
      url,
      title: explicitTitle || title || url,
      source: "link",
    };
  }

  const currentUrl = wc?.getURL().trim() || "";
  if (!currentUrl) {
    return { error: "No URL provided and no active page to save" };
  }

  const currentTitle = wc?.getTitle().trim() || currentUrl;
  return {
    url: currentUrl,
    title: explicitTitle || currentTitle || currentUrl,
    source: "page",
  };
}
