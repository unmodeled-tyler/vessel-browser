import type { WebContents } from "electron";
import type { HighlightColor } from "../../shared/types";

interface ColorValues {
  solid: string;
  glow: string;
  bg: string;
  label: string;
  text: string;
}

const HIGHLIGHT_COLORS: Record<string, ColorValues> = {
  yellow: {
    solid: "#f0c636",
    glow: "rgba(240, 198, 54, 0.5)",
    bg: "rgba(240, 198, 54, 0.3)",
    label: "#f0c636",
    text: "#1a1a1e",
  },
  red: {
    solid: "#ef4444",
    glow: "rgba(239, 68, 68, 0.5)",
    bg: "rgba(239, 68, 68, 0.25)",
    label: "#ef4444",
    text: "#ffffff",
  },
  green: {
    solid: "#22c55e",
    glow: "rgba(34, 197, 94, 0.5)",
    bg: "rgba(34, 197, 94, 0.25)",
    label: "#22c55e",
    text: "#1a1a1e",
  },
  blue: {
    solid: "#3b82f6",
    glow: "rgba(59, 130, 246, 0.5)",
    bg: "rgba(59, 130, 246, 0.25)",
    label: "#3b82f6",
    text: "#ffffff",
  },
  purple: {
    solid: "#a855f7",
    glow: "rgba(168, 85, 247, 0.5)",
    bg: "rgba(168, 85, 247, 0.25)",
    label: "#a855f7",
    text: "#ffffff",
  },
  orange: {
    solid: "#f97316",
    glow: "rgba(249, 115, 22, 0.5)",
    bg: "rgba(249, 115, 22, 0.25)",
    label: "#f97316",
    text: "#1a1a1e",
  },
};

function resolveColor(color?: HighlightColor | null): ColorValues {
  return HIGHLIGHT_COLORS[color ?? "yellow"] ?? HIGHLIGHT_COLORS.yellow;
}

export const VESSEL_HIGHLIGHT_CSS = `
.__vessel-highlight {
  outline: 3px solid #f0c636 !important;
  outline-offset: 2px !important;
  box-shadow: 0 0 12px rgba(240, 198, 54, 0.5) !important;
  transition: outline-color 0.3s, box-shadow 0.3s;
}
.__vessel-highlight-text {
  background: rgba(240, 198, 54, 0.3) !important;
  border-bottom: 2px solid #f0c636 !important;
  padding: 1px 2px !important;
  border-radius: 2px !important;
}
.__vessel-highlight-label {
  position: absolute;
  background: #f0c636;
  color: #1a1a1e;
  font-size: 11px;
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  padding: 2px 8px;
  border-radius: 4px;
  z-index: 999999;
  pointer-events: none;
  white-space: nowrap;
  box-shadow: 0 2px 6px rgba(0,0,0,0.3);
}
`;

