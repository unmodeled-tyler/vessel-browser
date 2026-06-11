import type { WebContents } from "electron";
import { selectorHelpersJS } from "../../../shared/dom/selector-helpers-js";
import { buildOverlayInventory, getBlockingOverlaySignature } from "../../content/overlay-inventory";
import { extractContent } from "../../content/extractor";
import { assertSafeURL } from "../../network/url-safety";
import {
  getCartAddedSummary,
  recordProductAddedToCart,
} from "../cart-click-state";
import {
  executePageScript,
  PAGE_SCRIPT_TIMEOUT,
  pageBusyError,
  waitForJsReady,
  logger,
} from "./core";
import { sleep, waitForLoad } from "../../utils/webcontents-utils";

async function getLocaleSnapshot(
  wc: WebContents,
): Promise<{ lang: string; url: string; title: string } | null> {
  const snapshot = await executePageScript<{
    lang?: string;
    url?: string;
    title?: string;
  }>(
    wc,
    `
    (function() {
      return {
        lang:
          document.documentElement?.lang ||
          document.body?.lang ||
          navigator.language ||
          "",
        url: window.location.href || "",
        title: document.title || "",
      };
    })()
  `,
    {
      label: "locale snapshot",
    },
  );

  if (
    !snapshot ||
    snapshot === PAGE_SCRIPT_TIMEOUT ||
    typeof snapshot !== "object"
  ) {
    return null;
  }

  return {
    lang: typeof snapshot.lang === "string" ? snapshot.lang.trim() : "",
    url: typeof snapshot.url === "string" ? snapshot.url : wc.getURL(),
    title: typeof snapshot.title === "string" ? snapshot.title : wc.getTitle(),
  };
}

function primaryLanguageTag(value: string): string {
  return value.trim().toLowerCase().split(/[-_]/)[0] || "";
}

function localeChanged(
  before: { lang: string; url: string; title: string } | null,
  after: { lang: string; url: string; title: string } | null,
): boolean {
  if (!before || !after) return false;
  const beforeLang = primaryLanguageTag(before.lang);
  const afterLang = primaryLanguageTag(after.lang);
  if (beforeLang && afterLang && beforeLang !== afterLang) {
    return true;
  }
  const localeHint =
    /[?&](lang|locale|language|hl)=|\/(ja|jp|en|fr|de|es|it|ko|zh)(\/|$)/i;
  return before.url !== after.url && localeHint.test(after.url);
}

async function restoreLocaleSnapshot(
  wc: WebContents,
  snapshot: { lang: string; url: string; title: string } | null,
): Promise<void> {
  if (!snapshot || wc.isDestroyed()) return;

  try {
    if (typeof wc.canGoBack === "function" && wc.canGoBack()) {
      wc.goBack();
      await waitForLoad(wc, 3000);
      const reverted = await getLocaleSnapshot(wc);
      if (!localeChanged(snapshot, reverted)) {
        return;
      }
    }
  } catch (err) {
    logger.warn("Failed to restore locale via history navigation, trying URL reload fallback:", err);
  }

  if (snapshot.url && snapshot.url !== wc.getURL()) {
    try {
      assertSafeURL(snapshot.url);
      await wc.loadURL(snapshot.url);
      await waitForLoad(wc, 3000);
      return;
    } catch (err) {
      logger.warn("Failed to restore locale via safe URL load, trying page reload fallback:", err);
    }
  }

  if (snapshot.url) {
    try {
      await wc.reload();
      await waitForLoad(wc, 3000);
    } catch (err) {
      logger.warn("Failed to restore locale via page reload:", err);
    }
  }
}


/**
 * Extract a meaningful product name from the page, preferring the main H1
 * or heading over the generic site title. Falls back to the page title if
 * no heading is found.
 */
async function getProductPageTitle(wc: WebContents): Promise<string> {
  try {
    const heading = await executePageScript<string>(
      wc,
      `(function() {
        var h1 = document.querySelector('h1');
        if (h1 && h1.textContent.trim().length > 3 && h1.textContent.trim().length < 200) {
          return h1.textContent.trim();
        }
        var meta = document.querySelector('meta[property="og:title"]');
        if (meta && meta.content && meta.content.trim().length > 3) {
          return meta.content.trim();
        }
        return '';
      })()`,
      { timeoutMs: 800, label: "get product title" },
    );
    if (heading && heading !== PAGE_SCRIPT_TIMEOUT && typeof heading === "string" && heading.length > 0) {
      return heading;
    }
  } catch {
    // Fall through to page title
  }
  return wc.getTitle() || "";
}


export async function buildCartSuccessSuffix(
  wc: WebContents,
  productUrl: string,
  overlayHint?: string | null,
): Promise<string> {
  const productTitle = await getProductPageTitle(wc);
  recordProductAddedToCart(productUrl, productTitle);
  const cartSummary = getCartAddedSummary(productUrl);
  const dismissResult = await tryAutoDismissCartDialog(wc);
  if (dismissResult) {
    return `\nItem added to cart. ${dismissResult}${cartSummary}\nGo back to search results to select the next product.`;
  }

  if (!overlayHint) {
    return cartSummary;
  }

  const dialogActions = await getCartDialogActions(wc);
  const actionsSuffix = dialogActions
    ? `\n${dialogActions}\nClick one of these dialog actions. Do NOT click any other element.`
    : "";
  return `\n${overlayHint}${actionsSuffix}${cartSummary}`;
}


