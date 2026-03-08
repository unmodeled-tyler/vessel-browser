import type Anthropic from "@anthropic-ai/sdk";

export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: "list_tabs",
    description: "List all open browser tabs with their IDs, titles, and URLs.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "switch_tab",
    description:
      "Switch to a browser tab by tab ID, or by matching part of the title or URL.",
    input_schema: {
      type: "object" as const,
      properties: {
        tabId: { type: "string", description: "Exact tab ID to switch to" },
        match: {
          type: "string",
          description:
            "Case-insensitive partial match against tab title or URL",
        },
      },
    },
  },
  {
    name: "create_tab",
    description: "Open a new browser tab, optionally navigating to a URL.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "Optional URL to open" },
      },
    },
  },
  {
    name: "navigate",
    description: "Navigate the browser to a URL.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "The URL to navigate to" },
      },
      required: ["url"],
    },
  },
  {
    name: "go_back",
    description: "Go back to the previous page in browser history.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "go_forward",
    description: "Go forward in browser history.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "reload",
    description: "Reload the current page.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "click",
    description:
      "Click an element on the page. Use the element index from the page content listing, or a CSS selector.",
    input_schema: {
      type: "object" as const,
      properties: {
        index: {
          type: "number",
          description: "The element index number from the page content",
        },
        selector: {
          type: "string",
          description: "CSS selector as fallback if index is not available",
        },
      },
    },
  },
  {
    name: "type_text",
    description:
      "Type text into an input field or textarea. Clears existing content first.",
    input_schema: {
      type: "object" as const,
      properties: {
        index: { type: "number", description: "The element index number" },
        selector: { type: "string", description: "CSS selector as fallback" },
        text: { type: "string", description: "The text to type" },
      },
      required: ["text"],
    },
  },
  {
    name: "scroll",
    description: "Scroll the page up or down.",
    input_schema: {
      type: "object" as const,
      properties: {
        direction: {
          type: "string",
          enum: ["up", "down"],
          description: "Scroll direction",
        },
        amount: {
          type: "number",
          description: "Pixels to scroll (default 500)",
        },
      },
      required: ["direction"],
    },
  },
  {
    name: "read_page",
    description:
      "Re-read the current page content. Use after navigation or interaction to see updated content.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "wait_for",
    description:
      "Wait for a text string or CSS selector to appear on the page before continuing.",
    input_schema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description: "Text that should appear in the page body",
        },
        selector: {
          type: "string",
          description: "CSS selector that should match an element",
        },
        timeoutMs: {
          type: "number",
          description: "Maximum time to wait in milliseconds (default 5000)",
        },
      },
    },
  },
  {
    name: "create_checkpoint",
    description:
      "Capture the current browser session as a named checkpoint for later recovery.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Short checkpoint name",
        },
        note: {
          type: "string",
          description: "Optional note about why this checkpoint matters",
        },
      },
    },
  },
  {
    name: "restore_checkpoint",
    description: "Restore a previously captured checkpoint by name or ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        checkpointId: {
          type: "string",
          description: "Exact checkpoint ID",
        },
        name: {
          type: "string",
          description: "Checkpoint name to match if ID is unknown",
        },
      },
    },
  },
];
