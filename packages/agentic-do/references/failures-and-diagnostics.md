# Failures and diagnostics

## One failure object

Every failed tool effect is normalized to `agent-tool-failure.v1` before the
terminal trajectory event is appended. Treat this object—not rendered prose—as
the control-flow contract:

- `code`, `kind`, `operation`, and `stage` locate the failure;
- `retry.policy` and `retry.commandIdPolicy` define the only safe recovery;
- `causal` carries available invocation, semantic command, effect, context, and
  receipt identities;
- `causes[0]` is the primary failure;
- cleanup, rollback, and transport faults are later causes and never replace
  the primary failure; and
- `data` preserves the bounded typed service detail.

`invocation.failed.payload.failure` is durable trajectory evidence. Tool
protocol content and eval `errorData` are presentations of the same failure,
not separate error channels. Render human guidance with
`renderAgentToolFailure`; branch with the typed fields.

Normalize errors at the boundary that first knows the operation and stage:

```ts
import { agentToolFailureFromUnknown } from "@workspace/agentic-protocol";

const failure = agentToolFailureFromUnknown(error, {
  operation: "fs.readdir",
  stage: "list-directory",
  causal: { invocationId },
});
```

Do not flatten a caught exception to `String(error)`, discard `errorData`, or
throw cleanup in place of the original operation error.

## One bounded causal packet

Use the public runtime GAD client to join one invocation to its durable turn,
events, semantic commands, effect intents, and receipts:

```ts
import { gad } from "@workspace/runtime";

const packet = await gad.diagnoseInvocation({
  trajectoryId,
  branchId,
  invocationId,
  eventLimit: 20,
  commandLimit: 20,
  effectLimit: 50,
});
```

The packet is read-only and exact-coordinate scoped. `summary.truncated`
reports whether any bounded section has more evidence. A missing coordinate
returns the requested coordinate with null invocation/turn and empty joined
collections; it is not guessed from a similarly named call. Use the full
trajectory only when this packet is insufficient.

For an outside-lineage authority refusal, `contextIntegrity.fact()` gives the
session latch and `contextIntegrity.explain({ key, cursor, limit })` pages the
verified exact leaf membership of a lineage-set coordinate. Cursors are opaque
and bound to the requested set. Do not parse the lineage-set digest or request
unrelated session lineage.