async function tryAutoDismissCartDialog(wc: WebContents): Promise<string | null> {
  try {
    const result = await executePageScript<string>(
      wc,
      `
      (function() {
        var dialog = document.querySelector('[role="dialog"], dialog[open], [role="alertdialog"], [aria-modal="true"]');
        if (!dialog) return null;
        var cs = getComputedStyle(dialog);
        if (cs.display === 'none' || cs.visibility === 'hidden') return null;
        var buttons = dialog.querySelectorAll('button, a[href], [role="button"]');
        var continueBtn = null;
        var closeBtn = null;
        for (var i = 0; i < buttons.length; i++) {
          var label = (buttons[i].getAttribute('aria-label') || buttons[i].textContent || '').trim().toLowerCase();
          if (/continue shopping|keep shopping|back to shopping/.test(label)) { continueBtn = buttons[i]; break; }
          if (/close|dismiss|×/.test(label) && !closeBtn) { closeBtn = buttons[i]; }
        }
        var target = continueBtn || closeBtn;
        if (!target) return null;
        var actionLabel = (target.getAttribute('aria-label') || target.textContent || '').trim();
        if (target.tagName === 'A' && target.href) {
          window.location.href = target.href;
          return "Navigated via: " + actionLabel;
        }
        target.click();
        return "Dismissed dialog via: " + actionLabel;
      })()
      `,
      { timeoutMs: 1500, label: "auto dismiss cart dialog" },
    );

    if (result && result !== PAGE_SCRIPT_TIMEOUT && typeof result === "string") {
      await sleep(500);
      return result;
    }
  } catch (err) {
    logger.warn("Failed to auto-dismiss cart dialog, falling back to dialog actions:", err);
  }
  return null;
}

/**
 * When a cart dialog is open, extract its interactive actions (buttons/links)
 * so the model can act on them without needing to call read_page.
 */
export async function getCartDialogActions(wc: WebContents): Promise<string | null> {
  const result = await executePageScript<{
    found: boolean;
    actions: string[];
  }>(
    wc,
    `
    (function() {
      var dialog = document.querySelector('[role="dialog"], dialog[open], [role="alertdialog"], [aria-modal="true"]');
      if (!dialog) return { found: false, actions: [] };
      var cs = getComputedStyle(dialog);
      if (cs.display === 'none' || cs.visibility === 'hidden') return { found: false, actions: [] };
      var text = (dialog.textContent || '').slice(0, 500).toLowerCase();
      var cartSignals = ['added to cart','added to bag','added to basket',
        'item added','your basket','your cart','your bag',
        'view basket','view cart','continue shopping'];
      var isCart = cartSignals.some(function(s) { return text.indexOf(s) !== -1; });
      if (!isCart) return { found: false, actions: [] };
      var actions = [];
      dialog.querySelectorAll('button, a[href], [role="button"]').forEach(function(el) {
        var cs2 = getComputedStyle(el);
        if (cs2.display === 'none' || cs2.visibility === 'hidden') return;
        var r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 10) return;
        var label = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 80);
        if (!label || label.length < 2) return;
        var href = el.getAttribute('href') || '';
        var sel = el.id ? '#' + el.id
          : el.getAttribute('data-test') ? '[data-test="' + el.getAttribute('data-test') + '"]'
          : el.getAttribute('aria-label') ? '[aria-label="' + el.getAttribute('aria-label') + '"]'
          : null;
        if (sel) actions.push({ label: label, selector: sel, href: href });
      });
      return {
        found: true,
        actions: actions.map(function(a) {
          return '- "' + a.label + '"' + (a.href ? ' → ' + a.href : '') + (a.selector ? ' (selector: ' + a.selector + ')' : '');
        }),
      };
    })()
    `,
    { timeoutMs: 800, label: "get cart dialog actions" },
  );

  if (!result || result === PAGE_SCRIPT_TIMEOUT || !result.found) return null;
  if (result.actions.length === 0) return null;

  return `Available dialog actions:\n${result.actions.join("\n")}`;
}

/**
 * Lightweight post-click check: did a dialog / cart-drawer appear?
 * Runs a small DOM query instead of a full extraction so it stays fast.
 */
