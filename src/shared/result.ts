export type OkResult<T extends object = Record<string, never>> = { ok: true } & T;
export type ErrorResult<T extends object = Record<string, never>> = {
  ok: false;
  error: string;
} & T;

export type Result<
  TSuccess extends object = Record<string, never>,
  TFailure extends object = Record<string, never>,
> = OkResult<TSuccess> | ErrorResult<TFailure>;

export function okResult<T extends object = Record<string, never>>(
  value?: T,
): OkResult<T> {
  return {
    ok: true,
    ...((value ?? {}) as T),
  };
}

export function errorResult<T extends object = Record<string, never>>(
  error: string,
  value?: T,
): ErrorResult<T> {
  return {
    ok: false,
    error,
    ...((value ?? {}) as T),
  };
}

export function getErrorMessage(
  error: unknown,
  fallback = "Unknown error",
): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Safely parse JSON with a fallback value. Logs the failure via an optional
 * logger callback so silent parse errors stay observable.
 */
export function safeJsonParse<T>(
  input: string | unknown,
  fallback: T,
  onError?: (message: string) => void,
): T {
  try {
    const raw = typeof input === "string" ? input : JSON.stringify(input);
    return JSON.parse(raw) as T;
  } catch (err) {
    const message = getErrorMessage(err, "JSON parse failed");
    onError?.(message);
    return fallback;
  }
}
