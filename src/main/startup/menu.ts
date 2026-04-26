import { Menu } from "electron";

interface AppMenuHandlers {
  newWindow: () => void;
  reopenClosedTab: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
  viewPageSource: () => void;
  savePageAs: () => void;
}

/** Builds and sets the application menu. */
export function setupAppMenu(handlers: AppMenuHandlers): void {
  const appMenu = Menu.buildFromTemplate([
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          accelerator: "CommandOrControl+N",
          click: handlers.newWindow,
        },
        {
          label: "Save Page As...",
          accelerator: "CommandOrControl+S",
          click: handlers.savePageAs,
        },
        {
          label: "Reopen Closed Tab",
          accelerator: "CommandOrControl+Shift+T",
          click: handlers.reopenClosedTab,
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Zoom In",
          accelerator: "CommandOrControl+Plus",
          click: handlers.zoomIn,
        },
        {
          label: "Zoom Out",
          accelerator: "CommandOrControl+-",
          click: handlers.zoomOut,
        },
        {
          label: "Actual Size",
          accelerator: "CommandOrControl+0",
          click: handlers.zoomReset,
        },
        { type: "separator" },
        {
          label: "View Page Source",
          accelerator: "CommandOrControl+U",
          click: handlers.viewPageSource,
        },
      ],
    },
  ]);
  Menu.setApplicationMenu(appMenu);
}