export async function detectPostClickOverlay(wc: WebContents): Promise<string | null> {
  const result = await executePageScript<{
    found: boolean;
    label: string;
    cartLike: boolean;
  }>(
    wc,
    `
    (function() {
      var vw = window.innerWidth || document.documentElement.clientWidth;
      var vh = window.innerHeight || document.documentElement.clientHeight;
      var vpArea = Math.max(1, vw * vh);

      function isVis(el) {
        var cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden' &&
          el.getBoundingClientRect().width > 0;
      }

      function hasFixedAncestor(el) {
        var cur = el.parentElement;
        while (cur && cur !== document.body) {
          var ps = getComputedStyle(cur).position;
          if (ps === 'fixed' || ps === 'sticky') return true;
          cur = cur.parentElement;
        }
        return false;
      }

      function effectiveZ(el) {
        var cur = el;
        while (cur && cur !== document.body) {
          var z = parseInt(getComputedStyle(cur).zIndex, 10);
          if (z > 0) return z;
          cur = cur.parentElement;
        }
        return 0;
      }

      function edgePad(r) {
        return r.left <= 24 || r.top <= 24 ||
          r.right >= vw - 24 || r.bottom >= vh - 24;
      }

      var cartPhrases = ['added to cart','added to bag','added to basket',
        'added to your cart','added to your bag','added to your basket'];
      var cartActions = ['view cart','go to cart','continue shopping',
        'keep shopping','checkout','view basket','go to basket'];

      // Phase 1: semantic dialog elements
      var selectors = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
      var candidates = document.querySelectorAll(selectors);
      var hit = null;
      for (var j = 0; j < candidates.length; j++) {
        if (isVis(candidates[j])) { hit = candidates[j]; break; }
      }

      // Phase 2: positioned drawer-like elements
      if (!hit) {
        var els = document.querySelectorAll('*');
        for (var i = 0; i < els.length; i++) {
          var s = getComputedStyle(els[i]);
          if (s.display === 'none' || s.visibility === 'hidden') continue;
          var pos = s.position;
          var isFixed = pos === 'fixed' || pos === 'sticky';
          var isAbs = pos === 'absolute';
          if (!isFixed && !isAbs) continue;
          if (isAbs && !hasFixedAncestor(els[i])) continue;
          if (effectiveZ(els[i]) < 5) continue;
          var r = els[i].getBoundingClientRect();
          var area = (r.width * r.height) / vpArea;
          if (r.width >= 160 && r.height >= 100 && area >= 0.05 && edgePad(r)) {
            hit = els[i]; break;
          }
        }
      }

      // Phase 3: text-based fallback — any positioned element with cart confirmation text
      if (!hit) {
        var els2 = document.querySelectorAll('*');
        for (var k = 0; k < els2.length; k++) {
          var s2 = getComputedStyle(els2[k]);
          if (s2.display === 'none' || s2.visibility === 'hidden') continue;
          var p2 = s2.position;
          if (p2 !== 'fixed' && p2 !== 'sticky' && p2 !== 'absolute') continue;
          var r2 = els2[k].getBoundingClientRect();
          if (r2.width < 120 || r2.height < 80) continue;
          var innerText = (els2[k].textContent || '').slice(0, 500).toLowerCase();
          var hasConfirm = cartPhrases.some(function(ph) { return innerText.indexOf(ph) !== -1; });
          if (hasConfirm) { hit = els2[k]; break; }
        }
      }

      if (!hit) return { found: false, label: '', cartLike: false };
      var text = (hit.textContent || '').slice(0, 500).toLowerCase();
      var cartLike = cartPhrases.concat(cartActions).some(function(s) { return text.indexOf(s) !== -1; });
      var label = (hit.getAttribute('aria-label') || (hit.querySelector('h1,h2,h3,h4') || {}).textContent || '').trim().slice(0, 80);
      return { found: true, label: label, cartLike: cartLike };
    })()
    `,
    { timeoutMs: 800, label: "post-click overlay check" },
  );

  if (!result || result === PAGE_SCRIPT_TIMEOUT || !result.found) return null;

  if (result.cartLike) {
    const desc = result.label ? ` ("${result.label}")` : "";
    return `A cart confirmation dialog appeared${desc}. Call read_page to see available actions — do not click Add to Cart again.`;
  }

  const desc = result.label ? ` ("${result.label}")` : "";
  return `A dialog or overlay appeared${desc}. Call read_page to see available actions.`;
}

