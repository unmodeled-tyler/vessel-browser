import { getActiveTabInfo } from "./common";
import type { WindowState } from "../window";

export async function togglePictureInPicture(
  tabManager: WindowState["tabManager"],
): Promise<boolean> {
  const info = getActiveTabInfo(tabManager);
  if (!info) return false;
  const { wc } = info;
  try {
    return await wc.executeJavaScript(`
      (async function() {
        const video = document.querySelector('video');
        if (!video) return false;
        if (!document.pictureInPictureEnabled || typeof video.requestPictureInPicture !== 'function') {
          return false;
        }
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
          return false;
        }
        try {
          await video.requestPictureInPicture();
          return true;
        } catch {
          return false;
        }
      })()
    `);
  } catch (err) {
    console.warn("Picture-in-picture toggle failed:", err);
    return false;
  }
}
