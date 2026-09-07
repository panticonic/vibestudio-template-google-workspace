import { useCallback, useEffect, useMemo, useReducer, type ComponentType } from "react";
import { Flex } from "@radix-ui/themes";
import {
  FeedbackContainer,
  FeedbackFormRenderer,
  type ActiveFeedbackTsx,
  type FeedbackComponentProps,
} from "@workspace/tool-ui";
import type { ChatSandboxValue } from "@workspace/agentic-core";
import type { ScopeManager, ScopesApi } from "@workspace/eval";
import { wrapChatForErrorReporting, wrapScopesForErrorReporting } from "../utils/wrapSandboxApis";
import { useChatContext } from "../context/ChatContext";

/**
 * Renders active feedback forms (schema-based and TSX-based).
 * Reads from ChatContext.
 */
export function ChatFeedbackArea() {
  const { activeFeedbacks, onFeedbackDismiss, onFeedbackError, chat, scope, scopes, scopeManager } =
    useChatContext();

  if (activeFeedbacks.size === 0) return null;

  return (
    <Flex direction="column" gap="2" flexShrink="0">
      {Array.from(activeFeedbacks.values()).map((feedback) => {
        // Render schema-based feedbacks using FeedbackFormRenderer
        if (feedback.type === "schema") {
          return (
            <FeedbackContainer
              key={feedback.callId}
              title={feedback.title}
              onDismiss={
                feedback.dismissible === false
                  ? undefined
                  : () => onFeedbackDismiss(feedback.callId)
              }
              onError={(error) => onFeedbackError(feedback.callId, error)}
            >
              <FeedbackFormRenderer
                title={feedback.title}
                fields={feedback.fields}
                initialValues={feedback.values}
                submitLabel={feedback.submitLabel}
                cancelLabel={feedback.cancelLabel}
                severity={feedback.severity}
                hideSubmit={feedback.hideSubmit}
                hideCancel={feedback.hideCancel}
                showTitle={false}
                onSubmit={(value) => feedback.complete({ type: "submit", value })}
                onCancel={() => feedback.complete({ type: "cancel" })}
              />
            </FeedbackContainer>
          );
        }

        // Render TSX-based feedbacks (type === "tsx")
        const FeedbackComponent = feedback.Component;
        if (!FeedbackComponent || typeof FeedbackComponent !== "function") {
          onFeedbackError(feedback.callId, new Error("Invalid feedback component"));
          return null;
        }
        return (
          <TsxFeedbackItem
            key={feedback.callId}
            feedback={feedback}
            FeedbackComponent={FeedbackComponent}
            chat={chat}
            scope={scope}
            scopes={scopes}
            scopeManager={scopeManager}
            onDismiss={() => onFeedbackDismiss(feedback.callId)}
            onError={(error) => onFeedbackError(feedback.callId, error)}
          />
        );
      })}
    </Flex>
  );
}

// ---------------------------------------------------------------------------
// TsxFeedbackItem — per-feedback wrapper that memoizes async-error wrappers
// ---------------------------------------------------------------------------

interface TsxFeedbackItemProps {
  feedback: ActiveFeedbackTsx;
  FeedbackComponent: ComponentType<FeedbackComponentProps>;
  chat: ChatSandboxValue;
  scope: Record<string, unknown>;
  scopes: ScopesApi;
  scopeManager: ScopeManager;
  onDismiss: () => void;
  onError: (error: Error) => void;
}

function TsxFeedbackItem({
  feedback,
  FeedbackComponent,
  chat,
  scope,
  scopes,
  scopeManager,
  onDismiss,
  onError,
}: TsxFeedbackItemProps) {
  const [, forceUpdate] = useReducer((value: number) => value + 1, 0);
  // Wrap chat so unhandled async rejections route to onError.
  // Memoized per feedback — onError changes when callId changes (new feedback).
  const wrappedChat = useMemo(() => wrapChatForErrorReporting(chat, onError), [chat, onError]);
  const wrappedScopes = useMemo(
    () => wrapScopesForErrorReporting(scopes, onError),
    [scopes, onError]
  );

  const onInteraction = useCallback(() => {
    void scopeManager.persist().catch((err) => {
      console.warn("[ChatFeedbackArea] Scope persist after interaction failed:", err);
    });
  }, [scopeManager]);

  useEffect(() => scopeManager.onChange(forceUpdate), [scopeManager]);

  const completeAfterPersist = useCallback(
    (result: Parameters<typeof feedback.complete>[0]) => {
      void (async () => {
        try {
          await scopeManager.persist();
          feedback.complete(result);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          console.warn("[ChatFeedbackArea] Scope persist before feedback completion failed:", err);
          onError(error);
          feedback.complete({
            type: "error",
            message: `Scope persist failed: ${error.message}`,
          });
        }
      })();
    },
    [feedback, onError, scopeManager]
  );

  return (
    <FeedbackContainer title={feedback.title} onDismiss={onDismiss} onError={onError}>
      <div
        onClickCapture={onInteraction}
        onInputCapture={onInteraction}
        onChangeCapture={onInteraction}
      >
        <FeedbackComponent
          onSubmit={(value) => completeAfterPersist({ type: "submit", value })}
          onCancel={() => completeAfterPersist({ type: "cancel" })}
          onError={(message) => feedback.complete({ type: "error", message })}
          chat={wrappedChat as unknown as Record<string, unknown>}
          scope={scope}
          scopes={wrappedScopes as unknown as Record<string, unknown>}
        />
      </div>
    </FeedbackContainer>
  );
}
