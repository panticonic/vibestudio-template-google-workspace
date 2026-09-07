# Icons

Use one restrained icon system across workspace UI and unit identity.

## Interface icons

- For React panels/apps/packages, import named Lucide components from
  `@workspace/ui/icons`, for example
  `import { GitBranch, FileText } from "@workspace/ui/icons"`.
- Imports are tree-shakeable. Import named components only; never import an
  all-icons object, sprite, font, or runtime icon loader.
- For the first-party mobile shell, import named components from
  `apps/mobile/src/design/icons`. That registry is the sole
  `lucide-react-native` package boundary: it uses literal per-icon exports so
  Metro includes only the icons the app renders. Add a missing icon there;
  never import the package barrel or a package subpath from a caller.
- Existing Radix icons may remain in established shell surfaces. Do not add
  Font Awesome, Iconify, React Icons, Heroicons, or another general catalog.
- Give icon-only controls an accessible name (`aria-label` on web,
  `accessibilityLabel` on React Native). Decorative icons must be hidden from
  assistive technology. Never rely on color alone to communicate state.

## Unit identity icons

Every user-visible or executable unit declares exactly one
`vibestudio.icon`. Choose in this order:

1. A truthful brand mark when the unit directly implements or integrates that
   named technology (for example Git, TypeScript, Claude, Svelte, or Gmail).
2. A concrete Lucide object/action for a generic concept (for example
   `file-text`, `database`, `messages-square`, or `shield-check`).
3. A single semantic emoji only when it is more expressive than a drawn icon.
4. Original repo-local artwork for a product identity.

For new panels and workers, discover the accepted ids and pass one exact result
to `createProjects`:

```ts
import { createProjects, searchProjectCatalog } from "@workspace-skills/workspace-dev";

const catalog = await searchProjectCatalog({
  resource: "icon",
  query: "messages square",
  limit: 5,
});
const icon = catalog.entries[0]?.id;
if (!icon) throw new Error("The messages icon is unavailable");
return createProjects([
  { projectType: "panel", name: "inbox", icon },
]);
```

Do not infer availability from the full upstream libraries or guess a plausible
Lucide name. The scaffold copies only the selected SVG into `assets/icon.svg`
and writes `vibestudio.icon: "./assets/icon.svg"`; no icon library enters the
unit's runtime bundle. Invalid catalog ids fail before mutation with the exact
available ids and suggestions in structured error data.

For apps and extensions, copy the chosen catalog SVG into the unit as
`assets/icon.svg`, replace Lucide's `currentColor` with a visible fixed color,
and declare the relative path. Keep artwork square, simple, transparent, and
legible at 16–20 px. Image assets must remain inside the unit and below 1 MiB.

Do not use generated initials, hash colors, remote favicons, or remote SVG URLs.
Browser panels use the page's authentic captured favicon instead of a unit icon.

### Cross-client coverage

An identity change is incomplete until both first-party clients are audited:

| Concept           | Desktop shell    | Mobile shell         |
| ----------------- | ---------------- | -------------------- |
| Active panel      | title breadcrumb | AppBar title pill    |
| Panel collection  | tree/sidebar     | drawer tree          |
| Privileged caller | approval card    | approval sheet       |
| Unit installation | install review   | install review sheet |
| Browser identity  | captured favicon | captured favicon     |

Use the same canonical `icon`, source path, and browser-favicon projection in
both clients. Keep rendering native (`PanelIcon` on desktop,
`MobileUnitIcon`/`MobilePanelIcon` on mobile); do not add a second identity
field or a mobile-only resolver. On mobile, SVG artwork is rendered by
`react-native-svg`; React Native `Image` is only the raster path. Add focused
behavioral coverage for every affected row in this table.

## Unit ownership and provenance

Each unit owns its checked-in `vibestudio.icon` declaration and local artwork.
Change the unit's manifest and `assets/icon.svg` together; there is no central
host-owned assignment table. Run the workspace tests after changing unit
identity so the icon-coverage check verifies every executable unit and its
local asset. Units contain only their own small SVG.

- Semantic sources: Lucide Static 1.27.0, ISC license.
- Brand sources: Simple Icons 16.27.1. The collection is CC0, but individual
  marks remain subject to their owners' trademark and usage rules. Use brand
  marks only for accurate nominative identification, never as decoration or an
  implication of endorsement.
