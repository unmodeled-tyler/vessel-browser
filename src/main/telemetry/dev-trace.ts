import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { app } from "electron";
import { createLogger } from "../../shared/logger";

interface TraceSessionLike {
  logToolCall(
    tool: string,
    input: Record<string, unknown>,
    output: string,
    durationMs: number,
    isError?: boolean,
  ): void;
  end(responseText: string, error?: string): void;
}

type TraceFactory = (
  query: string,
  url: string,
  title: string,
) => TraceSessionLike;

const require = createRequire(import.meta.url);
const logger = createLogger("DevTrace");

let cachedFactory: TraceFactory | null | undefined;

function createNoopTraceSession(): TraceSessionLike {
  return {
    logToolCall() {
      // no-op outside local dev tracing
    },
    end() {
      // no-op outside local dev tracing
    },
  };
}

function getCandidatePaths(): string[] {
  const roots = new Set<string>([
    process.cwd(),
    app.getAppPath(),
    path.join(app.getAppPath(), ".."),
  ]);

  return Array.from(roots).map((root) =>
    path.join(root, "src", "main", "telemetry", "trace-logger.local.cjs"),
  );
}

function loadLocalFactory(): TraceFactory | null {
  if (cachedFactory !== undefined) return cachedFactory;
  cachedFactory = null;

  if (app.isPackaged) return cachedFactory;

  for (const candidate of getCandidatePaths()) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const loaded = require(candidate) as { createTraceSession?: TraceFactory };
      if (typeof loaded.createTraceSession === "function") {
        cachedFactory = loaded.createTraceSession;
        return cachedFactory;
      }
    } catch (err) {
      logger.warn("Failed to load local trace logger:", err);
    }
  }

  return cachedFactory;
}

export function createTraceSession(
  query: string,
  url: string,
  title: string,
): TraceSessionLike {
  const factory = loadLocalFactory();
  return factory ? factory(query, url, title) : createNoopTraceSession();
}
