<!-- GENERATED FILE — run: pnpm generate:vcs-skill-release -->

# Public VCS contract

This is a portable projection of `packages/service-schemas/src/vcs.ts`. The service schema is
the only wire-contract authority; the skill explains how to use it. Exact
request and response JSON Schemas are in
[public-contract.json](public-contract.json).

State is named only by committed events and local work applications. Every
mutation except `push` advances an exact context working head; `commit` and
`discard` consume the complete local application chain.

## Methods

| Method | Class | Purpose | Typed errors |
| --- | --- | --- | --- |
| `vcs.edit` | `context-write` | Atomically create repositories with their initial files or author exact text, binary, file-create, delete, and mode changes on the working head. | `RevisionChanged`, `Unauthorized`, `InvalidReference`, `NoEffect`, `CommandIdReuse`, `ScopeTooLarge`, `IntegrityFailure`, `DestinationOccupied` |
| `vcs.move` | `context-write` | Move stable file or repository identities without reconstructing intent from bytes. | `RevisionChanged`, `Unauthorized`, `InvalidReference`, `NoEffect`, `CommandIdReuse`, `ScopeTooLarge`, `IntegrityFailure`, `DestinationOccupied` |
| `vcs.copy` | `context-write` | Copy exact source files into new identities with immediate coordinate provenance. | `RevisionChanged`, `Unauthorized`, `InvalidReference`, `NoEffect`, `CommandIdReuse`, `ScopeTooLarge`, `IntegrityFailure`, `DestinationOccupied` |
| `vcs.merge` | `context-write` | Merge one bounded page of stable coordinates from an exact event or external delta by net effect. | `RevisionChanged`, `Unauthorized`, `InvalidReference`, `NoEffect`, `CommandIdReuse`, `ScopeTooLarge`, `IntegrityFailure`, `ConflictPresent`, `CoupledGroupIncomplete` |
| `vcs.revert` | `context-write` | Author explicit counteractions of exact semantic changes. | `RevisionChanged`, `Unauthorized`, `InvalidReference`, `NoEffect`, `CommandIdReuse`, `ScopeTooLarge`, `IntegrityFailure`, `ConflictPresent` |
| `vcs.commit` | `context-write` | Commit the complete local application chain; derive every integration parent from recorded merge decisions. | `RevisionChanged`, `Unauthorized`, `InvalidReference`, `NoEffect`, `CommandIdReuse`, `ScopeTooLarge`, `IntegrityFailure`, `IntegrationIncomplete` |
| `vcs.discard` | `context-write` | Discard the complete uncommitted chain and return to the committed event. | `RevisionChanged`, `Unauthorized`, `InvalidReference`, `NoEffect`, `CommandIdReuse`, `ScopeTooLarge`, `IntegrityFailure` |
| `vcs.importSnapshot` | `context-write` | Import one exact complete external snapshot as ordinary changes on an import work unit and atomically return the committed event, application, work unit, admitted repository IDs, and canonical external snapshot. | `RevisionChanged`, `Unauthorized`, `InvalidReference`, `NoEffect`, `CommandIdReuse`, `ScopeTooLarge`, `IntegrityFailure`, `DestinationOccupied`, `WorkingChangesPresent`, `ExternalEffectFailed` |
| `vcs.registerExternalDelta` | `context-write` | Register one exact unapplied old-to-new external repository delta. | `RevisionChanged`, `Unauthorized`, `InvalidReference`, `NoEffect`, `CommandIdReuse`, `ScopeTooLarge`, `IntegrityFailure`, `ExternalEffectFailed` |
| `vcs.supersedeExternalDelta` | `context-write` | Retire one active external delta so it can no longer be merged. | `RevisionChanged`, `Unauthorized`, `InvalidReference`, `NoEffect`, `CommandIdReuse`, `ScopeTooLarge`, `IntegrityFailure` |
| `vcs.finalizeExternalDelta` | `context-write` | Finalize one fully decided external delta and release its dedicated GC roots. | `RevisionChanged`, `Unauthorized`, `InvalidReference`, `NoEffect`, `CommandIdReuse`, `ScopeTooLarge`, `IntegrityFailure`, `IntegrationIncomplete` |
| `vcs.push` | `workspace-write` | Publish one exact already-committed event to protected main; epochTransition requests the reviewed host handoff for a foreign-epoch candidate. | `RevisionChanged`, `Unauthorized`, `InvalidReference`, `WorkingChangesPresent`, `CommandIdReuse`, `ExternalEffectFailed`, `BuildGateFailed`, `IntegrityFailure` |
| `vcs.mainState` | `read` | Read the current protected main event without creating a context. | `Unauthorized`, `InvalidReference`, `ScopeTooLarge`, `IntegrityFailure` |
| `vcs.status` | `read` | Return context pointers, clean state, main relation, and compact working counts. | `Unauthorized`, `InvalidReference`, `ScopeTooLarge`, `IntegrityFailure` |
| `vcs.compare` | `read` | Compare an exact target state with a committed source event or coordinator-owned external delta by semantic change. | `Unauthorized`, `InvalidReference`, `ScopeTooLarge`, `IntegrityFailure` |
| `vcs.inspect` | `read` | Inspect one typed semantic node and a bounded preview of its direct adjacency. | `Unauthorized`, `InvalidReference`, `ScopeTooLarge`, `IntegrityFailure` |
| `vcs.neighbors` | `read` | Page immediate typed provenance edges without persisting traversal state. | `Unauthorized`, `InvalidReference`, `ScopeTooLarge`, `IntegrityFailure` |
| `vcs.history` | `read` | Page event history in either direction or past file history from one exact state. | `Unauthorized`, `InvalidReference`, `ScopeTooLarge`, `IntegrityFailure` |
| `vcs.walk` | `read` | Run one curated multi-hop provenance traversal (cause, cohort, rejections) with server-owned depth and fan-out bounds. | `Unauthorized`, `InvalidReference`, `ScopeTooLarge`, `IntegrityFailure` |
| `vcs.query` | `read` | Run one caller-scoped read-only SELECT against the versioned prov_* views; canonical tables stay private. | `Unauthorized`, `InvalidReference`, `ScopeTooLarge`, `IntegrityFailure` |
| `vcs.search` | `read` | Find semantic subjects by their recorded prose (intents, rationales, event messages, trigger excerpts). | `Unauthorized`, `InvalidReference`, `ScopeTooLarge`, `IntegrityFailure` |
| `vcs.blame` | `read` | Trace an exact bounded file range through immediate content-coordinate mappings. | `Unauthorized`, `InvalidReference`, `ScopeTooLarge`, `IntegrityFailure` |
| `vcs.readMemory` | `read` | Project bounded blame-backed workspace memory for the exact text range and content hash returned by a managed file read. | `Unauthorized`, `InvalidReference`, `ScopeTooLarge`, `IntegrityFailure` |
| `vcs.resolveRepository` | `read` | Resolve one canonical repository path at one exact semantic state. | `Unauthorized`, `InvalidReference`, `ScopeTooLarge`, `IntegrityFailure` |
| `vcs.readFile` | `read` | Read one file from an exact semantic state. | `Unauthorized`, `InvalidReference`, `ScopeTooLarge`, `IntegrityFailure`, `ExternalEffectFailed` |
| `vcs.listDirectory` | `read` | Page immediate visible children of one workspace directory with stable identities and attached name provenance. | `Unauthorized`, `InvalidReference`, `ScopeTooLarge`, `IntegrityFailure` |
| `vcs.listFiles` | `read` | Page the exact path-to-file manifest of one repository at one semantic state. | `Unauthorized`, `InvalidReference`, `ScopeTooLarge`, `IntegrityFailure` |

## Typed error codes

- `BuildGateFailed`
- `CommandIdReuse`
- `ConflictPresent`
- `CoupledGroupIncomplete`
- `DestinationOccupied`
- `ExternalEffectFailed`
- `IntegrationIncomplete`
- `IntegrityFailure`
- `InvalidReference`
- `NoEffect`
- `RevisionChanged`
- `ScopeTooLarge`
- `Unauthorized`
- `WorkingChangesPresent`

Mutation `commandId` values are idempotency identities, not actor or
authorship credentials. Retry the same ID only with an identical request.
Provenance is walked through typed nodes with `inspect`, `neighbors`,
`history`, and `blame`.
