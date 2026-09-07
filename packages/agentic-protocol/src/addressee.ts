/**
 * The addressee model (messaging plan §4.2): one string grammar for everything
 * `notify` can be pointed at, one parser, one resolver.
 *
 * Two rules hold this together:
 *
 *  - **Resolution is attribution, never authorization.** `resolveAddressee`
 *    answers "who was meant"; the write path (channel admission, authority
 *    stamps) answers "does this land". Keeping them apart is what lets this
 *    module stay pure and unit-testable.
 *  - **Fail closed, with suggestions.** An unresolvable ref is an error the
 *    tool surfaces verbatim, never a silent broadcast — matching `ask_user`'s
 *    stance. Guessing is how an agent ends up telling the wrong participant
 *    something.
 *
 * This is also the read side of discovery: `list_addressees` enumerates
 * exactly these kinds, so what an agent can discover and what it can address
 * are the same set by construction.
 */

import type { ParticipantRef } from "./events.js";
import { isHandleResolutionFailure, resolveHandle } from "./participant-ref.js";

/** Syntactic shape of a ref, before any roster or directory is consulted. */
export type ParsedAddressee =
  | { kind: "handle"; handle: string }
  | { kind: "participant"; participantId: string }
  | { kind: "user"; userId: string }
  | { kind: "owner" }
  | { kind: "parent" }
  | { kind: "run"; runId: string }
  | { kind: "agent"; handle: string; channelId?: string }
  | { kind: "channel"; channelId: string };

export type AddresseeErrorCode =
  | "malformed"
  | "unknown-handle"
  | "ambiguous-handle"
  | "not-a-subagent"
  | "unknown-run"
  | "ambiguous-run"
  | "unknown-agent"
  | "ambiguous-agent"
  | "unknown-user"
  | "unknown-channel"
  | "no-owner";

export interface AddresseeError {
  code: AddresseeErrorCode;
  /** Ready to hand back to the model verbatim. */
  message: string;
  suggestions: string[];
}

/**
 * A resolved destination. `channelId` is where the envelope goes; when it
 * differs from the sender's bound channel the tool must publish a guest
 * envelope (plan §4.6) rather than an ordinary one.
 */
export type ResolvedAddressee =
  | { kind: "channel"; channelId: string; foreign: false }
  | {
      kind: "participant";
      channelId: string;
      foreign: false;
      participantId: string;
      ref: ParticipantRef;
    }
  | { kind: "parent"; channelId: string; foreign: false; participantId: string }
  | {
      kind: "run";
      channelId: string;
      foreign: true;
      runId: string;
      participantId?: string;
    }
  | {
      kind: "agent";
      channelId: string;
      foreign: boolean;
      instanceId: string;
      participantId: string;
      handle: string;
    }
  | {
      kind: "user";
      channelId: string;
      foreign: boolean;
      userId: string;
      /** Present when the user is on the bound channel's roster. */
      participantId?: string;
      inRoster: boolean;
    }
  | { kind: "external-channel"; channelId: string; foreign: true };

/** A subagent run as the parent knows it (`subagent-runs` store). */
export interface AddresseeRunEntry {
  runId: string;
  taskChannelId: string;
  /** The child's participant id on its task channel, when known. */
  participantId?: string;
}

/** One row of the Gad agent directory (plan §4.4), as far as addressing cares. */
export interface AddresseeDirectoryEntry {
  instanceId: string;
  handle: string;
  channelId: string;
  participantId: string;
}

export interface AddresseeUserEntry {
  userId: string;
  handle?: string;
  displayName?: string;
}

export interface ResolveAddresseeContext {
  /** The channel the sender is bound to; the default destination. */
  channelId: string;
  roster: readonly ParticipantRef[];
  /** Set only when the sender is itself a subagent. */
  parent?: { participantId: string } | undefined;
  runs?: readonly AddresseeRunEntry[] | undefined;
  directory?: readonly AddresseeDirectoryEntry[] | undefined;
  users?: readonly AddresseeUserEntry[] | undefined;
  /** The channel-owning user, target of the `owner` ref. */
  ownerUserId?: string | undefined;
}