export async function dismissPopupWithClick(
  wc: WebContents,
  clickElement: (wc: WebContents, selector: string) => Promise<string>,
): Promise<string> {
  const before = await extractContent(wc);
  const initialBlocking = before.overlays.filter(
    (overlay) => overlay.blocksInteraction,
  ).length;

  // Refuse to dismiss cart confirmation dialogs — the model should interact
  // with the dialog buttons (View Cart, Continue Shopping) instead.
  if (initialBlocking > 0) {
    const overlayText = before.overlays
      .map((o) => [o.label, o.text].filter(Boolean).join(" "))
      .join(" ")
      .toLowerCase();
    const cartSignals = [
      "added to cart",
      "added to bag",
      "added to basket",
      "item added",
      "items in your basket",
      "items in your cart",
      "items in your bag",
      "your basket",
      "your cart",
      "your bag",
      "view basket",
      "view cart",
      "continue shopping",
    ];
    if (cartSignals.some((s) => overlayText.includes(s))) {
      // Instead of refusing, try to click "Continue Shopping" automatically
      const continueResult = await executePageScript<string>(
        wc,
        `
        (function() {
          var dialog = document.querySelector('[role="dialog"], dialog[open], [role="alertdialog"], [aria-modal="true"]');
          if (!dialog) return "Error: dialog not found";
          var buttons = dialog.querySelectorAll('button, a[href], [role="button"]');
          var continueBtn = null;
          var viewCartBtn = null;
          for (var i = 0; i < buttons.length; i++) {
            var label = (buttons[i].getAttribute('aria-label') || buttons[i].textContent || '').trim().toLowerCase();
            if (/continue shopping|keep shopping/.test(label)) { continueBtn = buttons[i]; break; }
            if (/view (basket|cart|bag)|checkout/.test(label) && !viewCartBtn) { viewCartBtn = buttons[i]; }
          }
          var target = continueBtn || viewCartBtn;
          if (!target) return "Error: no dialog action found";
          var actionLabel = (target.getAttribute('aria-label') || target.textContent || '').trim();
          if (target.tagName === 'A' && target.href) {
            window.location.href = target.href;
            return "Clicked: " + actionLabel + " -> " + target.href;
          }
          target.click();
          return "Clicked: " + actionLabel;
        })()
        `,
        { timeoutMs: 1500, label: "cart dialog continue shopping" },
      );

      if (
        continueResult &&
        continueResult !== PAGE_SCRIPT_TIMEOUT &&
        typeof continueResult === "string" &&
        !continueResult.startsWith("Error")
      ) {
        return `Cart confirmation handled: ${continueResult}. Item was already added to your cart.`;
      }

      // Fallback: return refusal with available actions
      const dialogActions = await getCartDialogActions(wc);
      return `Cannot dismiss: this is a cart confirmation dialog. Item is in your cart.${dialogActions ? "\n" + dialogActions + "\nClick one of these instead." : " Use read_page to see dialog actions."}`;
    }
  }

  const initialDormant = before.dormantOverlays.length;
  const initialLocale = await getLocaleSnapshot(wc);

  const candidates = await executePageScript<
    Array<{ selector: string; label?: string; score: number }>
  >(
    wc,
    `
    (function() {
      function text(value) {
        const trimmed = value == null ? "" : String(value).trim();
        return trimmed || "";
      }

      ${selectorHelpersJS(["data-testid", "data-test", "aria-label", "name", "title"])}

      function isVisible(el) {
        if (!(el instanceof HTMLElement)) return true;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
          return false;
        }
        if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      function overlayRoots() {
        const nodes = [];
        document.querySelectorAll("dialog, [role='dialog'], [role='alertdialog'], [aria-modal='true']").forEach((el) => {
          if (isVisible(el)) nodes.push(el);
        });
        // Detect known consent manager containers by ID/class patterns
        document.querySelectorAll("#onetrust-consent-sdk, #onetrust-banner-sdk, [id*='onetrust'], [class*='onetrust'], #CybotCookiebotDialog, #truste-consent-track, [id*='cookie-banner'], [id*='consent-banner'], [class*='cookie-consent'], [class*='consent-banner'], [id*='gdpr'], [class*='gdpr']").forEach((el) => {
          if (el instanceof HTMLElement && isVisible(el)) nodes.push(el);
        });
        document.querySelectorAll("body *").forEach((el) => {
          if (!(el instanceof HTMLElement) || !isVisible(el)) return;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const zIndex = Number.parseInt(style.zIndex, 10);
          const coversCenter =
            rect.left <= (window.innerWidth || 0) / 2 &&
            rect.right >= (window.innerWidth || 0) / 2 &&
            rect.top <= (window.innerHeight || 0) / 2 &&
            rect.bottom >= (window.innerHeight || 0) / 2;
          if (
            (style.position === "fixed" || style.position === "sticky") &&
            Number.isFinite(zIndex) &&
            zIndex >= 10 &&
            coversCenter
          ) {
            nodes.push(el);
          }
        });
        return Array.from(new Set(nodes));
      }

      function scoreCandidate(el, rooted) {
        const label = text(
          el.getAttribute("aria-label") ||
            el.getAttribute("title") ||
            el.textContent ||
            el.getAttribute("value"),
        ).toLowerCase();
        const classText = text(typeof el.className === "string" ? el.className : "").toLowerCase();
        const idText = text(el.id).toLowerCase();
        const hrefText = text(el.getAttribute && el.getAttribute("href")).toLowerCase();
        const combined = label + " " + classText + " " + idText + " " + hrefText;
        let score = rooted ? 30 : 0;
        if (/^x$|^×$/.test(label)) score += 120;
        if (/no thanks|no, thanks|not now|maybe later|dismiss|close|skip|cancel|continue without|no thank you|reject|decline/.test(label)) score += 100;
        if (/close|dismiss|modal-close|overlay-close/.test(combined)) score += 90;
        // Known consent manager dismiss/reject buttons get a big boost
        if (/onetrust-close|onetrust-reject|cookie.*close|consent.*close|cookie.*reject|consent.*reject/.test(combined)) score += 110;
        // OneTrust "Accept" is valid for dismissing the banner (user just wants it gone)
        if (/onetrust-accept|cookie.*accept|consent.*accept/.test(combined)) score += 80;
        if (el.getAttribute("aria-label")) score += 20;
        if (/(language|locale|region|country|currency)\b/.test(combined)) score -= 320;
        if (/\b(english|japanese|japan|francais|espanol|deutsch|italiano|portuguese|nihongo)\b/.test(label)) score -= 280;
        if (/\u65e5\u672c\u8a9e|\u4e2d\u6587|\ud55c\uad6d\uc5b4/.test(label)) score -= 280;
        if (/[?&](lang|locale|language|hl)=/.test(hrefText)) score -= 260;
        if (/(^|\\/)(ja|jp|en|fr|de|es|it|ko|zh)(\\/|$)/.test(hrefText)) score -= 220;
        // Penalize general accept/subscribe buttons that aren't consent-related
        if (/accept|continue|submit|sign up|subscribe|join|start|next/.test(label) && !/cookie|consent|onetrust/.test(combined)) score -= 80;
        const rect = el.getBoundingClientRect();
        if (rect.top < 120) score += 10;
        if (rect.right > (window.innerWidth || 0) - 120) score += 15;
        return score;
      }

      const selector = "button, [role='button'], a[href], input[type='button'], input[type='submit'], [aria-label], [title]";
      const results = [];
      const roots = overlayRoots();

      function collect(container, rooted) {
        container.querySelectorAll(selector).forEach((el) => {
          if (!(el instanceof HTMLElement) || !isVisible(el)) return;
          const candidateSelector = selectorFor(el);
          if (!candidateSelector) return;
          var label = text(
            el.getAttribute("aria-label") ||
              el.getAttribute("title") ||
              el.textContent ||
              el.getAttribute("value"),
          );
          // Don't skip empty-label buttons from known consent managers
          if (!label) {
            var idLower = (el.id || "").toLowerCase();
            var classLower = (typeof el.className === "string" ? el.className : "").toLowerCase();
            var combined = idLower + " " + classLower;
            if (/onetrust|consent|cookie|banner|gdpr|trustarc|cookiebot/.test(combined)) {
              label = idLower.includes("accept") ? "Accept cookies"
                : idLower.includes("reject") ? "Reject cookies"
                : idLower.includes("close") || classLower.includes("close") ? "Close"
                : "Consent button";
            } else {
              return;
            }
          }
          results.push({
            selector: candidateSelector,
            label: label.slice(0, 120),
            score: scoreCandidate(el, rooted),
          });
        });
      }

      roots.forEach((root) => collect(root, true));
      if (results.length === 0) {
        collect(document, false);
      }

      const seen = new Set();
      return results
        .filter((candidate) => {
          if (seen.has(candidate.selector)) return false;
          seen.add(candidate.selector);
          return candidate.score > 0;
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
    })()
  `,
    {
      timeoutMs: 2000,
      label: "inspect popup candidates",
    },
  );

  if (candidates === PAGE_SCRIPT_TIMEOUT) {
    return pageBusyError("dismiss_popup");
  }

  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        typeof candidate.selector !== "string"
      ) {
        continue;
      }
      const result = await clickElement(wc, candidate.selector);
      if (result.startsWith("Error:")) continue;
      await sleep(250);
      const postClickLocale = await getLocaleSnapshot(wc);
      if (localeChanged(initialLocale, postClickLocale)) {
        await restoreLocaleSnapshot(wc, initialLocale);
        continue;
      }
      const after = await extractContent(wc);
      const blocking = after.overlays.filter(
        (overlay) => overlay.blocksInteraction,
      ).length;
      if (
        blocking < initialBlocking ||
        (initialBlocking > 0 && blocking === 0)
      ) {
        const label =
          typeof candidate.label === "string" && candidate.label
            ? candidate.label
            : "popup control";
        return `Dismissed popup using "${label}"`;
      }
    }
  }

  wc.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  await sleep(16);
  wc.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await sleep(200);

  const afterEscape = await extractContent(wc);
  const escapeBlocking = afterEscape.overlays.filter(
    (overlay) => overlay.blocksInteraction,
  ).length;
  if (
    escapeBlocking < initialBlocking ||
    (initialBlocking > 0 && escapeBlocking === 0)
  ) {
    return "Dismissed popup with Escape";
  }

  return initialBlocking > 0
    ? "Could not dismiss the blocking popup automatically"
    : initialDormant > 0
      ? `No active blocking popup detected. Found ${initialDormant} dormant consent/modal surface(s) in the DOM, likely geo-gated or inactive in this session.`
      : "No blocking popup detected";
}

