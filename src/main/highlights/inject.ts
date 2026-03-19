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
  background: rgba(240, 198, 54, 0.3) !important;
  outline: 2px solid rgba(240, 198, 54, 0.6) !important;
  outline-offset: 1px !important;
  border-radius: 2px !important;
  box-shadow: 0 0 8px rgba(240, 198, 54, 0.3) !important;
  transition: background 0.3s, outline-color 0.3s, box-shadow 0.3s;
}
.__vessel-highlight-text {
  background: rgba(240, 198, 54, 0.3) !important;
  border-bottom: 2px solid #f0c636 !important;
  padding: 1px 2px !important;
  border-radius: 2px !important;
}
.__vessel-highlight-label {
  position: fixed;
  background: #f0c636;
  color: #1a1a1e;
  font-size: 11px;
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  padding: 2px 8px;
  border-radius: 4px;
  z-index: 999999;
  pointer-events: none;
  max-width: min(240px, calc(100vw - 16px));
  white-space: normal;
  line-height: 1.3;
  overflow-wrap: break-word;
  box-shadow: 0 2px 6px rgba(0,0,0,0.3);
  opacity: 0;
  transition: opacity 0.15s ease-in-out;
}
.__vessel-highlight-label.visible {
  opacity: 1;
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
      if (!window.__vesselHighlightLabelManager) {
        var overlap = function(a, b) {
          return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        };
        var manager = {
          rafId: 0,
          observer: null,
          schedule: function() {
            if (manager.rafId) return;
            manager.rafId = window.requestAnimationFrame(function() {
              manager.rafId = 0;
              manager.positionAll();
            });
          },
          positionLabel: function(label) {
            if (!label) return null;
            var anchor = label.__vesselAnchor;
            if (!anchor || !anchor.isConnected) {
              label.classList.remove('visible');
              return null;
            }
            var rect = anchor.getBoundingClientRect();
            var viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
            var viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
            if (!viewportWidth || !viewportHeight || rect.width === 0 && rect.height === 0) {
              label.classList.remove('visible');
              return null;
            }
            var margin = 8;
            var labelWidth = label.offsetWidth || 0;
            var labelHeight = label.offsetHeight || 0;
            var top = rect.top - labelHeight - 6;
            if (top < margin) {
              top = rect.bottom + 6;
            }
            var maxTop = Math.max(margin, viewportHeight - labelHeight - margin);
            top = Math.min(Math.max(margin, top), maxTop);
            var left = Math.min(Math.max(margin, rect.left), Math.max(margin, viewportWidth - labelWidth - margin));
            var visible = rect.bottom >= 0 && rect.top <= viewportHeight && rect.right >= 0 && rect.left <= viewportWidth;
            label.style.top = top + 'px';
            label.style.left = left + 'px';
            if (!visible) label.classList.remove('visible');
            return {
              left: left,
              top: top,
              right: left + labelWidth,
              bottom: top + labelHeight,
              height: labelHeight,
            };
          },
          positionAll: function() {
            var labels = Array.prototype.slice.call(document.querySelectorAll('.__vessel-highlight-label[data-vessel-highlight]'));
            var placed = [];
            labels.forEach(function(label) {
              var box = manager.positionLabel(label);
              if (!box) return;
              for (var i = 0; i < placed.length; i++) {
                if (!overlap(box, placed[i])) continue;
                var adjustedTop = placed[i].bottom + 4;
                var maxTop = Math.max(8, (window.innerHeight || 0) - box.height - 8);
                box.top = Math.min(adjustedTop, maxTop);
                box.bottom = box.top + box.height;
                label.style.top = box.top + 'px';
              }
              placed.push(box);
            });
          },
        };
        window.__vesselHighlightLabelManager = manager;
        window.addEventListener('resize', manager.schedule, { passive: true });
        window.addEventListener('scroll', manager.schedule, true);
        if (window.visualViewport) {
          window.visualViewport.addEventListener('resize', manager.schedule, { passive: true });
          window.visualViewport.addEventListener('scroll', manager.schedule, { passive: true });
        }
        if (window.ResizeObserver) {
          manager.observer = new window.ResizeObserver(function() {
            manager.schedule();
          });
          manager.observer.observe(document.documentElement);
          if (document.body) manager.observer.observe(document.body);
        }
      }
    })()
  `);

  if (resolvedSelector) {
    return wc.executeJavaScript(`
      (function() {
        var el = document.querySelector(${JSON.stringify(resolvedSelector)});
        if (!el) return 'Element not found';
        // Remove any existing badge on this element to avoid duplicates
        document.querySelectorAll('.__vessel-highlight-label[data-vessel-highlight]').forEach(function(b) {
          if (b.__vesselAnchor === el) b.remove();
        });
        el.classList.add('__vessel-highlight');
        el.style.setProperty('background', ${JSON.stringify(c.bg)}, 'important');
        el.style.setProperty('outline-color', ${JSON.stringify(c.solid)}, 'important');
        el.style.setProperty('box-shadow', '0 0 8px ' + ${JSON.stringify(c.glow)}, 'important');
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        var label = ${JSON.stringify(label || "")};
        var badge = null;
        if (label) {
          badge = document.createElement('div');
          badge.className = '__vessel-highlight-label';
          badge.style.background = ${JSON.stringify(c.label)};
          badge.style.color = ${JSON.stringify(c.text)};
          badge.textContent = label;
          badge.setAttribute('data-vessel-highlight', 'true');
          badge.__vesselAnchor = el;
          document.body.appendChild(badge);
          window.__vesselHighlightLabelManager.positionAll();
          el.addEventListener('mouseenter', function() { badge.classList.add('visible'); });
          el.addEventListener('mouseleave', function() { badge.classList.remove('visible'); });
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
        // Remove any existing badges whose text matches to avoid duplicates
        document.querySelectorAll('.__vessel-highlight-label[data-vessel-highlight]').forEach(function(b) {
          if (b.textContent === ${JSON.stringify(label || "")}) b.remove();
        });
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
        var badge = null;
        if (label && firstMark) {
          badge = document.createElement('div');
          badge.className = '__vessel-highlight-label';
          badge.style.background = labelBg;
          badge.style.color = labelText;
          badge.textContent = label;
          badge.setAttribute('data-vessel-highlight', 'true');
          badge.__vesselAnchor = firstMark;
          document.body.appendChild(badge);
          window.__vesselHighlightLabelManager.positionAll();
          var marks = document.querySelectorAll('mark.__vessel-highlight-text[data-vessel-highlight]');
          marks.forEach(function(m) {
            m.addEventListener('mouseenter', function() { if (badge) { badge.__vesselAnchor = m; window.__vesselHighlightLabelManager.positionAll(); badge.classList.add('visible'); } });
            m.addEventListener('mouseleave', function() { if (badge) badge.classList.remove('visible'); });
          });
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
