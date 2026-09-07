import { describe, expect, it } from "vitest";
import type { ParticipantRef } from "./events.js";
import {
  defaultAlertRung,
  isAddresseeError,
  parseAddressee,
  resolveAddressee,
  type ResolveAddresseeContext,
  type ResolvedAddressee,
} from "./addressee.js";
import { isHandleResolutionFailure, resolveHandle } from "./participant-ref.js";

function agent(handle: string, participantId = `do:${handle}`): ParticipantRef {
  return { kind: "agent", id: participantId, participantId, metadata: { handle } };
}

function human(userId: string, handle?: string, displayName?: string): ParticipantRef {
  return {
    kind: "user",
    id: `user:${userId}`,
    participantId: `user:${userId}`,
    ...(displayName ? { displayName } : {}),
    ...(handle ? { metadata: { handle } } : {}),
  };
}

const ROSTER: ParticipantRef[] = [agent("explorer"), agent("scribe"), human("gabriel", "gabriel")];

function ctx(overrides: Partial<ResolveAddresseeContext> = {}): ResolveAddresseeContext {
  return { channelId: "ch-home", roster: ROSTER, ...overrides };
}

function expectResolved(
  value: ResolvedAddressee | ReturnType<typeof parseAddressee>
): ResolvedAddressee {
  if (isAddresseeError(value)) throw new Error(`expected resolution, got ${value.message}`);
  return value as ResolvedAddressee;
}

describe("resolveHandle", () => {
  it("resolves an agent handle, which resolveMentionToUser never could", () => {
    const resolved = resolveHandle("explorer", ROSTER);
    expect(isHandleResolutionFailure(resolved)).toBe(false);
    expect((resolved as ParticipantRef).participantId).toBe("do:explorer");
  });

  it("matches ids before handles regardless of roster order", () => {
    // "scribe" is do:scribe's id-shaped name for one entry and the handle of a
    // later one; the id tier must win even though the handle appears first.
    const roster = [agent("scribe", "do:scribe-2"), agent("other", "scribe")];
    const resolved = resolveHandle("scribe", roster);
    expect((resolved as ParticipantRef).participantId).toBe("scribe");
  });

  it("fails closed on an ambiguous handle instead of picking one", () => {
    const roster = [agent("twin", "do:a"), agent("twin", "do:b")];
    const resolved = resolveHandle("twin", roster);
    expect(isHandleResolutionFailure(resolved)).toBe(true);
    expect(resolved).toMatchObject({ error: "ambiguous", suggestions: ["do:a", "do:b"] });
  });

  it("honours the kinds filter (ask_user stays human-only)", () => {
    expect(resolveHandle("explorer", ROSTER, { kinds: ["user"] })).toMatchObject({
      error: "unknown",
    });
  });

  it("suggests near misses without resolving them", () => {
    const resolved = resolveHandle("explor", ROSTER);
    expect(resolved).toMatchObject({ error: "unknown", suggestions: ["@explorer"] });
  });

  it("matches displayName only after handles", () => {
    const roster = [human("a", "ana", "Bo"), human("b", "bo")];
    expect((resolveHandle("bo", roster) as ParticipantRef).participantId).toBe("user:b");
  });
});

describe("parseAddressee", () => {
  it("parses each kind of the grammar", () => {
    expect(parseAddressee("@explorer")).toEqual({ kind: "handle", handle: "explorer" });
    expect(parseAddressee("explorer")).toEqual({ kind: "handle", handle: "explorer" });
    expect(parseAddressee("parent")).toEqual({ kind: "parent" });
    expect(parseAddressee("owner")).toEqual({ kind: "owner" });
    expect(parseAddressee("run:abc")).toEqual({ kind: "run", runId: "abc" });
    expect(parseAddressee("user:gabriel")).toEqual({ kind: "user", userId: "gabriel" });
    expect(parseAddressee("participant:do:x")).toEqual({
      kind: "participant",
      participantId: "do:x",
    });
    expect(parseAddressee("channel:ch-2")).toEqual({ kind: "channel", channelId: "ch-2" });
    expect(parseAddressee("agent:gmail@ch-9")).toEqual({
      kind: "agent",
      handle: "gmail",
      channelId: "ch-9",
    });
    expect(parseAddressee("agent:gmail")).toEqual({ kind: "agent", handle: "gmail" });
  });

  it("rejects malformed refs with a message that names the grammar", () => {
    const error = parseAddressee("thing:x");
    expect(isAddresseeError(error)).toBe(true);
    expect((error as { message: string }).message).toContain("agent:<handle>@<channelId>");
    expect(parseAddressee("   ")).toMatchObject({ code: "malformed" });
    expect(parseAddressee("run:")).toMatchObject({ code: "malformed" });
  });
});

