export type TextTargetMode = "interactive" | "context";

export interface TextTargetMatch {
  selector: string;
  label: string;
  kind: string;
  matchedText: string;
}

export function resolveTextTargetInDocument(
  doc: Document,
  rawQuery: string,
  mode: TextTargetMode,
): TextTargetMatch | null {
  function normalize(value: string | null | undefined): string {
    return String(value || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function text(value: string | null | undefined): string {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function escapeSelectorValue(value: string): string {
    const cssObject = typeof CSS !== "undefined" ? CSS : undefined;
    if (cssObject && typeof cssObject.escape === "function") {
      return cssObject.escape(value);
    }
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function uniqueSelector(candidate: string | null): string | null {
    if (!candidate) return null;
    try {
      return doc.querySelectorAll(candidate).length === 1 ? candidate : null;
    } catch {
      return null;
    }
  }

  function uniqueAttributeSelector(
    el: Element,
    attribute: string,
  ): string | null {
    const value = text(el.getAttribute(attribute));
    if (!value) return null;
    const candidate =
      `${el.tagName.toLowerCase()}[${attribute}="${escapeSelectorValue(value)}"]`;
    return uniqueSelector(candidate);
  }

  function selectorFor(el: Element | null): string | null {
    if (!el) return null;
    const htmlEl = el as HTMLElement;
    if (htmlEl.id) return `#${escapeSelectorValue(htmlEl.id)}`;
    for (const attribute of [
      "data-testid",
      "name",
      "aria-label",
      "title",
      "href",
    ]) {
      const candidate = uniqueAttributeSelector(el, attribute);
      if (candidate) return candidate;
    }

    const parts: string[] = [];
    let current: Element | null = el;
    while (current) {
      const currentEl = current as HTMLElement;
      if (currentEl.id) {
        parts.unshift(`#${escapeSelectorValue(currentEl.id)}`);
        break;
      }
      const parent = current.parentElement;
      const tag = current.tagName.toLowerCase();
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const siblings = Array.from(parent.children).filter(
        (child) => child.tagName === current!.tagName,
      );
      const index = siblings.indexOf(current) + 1;
      parts.unshift(
        siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag,
      );
      current = parent;
    }

    const candidate = parts.join(" > ");
    return uniqueSelector(candidate) || candidate;
  }

  function isVisible(el: Element | null): boolean {
    if (!(el instanceof HTMLElement)) return false;
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
    const style =
      typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
    if (
      style &&
      (style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0")
    ) {
      return false;
    }
    return true;
  }

  function inViewport(el: Element | null): boolean {
    if (!(el instanceof HTMLElement)) return false;
    if (typeof el.getBoundingClientRect !== "function") return true;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return true;
    const vw = window.innerWidth || doc.documentElement?.clientWidth || 0;
    const vh = window.innerHeight || doc.documentElement?.clientHeight || 0;
    return rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
  }

  function labelFor(el: Element): string {
    const htmlEl = el as HTMLElement;
    return (
      text(
        htmlEl.getAttribute("aria-label") ||
          htmlEl.getAttribute("title") ||
          htmlEl.getAttribute("name") ||
          htmlEl.getAttribute("placeholder") ||
          ("value" in htmlEl ? String((htmlEl as HTMLInputElement).value || "") : "") ||
          htmlEl.textContent,
      ) || el.tagName.toLowerCase()
    );
  }

  function contentFor(el: Element): string {
    const ariaLabel = text((el as HTMLElement).getAttribute?.("aria-label"));
    const title = text((el as HTMLElement).getAttribute?.("title"));
    const ownText = text(el.textContent).slice(0, 300);
    return [ariaLabel, title, ownText].filter(Boolean).join(" ");
  }

  function scoreText(query: string, candidate: string): number {
    const normalizedCandidate = normalize(candidate);
    if (!normalizedCandidate) return -1;
    if (normalizedCandidate === query) return 180;
    if (normalizedCandidate.startsWith(query)) return 150;
    if (normalizedCandidate.includes(query)) {
      return 130 - Math.min(30, normalizedCandidate.length - query.length);
    }

    const words = query.split(" ").filter((word) => word.length >= 3);
    if (words.length === 0) return -1;
    const overlap = words.filter((word) => normalizedCandidate.includes(word));
    if (overlap.length === 0) return -1;

    return overlap.length * 18;
  }

  function interactiveBonus(el: Element): number {
    const htmlEl = el as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const label = normalize(labelFor(el));
    let score = 0;
    if (tag === "button") score += 40;
    if (tag === "a") score += 35;
    if (tag === "input") score += 20;
    if (htmlEl.getAttribute("role") === "button") score += 25;
    if (/\b(shop|view|see|explore|browse|open|details|collection|discover)\b/.test(label)) {
      score += 30;
    }
    if (inViewport(el)) score += 25;
    return score;
  }

  function regionBonus(el: Element): number {
    const tag = el.tagName.toLowerCase();
    let score = 0;
    if (/^h[1-4]$/.test(tag)) score += 45;
    if (tag === "section" || tag === "article" || tag === "main") score += 30;
    if ((el as HTMLElement).getAttribute("role") === "heading") score += 35;
    if (inViewport(el)) score += 20;
    return score;
  }

  type Candidate = {
    el: Element;
    score: number;
    matchedText: string;
  };

  function consider(
    best: Candidate | null,
    el: Element,
    score: number,
    matchedText: string,
  ): Candidate | null {
    if (!Number.isFinite(score) || score < 0) return best;
    if (!best || score > best.score) return { el, score, matchedText };
    return best;
  }

  const query = normalize(rawQuery);
  if (!query) return null;

  let bestInteractive: Candidate | null = null;
  const interactiveSelector =
    "a[href], button, [role='button'], input[type='submit'], input[type='button'], input[type='radio'], input[type='checkbox'], select, textarea";

  doc.querySelectorAll(interactiveSelector).forEach((el) => {
    if (!isVisible(el)) return;
    const matchedText = labelFor(el);
    const score =
      scoreText(query, matchedText) +
      scoreText(query, contentFor(el)) +
      interactiveBonus(el);
    bestInteractive = consider(bestInteractive, el, score, matchedText);
  });

  if (mode === "interactive" && bestInteractive && bestInteractive.score >= 120) {
    const selector = selectorFor(bestInteractive.el);
    if (selector) {
      return {
        selector,
        label: labelFor(bestInteractive.el),
        kind: bestInteractive.el.tagName.toLowerCase(),
        matchedText: bestInteractive.matchedText,
      };
    }
  }

  let bestRegion: Candidate | null = null;
  const regionSelector =
    "h1, h2, h3, h4, [role='heading'], section, article, main, aside, li, [data-testid], div";
  let seenRegions = 0;

  doc.querySelectorAll(regionSelector).forEach((el) => {
    if (seenRegions >= 400 || !isVisible(el)) return;
    seenRegions += 1;
    const matchedText = contentFor(el);
    const score = scoreText(query, matchedText) + regionBonus(el);
    bestRegion = consider(bestRegion, el, score, matchedText);
  });

  if (!bestRegion || bestRegion.score < 80) {
    if (mode === "interactive" && bestInteractive) {
      const selector = selectorFor(bestInteractive.el);
      if (!selector) return null;
      return {
        selector,
        label: labelFor(bestInteractive.el),
        kind: bestInteractive.el.tagName.toLowerCase(),
        matchedText: bestInteractive.matchedText,
      };
    }
    return null;
  }

  if (mode === "context") {
    const selector = selectorFor(bestRegion.el);
    if (!selector) return null;
    return {
      selector,
      label: labelFor(bestRegion.el),
      kind: bestRegion.el.tagName.toLowerCase(),
      matchedText: bestRegion.matchedText,
    };
  }

  let regionAction: Candidate | null = null;
  bestRegion.el.querySelectorAll(interactiveSelector).forEach((el) => {
    if (!isVisible(el)) return;
    const matchedText = labelFor(el);
    const score =
      scoreText(query, matchedText) +
      interactiveBonus(el) +
      (bestRegion ? Math.floor(bestRegion.score / 4) : 0);
    regionAction = consider(regionAction, el, score, matchedText);
  });

  const chosen = regionAction || bestInteractive;
  if (!chosen) return null;
  const selector = selectorFor(chosen.el);
  if (!selector) return null;

  return {
    selector,
    label: labelFor(chosen.el),
    kind: chosen.el.tagName.toLowerCase(),
    matchedText: chosen.matchedText,
  };
}
