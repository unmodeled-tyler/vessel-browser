export interface LinkValidationResult {
  status: "live" | "dead" | "unknown";
  checkedUrl: string;
  finalUrl?: string;
  statusCode?: number;
  detail?: string;
}

const DEAD_STATUS_CODES = new Set([404, 410, 451]);
const HEAD_FALLBACK_STATUS_CODES = new Set([400, 403, 404, 405, 406, 500, 501]);

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function requestUrl(
  url: string,
  method: "HEAD" | "GET",
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "Vessel/0.1.0 (+https://github.com/unmodeled-tyler/vessel-browser)",
      },
    });
    await response.body?.cancel().catch(() => undefined);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function classifyResponse(
  checkedUrl: string,
  response: Response,
): LinkValidationResult {
  const statusCode = response.status;
  const finalUrl = response.url || checkedUrl;

  if (DEAD_STATUS_CODES.has(statusCode)) {
    return {
      status: "dead",
      checkedUrl,
      finalUrl,
      statusCode,
      detail: `HTTP ${statusCode}`,
    };
  }

  if (statusCode >= 200 && statusCode < 400) {
    return {
      status: "live",
      checkedUrl,
      finalUrl,
      statusCode,
      detail: `HTTP ${statusCode}`,
    };
  }

  return {
    status: "unknown",
    checkedUrl,
    finalUrl,
    statusCode,
    detail: `HTTP ${statusCode}`,
  };
}

export async function validateLinkDestination(
  url: string,
  timeoutMs = 3500,
): Promise<LinkValidationResult> {
  if (!isHttpUrl(url)) {
    return {
      status: "unknown",
      checkedUrl: url,
      detail: "Non-HTTP URL",
    };
  }

  try {
    const headResponse = await requestUrl(url, "HEAD", timeoutMs);
    if (!HEAD_FALLBACK_STATUS_CODES.has(headResponse.status)) {
      return classifyResponse(url, headResponse);
    }

    const getResponse = await requestUrl(url, "GET", timeoutMs);
    return classifyResponse(url, getResponse);
  } catch (error) {
    return {
      status: "unknown",
      checkedUrl: url,
      detail:
        error instanceof Error ? error.message : "Link validation failed",
    };
  }
}

export function formatDeadLinkMessage(
  label: string,
  result: LinkValidationResult,
): string {
  const destination = result.finalUrl || result.checkedUrl;
  const status = result.statusCode ? `HTTP ${result.statusCode}` : "dead link";
  return `Skipped stale link "${label}" because ${destination} returned ${status}. Try a different link or URL instead.`;
}
