import type { TaskTrackerState, TaskTrackerStep } from "../../shared/types";

function makeStep(
  label: string,
  status: TaskTrackerStep["status"] = "pending",
): TaskTrackerStep {
  return { label, status };
}

function extractRequestedCount(goal: string): number | null {
  const digitMatch = goal.match(/\b(\d+)\b/);
  if (digitMatch) return Number(digitMatch[1]);

  const wordMap: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };

  for (const [word, count] of Object.entries(wordMap)) {
    if (new RegExp(`\\b${word}\\b`, "i").test(goal)) return count;
  }

  return null;
}

function buildInitialSteps(goal: string): TaskTrackerStep[] {
  const lowered = goal.toLowerCase();
  const requestedCount = extractRequestedCount(goal);
  const itemLabel = /\b(book|books)\b/.test(lowered) ? "books" : "items";
  const countLabel = requestedCount ? `${requestedCount} ${itemLabel}` : itemLabel;

  const steps: TaskTrackerStep[] = [
    makeStep("Navigate to the requested site", "active"),
  ];

  if (/\b(find|browse|look|discover|select|recommend|interesting)\b/.test(lowered)) {
    steps.push(makeStep(`Browse or search for relevant ${itemLabel}`));
  }

  steps.push(makeStep(`Pick the requested ${countLabel}`));

  if (/\b(cart|checkout|bag)\b/.test(lowered)) {
    steps.push(makeStep(`Add the chosen ${itemLabel} to the cart`));
  }

  if (/\b(explain|reason|why)\b/.test(lowered)) {
    steps.push(makeStep("Explain the recommendations"));
  }

  return steps;
}

function setActiveStep(
  steps: TaskTrackerStep[],
  currentStepIndex: number,
): TaskTrackerStep[] {
  return steps.map((step, index) => {
    if (step.status === "done" || step.status === "failed") return step;
    return {
      ...step,
      status: index === currentStepIndex ? "active" : "pending",
    };
  });
}

function completeStep(
  state: TaskTrackerState,
  detail?: string,
): TaskTrackerState {
  const steps = state.steps.map((step) => ({ ...step }));
  const current = steps[state.currentStepIndex];
  if (current) {
    current.status = "done";
    current.detail = detail || current.detail;
  }

  const nextIndex = Math.min(state.currentStepIndex + 1, steps.length - 1);
  const normalizedSteps = setActiveStep(
    steps,
    current ? nextIndex : state.currentStepIndex,
  );

  return {
    ...state,
    steps: normalizedSteps,
    currentStepIndex: current ? nextIndex : state.currentStepIndex,
    updatedAt: new Date().toISOString(),
  };
}

