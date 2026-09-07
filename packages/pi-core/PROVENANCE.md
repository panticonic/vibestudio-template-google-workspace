# Provenance

Vendored subset of `@earendil-works/pi-agent-core` **v0.82.0**, copied as
TypeScript **sources** from https://github.com/earendil-works/pi at tag
`v0.82.0` (`packages/agent/src/`), per WS1.1 of the unified-log plan.

Vendoring is fully reproducible: run `./vendor.sh [tag]`. The script clones
the tag, copies the kept subset, and applies the transformations below. All
but the explicit tool-contract tightening are mechanical:

1. Relative `.ts` import/augmentation specifiers → `.js` (this workspace's
   `moduleResolution: bundler` house style; upstream uses
   `allowImportingTsExtensions`).
2. `harness/types.ts`: barrel import `../index.ts` → `../types.ts` (the
   upstream barrel re-exports excluded runtime modules), and the
   `AgentHarness` re-export removed (agent-harness.ts not vendored). Both
   patch sites carry `Vibestudio vendoring patch` comments.
3. Remove the optional `AgentTool.prepareArguments` compatibility hook.
   Vibestudio validates the provider's exact arguments at its durable execution
   boundary; silently converting legacy shapes would make the journal differ
   from what the model actually requested.
4. A `// @ts-nocheck` banner per file: upstream compiles under its own
   tsconfig (ES2022 lib, without this repo's `noUncheckedIndexedAccess` /
   `noPropertyAccessFromIndexSignature`); the pinned sources are typechecked
   by upstream CI at the tag, and `@ts-nocheck` does not affect the exported
   type declarations consumers see.

Vendored (under `src/vendor/`):

- `types` — top-level agent types (AgentMessage, AgentTool, AgentEvent, ThinkingLevel, …)
- `harness/types` — Result, errors, SessionStorage/SessionRepo/SessionTreeEntry, Skill, PromptTemplate, ExecutionEnv, harness event/option types
- `harness/compaction/*` — pure compaction + branch summarization
- `harness/session/{session,memory-repo,memory-storage,repo-utils}` — session tree, buildSessionContext, in-memory repo/storage
- `harness/messages` — message constructors
- `harness/{system-prompt,skills,prompt-templates}`
- `harness/utils/{shell-output,truncate}`

Intentionally excluded (replaced by `@workspace/agent-loop`):

- `agent.ts` (Agent), `agent-loop.ts` (the in-memory await chain)
- `harness/agent-harness.ts` (AgentHarness phase/queue machine)
- Jsonl/file-backed session repos
- the extension/hook-bus runtime, `proxy.ts`, `node.ts`

`@earendil-works/pi-ai` remains an external dependency, currently at `0.85.0`.
`@workspace/pi-ai` owns that integration surface and its Build V2
dependency-resolution patch; the host package manager has no `pi-ai` dependency
or patch knowledge. The workerd transport-liveness changes are not mixed into
this vendored agent-core subset.
