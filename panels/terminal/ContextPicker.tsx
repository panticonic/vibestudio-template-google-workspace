import { useState } from "react";
import { Button, DropdownMenu } from "@radix-ui/themes";
import { ChevronDownIcon } from "@radix-ui/react-icons";
import type { ContextOption } from "./contextPicker.js";

export interface PickedContextOptions {
  contextAttachToken?: string;
}

export interface CreatedContext {
  contextId: string;
  contextAttachToken: string;
}

/**
 * Context picker (§4.1) — a dropdown that lets the user open a terminal in the
 * workspace root (default), any live context, or a freshly-created context.
 * Data loading + context creation are injected so the model stays testable and
 * the component stays presentational.
 */
export function ContextPicker(props: {
  disabled?: boolean;
  /** Open a terminal; undefined contextId = workspace root. */
  onPick(contextId?: string, opts?: PickedContextOptions): void;
  /** Fetch the live contexts (lazily, on open). */
  loadContexts(): Promise<ContextOption[]>;
  /** Create a new session context, resolving to its contextId and first-attach token. */
  createContext(): Promise<CreatedContext>;
}) {
  const [contexts, setContexts] = useState<ContextOption[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      setContexts(await props.loadContexts());
    } catch {
      setContexts([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <DropdownMenu.Root onOpenChange={(open) => open && void refresh()}>
      <DropdownMenu.Trigger>
        <Button variant="soft" disabled={props.disabled}>
          Open in context
          <ChevronDownIcon />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content size="1">
        <DropdownMenu.Item onSelect={() => props.onPick(undefined)}>
          Workspace root
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        {loading ? (
          <DropdownMenu.Item disabled>Loading contexts…</DropdownMenu.Item>
        ) : contexts.length === 0 ? (
          <DropdownMenu.Item disabled>No live contexts</DropdownMenu.Item>
        ) : (
          contexts.map((ctx) => (
            <DropdownMenu.Item key={ctx.contextId} onSelect={() => props.onPick(ctx.contextId)}>
              {ctx.label}
            </DropdownMenu.Item>
          ))
        )}
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          onSelect={() => {
            void props.createContext().then((created) =>
              props.onPick(created.contextId, {
                contextAttachToken: created.contextAttachToken,
              })
            );
          }}
        >
          New context…
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
