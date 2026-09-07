---
name: terminal
description: Run bounded local commands from an agent via the installed shell extension; use literal argv by default, shell text only for intentional shell syntax.
---

# Terminal commands

Use the installed `shell` extension. For a normal command, use argv mode so
arguments are passed literally:

```ts
import { extensions } from "@workspace/runtime";

const result = await extensions.invoke("shell", "exec", [
  {
    intent: {
      kind: "argv",
      executable: "/usr/bin/printf",
      args: ["hello"],
    },
    timeoutMs: 5_000,
    maxOutputBytes: 64 * 1024,
  },
]);
```

Run with `eval`; for multi-file workflows, put the code in a context-relative
file and eval the file. Returns `exitCode`, `stdout`, `stderr`, and
`durationMs`.

Use shell-text mode only when pipes, redirections, globbing, or other shell
syntax are part of the request. Never turn an argv command into shell text for
convenience, or inspect the shell extension source for its API —
`docs_search`/`docs_open` and this skill are the public contract.

Permission follows normal authority. Call the operation once; if it needs
approval, let the invocation suspend and resume through the normal path. A
structured denial is terminal unless its remediation names a concrete state
change.

Keep output bounded and report exit status, relevant stdout/stderr, and whether
it timed out or was truncated.
