import type { ActionContext } from "../core";
import { waitForLoad } from "../../../utils/webcontents-utils";
import { getTabByMatch } from "../navigation";
import { getPostNavSummary } from "../summaries";
import { TAB_GROUP_COLORS, type TabGroupColor } from "../../../../shared/types";

export async function handleCurrentTab(_ctx: ActionContext): Promise<string> {
  const active = _ctx.tabManager.getActiveTab();
  const activeId = _ctx.tabManager.getActiveTabId();
  if (!active || !activeId) return "Error: No active tab";
  const state = active.state;
  return JSON.stringify(
    {
      tabId: activeId,
      title: state.title,
      url: state.url,
      isLoading: state.isLoading,
      canGoBack: state.canGoBack,
      canGoForward: state.canGoForward,
      adBlockingEnabled: state.adBlockingEnabled,
      humanFocused: true,
    },
    null,
    2,
  );
}

export function handleListTabs(ctx: ActionContext): string {
  const activeId = ctx.tabManager.getActiveTabId();
  const lines = ctx.tabManager.getAllStates().map((item) => {
    const prefix = item.id === activeId ? "->" : "  ";
    const adBlock = item.adBlockingEnabled ? "on" : "off";
    return `${prefix} [${item.id}] ${item.title} — ${item.url} [adblock:${adBlock}]`;
  });
  return lines.join("\n") || "No tabs open";
}

export function handleSwitchTab(ctx: ActionContext, args: Record<string, unknown>): string {
  let targetId = typeof args.tabId === "string" ? args.tabId.trim() : "";
  if (!targetId) {
    targetId = getTabByMatch(ctx.tabManager, args.match)?.id || "";
  }
  if (!targetId) return "Error: No matching tab found";
  ctx.tabManager.switchTab(targetId);
  const active = ctx.tabManager.getActiveTab();
  return active
    ? `Switched to ${active.view.webContents.getTitle() || active.view.webContents.getURL()}`
    : `Switched to tab ${targetId}`;
}

export async function handleCreateTab(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const createdId = ctx.tabManager.createTab(
    typeof args.url === "string" && args.url.trim() ? args.url.trim() : "about:blank",
  );
  const created = ctx.tabManager.getTab(createdId);
  if (created) {
    await waitForLoad(created.view.webContents);
    return `Created tab ${createdId}${await getPostNavSummary(created.view.webContents)}`;
  }
  return `Created tab ${createdId}`;
}

export async function handleSetAdBlocking(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const enabled = typeof args.enabled === "boolean" ? args.enabled : null;
  if (enabled == null) {
    return "Error: enabled must be true or false";
  }

  let targetId = typeof args.tabId === "string" ? args.tabId.trim() : "";
  if (!targetId) {
    targetId = getTabByMatch(ctx.tabManager, args.match)?.id || "";
  }
  if (!targetId) {
    targetId = ctx.tabManager.getActiveTabId() || "";
  }
  if (!targetId) return "Error: No target tab found";

  const targetTab = ctx.tabManager.getTab(targetId);
  if (!targetTab) return "Error: Target tab not found";

  ctx.tabManager.setAdBlockingEnabled(targetId, enabled);

  const shouldReload = args.reload !== false;
  if (shouldReload) {
    targetTab.reload();
    await waitForLoad(targetTab.view.webContents);
  }

  const state = targetTab.state;
  return `${enabled ? "Enabled" : "Disabled"} ad blocking for "${state.title}"${shouldReload ? " and reloaded the tab" : ""}`;
}

export function handleListGroups(ctx: ActionContext): string {
  const groups = ctx.tabManager.getGroups();
  const tabs = ctx.tabManager.getAllStates();
  if (groups.length === 0) return "No tab groups";
  return groups
    .map((group) => {
      const count = tabs.filter((tab) => tab.groupId === group.id).length;
      return `[${group.id}] ${group.name} — color:${group.color} collapsed:${group.collapsed} tabs:${count}`;
    })
    .join("\n");
}

export function handleCreateGroup(
  ctx: ActionContext,
  args: Record<string, unknown>,
): string {
  const targetId =
    typeof args.tabId === "string" && args.tabId.trim()
      ? args.tabId.trim()
      : ctx.tabManager.getActiveTabId();
  if (!targetId) return "Error: No active tab";
  const color =
    typeof args.color === "string" && TAB_GROUP_COLORS.includes(args.color as TabGroupColor)
      ? (args.color as TabGroupColor)
      : undefined;
  const groupId = ctx.tabManager.createGroupFromTab(targetId, {
    name: typeof args.name === "string" && args.name.trim() ? args.name.trim() : undefined,
    color,
  });
  if (!groupId) return "Error: Could not create group";
  return `Created group ${groupId}`;
}

export function handleAssignToGroup(
  ctx: ActionContext,
  args: Record<string, unknown>,
): string {
  const groupId = typeof args.groupId === "string" ? args.groupId.trim() : "";
  if (!groupId) return "Error: Group ID is required";
  const targetId =
    typeof args.tabId === "string" && args.tabId.trim()
      ? args.tabId.trim()
      : ctx.tabManager.getActiveTabId();
  if (!targetId) return "Error: No active tab";
  ctx.tabManager.assignTabToGroup(targetId, groupId);
  return `Assigned tab ${targetId} to group ${groupId}`;
}

export function handleRemoveFromGroup(
  ctx: ActionContext,
  args: Record<string, unknown>,
): string {
  const targetId =
    typeof args.tabId === "string" && args.tabId.trim()
      ? args.tabId.trim()
      : ctx.tabManager.getActiveTabId();
  if (!targetId) return "Error: No active tab";
  ctx.tabManager.removeTabFromGroup(targetId);
  return `Removed tab ${targetId} from group`;
}

export function handleToggleGroup(
  ctx: ActionContext,
  args: Record<string, unknown>,
): string {
  const groupId = typeof args.groupId === "string" ? args.groupId.trim() : "";
  if (!groupId) return "Error: Group ID is required";
  const collapsed = ctx.tabManager.toggleGroupCollapsed(groupId);
  if (collapsed === null) return "Error: Group not found";
  return collapsed ? `Collapsed group ${groupId}` : `Expanded group ${groupId}`;
}

export function handleSetGroupColor(
  ctx: ActionContext,
  args: Record<string, unknown>,
): string {
  const groupId = typeof args.groupId === "string" ? args.groupId.trim() : "";
  const color = typeof args.color === "string" ? args.color.trim() : "";
  if (!groupId) return "Error: Group ID is required";
  if (!TAB_GROUP_COLORS.includes(color as TabGroupColor)) {
    return "Error: Invalid tab group color";
  }
  const groupExists = ctx.tabManager.getGroups().some((group) => group.id === groupId);
  if (!groupExists) return "Error: Group not found";
  ctx.tabManager.setGroupColor(groupId, color as TabGroupColor);
  return `Set group ${groupId} color to ${color}`;
}
