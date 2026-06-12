const DOLLAR_PRICE_RE = /\$\s?\d{2,4}(?:[,.]\d{2})?\b/;

const FLIGHT_TASK_RE =
  /\b(?:flight|flights|airfare|air fare|plane ticket|airline|airport|google flights|pdx|sfo|san francisco|portland)\b/i;

const SHOPPING_INTENT_RE =
  /\b(?:cheap|cheapest|price|prices|fare|fares|one[- ]?way|round[- ]?trip|depart|departure|arrive|arrival|from|to)\b/i;

const FLIGHT_CLAIM_CONTEXT_RE =
  /\b(?:flight|flights|airline|airlines|departure|arrival|depart|arrive|nonstop|non-stop|stops?|duration|alaska|united|delta|american|southwest|frontier|spirit|jetblue|hawaiian)\b/i;

const FLIGHT_RESULT_CONTEXT_RE =
  /\b(?:best departing flights|departing flights|returning flights|flight results|google flights|airline|airlines|duration|nonstop|non-stop|stops?|departure|arrival|depart|arrive|price|fare|fares|alaska|united|delta|american|southwest|frontier|spirit|jetblue|hawaiian)\b/i;

const EMPTY_FORM_CONTEXT_RE =
  /\b(?:where to\?|search airports or cities|destination|from\?|departure date|calendar|google flights)\b/i;

const TOOL_FAILURE_RE =
  /\b(?:error|failed|type-not-applied|did not type|could not type|not applied|unsupported|invalid args)\b/i;

function normalizeEvidenceText(text: string | null | undefined): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

export function looksLikeFlightShoppingTask(userMessage: string): boolean {
  return FLIGHT_TASK_RE.test(userMessage) && SHOPPING_INTENT_RE.test(userMessage);
}

export function answerIncludesFlightPriceClaims(assistantText: string): boolean {
  return DOLLAR_PRICE_RE.test(assistantText) && FLIGHT_CLAIM_CONTEXT_RE.test(assistantText);
}

export function toolResultHasFlightPriceEvidence(
  latestToolResultPreview: string | null | undefined,
): boolean {
  const text = normalizeEvidenceText(latestToolResultPreview);
  if (!text) return false;
  if (TOOL_FAILURE_RE.test(text) && !DOLLAR_PRICE_RE.test(text)) return false;
  return DOLLAR_PRICE_RE.test(text) && FLIGHT_RESULT_CONTEXT_RE.test(text);
}

export function shouldBlockUnsupportedFlightPriceAnswer(
  userMessage: string,
  assistantText: string,
  latestToolResultPreview: string | null | undefined,
): boolean {
  return (
    looksLikeFlightShoppingTask(userMessage) &&
    answerIncludesFlightPriceClaims(assistantText) &&
    !toolResultHasFlightPriceEvidence(latestToolResultPreview)
  );
}

export function buildFlightPriceEvidenceRecoveryPrompt(
  userMessage: string,
  assistantText: string,
  latestToolResultPreview: string | null | undefined,
): string {
  const latest = normalizeEvidenceText(latestToolResultPreview);
  const maybeFormState =
    latest && EMPTY_FORM_CONTEXT_RE.test(latest)
      ? " The latest page state still looks like a flight search form, so verify the destination, route, and date before reading results."
      : "";

  return [
    `The user asked for live flight prices: ${userMessage}`,
    `Your last answer included specific flight prices, but the latest browser/tool evidence does not show visible flight-result rows with prices.`,
    `Erase that answer and continue with browser tools until the current page evidence shows the route/date and visible priced flight results.${maybeFormState}`,
    `Do not report airline names, times, or prices unless they are visible in the latest browser/page evidence.`,
    `Last unsupported answer: ${assistantText.replace(/\s+/g, " ").trim().slice(0, 500) || "(empty)"}`,
  ].join("\n");
}
