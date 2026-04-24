const UNDOABLE_ACTIONS = new Set([
  "accept_cookies",
  "clear_overlays",
  "click",
  "close_tab",
  "create_tab",
  "dismiss_popup",
  "fill_form",
  "focus",
  "go_back",
  "go_forward",
  "load_session",
  "login",
  "navigate",
  "open_bookmark",
  "paginate",
  "press_key",
  "reload",
  "restore_checkpoint",
  "scroll",
  "scroll_to_element",
  "search",
  "select_option",
  "set_ad_blocking",
  "submit_form",
  "switch_tab",
  "type_text",
]);

export function isUndoableAction(name: string): boolean {
  return UNDOABLE_ACTIONS.has(name);
}

export function isUndoableResult(result: string): boolean {
  const normalized = result.trim().toLowerCase();
  return (
    normalized.length > 0 &&
    !normalized.startsWith("error:") &&
    !normalized.startsWith("nothing to ") &&
    !normalized.startsWith("no active ") &&
    !normalized.startsWith("action rejected:")
  );
}
