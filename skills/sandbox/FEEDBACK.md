# Feedback Forms

Block the agent until the user responds. Two variants: schema-based (simple forms) and custom (full React component).

## feedback_form (Schema-Based)

For standard forms with typed fields. No code needed.

Use this for one self-contained decision or a genuinely simple set of fields.
Never serialize a known multi-step setup into several one-question forms.
Provider setup, permission selection, deep links, progress, retry, and
explanatory choices belong in a persistent `inline_ui` surface that calls its
trusted helpers directly.

### Parameters

| Param         | Type                              | Description                            |
| ------------- | --------------------------------- | -------------------------------------- |
| `title`       | string                            | Form title                             |
| `fields`      | FieldDefinition[]                 | Field definitions                      |
| `values`      | Record                            | Pre-populated values                   |
| `submitLabel` | string                            | Submit button text (default: "Submit") |
| `cancelLabel` | string                            | Cancel button text (default: "Cancel") |
| `severity`    | `"info" \| "warning" \| "danger"` | Visual severity                        |
| `hideSubmit`  | boolean                           | Hide submit button                     |
| `hideCancel`  | boolean                           | Hide cancel button                     |

### Field Types

| Type          | Extra Props                   | Description                                                 |
| ------------- | ----------------------------- | ----------------------------------------------------------- |
| `string`      | —                             | Text input                                                  |
| `number`      | —                             | Number input                                                |
| `boolean`     | —                             | Checkbox                                                    |
| `select`      | `options: { value, label }[]` | Dropdown                                                    |
| `slider`      | `min`, `max`                  | Range slider                                                |
| `segmented`   | `options: { value, label }[]` | Segmented control                                           |
| `multiSelect` | `options: { value, label }[]` | Multiple checkboxes with Select all / Deselect all controls |

Choice fields (`select`, `segmented`, and `multiSelect`) show an automatic
free-text "Other" choice in feedback forms unless `allowFreeText: false` is set
on the field. `buttonGroup` can opt in with `allowFreeText: true`. Customize it
with `freeTextLabel`, `freeTextPlaceholder`, and `freeTextKey`.

### Field Definition

```typescript
{
  key: string;       // required — field identifier
  label: string;     // required — display label
  type: string;      // required — field type
  default?: unknown; // default value
  required?: boolean;
  description?: string;
}
```

### Result

```typescript
{ type: "submit", value: { fieldKey: userValue, ... } }
// or
{ type: "cancel" }
```

### Example

```
feedback_form({
  title: "Deployment Config",
  fields: [
    { key: "env", label: "Environment", type: "select", options: [
      { value: "staging", label: "Staging" },
      { value: "production", label: "Production" },
    ], required: true },
    { key: "replicas", label: "Replicas", type: "slider", min: 1, max: 10, default: 3 },
    { key: "dryRun", label: "Dry run", type: "boolean", default: true },
  ],
  severity: "warning",
  submitLabel: "Deploy",
})
```

## feedback_custom (React Component)

For complex decisions that schema-based forms cannot express and whose
structured result the agent genuinely needs for subsequent reasoning.

Do not use this as the default provider-setup surface. When every control maps
to an existing runtime or skill helper, use `inline_ui`, invoke that helper in
the component, and keep progress, errors, retry, and completion there. Returning
choices to the agent solely to assemble a function call is an unnecessary
agent-mediated control plane.

### Parameters

| Param     | Type                     | Description                                               |
| --------- | ------------------------ | --------------------------------------------------------- |
| `code`    | string                   | TSX source code. Provide either `code` or `path`          |
| `path`    | string                   | Context-relative TSX file to load instead of inline code  |
| `imports` | `Record<string, string>` | Explicit package versions, same semantics as eval imports |
| `title`   | string                   | Container header title                                    |

File-loaded feedback components support static relative imports from the entry
file and infer bare package imports from the nearest `package.json` when
possible. Package-local aliases from `package.json` `imports` and simple
`tsconfig.json` paths are supported.

### Component Contract

The component receives `{ onSubmit, onCancel, onError, chat }`:

```tsx
export default function MyForm({ onSubmit, onCancel, onError, chat }) {
  // onSubmit(value) — return data to the agent and close the form
  // onCancel() — signal cancellation
  // onError(message) — signal error
  // chat — ChatSandboxValue (publish, callMethod, callMethodResult, rpc)
}
```

**Must use `export default`.**

### Rendering Context

The component renders inside a container Card with a header, scroll area, and resize handle. Do NOT wrap your component in a top-level Card. Use `<Flex direction="column" gap="3" p="2">` or similar as root.

### Error Handling

Render-time errors and synchronous throws in event handlers are caught by the host's error boundary. Errors from `chat.publish`, `chat.callMethod`, and `chat.rpc.call` are caught even when awaited without try/catch. **Errors in `async` handlers that `await` other APIs (e.g. `fetch`, `fs.readFile`, third-party libraries) should be wrapped in try/catch** — on failure, call `onError(message)` to signal the failure back to the agent, or surface the error inline and leave `onSubmit`/`onCancel` uncalled so the user can retry.

### Result

```typescript
{ type: "submit", value: { ... } }  // whatever was passed to onSubmit()
// or
{ type: "cancel" }
// or
{ type: "error", message: "..." }
```

### Example — Simple Form

```
feedback_custom({
  code: `
import { useState } from "react";
import { Button, Flex, Text, TextField } from "@radix-ui/themes";

export default function NameForm({ onSubmit, onCancel }) {
  const [name, setName] = useState("");
  return (
    <Flex direction="column" gap="3" p="2">
      <Text size="2" weight="bold">What is your name?</Text>
      <TextField.Root value={name} onChange={e => setName(e.target.value)} />
      <Flex gap="2" justify="end">
        <Button variant="soft" onClick={onCancel}>Cancel</Button>
        <Button onClick={() => onSubmit({ name })} disabled={!name}>Submit</Button>
      </Flex>
    </Flex>
  );
}`,
  title: "Name Input"
})
```

### Example — Structured input for agent reasoning

```
feedback_custom({
  code: `
import { useState } from "react";
import { Button, Flex, Text, TextArea } from "@radix-ui/themes";

export default function ReviewRequest({ onSubmit, onCancel }) {
  const [focus, setFocus] = useState("");
  return (
    <Flex direction="column" gap="3" p="2">
      <Text size="2" weight="bold">What should the review prioritize?</Text>
      <TextArea value={focus} onChange={(event) => setFocus(event.target.value)} />
      <Flex gap="2" justify="end">
        <Button variant="soft" onClick={onCancel}>Cancel</Button>
        <Button onClick={() => onSubmit({ focus })} disabled={!focus}>
          Start review
        </Button>
      </Flex>
    </Flex>
  );
}`,
  title: "Browser Import"
})
```
