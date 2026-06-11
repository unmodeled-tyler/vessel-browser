import type { WebContents } from "electron";
import { selectorHelpersJS } from "../../../shared/dom/selector-helpers-js";
import { resolveSelector } from "../../utils/selector-resolver";
import {
  sleep,
  waitForLoad,
  waitForPotentialNavigation,
} from "../../utils/webcontents-utils";
import {
  executePageScript,
  loadPermittedUrl,
  PAGE_SCRIPT_TIMEOUT,
  pageBusyError,
  type FillFormFieldInput,
  type FillFormFieldResult,
} from "./core";

function normalizeFieldToken(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function describeFillField(field: FillFormFieldInput): string {
  if (field.selector) return `selector=${field.selector}`;
  if (field.index != null) return `index=${field.index}`;
  if (field.name) return `name=${field.name}`;
  if (field.label) return `label=${field.label}`;
  if (field.placeholder) return `placeholder=${field.placeholder}`;
  return "field";
}

async function resolveFieldSelector(
  wc: WebContents,
  field: FillFormFieldInput,
): Promise<string | null> {
  const directSelector = await resolveSelector(wc, field.index, field.selector);
  if (directSelector) return directSelector;

  const name = normalizeFieldToken(field.name);
  const label = normalizeFieldToken(field.label);
  const placeholder = normalizeFieldToken(field.placeholder);
  if (!name && !label && !placeholder) return null;

  const selector = await executePageScript<string | null>(
    wc,
    `
      (function() {
        function normalize(value) {
          return value == null ? "" : String(value).trim().toLowerCase();
        }

        function text(value) {
          return value == null ? "" : String(value).trim();
        }

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

        ${selectorHelpersJS(["data-testid", "name", "form", "aria-label", "placeholder"])}

        function getLabelText(el) {
          const parts = [];
          if (el.labels) {
            Array.from(el.labels).forEach((labelEl) => {
              const value = text(labelEl.textContent);
              if (value) parts.push(value);
            });
          }
          const ariaLabel = text(el.getAttribute && el.getAttribute("aria-label"));
          if (ariaLabel) parts.push(ariaLabel);
          const labelledBy = text(el.getAttribute && el.getAttribute("aria-labelledby"));
          if (labelledBy) {
            labelledBy.split(/\\s+/).forEach((id) => {
              const ref = document.getElementById(id);
              const value = text(ref && ref.textContent);
              if (value) parts.push(value);
            });
          }
          return normalize(parts.join(" "));
        }

        function scoreField(el) {
          if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
            return -1;
          }
          if (!isVisible(el) || el.disabled || el.getAttribute("aria-disabled") === "true") {
            return -1;
          }

          const normalizedName = normalize(el.getAttribute("name")) || normalize(el.id);
          const normalizedLabel = getLabelText(el);
          const normalizedPlaceholder = normalize(el.getAttribute("placeholder"));
          let score = 0;

          if (${JSON.stringify(name)}) {
            if (normalizedName === ${JSON.stringify(name.toLowerCase())}) score += 120;
            else if (normalizedName.includes(${JSON.stringify(name.toLowerCase())})) score += 70;
          }

          if (${JSON.stringify(label)}) {
            if (normalizedLabel === ${JSON.stringify(label.toLowerCase())}) score += 110;
            else if (normalizedLabel.includes(${JSON.stringify(label.toLowerCase())})) score += 65;
          }

          if (${JSON.stringify(placeholder)}) {
            if (normalizedPlaceholder === ${JSON.stringify(placeholder.toLowerCase())}) score += 105;
            else if (normalizedPlaceholder.includes(${JSON.stringify(placeholder.toLowerCase())})) score += 60;
          }

          if (score === 0) return -1;
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) score += 5;
          return score;
        }

        const candidates = Array.from(document.querySelectorAll("input, textarea, select"));
        let best = null;
        let bestScore = -1;
        for (const el of candidates) {
          const score = scoreField(el);
          if (score > bestScore) {
            best = el;
            bestScore = score;
          }
        }

        return best ? selectorFor(best) : null;
      })()
    `,
    {
      label: "resolve form field",
    },
  );

  return typeof selector === "string" && selector ? selector : null;
}

export async function fillFormFields(
  wc: WebContents,
  fields: FillFormFieldInput[],
): Promise<FillFormFieldResult[]> {
  const results: FillFormFieldResult[] = [];

  for (const field of fields) {
    const selector = await resolveFieldSelector(wc, field);
    if (!selector) {
      results.push({
        field,
        selector: null,
        result: `Skipped: no selector for ${describeFillField(field)}`,
      });
      continue;
    }

    const result = await setElementValue(
      wc,
      selector,
      String(field.value || ""),
    );
    results.push({ field, selector, result });
  }

  return results;
}


export async function setElementValue(
  wc: WebContents,
  selector: string,
  value: string,
): Promise<string> {
  if (selector.startsWith("__vessel_idx:")) {
    const idx = Number(selector.slice("__vessel_idx:".length));
    const result = await executePageScript<string>(
      wc,
      `window.__vessel?.interactByIndex?.(${idx}, "value", ${JSON.stringify(value)}) || "Error: interactByIndex not available"`,
    );
    return result === PAGE_SCRIPT_TIMEOUT
      ? pageBusyError("type_text")
      : result || "Error: interactByIndex not available";
  }
  // Shadow-piercing selector — use interactByIndex-style value setter via __vessel
  if (selector.includes(" >>> ")) {
    const result = await executePageScript<string>(
      wc,
      `
      (function() {
        var el = window.__vessel?.resolveShadowSelector?.(${JSON.stringify(selector)});
        if (!el) return "Error[stale-index]: Shadow DOM element not found — call read_page to refresh.";
        if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return "Error[not-input]: Element is not a fillable input";
        if (el.disabled || el.getAttribute("aria-disabled") === "true") return "Error[disabled]: Input is disabled";
        if (el instanceof HTMLSelectElement) {
          var requested = ${JSON.stringify(value)}.trim().toLowerCase();
          var option = Array.from(el.options).find(function(item) {
            return item.value.trim().toLowerCase() === requested ||
              (item.textContent || "").trim().toLowerCase() === requested;
          });
          if (!option) return "Error[option-not-found]: Option not found";
          el.value = option.value;
          el.focus();
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return "Selected: " + ((option.textContent || option.value).trim().slice(0, 100));
        }
        var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) { desc.set.call(el, ${JSON.stringify(value)}); } else { el.value = ${JSON.stringify(value)}; }
        el.focus();
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return "Typed into: " + (el.getAttribute("aria-label") || el.placeholder || el.name || "input");
      })()
    `,
      {
        label: "type text in shadow input",
      },
    );
    return result === PAGE_SCRIPT_TIMEOUT
      ? pageBusyError("type_text")
      : result || "Error: Could not type into element";
  }
  const result = await executePageScript<string>(
    wc,
    `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'Error[stale-index]: Element not found — the page may have changed. Call read_page to refresh.';
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
        return 'Error[not-input]: Element is not a fillable input';
      }
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
        return 'Error[disabled]: Input is disabled';
      }

      if (el instanceof HTMLSelectElement) {
        const requested = ${JSON.stringify(value)}.trim().toLowerCase();
        const option = Array.from(el.options).find((item) => {
          const label = (item.textContent || '').trim().toLowerCase();
          return label === requested || item.value.trim().toLowerCase() === requested;
        });
        if (!option) {
          return 'Error[option-not-found]: Option not found';
        }
        el.value = option.value;
        el.focus();
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 'Selected: ' + ((option.textContent || option.value).trim().slice(0, 100));
      }

      const prototype = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
      if (descriptor && descriptor.set) {
        descriptor.set.call(el, ${JSON.stringify(value)});
      } else {
        el.value = ${JSON.stringify(value)};
      }

      el.focus();
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        data: ${JSON.stringify(value)},
        inputType: 'insertText',
      }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'Typed into: ' +
        (el.getAttribute('aria-label') || el.placeholder || el.name || 'input') +
        ' = ' + (el.type === 'password' ? '[hidden]' : String(el.value).slice(0, 80));
    })()
  `,
    {
      label: "type text",
    },
  );
  return result === PAGE_SCRIPT_TIMEOUT
    ? pageBusyError("type_text")
    : result || "Error: Could not type into element";
}

export async function typeKeystroke(
  wc: WebContents,
  selector: string,
  value: string,
): Promise<string> {
  const result = await executePageScript<string>(
    wc,
    `
    (async function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'Error[stale-index]: Element not found — the page may have changed. Call read_page to refresh.';
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
        return 'Error[not-input]: Element is not a text input';
      }
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
        return 'Error[disabled]: Input is disabled';
      }
      el.focus();
      const prototype = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
      if (descriptor && descriptor.set) {
        descriptor.set.call(el, '');
      } else {
        el.value = '';
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: '', inputType: 'deleteContentBackward' }));
      const chars = ${JSON.stringify(value)}.split('');
      for (const ch of chars) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
        el.dispatchEvent(new KeyboardEvent('keypress', { key: ch, bubbles: true, cancelable: true }));
        if (descriptor && descriptor.set) {
          descriptor.set.call(el, el.value + ch);
        } else {
          el.value += ch;
        }
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: ch, inputType: 'insertText' }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true, cancelable: true }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'Typed into: ' +
        (el.getAttribute('aria-label') || el.placeholder || el.name || 'input') +
        ' = ' + (el.type === 'password' ? '[hidden]' : String(el.value).slice(0, 80));
    })()
  `,
    {
      timeoutMs: 2000,
      label: "type keystrokes",
    },
  );
  return result === PAGE_SCRIPT_TIMEOUT
    ? pageBusyError("type_text")
    : result || "Error: Could not type into element";
}

export async function hoverElement(
  wc: WebContents,
  selector: string,
): Promise<string> {
  const pos = await wc.executeJavaScript(`
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { error: 'Error[stale-index]: Element not found — the page may have changed. Call read_page to refresh.' };
      if (el instanceof HTMLElement) {
        el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      }
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return { error: 'Error[hidden]: Element has no visible area' };
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      const label = (el.textContent || el.tagName || 'Element').trim().slice(0, 80);
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        label: label,
      };
    })()
  `);

  if (!pos || typeof pos !== "object") return "Error: Could not hover element";
  if ("error" in pos && typeof pos.error === "string") return pos.error;
  const x = typeof pos.x === "number" ? pos.x : null;
  const y = typeof pos.y === "number" ? pos.y : null;
  if (x == null || y == null)
    return "Error: Could not resolve hover coordinates";

  wc.sendInputEvent({ type: "mouseMove", x, y });
  const label = typeof pos.label === "string" ? pos.label : "element";
  return `Hovered: ${label}`;
}

export async function focusElement(
  wc: WebContents,
  selector: string,
): Promise<string> {
  return wc.executeJavaScript(`
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'Error[stale-index]: Element not found — the page may have changed. Call read_page to refresh.';
      if (!(el instanceof HTMLElement)) return 'Error[not-interactive]: Element is not focusable';
      if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
        return 'Error[disabled]: Element is disabled';
      }
      el.focus({ preventScroll: false });
      return 'Focused: ' + (el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 60) || el.tagName.toLowerCase());
    })()
  `);
}

export async function waitForCondition(
  wc: WebContents,
  args: Record<string, unknown>,
): Promise<string> {
  const timeoutMs = Math.max(250, Number(args.timeoutMs) || 5000);
  const selector =
    typeof args.selector === "string" && args.selector.trim()
      ? args.selector.trim()
      : "";
  const text =
    typeof args.text === "string" && args.text.trim() ? args.text.trim() : "";

  if (!selector && !text) {
    return "Error: wait_for requires text or selector";
  }

  // Wait for any pending load to finish first
  if (wc.isLoading()) {
    await waitForLoad(wc, Math.min(timeoutMs, 5000));
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await executePageScript<string>(
      wc,
      `
      (function() {
        var selector = ${JSON.stringify(selector)};
        var text = ${JSON.stringify(text)};
        if (selector) {
          try {
            if (document.querySelector(selector)) return 'selector';
          } catch (e) {
            return 'invalid_selector:' + e.message;
          }
        }
        if (text && document.body && document.body.innerText && document.body.innerText.includes(text)) return 'text';
        return '';
      })()
    `,
      {
        label: "wait_for probe",
      },
    );
    if (result === PAGE_SCRIPT_TIMEOUT) {
      return pageBusyError("wait_for");
    }
    if (result === "selector") {
      return `Matched selector ${selector}`;
    }
    if (result === "text") {
      return `Matched text "${text.slice(0, 80)}"`;
    }
    if (typeof result === "string" && result.startsWith("invalid_selector:")) {
      return `Error: Invalid selector "${selector}" — ${result.slice(17)}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return selector
    ? `Timed out waiting for selector ${selector}`
    : `Timed out waiting for text "${text.slice(0, 80)}"`;
}


export async function selectOption(
  wc: WebContents,
  args: Record<string, unknown>,
): Promise<string> {
  const selector = await resolveSelector(wc, args.index, args.selector);
  if (!selector) return "Error: No select element index or selector provided";

  const result = await executePageScript<string>(
    wc,
    `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!(el instanceof HTMLSelectElement)) {
        return 'Element is not a select dropdown';
      }
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
        return 'Select is disabled';
      }
      const requestedLabel = ${JSON.stringify(args.label || "")}.trim().toLowerCase();
      const requestedValue = ${JSON.stringify(args.value || "")}.trim();
      const option = Array.from(el.options).find((item) => {
        const label = (item.textContent || '').trim().toLowerCase();
        return (requestedLabel && label === requestedLabel) ||
          (requestedValue && item.value === requestedValue);
      });
      if (!option) {
        return 'Option not found';
      }
      el.value = option.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'Selected: ' + ((option.textContent || option.value).trim().slice(0, 100));
    })()
  `,
    {
      label: "select option",
    },
  );
  return result === PAGE_SCRIPT_TIMEOUT
    ? pageBusyError("select_option")
    : result || "Error: Could not select option";
}

export async function submitForm(
  wc: WebContents,
  args: Record<string, unknown>,
): Promise<string> {
  const beforeUrl = wc.getURL();
  let selector = await resolveSelector(wc, args.index, args.selector);

  // If no index/selector provided, find the first visible form on the page
  if (!selector) {
    const discoveredSelector = await executePageScript<string | null>(
      wc,
      `
      (function() {
        var forms = document.querySelectorAll('form');
        for (var i = 0; i < forms.length; i++) {
          var f = forms[i];
          var rect = f.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return 'form';
        }
        return forms.length > 0 ? 'form' : null;
      })()
    `,
      {
        label: "discover form",
      },
    );
    if (discoveredSelector === PAGE_SCRIPT_TIMEOUT) {
      return pageBusyError("submit_form");
    }
    selector = discoveredSelector || null;
    if (!selector) return "Error: No form found on the page";
  }

  // Get form info to determine submission method
  const formInfo = await executePageScript<{
    error?: string;
    found?: boolean;
    method?: string;
    action?: string;
    params?: string;
    submitted?: boolean;
  }>(
    wc,
    `
    (function() {
      const target = document.querySelector(${JSON.stringify(selector)});
      if (!target) return { error: 'Target not found' };
      var form = target instanceof HTMLFormElement ? target : target.closest('form');
      if (!form) {
        const formId = target.getAttribute('form');
        if (formId) {
          const linked = document.getElementById(formId);
          if (linked instanceof HTMLFormElement) form = linked;
        }
      }
      if (!form) return { error: 'No parent form found' };
      function isSubmitControl(el) {
        return (
          (el instanceof HTMLButtonElement &&
            ((el.getAttribute('type') || '').trim().toLowerCase() === '' ||
              el.type === 'submit')) ||
          (el instanceof HTMLInputElement &&
            (el.type === 'submit' || el.type === 'image'))
        );
      }
      const submitter = isSubmitControl(target)
        ? target
        : Array.from(document.querySelectorAll('button, input[type="submit"], input[type="image"]')).find(
            (candidate) => isSubmitControl(candidate) && candidate.form === form,
          );
      if (
        submitter instanceof HTMLElement &&
        (submitter.hasAttribute('disabled') ||
          submitter.getAttribute('aria-disabled') === 'true')
      ) {
        return { error: 'Submit control is disabled' };
      }
      // Collect form data and determine method
      const submitterActionAttr =
        (submitter instanceof HTMLButtonElement ||
          submitter instanceof HTMLInputElement
          ? submitter.getAttribute('formaction')?.trim()
          : '') || '';
      const action = submitterActionAttr
        ? new URL(submitterActionAttr, document.baseURI).toString()
        : form.action || window.location.href;
      const submitterMethodAttr =
        (submitter instanceof HTMLButtonElement ||
          submitter instanceof HTMLInputElement
          ? submitter.getAttribute('formmethod')?.trim()
          : '') || '';
      const method = (
        submitterMethodAttr ||
        form.getAttribute('method') ||
        form.method ||
        'GET'
      ).toUpperCase();
      let fd;

      try {
        fd = submitter instanceof HTMLElement
          ? new FormData(form, submitter)
          : new FormData(form);
      } catch {
        fd = new FormData(form);
      }
      const params = new URLSearchParams();
      for (const [k, v] of fd.entries()) {
        if (typeof v === 'string') params.append(k, v);
      }
      // Use requestSubmit to fire JS submit handlers for all methods
      if (typeof form.requestSubmit === 'function') {
        try {
          if (
            submitter instanceof HTMLButtonElement ||
            submitter instanceof HTMLInputElement
          ) {
            form.requestSubmit(submitter);
          } else {
            form.requestSubmit();
          }
        } catch {
          form.requestSubmit();
        }
        return { submitted: true, method };
      }
      if (submitter instanceof HTMLElement && typeof submitter.click === 'function') {
        submitter.click();
        return { submitted: true, method };
      }
      // Last resort: form.submit() bypasses JS handlers but at least submits
      if (method === 'GET') {
        return { action, method, params: params.toString(), found: true };
      }
      form.submit();
      return { submitted: true, method };
    })()
  `,
    {
      timeoutMs: 2000,
      label: "submit form",
    },
  );

  if (formInfo === PAGE_SCRIPT_TIMEOUT) {
    return pageBusyError("submit_form");
  }
  if (!formInfo || typeof formInfo !== "object") {
    return "Error: Could not inspect form";
  }

  if (formInfo.error) return formInfo.error;

  // Fallback for GET when requestSubmit was unavailable
  if (formInfo.found && formInfo.method === "GET") {
    const url = new URL(formInfo.action);
    if (formInfo.params) {
      url.search = formInfo.params;
    }
    await loadPermittedUrl(wc, url.toString());
    await waitForPotentialNavigation(wc, beforeUrl);
    const afterUrl = wc.getURL();
    return afterUrl !== beforeUrl
      ? `Submitted form via GET -> ${afterUrl}`
      : "Submitted form via GET";
  }

  if (formInfo.submitted) {
    await waitForPotentialNavigation(wc, beforeUrl);
    const afterUrl = wc.getURL();
    if (afterUrl !== beforeUrl) {
      return `Submitted form via ${formInfo.method} -> ${afterUrl}`;
    }

    // Form submitted but URL didn't change — JS-heavy sites like Google
    // intercept requestSubmit. Try pressing Enter on the active input as fallback.
    await executePageScript(
      wc,
      `
      (function() {
        var active = document.activeElement;
        if (!active || active === document.body) {
          var inputs = document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])');
          for (var i = 0; i < inputs.length; i++) {
            if (inputs[i].value) { active = inputs[i]; active.focus(); break; }
          }
        }
        if (active && active !== document.body) {
          active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
          active.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
          active.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
        }
      })()
    `,
      {
        label: "submit form enter fallback",
      },
    );
    // Also send native Enter via Electron input events for sites that listen at the browser level
    wc.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    await new Promise((r) => setTimeout(r, 50));
    wc.sendInputEvent({ type: "keyUp", keyCode: "Return" });

    await waitForPotentialNavigation(wc, beforeUrl, 3000);
    const finalUrl = wc.getURL();
    return finalUrl !== beforeUrl
      ? `Submitted form (Enter fallback) -> ${finalUrl}`
      : `Submitted form via ${formInfo.method} (page may have updated dynamically)`;
  }

  return "Submitted form";
}

export async function pressKeyDirect(
  wc: WebContents,
  key: string,
  index?: number,
  selector?: string,
): Promise<string> {
  return pressKey(wc, { key, index, selector });
}

export async function submitFormDirect(
  wc: WebContents,
  index?: number,
  selector?: string,
): Promise<string> {
  return submitForm(wc, { index, selector });
}

export async function selectOptionDirect(
  wc: WebContents,
  index?: number,
  selector?: string,
  label?: string,
  value?: string,
): Promise<string> {
  return selectOption(wc, { index, selector, label, value });
}

export async function waitForConditionDirect(
  wc: WebContents,
  text?: string,
  selector?: string,
  timeoutMs?: number,
): Promise<string> {
  return waitForCondition(wc, { text, selector, timeoutMs });
}


export async function submitFormBySelector(
  wc: WebContents,
  selector: string,
): Promise<string> {
  return submitForm(wc, { selector });
}


export async function pressKey(
  wc: WebContents,
  args: Record<string, unknown>,
): Promise<string> {
  const key = typeof args.key === "string" ? args.key.trim() : "";
  if (!key) return "Error: No key provided";

  const selector = await resolveSelector(wc, args.index, args.selector);
  const focusResult = await executePageScript<{
    ok?: boolean;
    error?: string;
    label?: string;
  }>(
    wc,
    `
    (function() {
      const selector = ${JSON.stringify(selector)};
      const target =
        selector ? document.querySelector(selector) : document.activeElement;
      if (!target || !(target instanceof HTMLElement)) {
        return { error: selector ? 'Target not found' : 'No focused element' };
      }
      target.focus({ preventScroll: false });
      return {
        ok: true,
        label:
          target.getAttribute('aria-label') ||
          target.getAttribute('name') ||
          target.getAttribute('placeholder') ||
          target.textContent?.trim().slice(0, 60) ||
          target.tagName.toLowerCase(),
      };
    })()
  `,
    {
      label: "focus before key press",
    },
  );
  if (focusResult === PAGE_SCRIPT_TIMEOUT) {
    return pageBusyError("press_key");
  }
  if (!focusResult || typeof focusResult !== "object") {
    return "Error: Could not prepare key press";
  }
  if ("error" in focusResult && typeof focusResult.error === "string") {
    return focusResult.error;
  }

  wc.focus();

  const normalizedKey =
    key.length === 1 ? key : key[0].toUpperCase() + key.slice(1);
  const electronKeyCode =
    normalizedKey === "Enter"
      ? "Return"
      : normalizedKey === "ArrowUp"
        ? "Up"
        : normalizedKey === "ArrowDown"
          ? "Down"
          : normalizedKey === "ArrowLeft"
            ? "Left"
            : normalizedKey === "ArrowRight"
              ? "Right"
              : normalizedKey;

  wc.sendInputEvent({ type: "keyDown", keyCode: electronKeyCode });
  if (key.length === 1) {
    wc.sendInputEvent({ type: "char", keyCode: key });
  }
  await sleep(16);
  wc.sendInputEvent({ type: "keyUp", keyCode: electronKeyCode });

  const label =
    "label" in focusResult && typeof focusResult.label === "string"
      ? focusResult.label
      : null;
  return label ? `Pressed key: ${key} on ${label}` : `Pressed key: ${key}`;
}