export async function highlightOnPage(
  wc: WebContents,
  resolvedSelector?: string | null,
  text?: string,
  label?: string,
  durationMs?: number,
  color?: HighlightColor | null,
): Promise<string> {
  const c = resolveColor(color);

  await wc.executeJavaScript(`
    (function() {
      if (!document.getElementById('__vessel-highlight-styles')) {
        var s = document.createElement('style');
        s.id = '__vessel-highlight-styles';
        s.textContent = ${JSON.stringify(VESSEL_HIGHLIGHT_CSS)};
        document.head.appendChild(s);
      }
    })()
  `);

  if (resolvedSelector) {
    return wc.executeJavaScript(`
      (function() {
        var el = document.querySelector(${JSON.stringify(resolvedSelector)});
        if (!el) return 'Element not found';
        el.classList.add('__vessel-highlight');
        el.style.setProperty('outline-color', ${JSON.stringify(c.solid)}, 'important');
        el.style.setProperty('box-shadow', '0 0 12px ' + ${JSON.stringify(c.glow)}, 'important');
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        var label = ${JSON.stringify(label || "")};
        if (label) {
          var badge = document.createElement('div');
          badge.className = '__vessel-highlight-label';
          badge.style.background = ${JSON.stringify(c.label)};
          badge.style.color = ${JSON.stringify(c.text)};
          badge.textContent = label;
          badge.setAttribute('data-vessel-highlight', 'true');
          document.body.appendChild(badge);
          var rect = el.getBoundingClientRect();
          badge.style.top = (window.scrollY + rect.top - badge.offsetHeight - 4) + 'px';
          badge.style.left = (window.scrollX + rect.left) + 'px';
        }
        var duration = ${durationMs ?? 0};
        if (duration > 0) {
          setTimeout(function() {
            el.classList.remove('__vessel-highlight');
            if (badge) badge.remove();
          }, duration);
        }
        return 'Highlighted: ' + (el.textContent || el.tagName).trim().slice(0, 80);
      })()
    `);
  }

  if (text) {
    return wc.executeJavaScript(`
      (function() {
        var searchText = ${JSON.stringify(text)};
        var solidColor = ${JSON.stringify(c.solid)};
        var bgColor = ${JSON.stringify(c.bg)};
        var labelBg = ${JSON.stringify(c.label)};
        var labelText = ${JSON.stringify(c.text)};
        var SKIP_TAGS = {SCRIPT:1,STYLE:1,NOSCRIPT:1,TEMPLATE:1,IFRAME:1,SVG:1};
        // Collect matching text nodes first, then wrap — avoids TreeWalker
        // seeing newly created nodes from surroundContents and re-matching.
        var textNodes = [];
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode: function(node) {
            var p = node.parentElement;
            if (!p) return NodeFilter.FILTER_REJECT;
            if (SKIP_TAGS[p.tagName]) return NodeFilter.FILTER_REJECT;
            if (p.closest('[data-vessel-highlight]')) return NodeFilter.FILTER_REJECT;
            var style = window.getComputedStyle(p);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return NodeFilter.FILTER_REJECT;
            if (p.offsetWidth === 0 && p.offsetHeight === 0) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
        });
        var node;
        while ((node = walker.nextNode())) {
          var idx = node.textContent.indexOf(searchText);
          if (idx !== -1) {
            textNodes.push({ node: node, idx: idx });
            if (textNodes.length >= 20) break;
          }
        }
        var count = 0;
        var firstMark = null;
        for (var i = 0; i < textNodes.length; i++) {
          var match = textNodes[i];
          try {
            var range = document.createRange();
            range.setStart(match.node, match.idx);
            range.setEnd(match.node, match.idx + searchText.length);
            var mark = document.createElement('mark');
            mark.className = '__vessel-highlight-text';
            mark.style.setProperty('background', bgColor, 'important');
            mark.style.setProperty('border-bottom-color', solidColor, 'important');
            mark.setAttribute('data-vessel-highlight', 'true');
            range.surroundContents(mark);
            if (!firstMark) firstMark = mark;
            count++;
          } catch (_e) {}
        }
        if (count === 0) return 'Text not found: ' + searchText.slice(0, 80);
        if (firstMark) firstMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        var label = ${JSON.stringify(label || "")};
        if (label && firstMark) {
          var badge = document.createElement('div');
          badge.className = '__vessel-highlight-label';
          badge.style.background = labelBg;
          badge.style.color = labelText;
          badge.textContent = label;
          badge.setAttribute('data-vessel-highlight', 'true');
          document.body.appendChild(badge);
          var rect = firstMark.getBoundingClientRect();
          badge.style.top = (window.scrollY + rect.top - badge.offsetHeight - 4) + 'px';
          badge.style.left = (window.scrollX + rect.left) + 'px';
        }
        var duration = ${durationMs ?? 0};
        if (duration > 0) {
          setTimeout(function() {
            document.querySelectorAll('mark.__vessel-highlight-text[data-vessel-highlight]').forEach(function(m) {
              var parent = m.parentNode;
              while (m.firstChild) parent.insertBefore(m.firstChild, m);
              m.remove();
              parent.normalize();
            });
            document.querySelectorAll('.__vessel-highlight-label[data-vessel-highlight]').forEach(function(b) { b.remove(); });
          }, duration);
        }
        return 'Highlighted ' + count + ' occurrence' + (count > 1 ? 's' : '') + ' of: ' + searchText.slice(0, 80);
      })()
    `);
  }

  return "Error: No element or text to highlight";
}

export async function clearHighlights(wc: WebContents): Promise<string> {
  return wc.executeJavaScript(`
    (function() {
      var count = 0;
      document.querySelectorAll('.__vessel-highlight').forEach(function(el) {
        el.classList.remove('__vessel-highlight');
        el.style.removeProperty('outline-color');
        el.style.removeProperty('box-shadow');
        count++;
      });
      document.querySelectorAll('mark.__vessel-highlight-text[data-vessel-highlight]').forEach(function(m) {
        var parent = m.parentNode;
        while (m.firstChild) parent.insertBefore(m.firstChild, m);
        m.remove();
        parent.normalize();
        count++;
      });
      document.querySelectorAll('.__vessel-highlight-label[data-vessel-highlight]').forEach(function(b) { b.remove(); });
      var style = document.getElementById('__vessel-highlight-styles');
      if (style) style.remove();
      return count > 0 ? 'Cleared ' + count + ' highlight' + (count > 1 ? 's' : '') : 'No highlights to clear';
    })()
  `);
}
