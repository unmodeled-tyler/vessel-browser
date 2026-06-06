import { getErrorMessage } from "../../shared/result";

export async function readJsonResponse<T>(
  response: Response,
  fallback: T,
  onError: (message: string) => void,
): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (err) {
    onError(getErrorMessage(err, "JSON parse failed"));
    return fallback;
  }
}
