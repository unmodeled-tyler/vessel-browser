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
    name: "select_option",
    description:
      "Select an option in a dropdown by visible label or option value.",
    input_schema: {
      type: "object" as const,
      properties: {
        index: {
          type: "number",
          description: "The select element index number",
        },
        selector: { type: "string", description: "CSS selector as fallback" },
        label: {
          type: "string",
          description: "Visible option label to match",
        },
        value: {
          type: "string",
          description: "Option value attribute to match",
        },
      },
    },
  },
  {
    name: "submit_form",
    description:
      "Submit a form using a field index, submit button index, form selector, or button selector.",
    input_schema: {
      type: "object" as const,
      properties: {
        index: {
          type: "number",
          description:
            "Index of a field or submit button inside the target form",
        },
        selector: {
          type: "string",
          description: "Form or submit button selector",
        },
      },
    },
  },
  {
    name: "press_key",
    description:
      "Press a keyboard key, optionally targeting a specific element first.",
    input_schema: {
      type: "object" as const,
      properties: {
        key: {
          type: "string",
          description: "Keyboard key, for example Enter or Escape",
        },
        index: { type: "number", description: "Element index to focus first" },
        selector: {
          type: "string",
          description: "CSS selector to focus first",
        },
      },
      required: ["key"],
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
    name: "set_ad_blocking",
    description:
      "Enable or disable ad blocking for the active tab or a matched tab. Reload after changes unless you explicitly set reload to false.",
    input_schema: {
      type: "object" as const,
      properties: {
        enabled: {
          type: "boolean",
          description: "Whether ad blocking should be enabled for the tab",
        },
        tabId: {
          type: "string",
          description: "Exact tab ID to target instead of the active tab",
        },
        match: {
          type: "string",
          description:
            "Case-insensitive partial match against tab title or URL",
        },
        reload: {
          type: "boolean",
          description:
            "Reload the tab after changing the setting (default true)",
        },
      },
      required: ["enabled"],
    },
  },
  {
    name: "dismiss_popup",
    description:
      "Dismiss a modal, popup, newsletter gate, cookie banner, or overlay using common close/decline actions.",
    input_schema: {
      type: "object" as const,
      properties: {},
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
  {
    name: "save_session",
    description:
      "Persist the current browser cookies, localStorage, and tab layout under a reusable session name.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Session name such as github-logged-in",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "load_session",
    description:
      "Load a previously saved named session, restoring cookies, localStorage, and saved tabs.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Previously saved session name",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "list_sessions",
    description:
      "List previously saved named browser sessions with cookie and storage counts.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "delete_session",
    description: "Delete a previously saved named browser session.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Saved session name to delete",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "list_bookmarks",
    description:
      "List bookmark folders and saved pages. Optionally filter by folder name or ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        folderId: {
          type: "string",
          description: "Exact bookmark folder ID to filter by",
        },
        folderName: {
          type: "string",
          description: "Exact bookmark folder name to filter by",
        },
      },
    },
  },
  {
    name: "search_bookmarks",
    description:
      "Search bookmarks by title, URL, note, folder name, or folder summary.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search term to match against saved bookmarks",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "create_bookmark_folder",
    description:
      "Create a bookmark folder for organizing saved pages. If the same folder already exists, return it instead of creating a duplicate.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Folder name to create",
        },
        summary: {
          type: "string",
          description:
            "Optional one-sentence summary shown in the UI for this folder",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "save_bookmark",
    description:
      "Save the current page or a specified URL as a bookmark. If folderName is provided and missing, create it automatically.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "URL to save. Omit to save the current page.",
        },
        title: {
          type: "string",
          description:
            "Title for the bookmark. Omit to use the current page title.",
        },
        folderId: {
          type: "string",
          description: "Folder ID to save into",
        },
        folderName: {
          type: "string",
          description:
            "Folder name to save into. Created automatically if missing.",
        },
        folderSummary: {
          type: "string",
          description: "Optional summary used if a new folder is created",
        },
        createFolderIfMissing: {
          type: "boolean",
          description:
            "Create folderName automatically when it does not exist",
        },
        note: {
          type: "string",
          description: "Optional note about why the page was saved",
        },
        onDuplicate: {
          type: "string",
          enum: ["ask", "update", "duplicate"],
          description:
            'How to handle an existing bookmark with the same URL in the same folder: "ask" (default), "update", or "duplicate".',
        },
      },
    },
  },
  {
    name: "organize_bookmark",
    description:
      'Organize a bookmark by intent: move an existing bookmark or save the current page/URL into a folder, creating the folder if needed. If archive is true, use the default "Archive" folder.',
    input_schema: {
      type: "object" as const,
      properties: {
        bookmarkId: {
          type: "string",
          description: "Existing bookmark ID to move or update",
        },
        url: {
          type: "string",
          description: "URL to organize. Omit to use the current page",
        },
        title: {
          type: "string",
          description:
            "Optional title when saving a new bookmark or retitling an existing one",
        },
        folderId: {
          type: "string",
          description: "Exact bookmark folder ID target",
        },
        folderName: {
          type: "string",
          description: "Folder name target. Created automatically if missing",
        },
        folderSummary: {
          type: "string",
          description: "Optional summary used if a new folder is created",
        },
        createFolderIfMissing: {
          type: "boolean",
          description:
            "Create folderName automatically when it does not exist",
        },
        note: {
          type: "string",
          description: "Optional note to attach or update on the bookmark",
        },
        archive: {
          type: "boolean",
          description:
            'If true, organize into the default "Archive" folder',
        },
      },
    },
  },
  {
    name: "archive_bookmark",
    description:
      'Archive the current page, a URL, or an existing bookmark into the default "Archive" folder.',
    input_schema: {
      type: "object" as const,
      properties: {
        bookmarkId: {
          type: "string",
          description: "Existing bookmark ID to archive",
        },
        url: {
          type: "string",
          description: "URL to archive. Omit to use the current page",
        },
        title: {
          type: "string",
          description: "Optional title when saving a new archived bookmark",
        },
        note: {
          type: "string",
          description: "Optional note about why the page was archived",
        },
      },
    },
  },
  {
    name: "open_bookmark",
    description:
      "Open a saved bookmark by its bookmark ID. Optionally open it in a new tab.",
    input_schema: {
      type: "object" as const,
      properties: {
        bookmarkId: {
          type: "string",
          description: "Exact bookmark ID to open",
        },
        newTab: {
          type: "boolean",
          description:
            "Open the bookmark in a new tab instead of the current tab",
        },
      },
      required: ["bookmarkId"],
    },
  },
];
