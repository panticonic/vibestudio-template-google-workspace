---
name: messaging
description: Message anyone — the channel, a person, another agent, a subagent run — with the notify tool, its addressee grammar, and the escalation ladder.
---

# Messaging

There is one messaging primitive: **`notify`**. It is how you speak to the
channel, how you report to a supervisor, how you steer a child, how you reach a
person's phone, and how you talk to an agent in another conversation. If you are
about to write text that someone else should see, `notify` is the tool.

```
notify({
  content: "…",              // markdown
  to?: string | string[],    // addressees; omit for the whole channel
  alert?: "none" | "inbox" | "interrupt",
  title?: string,            // headline for escalated surfaces
  replyTo?: string,
  attachments?: string[],    // image paths in your working tree
})
```

## Who you can address

`to` takes one ref or a list. Omitting it addresses the whole channel.

| Ref | Reaches |
|---|---|
| *(omitted)* | everyone in this conversation |
| `@handle` | one participant here — an agent or a person; a person is also found by handle when they are a workspace member who has not joined this channel yet |
| `participant:<id>` | the same, by exact id |
| `user:<id>` | a specific person, on this channel or not (they are added to it) |
| `owner` | the person this channel belongs to (fails when there is more than one person here — nobody is guessed) |
| `parent` | your supervisor, when you are a subagent |
| `run:<runId>` | a subagent you spawned, in its own task channel |
| `agent:<handle>@<channelId>` | an agent instance in another conversation |
| `channel:<id>` | everyone in another conversation |

Run a `list_addressees` to see exactly these, filled in, for where you are
standing. Every row prints the string `to` accepts — discovery output is notify
input, so there is nothing to translate.

**Unresolvable refs fail the call.** A misspelled handle comes back with
suggestions rather than being broadcast to everyone; a handle that matches two
participants comes back asking which. This is deliberate: guessing is how an
agent tells the wrong person something.

## The alert ladder

Three rungs, each a superset of the one below. They are named for what the
*recipient experiences*, because that is the only thing you can be held to —
not for how urgent the news feels to you.

| Rung | What the person gets | When |
|---|---|---|
| `none` | the message in the channel, nothing else | agent-to-agent, and ordinary channel utterances. The default. |
| `inbox` | + a durable notification entry and a phone push | the default whenever you address a person. It lands and it travels, without seizing a screen. |
| `interrupt` | + a toast on whatever they are doing | only for something they would want to be pulled away from. |

Escalation is **explicit**: an untargeted `notify` is a plain channel message.
A rung above `none` reaches the people you addressed — or, when you raised the
rung on purpose without naming anyone, the people in this conversation. Nobody
outside the conversation is ever guessed at.

What the person sees: a notification-center row (grouped per agent, so two
reports before they look read as one), a phone notification, and — at
`interrupt` — a toast. From any of these they can **reply in place** in a
lightweight conversation view bound to your channel, or open the full chat
panel landed on your message. The durable entry retires only when the person
explicitly replies, opens it from the inbox, or dismisses it. Rendering a
mounted chat panel is not acknowledgement: window visibility, panel presence,
and human attention are different facts. Do not re-notify an entry the person
has already disposed of.

Worked examples:

```ts
// A milestone your supervisor should see. No person is addressed, no escalation.
notify({ content: "Fixture landed; verification is green.", to: "parent" });

// A background run finishing while nobody is watching. This is what phones are for.
notify({
  to: "owner",
  title: "Nightly build failed",
  content: "`packages/agent-loop` — 3 tests red since 02:14. [details](…)",
});                                   // alert defaults to "inbox"

// Something that should not wait.
notify({
  to: "owner",
  alert: "interrupt",
  title: "Production deploy is rolling back",
  content: "The 14:20 deploy is reverting. Nothing is lost; it needs a decision.",
});
```

