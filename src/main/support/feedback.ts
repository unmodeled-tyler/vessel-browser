import {
  errorResult,
  getErrorMessage,
  okResult,
  type Result,
} from "../../shared/result";

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

    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      return errorResult(data.error || `HTTP ${res.status}`);
    }

    return okResult();
  } catch (error) {
    return errorResult(getErrorMessage(error, "Failed to send feedback."));
  }
}
