---
name: capabilities
description: Declare, discover, inspect, or debug authority grants, workspace services, and provider-owned capabilities.
---

# Capabilities and workspace services

Read before adding a host effect, worker/DO API, authority request, or approval
boundary. For host enforcement, automation execution, product seeds, or the System
Agent, also read the [authority implementation
checklist](references/authority-implementation-checklist.md).

## Authority layers

1. **Method contract** — defines principals, receiver/resource derivation,
   effect, sensitivity, and tier.
2. **Authority manifest** — the installed unit's maximum gated/critical
   authority request. A request is not a grant.
3. **Host grant or fresh approval** — authorizes an eligible request. Open
   methods need no grant; critical effects require a fresh decision.
4. **Provided capability** — a workspace provider protects a resource it owns.
   The receiver enforces it before provider code runs. Downstream host effects
   (credentials, egress, publication, browser) remain independently protected.

Discovery, generated docs, builds, censuses, and observed invocations are never
grants. Generated authority catalogs are review evidence; admission comes from a
decision over the exact sealed unit and manifest.

## Inspect or acquire authority

Use live docs for `permissions`, `authority.preflight`, and the target service's
method contract. Permission inventory is read-only; modify decisions only
through the owning host surface.

Let the real protected operation enter the normal acquisition path. Never ask
for authority inside provider code, probe with a broader call, or retry through
another caller. Use preflight only when knowing the structured outcome before
the effect is useful.

Opaque preparation handles identify provider-owned state but don't authorize it.
Produce them with the declared handle mechanism and bind consumers to the
matching capability and argument. Never accept or invent a raw selector as a
substitute.

## Author a dynamic workspace service

Workspace services resolve from the caller's semantic context, not a startup
scan or static catalog.

1. Add the provider method with its explicit `@rpc` receiver contract.
2. Use `workspace_service` with `operation: "upsert"` to update service and
   singleton declaration atomically. Supply presentation, notability,
   principals, protocol, source, and transport per its schema. Never splice
   these YAML lists by hand.
3. Use `docs_search` and `docs_open` as agent tools. Absence is a declaration or
   build diagnostic; don't poll or guess a route.
4. In eval, resolve the documented protocol and call the returned target:

   ```ts
   import { rpc, workers } from "@workspace/runtime";

   const service = await workers.resolveService("example.protocol");
   return rpc.call(service.targetId, "methodName", []);
   ```

`docs_search` and `docs_open` are not eval globals or runtime exports. Never
source-scan another unit to reconstruct the roster or add dynamic service names
to a generated host catalog.

Use `workers.listServices()` only for lightweight enumeration, then open the
returned docs ID before choosing a method. Use `resolveDurableObject(...)` only
for explicitly lifecycle-owned objects addressed by source, class, and key
rather than a discoverable service.

## Protect provider-owned resources

Declare local capabilities in `authority.provides` and bind each protected
receiver through its `@rpc` effect or extension method authority. Use the
declared receiver resource for simple values and opaque handles for private
provider state.

An installed consumer requests `workspace-service:<name>` in its manifest.
Evaluated code has no installed-unit manifest ceiling; live selection,
task/mission admission, session grants, receiver policy, context lineage, and
content integrity still intersect at the call.

Never mark a protected method open to compensate for a missing service
declaration or consumer request. Fix the owning contract.

## Author an executable unit request

For a panel, worker, app, extension, or package performing gated/critical work:

1. Find the typed operation and exact resource through live docs.
2. Add the narrow request to `package.json#vibestudio.authority.requests`. Don't
   request open methods or host lifecycle plumbing.
3. Use the narrowest exact identity, origin, domain, or intentional prefix.
   Never use a wildcard to silence a build error.
4. Build or typecheck the exact `ctx:<contextId>` working state. The build seals
   and checks the manifest but doesn't write or approve it.
5. Exercise the real path. On denial, follow structured remediation rather than
   catching `EACCES` and trying a parallel route.

Version-bound grants follow the exact execution digest, so shared library
changes affect reviewed identities of executable dependents. Carry a reviewed
identity into activation; don't add a second approval around build, startup, or
first use.

## Relationship authority

Panel-tree placement is presentation, not authority. Immutable launch ancestry
can prove control over runtimes a panel, its bound agent, or that agent's eval
created. Moving an unrelated panel into a collection doesn't transfer that
relationship or its context authority.

Never propagate capabilities through ancestors, descendants, or reparenting.
Have a coordinator spawn resources it should control; otherwise preserve
provenance and use the exact context-boundary decision.

## Content integrity, missions, and product agents

Content provenance is authority input. The host stamps files and durable
messages at write boundaries and advances the receiving session's monotone
integrity latch on reads. Never accept caller-supplied content class, copy
content to disguise origin, or invent/parse lineage-set coordinates. Use
`contextIntegrity.explain` for bounded diagnostics from the current session.

A continuing automation is an ordinary wake-up of its existing agent and uses
that conversation task's authority. A fresh-agent or non-agentic automation
revision is a durable mission principal over an exact charter and host-compiled
authority plan. Userland declares semantic service operations; it never authors
capability rows. The host derives capability and resource leaves from receiver
contracts, stores the immutable authority-plan artifact, and acquires eligible
grants for the existing task or `mission:<id>@<revisionDigest>` as appropriate.
Editing an isolated mission creates a new subject. Pausing stops new admission
without revoking existing task or mission grants.

Mission execution admission binds the isolated subject and plan provenance to
one authenticated agent turn, eval run, or method invocation. A continuing
turn uses ordinary task execution instead. Causal child calls inherit the
ordinary authorization context. Channel IDs are routing facts, never authority subjects.
Missing runtime authority uses ordinary acquisition; do not force automation
eval into `pregranted-only` mode. The plan predicts launch-time acquisition; it
does not authorize, deny, or structurally expose a runtime call.

The RPC runtime keeps an admitted parent active until every outbound operation
it started settles, across direct clients, request-scoped clients, and typed
peers, including when the parent handler throws. Do not use `waitUntil` or a
floating promise as authority inheritance. Work intended to begin after the
parent closes must be persisted and admitted as a new execution.

The System Agent is a product-owned mission with a product-derived worker,
prompt, roster, tools, and execution identity. It uses ordinary typed services
inside eval. Never add a special transport, receiver bypass, approval channel,
workspace prompt injection, self-grant path, or credential extraction route. Use
the checklist for exact invariants and verification.

## Diagnose a denial

Read the live method and provider contract, then follow the structured reason
and remediation:

| Outcome                                                               | Action                                                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Missing grant/content-lineage decision with user-approval remediation | Let the acquisition flow request the exact decision. Retry only after it resolves.         |
| Installed code didn't request the capability                          | Add the narrow request to the manifest and submit a newly sealed unit for review.          |
| Undeclared receiver                                                   | Add or repair the provider's reviewed receiver contract. Caller grants can't authorize it. |
| Principal, relationship, session, attestation, or explicit denial     | Terminal for that invocation — follow its exact remediation.                               |

Inspect sealed build metadata and execution identity, not only mutable source.
Preserve structured errors and the original caller across internal legs. Unknown
schemas, missing provider declarations, missing provenance, and unclassified
authority fail closed.
