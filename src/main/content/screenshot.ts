import type { WebContents } from "electron";

export interface ScreenshotResult {
  ok: true;
  base64: string;
  width: number;
  height: number;
}

export interface ScreenshotError {
  ok: false;
  error: string;
}

/**
 * Capture a screenshot of the visible page area.
 * Retries up to 3 times with increasing delays to handle pages that are
 * still painting.
 */
export async function captureScreenshot(
  wc: WebContents,
): Promise<ScreenshotResult | ScreenshotError> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
    try {
      const image = await wc.capturePage();
      if (!image.isEmpty()) {
        const size = image.getSize();
        const base64 = image.toPNG().toString("base64");
        if (base64) {
          return { ok: true, base64, width: size.width, height: size.height };
        }
      }
    } catch {
      // capturePage can fail if the webContents is destroyed mid-capture
    }
  }

  return { ok: false, error: "Page image was empty after 3 attempts" };
}
