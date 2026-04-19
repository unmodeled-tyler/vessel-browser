#!/usr/bin/env node
/**
 * Vessel Browser — Extraction Demo
 *
 * Shows what an AI agent actually "sees" when it reads a webpage through
 * Vessel's MCP tools. Run with Vessel open and a page loaded.
 *
 * Usage:
 *   node scripts/demo-extraction.mjs                   # interactive demo
 *   node scripts/demo-extraction.mjs --mode full       # single mode
 *   node scripts/demo-extraction.mjs --list-tools      # list all MCP tools
 *   node scripts/demo-extraction.mjs --url https://... # navigate first, then extract
 *   node scripts/demo-extraction.mjs --all             # run all modes sequentially
 *   node scripts/demo-extraction.mjs --save            # save output to demo-output/
 */

import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

// ── Config ──────────────────────────────────────────────────────────────────

const MCP_URL = process.env.VESSEL_MCP_URL || "http://127.0.0.1:3100/mcp";

const EXTRACT_MODES = [
  {
    name: "full",
    label: "Full Extraction",
    desc: "Complete page structure + content — everything the agent sees",
  },
  {
    name: "summary",
    label: "Summary",
    desc: "Compact overview: title, headings, stats — for initial page assessment",
  },
  {
    name: "interactives_only",
    label: "Interactive Elements",
    desc: "Buttons, links, inputs with [#index] IDs — what the agent can click/type",
  },
  {
    name: "forms_only",
    label: "Forms Only",
    desc: "Form structure and fields — what the agent uses to fill out forms",
  },
  {
    name: "text_only",
    label: "Text Only",
    desc: "Raw page text, no structural metadata — for content-heavy reading",
  },
  {
    name: "visible_only",
    label: "Visible Only",
    desc: "Only currently visible, unobstructed elements — the agent's viewport",
  },
  {
    name: "results_only",
    label: "Results Only",
    desc: "Detected search/result links — for parsing search engine results",
  },
];

// ── ANSI Helpers ────────────────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
  bgCyan: "\x1b[46m",
};

function banner(text) {
  const pad = 2;
  const line = "─".repeat(text.length + pad * 2);
  console.log();
  console.log(`${c.cyan}  ┌${line}┐${c.reset}`);
  console.log(`${c.cyan}  │${" ".repeat(pad)}${c.bold}${c.white}${text}${c.reset}${c.cyan}${" ".repeat(pad)}│${c.reset}`);
  console.log(`${c.cyan}  └${line}┘${c.reset}`);
  console.log();
}

function sectionHeader(text) {
  console.log();
  console.log(`${c.bold}${c.magenta}  ▸ ${text}${c.reset}`);
  console.log(`${c.dim}  ${"─".repeat(text.length + 2)}${c.reset}`);
}

function info(text) {
  console.log(`${c.dim}  ${text}${c.reset}`);
}

function success(text) {
  console.log(`${c.green}  ✓ ${text}${c.reset}`);
}

function warn(text) {
  console.log(`${c.yellow}  ! ${text}${c.reset}`);
}

function error(text) {
  console.error(`${c.red}  ✗ ${text}${c.reset}`);
}

