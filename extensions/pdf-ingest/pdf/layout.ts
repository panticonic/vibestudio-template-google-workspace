import type { PdfLine } from "./types.js";

export interface PdfTextItem {
  str: string;
  transform: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
}

interface PositionedTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  hasEOL: boolean;
}

interface LineAccumulator {
  items: PositionedTextItem[];
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function itemToPositioned(item: PdfTextItem, pageHeight: number): PositionedTextItem | null {
  const text = item.str;
  if (!text) return null;
  const transform = item.transform;
  if (!Array.isArray(transform) || transform.length < 6) return null;
  const x = Number(transform[4] ?? 0);
  const baselineY = Number(transform[5] ?? 0);
  const width = Math.max(0, Number(item.width ?? Math.abs(transform[0] ?? 0) * text.length));
  const height = Math.max(1, Number(item.height ?? Math.abs(transform[3] ?? transform[0] ?? 12)));
  const y = Math.max(0, pageHeight - baselineY - height);
  return {
    text,
    x,
    y,
    width,
    height,
    hasEOL: Boolean(item.hasEOL),
  };
}

function overlapsLine(line: LineAccumulator, item: PositionedTextItem): boolean {
  const lineMid = (line.y1 + line.y2) / 2;
  const itemMid = item.y + item.height / 2;
  const tolerance = Math.max(2.5, Math.min(8, Math.max(line.y2 - line.y1, item.height) * 0.45));
  return Math.abs(lineMid - itemMid) <= tolerance;
}

function addToLine(line: LineAccumulator, item: PositionedTextItem): void {
  line.items.push(item);
  line.x1 = Math.min(line.x1, item.x);
  line.y1 = Math.min(line.y1, item.y);
  line.x2 = Math.max(line.x2, item.x + item.width);
  line.y2 = Math.max(line.y2, item.y + item.height);
}

function lineText(line: LineAccumulator): string {
  const items = [...line.items].sort((a, b) => a.x - b.x);
  const widths = items
    .filter((item) => item.text.trim())
    .map((item) => item.width / Math.max(1, item.text.length))
    .filter((width) => Number.isFinite(width) && width > 0);
  const averageCharWidth =
    widths.length > 0 ? widths.reduce((sum, width) => sum + width, 0) / widths.length : 5;

  let output = "";
  let previousRight: number | null = null;
  for (const item of items) {
    const text = item.text.replace(/\r/g, "");
    if (!text) continue;
    if (previousRight !== null) {
      const gap = item.x - previousRight;
      if (gap > averageCharWidth * 1.2) {
        const spaces = Math.max(1, Math.min(12, Math.round(gap / averageCharWidth)));
        if (!output.endsWith(" ") && !text.startsWith(" ")) output += " ".repeat(spaces);
      }
    }
    output += text;
    previousRight = Math.max(previousRight ?? item.x, item.x + item.width);
  }
  return output.trimEnd();
}

export function groupTextItems(
  rawItems: PdfTextItem[],
  page: { width: number; height: number }
): PdfLine[] {
  const positioned = rawItems
    .map((item) => itemToPositioned(item, page.height))
    .filter((item): item is PositionedTextItem => item !== null)
    .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));

  const lines: LineAccumulator[] = [];
  for (const item of positioned) {
    const line = lines.find((candidate) => overlapsLine(candidate, item));
    if (line) {
      addToLine(line, item);
    } else {
      lines.push({
        items: [item],
        x1: item.x,
        y1: item.y,
        x2: item.x + item.width,
        y2: item.y + item.height,
      });
    }
  }

  return lines
    .sort((a, b) => (a.y1 === b.y1 ? a.x1 - b.x1 : a.y1 - b.y1))
    .map((line) => ({
      text: lineText(line),
      bbox: [
        round(line.x1),
        round(line.y1),
        round(Math.max(0, line.x2 - line.x1)),
        round(Math.max(0, line.y2 - line.y1)),
      ] as [number, number, number, number],
      confidence: 1,
      source: "embedded-text" as const,
    }))
    .filter((line) => line.text.trim().length > 0);
}

export function linesToLayoutText(lines: PdfLine[]): string {
  if (lines.length === 0) return "";
  const heights = lines.map((line) => line.bbox[3]).filter((height) => height > 0);
  const sortedHeights = [...heights].sort((a, b) => a - b);
  const medianHeight =
    sortedHeights.length > 0 ? (sortedHeights[Math.floor(sortedHeights.length / 2)] ?? 12) : 12;
  const stanzaGap = Math.max(12, medianHeight * 1.65);

  const output: string[] = [];
  let previousBottom: number | null = null;
  for (const line of lines) {
    if (previousBottom !== null) {
      const gap = line.bbox[1] - previousBottom;
      if (gap > stanzaGap) output.push("");
    }
    output.push(line.text);
    previousBottom = line.bbox[1] + line.bbox[3];
  }
  return output.join("\n");
}

export function linesToMarkdown(lines: PdfLine[]): string {
  return linesToLayoutText(lines);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
