export interface ApprovedOpenUrl {
  id: string;
  url: string;
  requestedAt: number;
}

export function parseApprovedOpenUrl(value: unknown): ApprovedOpenUrl | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = record["id"];
  const url = record["url"];
  const requestedAt = record["requestedAt"];
  if (typeof id !== "string" || !id) return undefined;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return undefined;
  if (typeof requestedAt !== "number" || !Number.isFinite(requestedAt)) return undefined;
  return { id, url, requestedAt };
}
