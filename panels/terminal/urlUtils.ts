export function normalizeLocalhostUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.hostname === "0.0.0.0" || url.hostname === "::" || url.hostname === "[::]") {
      url.hostname = "localhost";
      return url.toString();
    }
  } catch {
    // Keep malformed values unchanged; callers decide how to open/fallback.
  }
  return value;
}
