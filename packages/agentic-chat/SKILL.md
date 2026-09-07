---
name: agentic-chat
description: Compose an agentic conversation surface, select browser capabilities, customize or elide stock UI, route natural-language input, and preserve delivery diagnostics.
---

# Agentic chat composition

Use `AgenticChat` when a product wants canonical channel, trajectory, delivery,
and composer behavior with product-owned presentation. For a wholly custom
layout, compose `useAgenticChat`, `ChatProvider`, and the exported individual
chat components instead.

For a change spanning the chat panel, agent worker, channel, or shared event
contract, read [agentic development](../../skills/agentic-development/SKILL.md).

## Capabilities are explicit

Pass `features` on every `AgenticChat` mount. Supported browser-owned
capabilities are `feedback`, `inline-ui`, `action-bar`, and `client-eval`.
This is an authority boundary, not a visibility preference: an omitted feature
is neither mounted nor advertised as a channel method. The selection stays
fixed for the participant lifetime because changing its method surface requires
a new channel join.

Use presentation callbacks independently of capabilities. Each receives the
complete stock renderer and may return it, wrap it, replace it, or return
`null`:

- `renderMessage`
- `renderInlineGroup`
- `renderInvocation`
- `renderEmptyState`
- `renderHeader`
- `renderDeliveryStatus`
- `renderComposer`

Prefer these boundaries over CSS selectors that depend on component structure.
Use [THEMING.md](THEMING.md) for semantic variables and stable `data-part`
styling slots.

## Natural-language routing

`composerDefaultMentions` supplies recipients only when the player has not
written an explicit mention. Explicit mentions always win. In a multi-agent
product, route ordinary text to one command interpreter and let direct mentions
bypass it; do not broadcast ambiguous player text to every agent.

Set agents that should act only on addressed work to `mentioned-strict`. Disable
the composer with `composerDisabled` until every required default recipient has
a participant identity. Participant IDs—not handles or entity keys—belong in
`composerDefaultMentions`.

Quick actions should publish through the same addressed conversation protocol
as typed input. Do not create a second application command path.

## Diagnostics and elision

Custom invocation renderers should retain a failure-inspection route. A useful
pattern is a product-specific collapsed renderer that delegates to
`defaultContent` when expanded. Eliding routine tool activity must not erase
errors from the durable trajectory or make failed effects impossible to inspect.

`renderDeliveryStatus` owns the stock pending-delivery queue and outbox as one
surface. Elide it only when the product supplies equivalent delivery and error
feedback. Connection failures and dirty-repository warnings remain outside that
renderer because they are operational safety surfaces.

## Verification

Test capability selection separately from presentation. At minimum, cover:

- omitted features do not mount or advertise their methods;
- renderers can preserve, wrap, and elide their default surfaces;
- explicit mentions override default routing;
- the composer remains disabled until its required recipient is ready;
- hidden invocations retain an intentional failure diagnostic.
