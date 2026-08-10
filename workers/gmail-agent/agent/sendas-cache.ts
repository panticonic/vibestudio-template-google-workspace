import type { GmailClient, GmailSendAsAlias } from "@workspace/gmail";

const SENDAS_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Per-channel cache of Gmail send-as aliases (GET /settings/sendAs).
 * Backs From-address validation on send/saveDraft and signature lookup at
 * draft time. Failures degrade to "no aliases known" so mail flows keep
 * working without the settings scope.
 */
export class SendAsCache {
  private cache = new Map<string, { aliases: GmailSendAsAlias[]; fetchedAt: number }>();

  constructor(
    private readonly deps: {
      gmailFor: (channelId: string) => GmailClient;
      now?: () => number;
    }
  ) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  invalidate(channelId: string): void {
    this.cache.delete(channelId);
  }

  async aliases(channelId: string): Promise<GmailSendAsAlias[]> {
    const cached = this.cache.get(channelId);
    if (cached && this.now() - cached.fetchedAt < SENDAS_CACHE_TTL_MS) return cached.aliases;
    let aliases: GmailSendAsAlias[] = [];
    try {
      aliases = await this.deps.gmailFor(channelId).listSendAs();
    } catch {
      // Missing settings scope or transient failure: behave as if the
      // account had no aliases (no validation, no signature).
    }
    this.cache.set(channelId, { aliases, fetchedAt: this.now() });
    return aliases;
  }

  async defaultAlias(channelId: string): Promise<GmailSendAsAlias | undefined> {
    const aliases = await this.aliases(channelId);
    return aliases.find((alias) => alias.isDefault) ?? aliases.find((alias) => alias.isPrimary);
  }

  /** Default-alias signature as plain text ("" when none). */
  async defaultSignature(channelId: string): Promise<string> {
    const alias = await this.defaultAlias(channelId);
    return alias?.signature ? htmlSignatureToPlainText(alias.signature) : "";
  }

  /** Alias addresses, default first — compose cards offer these as From options. */
  async fromOptions(channelId: string): Promise<string[]> {
    const aliases = await this.aliases(channelId);
    return [...aliases]
      .sort((a, b) => Number(b.isDefault ?? false) - Number(a.isDefault ?? false))
      .map((alias) =>
        alias.displayName ? `${alias.displayName} <${alias.sendAsEmail}>` : alias.sendAsEmail
      );
  }

  /**
   * Validate a requested From against the alias list. Returns the resolved
   * header value, or throws for an address Gmail would reject/rewrite.
   * When the alias list is unknown (no settings scope), passes through.
   */
  async validateFrom(channelId: string, from: string): Promise<string> {
    const aliases = await this.aliases(channelId);
    if (aliases.length === 0) return from;
    const bare = (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
    const match = aliases.find((alias) => alias.sendAsEmail.toLowerCase() === bare);
    if (!match) {
      throw new Error(
        `from address is not a configured send-as alias: ${from} (known: ${aliases
          .map((alias) => alias.sendAsEmail)
          .join(", ")})`
      );
    }
    return match.displayName ? `${match.displayName} <${match.sendAsEmail}>` : match.sendAsEmail;
  }
}

/**
 * Lossy HTML→plain conversion for signatures (we send text/plain).
 * Keeps line structure (<br>, <div>, <p>), strips everything else.
 */
export function htmlSignatureToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:div|p|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Append the signature to a body unless it is already present. */
export function appendSignature(body: string, signature: string): string {
  if (!signature) return body;
  if (body.includes(signature)) return body;
  return `${body.trimEnd()}\n\n${signature}`;
}
