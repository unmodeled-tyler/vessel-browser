import {
  errorResult,
  getErrorMessage,
  okResult,
  type Result,
} from "../../shared/result";
import { isAirGapped } from "../config/air-gapped";
import { createLogger } from "../../shared/logger";
import { readJsonResponse } from "../network/json-response";

const logger = createLogger("Feedback");

const SUPPORT_API =
  process.env.VESSEL_SUPPORT_API ||
  process.env.VESSEL_PREMIUM_API ||
  "https://vesselpremium.quantaintellect.com";

const MAX_FEEDBACK_MESSAGE_LENGTH = 5000;
const FEEDBACK_REQUEST_TIMEOUT_MS = 15_000;

type FeedbackPayload = {
  email: string;
  message: string;
  source?: string;
};

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function submitFeedback(
  payload: FeedbackPayload,
): Promise<Result> {
  if (isAirGapped()) {
    return errorResult("Feedback submission is disabled in air-gapped mode.");
  }

  const email = payload.email.trim().toLowerCase();
  const message = payload.message.trim();

  if (!isValidEmail(email)) {
    return errorResult("Enter a valid reply email.");
  }
  if (!message) {
    return errorResult("Write a feedback message before sending.");
  }
  if (message.length > MAX_FEEDBACK_MESSAGE_LENGTH) {
    return errorResult(
      `Feedback must be ${MAX_FEEDBACK_MESSAGE_LENGTH.toLocaleString()} characters or less.`,
    );
  }

  try {
    const signal = AbortSignal.timeout(FEEDBACK_REQUEST_TIMEOUT_MS);
    const res = await fetch(`${SUPPORT_API}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        email,
        message,
        source: payload.source,
      }),
    });

    const data = await readJsonResponse(
      res,
      {} as { error?: string },
      (msg) => logger.warn("Failed to parse feedback response:", msg),
    );
    if (!res.ok) {
      return errorResult(data.error || `HTTP ${res.status}`);
    }

    return okResult();
  } catch (error) {
    return errorResult(getErrorMessage(error, "Failed to send feedback."));
  }
}
