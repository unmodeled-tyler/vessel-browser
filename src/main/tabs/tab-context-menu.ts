import { Menu, MenuItem, type BaseWindow } from "electron";
import type { TabManager } from "./tab-manager";
import { TAB_GROUP_COLORS, TAB_GROUP_COLOR_LABELS } from "../../shared/types";

/**
 * Build and show the standard tab context menu (right-click on a tab).
 * The `onLayout` callback is invoked when an action requires relayout
 * (e.g., after pin/unpin, duplicate, or close).
 */
export function showTabContextMenu(
  tabManager: TabManager,
  id: string,
  parentWindow: BaseWindow,
  onLayout?: () => void,
): void {
  const tab = tabManager.getTab(id);
  const isPinned = tab?.state.isPinned ?? false;
  const groupId = tab?.state.groupId;
  const isMuted = tab?.state.isMuted ?? false;
  const groups = tabManager
    .getAllStates()
    .filter((state) => state.groupId && state.groupId !== groupId)
    .reduce(
      (map, state) =>
        map.set(state.groupId!, {
          id: state.groupId!,
          name: state.groupName || "Group",
        }),
      new Map<string, { id: string; name: string }>(),
    );

  const menu = new Menu();
  menu.append(
    new MenuItem({
      label: isPinned ? "Unpin Tab" : "Pin Tab",
      click: () => {
        if (isPinned) {
          tabManager.unpinTab(id);
        } else {
          tabManager.pinTab(id);
        }
      },
    }),
  );
  menu.append(
    new MenuItem({
      label: "Duplicate Tab",
      click: () => {
        const newId = tabManager.duplicateTab(id);
        if (newId) onLayout?.();
      },
    }),
  );
  menu.append(
    new MenuItem({
      label: "Add to New Group",
      click: () => {
        tabManager.createGroupFromTab(id);
      },
    }),
  );
  if (groups.size > 0) {
    menu.append(
      new MenuItem({
        label: "Add to Group",
        submenu: [...groups.values()].map(
          (group) =>
            new MenuItem({
              label: group.name,
              click: () => tabManager.assignTabToGroup(id, group.id),
            }),
        ),
      }),
    );
  }
  if (groupId) {
    menu.append(
      new MenuItem({
        label: "Remove from Group",
        click: () => {
          tabManager.removeTabFromGroup(id);
        },
      }),
    );
  }
  menu.append(
    new MenuItem({
      label: isMuted ? "Unmute Tab" : "Mute Tab",
      click: () => {
        tabManager.toggleMuted(id);
      },
    }),
  );
  menu.append(new MenuItem({ type: "separator" }));
  menu.append(
    new MenuItem({
      label: "Print Page",
      click: () => {
        tabManager.printTab(id);
      },
    }),
  );
  menu.append(
    new MenuItem({
      label: "Save Page as PDF",
      click: () => {
        void tabManager.saveTabAsPdf(id).catch(() => {
          // PDF save failures are non-critical
        });
      },
    }),
  );
  if (!isPinned) {
    menu.append(new MenuItem({ type: "separator" }));
    menu.append(
      new MenuItem({
        label: "Close Tab",
        click: () => {
          tabManager.closeTab(id);
          onLayout?.();
        },
      }),
    );
  }
  menu.popup({ window: parentWindow });
}

/**
 * Build and show the tab group context menu (right-click on a group label).
 */
export function showGroupContextMenu(
  tabManager: TabManager,
  groupId: string,
  parentWindow: BaseWindow,
): void {
  const firstTab = tabManager
    .getAllStates()
    .find((tab) => tab.groupId === groupId);
  if (!firstTab) return;

  const menu = new Menu();
  menu.append(
    new MenuItem({
      label: firstTab.groupCollapsed ? "Expand Group" : "Collapse Group",
      click: () => tabManager.toggleGroupCollapsed(groupId),
    }),
  );
  menu.append(
    new MenuItem({
      label: "Group Color",
      submenu: TAB_GROUP_COLORS.map(
        (color) =>
          new MenuItem({
            label: TAB_GROUP_COLOR_LABELS[color],
            type: "radio",
            checked: firstTab.groupColor === color,
            click: () => tabManager.setGroupColor(groupId, color),
          }),
      ),
    }),
  );
  menu.popup({ window: parentWindow });
}