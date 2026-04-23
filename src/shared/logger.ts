type LogLevel = "debug" | "info" | "warn" | "error";

function getEnvFlag(name: string): string | undefined {
  const globalProcess =
    typeof globalThis === "object" && "process" in globalThis
      ? (globalThis as { process?: { env?: Record<string, string | undefined> } })
          .process
      : undefined;
  return globalProcess?.env?.[name];
}

function isDebugEnabled(): boolean {
  const value = getEnvFlag("VESSEL_DEBUG")?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function writeLog(level: LogLevel, scope: string, args: unknown[]): void {
  if (level === "debug" && !isDebugEnabled()) {
    return;
  }

  const prefix = `[Vessel ${scope}]`;
  switch (level) {
    case "debug":
      console.debug(prefix, ...args);
      return;
    case "info":
      console.info(prefix, ...args);
      return;
    case "warn":
      console.warn(prefix, ...args);
      return;
    case "error":
      console.error(prefix, ...args);
      return;
  }
}

export function createLogger(scope: string) {
  return {
    debug: (...args: unknown[]) => writeLog("debug", scope, args),
    info: (...args: unknown[]) => writeLog("info", scope, args),
    warn: (...args: unknown[]) => writeLog("warn", scope, args),
    error: (...args: unknown[]) => writeLog("error", scope, args),
  };
}