function describeOverlayState(
  page: Awaited<ReturnType<typeof extractContent>>,
): {
  inventory: ReturnType<typeof buildOverlayInventory>;
  blocking: number;
  total: number;
  signature: string;
} {
  const inventory = buildOverlayInventory(page);
  return {
    inventory,
    blocking: inventory.filter((overlay) => overlay.blocksInteraction).length,
    total: inventory.length,
    signature: getBlockingOverlaySignature(inventory),
  };
}


/**
 * Try to dismiss consent overlays that live inside iframes (common for
 * Sourcepoint, OneTrust hosted, TrustArc, etc.). Electron's
 * executeJavaScript only runs in the main frame, so we iterate over all
 * child frames looking for accept/dismiss buttons.
 */
async function tryDismissConsentIframe(wc: WebContents): Promise<string | null> {
  try {
    // Check if body is scroll-locked or a consent container is visible — if not, skip
    const hasSignal = await executePageScript<boolean>(
      wc,
      `(function() {
        var bs = window.getComputedStyle(document.body);
        var hs = window.getComputedStyle(document.documentElement);
        if (bs.overflow === 'hidden' || hs.overflow === 'hidden') return true;
        var sels = '#onetrust-consent-sdk, [class*="consent"], [class*="cookie-banner"], [id*="consent"], [id*="sp_message"], .fc-consent-root, [class*="cmp-"]';
        var el = document.querySelector(sels);
        return !!(el && el.offsetHeight > 20);
      })()`,
      { timeoutMs: 1000, label: "iframe-consent-signal" },
    );
    if (!hasSignal || hasSignal === PAGE_SCRIPT_TIMEOUT) return null;

    // Iterate child frames and try to click consent buttons inside them
    const frames = wc.mainFrame.framesInSubtree;
    for (const frame of frames) {
      if (frame === wc.mainFrame) continue; // skip main frame, already handled
      try {
        const result = await frame.executeJavaScript(`
          (function() {
            var selectors = [
              'button[title*="Accept"], button[title*="Agree"], button[title*="OK"]',
              '[class*="accept"], [class*="agree"], [class*="consent-accept"]',
              'button[aria-label*="accept" i], button[aria-label*="agree" i]',
              '.sp_choice_type_11', '.message-component.message-button',
            ];
            // Try selectors first
            for (var i = 0; i < selectors.length; i++) {
              try {
                var els = document.querySelectorAll(selectors[i]);
                for (var j = 0; j < els.length; j++) {
                  var el = els[j];
                  if (!(el instanceof HTMLElement)) continue;
                  var text = (el.textContent || '').trim().toLowerCase();
                  if (/accept|agree|consent|got it|ok|continue|i understand/i.test(text) || el.offsetHeight > 0) {
                    el.click();
                    return 'Clicked iframe consent button: ' + text.slice(0, 60);
                  }
                }
              } catch {
                // Swallow — selector may be invalid or cross-origin frame may block access
              }
            }
            // Text-match fallback on all buttons
            var buttons = document.querySelectorAll('button, [role="button"], a.message-component');
            for (var k = 0; k < buttons.length; k++) {
              var btn = buttons[k];
              var label = (btn.textContent || '').trim().toLowerCase();
              if (/^(accept|agree|accept all|i agree|i accept|ok|got it|allow|continue|yes)$/i.test(label) ||
                  /accept all|agree and|accept & continue|accept and continue/i.test(label)) {
                btn.click();
                return 'Clicked iframe consent button: ' + label.slice(0, 60);
              }
            }
            return null;
          })()
        `);
        if (result) return result;
      } catch {
        // Frame may be cross-origin or destroyed — skip
        continue;
      }
    }
  } catch {
    // framesInSubtree may not be available on older Electron
  }
  return null;
}

