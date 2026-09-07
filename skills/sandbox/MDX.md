# MDX Messages

Use MDX for normal assistant messages when a compact rich response is clearer
than plain Markdown. MDX is for presentation and simple declarative follow-up
actions. Use `inline_ui`, `load_action_bar`, or `feedback_custom` for app-like
UI, custom logic, or workflow controls that need component state.

## Available Components

Normal chat messages support standard Markdown plus these components:

- `Badge`, `Blockquote`, `Box`, `Button`, `Callout`, `Card`, `Code`, `Flex`,
  `Heading`, `Link`, `Table`, `Text`
- `Icons` from Radix icons, such as `Icons.CheckIcon`,
  `Icons.InfoCircledIcon`, `Icons.OpenInNewWindowIcon`
- `ActionButton` for simple follow-up actions

## ActionButton

`ActionButton` sends a new user message when clicked. Use it for simple
next-step prompts where the agent can continue from a normal chat message.

```mdx
<Flex gap="2" wrap="wrap">
  <ActionButton message="Show me the browser import workflow">
    Browser import
  </ActionButton>
  <ActionButton message="Help me build a panel">
    Build a panel
  </ActionButton>
</Flex>
```

Do not put arbitrary `onClick` handlers in MDX messages. If the action needs
runtime code, provider setup, browser opens, OAuth, persistence, or error
handling, render `inline_ui` or `feedback_custom` instead.
If the controls or status should stay pinned above the current chat history,
use `load_action_bar` with a TSX file.

## Callouts

Use callouts for short status, caveats, or setup notes.

```mdx
<Callout.Root color="blue">
  <Callout.Icon><Icons.InfoCircledIcon /></Callout.Icon>
  <Callout.Text>
    I found an existing Google OAuth client. You can reuse it or create a new one.
  </Callout.Text>
</Callout.Root>
```

## Links

Markdown links are clickable in Vibestudio panels.

- HTTPS links open browser panels.
- Workspace panel navigation should use `buildPanelLink` from
  `@workspace/runtime` inside panel code.
- Workflow UI should offer both `openPanel(url, { focus: true })` and
  approval-gated `openExternal(url)` when the user may need their normal browser
  profile.
- OAuth authorize URLs should use
  `openExternal(authorizeUrl, { expectedRedirectUri })`.

## When To Use MDX

Good MDX uses:

- Short summaries with badges or callouts
- Tables comparing options
- Small next-step action groups with `ActionButton`
- Checklists that do not need custom state

Use `inline_ui`, `load_action_bar`, or `feedback_custom` instead for:

- Setup workflows with links and completion buttons
- Browser/profile import choices
- OAuth provider setup
- Dashboards, tables with row actions, or components the user may return to
- Anything that needs component state or runtime API calls

Prefer `load_action_bar` specifically for compact controls or status that
should stay visible at the top of the current chat panel while the conversation
continues.
