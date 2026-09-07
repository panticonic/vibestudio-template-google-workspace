# Typed RPC Contracts

Type-safe parent-child communication using contracts.

## Define Contract

```typescript
// panels/editor/contract.ts
import { z, defineContract } from "@workspace/runtime";

export interface EditorApi {
  getContent(): Promise<string>;
  setContent(text: string): Promise<void>;
  save(): Promise<void>;
}

export const editorContract = defineContract({
  source: "panels/editor",
  child: {
    methods: {} as EditorApi,
    emits: {
      saved: z.object({ path: z.string(), timestamp: z.number() }),
      modified: z.object({ dirty: z.boolean() }),
    },
  },
});
```

## Export Contract

```json
{
  "name": "@workspace-panels/editor",
  "exports": {
    ".": "./index.tsx",
    "./contract": "./contract.ts"
  }
}
```

## Implement Child

```tsx
import { useEffect, useState } from "react";
import { rpc, getParentWithContract } from "@workspace/runtime";
import { editorContract } from "./contract.js";

const parent = getParentWithContract(editorContract);

export default function Editor() {
  const [content, setContent] = useState("");

  useEffect(() => {
    rpc.expose("getContent", () => content);
    rpc.expose("setContent", (request) => {
      const [text] = request.args as [string];
      setContent(text);
    });
    rpc.expose("save", async () => {
      await parent?.emit("saved", { path: "/file.txt", timestamp: Date.now() });
    });
  }, [content]);

  return (
    <textarea
      value={content}
      onChange={(e) => {
        setContent(e.target.value);
        void parent?.emit("modified", { dirty: true });
      }}
    />
  );
}
```

## Use from Parent

```tsx
import { useState } from "react";
import { buildPanelLink } from "@workspace/runtime";
import { editorContract } from "@workspace-panels/editor/contract";

export default function IDE() {
  const [dirty, setDirty] = useState(false);

  const launch = () => {
    // Navigate to the editor panel via URL
    window.open(buildPanelLink("panels/editor"));
  };

  return (
    <div>
      <button onClick={launch}>Open Editor</button>
      <span>{dirty ? "Modified" : "Saved"}</span>
    </div>
  );
}
```

## ChildHandle Methods

```typescript
child.id; // Unique ID
child.name; // Name from creation
child.type; // "app" | "worker" | "browser"
child.source; // Panel path or URL

child.call.method(args); // Call exposed RPC method
child.on("event", handler); // Listen for events
child.emit("event", payload); // Emit event to child
child.archive(); // Archive the panel subtree
```

## Parent PanelHandle Methods

```typescript
parent.id; // Parent's ID
await parent.observe(); // Exact attempt, phase, source/context/ref/build provenance
parent.call.method(args); // Call parent's RPC method
parent.emit("event", payload); // Emit event to parent
parent.on("event", handler); // Listen for parent events
await parent.click("button"); // CDP click convenience; prompts on first automation use
```
