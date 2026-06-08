/**
 * CJS mock for DOMPurify — mirrors dompurify.mjs for require() paths.
 * @see ./dompurify.mjs for documentation.
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

function sanitize(html, _opts) {
  let result = html.replace(
    /<(\w+)(\s[^>]*)?>/g,
    (match, tag, attrs) => {
      if (!ALLOWED_TAGS.has(tag.toLowerCase())) {
        return "";
      }
      if (!attrs) return `<${tag}>`;
      const filteredAttrs = attrs
        .replace(/(\w[\w-]*)=(?:"[^"]*"|'[^']*'|\S+)/g, (attrMatch, attrName) => {
          return ALLOWED_ATTR.has(attrName.toLowerCase()) ? attrMatch : "";
        })
        .trim();
      return filteredAttrs ? `<${tag} ${filteredAttrs}>` : `<${tag}>`;
    },
  );

  result = result.replace(
    /<\/(\w+)>/g,
    (_, tag) => (ALLOWED_TAGS.has(tag.toLowerCase()) ? `</${tag}>` : ""),
  );

  return result;
}

module.exports = { sanitize };
module.exports.default = { sanitize };