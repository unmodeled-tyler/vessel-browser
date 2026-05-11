import type { WebContents } from "electron";
import type { StoredHighlight } from "../../shared/types";

export interface LivePageHighlight {
  text: string;
  color?: string;
  persisted: boolean;
}

export interface LiveHighlightSnapshot {
  activeSelection?: string;
  pageHighlights: LivePageHighlight[];
}

type RawLiveHighlightSnapshot = {
  activeSelection?: string;
  pageHighlights?: Array<{
    text?: string;
    color?: string;
  }>;
};

function normalizeText(text: string | undefined): string {
  return text?.trim() ?? "";
}

export async function captureLiveHighlightSnapshot(
  wc: WebContents,
  savedHighlights: StoredHighlight[] = [],
): Promise<LiveHighlightSnapshot> {
  if (wc.isDestroyed()) {
    return { pageHighlights: [] };
  }

  const savedTexts = new Set(
    savedHighlights.map((highlight) => normalizeText(highlight.text)).filter(Boolean),
  );

  try {
    const snapshot = (await wc.executeJavaScript(`(() => {
      const selection = window.getSelection?.()?.toString().trim() || "";
      const pageHighlights = Array.from(
        document.querySelectorAll("mark.__vessel-highlight-text[data-vessel-highlight]")
      ).map((mark) => {
        const text =
          mark.getAttribute("data-vessel-highlight-text")?.trim() ||
          mark.textContent?.trim() ||
          "";
        const style = window.getComputedStyle(mark);
        return {
          text,
          color: style.borderBottomColor || style.backgroundColor || undefined,
        };
      });

      return {
        activeSelection: selection || undefined,
        pageHighlights,
      };
    })()`, true)) as RawLiveHighlightSnapshot;

    const seen = new Set<string>();
    const pageHighlights = (snapshot.pageHighlights ?? [])
      .map((highlight) => ({
        text: normalizeText(highlight.text),
        color: highlight.color?.trim() || undefined,
      }))
      .filter((highlight) => highlight.text.length > 0)
      .filter((highlight) => {
        const key = `${highlight.text}\u0000${highlight.color ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((highlight) => ({
        ...highlight,
        persisted: savedTexts.has(highlight.text),
      }));

    const activeSelection = normalizeText(snapshot.activeSelection) || undefined;
    return { activeSelection, pageHighlights };
  } catch {
    return { pageHighlights: [] };
  }
}

export function formatLiveSelectionSection(
  snapshot: LiveHighlightSnapshot,
): string | null {
  const sections: string[] = [];

  if (snapshot.activeSelection) {
    const preview =
      snapshot.activeSelection.length > 400
        ? `${snapshot.activeSelection.slice(0, 397)}...`
        : snapshot.activeSelection;
    sections.push(
      `## Active User Selection\nThe user currently has this text selected on screen:\n- "${preview}"`,
    );
  }

  if (snapshot.pageHighlights.length > 0) {
    const lines = snapshot.pageHighlights.map((highlight) => {
      const preview =
        highlight.text.length > 180
          ? `${highlight.text.slice(0, 177)}...`
          : highlight.text;
      const details = [
        highlight.persisted ? "saved" : "visible only",
        highlight.color ? `color: ${highlight.color}` : "",
      ].filter(Boolean);
      return `- "${preview}"${details.length ? ` (${details.join(", ")})` : ""}`;
    });
    sections.push(
      [
        "## Visible Highlights On Screen",
        "These are the highlighted passages currently visible in the page. Treat this as authoritative before searching or inspecting:",
        lines.join("\n"),
      ].join("\n"),
    );
  }

  return sections.length > 0 ? sections.join("\n\n") : null;
}
