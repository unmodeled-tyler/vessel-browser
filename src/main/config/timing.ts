/**
 * Timing constants shared by multiple modules for the same conceptual purpose.
 * Only put a constant here if it appears in multiple files for the same domain.
 */

// --- Page script execution ---
export const DEFAULT_PAGE_SCRIPT_TIMEOUT_MS = 1500;

// --- Content extraction ---
export const EXTRACT_SCRIPT_TIMEOUT_MS = 3000;
export const EXTRACT_TIMEOUT_BASE_MS = 12000;
export const EXTRACT_TIMEOUT_MAX_MS = 20000;

// --- Page diff monitoring ---
export const MUTATION_CAPTURE_INTERVAL_MS = 5000;
export const MUTATION_SETTLE_AFTER_MS = 1500;

// --- Agent stream idle ---
export const AGENT_STREAM_IDLE_TIMEOUT_MS = 30000;

// --- Navigation ---
export const NAVIGATION_WAIT_MS = 3000;
export const WAIT_FOR_LOAD_TIMEOUT_MS = 3000;
export const QUIET_NAVIGATION_TIMEOUT_MS = 2500;

// --- Page interaction ---
export const POST_CLICK_DELAY_MS = 1200;
export const WAIT_POLL_INTERVAL_MS = 150;

// --- Tool execution ---
export const TOOL_TIMEOUT_DEFAULT_MS = 10000;

// --- UI status messages ---
export const STATUS_MESSAGE_CLEAR_MS = 3000;
export const STATUS_MESSAGE_LONG_CLEAR_MS = 5000;