function printExtraction(text, maxLines = 0) {
  const lines = text.split("\n");
  const display = maxLines > 0 ? lines.slice(0, maxLines) : lines;

  console.log(`${c.dim}  ┌${"─".repeat(76)}┐${c.reset}`);
  for (const line of display) {
    // Colorize structural elements for readability
    let styled = line;
    // Section headers
    if (/^#{1,3}\s/.test(styled)) {
      styled = `${c.bold}${c.cyan}${styled}${c.reset}`;
    }
    // Bold markers
    else if (/^\*\*/.test(styled.trim())) {
      styled = `${c.bold}${c.yellow}${styled}${c.reset}`;
    }
    // Interactive element indices [#N]
    else if (/\[#\d+\]/.test(styled)) {
      styled = styled.replace(
        /\[#(\d+)\]/g,
        `${c.green}[#$1]${c.reset}`,
      );
    }
    // Links with arrows
    else if (/→/.test(styled)) {
      styled = styled.replace(
        /→\s*(.*)/,
        `${c.dim}→ ${c.blue}$1${c.reset}`,
      );
    }
    console.log(`${c.dim}  │${c.reset} ${styled}`);
  }

  if (maxLines > 0 && lines.length > maxLines) {
    console.log(
      `${c.dim}  │ ... (${lines.length - maxLines} more lines)${c.reset}`,
    );
  }
  console.log(`${c.dim}  └${"─".repeat(76)}┘${c.reset}`);
  info(`${lines.length} lines, ${text.length} characters`);
}

// ── MCP Client ──────────────────────────────────────────────────────────────

let requestId = 0;

async function mcpCall(method, params = {}) {
  requestId++;
  const body = {
    jsonrpc: "2.0",
    id: requestId,
    method,
    params,
  };

  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status}: ${res.statusText}`);
  }

  const contentType = res.headers.get("content-type") || "";

  // StreamableHTTP can return SSE or JSON
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    // Parse SSE events — find the last "data:" line with our response
    const events = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => {
        try {
          return JSON.parse(l.slice(5).trim());
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    // Find the response matching our request ID
    const match = events.find((e) => e.id === requestId);
    if (match) return match;
    // Or return the last event (often the result)
    return events[events.length - 1] || { error: "No SSE response parsed" };
  }

  return res.json();
}

async function mcpInitialize() {
  return mcpCall("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "vessel-demo", version: "1.0.0" },
  });
}

async function mcpToolCall(toolName, args = {}) {
  // StreamableHTTP stateless — need to initialize + call per connection
  // But vessel creates a new server per request, so just try the tool call directly
  // If that fails, try with initialize first
  try {
    const result = await mcpCall("tools/call", { name: toolName, arguments: args });
    if (result.error && result.error.code === -32600) {
      // Server requires initialization — retry with init
      await mcpInitialize();
      return mcpCall("tools/call", { name: toolName, arguments: args });
    }
    return result;
  } catch (e) {
    throw e;
  }
}

async function mcpListTools() {
  try {
    const result = await mcpCall("tools/list", {});
    if (result.error && result.error.code === -32600) {
      await mcpInitialize();
      return mcpCall("tools/list", {});
    }
    return result;
  } catch (e) {
    throw e;
  }
}

function extractText(result) {
  if (result?.result?.content) {
    return result.result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  if (result?.error) {
    throw new Error(
      `MCP error ${result.error.code}: ${result.error.message}`,
    );
  }
  return JSON.stringify(result, null, 2);
}

// ── Demo Routines ───────────────────────────────────────────────────────────

async function checkConnection() {
  try {
    const result = await mcpListTools();
    const tools = result?.result?.tools || [];
    return tools;
  } catch (e) {
    return null;
  }
}

async function demoListTools() {
  sectionHeader("All MCP Tools Exposed by Vessel");
  info("These tools are what the agent can call through MCP:\n");

  const tools = await checkConnection();
  if (!tools) {
    error("Could not connect to Vessel MCP server");
    return;
  }

  const categories = {};
  for (const tool of tools) {
    const prefix = tool.name.replace(/^vessel_/, "").split("_")[0];
    const cat =
      prefix === "extract" || prefix === "read"
        ? "Page Content"
        : prefix === "bookmark" || prefix === "create" || prefix === "folder"
          ? "Bookmarks"
          : prefix === "memory"
            ? "Memory (Obsidian)"
            : prefix === "save" || prefix === "load" || prefix === "list" || prefix === "delete"
              ? "Sessions"
              : prefix === "navigate" || prefix === "go" || prefix === "reload"
                ? "Navigation"
                : prefix === "click" || prefix === "type" || prefix === "press" || prefix === "select" || prefix === "submit"
                  ? "Interaction"
                  : prefix === "scroll" || prefix === "dismiss" || prefix === "wait"
                    ? "Page Control"
                    : prefix === "screenshot" || prefix === "highlight" || prefix === "clear"
                      ? "Visual"
                      : prefix === "checkpoint" || prefix === "restore"
                        ? "Checkpoints"
                        : prefix === "tab" || prefix === "switch" || prefix === "close"
                          ? "Tabs"
                          : "Other";

    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(tool);
  }

  for (const [cat, catTools] of Object.entries(categories).sort()) {
    console.log(`\n${c.bold}${c.cyan}  ${cat}${c.reset}`);
    for (const tool of catTools) {
      const desc =
        tool.description && tool.description.length > 70
          ? tool.description.slice(0, 67) + "..."
          : tool.description || "";
      console.log(
        `    ${c.green}${tool.name.padEnd(35)}${c.reset} ${c.dim}${desc}${c.reset}`,
      );
    }
  }

  console.log(`\n${c.bold}  Total: ${tools.length} tools${c.reset}`);
}

async function demoExtractMode(mode, previewLines = 60) {
  const modeInfo = EXTRACT_MODES.find((m) => m.name === mode) || {
    label: mode,
    desc: "",
  };

  sectionHeader(`${modeInfo.label} (mode: "${mode}")`);
  info(modeInfo.desc);
  console.log();

  const start = performance.now();
  const result = await mcpToolCall("vessel_extract_content", { mode });
  const elapsed = (performance.now() - start).toFixed(0);
  const text = extractText(result);

  success(`Extracted in ${elapsed}ms`);
  console.log();
  printExtraction(text, previewLines);

  return text;
}

async function demoNavigation(url) {
  sectionHeader(`Navigating to ${url}`);
  const start = performance.now();
  const result = await mcpToolCall("vessel_navigate", { url });
  const elapsed = (performance.now() - start).toFixed(0);
  const text = extractText(result);
  success(`${text} (${elapsed}ms)`);
  // Let the page settle
  await new Promise((r) => setTimeout(r, 2000));
}

async function demoTabs() {
  sectionHeader("Open Tabs");
  const result = await mcpToolCall("vessel_list_tabs");
  const text = extractText(result);
  printExtraction(text);
}

async function demoBookmarks() {
  sectionHeader("Bookmarks");
  const result = await mcpToolCall("vessel_bookmark_list");
  const text = extractText(result);
  printExtraction(text);
}

async function demoSessions() {
  sectionHeader("Saved Sessions");
  const result = await mcpToolCall("vessel_list_sessions");
  const text = extractText(result);
  printExtraction(text);
}

// ── Interactive Menu ────────────────────────────────────────────────────────

function createPrompt() {
  return createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function interactiveMenu() {
  banner("Vessel Browser — Agent Extraction Demo");

  info("This demo shows what an AI agent actually \"sees\" when it reads a");
  info("webpage through Vessel's MCP tools. The agent doesn't see pixels —");
  info("it sees structured text describing the page's content, interactive");
  info("elements, forms, navigation, and metadata.");
  console.log();

  // Check connection
  process.stdout.write(`${c.dim}  Connecting to ${MCP_URL}...${c.reset}`);
  const tools = await checkConnection();
  if (!tools) {
    console.log();
    error(`Cannot connect to Vessel MCP server at ${MCP_URL}`);
    error("Make sure Vessel is running: npx electron .");
    process.exit(1);
  }
  console.log(` ${c.green}connected${c.reset} (${tools.length} tools)\n`);

  const rl = createPrompt();

  while (true) {
    console.log(`\n${c.bold}  What would you like to see?${c.reset}\n`);
    console.log(`${c.cyan}  Extraction Modes:${c.reset}`);
    for (let i = 0; i < EXTRACT_MODES.length; i++) {
      const m = EXTRACT_MODES[i];
      console.log(
        `    ${c.green}${i + 1}${c.reset})  ${m.label.padEnd(24)} ${c.dim}${m.desc}${c.reset}`,
      );
    }
    console.log(`\n${c.cyan}  Other:${c.reset}`);
    console.log(`    ${c.green}a${c.reset})  Run all modes sequentially`);
    console.log(`    ${c.green}t${c.reset})  List all MCP tools`);
    console.log(`    ${c.green}T${c.reset})  Show open tabs`);
    console.log(`    ${c.green}b${c.reset})  Show bookmarks`);
    console.log(`    ${c.green}s${c.reset})  Show saved sessions`);
    console.log(`    ${c.green}n${c.reset})  Navigate to a URL`);
    console.log(`    ${c.green}q${c.reset})  Quit`);
    console.log();

    const choice = await ask(rl, `${c.bold}  > ${c.reset}`);

    try {
      if (choice === "q" || choice === "quit" || choice === "exit") {
        info("Bye!");
        rl.close();
        break;
      }

      const modeIndex = parseInt(choice, 10);
      if (modeIndex >= 1 && modeIndex <= EXTRACT_MODES.length) {
        await demoExtractMode(EXTRACT_MODES[modeIndex - 1].name);
      } else if (choice === "a") {
        for (const mode of EXTRACT_MODES) {
          await demoExtractMode(mode.name, 40);
          console.log();
          await new Promise((r) => setTimeout(r, 500));
        }
      } else if (choice === "t") {
        await demoListTools();
      } else if (choice === "T") {
        await demoTabs();
      } else if (choice === "b") {
        await demoBookmarks();
      } else if (choice === "s") {
        await demoSessions();
      } else if (choice === "n") {
        const url = await ask(rl, `${c.dim}  URL: ${c.reset}`);
        if (url) {
          await demoNavigation(url);
          await demoExtractMode("summary");
        }
      } else {
        warn(`Unknown option: "${choice}"`);
      }
    } catch (e) {
      error(e.message);
    }
  }
}

// ── Non-Interactive Modes ───────────────────────────────────────────────────

async function runAllModes(url, save) {
  banner("Vessel Browser — Full Extraction Demo");

  process.stdout.write(`${c.dim}  Connecting to ${MCP_URL}...${c.reset}`);
  const tools = await checkConnection();
  if (!tools) {
    console.log();
    error(`Cannot connect to Vessel MCP server at ${MCP_URL}`);
    process.exit(1);
  }
  console.log(` ${c.green}connected${c.reset} (${tools.length} tools)`);

  if (url) {
    await demoNavigation(url);
  }

  await demoTabs();

  const outputs = {};

  for (const mode of EXTRACT_MODES) {
    const text = await demoExtractMode(mode.name, 50);
    outputs[mode.name] = text;
    console.log();
    await new Promise((r) => setTimeout(r, 300));
  }

  if (save) {
    const outDir = join(PROJECT_ROOT, "demo-output");
    mkdirSync(outDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

    for (const [mode, text] of Object.entries(outputs)) {
      const filename = `extraction-${mode}-${timestamp}.txt`;
      writeFileSync(join(outDir, filename), text);
      success(`Saved ${filename}`);
    }

    // Also save a combined file with all modes
    const combined = Object.entries(outputs)
      .map(([mode, text]) => {
        const modeInfo = EXTRACT_MODES.find((m) => m.name === mode);
        return `${"=".repeat(80)}\n${(modeInfo?.label || mode).toUpperCase()} (mode: "${mode}")\n${modeInfo?.desc || ""}\n${"=".repeat(80)}\n\n${text}`;
      })
      .join("\n\n\n");
    const combinedFile = `extraction-all-modes-${timestamp}.txt`;
    writeFileSync(join(outDir, combinedFile), combined);
    success(`Saved combined: ${combinedFile}`);
  }
}

async function runSingleMode(mode) {
  banner(`Vessel Browser — ${mode} Extraction`);

  process.stdout.write(`${c.dim}  Connecting to ${MCP_URL}...${c.reset}`);
  const tools = await checkConnection();
  if (!tools) {
    console.log();
    error(`Cannot connect to Vessel MCP server at ${MCP_URL}`);
    process.exit(1);
  }
  console.log(` ${c.green}connected${c.reset}`);

  await demoExtractMode(mode);
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { mode: null, url: null, all: false, save: false, listTools: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--mode":
      case "-m":
        opts.mode = args[++i];
        break;
      case "--url":
      case "-u":
        opts.url = args[++i];
        break;
      case "--all":
      case "-a":
        opts.all = true;
        break;
      case "--save":
      case "-s":
        opts.save = true;
        break;
      case "--list-tools":
      case "-l":
        opts.listTools = true;
        break;
      case "--help":
      case "-h":
        console.log(`
