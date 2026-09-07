---
name: workspace-native-test-adapter
description: Run explicitly native workspace test suites through the context-aware verify tool.
---

# Workspace Native Test Adapter

Use `verify`, never invoke this extension directly:

```ts
verify({
  operation: "test",
  target: "extensions/test-runner",
  suite: "native",
  file: "index.test.ts",
});
```

The unit manifest must declare the named suite with `runtime: "native"`.
Only that declaration routes here and requests `native.code.execute-tests`.
The adapter rechecks the declaration against the exact materialized context,
then launches Vitest in a fresh Node child with an allow-listed environment,
the installed test-engine dependencies, and a fresh writable scratch directory.
The child shares the workspace's native execution domain: MXC resource admission
on Unix and ordinary host-user permissions on Windows. Context and suite
selection do not create another filesystem security boundary. Selected workspace
modules are imported in the child, separate from the long-lived extension process.

Browser and workerd suites do not use this extension and do not request native
approval. A compatibility or build failure never falls back to this adapter.
