#!/usr/bin/env bash
# Reproducible vendoring of @earendil-works/pi-agent-core TS sources.
#
# Usage: ./vendor.sh [tag]   (default: v0.82.0)
#
# Transformations applied to pristine upstream sources, in order:
#   1. Copy the kept subset (see FILES below; PROVENANCE.md explains what is
#      excluded and why).
#   2. Rewrite relative ".ts" import/augmentation specifiers to ".js" —
#      upstream uses allowImportingTsExtensions; this workspace's
#      moduleResolution:bundler house style is ".js" specifiers resolving to
#      .ts sources.
#   3. harness/types.ts: import from "../types.js" instead of the upstream
#      barrel "../index.js" (the barrel re-exports excluded runtime modules),
#      and drop the AgentHarness re-export (agent-harness.ts not vendored).
#   4. Remove AgentTool.prepareArguments. Vibestudio validates the exact
#      provider-emitted shape at its durable execution boundary.
#   5. Prepend a @ts-nocheck banner: upstream compiles under its own tsconfig
#      (ES2022 lib, no noUncheckedIndexedAccess); this repo's stricter flags
#      would reject pinned upstream internals in every consumer project.
#      Exported type declarations are unaffected by @ts-nocheck.
set -euo pipefail

TAG="${1:-v0.82.0}"
HERE="$(cd "$(dirname "$0")" && pwd)"
VENDOR="$HERE/src/vendor"
CLONE="$(mktemp -d)/pi"
trap 'rm -rf "$(dirname "$CLONE")"' EXIT

git clone --depth 1 --branch "$TAG" https://github.com/earendil-works/pi.git "$CLONE"
SRC="$CLONE/packages/agent/src"

FILES=(
  types.ts
  harness/types.ts
  harness/messages.ts
  harness/system-prompt.ts
  harness/skills.ts
  harness/prompt-templates.ts
  harness/utils/shell-output.ts
  harness/utils/truncate.ts
  harness/compaction/branch-summarization.ts
  harness/compaction/compaction.ts
  harness/compaction/utils.ts
  harness/session/session.ts
  harness/session/memory-repo.ts
  harness/session/memory-storage.ts
  harness/session/repo-utils.ts
)

rm -rf "$VENDOR"
for f in "${FILES[@]}"; do
  mkdir -p "$VENDOR/$(dirname "$f")"
  cp "$SRC/$f" "$VENDOR/$f"
done

# (2) ".ts" → ".js" on relative specifiers (imports, exports, module augmentation)
find "$VENDOR" -name '*.ts' -exec sed -i \
  -e 's/\(from "\.[^"]*\)\.ts"/\1.js"/g' \
  -e 's/\(declare module "\.[^"]*\)\.ts"/\1.js"/g' {} +

# (3) barrel decoupling patches in harness/types.ts
sed -i \
  -e 's|import type { AgentEvent, AgentMessage, AgentTool, QueueMode, ThinkingLevel } from "../index.js";|// Vibestudio vendoring patch: upstream barrel import rewritten to "../types.js" (the barrel\n// re-exports excluded runtime modules and is not vendored).\nimport type { AgentEvent, AgentMessage, AgentTool, QueueMode, ThinkingLevel } from "../types.js";|' \
  -e 's|export type { AgentHarness } from "./agent-harness.js";|// Vibestudio vendoring patch: AgentHarness re-export removed (agent-harness.ts is intentionally not vendored).|' \
  "$VENDOR/harness/types.ts"

# (4) remove the legacy raw-argument compatibility hook
perl -0pi -e '
  s/\t\/\*\*\n\t \* Optional compatibility shim for raw tool-call arguments before schema validation\.\n\t \* Must return an object that matches `TParameters`\.\n\t \*\/\n\tprepareArguments\?: \(args: unknown\) => Static<TParameters>;\n//
    or die "AgentTool.prepareArguments vendoring patch no longer matches upstream\n";
' "$VENDOR/types.ts"

# (5) @ts-nocheck banner
for f in "${FILES[@]}"; do
  printf '// @ts-nocheck — vendored from @earendil-works/pi-agent-core %s; see PROVENANCE.md and vendor.sh\n%s' \
    "$TAG" "$(cat "$VENDOR/$f")" > "$VENDOR/$f.tmp"
  mv "$VENDOR/$f.tmp" "$VENDOR/$f"
done

echo "Vendored ${#FILES[@]} files from $TAG into src/vendor/"
