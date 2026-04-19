import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

interface ToolCallEntry {
  ts: string;
  tool: string;
  input: Record<string, unknown>;
  output: string;
  duration_ms: number;
  error: boolean;
}

interface TraceEntry {
  id: string;
  ts: string;
  query: string;
  url: string;
  title: string;
  tool_calls: ToolCallEntry[];
  response: string;
  duration_ms: number;
  status: "ok" | "error";
  error?: string;
}

function getTracesDir(): string {
  return path.join(app.getPath("userData"), "agent-traces");
}

function getTodayFile(): string {
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return path.join(getTracesDir(), `${ymd}.jsonl`);
}

/** Strip large base64 blobs (screenshots) to keep trace files manageable. */
function sanitizeOutput(output: string): string {
  return output.replace(/"base64":"[A-Za-z0-9+/=]{100,}"/g, '"base64":"[stripped]"');
}

function appendTrace(entry: TraceEntry): void {
  try {
    const dir = getTracesDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(getTodayFile(), JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    console.warn("[trace-logger] Failed to write trace:", err);
  }
}

export class TraceSession {
  private readonly id: string;
  private readonly startTs: string;
  private readonly startTime: number;
  private readonly query: string;
  private readonly url: string;
  private readonly title: string;
  private readonly toolCalls: ToolCallEntry[] = [];

  constructor(query: string, url: string, title: string) {
    this.id = crypto.randomUUID();
    this.startTs = new Date().toISOString();
    this.startTime = Date.now();
    this.query = query;
    this.url = url;
    this.title = title;
  }

  logToolCall(
    tool: string,
    input: Record<string, unknown>,
    output: string,
    durationMs: number,
    isError = false,
  ): void {
    this.toolCalls.push({
      ts: new Date().toISOString(),
      tool,
      input,
      output: sanitizeOutput(output).slice(0, 4000),
      duration_ms: durationMs,
      error: isError,
    });
  }

  end(responseText: string, error?: string): void {
    // Strip internal tool-marker tokens emitted by the provider (<<tool:navigate:...>>)
    const clean = responseText.replace(/<<tool:[^>]+>>\n?/g, "").trim();
    appendTrace({
      id: this.id,
      ts: this.startTs,
      query: this.query,
      url: this.url,
      title: this.title,
      tool_calls: this.toolCalls,
      response: clean.slice(0, 8000),
      duration_ms: Date.now() - this.startTime,
      status: error ? "error" : "ok",
      ...(error ? { error } : {}),
    });
  }
}

export function createTraceSession(
  query: string,
  url: string,
  title: string,
): TraceSession {
  return new TraceSession(query, url, title);
}
