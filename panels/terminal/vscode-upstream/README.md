# VS Code Terminal Upstream

This directory vendors terminal source from `microsoft/vscode` so the vibestudio terminal
can be ported from battle-tested upstream implementation details instead of re-creating
them from memory.

Source repository: https://github.com/microsoft/vscode
License: MIT; see `License.txt`. Individual files retain Microsoft copyright headers.

Included upstream slices:

- `src/vs/workbench/contrib/terminal/browser`
- `src/vs/workbench/contrib/terminal/common`
- `src/vs/platform/terminal/common`

This subtree is not imported directly by the panel bundle. Ported, system-adapted code
lives beside the panel source and should preserve upstream names and comments where
practical, with vibestudio-specific connectivity isolated at adapter boundaries.
