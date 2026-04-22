import type { WebContents } from "electron";
import { createLogger } from "../../shared/logger";
import {
  errorResult,
  getErrorMessage,
  okResult,
  type Result,
} from "../../shared/result";

const logger = createLogger("Screenshot");

type ScreenshotPayload = {
  base64: string;
  width: number;
  height: number;
};

export type ScreenshotResult = Result<ScreenshotPayload>;

/**
 * Capture a screenshot of the visible page area.
 * Retries up to 3 times with increasing delays to handle pages that are
 * still painting.
 */
export async function captureScreenshot(
  wc: WebContents,
): Promise<ScreenshotResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
    try {
      const image = await wc.capturePage();
      if (!image.isEmpty()) {
        const size = image.getSize();
        const base64 = image.toPNG().toString("base64");
        if (base64) {
          return okResult({
            base64,
            width: size.width,
            height: size.height,
          });
        }
      }
    } catch (err) {
      logger.debug(
        `capturePage attempt ${attempt + 1} failed; retrying if attempts remain.`,
        getErrorMessage(err),
      );
    }
  }

  return errorResult("Page image was empty after 3 attempts");
}
