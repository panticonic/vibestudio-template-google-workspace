# Revert and counteractions

Revert authors explicit inverse changes; it does not erase history. The original change, its counteraction, both work units, and every later merge decision remain reachable.

Use `vcs({ operation: "revert", changeIds, intent })` for exact changes discovered through inspect, history, blame, or memory. Select the semantic change identities, not paths or guessed ordering.

```js
vcs({
  operation: "revert",
  changeIds: ["change:..."],
  intent: "Remove the temporary compatibility behavior now that all callers use v2"
})
```

The engine plans the selected counteractions as one fact-valid mutation. If newer live state makes an inverse untruthful, it reports `ConflictPresent`; inspect the coordinate and author the desired current result deliberately. Do not force an old endpoint over newer intent.

Use `discard` only to abandon the complete uncommitted application chain and return the context to its committed event. It is not a selective undo.
