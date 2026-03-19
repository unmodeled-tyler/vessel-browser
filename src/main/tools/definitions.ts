import { z } from "zod";

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
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // --- Tab Management ---
  {
    name: "current_tab",
    title: "Get Active Tab",
    description:
      "Get the browser tab the human is actively looking at right now. Use this instead of list_tabs when you only need the focused tab.",
  },
  {
    name: "list_tabs",
    title: "List Tabs",
    description: "List all open browser tabs with their IDs, titles, and URLs.",
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
        .describe(
          "Case-insensitive partial match against tab title or URL",
        ),
    },
  },
  {
    name: "create_tab",
    title: "Create Tab",
    description: "Open a new browser tab, optionally navigating to a URL.",
    inputSchema: {
      url: z.string().optional().describe("Optional URL to open"),
    },
  },

  // --- Navigation ---
  {
    name: "navigate",
    title: "Navigate",
    description: "Navigate the browser to a URL.",
    inputSchema: {
      url: z.string().describe("The URL to navigate to"),
    },
  },
  {
    name: "go_back",
    title: "Go Back",
    description: "Go back to the previous page in browser history.",
  },
  {
    name: "go_forward",
    title: "Go Forward",
    description: "Go forward in browser history.",
  },
  {
    name: "reload",
    title: "Reload",
    description: "Reload the current page.",
  },

  // --- Interaction ---
  {
    name: "click",
    title: "Click Element",
    description:
      "Click an element on the page by its index number or CSS selector.",
    inputSchema: {
      index: z
        .number()
        .optional()
        .describe("Element index from the page content listing"),
      selector: z.string().optional().describe("CSS selector as fallback"),
    },
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
  },
  {
    name: "select_option",
    title: "Select Option",
    description:
      "Select an option in a dropdown by visible label or option value.",
    inputSchema: {
      index: z
        .number()
        .optional()
        .describe("The select element index number"),
      selector: z.string().optional().describe("CSS selector as fallback"),
      label: z.string().optional().describe("Visible option label to match"),
      value: z
        .string()
        .optional()
        .describe("Option value attribute to match"),
    },
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
  },
  {
    name: "press_key",
    title: "Press Key",
    description:
      "Press a keyboard key, optionally after focusing an element.",
    inputSchema: {
      key: z.string().describe("Keyboard key such as Enter or Escape"),
      index: z.number().optional().describe("Element index to focus first"),
      selector: z.string().optional().describe("CSS selector to focus first"),
    },
  },
  {
    name: "scroll",
    title: "Scroll",
    description: "Scroll the page up or down.",
    inputSchema: {
      direction: z.enum(["up", "down"]).describe("Scroll direction"),
      amount: z
        .number()
        .optional()
        .describe("Pixels to scroll (default 500)"),
    },
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
        .describe(
          "Case-insensitive partial match against tab title or URL",
        ),
      reload: z
        .boolean()
        .optional()
        .describe("Reload the tab after changing (default true)"),
    },
  },
  {
    name: "dismiss_popup",
    title: "Dismiss Popup",
    description:
      "Dismiss a modal, popup, newsletter gate, cookie banner, or overlay using common close/decline actions.",
  },
  {
    name: "read_page",
    title: "Read Page",
    description:
      "Re-read the current page content. Includes active text selection and visible unsaved highlights. Use after navigation or interaction to see updated content.",
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
  },
  {
    name: "save_session",
    title: "Save Session",
    description:
      "Persist the current browser cookies, localStorage, and tab layout under a reusable session name.",
    inputSchema: {
      name: z.string().describe("Session name such as github-logged-in"),
    },
  },
  {
    name: "load_session",
    title: "Load Session",
    description:
      "Load a previously saved named session, restoring cookies, localStorage, and saved tabs.",
    inputSchema: {
      name: z.string().describe("Previously saved session name"),
    },
  },
  {
    name: "list_sessions",
    title: "List Sessions",
    description:
      "List previously saved named browser sessions with cookie and storage counts.",
  },
  {
    name: "delete_session",
    title: "Delete Session",
    description: "Delete a previously saved named browser session.",
    inputSchema: {
      name: z.string().describe("Saved session name to delete"),
    },
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
      folderId: z
        .string()
        .optional()
        .describe("Folder ID to save into"),
      folderName: z
        .string()
        .optional()
        .describe("Folder name to save into. Created automatically if missing."),
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
    },
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
      folderId: z
        .string()
        .optional()
        .describe("Target folder ID"),
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
    },
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
        .describe("What this workflow accomplishes (e.g. 'Purchase item from Amazon')"),
      steps: z
        .array(z.string())
        .describe(
          "Ordered list of step labels (e.g. ['Log in', 'Search', 'Select item', 'Checkout'])",
        ),
    },
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
  },
  {
    name: "flow_status",
    title: "Workflow Status",
    description: "Check the current workflow progress.",
  },
  {
    name: "flow_end",
    title: "End Workflow",
    description: "Clear the active workflow tracker.",
  },

  // --- Speedee System: Suggestion Engine ---
  {
    name: "suggest",
    title: "What Should I Do?",
    description:
      "Analyze the current page and return the most relevant tools and suggested next actions. Call this when unsure what to do.",
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
            selector: z
              .string()
              .optional()
              .describe("CSS selector fallback"),
            value: z.string().describe("Value to enter"),
          }),
        )
        .describe("Fields to fill"),
      submit: z
        .boolean()
        .optional()
        .describe("Submit the form after filling (default false)"),
    },
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
        .describe("CSS selector for pagination link (auto-detected if omitted)"),
    },
  },
];
