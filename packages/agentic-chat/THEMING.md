# Agentic chat theming

Mount chat under a Radix `Theme`, then override semantic variables on the
embedding subtree. Component structure and internal Radix scale use remain an
implementation detail.

```css
.my-game-chat {
  --agentic-surface: #101418;
  --agentic-surface-card: #182028;
  --agentic-surface-raised: #22303a;
  --agentic-border: #4b6575;
  --agentic-text: #f5fbff;
  --agentic-text-muted: #a9becb;
  --agentic-player-accent: #67e8f9;
  --agentic-player-rail: #22d3ee;
  --agentic-player-surface: rgb(34 211 238 / 10%);
  --agentic-player-surface-strong: rgb(34 211 238 / 18%);
}
```

Layout roles are `--agentic-root-gap`, `--agentic-root-padding`,
`--agentic-panel-padding`, and `--agentic-message-list-padding`.

Stable styling/inspection slots are exposed as `data-part="chat-root"`,
`chat-header`, `message-list`, `message`, and `chat-composer`. Messages also
carry `data-message-role="player|agent"` and their existing tier metadata.
