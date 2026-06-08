/**
 * Mock DOMPurify for Node.js test environment.
 *
 * In production, DOMPurify runs in the browser and sanitizes HTML.
 * For tests, we provide a simple implementation that strips tags/attributes
 * not in the production allowlist — close enough to exercise the sanitization
 * path without needing a DOM.
 */

const ALLOWED_TAGS = new Set([
  "a", "blockquote", "br", "code", "div", "em",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr",
  "li", "ol", "p", "pre", "span", "strong",
  "table", "tbody", "td", "th", "thead", "tr", "ul",
]);

const ALLOWED_ATTR = new Set([
  "href", "target", "rel", "data-language", "style", "class",
]);

/**
 * Minimal sanitize: strip disallowed tags and attributes.
 * This is NOT a full HTML sanitizer — it's a test mock that
 * approximates the production DOMPurify behavior.
 */
export function sanitize(html, _opts) {
  // Remove attributes that aren't in the allowlist from all tags
  let result = html.replace(
    /<(\w+)(\s[^>]*)?>/g,
    (match, tag, attrs) => {
      if (!ALLOWED_TAGS.has(tag.toLowerCase())) {
        // Strip the opening tag entirely, but keep content
        return "";
      }
      if (!attrs) return `<${tag}>`;
      // Filter attributes
      const filteredAttrs = attrs
        .replace(/(\w[\w-]*)=(?:"[^"]*"|'[^']*'|\S+)/g, (attrMatch, attrName) => {
          return ALLOWED_ATTR.has(attrName.toLowerCase()) ? attrMatch : "";
        })
        .trim();
      return filteredAttrs ? `<${tag} ${filteredAttrs}>` : `<${tag}>`;
    },
  );

  // Remove closing tags for disallowed tags
  result = result.replace(
    /<\/(\w+)>/g,
    (_, tag) => (ALLOWED_TAGS.has(tag.toLowerCase()) ? `</${tag}>` : ""),
  );

  return result;
}

export default { sanitize };