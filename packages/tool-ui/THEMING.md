# Tool surface theming

`SurfaceFrame` preserves its tone-based Radix defaults while exposing semantic
overrides on any ancestor:

```css
.my-game-tools {
  --tool-surface-background: rgb(10 18 24 / 92%);
  --tool-surface-border: #426579;
  --tool-surface-header-border: #2c4655;
  --tool-surface-accent: #7dd3fc;
  --tool-surface-muted: #94a3b8;
  --tool-surface-handle: #172631;
  --tool-surface-handle-active: #254052;
  --tool-surface-handle-border: #365365;
}
```

Stable parts are `tool-surface`, `tool-surface-header`,
`tool-surface-title`, `tool-surface-body`, and
`tool-surface-resize-handle`. The root also exposes `data-tone` for consumers
that intentionally want tone-specific variants.
