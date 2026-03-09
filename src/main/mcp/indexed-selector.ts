import type { InteractiveElement, PageContent } from "../../shared/types";

function selectorFromElement(
  element: Pick<InteractiveElement, "index" | "selector">,
  index: number,
): string | null {
  return element.index === index && typeof element.selector === "string"
    ? element.selector
    : null;
}

export function findSelectorByIndex(
  page: PageContent,
  index: number,
): string | null {
  for (const element of page.navigation) {
    const selector = selectorFromElement(element, index);
    if (selector) return selector;
  }

  for (const element of page.interactiveElements) {
    const selector = selectorFromElement(element, index);
    if (selector) return selector;
  }

  for (const form of page.forms) {
    for (const field of form.fields) {
      const selector = selectorFromElement(field, index);
      if (selector) return selector;
    }
  }

  return null;
}
