import { z } from "zod";
import type { PageType } from "../ai/context-builder";
import {
  normalizedOptionalStringSchema,
  optionalNumberLikeSchema,
  stringArrayLikeSchema,
} from "./input-coercion";

export interface ToolDefinition {
  /** Base name without prefix, e.g. "navigate" */
  name: string;
  /** Human-readable title for MCP */
  title: string;
  /** Description shared by both systems */
  description: string;
  /** Zod shape for parameters. Omit for zero-parameter tools. */
  inputSchema?: z.ZodRawShape;
  /** If true, only register for MCP (not internal AI). */
  mcpOnly?: boolean;
  /** Page types where this tool is most relevant. Omit = always relevant (core tool). */
  relevance?: PageType[];
  /** Priority tier: 0 = core (always first), 1 = contextual, 2 = utility (deprioritized when irrelevant). Default 1. */
  tier?: 0 | 1 | 2;
  /** If true, hide from the default AI tool belt unless explicitly surfaced by intent. */
  hiddenByDefault?: boolean;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // --- Tab Management ---
  {
    name: "current_tab",
    title: "Get Active Tab",
    description:
      "Get the browser tab the human is actively looking at right now. Use this instead of list_tabs when you only need the focused tab.",
    tier: 0,
  },
  {
    name: "list_tabs",
    title: "List Tabs",
    description: "List all open browser tabs with their IDs, titles, and URLs.",
    tier: 2,
  },
  {
    name: "switch_tab",
    title: "Switch Tab",
    description:
      "Switch to a browser tab by tab ID, or by matching part of the title or URL.",
    inputSchema: {
      tabId: z.string().optional().describe("Exact tab ID to switch to"),
      match: z
        .string()
        .optional()
        .describe("Case-insensitive partial match against tab title or URL"),
    },
    tier: 2,
  },
  {
    name: "create_tab",
    title: "Create Tab",
    description: "Open a new browser tab, optionally navigating to a URL.",
    inputSchema: {
      url: z.string().optional().describe("Optional URL to open"),
    },
    tier: 2,
  },

