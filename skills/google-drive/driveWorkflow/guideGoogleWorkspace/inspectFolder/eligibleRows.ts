import type { GoogleFolderRow, GoogleInventoryRequest } from "../../types.js";

export default function eligibleRows(
  request: GoogleInventoryRequest,
  rows: GoogleFolderRow[],
): GoogleFolderRow[] {
  const known = new Set<string>();
  const cutoff =
    request.modifiedSince === null ? null : Date.parse(request.modifiedSince);
  return rows.filter((row) => {
    if (known.has(row.id) || row.shortcut) return false;
    if (request.media.length > 0 && !request.media.includes(row.mimeType))
      return false;
    if (
      cutoff !== null &&
      (row.modifiedAt === null || !(Date.parse(row.modifiedAt) >= cutoff))
    )
      return false;
    known.add(row.id);
    return true;
  });
}
