export function escapeSelectorValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }

  return value.replace(/["\\]/g, "\\$&");
}

function uniqueSelector(
  document: Document,
  candidate: string | null | undefined,
): string | null {
  if (!candidate) return null;

  try {
    return document.querySelectorAll(candidate).length === 1 ? candidate : null;
  } catch {
    return null;
  }
}

function uniqueAttributeSelector(
  el: Element,
  attribute: string,
): string | null {
  const value = el.getAttribute(attribute)?.trim();
  if (!value) return null;

  const candidate = `${el.tagName.toLowerCase()}[${attribute}="${escapeSelectorValue(value)}"]`;
  return uniqueSelector(el.ownerDocument, candidate);
}

export function generateStableSelector(el: Element): string {
  const document = el.ownerDocument;

  if (el.id) {
    return `#${escapeSelectorValue(el.id)}`;
  }

  for (const attribute of ["data-testid", "name", "form", "aria-label"]) {
    const candidate = uniqueAttributeSelector(el, attribute);
    if (candidate) return candidate;
  }

  const parts: string[] = [];
  let current: Element | null = el;

  while (current) {
    if (current.id) {
      parts.unshift(`#${escapeSelectorValue(current.id)}`);
      break;
    }

    const tag = current.tagName.toLowerCase();
    const parent = current.parentElement;

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

    // Stop as soon as the accumulated path is already unique in the document
    if (uniqueSelector(document, parts.join(" > "))) {
      break;
    }
  }

  return uniqueSelector(document, parts.join(" > ")) || parts.join(" > ");
}
