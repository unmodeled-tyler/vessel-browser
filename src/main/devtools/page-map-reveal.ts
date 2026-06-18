import type { DevToolsPageMapRevealStatus } from "../../shared/devtools-types";
import type { TabManager } from "../tabs/tab-manager";

// Ephemeral "inspect" overlay injected into the page when a Page Map row is
// clicked. The selector is JSON-spliced into the placeholder at call time so
// selector text cannot break out of the injected script.
const REVEAL_SCRIPT = `
(function () {
  var selector = __SELECTOR_JSON__;
  try {
    var el = document.querySelector(selector);
  } catch (e) {
    return "invalid-selector";
  }
  if (!el) return "not-found";
  try {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  } catch (e) {}
  var rect = el.getBoundingClientRect();
  var overlay = document.createElement("div");
  overlay.setAttribute("data-vessel-devtools-reveal", "");
  overlay.style.cssText = [
    "position: fixed",
    "left: " + rect.left + "px",
    "top: " + rect.top + "px",
    "width: " + rect.width + "px",
    "height: " + rect.height + "px",
    "box-sizing: border-box",
    "border: 2px solid #4f8cff",
    "background: rgba(79, 140, 255, 0.18)",
    "border-radius: 4px",
    "pointer-events: none",
    "z-index: 2147483647",
    "transition: opacity 250ms ease-out",
    "opacity: 1",
  ].join("; ");
  document.documentElement.appendChild(overlay);
  var start = performance.now();
  function track(now) {
    var r = el.getBoundingClientRect();
    overlay.style.left = r.left + "px";
    overlay.style.top = r.top + "px";
    overlay.style.width = r.width + "px";
    overlay.style.height = r.height + "px";
    if (now - start < 1000) {
      requestAnimationFrame(track);
    } else {
      overlay.style.opacity = "0";
      setTimeout(function () {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }, 300);
    }
  }
  requestAnimationFrame(track);
  return "revealed";
})();
`;

/**
 * Scroll a page-map element into view and flash a transient outline on it.
 * Used by the Page Map tab so a human can locate an element by clicking its
 * row. Pure side-effect: does not re-snapshot the page map.
 */
export async function revealPageMapElement(
  tabManager: TabManager,
  selector: string,
): Promise<DevToolsPageMapRevealStatus> {
  const tab = tabManager.getActiveTab();
  if (!tab || tab.view.webContents.isDestroyed()) {
    return "no-active-tab";
  }
  try {
    const script = REVEAL_SCRIPT.replace(
      "__SELECTOR_JSON__",
      JSON.stringify(selector),
    );
    const result = await tab.view.webContents.executeJavaScript(script, true);
    if (
      result === "revealed" ||
      result === "not-found" ||
      result === "invalid-selector"
    ) {
      return result;
    }
    return "revealed";
  } catch {
    return "invalid-selector";
  }
}