const AGENT_REF_PATTERN = /^([^@\s]+)(?:@(.+))?$/;

/**
 * Parse a ref string. Pure syntax: an unknown handle and a well-formed handle
 * are both `{kind:"handle"}` here — only `resolveAddressee` can tell them
 * apart, because only it has the roster.
 */
export function parseAddressee(ref: string): ParsedAddressee | AddresseeError {
  const token = ref.trim();
  if (token.length === 0) {
    return { code: "malformed", message: "empty addressee", suggestions: [] };
  }
  if (token.startsWith("@")) {
    const handle = token.slice(1).trim();
    if (handle.length === 0) {
      return { code: "malformed", message: `"${ref}" is not a handle`, suggestions: [] };
    }
    return { kind: "handle", handle };
  }
  if (token === "parent") return { kind: "parent" };
  if (token === "owner") return { kind: "owner" };

  const separator = token.indexOf(":");
  if (separator <= 0) {
    // A bare word is a handle; requiring "@" for every mention would make the
    // common case the noisy one.
    return { kind: "handle", handle: token };
  }
  const scheme = token.slice(0, separator);
  const rest = token.slice(separator + 1).trim();
  if (rest.length === 0) {
    return { code: "malformed", message: `"${ref}" is missing its target`, suggestions: [] };
  }
  switch (scheme) {
    case "participant":
      return { kind: "participant", participantId: rest };
    case "user":
      // `user:<id>` keeps its prefix as the participant id convention
      // (userParticipantId); the bare id travels in `userId`.
      return { kind: "user", userId: rest };
    case "run":
      return { kind: "run", runId: rest };
    case "channel":
      return { kind: "channel", channelId: rest };
    case "agent": {
      const match = AGENT_REF_PATTERN.exec(rest);
      if (!match) {
        return {
          code: "malformed",
          message: `"${ref}" is not an agent ref; use agent:<handle>@<channelId>`,
          suggestions: [],
        };
      }
      const [, handle, channelId] = match;
      return {
        kind: "agent",
        handle: handle as string,
        ...(channelId ? { channelId } : {}),
      };
    }
    default:
      return {
        code: "malformed",
        message:
          `"${ref}" has an unknown prefix "${scheme}:". Use @handle, participant:<id>, ` +
          `user:<id>, owner, parent, run:<id>, agent:<handle>@<channelId>, or channel:<id>.`,
        suggestions: [],
      };
  }
}

export function isAddresseeError(
  value: ParsedAddressee | ResolvedAddressee | AddresseeError
): value is AddresseeError {
  return "code" in value && "message" in value;
}

function participantIdOf(ref: ParticipantRef): string {
  return ref.participantId ?? ref.id;
}

function userIdOf(participantId: string): string {
  return participantId.startsWith("user:") ? participantId.slice("user:".length) : participantId;
}

function resolveRosterUser(
  ctx: ResolveAddresseeContext,
  userId: string
): ParticipantRef | undefined {
  const wanted = `user:${userId}`;
  return ctx.roster.find((ref) => {
    if (ref.kind !== "user") return false;
    const id = participantIdOf(ref);
    return id === userId || id === wanted;
  });
}

function resolveUser(ctx: ResolveAddresseeContext, userId: string): ResolvedAddressee | AddresseeError {
  const rosterMatch = resolveRosterUser(ctx, userId);
  if (rosterMatch) {
    return {
      kind: "user",
      channelId: ctx.channelId,
      foreign: false,
      userId: userIdOf(participantIdOf(rosterMatch)),
      participantId: participantIdOf(rosterMatch),
      inRoster: true,
    };
  }
  const known = (ctx.users ?? []).find((entry) => entry.userId === userId);
  if (!known) {
    return {
      code: "unknown-user",
      message: `no workspace user "${userId}"`,
      suggestions: (ctx.users ?? []).slice(0, 5).map((entry) => `user:${entry.userId}`),
    };
  }
  // Off-roster users still get the envelope on the sender's own channel; it is
  // the escalation (plan §4.5) that reaches them, plus an invite affordance.
  return {
    kind: "user",
    channelId: ctx.channelId,
    foreign: false,
    userId: known.userId,
    inRoster: false,
  };
}