describe("resolveAddressee", () => {
  it("resolves a handle to a channel participant", () => {
    const resolved = expectResolved(resolveAddressee("@explorer", ctx()));
    expect(resolved).toMatchObject({
      kind: "participant",
      channelId: "ch-home",
      foreign: false,
      participantId: "do:explorer",
    });
  });

  it("fails closed with suggestions on an unknown handle", () => {
    const error = resolveAddressee("@explore", ctx());
    expect(error).toMatchObject({ code: "unknown-handle", suggestions: ["@explorer"] });
  });

  it("refuses `parent` when the sender is not a subagent", () => {
    expect(resolveAddressee("parent", ctx())).toMatchObject({ code: "not-a-subagent" });
    expect(
      expectResolved(resolveAddressee("parent", ctx({ parent: { participantId: "do:boss" } })))
    ).toMatchObject({ kind: "parent", participantId: "do:boss" });
  });

  it("prefix-matches a run id and targets the child's task channel", () => {
    const runs = [{ runId: "run-abcdef", taskChannelId: "ch-task", participantId: "do:child" }];
    const resolved = expectResolved(resolveAddressee("run:run-abc", ctx({ runs })));
    expect(resolved).toMatchObject({
      kind: "run",
      channelId: "ch-task",
      foreign: true,
      runId: "run-abcdef",
    });
  });

  it("refuses an ambiguous run prefix rather than steering the wrong child", () => {
    const runs = [
      { runId: "run-a1", taskChannelId: "ch-1" },
      { runId: "run-a2", taskChannelId: "ch-2" },
    ];
    expect(resolveAddressee("run:run-a", ctx({ runs }))).toMatchObject({ code: "ambiguous-run" });
  });

  it("resolves an agent instance and marks a foreign channel", () => {
    const directory = [
      {
        instanceId: "gmail@ch-mail",
        handle: "gmail",
        channelId: "ch-mail",
        participantId: "do:gmail",
      },
    ];
    const resolved = expectResolved(resolveAddressee("agent:gmail@ch-mail", ctx({ directory })));
    expect(resolved).toMatchObject({ kind: "agent", channelId: "ch-mail", foreign: true });
  });

  it("refuses a handle-only agent ref when the worker runs in several channels", () => {
    const directory = [
      { instanceId: "gmail@ch-a", handle: "gmail", channelId: "ch-a", participantId: "do:gmail" },
      { instanceId: "gmail@ch-b", handle: "gmail", channelId: "ch-b", participantId: "do:gmail" },
    ];
    const error = resolveAddressee("agent:gmail", ctx({ directory }));
    expect(error).toMatchObject({ code: "ambiguous-agent" });
    expect((error as { suggestions: string[] }).suggestions).toEqual([
      "agent:gmail@ch-a",
      "agent:gmail@ch-b",
    ]);
  });

  it("resolves an in-roster user to their participant, and an off-roster user to the workspace", () => {
    const inRoster = expectResolved(resolveAddressee("user:gabriel", ctx()));
    expect(inRoster).toMatchObject({ kind: "user", inRoster: true, participantId: "user:gabriel" });

    const offRoster = expectResolved(
      resolveAddressee("user:sam", ctx({ users: [{ userId: "sam" }] }))
    );
    expect(offRoster).toMatchObject({ kind: "user", inRoster: false, userId: "sam" });
    // The envelope still belongs to the sender's own channel; escalation is
    // what reaches an off-roster person (plan §4.5).
    expect(offRoster).toMatchObject({ channelId: "ch-home", foreign: false });
  });

  it("falls back to a workspace member for an @handle nobody on the roster carries", () => {
    const users = [
      { userId: "sam", handle: "sam" },
      { userId: "alex", handle: "alex" },
    ];
    const resolved = expectResolved(resolveAddressee("@sam", ctx({ users })));
    expect(resolved).toMatchObject({ kind: "user", userId: "sam", inRoster: false });
    // The fallback is exact-only: a near miss still fails closed with the
    // roster's suggestions rather than picking a member.
    const miss = resolveAddressee("@sa", ctx({ users }));
    expect(isAddresseeError(miss) && miss.code).toBe("unknown-handle");
    // A roster hit always wins over a member with the same handle.
    const onRoster = expectResolved(
      resolveAddressee("@gabriel", ctx({ users: [{ userId: "gabriel", handle: "gabriel" }] }))
    );
    expect(onRoster).toMatchObject({ kind: "user", inRoster: true });
  });

  it("resolves `owner` through the channel owner", () => {
    const resolved = expectResolved(resolveAddressee("owner", ctx({ ownerUserId: "gabriel" })));
    expect(resolved).toMatchObject({ kind: "user", userId: "gabriel", inRoster: true });
    expect(resolveAddressee("owner", ctx())).toMatchObject({ code: "no-owner" });
  });

  it("treats the bound channel as local even when addressed explicitly", () => {
    expect(expectResolved(resolveAddressee("channel:ch-home", ctx()))).toMatchObject({
      kind: "channel",
      foreign: false,
    });
    expect(expectResolved(resolveAddressee("channel:ch-2", ctx()))).toMatchObject({
      kind: "external-channel",
      foreign: true,
    });
  });
});

describe("defaultAlertRung", () => {
  it("escalates only when a person is addressed", () => {
    const channel: ResolvedAddressee = { kind: "channel", channelId: "ch", foreign: false };
    const user: ResolvedAddressee = {
      kind: "user",
      channelId: "ch",
      foreign: false,
      userId: "gabriel",
      inRoster: true,
    };
    expect(defaultAlertRung([channel])).toBe("none");
    expect(defaultAlertRung([channel, user])).toBe("inbox");
    expect(defaultAlertRung([])).toBe("none");
  });
});
