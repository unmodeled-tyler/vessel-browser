/**
 * Rich tool results that can include images alongside text.
 * The providers detect this via the __richResult tag and format
 * it appropriately for their respective APIs.
 */

export interface ImageBlock {
  type: "image";
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  base64: string;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface RichToolResult {
  __richResult: true;
  content: Array<TextBlock | ImageBlock>;
}

export function isRichToolResult(value: unknown): value is RichToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "__richResult" in value &&
    (value as { __richResult: unknown }).__richResult === true
  );
}

export function makeImageResult(
  base64: string,
  description: string,
  mediaType: "image/png" | "image/jpeg" | "image/webp" = "image/png",
): string {
  const result: RichToolResult = {
    __richResult: true,
    content: [
      { type: "text", text: description },
      { type: "image", mediaType, base64 },
    ],
  };
  return JSON.stringify(result);
}