For a recurring notification, put the same explicit `notify` call in an
agent-owned automation prompt. Use `alert: "inbox"` explicitly even though
person-addressed messages currently default there. `notify` is an agent tool,
not a service operation, so omit the automation `operations` list unless the
action separately makes concrete external service calls. See
[Automations](../automations/SKILL.md); `launch_automation` immediately creates
the active revision and seals the current agent's identity and installed image.

An explicit `inbox` or `interrupt` rung is part of the tool effect. If its
durable entry or live inbox invalidation fails, `notify` fails rather than
claiming delivery merely because the channel message was published. An
automation that completes its turn after such a failure is recorded as
`completed-with-errors`; its inspector shows the exact failed invocation and
the mission owner projects an addressed failure entry through the ordinary
durable GAD inbox. That projection retries independently of the canonical run.

## Etiquette

Notification is cheap. Keep it **rare**.

- **Notable circumstances only.** Report what this conversation has established
  as report-worthy and what the user or your supervisor asked to hear about.
  Turn narration is not a notification.
- **Expectations are addressable state.** "Only tell me when it's done" and
  "keep me posted" both override the defaults above. When you spawn a subagent,
  say in its task what you want to hear about.
- **Steer, don't poll.** `notify({ to: "run:<runId>" })` is for correcting
  course or supplying information the child lacks. Progress is read with
  `inspect_subagent` / `read_subagent` and arrives on terminal delivery.
  Messaging a working child to ask how it is going costs it a turn and buys
  nothing.
- **Prefer addressed over broadcast.** An addressed message wakes exactly who
  should act; a broadcast makes everyone decide whether it was for them.
- **Break ping cycles.** Do not reply to acknowledgments, do not thank, do not
  re-notify what the recipient already acknowledged. If an exchange stops
  producing new information, stop messaging. There is a hop cap underneath you,
  but it is a backstop, not a budget to spend.

## Finding someone to talk to

- `list_addressees` — everyone reachable from where you are: this channel's
  roster, your supervisor, your live runs, and running agents elsewhere.
- `discover_agents({ query })` — search by *purpose*: "gmail triage", "nightly
  builds". Results carry each instance's own latest deliberate message as its
  overview, and print `agent:<handle>@<channelId>` refs ready to paste into
  `notify`.

**Be findable.** The directory searches each instance's handle, name, its
one-line description, and its latest deliberate message. Set the description
yourself with `set_description("…")` — what you are for and what you are doing
here — and update it when that changes materially. An agent with no
description is found only by its handle.

An agent instance is a **(worker, channel) pair**. The same worker sitting in
three conversations is three instances with three refs, because "message the
gmail agent" is meaningless without saying *where*. Addressing a bare
`agent:<handle>` when the worker runs in several channels fails with the list.

Instances that have left their channel stay discoverable with
`includeTerminal`. Their channels are durable, so messaging one wakes it — that
is how you resume a conversation with an agent that finished weeks ago. Status
is `running` / `idle` / `terminal`, flipped by lifecycle events only; `idle`
includes an agent whose process has been evicted — it wakes on your message
exactly like a running one.

## Talking to an agent in another conversation

```ts
notify({
  to: "agent:gmail@ch-inbox-triage",
  content: "Can you extract the newsletter senders from the last 20 messages tagged `newsletters`?",
});
```

The message lands as an ordinary message in *their* channel, marked as coming
from you and from here; they can reply symmetrically — a guest message tells its
recipient the exact `agent:<handle>@<channelId>` ref to answer with. Your own
channel records a reference to it, not a copy — the utterance exists once,
where it was said. Guest messages are not editable after sending.

Two consequences worth knowing:

- The conversation-depth cap travels with the message. A ping-pong across two
  channels is bounded exactly like one inside a single channel.
- A channel with locked membership refuses guests, and says so as a *closed
  channel* rather than as an unknown addressee. Do not retry it.

## What `notify` is not

It does not compel a reply. It makes one *possible* (the recipient is addressed,
so their respond policy can wake them) and *observable* (the message is durable
and the escalation is recorded). Whether anyone answers is theirs to decide.

For a blocking question you cannot continue without, use `ask_user`.
