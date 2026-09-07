/**
 * Images buried in a tool result.
 *
 * `ToolExecutionState.resultImages` has been part of the invocation card's shape
 * for a long time, and `ActionMessage` renders it — but nothing ever filled it
 * in, so the branch was dead and every image a tool returned reached the user as
 * `"data": "[402931 characters omitted]"` inside a JSON blob. `panel_screenshot`
 * is the case that makes this indefensible: the whole point of the tool is to
 * show someone what a panel looks like.
 *
 * Tools disagree about where the image sits — some return the content array the
 * model saw, some return their own details record — so this looks for the shape
 * rather than for a path, bounded so a pathological result cannot walk forever.
 */

export interface ResultImage {
  mimeType: string;
  /** Base64 payload, exactly as the tool returned it. */
  data: string;
  width?: number;
  height?: number;
}

const MAX_IMAGES = 8;
const MAX_DEPTH = 6;

function isImageRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["data"] === "string" &&
    record["data"].length > 0 &&
    typeof record["mimeType"] === "string" &&
    record["mimeType"].startsWith("image/")
  );
}

/** Every image in a tool result, in encounter order. */
export function extractResultImages(value: unknown): ResultImage[] {
  const images: ResultImage[] = [];
  const seen = new WeakSet<object>();

  const walk = (node: unknown, depth: number): void => {
    if (images.length >= MAX_IMAGES || depth > MAX_DEPTH) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (isImageRecord(node)) {
      const record = node as Record<string, unknown>;
      images.push({
        mimeType: record["mimeType"] as string,
        data: record["data"] as string,
        ...(typeof record["width"] === "number" ? { width: record["width"] } : {}),
        ...(typeof record["height"] === "number" ? { height: record["height"] } : {}),
      });
      return;
    }
    for (const item of Object.values(node as Record<string, unknown>)) walk(item, depth + 1);
  };

  walk(value, 0);
  return images;
}

/** Decoded byte count of a base64 payload, for a human size label. */
export function base64ByteLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/** The `src` an image element wants. */
export function imageDataUrl(image: Pick<ResultImage, "mimeType" | "data">): string {
  return `data:${image.mimeType};base64,${image.data}`;
}
