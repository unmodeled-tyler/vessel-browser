import http from "http";
import crypto from "crypto";
import type { createLogger } from "../../shared/logger";
import { openExternalAllowlisted } from "../security/external-open";

export type LocalOAuthStatus = "idle" | "waiting" | "exchanging" | "connected" | "error";

export interface PkceCodes {
  codeVerifier: string;
  codeChallenge: string;
}

interface CallbackExchangeInput {
  code: string;
  codeVerifier: string;
  callbackUrl: string;
  port: number;
}

interface LocalPkceOAuthConfig<T> {
  name: string;
  logger: ReturnType<typeof createLogger>;
  preferredPorts: readonly number[];
  timeoutMs: number;
  callbackPath: (state: string) => string;
  readState: (url: URL) => string | null;
  buildAuthorizeUrl: (input: {
    port: number;
    pkce: PkceCodes;
    state: string;
    callbackUrl: string;
  }) => string;
  exchangeCode: (input: CallbackExchangeInput) => Promise<T>;
  successHtml: (result: T) => string;
  openHosts: readonly string[];
  authErrorMessage?: (url: URL) => string | null;
}

interface AuthFlowState {
  server: http.Server;
  timeout: ReturnType<typeof setTimeout>;
  onStatus: (status: LocalOAuthStatus, error?: string) => void;
}

export interface LocalPkceOAuthFlow<T> {
  start(onStatus: (status: LocalOAuthStatus, error?: string) => void): Promise<T>;
  cancel(): void;
  isInProgress(): boolean;
}

function base64url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generatePkce(): PkceCodes {
  const codeVerifier = base64url(crypto.randomBytes(64));
  const hash = crypto.createHash("sha256").update(codeVerifier).digest();
  return {
    codeVerifier,
    codeChallenge: base64url(hash),
  };
}

function generateState(): string {
  return base64url(crypto.randomBytes(32));
}

function buildCallbackUrl(port: number, path: string): string {
  return `http://localhost:${port}${path}`;
}

async function bindServer(
  server: http.Server,
  preferredPorts: readonly number[],
): Promise<number> {
  for (const port of preferredPorts) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
      return port;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    `Could not bind ${preferredPorts.join(", ")} callback ports`,
  );
}

export function createLocalPkceOAuthFlow<T>(
  config: LocalPkceOAuthConfig<T>,
): LocalPkceOAuthFlow<T> {
  let activeFlow: AuthFlowState | null = null;

  const cancel = (): void => {
    if (!activeFlow) return;
    activeFlow.server.close();
    clearTimeout(activeFlow.timeout);
    try {
      activeFlow.onStatus("idle");
    } catch {
      config.logger.warn(`${config.name} OAuth cancel status callback failed`);
    }
    activeFlow = null;
  };

  const start = (
    onStatus: (status: LocalOAuthStatus, error?: string) => void,
  ): Promise<T> => {
    if (activeFlow) {
      throw new Error(`${config.name} auth flow already in progress`);
    }

    const pkce = generatePkce();
    const state = generateState();
    const callbackPath = config.callbackPath(state);

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let boundPort = 0;

      const safeOnStatus = (status: LocalOAuthStatus, error?: string) => {
        try {
          onStatus(status, error);
        } catch {
          config.logger.warn(`${config.name} OAuth status callback failed`);
        }
      };

      const cleanup = () => {
        clearTimeout(activeFlow?.timeout);
        activeFlow?.server.close();
        activeFlow = null;
      };

      const wrappedResolve = (result: T) => {
        if (settled) return;
        settled = true;
        cleanup();
        safeOnStatus("connected");
        resolve(result);
      };

      const wrappedReject = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        safeOnStatus("error", err.message);
        reject(err);
      };

      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || "/", `http://localhost:${boundPort}`);

        if (url.pathname === callbackPath) {
          const authError =
            config.authErrorMessage?.(url) || url.searchParams.get("error");
          if (authError) {
            res.writeHead(400, { "Content-Type": "text/plain", Connection: "close" });
            res.end(`Authorization failed: ${authError}`);
            wrappedReject(new Error(authError));
            return;
          }

          if (config.readState(url) !== state) {
            res.writeHead(400, { "Content-Type": "text/plain", Connection: "close" });
            res.end("State mismatch. Please try again.");
            wrappedReject(new Error("State mismatch"));
            return;
          }

          const code = url.searchParams.get("code");
          if (!code) {
            res.writeHead(400, { "Content-Type": "text/plain", Connection: "close" });
            res.end("Missing authorization code.");
            wrappedReject(new Error("Missing authorization code"));
            return;
          }

          try {
            safeOnStatus("exchanging");
            const result = await config.exchangeCode({
              code,
              codeVerifier: pkce.codeVerifier,
              callbackUrl: buildCallbackUrl(boundPort, callbackPath),
              port: boundPort,
            });
            res.writeHead(200, { "Content-Type": "text/html", Connection: "close" });
            res.end(config.successHtml(result));
            wrappedResolve(result);
          } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            res.writeHead(400, { "Content-Type": "text/plain", Connection: "close" });
            res.end(`${config.name} setup failed: ${message}`);
            wrappedReject(err instanceof Error ? err : new Error(`${config.name} setup failed`));
          }
          return;
        }

        res.writeHead(404, { Connection: "close" });
        res.end("Not found");
      });

      const timeout = setTimeout(() => {
        wrappedReject(new Error(`${config.name} setup timed out after 5 minutes`));
      }, config.timeoutMs);

      activeFlow = {
        server,
        timeout,
        onStatus,
      };

      bindServer(server, config.preferredPorts)
        .then((port) => {
          if (settled || !activeFlow) return;
          boundPort = port;
          const callbackUrl = buildCallbackUrl(port, callbackPath);
          const authUrl = config.buildAuthorizeUrl({
            port,
            pkce,
            state,
            callbackUrl,
          });
          safeOnStatus("waiting");
          openExternalAllowlisted(authUrl, { hosts: [...config.openHosts] }).catch((err: Error) => {
            config.logger.warn(`Failed to open ${config.name} auth URL:`, err);
          });
        })
        .catch(wrappedReject);
    });
  };

  return {
    start,
    cancel,
    isInProgress: () => activeFlow !== null,
  };
}
