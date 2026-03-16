import type { WebContents } from "electron";

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
): Promise<string> {
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
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        var label = ${JSON.stringify(label || "")};
        if (label) {
          var badge = document.createElement('div');
          badge.className = '__vessel-highlight-label';
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
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        var count = 0;
        var firstMark = null;
        var node;
        while ((node = walker.nextNode())) {
          var idx = node.textContent.indexOf(searchText);
          if (idx === -1) continue;
          var range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + searchText.length);
          var mark = document.createElement('mark');
          mark.className = '__vessel-highlight-text';
          mark.setAttribute('data-vessel-highlight', 'true');
          range.surroundContents(mark);
          if (!firstMark) firstMark = mark;
          count++;
          if (count >= 20) break;
        }
        if (count === 0) return 'Text not found: ' + searchText.slice(0, 80);
        if (firstMark) firstMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        var label = ${JSON.stringify(label || "")};
        if (label && firstMark) {
          var badge = document.createElement('div');
          badge.className = '__vessel-highlight-label';
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
