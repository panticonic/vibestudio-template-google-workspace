export function normalizePageImageMode(
  mode: boolean | "never" | "always" | "on-ocr" | "on-request" | undefined
): "never" | "always" | "on-ocr" | "on-request" {
  if (mode === true) return "always";
  if (mode === false) return "never";
  return mode ?? "on-request";
}

export function selectPages(
  pages: string | number[] | { from?: number; to?: number } | undefined,
  pageCount: number,
  maxPages?: number
): number[] {
  let selected: number[];
  if (!pages || pages === "all") {
    selected = range(1, pageCount);
  } else if (typeof pages === "string") {
    selected = parsePageRange(pages, pageCount);
  } else if (Array.isArray(pages)) {
    selected = [...new Set(pages.map((page) => Math.trunc(page)))].filter(
      (page) => page >= 1 && page <= pageCount
    );
  } else {
    const from = Math.max(1, Math.trunc(pages.from ?? 1));
    const to = Math.min(pageCount, Math.trunc(pages.to ?? pageCount));
    selected = from <= to ? range(from, to) : [];
  }

  const limit = Math.max(0, Math.trunc(maxPages ?? selected.length));
  return selected.slice(0, limit);
}

function parsePageRange(input: string, pageCount: number): number[] {
  const pages = new Set<number>();
  for (const part of input.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const match = /^(\d+)(?:-(\d+)?)?$/.exec(trimmed);
    if (!match) throw new Error(`pdf-ingest: invalid page range ${JSON.stringify(input)}`);
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : trimmed.endsWith("-") ? pageCount : from;
    for (const page of range(Math.max(1, from), Math.min(pageCount, to))) {
      pages.add(page);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

function range(from: number, to: number): number[] {
  const output: number[] = [];
  for (let page = from; page <= to; page++) output.push(page);
  return output;
}
