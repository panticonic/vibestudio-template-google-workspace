# External dependency resolution

Buildable workspace units are not pnpm importers. Declare ordinary registry
dependencies in the unit's `dependencies`; declare resolution policy under
`vibestudio.dependencyResolution`. Build V2 reads both from the exact
materialized source being built. It never inherits root package-manager policy.

## Contents

- [Declare dependencies](#declare-dependencies)
- [Own it, or let the realm provide it](#own-it-or-let-the-realm-provide-it)
- [Use ranges by default](#use-ranges-by-default)
- [Override a resolution](#override-a-resolution)
- [Patch an exact dependency](#patch-an-exact-dependency)
- [Own a patched integration](#own-a-patched-integration)
- [Understand the live build behavior](#understand-the-live-build-behavior)
- [Diagnose and verify](#diagnose-and-verify)

## Declare dependencies

Put every direct external import in `dependencies` with a registry version:

```json
{
  "dependencies": {
    "upstream-package": "1.2.3"
  }
}
```

Use `workspace:*` for internal workspace packages. Do not add a buildable unit
to `pnpm-workspace.yaml`, the checkout lockfile, or the host's dependencies.
Build V2 installs the external closure into a content-addressed derived
environment when it builds a consumer.

Declare everything you import. Nothing is added on your behalf: a package that
appears in no manifest is not installed, even when something you depend on
names it as its own peer. A gap surfaces as an unresolved import naming the
specifier, never as a version the registry picked for you.

## Use ranges by default

An exact dependency pin is a claim that no other compatible release can run the
integration. Do not make that claim incidentally. Use the narrowest truthful
semver range so canonical builds can reuse the dependency realm packaged with
the Host.

Exact pins require a concrete byte-identity or ABI reason. Current legitimate
classes are a source patch whose selector names exact bytes, and JavaScript for
a native module or renderer that must match the version compiled into the
mobile APK. The manifest must carry that policy through
`vibestudio.dependencyResolution`, the mobile native-module policy, or an
adjacent dependency comment. Test tooling, preference, and “this is what was
installed when I wrote it” are not reasons to pin.

`pnpm check:userland-dependencies` enforces both sides of reuse: undocumented
exact pins fail, and every Host runtime range shared with Base must be wholly
contained by Base's accepted range. Mere overlap is unstable because a later
Host installation may legally select a lower version.

## Own it, or let the realm provide it

Two declarations, and the difference is who supplies the running instance.

`dependencies` are yours. They are installed for your closure and bundled into
your artifact, at the version you name.

`peerDependencies` belong to whatever composes you. They are installed so your
code typechecks, but never bundled: the realm that loads you supplies the live
instance.

That distinction is not bookkeeping. A panel's inline UI, a `feedback_custom`
component and an eval'd snippet all execute inside the *panel's* realm and
resolve their imports through that realm's module map. A guest that bundles its
own React puts a second React in one realm, and the host's hooks and the
guest's hooks stop being the same hooks -- which presents as a hook error far
from its cause, or as a Radix component rendering outside the host's Theme.

Which one you write follows from how the unit is loaded:

| Unit | Loaded | React and the UI kit go in |
| --- | --- | --- |
| Panel, about page, app | On its own | `dependencies` -- it *is* the realm |
| Worker, extension | On its own | `dependencies`, if it renders at all |
| Skill, package | Into someone's realm | `peerDependencies` |

A runtime root has nothing above it, so it must own every peer its closure
asks for. Build V2 refuses it otherwise, naming the packages that asked:

```
@workspace-about/new is loaded on its own, so nothing provides its closure's
peers: react-dom@19.2.4 (required by @workspace/about-shared, @workspace/react,
@workspace/ui). Declare each as a dependency of @workspace-about/new at the
version it should own.
```

Own the pair together. `react-dom` carries its own peer range on `react`, so a
root that owns one and not the other is a root whose renderer version is
decided by whatever resolves first.

A library leaves its peers external and gets them from the realm at load. If
the realm does not have one, the import fails at load naming the module -- fix
it by exposing the module on the host panel (`vibestudio.exposeModules`), not
by moving the peer into `dependencies`.

### Say what you actually accept

A peer range is a claim about every consumer, and it is checked. Write the
range you mean:

```json
{
  "peerDependencies": { "react": "^19.0.0" },
  "peerDependenciesMeta": { "react": { "optional": true } }
}
```

An exact `19.0.0` says *only* 19.0.0 will do. If a consuming app owns 19.2.4,
its build is refused -- correctly, because the claim was false. `^19.0.0` says
what a shared package usually means: any React 19, whichever one my consumer
owns. `@workspace/quickfire-core` needs exactly this, because the desktop shell
provides 19.2.4 while `apps/mobile` provides 19.0.0, pinned by the react-native
renderer compiled into the installed APK.

Mark a peer `optional` when only part of your package needs it -- most often a
type-only reference (`import type { ComponentType } from "react"`). It is still
installed for typechecking and still external, but a consumer that never
reaches that part is not made to own an instance. `@workspace/eval` and
`@workspace/agentic-core` are declared this way, which is why a worker can use
them without adopting a renderer it never runs.

A peer is optional for a closure only when every package that declares it says
so: one package that genuinely renders makes the instance required for all of
them.

## Override a resolution

Put dependency pins in the unit that owns the integration:

```json
{
  "vibestudio": {
    "dependencyResolution": {
      "overrides": {
        "transitive-package": "4.5.6",
        "ws@8": "8.21.1"
      }
    }
  }
}
```

Override keys may name a package or one package major. Values must be registry
versions accepted by Build V2. A direct-dependency override changes that direct
install request; a transitive override becomes npm resolution policy in the
derived install. Overrides propagate through the internal workspace dependency
closure. Conflicting values for one selector fail the build.

Do not use top-level `overrides`, `resolutions`, `pnpm.overrides`, or
`pnpm.patchedDependencies` in a buildable unit. Those are package-manager
importer policy and have no live workspace-build semantics.

## Patch an exact dependency

Declare a unified text diff beside its owner:

```json
{
  "dependencies": {
    "upstream-package": "1.2.3"
  },
  "vibestudio": {
    "dependencyResolution": {
      "patches": {
        "upstream-package@1.2.3": {
          "path": "patches/upstream-package@1.2.3.patch",
          "roots": ["upstream-package"]
        }
      }
    }
  }
}
```

The selector must be an exact registry `package@version`, including the scope
for scoped packages. Ranges are invalid. `path` is relative to the declaring
unit and must remain inside it. Patch paths may use the conventional `a/` and
`b/` prefixes; absolute paths, `..`, and symlink traversal are rejected.

`roots` names one or more of the owner's direct external dependencies whose
installed closures carry the target:

- For a direct patch, name the target itself.
- For a transitive patch, name the direct parent dependency.
- If several direct dependencies can carry the same exact target, name each
  relevant root.

For example, patch `transitive-package` reached through `parent-package` like
this:

```json
{
  "dependencies": {
    "parent-package": "7.0.0"
  },
  "vibestudio": {
    "dependencyResolution": {
      "patches": {
        "transitive-package@4.5.6": {
          "path": "patches/transitive-package@4.5.6.patch",
          "roots": ["parent-package"]
        }
      }
    }
  }
}
```

Every root must be that owner's direct external dependency. `roots` selects
whether a patch belongs in a derived dependency subset; it is not another
dependency request and does not make a missing target optional.

## Own a patched integration

Give a patched external one canonical workspace owner, normally an adapter
under `packages/`:

1. Put the upstream dependency, overrides, patch file, and patch declaration in
   the adapter.
2. Export the API the workspace needs from the adapter.
3. Make consumers depend on and import the adapter, not the patched upstream
   package.

Within one internal dependency closure, another unit may not directly depend
on or override the patched package. Two owners may not declare the same exact
patch selector. These checks make the workspace import name the explicit
identity of the patched integration instead of silently changing an upstream
import. See `packages/pi-ai/package.json` for a live direct-patch example.

Use an adapter even when the target is transitive: the owner depends on the
direct parent named in `roots`, carries the policy, and exposes the stable
workspace-facing API. Do not teach the host, root installer, or an unrelated
consumer about that userland dependency.

## Understand the live build behavior

For each build, Build V2:

1. Collects policies and patch bytes from the exact internal source closure,
   splitting externals into what the unit owns and what its peers leave to the
   composing realm.
2. Reuses one complete package-owned Host dependency realm when it satisfies the
   whole closure and no override or patch changes the requested bytes. Otherwise
   it installs the derived registry dependency environment -- both halves, since
   a typecheck needs a peer's declarations, and nothing beyond them.
3. Applies each patch to every installed package whose name and version exactly
   match the selector, including hoisted and nested copies.
4. Seals dependency versions, overrides, patch roots, and patch-content digests
   into the cache key and build recipe.
5. Records the digest of every patched or deleted file and rejects a modified
   or incomplete cache receipt.

The compiler resolves every bare import through that prepared realm. It does
not perform Node-style ancestor discovery from the materialized source path;
an undeclared `~/node_modules` package is never a build input. Installed package
manifests and their nesting are fingerprinted into the build key, so reinstalling
the Host with a different valid dependency graph cannot reuse an artifact built
from the old graph.

Patch application is strict. The build fails for an absent patch file, unsafe
path, duplicate owner, conflicting override, missing declared root, selector
that matches no installed package, empty patch, or hunk that does not apply.
Patches are unified text diffs applied after dependency installation; they do
not modify install-script behavior and are not a binary-patching mechanism.

Extensions can produce a smaller runtime dependency install after bundling. A
patch enters that install only when at least one declared root remains
external. Once selected, the patch is still mandatory and must match. A patch
whose roots were bundled stays out of the runtime install while still affecting
the build environment. Runtime dependency caches and sealed recipes preserve
the same patch inputs for reconstruction after eviction.

### Checkout validation limitation

Runtime Build V2 isolates each unit closure and can therefore build independent
patched and unpatched consumers of the same exact transitive package. The
checkout-wide TypeScript and Vitest commands still merge userland requirements
into one validation install, so they cannot represent both identities at once.
Current `@earendil-works/pi-ai` consumers all enter through the canonical
`@workspace/pi-ai` adapter and do not create that split.

Do not address this by preferring root `node_modules`, conditionally aliasing
one test, or applying the patch checkout-wide. A complete validation design
needs policy-owned TypeScript/Vitest projects, an explicit rule for integration
tests that cross policy closures, and script-enabled runtime projections for
tests that load native dependencies. Until that design lands, treat a second
independent unpatched consumer as a validation-architecture blocker even
though its isolated runtime Build V2 build is valid.

## Diagnose and verify

Run an exact Build V2 report for the consuming unit. A root `pnpm install` does
not exercise userland patching and is not evidence that the patch works.

Dependency-shaped build refusals name their own remedy:

| Refusal | Meaning |
| --- | --- |
| `loaded on its own, so nothing provides its closure's peers` | A runtime root reached a peer nobody owns. Declare it in that root's `dependencies`. |
| `resolves a dependency its own closure rejects` | A peer range excludes the version its consumer owns. The range is a claim; make it true or widen it. |
| `requires X@range, but the closure installed X@version` | Two installed packages disagree. Declare a version their dependents share. |
| `Module "X" not available` at load | A library's peer is not in the loading realm. Expose it on the host panel (`vibestudio.exposeModules`). |

From a Vibestudio source checkout, run the relevant focused tests plus:

```sh
pnpm check:userland-dependencies
pnpm check:package-dependencies
pnpm check:userland-package-manager-boundary
pnpm type-check:userland
```

`check:userland-dependencies` answers the ownership question for every unit
from the graph alone, without building anything, and prints the same refusal a
build would. Use it after editing any manifest: a build only asks about the
unit you build, so an app whose closure lost an owner can stay quiet until the
moment it is loaded on a device. Inside a workspace, `verify` asks the same
question for the unit it checks.

The boundary check rejects userland package-manager policy, host dependencies
on userland units, and root patches reaching into `workspace/`. When updating
an upstream version, update its direct dependency, exact patch selector, and
patch contents together, then rebuild the real consumer. A no-longer-applicable
patch must fail visibly; never retain it through a best-effort or once-only
installation path.