function setNextHint(
  state: TaskTrackerState,
  nextHint: string,
): TaskTrackerState {
  return {
    ...state,
    nextHint,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeResult(result: string): string {
  return result.toLowerCase();
}

function looksLikeListingResult(result: string): boolean {
  const lowered = normalizeResult(result);
  return (
    lowered.includes("### primary results") ||
    lowered.includes("### likely search results") ||
    lowered.includes("[read_page mode=results_only]")
  );
}

function countSurfacedResults(result: string): number {
  const matches = result.match(/^\s*-\s+\[#\d+\]/gm);
  return matches?.length ?? 0;
}

function looksLikeSearchResultsPage(result: string): boolean {
  const lowered = normalizeResult(result);
  return (
    lowered.includes("/searchresults") ||
    lowered.includes("/books/search") ||
    lowered.includes("search results") ||
    lowered.includes("bestsellers") ||
    lowered.includes("best sellers")
  );
}

function looksLikeProductDetailResult(result: string): boolean {
  const lowered = normalizeResult(result);
  return (
    lowered.includes("### visible purchase controls") ||
    /\badd(?: item)? to (?:cart|bag|basket)\b/.test(lowered) ||
    lowered.includes("buy now") ||
    /https?:\/\/[^\s)]+\/book\//i.test(result)
  );
}

function looksLikeCartConfirmation(result: string): boolean {
  return /(added to cart|cart confirmation|view cart|continue shopping|shopping cart|checkout)/.test(
    normalizeResult(result),
  );
}

function looksLikeCartPage(result: string): boolean {
  const lowered = normalizeResult(result);
  return (
    /\*\*url:\*\*\s*https?:\/\/[^\s]+\/cart\b/.test(lowered) ||
    /\b(?:navigated to|went back to|went forward to)\s+https?:\/\/[^\s]+\/cart\b/.test(
      lowered,
    ) ||
    /\*\*title:\*\*.*\b(cart|checkout)\b/.test(lowered) ||
    /\b(shopping cart|cart subtotal|cart total)\b/.test(lowered)
  );
}

function looksLikeStaleElementError(result: string): boolean {
  const lowered = normalizeResult(result);
  return (
    lowered.includes("error[stale-index]") ||
    lowered.includes("element not found — the page may have changed") ||
    lowered.includes("shadow dom element not found") ||
    lowered.includes("call read_page to refresh") ||
    lowered.includes("cannot locate the elements to click") ||
    lowered.includes("page structure is not being reliably captured")
  );
}

function extractStructuredUrl(result: string): string | null {
  return (
    result.match(/\*\*url:\*\*\s*([^\n]+)/i)?.[1]?.trim() ??
    extractNavigatedUrl(result)
  );
}

function isAddToCartSuccess(actionName: string, result: string): boolean {
  const lowered = normalizeResult(result);
  if (actionName !== "click") return false;
  if (lowered.startsWith("blocked:")) return false;
  const clickedAddToCart = /clicked:.*add(?: item)? to (?:cart|bag|basket)/.test(lowered);
  return clickedAddToCart && looksLikeCartConfirmation(result);
}

function extractNavigatedUrl(result: string): string | null {
  return (
    result.match(
      /\b(?:navigated to|went back to|went forward to|searched "[^"]+"(?: \(via search button\))? →)\s+([^\s\n]+)/i,
    )?.[1]?.trim() ?? null
  );
}

function stepIndexMatching(
  steps: TaskTrackerStep[],
  pattern: RegExp,
): number {
  return steps.findIndex((step) => pattern.test(step.label.toLowerCase()));
}

function activateSpecificStep(
  state: TaskTrackerState,
  stepIndex: number,
): TaskTrackerState {
  if (stepIndex < 0 || stepIndex >= state.steps.length) return state;
  return {
    ...state,
    steps: setActiveStep(state.steps.map((step) => ({ ...step })), stepIndex),
    currentStepIndex: stepIndex,
    updatedAt: new Date().toISOString(),
  };
}

function finalizeShoppingTracker(
  state: TaskTrackerState,
  detail: string,
): TaskTrackerState {
  const steps = state.steps.map((step) => ({ ...step }));
  const pickIndex = stepIndexMatching(steps, /^pick the requested/);
  const cartIndex = stepIndexMatching(steps, /^add the chosen .* to the cart$/);
  const explainIndex = stepIndexMatching(steps, /^explain the recommendations$/);

  if (pickIndex >= 0) {
    steps[pickIndex] = {
      ...steps[pickIndex],
      status: "done",
      detail,
    };
  }

  if (cartIndex >= 0) {
    steps[cartIndex] = {
      ...steps[cartIndex],
      status: "done",
      detail,
    };
  }

  const activeIndex = explainIndex >= 0 ? explainIndex : state.currentStepIndex;
  return {
    ...state,
    steps: setActiveStep(steps, activeIndex),
    currentStepIndex: activeIndex,
    updatedAt: new Date().toISOString(),
  };
}

export function createTaskTracker(
  goal: string,
  startUrl?: string,
): TaskTrackerState {
  const now = new Date().toISOString();
  return {
    goal,
    startedAt: now,
    updatedAt: now,
    startUrl,
    currentStepIndex: 0,
    steps: buildInitialSteps(goal),
    lastAction: undefined,
    nextHint:
      "Use the site's search box or a strong curated section immediately. Avoid rereading the homepage unless search or navigation is hidden.",
  };
}

export function updateTaskTracker(
  state: TaskTrackerState,
  actionName: string,
  result: string,
): TaskTrackerState {
  const requestedCount =
    state.requestedCount ?? extractRequestedCount(state.goal) ?? null;
  let cartCount = state.cartCount ?? 0;
  const cartVisible = state.cartVisible || looksLikeCartPage(result);
  let nextState: TaskTrackerState = {
    ...state,
    lastAction: actionName,
    requestedCount,
    cartCount,
    cartVisible,
    updatedAt: new Date().toISOString(),
  };

  const currentLabel =
    nextState.steps[nextState.currentStepIndex]?.label.toLowerCase() ?? "";

  if (actionName === "navigate") {
    if (/navigate to the requested site/.test(currentLabel)) {
      nextState = completeStep(nextState, "Reached the requested site.");
      return setNextHint(
        nextState,
        "Use the site's search box or a curated section to expose product results you can click directly. Avoid a full-page read unless the path is unclear.",
      );
    }

    const navigatedUrl = extractNavigatedUrl(result) || "";
    if (/pick the requested/.test(currentLabel)) {
      if (/\/book\//i.test(navigatedUrl)) {
        return setNextHint(
          nextState,
          "You opened a chosen product detail page. Do not restart search. Click Add to Cart here, then wait for cart confirmation before moving on.",
        );
      }

      if (looksLikeSearchResultsPage(result)) {
        return setNextHint(
          nextState,
          "You are back on a results page while the chosen items are already decided. Do not restart search or browse new categories. Open one of the chosen result links and continue the add-to-cart flow.",
        );
      }
    }

    if (/add the chosen .* to the cart/.test(currentLabel)) {
      if (/\/book\//i.test(navigatedUrl)) {
        return setNextHint(
          nextState,
          "Stay on this product detail page and add the current chosen item to the cart. Do not go back to search unless this specific cart step fails.",
        );
      }

      if (looksLikeSearchResultsPage(result)) {
        return setNextHint(
          nextState,
          "The chosen items are already decided. Do not restart the search flow here. Open the next chosen result from the current page and add it to the cart.",
        );
      }
    }
  }

  const isDiscoveryAction = [
    "read_page",
    "search",
    "click",
    "inspect_element",
    "scroll",
  ].includes(actionName);

  if (
    isDiscoveryAction &&
    /browse or search/.test(currentLabel)
  ) {
    const surfacedResults = countSurfacedResults(result);
    nextState = completeStep(nextState, "Found a starting point on the site.");
    return setNextHint(
      nextState,
      looksLikeListingResult(result)
        ? surfacedResults === 1
          ? "One likely result is visible. Inspect or click that result before deciding there is no match. Do not skip to a new search yet."
          : "Product results are already visible. Open exactly one unseen result now, add that item before choosing another, and do not click multiple results in a row from the same listing page."
        : looksLikeSearchResultsPage(result)
          ? 'You are on a results page. Call read_page(mode="results_only") now to surface product results. Do not use visible_only or generic inspect_element to hunt result links.'
          : "Expose product results you can click directly, then inspect individual items until you have the full set.",
    );
  }

  if (
    /pick the requested/.test(currentLabel) &&
    isDiscoveryAction
  ) {
    if (isAddToCartSuccess(actionName, result)) {
      cartCount += 1;
      nextState = {
        ...nextState,
        cartCount,
      };

      if (requestedCount && cartCount >= requestedCount) {
        nextState = finalizeShoppingTracker(
          nextState,
          `Added ${cartCount} of ${requestedCount} requested items to the cart.`,
        );
        return setNextHint(
          nextState,
          cartVisible
            ? "All requested items are now in the cart and the cart is visible. Explain your reasoning in chat now and stop using tools."
            : "All requested items are now in the cart. Open the cart so the user can see it, then explain your reasoning in chat and stop using tools.",
        );
      }

      return setNextHint(
        nextState,
        requestedCount
          ? `${cartCount} of ${requestedCount} requested items are now in the cart. If the cart confirmation dialog is open, click Continue Shopping there. Do not click View Cart or Go to Basket until all requested items are added. Only use go_back if no dialog action is available. Then open the next unseen result.`
          : "This item is now in the cart. If the cart confirmation dialog is open, click Continue Shopping there. Do not click View Cart or Go to Basket yet. Only use go_back if no dialog action is available. Then open the next unseen result.",
      );
    }

    if (looksLikeCartConfirmation(result)) {
      return setNextHint(
        nextState,
        "This item is already in the cart. If the cart confirmation dialog is still open, click Continue Shopping there. Do not click View Cart or Go to Basket yet. Only use go_back if no dialog action is available. Then open the next unseen result.",
      );
    }

    const structuredUrl = extractStructuredUrl(result) || "";
    if (
      actionName === "read_page" &&
      cartCount > 0 &&
      /\/book\//i.test(structuredUrl) &&
      looksLikeProductDetailResult(result)
    ) {
      return setNextHint(
        nextState,
        "This detail page may already be for an item you just added. Do not click Add to Cart again on the same page. If the cart confirmation dialog is still open, click Continue Shopping there. Otherwise go back once and open the next chosen result. Do not click View Cart or Go to Basket yet.",
      );
    }

    if (looksLikeProductDetailResult(result)) {
      return setNextHint(
        nextState,
        'You are on a product detail page. Opening this page did not add the item to the cart. Click Add to Cart now, then wait for cart confirmation before moving on. Use read_page(mode="visible_only") once only if you need the Add to Cart index.',
      );
    }

    if (looksLikeSearchResultsPage(result) && !looksLikeListingResult(result)) {
      return setNextHint(
        nextState,
        'This is still a results page. Call read_page(mode="results_only") now and click a surfaced result. Do not loop on visible_only or generic inspect_element here.',
      );
    }

    if (looksLikeListingResult(result)) {
      const surfacedResults = countSurfacedResults(result);
      return setNextHint(
        nextState,
        surfacedResults === 1
          ? "There is one likely result visible. Inspect or click that result before declaring no match or moving to a different query."
          : "A product listing is already visible. Open exactly one unseen result now, add that item to the cart from its detail page, then return for the next result. Do not click multiple remembered results in a row from the listing page.",
      );
    }

    if (actionName === "click" && looksLikeStaleElementError(result)) {
      return setNextHint(
        nextState,
        'The last remembered click target is stale. Trust the latest page state, not older labels or indexes. Call read_page once on the current page. If you are on a detail page, add the current item now. If you are still on a listing page, open exactly one visible unseen result. Do not click multiple saved results in sequence.',
      );
    }

    return setNextHint(
      nextState,
      "Pick one promising unseen item at a time. As soon as a detail page opens, add that item to the cart before selecting another result.",
    );
  }

  if (
    /pick the requested/.test(currentLabel) &&
    actionName === "go_back"
  ) {
    return setNextHint(
      nextState,
      "You are back on the listing flow. Open exactly one next chosen or unseen result now instead of rereading the whole page, restarting search, or clicking multiple results in sequence.",
    );
  }

  if (
    /add the chosen .* to the cart/.test(currentLabel) &&
    isAddToCartSuccess(actionName, result)
  ) {
    cartCount += 1;
    nextState = {
      ...nextState,
      cartCount,
    };
    const detail = requestedCount
      ? `Added ${cartCount} of ${requestedCount} requested items to the cart.`
      : "Cart interaction succeeded.";
    nextState = completeStep(nextState, detail);
    return setNextHint(
      nextState,
      requestedCount && cartCount >= requestedCount
        ? cartVisible
          ? "All requested books are now in the cart and the cart is visible. Explain your reasoning in chat now and stop using tools."
          : "All requested books are now in the cart. Open the cart so the user can see it, then explain your reasoning in chat and stop using tools."
        : requestedCount
          ? `${cartCount} of ${requestedCount} requested books are now in the cart. Continue adding the remaining selected books.`
          : "Summarize the chosen books and explain why they were recommended.",
    );
  }

  if (/explain the recommendations/.test(currentLabel)) {
    return setNextHint(
      nextState,
      cartVisible
        ? "The cart is visible. Explain your reasoning in chat now, mention the chosen books, and stop using tools."
        : "Finish by naming the chosen books and giving concise reasons for each. If the cart is not visible yet, show it first.",
    );
  }

  return nextState;
}

export function formatTaskTracker(state: TaskTrackerState | null): string {
  if (!state) return "";

  const completed = state.steps
    .filter((step) => step.status === "done")
    .map((step) => step.label);
  const current = state.steps[state.currentStepIndex]?.label ?? "Task in progress";
  const remaining = state.steps
    .filter((step, index) => step.status !== "done" && index !== state.currentStepIndex)
    .map((step) => step.label);

  const lines = [
    "--- Task Tracker ---",
    `Goal: ${state.goal}`,
    `Completed: ${completed.length > 0 ? completed.join("; ") : "none yet"}`,
    `Current: ${current}`,
    `Remaining: ${remaining.length > 0 ? remaining.join("; ") : "wrap up the response"}`,
  ];

  if (state.nextHint) {
    lines.push(`Next: ${state.nextHint}`);
  }

  return `\n${lines.join("\n")}\n---`;
}
