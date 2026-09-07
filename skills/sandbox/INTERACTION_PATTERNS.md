# Interaction Patterns

Choose the smallest interaction that gives the user real control.

## Use `eval`

Use `eval` for deterministic runtime work where no user choice is needed:

- Read workspace state.
- Run a typecheck or test.
- Create a project after the user has already approved the shape.
- Verify a credential or API response.

## Use `feedback_form`

Use `feedback_form` for one isolated, easily understood input:

- Pick one option from a list.
- Confirm a safe command.
- Enter a short label or numeric setting.

Do not chain several feedback forms to implement one setup flow. If the next
question is already known, it belongs in the same surface. Do not expose
implementation choices—credential formats, protocol variants, permission
names, storage modes, or browser mechanics—when a recommended default can
derive them from the user's goal.

## Use `inline_ui`

Use `inline_ui` for a self-contained workflow whose component can invoke the
trusted runtime or skill helpers itself:

- Provider and OAuth setup.
- Browser/profile/data import.
- Deep-linked checklists.
- Progress, verification, retry, and completion states.

A setup surface should:

- ask in plain language about outcomes, not implementation;
- preselect the safest useful default;
- keep related choices, explanations, links, progress, and retry together;
- reveal advanced controls only after an explicit need;
- use action buttons for where an operation happens instead of a separate
  question;
- call trusted helpers directly from its buttons;
- keep status, errors, retry, and success in the component.

Do not return setup choices to the agent merely so it can assemble a function
call containing those choices.

Use direct link buttons in the UI:

```tsx
import { useState } from "react";
import { Button, Flex, Text } from "@radix-ui/themes";
import { GlobeIcon, OpenInNewWindowIcon } from "@radix-ui/react-icons";
import { openPanel, openExternal } from "@workspace/runtime";

export default function SetupStep() {
  const url = "https://console.cloud.google.com/apis/credentials";
  const [status, setStatus] = useState({});

  async function run(kind, action) {
    setStatus((current) => ({ ...current, [kind]: "pending" }));
    try {
      await action();
      setStatus((current) => ({ ...current, [kind]: "done" }));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setStatus((current) => ({ ...current, [kind]: message }));
    }
  }

  const error = [status.internal, status.external].find(
    (value) => value && value !== "pending" && value !== "done"
  );
  return (
    <Flex direction="column" gap="3" p="2" style={{ width: "100%", minWidth: 0 }}>
      <Text size="2" weight="bold">
        Open the credentials page
      </Text>
      <Flex gap="2">
        <Button
          size="1"
          variant="soft"
          disabled={status.internal === "pending"}
          onClick={async () => run("internal", () => openPanel(url, { focus: true }))}
        >
          <GlobeIcon /> {status.internal === "pending" ? "Opening…" : "Internal"}
        </Button>
        <Button
          size="1"
          variant="soft"
          disabled={status.external === "pending"}
          onClick={async () => run("external", () => openExternal(url))}
        >
          <OpenInNewWindowIcon />{" "}
          {status.external === "pending" ? "Awaiting approval…" : "External"}
        </Button>
      </Flex>
      {error && (
        <Text size="1" color="red">
          {error} — retry when ready.
        </Text>
      )}
    </Flex>
  );
}
```

## Use `feedback_custom`

Use `feedback_custom` only when the agent truly needs a returned decision
before it can determine the next operation, and the component cannot own that
operation itself. Examples:

- selecting one of several fundamentally different plans the agent must author;
- approving a generated proposal before the agent changes workspace files;
- supplying structured requirements that become input to later reasoning.

If every result maps directly to an existing helper call, use `inline_ui` and
make that call in the component.

## Use `load_action_bar`

Use `load_action_bar` for compact controls or status that should stay visible
above chat history in the current panel:

- Current workflow status.
- Pinned next actions.
- Small control strips for a running task.
- A file-backed UI the agent can edit and reload.

`load_action_bar` reads a context-relative TSX file from the current panel's
filesystem context. It is panel-local; it does not affect other panels on the
same channel. Keep the UI compact and use `inline_ui` for larger dashboards or
inspectable results that belong in the transcript.

When creating the file under a workspace repo namespace such as `panels/`, use
a canonical repo-shaped path like `panels/action-bar-review/index.tsx`.
File-oriented APIs also accept `panels/action-bar-review.tsx` as shorthand for
`panels/action-bar-review/action-bar-review.tsx` and report the canonical path.

## Browser Opens

- Internal browser panels: `openPanel(url, { focus: true })`
- System browser: `openExternal(url)`
- OAuth authorize URLs: `openExternal(url, { expectedRedirectUri })`

Await these helpers in a caught async handler, show action-scoped pending and
failure state, and keep unrelated controls enabled. An approval prompt is
workflow progress, not a reason to block the component or panel tree.

`openExternal` is approval-gated. Do not invent provider-specific browser-open
bridges.
