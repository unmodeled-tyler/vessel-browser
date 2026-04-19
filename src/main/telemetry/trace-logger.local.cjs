const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

function getTracesDir() {
  return path.join(app.getPath("userData"), "agent-traces");
}

function getTodayFile() {
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return path.join(getTracesDir(), `${ymd}.jsonl`);
}

function sanitizeOutput(output) {
  return output.replace(/"base64":"[A-Za-z0-9+/=]{100,}"/g, '"base64":"[stripped]"');
}

function appendTrace(entry) {
  try {
    const dir = getTracesDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(getTodayFile(), JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    console.warn("[trace-logger] Failed to write trace:", err);
  }
}

class TraceSession {
  constructor(query, url, title) {
    this.id = crypto.randomUUID();
    this.startTs = new Date().toISOString();
    this.startTime = Date.now();
    this.query = query;
    this.url = url;
    this.title = title;
    this.toolCalls = [];
  }

  logToolCall(tool, input, output, durationMs, isError = false) {
    this.toolCalls.push({
      ts: new Date().toISOString(),
      tool,
      input,
      output: sanitizeOutput(output).slice(0, 4000),
      duration_ms: durationMs,
      error: isError,
    });
  }

  end(responseText, error) {
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

function createTraceSession(query, url, title) {
  return new TraceSession(query, url, title);
}

module.exports = {
  createTraceSession,
};
