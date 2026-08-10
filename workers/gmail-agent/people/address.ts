/**
 * RFC-2822-ish address-list parsing for the derived people store. Gmail
 * headers arrive as display strings ("Name <a@b.c>, x@y.z"); we only need
 * (email, display name) pairs, not full RFC compliance.
 */

export interface ParsedAddress {
  email: string;
  name?: string;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const BARE_EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

export function isBareEmailAddress(value: string): boolean {
  return BARE_EMAIL_RE.test(value.trim());
}

function cleanName(raw: string): string | undefined {
  const name = raw.trim().replace(/^"(.*)"$/s, "$1").replace(/\\(["\\])/g, "$1").trim();
  if (!name || EMAIL_RE.test(name)) return undefined;
  return name;
}

/** Split an address list on commas that are not inside quotes or <>. */
function splitAddressList(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let inAngle = false;
  for (const char of text) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && char === "<") inAngle = true;
    else if (!inQuotes && char === ">") inAngle = false;
    if (char === "," && !inQuotes && !inAngle) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * Parse an RFC-2822 address list ("Name <a@b.c>, x@y.z") into
 * lowercase-email + optional display-name entries. Invalid entries are
 * dropped; duplicate emails keep the first (usually named) occurrence.
 */
export function parseAddressEntries(value: string | string[] | undefined): ParsedAddress[] {
  const text = Array.isArray(value) ? value.join(", ") : value ?? "";
  const seen = new Map<string, ParsedAddress>();
  for (const part of splitAddressList(text)) {
    const angled = /<([^>]*)>/.exec(part);
    let email: string | undefined;
    let name: string | undefined;
    if (angled) {
      email = EMAIL_RE.exec(angled[1] ?? "")?.[0];
      name = cleanName(part.slice(0, angled.index));
    } else {
      email = EMAIL_RE.exec(part)?.[0];
    }
    if (!email) continue;
    const normalized = email.toLowerCase();
    if (!seen.has(normalized)) seen.set(normalized, { email: normalized, ...(name ? { name } : {}) });
  }
  return [...seen.values()];
}
