import { createSignal, onCleanup, onMount } from "solid-js";
import type { ProviderId } from "../../../../shared/types";

type AuthStatus = "idle" | "waiting" | "exchanging" | "connected" | "error";

interface OpenRouterConnectedResult {
  providerId: "openrouter";
  model: string;
}

interface ProviderAuthSetupOptions {
  onCodexConnected?: () => void | Promise<void>;
  onCodexDisconnected?: () => void | Promise<void>;
  onOpenRouterConnected?: (result: OpenRouterConnectedResult) => void | Promise<void>;
}

export function useProviderAuthSetup(options: ProviderAuthSetupOptions = {}) {
  const [codexAuthStatus, setCodexAuthStatus] = createSignal<AuthStatus>("idle");
  const [codexAccountEmail, setCodexAccountEmail] = createSignal("");
  const [codexAuthError, setCodexAuthError] = createSignal("");
  const [openRouterAuthStatus, setOpenRouterAuthStatus] =
    createSignal<AuthStatus>("idle");
  const [openRouterAuthError, setOpenRouterAuthError] = createSignal("");

  const markProviderConnected = (
    providerId: ProviderId | null | undefined,
    hasApiKey: boolean,
  ) => {
    setCodexAuthStatus(providerId === "openai_codex" && hasApiKey ? "connected" : "idle");
    setOpenRouterAuthStatus(providerId === "openrouter" && hasApiKey ? "connected" : "idle");
  };

  const startCodexAuth = async () => {
    setCodexAuthStatus("waiting");
    setCodexAuthError("");
    try {
      const result = await window.vessel.codex.startAuth();
      if (result.ok) {
        setCodexAccountEmail(result.accountEmail);
        setCodexAuthStatus("connected");
        await options.onCodexConnected?.();
      } else {
        setCodexAuthStatus("error");
        setCodexAuthError(result.error);
      }
    } catch (err) {
      setCodexAuthStatus("error");
      setCodexAuthError(err instanceof Error ? err.message : "Unknown error");
    }
  };

  const disconnectCodex = async () => {
    await window.vessel.codex.disconnect();
    setCodexAuthStatus("idle");
    setCodexAccountEmail("");
    await options.onCodexDisconnected?.();
  };

  const startOpenRouterAuth = async () => {
    setOpenRouterAuthStatus("waiting");
    setOpenRouterAuthError("");
    try {
      const result = await window.vessel.openrouter.startAuth();
      if (result.ok) {
        setOpenRouterAuthStatus("connected");
        await options.onOpenRouterConnected?.(result);
      } else {
        setOpenRouterAuthStatus("error");
        setOpenRouterAuthError(result.error);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setOpenRouterAuthStatus("error");
      setOpenRouterAuthError(message);
    }
  };

  onMount(() => {
    const unsubCodex = window.vessel.codex.onAuthStatus((payload) => {
      if (payload.status === "waiting") {
        setCodexAuthStatus("waiting");
      } else if (payload.status === "exchanging") {
        setCodexAuthStatus("exchanging");
      } else if (payload.status === "error") {
        setCodexAuthStatus("error");
        setCodexAuthError(payload.error || "Unknown error");
      }
    });
    const unsubOpenRouter = window.vessel.openrouter.onAuthStatus((payload) => {
      if (payload.status === "waiting") {
        setOpenRouterAuthStatus("waiting");
      } else if (payload.status === "exchanging") {
        setOpenRouterAuthStatus("exchanging");
      } else if (payload.status === "connected") {
        setOpenRouterAuthStatus("connected");
      } else if (payload.status === "error") {
        setOpenRouterAuthStatus("error");
        setOpenRouterAuthError(payload.error || "Unknown error");
      }
    });

    onCleanup(() => {
      unsubCodex();
      unsubOpenRouter();
    });
  });

  return {
    codexAuthStatus,
    codexAccountEmail,
    setCodexAccountEmail,
    codexAuthError,
    setCodexAuthError,
    openRouterAuthStatus,
    openRouterAuthError,
    markProviderConnected,
    startCodexAuth,
    disconnectCodex,
    startOpenRouterAuth,
  };
}