Vessel Browser — Extraction Demo

Usage:
  node scripts/demo-extraction.mjs              Interactive menu
  node scripts/demo-extraction.mjs --all        Run all extraction modes
  node scripts/demo-extraction.mjs -m full      Single extraction mode
  node scripts/demo-extraction.mjs -u URL       Navigate then extract
  node scripts/demo-extraction.mjs --save       Save outputs to demo-output/
  node scripts/demo-extraction.mjs -l           List all MCP tools

Options:
  -m, --mode <mode>   Extraction mode: full, summary, interactives_only,
                       forms_only, text_only, visible_only, results_only
  -u, --url <url>     Navigate to URL before extracting
  -a, --all           Run all extraction modes
  -s, --save          Save extraction output to demo-output/
  -l, --list-tools    List all Vessel MCP tools
  -h, --help          Show this help

Environment:
  VESSEL_MCP_URL      MCP endpoint (default: http://127.0.0.1:3100/mcp)

Examples:
  # Interactive demo (great for live recording)
  node scripts/demo-extraction.mjs

  # Navigate to GitHub and show all extraction modes
  node scripts/demo-extraction.mjs --all --url https://github.com/anthropics

  # Save a full extraction of the current page
  node scripts/demo-extraction.mjs -m full --save

  # Quick look at interactive elements
  node scripts/demo-extraction.mjs -m interactives_only
`);
        process.exit(0);
      default:
        // If it looks like a mode name, use it
        if (EXTRACT_MODES.some((m) => m.name === args[i])) {
          opts.mode = args[i];
        }
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs();

  try {
    if (opts.listTools) {
      banner("Vessel Browser — MCP Tool Catalog");
      process.stdout.write(`${c.dim}  Connecting to ${MCP_URL}...${c.reset}`);
      const tools = await checkConnection();
      if (!tools) {
        console.log();
        error(`Cannot connect to Vessel MCP server at ${MCP_URL}`);
        process.exit(1);
      }
      console.log(` ${c.green}connected${c.reset}`);
      await demoListTools();
    } else if (opts.all || opts.save) {
      await runAllModes(opts.url, opts.save);
    } else if (opts.mode) {
      if (opts.url) {
        process.stdout.write(`${c.dim}  Connecting to ${MCP_URL}...${c.reset}`);
        const tools = await checkConnection();
        if (!tools) {
          console.log();
          error(`Cannot connect to Vessel MCP server at ${MCP_URL}`);
          process.exit(1);
        }
        console.log(` ${c.green}connected${c.reset}`);
        await demoNavigation(opts.url);
      }
      await runSingleMode(opts.mode);
    } else {
      await interactiveMenu();
    }
  } catch (e) {
    if (e.code === "ECONNREFUSED") {
      error(`Connection refused at ${MCP_URL}`);
      error("Is Vessel running? Launch it with: npx electron .");
    } else {
      error(e.message);
    }
    process.exit(1);
  }
}

main();
