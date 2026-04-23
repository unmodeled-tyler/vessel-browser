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
