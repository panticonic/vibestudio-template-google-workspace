export interface FindResultState {
  index: number;
  count: number;
}

export type FindKeyAction = "close" | "next" | "previous" | "none";

export function findStatus(
  query: string,
  matched: boolean | undefined,
  result: FindResultState,
): string {
  if (!query) return "";
  if (matched === false || result.count === 0) return "No matches";
  if (result.index >= 0 && result.count > 0) return `${result.index + 1} of ${result.count}`;
  return "Searching...";
}

export function findKeyAction(event: Pick<KeyboardEvent, "key" | "shiftKey">): FindKeyAction {
  if (event.key === "Escape") return "close";
  if (event.key === "Enter") return event.shiftKey ? "previous" : "next";
  return "none";
}