/**
 * Resolve one ref against a context. Pure: every lookup table is supplied by
 * the caller, so this stays testable without a channel, a DO, or a clock.
 */
export function resolveAddressee(
  ref: string,
  ctx: ResolveAddresseeContext
): ResolvedAddressee | AddresseeError {
  const parsed = parseAddressee(ref);
  if (isAddresseeError(parsed)) return parsed;

  switch (parsed.kind) {
    case "handle": {
      const resolved = resolveHandle(parsed.handle, ctx.roster);
      if (isHandleResolutionFailure(resolved)) {
        // A person can be addressed by handle before they are on this channel:
        // the workspace member list is the fallback roster. Only an exact,
        // unambiguous handle qualifies — a near-miss stays a failure with
        // suggestions, never a guess.
        if (resolved.error !== "ambiguous") {
          const needle = parsed.handle.toLowerCase();
          const members = (ctx.users ?? []).filter(
            (entry) => entry.handle?.toLowerCase() === needle
          );
          if (members.length === 1) {
            return resolveUser(ctx, (members[0] as AddresseeUserEntry).userId);
          }
        }
        return resolved.error === "ambiguous"
          ? {
              code: "ambiguous-handle",
              message:
                `"@${parsed.handle}" matches more than one participant on this channel. ` +
                `Address one directly: ${resolved.suggestions.join(", ")}.`,
              suggestions: resolved.suggestions,
            }
          : {
              code: "unknown-handle",
              message:
                `no participant "@${parsed.handle}" on this channel.` +
                (resolved.suggestions.length > 0
                  ? ` Did you mean ${resolved.suggestions.join(", ")}?`
                  : " Use list_addressees to see who is here."),
              suggestions: resolved.suggestions,
            };
      }
      // A person is a person however they were named: `@gabriel` and
      // `user:gabriel` must both escalate (plan §4.3 — addressing a person is
      // what asks for their attention), so a human roster hit resolves to the
      // `user` shape, never to a bare participant.
      if (resolved.kind === "user") {
        return resolveUser(ctx, userIdOf(participantIdOf(resolved)));
      }
      return {
        kind: "participant",
        channelId: ctx.channelId,
        foreign: false,
        participantId: participantIdOf(resolved),
        ref: resolved,
      };
    }

    case "participant": {
      const match = ctx.roster.find((entry) => participantIdOf(entry) === parsed.participantId);
      if (!match) {
        return {
          code: "unknown-handle",
          message: `no participant "${parsed.participantId}" on this channel.`,
          suggestions: ctx.roster.slice(0, 5).map(participantIdOf),
        };
      }
      if (match.kind === "user") {
        return resolveUser(ctx, userIdOf(participantIdOf(match)));
      }
      return {
        kind: "participant",
        channelId: ctx.channelId,
        foreign: false,
        participantId: participantIdOf(match),
        ref: match,
      };
    }

    case "user":
      return resolveUser(ctx, userIdOf(parsed.userId));

    case "owner": {
      if (!ctx.ownerUserId) {
        return {
          code: "no-owner",
          message: "this channel has no owning user to address as `owner`",
          suggestions: [],
        };
      }
      return resolveUser(ctx, ctx.ownerUserId);
    }

    case "parent": {
      if (!ctx.parent) {
        return {
          code: "not-a-subagent",
          message: "`parent` is only addressable from a subagent; you have no supervising parent",
          suggestions: [],
        };
      }
      return {
        kind: "parent",
        channelId: ctx.channelId,
        foreign: false,
        participantId: ctx.parent.participantId,
      };
    }

    case "run": {
      const runs = ctx.runs ?? [];
      // Prefix match, as `send_to_subagent` accepted: the display form is
      // elided, so an agent copying a runId out of its transcript still hits.
      const exact = runs.find((entry) => entry.runId === parsed.runId);
      const matches = exact ? [exact] : runs.filter((entry) => entry.runId.startsWith(parsed.runId));
      if (matches.length === 0) {
        return {
          code: "unknown-run",
          message: `no subagent run matching "${parsed.runId}"`,
          suggestions: runs.slice(0, 5).map((entry) => `run:${entry.runId}`),
        };
      }
      if (matches.length > 1) {
        return {
          code: "ambiguous-run",
          message: `"${parsed.runId}" matches ${matches.length} runs; use more of the id`,
          suggestions: matches.slice(0, 5).map((entry) => `run:${entry.runId}`),
        };
      }
      const run = matches[0] as AddresseeRunEntry;
      return {
        kind: "run",
        channelId: run.taskChannelId,
        foreign: true,
        runId: run.runId,
        ...(run.participantId ? { participantId: run.participantId } : {}),
      };
    }

    case "agent": {
      const directory = ctx.directory ?? [];
      const byHandle = directory.filter((entry) => entry.handle === parsed.handle);
      const matches = parsed.channelId
        ? byHandle.filter((entry) => entry.channelId === parsed.channelId)
        : byHandle;
      if (matches.length === 0) {
        return {
          code: "unknown-agent",
          message:
            `no agent instance "${parsed.handle}${parsed.channelId ? `@${parsed.channelId}` : ""}". ` +
            "Use discover_agents to find one.",
          suggestions: directory.slice(0, 5).map((entry) => `agent:${entry.instanceId}`),
        };
      }
      if (matches.length > 1) {
        // A handle without a channel is not an address: the same worker agent
        // commonly sits in several channels, and "which conversation" is part
        // of what you meant (plan §4.4).
        return {
          code: "ambiguous-agent",
          message:
            `"${parsed.handle}" runs in ${matches.length} channels; name one: ` +
            matches.map((entry) => `agent:${entry.instanceId}`).join(", "),
          suggestions: matches.map((entry) => `agent:${entry.instanceId}`),
        };
      }
      const entry = matches[0] as AddresseeDirectoryEntry;
      return {
        kind: "agent",
        channelId: entry.channelId,
        foreign: entry.channelId !== ctx.channelId,
        instanceId: entry.instanceId,
        participantId: entry.participantId,
        handle: entry.handle,
      };
    }

    case "channel": {
      if (parsed.channelId === ctx.channelId) {
        return { kind: "channel", channelId: ctx.channelId, foreign: false };
      }
      return { kind: "external-channel", channelId: parsed.channelId, foreign: true };
    }
  }
}

