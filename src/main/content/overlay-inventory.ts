import type { InteractiveElement, PageContent } from "../../shared/types";

export type OverlayKind =
  | "cookie_consent"
  | "selection_modal"
  | "alert"
  | "cart_confirmation"
  | "drawer"
  | "dialog"
  | "modal"
  | "overlay";

export interface OverlayActionCandidate {
  index?: number;
  label?: string;
  selector?: string;
  role?: string;
  labelSource?: string;
  looksCorrect?: boolean;
}

export interface OverlayInventoryItem {
  type: PageContent["overlays"][number]["type"];
  kind: OverlayKind;
  role?: string;
  label?: string;
  selector?: string;
  text?: string;
  blocksInteraction?: boolean;
  actions: OverlayActionCandidate[];
  radioOptions: OverlayActionCandidate[];
  dismissAction?: OverlayActionCandidate;
  acceptAction?: OverlayActionCandidate;
  submitAction?: OverlayActionCandidate;
  correctOption?: OverlayActionCandidate;
}

const CORRECT_HINT_RE =
  /\b(correct|right choice|this is correct|correct answer|pick this|select this|choose this|right answer)\b/i;
const WRONG_HINT_RE =
  /\b(wrong|incorrect|not this|don't pick|do not pick|bad option|decoy)\b/i;

function elementLabel(el: InteractiveElement): string | undefined {
  return (
    el.text?.trim() ||
    el.label?.trim() ||
    el.value?.trim() ||
    el.placeholder?.trim() ||
    undefined
  );
}

function isOverlayAction(el: InteractiveElement): boolean {
  if (el.type === "button" || el.type === "link") return true;
  if (el.type !== "input") return false;
  return ["button", "submit", "radio", "checkbox"].includes(
    (el.inputType || "").toLowerCase(),
  );
}

function isRadioOption(el: InteractiveElement): boolean {
  return (
    el.role === "radio" ||
    (el.type === "input" && (el.inputType || "").toLowerCase() === "radio")
  );
}

function normalizeAction(el: InteractiveElement): OverlayActionCandidate {
  return {
    index: el.index,
    label: elementLabel(el),
    selector: el.selector,
    role: el.role,
    labelSource: el.labelSource,
    looksCorrect:
      el.looksCorrect !== undefined
        ? el.looksCorrect
        : looksLikeCorrectOption(elementLabel(el)),
  };
}

function normalizeStoredAction(
  action: NonNullable<PageContent["overlays"][number]["actions"]>[number],
): OverlayActionCandidate {
  return {
    label: action.label,
    selector: action.selector,
    role: action.kind === "radio" ? "radio" : undefined,
  };
}

function normalizeStoredRadioOption(
  option: NonNullable<PageContent["overlays"][number]["radioOptions"]>[number],
): OverlayActionCandidate {
  return {
    label: option.label,
    selector: option.selector,
    role: "radio",
    labelSource: option.labelSource,
    looksCorrect:
      option.looksCorrect !== undefined
        ? option.looksCorrect
        : looksLikeCorrectOption(option.label),
  };
}

function dedupeCandidates(
  actions: OverlayActionCandidate[],
): OverlayActionCandidate[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = [
      action.selector || "",
      action.label || "",
      action.role || "",
      action.labelSource || "",
    ].join("::");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function classifyOverlayKind(
  overlay: PageContent["overlays"][number],
  radioOptions: OverlayActionCandidate[],
): OverlayKind {
  if (overlay.kind) {
    return overlay.kind;
  }

  const haystack = [overlay.label, overlay.text, overlay.role]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (
    /cookie|consent|privacy|gdpr|ccpa|onetrust|trustarc|cookiebot/.test(
      haystack,
    )
  ) {
    return "cookie_consent";
  }
  if (radioOptions.length > 0) return "selection_modal";
  if (
    overlay.role === "alertdialog" ||
    /\b(alert|warning|error)\b/.test(haystack)
  ) {
    return "alert";
  }
  if (overlay.type === "dialog") return "dialog";
  if (overlay.type === "modal") return "modal";
  return "overlay";
}

function findAction(
  actions: OverlayActionCandidate[],
  matcher: RegExp,
): OverlayActionCandidate | undefined {
  return actions.find((action) =>
    matcher.test((action.label || "").toLowerCase()),
  );
}

export function looksLikeCorrectOption(label?: string): boolean | undefined {
  const text = label?.trim();
  if (!text) return undefined;
  if (CORRECT_HINT_RE.test(text)) return true;
  if (WRONG_HINT_RE.test(text)) return false;
  return undefined;
}

export function getBlockingOverlaySignature(
  overlays: OverlayInventoryItem[],
): string {
  return overlays
    .filter((overlay) => overlay.blocksInteraction)
    .map((overlay) =>
      [
        overlay.kind,
        overlay.selector || "",
        overlay.label || "",
        overlay.text || "",
        overlay.actions
          .map((action) => `${action.selector || ""}:${action.label || ""}`)
          .join("|"),
        overlay.radioOptions
          .map((option) => `${option.selector || ""}:${option.label || ""}`)
          .join("|"),
      ].join("::"),
    )
    .join("||");
}

export function buildOverlayInventory(
  page: Pick<PageContent, "overlays" | "interactiveElements">,
): OverlayInventoryItem[] {
  if (page.overlays.length === 0) return [];

  return page.overlays.map((overlay) => {
    const controls = dedupeCandidates([
      ...page.interactiveElements
        .filter((el) => {
          if (overlay.selector && el.parentOverlay === overlay.selector) {
            return true;
          }
          return page.overlays.length === 1 && el.context === "dialog";
        })
        .filter(isOverlayAction)
        .map(normalizeAction),
      ...(overlay.actions || []).map(normalizeStoredAction),
    ]).filter((action) => action.label || action.selector);

    const radioOptions = dedupeCandidates([
      ...page.interactiveElements
        .filter((el) => {
          if (!isRadioOption(el)) return false;
          if (overlay.selector && el.parentOverlay === overlay.selector) {
            return true;
          }
          return page.overlays.length === 1 && el.context === "dialog";
        })
        .map(normalizeAction),
      ...(overlay.radioOptions || []).map(normalizeStoredRadioOption),
    ]).filter((action) => action.label || action.selector);

    const kind = classifyOverlayKind(overlay, radioOptions);
    const dismissAction = findAction(
      controls,
      /\b(close|dismiss|skip|cancel|reject|decline|no thanks|not now|maybe later|continue without)\b/,
    );
    const acceptAction = findAction(
      controls,
      /\b(accept|allow|agree|got it|ok|okay|consent)\b/,
    );
    const submitAction = findAction(
      controls,
      /\b(submit|continue|confirm|done|next|save|apply|finish)\b/,
    );
    const correctOption = radioOptions.find(
      (option) => option.looksCorrect === true,
    );

    return {
      type: overlay.type,
      kind,
      role: overlay.role,
      label: overlay.label,
      selector: overlay.selector,
      text: overlay.text,
      blocksInteraction: overlay.blocksInteraction,
      actions: controls,
      radioOptions,
      dismissAction,
      acceptAction,
      submitAction,
      correctOption,
    };
  });
}
