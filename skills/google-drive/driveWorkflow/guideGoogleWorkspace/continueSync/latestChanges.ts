import type { GoogleChange } from "../../types.js";

export default function latestChanges(changes: GoogleChange[]): GoogleChange[] {
  const latest = new Map<string, GoogleChange>();
  for (const change of changes) latest.set(change.fileId, change);
  return [...latest.values()];
}