/**
 * The escalation ladder (plan §4.3). Three explicit rungs, each a superset of
 * the one below, named for what the *recipient* experiences rather than for
 * the sender's urgency assessment — that is the only thing an agent can be
 * held to. There is deliberately no "auto": escalation never consults a guess
 * about whether someone is watching (D12).
 */
export const ALERT_RUNGS = ["none", "inbox", "interrupt"] as const;
export type AlertRung = (typeof ALERT_RUNGS)[number];

export function isAlertRung(value: unknown): value is AlertRung {
  return ALERT_RUNGS.includes(value as AlertRung);
}

/**
 * Addressing a person is what asks for their attention, so `inbox` is the
 * default there and `none` everywhere else. `interrupt` is never a default.
 */
export function defaultAlertRung(addressees: readonly ResolvedAddressee[]): AlertRung {
  return addressees.some(addresseeIsUser) ? "inbox" : "none";
}

/** The default destination when `to:` is omitted — this agent's own channel. */
export function boundChannelAddressee(channelId: string): ResolvedAddressee {
  return { kind: "channel", channelId, foreign: false };
}

/** True when the resolved addressee is a person (drives escalation, §4.5). */
export function addresseeIsUser(resolved: ResolvedAddressee): boolean {
  return resolved.kind === "user";
}
