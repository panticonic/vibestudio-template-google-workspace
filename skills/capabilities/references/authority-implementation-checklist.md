# Authority implementation checklist

Use this checklist for host enforcement and cross-cutting authority changes. The
capabilities skill contains the userland authoring loop; this reference covers the
host review inputs that must remain explicit.

## Add or change a host service method

1. Define a strict schema in `packages/service-schemas`. Reject unknown fields at the
   boundary and keep caller/session/owner identity out of arguments when the host can
   derive it.
2. Declare the receiver contract on the service definition: admitted principal kinds,
   relationship/resource derivation, sensitivity, and effect.
3. Assign the reviewed tier on that same method schema. Tier is static method
   semantics: open, gated, or critical. Do not infer it from current callers.
4. Map the method to a semantic capability on the method schema. Several transport
   methods may intentionally share one user decision.
5. For every promptable static host method, add plain-language `presentation` copy
   on the method schema. Write what the user allows, not the RPC verb. Use
   `{requesterKind}` only for the panel, worker, app, extension, or agent kind;
   display identity and immutable authority identity are separate fields. The
   read-only projection is
   `packages/shared/src/authority/hostAuthorityCatalog.generated.ts`.
6. Implement the handler without accepting authority facts from arguments. Preserve
   the verified caller and authorization context on downstream calls.
7. Update the explicit receiver-review input in
   `scripts/runtime-authority-review.json`. Its census digest is a drift detector;
   the per-method rationale is the human review. Regenerating derived ledgers is not
   approval.
8. Add tests for admitted and rejected principal/relationship/resource cases,
   malformed schemas, semantic capability grouping, tier/presentation coverage, and
   downstream caller preservation.

Dynamic workspace service copy does not belong in the host presentation census. Put
its stable user-facing `title`, `action`, and `description` in the live workspace
service declaration; live docs and resolution consume that same declaration.

## Add or change an executable workspace unit

1. Put gated/critical requests performed by the installed unit in its checked-in
   `package.json#vibestudio.authority.requests`.
2. Build the exact semantic context. The build seals the manifest and dependency
   closure but never writes or approves it.
3. Review the exact effective version: source, transitive dependencies, runtime ABI,
   and direct requests.
4. Show added human-readable capabilities first. Keep unchanged capabilities
   collapsed and summarize removals. One version decision covers code plus its full
   authority contract.
5. Carry the admitted exact identity into activation. Do not ask again during build,
   startup, or first use.
6. On a fresh workspace, batch all previously unreviewed executable units into one
   progressive-disclosure startup decision rather than one prompt per unit or
   capability.

Static census generation is valid for shipped host methods. Workspace-built services
and intra-workspace capabilities stay context-relative: declare them in the semantic
workspace, discover them through live docs, and resolve them through the live service
registry. Never regenerate a static host catalog to approve workspace code.

## Change a mission

Treat these as one contract:

- exact immutable execution image;
- action, conversation mode, and trigger;
- semantic operation intents;
- host-compiled, content-addressed authority plan for pre-acquisition, with compiler and catalog versions;
- durable subject `mission:<id>@<revisionDigest>` and attributed owner;
- durable target authority requests and grants; and
- generic executor admission and causal inheritance.

The host compiler—not userland—derives capability/resource leaves from receiver
contracts. Store the canonical authority-plan body under its digest; never trust a body
supplied by the mission store or recompile an old revision against a newer
catalog during admission.

Launch registers the subject and begins eligible standing acquisition. Pending
requests belong to the revision, survive the launching execution and host
restart, and deduplicate by revision plan plus compiled operation. Runtime
misses still enter ordinary acquisition and may park the invocation.

Editing creates a new revision subject. Prevent new admission to the retired
subject, terminalize its live executions, then revoke its grants. Pause is not
retirement: it prevents new runs while preserving the same subject and grants.

Execution admission must represent agent-turn, eval, and method executors in
one authenticated schema with an idempotent admission key, exact image, policy
digest, parent derivation, renewal owner, and terminal closure. Do not add a
second transport for one executor kind or bind authority to a channel ID.

Observe causal outbound operations in the generic RPC core, including direct,
request-scoped, and typed-peer calls. Parent closure fences new children only
after every operation already started has settled, on both handler success and
failure. Delayed/background work that has not yet started is a separate durable
execution and must not inherit an expired parent through `waitUntil`.

Preserve terminal child-effect failures through turn closure. A mission run may
be `succeeded` only when its turn and every terminal child effect succeeded;
otherwise use `completed-with-errors` with exact invocation evidence or
`failed` when the turn itself failed.

## Change a product-seeded mission

Seed files are strict, checked-in reviewed inputs under the host's seed directory.
Resolve `@seed` harness and skill hashes only from immutable product snapshot outputs.
Key reconciliation by the exact product snapshot state and preserve the host/system
owner. On snapshot drift, create and activate a new exact revision, prevent new
old admissions, finish old executions, and only then revoke old revision grants.

Do not read mutable workspace source to construct a product seed. Do not add a
compatibility or repair path for old schemas; migrate forward and fail closed on
unknown schemas.

## Change the System Agent

Treat these invariants as one boundary:

- one deterministic conversation per workspace, authenticated user, and immutable
  product snapshot;
- host-derived context, channel, agent key, and exact locked membership;
- product-blessed worker effective version and execution digest;
- product prompt and eval handbook;
- no workspace prompt override, skill injection, or memory recall;
- exactly `eval` and `notify` as model-facing tools;
- ordinary typed service/runtime APIs inside eval;
- no non-delegated approval payload or settlement;
- no delegation activation, renewal, or widening from conversation eval;
- no self-blessing, self-grant mutation, or credential extraction; and
- desktop and mobile clients call the same typed lifecycle service.

A missing shell feature is not grounds for a System Agent bypass. Add or improve the
shared semantic service, receiver contract, presentation, and mission exposure so
ordinary clients and the System Agent use the same boundary.

## Verification

Run the narrow deterministic tests first, then:

1. authority manifest and runtime receiver-review checks;
2. host, workerd, userland, and mobile type checks;
3. host and workspace conventional test suites;
4. desktop and mobile approval/lifecycle coverage;
5. Iroh remote-transport smoke coverage; and
6. vague model-backed system tests only when model capacity is available.

Model-backed failures are evidence about infrastructure, APIs, or guidance. Do not
make prompts more prescriptive to route around a platform defect, and do not increase
optional eval or model-stream timeouts. Terminal infrastructure failure must settle
the invocation and owning turn.

At tool/service boundaries, preserve structured error data and normalize the
terminal record to `agent-tool-failure.v1`. The original operation failure is
always the primary cause; cleanup, rollback, and transport failures are
secondary evidence. Include exact causal IDs and a typed retry policy when
known. Never make prose parsing, a cleanup throw, or a second error channel the
control-flow contract.
