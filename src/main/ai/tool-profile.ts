import type { ProviderConfig, ProviderId } from "../../shared/types";

export type AgentToolProfile = "default" | "compact";

function parseModelSizeInBillions(model: string): number | null {
  const match = model.toLowerCase().match(/(?:^|[:/_\-\s])(\d+(?:\.\d+)?)b(?:$|[:/_\-\s])/i);
  if (!match) return null;

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function isLoopbackBaseUrl(baseUrl?: string): boolean {
  if (!baseUrl) return false;

  try {
    const url = new URL(baseUrl);
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1"
    );
  } catch {
    return false;
  }
}

export function resolveAgentToolProfile(
  config: Pick<ProviderConfig, "id" | "model" | "baseUrl">,
): AgentToolProfile {
  const providerId: ProviderId = config.id;
  const isLocalProvider =
    providerId === "ollama" ||
    providerId === "llama_cpp" ||
    (providerId === "custom" && isLoopbackBaseUrl(config.baseUrl));

  if (!isLocalProvider) return "default";

  const sizeInBillions = parseModelSizeInBillions(config.model);
  if (sizeInBillions === null) {
    return "compact";
  }

  return sizeInBillions <= 14 ? "compact" : "default";
}