type QuickCookieDismissResult =
  | { status: "dismissed"; message: string }
  | { status: "still_visible"; message: string };

async function tryAcceptCookiesQuickly(
  wc: WebContents,
): Promise<QuickCookieDismissResult | typeof PAGE_SCRIPT_TIMEOUT | null> {
  const dismissed = await executePageScript<QuickCookieDismissResult | null>(
    wc,
    `
      (async function() {
        var delay = function(ms) {
          return new Promise(function(resolve) { setTimeout(resolve, ms); });
        };
        var selectorTargets = [
          '#onetrust-accept-btn-handler',
          '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
          '[data-cookiefirst-action="accept"]',
          '.cookie-consent-accept-all',
          '#accept-cookies',
          '.cc-accept',
          '.cc-btn.cc-allow',
          '[aria-label="Accept cookies"]',
          '[aria-label="Accept all cookies"]',
          '[data-testid="cookie-accept"]',
          '[data-testid="consent-accept"]',
          '[data-testid="accept-all"]',
          'button[class*="consent"][class*="accept"]',
          'button[class*="privacy"][class*="accept"]',
          '.fc-cta-consent',
          '#sp_choice_button_accept',
          '.message-component.message-button.no-children.focusable.sp_choice_type_11',
          '[class*="truste"] [class*="accept"]',
          '[id*="consent-accept"]',
          '[class*="cmp-accept"]'
        ];
        var surfaceSelectors = [
          '#onetrust-consent-sdk',
          '#CybotCookiebotDialog',
          '[id*="cookie" i]',
          '[id*="consent" i]',
          '[id*="cmp" i]',
          '[id*="sp_message" i]',
          '[class*="cookie" i]',
          '[class*="consent" i]',
          '[class*="cmp" i]',
          '[class*="sp_message" i]',
          '[class*="truste" i]',
          '[class*="didomi" i]',
          '[data-testid*="cookie" i]',
          '[data-testid*="consent" i]',
          '[aria-label*="cookie" i]',
          '[aria-label*="consent" i]',
          '.fc-consent-root'
        ];
        var actionSelector = [
          'button',
          '[role="button"]',
          'a[role="button"]',
          'a.message-component',
          'input[type="button"]',
          'input[type="submit"]'
        ].join(',');
        var seen = [];

        function normalize(text) {
          return String(text || '').replace(/\\s+/g, ' ').trim();
        }

        function lower(text) {
          return normalize(text).toLowerCase();
        }

        function isElementVisible(el) {
          if (!(el instanceof HTMLElement)) return false;
          var style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          if (Number(style.opacity || '1') < 0.05) return false;
          var rect = el.getBoundingClientRect();
          return rect.width > 2 &&
            rect.height > 2 &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth;
        }

        function elementText(el) {
          if (!(el instanceof HTMLElement)) return '';
          return normalize([
            el.getAttribute('aria-label'),
            el.getAttribute('title'),
            el.getAttribute('value'),
            el.textContent
          ].filter(Boolean).join(' '));
        }

        function looksLikeCookieSurface(el) {
          if (!isElementVisible(el)) return false;
          var text = lower([
            el.getAttribute('aria-label'),
            el.getAttribute('id'),
            el.getAttribute('class'),
            el.textContent
          ].filter(Boolean).join(' ')).slice(0, 1600);
          if (!/(cookie|consent|privacy|tracking|personalise|personalize|advertis|data choices|your choices|cmp|onetrust|truste|didomi)/.test(text)) {
            return false;
          }

          var rect = el.getBoundingClientRect();
          var style = window.getComputedStyle(el);
          var fixedLike = style.position === 'fixed' || style.position === 'sticky';
          var sizeable = rect.width >= Math.min(window.innerWidth * 0.35, 360) && rect.height >= 48;
          var bottomBanner = fixedLike && rect.bottom > window.innerHeight * 0.58 && rect.height >= 64;
          var dialog = el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true';
          var namedSurface = /(cookie|consent|cmp|onetrust|truste|didomi|sp_message)/.test(lower([
            el.getAttribute('id'),
            el.getAttribute('class'),
            el.getAttribute('data-testid')
          ].filter(Boolean).join(' ')));

          return sizeable && (namedSurface || bottomBanner || dialog);
        }

        function cookieSurfaces() {
          var surfaces = [];
          function addSurface(el) {
            if (surfaces.indexOf(el) === -1 && looksLikeCookieSurface(el)) {
              surfaces.push(el);
            }
          }

          for (var i = 0; i < surfaceSelectors.length; i++) {
            try {
              document.querySelectorAll(surfaceSelectors[i]).forEach(addSurface);
            } catch {
              // Ignore unsupported selectors in older page engines.
            }
          }

          document.querySelectorAll('div, section, aside, footer, form, [role="dialog"]').forEach(function(el) {
            if (!(el instanceof HTMLElement)) return;
            var style = window.getComputedStyle(el);
            if (style.position === 'fixed' || style.position === 'sticky' || el.getAttribute('role') === 'dialog') {
              addSurface(el);
            }
          });

          return surfaces;
        }

        function hasCookieSurface() {
          return cookieSurfaces().length > 0;
        }

        function labelScore(label) {
          var text = lower(label);
          if (!text) return 0;
          if (/^(accept all|accept cookies|allow all|allow cookies|accept and continue|accept & continue|agree and continue)$/.test(text)) {
            return 220;
          }
          if (/^(i agree|i accept|agree|accept|allow|ok|okay|got it|continue|yes)$/.test(text)) {
            return 190;
          }
          if (/^(reject all|decline|deny|necessary only|essential only|save preferences|confirm choices|submit preferences)$/.test(text)) {
            return 170;
          }
          if (/\\b(accept all|allow all|accept cookies|allow cookies|accept and continue|accept & continue|agree and continue)\\b/.test(text)) {
            return 160;
          }
          if (/\\b(reject all|save preferences|confirm choices|necessary only|essential only)\\b/.test(text)) {
            return 145;
          }
          if (/^(consent|cookie consent|cookies|privacy|privacy policy|cookie policy|learn more|more information|settings|preferences|manage options|customize|customise)$/.test(text)) {
            return 0;
          }
          return 0;
        }

        function addCandidate(el, source, baseScore) {
          if (!(el instanceof HTMLElement) || seen.indexOf(el) !== -1 || !isElementVisible(el)) return;
          var label = elementText(el);
          var score = labelScore(label);
          if (score <= 0 && baseScore < 160) return;
          seen.push(el);
          candidates.push({
            el: el,
            label: label || source,
            source: source,
            score: baseScore + score
          });
        }

        var beforeHadSurface = hasCookieSurface();
        var candidates = [];

        for (var i = 0; i < selectorTargets.length; i++) {
          try {
            document.querySelectorAll(selectorTargets[i]).forEach(function(el) {
              addCandidate(el, selectorTargets[i], 160);
            });
          } catch {
            // Ignore unsupported selectors in older page engines.
          }
        }

        var surfaces = cookieSurfaces();
        surfaces.forEach(function(surface) {
          surface.querySelectorAll(actionSelector).forEach(function(el) {
            addCandidate(el, 'cookie surface', 120);
          });
        });

        if (beforeHadSurface) {
          document.querySelectorAll(actionSelector).forEach(function(el) {
            addCandidate(el, 'page action', 40);
          });
        }

        candidates.sort(function(a, b) { return b.score - a.score; });

        var tried = 0;
        for (var j = 0; j < Math.min(candidates.length, 8); j++) {
          var candidate = candidates[j];
          tried += 1;
          candidate.el.click();
          await delay(220);
          if (!hasCookieSurface()) {
            return {
              status: 'dismissed',
              message: 'Dismissed cookie banner via: ' + candidate.label.slice(0, 80)
            };
          }
        }

        if (beforeHadSurface || tried > 0) {
          return {
            status: 'still_visible',
            message: tried > 0
              ? 'Cookie consent banner is still visible after trying ' + tried + ' candidate control(s). Try clear_overlays or dismiss_popup.'
              : 'Cookie consent banner appears visible, but no reliable accept/reject button was found. Try clear_overlays or dismiss_popup.'
          };
        }

        return null;
      })()
    `,
    {
      label: "accept cookies",
      timeoutMs: 2200,
      userGesture: true,
    },
  );
  if (dismissed) return dismissed;
  const iframeDismissed = await tryDismissConsentIframe(wc);
  return iframeDismissed
    ? { status: "dismissed", message: iframeDismissed }
    : null;
}