  // --- Navigation ---
  {
    name: "navigate",
    title: "Navigate",
    description:
      "Navigate the browser to a URL. Use postBody to submit data via POST request (e.g. form submissions).",
    inputSchema: {
      url: z.string().describe("The URL to navigate to"),
      postBody: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          "Optional form fields to submit via POST (application/x-www-form-urlencoded). Only supported on http/https URLs.",
        ),
    },
    tier: 0,
  },
  {
    name: "go_back",
    title: "Go Back",
    description: "Go back to the previous page in browser history.",
    tier: 1,
  },
  {
    name: "go_forward",
    title: "Go Forward",
    description: "Go forward in browser history.",
    tier: 2,
  },
  {
    name: "reload",
    title: "Reload",
    description: "Reload the current page.",
    tier: 2,
  },

  // --- Interaction ---
  {
    name: "click",
    title: "Click Element",
    description:
      "Click an element on the page by its index number, CSS selector, or visible text/section name. If you know the label on the page but not the index yet, pass text instead of guessing a selector.",
    inputSchema: {
      index: z
        .number()
        .optional()
        .describe("Element index from the page content listing"),
      selector: z.string().optional().describe("CSS selector as fallback"),
      text: z
        .string()
        .optional()
        .describe("Visible label, link text, button text, or section name to match"),
    },
    tier: 0,
  },
  {
    name: "type_text",
    title: "Type Text",
    description:
      "Type text into an input field or textarea. Clears existing content first.",
    inputSchema: {
      index: z.number().optional().describe("The element index number"),
      selector: z.string().optional().describe("CSS selector as fallback"),
      text: z.string().describe("The text to type"),
      mode: z
        .enum(["default", "keystroke"])
        .optional()
        .describe(
          '"default" sets value directly. "keystroke" simulates character-by-character key events.',
        ),
    },
    tier: 0,
    relevance: ["LOGIN", "FORM", "SEARCH_READY"],
  },
  {
    name: "select_option",
    title: "Select Option",
    description:
      "Select an option in a <select> dropdown by visible label or option value. Only works on <select> elements — for checkboxes or radio buttons use click instead.",
    inputSchema: {
      index: z.number().optional().describe("The select element index number"),
      selector: z.string().optional().describe("CSS selector as fallback"),
      label: z.string().optional().describe("Visible option label to match"),
      value: z.string().optional().describe("Option value attribute to match"),
    },
    tier: 1,
    relevance: ["FORM", "SHOPPING"],
  },
  {
    name: "submit_form",
    title: "Submit Form",
    description:
      "Submit a form using a field index, submit button index, form selector, or button selector.",
    inputSchema: {
      index: z
        .number()
        .optional()
        .describe("Index of a form field or submit button"),
      selector: z
        .string()
        .optional()
        .describe("Form or submit button selector"),
    },
    tier: 1,
    relevance: ["LOGIN", "FORM", "SEARCH_READY", "SHOPPING"],
  },
  {
    name: "press_key",
    title: "Press Key",
    description: "Press a keyboard key, optionally after focusing an element.",
    inputSchema: {
      key: z.string().describe("Keyboard key such as Enter or Escape"),
      index: z.number().optional().describe("Element index to focus first"),
      selector: z.string().optional().describe("CSS selector to focus first"),
    },
    tier: 1,
  },
  {
    name: "scroll",
    title: "Scroll",
    description: "Scroll the page up or down.",
    inputSchema: {
      direction: z.enum(["up", "down"]).describe("Scroll direction"),
      amount: optionalNumberLikeSchema().describe(
        "Pixels to scroll (default 500)",
      ),
    },
    tier: 0,
    relevance: ["ARTICLE", "SEARCH_RESULTS", "PAGINATED_LIST"],
  },
  {
    name: "hover",
    title: "Hover Element",
    description:
      "Move the mouse pointer over an element to trigger hover states, tooltips, or dropdown menus.",
    inputSchema: {
      index: z.number().optional().describe("Element index number"),
      selector: z.string().optional().describe("CSS selector as fallback"),
    },
    tier: 2,
  },
  {
    name: "focus",
    title: "Focus Element",
    description:
      "Focus an input, button, or interactive element. Useful before pressing keys or to trigger focus-dependent UI.",
    inputSchema: {
      index: z.number().optional().describe("Element index number"),
      selector: z.string().optional().describe("CSS selector as fallback"),
    },
    tier: 2,
    relevance: ["FORM", "LOGIN"],
  },

  // --- Page & Content ---
  {
    name: "set_ad_blocking",
    title: "Set Ad Blocking",
    description:
      "Enable or disable ad blocking for the active tab or a matched tab. Reload after changes unless reload is false.",
    inputSchema: {
      enabled: z
        .boolean()
        .describe("Whether ad blocking should be enabled for the tab"),
      tabId: z
        .string()
        .optional()
        .describe("Exact tab ID to target instead of the active tab"),
      match: z
        .string()
        .optional()
        .describe("Case-insensitive partial match against tab title or URL"),
      reload: z
        .boolean()
        .optional()
        .describe("Reload the tab after changing (default true)"),
    },
    tier: 2,
  },
  {
    name: "dismiss_popup",
    title: "Dismiss Popup",
    description:
      "Dismiss a modal, popup, newsletter gate, cookie banner, or overlay using common close/decline actions.",
    tier: 1,
  },
  {
    name: "clear_overlays",
    title: "Clear Overlays",
    description:
      "Work through blocking overlays and modals until the page is unblocked, using overlay-specific heuristics for consent banners and radio-selection dialogs.",
    inputSchema: {
      strategy: z
        .enum(["auto", "interactive"])
        .optional()
        .describe(
          'How aggressively to clear overlays. "auto" uses heuristics; "interactive" stops earlier when human judgment may be needed.',
        ),
    },
    tier: 1,
  },
  {
    name: "inspect_element",
    title: "Inspect Element",
    description:
      "Inspect one element and its nearest local UI region such as a product card, result row, form section, or modal. You can target it by index, selector, or visible text/section name when you know what it says but not where it is.",
    inputSchema: {
      index: z.number().optional().describe("Element index to inspect"),
      selector: z.string().optional().describe("CSS selector to inspect"),
      text: z
        .string()
        .optional()
        .describe("Visible label or section text to locate before inspecting"),
      limit: z
        .number()
        .optional()
        .describe("Maximum nearby controls to include (default 8)"),
    },
    tier: 1,
    relevance: ["SEARCH_RESULTS", "SHOPPING", "FORM"],
  },
  {
    name: "read_page",
    title: "Read Page",
    description:
      "Read the current page using a scoped mode. Defaults to a minimal navigation-focused brief; use mode='debug' only when narrower modes are insufficient.",
    inputSchema: {
      mode: z
        .enum([
          "glance",
          "summary",
          "interactives_only",
          "forms_only",
          "text_only",
          "visible_only",
          "results_only",
          "full",
          "debug",
        ])
        .optional()
        .describe(
          "Read mode: glance (fastest — viewport snapshot, no JS extraction, ideal for heavy pages), visible_only/results_only/forms_only/summary/text_only for narrow reads, full/debug for the complete page dump",
        ),
    },
    tier: 0,
  },
  {
    name: "screenshot",
    title: "Screenshot",
    description:
      "Take a screenshot of the current page — see exactly what the user sees. Returns the image for visual analysis. Use when you need to verify visual layout, check what's actually rendered on screen, or when text extraction fails on heavy pages.",
    inputSchema: {},
    tier: 1,
  },
  {
    name: "wait_for",
    title: "Wait For",
    description:
      "Wait for a text string or CSS selector to appear on the page before continuing.",
    inputSchema: {
      text: z
        .string()
        .optional()
        .describe("Text that should appear in the page body"),
      selector: z
        .string()
        .optional()
        .describe("CSS selector that should match an element"),
      timeoutMs: z
        .number()
        .optional()
        .describe("Maximum time to wait in milliseconds (default 5000)"),
    },
    tier: 2,
  },

  // --- Checkpoints & Sessions ---
  {
    name: "create_checkpoint",
    title: "Create Checkpoint",
    description:
      "Capture the current browser session as a named checkpoint for later recovery.",
    inputSchema: {
      name: z.string().optional().describe("Short checkpoint name"),
      note: z
        .string()
        .optional()
        .describe("Optional note about why this checkpoint matters"),
    },
    tier: 2,
  },
  {
    name: "restore_checkpoint",
    title: "Restore Checkpoint",
    description: "Restore a previously captured checkpoint by name or ID.",
    inputSchema: {
      checkpointId: z.string().optional().describe("Exact checkpoint ID"),
      name: z
        .string()
        .optional()
        .describe("Checkpoint name to match if ID is unknown"),
    },
    tier: 2,
  },
  {
    name: "save_session",
    title: "Save Session",
    description:
      "Persist the current browser cookies, localStorage, and tab layout under a reusable session name.",
    inputSchema: {
      name: z.string().describe("Session name such as github-logged-in"),
    },
    tier: 2,
    relevance: ["LOGIN"],
  },
  {
    name: "load_session",
    title: "Load Session",
    description:
      "Load a previously saved named session, restoring cookies, localStorage, and saved tabs.",
    inputSchema: {
      name: z.string().describe("Previously saved session name"),
    },
    tier: 2,
  },
  {
    name: "list_sessions",
    title: "List Sessions",
    description:
      "List previously saved named browser sessions with cookie and storage counts.",
    tier: 2,
  },
  {
    name: "delete_session",
    title: "Delete Session",
    description: "Delete a previously saved named browser session.",
    inputSchema: {
      name: z.string().describe("Saved session name to delete"),
    },
    tier: 2,
  },

  // --- Bookmarks ---
  {
    name: "list_bookmarks",
    title: "List Bookmarks",
    description:
      "List bookmark folders and saved pages. Optionally filter by folder name or ID.",
    inputSchema: {
      folderId: z
        .string()
        .optional()
        .describe("Exact bookmark folder ID to filter by"),
      folderName: z
        .string()
        .optional()
        .describe("Exact bookmark folder name to filter by"),
    },
    tier: 2,
  },
  {
    name: "search_bookmarks",
    title: "Search Bookmarks",
    description:
      "Search bookmarks by title, URL, note, folder name, or folder summary.",
    inputSchema: {
      query: z
        .string()
        .describe("Search term to match against saved bookmarks"),
    },
    tier: 2,
  },
  {
    name: "create_bookmark_folder",
    title: "Create Bookmark Folder",
    description:
      "Create a bookmark folder for organizing saved pages. Returns existing folder if the same name exists.",
    inputSchema: {
      name: z.string().describe("Folder name to create"),
      summary: z
        .string()
        .optional()
        .describe("Optional one-sentence summary for this folder"),
    },
    tier: 2,
  },
  {
    name: "save_bookmark",
    title: "Save Bookmark",
    description:
      "Save the current page, a specified URL, or a link target from the current page as a bookmark.",
    inputSchema: {
      url: z
        .string()
        .optional()
        .describe("URL to save. Omit to save the current page."),
      title: z.string().optional().describe("Title for the bookmark"),
      index: z
        .number()
        .optional()
        .describe("Element index of a link to bookmark without opening"),
      selector: z
        .string()
        .optional()
        .describe("CSS selector of a link to bookmark without opening"),
      folderId: z.string().optional().describe("Folder ID to save into"),
      folderName: z
        .string()
        .optional()
        .describe(
          "Folder name to save into. Created automatically if missing.",
        ),
      folderSummary: z
        .string()
        .optional()
        .describe("Optional summary used if a new folder is created"),
      createFolderIfMissing: z
        .boolean()
        .optional()
        .describe("Create folderName automatically when it does not exist"),
      note: z
        .string()
        .optional()
        .describe("Optional note about why the page was saved"),
      onDuplicate: z
        .enum(["ask", "update", "duplicate"])
        .optional()
        .describe("How to handle duplicate URLs in the same folder"),
      intent: z
        .string()
        .optional()
        .describe(
          "Human-readable description of what this bookmark is for (e.g. 'expense reporting')",
        ),
      expectedContent: z
        .string()
        .optional()
        .describe(
          "Brief description of the content the agent should expect to find here",
        ),
      keyFields: z
        .array(z.string())
        .optional()
        .describe(
          "Important form field names for this page (e.g. ['receipt_id', 'date', 'amount'])",
        ),
      agentHints: z
        .record(z.string(), z.string())
        .optional()
        .describe("Arbitrary key-value hints for the agent"),
    },
    tier: 1,
  },
  {
    name: "organize_bookmark",
    title: "Organize Bookmark",
    description:
      "Move an existing bookmark or save the current page into a folder, creating the folder if needed.",
    inputSchema: {
      bookmarkId: z
        .string()
        .optional()
        .describe("Existing bookmark ID to move"),
      url: z.string().optional().describe("URL to organize"),
      title: z.string().optional().describe("Optional title"),
      index: z
        .number()
        .optional()
        .describe("Element index of a link to organize"),
      selector: z
        .string()
        .optional()
        .describe("CSS selector of a link to organize"),
      folderId: z.string().optional().describe("Target folder ID"),
      folderName: z
        .string()
        .optional()
        .describe("Target folder name. Created automatically if missing"),
      folderSummary: z
        .string()
        .optional()
        .describe("Optional summary for new folder"),
      createFolderIfMissing: z
        .boolean()
        .optional()
        .describe("Create folderName automatically when it does not exist"),
      note: z.string().optional().describe("Optional note"),
      archive: z
        .boolean()
        .optional()
        .describe('If true, organize into the default "Archive" folder'),
      intent: z
        .string()
        .optional()
        .describe("Human-readable description of what this bookmark is for"),
      expectedContent: z
        .string()
        .optional()
        .describe("Brief description of content the agent should expect"),
      keyFields: z
        .array(z.string())
        .optional()
        .describe("Important form field names for this page"),
      agentHints: z
        .record(z.string(), z.string())
        .optional()
        .describe("Arbitrary key-value hints for the agent"),
    },
    tier: 2,
  },
  {
    name: "archive_bookmark",
    title: "Archive Bookmark",
    description:
      'Archive the current page, a URL, a link target, or an existing bookmark into the "Archive" folder.',
    inputSchema: {
      bookmarkId: z
        .string()
        .optional()
        .describe("Existing bookmark ID to archive"),
      url: z.string().optional().describe("URL to archive"),
      title: z.string().optional().describe("Optional title"),
      index: z
        .number()
        .optional()
        .describe("Element index of a link to archive"),
      selector: z
        .string()
        .optional()
        .describe("CSS selector of a link to archive"),
      note: z.string().optional().describe("Optional note"),
    },
    tier: 2,
  },
  {
    name: "open_bookmark",
    title: "Open Bookmark",
    description:
      "Open a saved bookmark by its bookmark ID. Optionally open it in a new tab.",
    inputSchema: {
      bookmarkId: z.string().describe("Exact bookmark ID to open"),
      newTab: z
        .boolean()
        .optional()
        .describe("Open in a new tab instead of the current tab"),
    },
    tier: 2,
  },

  // --- Highlights ---
  {
    name: "highlight",
    title: "Highlight Element",
    description:
      "Visually highlight an element or text on the page for the user. Use to draw attention to specific content. Highlights persist until cleared.",
    inputSchema: {
      index: z
        .number()
        .optional()
        .describe("Element index from page content to highlight"),
      selector: z
        .string()
        .optional()
        .describe("CSS selector of element to highlight"),
      text: normalizedOptionalStringSchema().describe(
        "Text to find and highlight on the page (all occurrences)",
      ),
      label: z
        .string()
        .optional()
        .describe("Annotation label to display near the highlight"),
      durationMs: z
        .number()
        .optional()
        .describe(
          "Auto-clear after this many milliseconds (omit for permanent)",
        ),
      color: z
        .enum(["yellow", "red", "green", "blue", "purple", "orange"])
        .optional()
        .describe("Highlight color (default yellow)"),
    },
    tier: 1,
    relevance: ["ARTICLE", "SEARCH_RESULTS"],
  },
  {
    name: "clear_highlights",
    title: "Clear Highlights",
    description: "Remove all visual highlights from the current page.",
    tier: 2,
  },

  // --- Speedee System: Flow State ---
  {
    name: "flow_start",
    title: "Start Workflow",
    description:
      "Begin tracking a multi-step web workflow. Vessel will show progress after every action so you always know where you are.",
    inputSchema: {
      goal: z
        .string()
        .describe(
          "What this workflow accomplishes (e.g. 'Purchase item from Amazon')",
        ),
      steps: stringArrayLikeSchema().describe(
        "Ordered list of step labels (e.g. ['Log in', 'Search', 'Select item', 'Checkout'])",
      ),
    },
    tier: 1,
    hiddenByDefault: true,
  },
  {
    name: "flow_advance",
    title: "Advance Workflow Step",
    description:
      "Mark the current workflow step as done and move to the next one.",
    inputSchema: {
      detail: z
        .string()
        .optional()
        .describe("Brief note about what was accomplished"),
    },
    tier: 1,
    hiddenByDefault: true,
  },
  {
    name: "flow_status",
    title: "Workflow Status",
    description: "Check the current workflow progress.",
    tier: 2,
    hiddenByDefault: true,
  },
  {
    name: "flow_end",
    title: "End Workflow",
    description: "Clear the active workflow tracker.",
    tier: 2,
    hiddenByDefault: true,
  },

  // --- Undo ---
  {
    name: "undo_last_action",
    title: "Undo Last Action",
    description:
      "Undo the most recent agent action by restoring the browser to its state before that action ran. Works for click, type, submit, navigate, and similar mutating actions. Returns the name of the undone action, or an error if nothing can be undone.",
    tier: 1,
  },

  // --- Speedee System: Suggestion Engine ---
  {
    name: "suggest",
    title: "What Should I Do?",
    description:
      "Analyze the current page and return the most relevant tools and suggested next actions. Call this when unsure what to do.",
    tier: 1,
    hiddenByDefault: true,
  },

  // --- Speedee System: Composable Macros ---
  {
    name: "fill_form",
    title: "Fill Form",
    description:
      "Fill multiple form fields at once. Much faster than calling type_text for each field individually.",
    inputSchema: {
      fields: z
        .array(
          z.object({
            index: z
              .number()
              .optional()
              .describe("Element index from page content"),
            selector: z.string().optional().describe("CSS selector fallback"),
            name: z
              .string()
              .optional()
              .describe("Field name or id, such as custname"),
            label: z
              .string()
              .optional()
              .describe("Visible label or aria-label text"),
            placeholder: z
              .string()
              .optional()
              .describe("Placeholder text shown in the field"),
            value: z.string().describe("Value to enter"),
          }),
        )
        .describe(
          "Fields to fill, matched by index, selector, name, label, or placeholder",
        ),
      submit: z
        .boolean()
        .optional()
        .describe("Submit the form after filling (default false)"),
    },
    tier: 1,
    relevance: ["FORM", "LOGIN", "SHOPPING"],
  },
  {
    name: "login",
    title: "Login",
    description:
      "Compound action: navigate to a login page, fill credentials, and submit. Handles the full login flow in one call.",
    inputSchema: {
      url: z
        .string()
        .optional()
        .describe("Login page URL (skip if already on login page)"),
      username: z.string().describe("Username or email"),
      password: z.string().describe("Password"),
      username_selector: z
        .string()
        .optional()
        .describe("CSS selector for username field (auto-detected if omitted)"),
      password_selector: z
        .string()
        .optional()
        .describe("CSS selector for password field (auto-detected if omitted)"),
      submit_selector: z
        .string()
        .optional()
        .describe("CSS selector for submit button (auto-detected if omitted)"),
    },
    tier: 1,
    relevance: ["LOGIN"],
  },
  {
    name: "search",
    title: "Search",
    description:
      "Find a search box on the current page, type a query, and submit. Returns the resulting page state.",
    inputSchema: {
      query: z.string().describe("Search query text"),
      selector: z
        .string()
        .optional()
        .describe("CSS selector for search input (auto-detected if omitted)"),
    },
    tier: 1,
    relevance: ["SEARCH_READY", "SEARCH_RESULTS"],
  },
  {
    name: "paginate",
    title: "Paginate",
    description:
      "Navigate to the next or previous page of results. Auto-detects pagination controls.",
    inputSchema: {
      direction: z.enum(["next", "prev"]).describe("Pagination direction"),
      selector: z
        .string()
        .optional()
        .describe(
          "CSS selector for pagination link (auto-detected if omitted)",
        ),
    },
    tier: 1,
    relevance: ["SEARCH_RESULTS", "PAGINATED_LIST"],
  },

  // --- Speedee System: Expanded Macros ---
  {
    name: "accept_cookies",
    title: "Accept Cookies",
    description:
      "Dismiss cookie consent banners (OneTrust, CookieBot, GDPR popups, etc.). More targeted than dismiss_popup for consent-specific overlays.",
    tier: 1,
  },
  {
    name: "extract_table",
    title: "Extract Table",
    description:
      "Extract a table from the page as structured JSON rows. Returns column headers and cell values.",
    inputSchema: {
      index: z
        .number()
        .optional()
        .describe("Element index of the table to extract"),
      selector: z
        .string()
        .optional()
        .describe(
          "CSS selector for the table (auto-detected if omitted — uses first table)",
        ),
    },
    tier: 1,
    relevance: ["SEARCH_RESULTS", "ARTICLE"],
  },
  {
    name: "scroll_to_element",
    title: "Scroll To Element",
    description:
      "Scroll a specific element into view by index, selector, or visible text/section name. Useful for navigating to off-screen content when you know the heading or label you want.",
    inputSchema: {
      index: z.number().optional().describe("Element index to scroll to"),
      selector: z.string().optional().describe("CSS selector to scroll to"),
      text: z
        .string()
        .optional()
        .describe("Visible label or section text to scroll into view"),
      position: z
        .enum(["center", "top", "bottom"])
        .optional()
        .describe(
          "Where to position the element in the viewport (default center)",
        ),
    },
    tier: 1,
  },

  // --- Navigation Primitives ---
  {
    name: "wait_for_navigation",
    title: "Wait For Navigation",
    description:
      "Wait for the current page to finish loading after a click or form submission. Use when you clicked a link and need to wait for the new page before reading it.",
    inputSchema: {
      timeoutMs: z
        .number()
        .optional()
        .describe("Maximum time to wait in milliseconds (default 10000)"),
    },
    tier: 1,
    hiddenByDefault: true,
  },

  // --- Speedee System: Metrics ---
  {
    name: "metrics",
    title: "Session Metrics",
    description:
      "Show performance metrics for this session: total tool calls, average duration, per-tool breakdown, and error rates.",
    tier: 2,
    hiddenByDefault: true,
  },
];
