import type { NotificationSeverity } from "./types.js";

export interface ParsedNotification {
  severity: NotificationSeverity;
  title?: string;
  message: string;
  source: "osc" | "snug";
}

/* oxlint-disable eslint/no-control-regex -- ESC and BEL are the OSC wire delimiters. */
const oscPattern =
  /\x1b\](9;([^\x07]*)|99;(?:[^;\x07]*;)*([^\x07]*)|777;notify;([^;\x07]*);([^\x07]*)|1337;snug;([^\x07]*))\x07/g;
/* oxlint-enable eslint/no-control-regex */

export class NotificationStreamParser {
  private buffer = "";

  push(data: string): ParsedNotification[] {
    this.buffer += data;
    const completeThrough = this.completePrefixLength();
    if (completeThrough === 0) {
      this.trimBuffer();
      return [];
    }
    const chunk = this.buffer.slice(0, completeThrough);
    this.buffer = this.buffer.slice(completeThrough);
    this.trimBuffer();
    return parseNotifications(chunk);
  }

  private completePrefixLength(): number {
    const lastBell = this.buffer.lastIndexOf("\x07");
    const lastOsc = this.buffer.lastIndexOf("\x1b]");
    if (lastOsc < 0) return this.buffer.length;
    if (lastBell > lastOsc) return lastBell + 1;
    return lastOsc;
  }

  private trimBuffer(): void {
    if (this.buffer.length > 8192) this.buffer = this.buffer.slice(-8192);
  }
}

export function parseNotifications(data: string): ParsedNotification[] {
  const out: ParsedNotification[] = [];
  for (const match of data.matchAll(oscPattern)) {
    if (match[2]) out.push(classify({ message: stripMarker(match[2]) }, match[2]));
    else if (match[3]) out.push(classify({ message: stripMarker(match[3]) }, match[3]));
    else if (match[4] || match[5])
      out.push(
        classify(
          { title: match[4], message: stripMarker(match[5] ?? match[4] ?? "") },
          `${match[4] ?? ""} ${match[5] ?? ""}`
        )
      );
    else if (match[6]) out.push(parseSnugOsc(match[6]));
  }
  return out;
}

function parseSnugOsc(payload: string): ParsedNotification {
  const params = new URLSearchParams(payload.replace(/;/g, "&"));
  const severity = parseSeverity(params.get("sev") ?? params.get("severity")) ?? "info";
  const title = params.get("title") ?? undefined;
  const message = params.get("msg") ?? params.get("message") ?? payload;
  return { severity, title, message, source: "snug" };
}

function classify(
  notification: Omit<ParsedNotification, "severity" | "source">,
  raw: string
): ParsedNotification {
  return { ...notification, source: "osc", severity: parseSeverity(raw) ?? keywordSeverity(raw) };
}

function parseSeverity(value: string | null | undefined): NotificationSeverity | undefined {
  const normalized = value?.toLowerCase();
  if (!normalized) return undefined;
  if (
    normalized.includes("[approval]") ||
    normalized.includes("sev=approval") ||
    normalized === "approval"
  )
    return "approval";
  if (
    normalized.includes("[error]") ||
    normalized.includes("sev=failure") ||
    normalized === "failure"
  )
    return "failure";
  if (normalized.includes("sev=waiting") || normalized === "waiting") return "waiting";
  if (normalized.includes("sev=done") || normalized === "done") return "done";
  if (normalized.includes("sev=info") || normalized === "info") return "info";
  return undefined;
}

function keywordSeverity(value: string): NotificationSeverity {
  const text = value.toLowerCase();
  if (/\b(approval|approve|permission)\b/.test(text)) return "approval";
  if (/\b(fail|failed|failure|error|denied)\b/.test(text)) return "failure";
  if (/\b(wait|waiting|blocked|pending)\b/.test(text)) return "waiting";
  if (/\b(done|success|passed|complete)\b/.test(text)) return "done";
  return "info";
}

function stripMarker(value: string): string {
  return value.replace(/^\[(approval|error|failure|waiting|done|info)\]\s*/i, "");
}
