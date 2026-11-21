# Open Google Calendar goals

The user asks for a scheduling decision. The workflow discovers calendars
available to the caller and reconciles the requested proposals and conflicting
resource events. A staged handoff records an evidence-backed recommendation.
It does not book time on a calendar.

| Responsibility | Implementation |
| --- | --- |
| Identify proposal and resource calendars and a time window | `chooseCalendarPlan` is a data-only judgment over the goal and the observed catalog. Its caller discovers the sources first and uses the returned plan to read provider windows. |
| Read and refresh complete calendar windows | The installed Calendar client follows provider pages. The mechanism binds bounded authorized coordinates, preserves revisions and local dates, and normalizes timestamps to UTC. |
| Identify valid proposals and blockers | `chooseCalendarOutcome` resolves provider revisions and delegates overlap, closure and evidence interpretation to scoped lambdas. |
| Reconcile changed provider state | `reconcileCalendarPlan` reopens relevant windows before a handoff, consumes new evidence, and reads back the selected event by its authoritative ID. A changed or missing proposal leaves the recommendation stale. |
| Persist a workspace handoff | TypeScript stages exact observed evidence in owned scratch and returns a digest after independent readback. |

Managed scenarios use the installed provider client against an owned,
read-only HTTP transport. The transport retains every request and can change
records between pages, before a refresh, or before event readback. The
verifier owns expected outcomes and checks actual source versions, provider
requests and scratch bytes after the Natlang call. Independent calendar reads
can occur in any order across calendars. Within a calendar, its initial and
refreshed pages and their cursor order must match the provider. Catalog
discovery precedes event windows and the final event readback follows them.

The owner supplies `{ contextId, caseId }` and a world to
`prepareOpenCalendarGoal` from `@workspace-skills/open-calendar-goal/managed`.
Mount `program` and bind the returned services for a run of
`workOnCalendarGoal(goal)`. The original goal is the only program argument.
The exported `verify(outcome)` independently verifies the outcome and effects.
The exported `qualify()` exercises the same installed client and workspace
filesystem from the reference path without invoking a model.
