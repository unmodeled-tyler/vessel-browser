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
    lowered.includes("search results") ||
    lowered.includes("best sellers") ||
    lowered.includes("bestsellers") ||
    lowered.includes("[read_page mode=results_only]")
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
  const loweredResult = normalizeResult(result);
  let nextState: TaskTrackerState = {
    ...state,
    lastAction: actionName,
    updatedAt: new Date().toISOString(),
  };

  const currentLabel =
    nextState.steps[nextState.currentStepIndex]?.label.toLowerCase() ?? "";

  if (actionName === "navigate") {
    nextState = completeStep(nextState, "Reached the requested site.");
    return setNextHint(
      nextState,
      "Use the site's search box or a curated section to expose book titles you can click directly. Avoid a full-page read unless the path is unclear.",
    );
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
    nextState = completeStep(nextState, "Found a starting point on the site.");
    return setNextHint(
      nextState,
      looksLikeListingResult(result)
        ? "Book results are already visible. Click one promising title now. Do not reread or scroll the same listing page unless no book link is available."
        : "Expose book titles you can click directly, then inspect individual books until you have the full set.",
    );
  }

  if (
    /pick the requested/.test(currentLabel) &&
    isDiscoveryAction
  ) {
    if (looksLikeCartConfirmation(result)) {
      return setNextHint(
        nextState,
        "This book is already in the cart. Choose Continue Shopping or go back, then open the next unseen title.",
      );
    }

    if (looksLikeProductDetailResult(result)) {
      return setNextHint(
        nextState,
        'You are on a book detail page. Add this book to the cart now. Use read_page(mode="visible_only") once only if you need the Add to Cart index.',
      );
    }

    if (looksLikeListingResult(result)) {
      return setNextHint(
        nextState,
        "A book listing is already visible. Click one unseen title now, then add it to the cart from its detail page before returning to the list.",
      );
    }

    return setNextHint(
      nextState,
      "Keep selecting candidate books. After you have the requested set, add each one to the cart.",
    );
  }

  if (
    /pick the requested/.test(currentLabel) &&
    actionName === "go_back"
  ) {
    return setNextHint(
      nextState,
      "You are back on the listing flow. Open the next unseen book title now instead of rereading the whole page.",
    );
  }

  if (
    /add the chosen .* to the cart/.test(currentLabel) &&
    looksLikeCartConfirmation(result)
  ) {
    nextState = completeStep(nextState, "Cart interaction succeeded.");
    return setNextHint(
      nextState,
      "Summarize the chosen books and explain why they were recommended.",
    );
  }

  if (/explain the recommendations/.test(currentLabel)) {
    return setNextHint(
      nextState,
      "Finish by naming the chosen books and giving concise reasons for each.",
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
