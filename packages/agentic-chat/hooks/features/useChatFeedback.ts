/**
 * useChatFeedback — Feedback form + custom feedback handlers.
 *
 * Manages feedback_form and feedback_custom method definitions,
 * feedback lifecycle, and dismiss/error handling.
 */
import { useCallback, useRef, useEffect } from "react";
import type {
  MethodDefinition,
  MethodExecutionContext,
  FeedbackFormArgs,
  FeedbackCustomArgs,
  PubSubClient,
} from "@workspace/pubsub";
import { FeedbackFormArgsSchema, FeedbackCustomArgsSchema } from "@workspace/pubsub";
import {
  useFeedbackManager,
  type FeedbackResult,
  type ActiveFeedbackTsx,
  type ActiveFeedbackSchema,
  type ActiveFeedback,
} from "@workspace/tool-ui";
import type { SandboxOptions } from "@workspace/eval";
import type { FeedbackComponentProps } from "@workspace/tool-ui";
import { AGENTIC_EVENT_PAYLOAD_KIND, type AgenticEvent } from "@workspace/agentic-protocol";
import { type ChatSandboxValue } from "@workspace/agentic-core";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { fsMethods } from "@vibestudio/service-schemas/fs";
interface UseChatFeedbackOptions {
  chat: ChatSandboxValue;
  loadImport?: SandboxOptions["loadImport"];
  clientRef: React.MutableRefObject<PubSubClient<any> | null>;
  connected: boolean;
}
export interface ChatFeedbackState {
  activeFeedbacks: Map<string, ActiveFeedback>;
  /** Ref to current feedbacks — for stable access in callbacks */
  activeFeedbacksRef: React.MutableRefObject<Map<string, ActiveFeedback>>;
  /** Raw addFeedback/removeFeedback — needed by useChatTools for tool approval */
  addFeedback: ReturnType<typeof useFeedbackManager>["addFeedback"];
  removeFeedback: ReturnType<typeof useFeedbackManager>["removeFeedback"];
  /** Refs to feedback handlers — for use in connection effect */
  handleFeedbackFormCallRef: React.MutableRefObject<
    (callId: string, args: FeedbackFormArgs, ctx: MethodExecutionContext) => Promise<FeedbackResult>
  >;
  handleFeedbackCustomCallRef: React.MutableRefObject<
    (
      callId: string,
      args: FeedbackCustomArgs,
      ctx: MethodExecutionContext
    ) => Promise<FeedbackResult>
  >;
  /** Build feedback method definitions for the connection */
  buildFeedbackMethods: () => Record<string, MethodDefinition>;
  onFeedbackDismiss: (callId: string) => void;
  onFeedbackError: (callId: string, error: Error) => void;
}
export function useChatFeedback({
  chat,
  loadImport,
  clientRef,
  connected,
}: UseChatFeedbackOptions): ChatFeedbackState {
  const { activeFeedbacks, addFeedback, removeFeedback, dismissFeedback, handleFeedbackError } =
    useFeedbackManager();
  const activeFeedbacksRef = useRef(activeFeedbacks);
  activeFeedbacksRef.current = activeFeedbacks;
  const readTextFile = useCallback(
    async (path: string): Promise<string> => {
      const fsClient = createTypedServiceClient("fs", fsMethods, (svc, method, args) =>
        chat.rpc.call("main", `${svc}.${method}`, args)
      );
      return (await fsClient.readFile(path, "utf8")) as string;
    },
    [chat.rpc]
  );
  const handleFeedbackFormCall = useCallback(
    async (callId: string, args: FeedbackFormArgs, ctx: MethodExecutionContext) => {
      void ctx;
      return new Promise<FeedbackResult>((resolve) => {
        const feedback: ActiveFeedbackSchema = {
          type: "schema",
          callId,
          title: args.title,
          fields: args.fields,
          values: args.values ?? {},
          submitLabel: args.submitLabel,
          cancelLabel: args.cancelLabel,
          severity: args.severity,
          hideSubmit: args.hideSubmit,
          hideCancel: args.hideCancel,
          createdAt: Date.now(),
          complete: (feedbackResult: FeedbackResult) => {
            removeFeedback(callId);
            resolve(feedbackResult);
          },
        };
        addFeedback(feedback);
      });
    },
    [addFeedback, removeFeedback]
  );
  const handleFeedbackCustomCall = useCallback(
    async (callId: string, args: FeedbackCustomArgs, ctx: MethodExecutionContext) => {
      void ctx;
      const path = args.path?.trim();
      const sourceCode = path ? await readTextFile(path) : args.code;
      if (!sourceCode) throw new Error("Missing code or path");
      if (!sourceCode.includes("onSubmit")) {
        console.warn(
          "[feedback_custom] Component code does not reference 'onSubmit'. " +
            "The user will not be able to submit a response. Did you forget to destructure { onSubmit } from props?"
        );
      }
      const { compileComponent } = await import("@workspace/eval/sandbox");
      let compiled: Awaited<
        ReturnType<typeof compileComponent<import("react").ComponentType<FeedbackComponentProps>>>
      >;
      try {
        compiled = await compileComponent<import("react").ComponentType<FeedbackComponentProps>>(
          sourceCode,
          {
            imports: args.imports,
            sourcePath: path,
            loadSourceFile: path ? readTextFile : undefined,
            loadImport,
          }
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        compiled = { success: false, error: message };
      }
      if (!compiled.success) {
        const errorMessage = compiled.error ?? "Unknown compile error";
        // Surface the compile failure to the user as a dismissable schema
        // feedback card. Without this, a bad TSX from the agent renders
        // nothing on screen and the method result error flows past the user
        // silently. After the user dismisses, we throw so the caller sees
        // an error result via handleMethodCallExec's catch path.
        await new Promise<void>((resolve) => {
          const feedback: ActiveFeedbackSchema = {
            type: "schema",
            callId,
            title: "feedback_custom failed to compile",
            fields: [{ key: "__err", type: "readonly", label: "Error", default: errorMessage }],
            values: {},
            hideSubmit: true,
            cancelLabel: "Dismiss",
            severity: "danger",
            createdAt: Date.now(),
            complete: () => {
              removeFeedback(callId);
              resolve();
            },
          };
          addFeedback(feedback);
        });
        throw new Error(errorMessage);
      }
      const cacheKey = compiled.cacheKey!;
      return new Promise<FeedbackResult>((resolve) => {
        let resolved = false;
        const feedback: ActiveFeedbackTsx = {
          type: "tsx",
          callId,
          Component: compiled.Component!,
          createdAt: Date.now(),
          cacheKey,
          title: args.title,
          complete: (feedbackResult: FeedbackResult) => {
            if (resolved) return; // Prevent double-submission
            resolved = true;
            removeFeedback(callId);
            resolve(feedbackResult);
          },
        };
        addFeedback(feedback);
      });
    },
    [addFeedback, removeFeedback, readTextFile, loadImport]
  );
  const onFeedbackDismiss = useCallback(
    (callId: string) => {
      dismissFeedback(callId);
    },
    [dismissFeedback]
  );
  // Stable refs for connection effect
  const handleFeedbackFormCallRef = useRef(handleFeedbackFormCall);
  const handleFeedbackCustomCallRef = useRef(handleFeedbackCustomCall);
  useEffect(() => {
    handleFeedbackFormCallRef.current = handleFeedbackFormCall;
    handleFeedbackCustomCallRef.current = handleFeedbackCustomCall;
  }, [handleFeedbackFormCall, handleFeedbackCustomCall]);
  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;
    let cancelled = false;
    const consume = async () => {
      try {
        // A cancelled in-flight feedback invocation surfaces as a durable
        // invocation.cancelled / invocation.abandoned agentic event (the
        // channel emits it on cancel/interrupt). Resolve the matching
        // feedback UI as cancelled. Feedback handlers ignore ctx.signal,
        // so this observation is their cancellation path.
        for await (const event of client.events()) {
          if (cancelled) break;
          const wire = event as { type?: string; payload?: AgenticEvent };
          if (wire.type !== AGENTIC_EVENT_PAYLOAD_KIND || !wire.payload) continue;
          const ev = wire.payload;
          if (ev.kind !== "invocation.cancelled" && ev.kind !== "invocation.abandoned") continue;
          const callId = ev.causality?.transportCallId ?? ev.causality?.invocationId;
          if (!callId) continue;
          const feedback = activeFeedbacksRef.current.get(callId);
          if (!feedback) continue;
          feedback.complete({ type: "cancel" });
        }
      } catch (err) {
        if (!cancelled) console.error("[useChatFeedback] invocation cancel listener failed:", err);
      }
    };
    void consume();
    return () => {
      cancelled = true;
    };
  }, [clientRef, connected]);
  const buildFeedbackMethods = useCallback((): Record<string, MethodDefinition> => {
    const feedbackFormMethodDef: MethodDefinition = {
      description: `Show a form to collect user input.

**Result:** \`{ type: "submit", value: { fieldKey: userValue, ... } }\` or \`{ type: "cancel" }\`

**Field types:** string, number, boolean, select (needs \`options\`), segmented (\`options\`), multiSelect (\`options\`), slider (\`min\`/\`max\`)
**Field props:** \`key\` (required), \`label\` (required), \`type\` (required), \`default\`, \`required\`, \`description\`
**Conditional props:** \`visibleWhen\`, \`enabledWhen\`, and warning \`when\` accept \`{ field, operator, value }\`; warning \`when\` also accepts a value or value array for its own field.
**Choice fields:** select, segmented, and multiSelect include an "Other" free-text option by default unless \`allowFreeText: false\`; multiSelect also includes Select all / Deselect all controls.
**Pre-populate:** Add \`values: { "key": "existing value" }\``,
      parameters: FeedbackFormArgsSchema,
      execute: async (args: unknown, ctx: MethodExecutionContext) =>
        handleFeedbackFormCallRef.current(ctx.callId, args as FeedbackFormArgs, ctx),
    };
    const feedbackCustomMethodDef: MethodDefinition = {
      description: `Show a custom React component that blocks until user submits or cancels.

**The component receives { onSubmit, onCancel, onError, chat, scope, scopes }:**
- onSubmit(value) — return data to the agent and close the form
- onCancel() — signal cancellation to the agent
- onError(message) — signal error
- chat — chat API (publish messages, call runtime, etc.)
  - chat.publish(type, payload) — send a message to the conversation
  - chat.rpc.call(target, method, ...args) — call runtime services
- scope — panel-local durable UI state shared by inline_ui, feedback_custom, and the action bar in this panel instance. Serializable values persist in localStorage across panel reloads; functions, class instances, DOM objects, and other nonserializable values are live-only and are dropped on restore.
- scopes — scope API for this panel-local UI scope: scopes.save(), scopes.push(), scopes.list(), scopes.get(id)

**Side effects during interaction:**
- Component can call chat.publish() or chat.rpc.call() before submitting
- Example: a form that runs validation via chat.rpc before returning results

**Result:** \`{ type: "submit", value: ... }\` or \`{ type: "cancel" }\`

**Requirements:**
- Component MUST use \`export default\`
- Syntax: TSX (TypeScript + JSX)
- Provide either \`code\` or \`path\`. \`path\` reads a context-relative TSX file, supports static relative imports, and infers bare package imports from the nearest package.json when possible. Use \`imports\` for explicit package versions.
- Do NOT wrap in a Card — rendered inside a container with header and scroll area.

**Available imports:** react, @radix-ui/themes, @radix-ui/react-icons

**Example:**
\`\`\`tsx
import { useState } from "react";
import { Button, Flex, Text, TextField } from "@radix-ui/themes";

export default function App({ onSubmit, onCancel, scope }) {
  const [name, setName] = useState(() => typeof scope.name === "string" ? scope.name : "");
  const setDraft = (value) => {
    scope.name = value;
    setName(value);
  };
  return (
    <Flex direction="column" gap="3" p="2">
      <Text size="2" weight="bold">What is your name?</Text>
      <TextField.Root value={name} onChange={e => setDraft(e.target.value)} />
      <Flex gap="2" justify="end">
        <Button variant="soft" onClick={onCancel}>Cancel</Button>
        <Button onClick={() => onSubmit({ name })}>Submit</Button>
      </Flex>
    </Flex>
  );
}
\`\`\``,
      parameters: FeedbackCustomArgsSchema,
      execute: async (args: unknown, ctx: MethodExecutionContext) =>
        handleFeedbackCustomCallRef.current(ctx.callId, args as FeedbackCustomArgs, ctx),
    };
    return {
      feedback_form: feedbackFormMethodDef,
      feedback_custom: feedbackCustomMethodDef,
    };
  }, []);
  return {
    activeFeedbacks,
    activeFeedbacksRef,
    addFeedback,
    removeFeedback,
    handleFeedbackFormCallRef,
    handleFeedbackCustomCallRef,
    buildFeedbackMethods,
    onFeedbackDismiss,
    onFeedbackError: handleFeedbackError,
  };
}
