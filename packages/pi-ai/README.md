# @workspace/pi-ai

Workspace-owned integration boundary for `@earendil-works/pi-ai`.

Consumers import this package (including its declared subpaths) instead of the
upstream package. Its `vibestudio.dependencyResolution` declaration owns the
exact upstream version, compatibility overrides, and patch. Build V2 reads
that policy from the consumer's exact internal dependency closure, installs the
registry dependency into derived storage, applies the patch to every installed
copy matching the exact `package@version` selector under its declared external
dependency roots, and includes the patch digest in the dependency-cache
identity.

This is also the opt-in rule for transitive patches: a unit that needs a patch
depends on its workspace patch owner. It must not add a parallel direct
dependency on the patched external package. Build V2 rejects that ambiguous
shape rather than silently changing an unrelated dependency closure.
