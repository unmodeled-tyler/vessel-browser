/**
 * Returns the title, URL, visible headings, in-viewport links/buttons/inputs,
 * and a compact text snapshot of the main content area.
 */
export function getGlanceExtractScript(): string {
  return `(function() {
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    var sy = window.scrollY || window.pageYOffset || 0;

    function inViewport(el) {
      var r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw && r.width > 0 && r.height > 0;
    }

    function label(el) {
      return (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 120);
    }

    // Headings visible on screen
    var headings = [];
    document.querySelectorAll('h1, h2, h3, h4').forEach(function(h) {
      if (!inViewport(h)) return;
      var t = (h.textContent || '').trim();
      if (t && t.length < 200) headings.push(h.tagName.toLowerCase() + ': ' + t);
    });

    // Links visible on screen (deduplicated by text)
    var links = [];
    var seenLinks = {};
    var idx = 1;
    document.querySelectorAll('a[href]').forEach(function(a) {
      if (!inViewport(a)) return;
      var t = (a.textContent || '').trim().slice(0, 100);
      if (!t || t.length < 2 || seenLinks[t]) return;
      seenLinks[t] = true;
      links.push({ text: t, href: (a.href || '').slice(0, 200), index: idx++ });
    });

    // Buttons visible on screen
    var buttons = [];
    document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]').forEach(function(b) {
      if (!inViewport(b)) return;
      var t = label(b);
      if (!t || t.length < 1) return;
      buttons.push({ text: t, index: idx++ });
    });

    // Input fields visible on screen
    var inputs = [];
    document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea').forEach(function(inp) {
      if (!inViewport(inp)) return;
      var type = (inp.type || inp.tagName.toLowerCase() || '').toLowerCase();
      var lbl = (inp.getAttribute('aria-label') || inp.getAttribute('placeholder') || inp.name || '').trim();
      inputs.push({ type: type, label: lbl.slice(0, 80), placeholder: (inp.getAttribute('placeholder') || '').slice(0, 80), index: idx++ });
    });

    // Content snapshot from main content area using textContent (instant, no reflow)
    var roots = ['main', 'article', '[role="main"]', '#content', '.content', '.story-body'];
    var contentRoot = null;
    for (var i = 0; i < roots.length; i++) {
      contentRoot = document.querySelector(roots[i]);
      if (contentRoot && contentRoot.textContent.trim().length > 50) break;
      contentRoot = null;
    }
    var snippet = '';
    if (contentRoot) {
      snippet = contentRoot.textContent.replace(/[ \\t]+/g, ' ').replace(/(\\n\\s*){3,}/g, '\\n\\n').trim().slice(0, 8000);
    } else {
      // Fallback: grab text from visible elements only
      var parts = [];
      document.querySelectorAll('h1, h2, h3, p, li, td, span, div').forEach(function(el) {
        if (parts.length > 100 || !inViewport(el)) return;
        var t = (el.textContent || '').trim();
        if (t.length > 10 && t.length < 500) parts.push(t);
      });
      snippet = parts.join('\\n').slice(0, 8000);
    }

    return {
      title: document.title || '',
      url: location.href,
      headings: headings.slice(0, 20),
      links: links.slice(0, 40),
      buttons: buttons.slice(0, 20),
      inputs: inputs.slice(0, 15),
      contentSnippet: snippet,
      viewportHeight: vh,
      viewportWidth: vw,
      scrollY: Math.round(sy),
    };
  })()`;
}