export async function clearOverlaysWithHandlers(
  wc: WebContents,
  strategy: "auto" | "interactive" = "auto",
  handlers: {
    clickOverlayCandidate: (
      wc: WebContents,
      action?: { label?: string; selector?: string },
    ) => Promise<string | null>;
    dismissPopup: (wc: WebContents) => Promise<string>;
  },
): Promise<string> {
  const quickCookieResult = await tryAcceptCookiesQuickly(wc);
  if (quickCookieResult === PAGE_SCRIPT_TIMEOUT) {
    return pageBusyError("clear_overlays");
  }
  if (quickCookieResult?.status === "dismissed") {
    return [
      quickCookieResult.message,
      "Stopped after a lightweight consent pass to keep the page responsive. Re-run only if the banner is still blocking the page.",
    ].join("\n");
  }

  await waitForJsReady(wc, 1500);
  const steps: string[] = [];
  let cleared = 0;
  const maxIterations = 8;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const before = await extractContent(wc);
    const beforeState = describeOverlayState(before);
    const blockingOverlays = beforeState.inventory.filter(
      (overlay) => overlay.blocksInteraction,
    );

    if (blockingOverlays.length === 0) {
      // No blocking overlays in main frame — check for iframe-based consent
      if (cleared === 0) {
        const iframeResult = await tryDismissConsentIframe(wc);
        if (iframeResult) {
          steps.push(`Iframe consent: ${iframeResult}`);
          await sleep(500);
          return steps.join("\n");
        }
        return "No blocking overlays detected";
      }
      steps.push(`Overlays remaining: ${beforeState.total}`);
      steps.push("Page still blocked: false");
      return steps.join("\n");
    }

    const overlay = blockingOverlays[0];
    let actionMessage: string | null = null;

    if (overlay.kind === "cookie_consent") {
      actionMessage = await handlers.clickOverlayCandidate(
        wc,
        overlay.acceptAction || overlay.dismissAction || overlay.actions[0],
      );
    } else if (overlay.kind === "selection_modal") {
      if (!overlay.correctOption?.selector) {
        if (strategy === "interactive") {
          steps.push(
            "Stopped: selection modal needs human judgment because no likely-correct option was detected.",
          );
          steps.push(`Overlays remaining: ${beforeState.total}`);
          steps.push("Page still blocked: true");
          return steps.join("\n");
        }
      } else {
        const optionResult = await handlers.clickOverlayCandidate(
          wc,
          overlay.correctOption,
        );
        if (optionResult) {
          actionMessage = `Selected likely-correct option: ${optionResult}`;
          await sleep(120);
          const submitResult = await handlers.clickOverlayCandidate(
            wc,
            overlay.submitAction || overlay.acceptAction,
          );
          if (submitResult) {
            actionMessage += `\nSubmitted modal: ${submitResult}`;
          }
        }
      }
    }

    if (!actionMessage) {
      actionMessage = `Fallback popup handling: ${await handlers.dismissPopup(wc)}`;
    }

    steps.push(actionMessage);
    if (overlay.kind === "cookie_consent") {
      steps.push(
        "Stopped after a lightweight consent pass to keep the page responsive. Re-run only if the banner is still blocking the page.",
      );
      return steps.join("\n");
    }
    await sleep(250);

    const after = await extractContent(wc);
    const afterState = describeOverlayState(after);
    steps.push(`Overlays remaining: ${afterState.total}`);
    steps.push(`Page still blocked: ${afterState.blocking > 0}`);

    if (afterState.blocking === 0) {
      return steps.join("\n");
    }
    const progressMade =
      afterState.blocking < beforeState.blocking ||
      afterState.total !== beforeState.total ||
      afterState.signature !== beforeState.signature;
    if (progressMade) {
      cleared += 1;
      continue;
    }

    return steps.join("\n");
  }

  return steps.join("\n");
}
