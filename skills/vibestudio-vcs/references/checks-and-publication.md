# Checks, publication, and activation

## Build the current context

Build is a projection of source state, not a second history. Use the ordinary
build service with the context ref (`ctx:<contextId>`) and the smallest relevant
unit or package. Inspect its structured esbuild, TypeScript, and authority
diagnostics and repair the cited files
through ordinary local edits. In eval, the direct shape is
`await services.build.getBuildReport(unit, "ctx:" + contextId)`; other clients
should discover the same live `build.getBuildReport` service schema.

Do not mint semantic identities from build keys or content digests. After a
repair, build the new context state again and keep VCS orientation through
`vcs.status`. The local check is deliberately not authority, but it is the
fast path for consuming the same structured diagnostics the publication gate
will enforce.

## Publish through VCS

`vcs.push` is the only protected publication operation. It accepts an exact
clean committed event and the exact main event observed by `status`. Push
validates semantic ancestry and integration completeness, runs the
candidate-state build/typecheck/authority gate for changed units and their transitive
reverse dependents, obtains the required approval, and atomically advances the
protected refs through a durable effect.

Publication protects semantic history as well as bytes. If the committed event
preserves every repository byte, approval still names the exact previous and
new semantic events and main advances. An exact replay of an already-applied
publication does not prompt again; a generic retry or host operation cannot
manufacture publication authority.

Publication does not create a source event. A build/typecheck, ancestry,
integration, authorization, approval, or atomic-ref failure advances no
protected ref.

Handle refusals by typed code:

- merge from the freshly observed main when it advanced; the protected-main
  driver performs its own conflict-only preflight and makes zero mutations if
  conflicts exist;
- on `IntegrationIncomplete`, execute the returned `allRemaining` recovery
  recipe before retrying commit or publication;
- stop for required authorization or approval;
- preserve integrity and host-effect diagnostics;
- for a build/typecheck refusal, consume every diagnostic, repair the cited
  source, rerun the exact-context report, commit the repaired chain, and push
  the new exact committed event.

## Treat post-publication builds as projections

Build subscribers may react to the newly published `main` and produce derived,
content-addressed artifacts. Their success or failure does not rewrite or roll
back the semantic event or protected refs. Use unit diagnostics and server logs
to inspect those projections.

Activation remains fail closed. A failed build, validation, or startup must not
become runnable; the last known-good runnable artifact remains selected. Repair
the source in a new local application, run an explicit context check, commit,
and publish the new event. Unit logs, panel consoles, and screenshots help
debug projections and runtime behavior, but do not replace semantic `status`,
`history`, or provenance inspection.
