import { Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { Box, Spinner } from "@radix-ui/themes";
import { EventErrorBoundary } from "@workspace/tool-ui/components/EventErrorBoundary";
import { useChatContext } from "../context/ChatContext";
import { wrapChatForErrorReporting, wrapScopesForErrorReporting } from "../utils/wrapSandboxApis";
import { InlineUiErrorCallout } from "./InlineUiMessage";
import type { ActionBarState } from "../types";

const DEFAULT_MAX_HEIGHT = 180;
const MIN_MAX_HEIGHT = 64;
const MAX_MAX_HEIGHT = 360;

function clampMaxHeight(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_HEIGHT;
  return Math.min(MAX_MAX_HEIGHT, Math.max(MIN_MAX_HEIGHT, value));
}

function ChatActionBarContent({ actionBar }: { actionBar: ActionBarState }) {
  const { chat, scope, scopes, scopeManager, onActionBarMaxHeightChange } = useChatContext();
  const { data, component } = actionBar;
  const CompiledComponent = component?.Component;
  const componentProps = useMemo(() => data.props ?? {}, [data.props]);
  const [, forceUpdate] = useReducer((value: number) => value + 1, 0);
  const [asyncError, setAsyncError] = useState<Error | null>(null);
  const [isAtLimit, setIsAtLimit] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startY: number; startHeight: number; nextHeight: number } | null>(null);

  const onAsyncError = useCallback(
    (err: Error) => {
      console.error(
        `[ChatActionBar] Component "${data.id}" failed (${data.source.type === "file" ? data.source.path : "inline code"}):`,
        err
      );
      setAsyncError(err);
    },
    [data.id, data.source]
  );
  const wrappedChat = useMemo(
    () => wrapChatForErrorReporting(chat, onAsyncError),
    [chat, onAsyncError],
  );
  const wrappedScopes = useMemo(
    () => wrapScopesForErrorReporting(scopes, onAsyncError),
    [scopes, onAsyncError],
  );

  const onInteraction = useCallback(() => {
    void scopeManager.persist().catch((err) => {
      console.warn("[ChatActionBar] Scope persist after interaction failed:", err);
    });
  }, [scopeManager]);

  useEffect(() => scopeManager.onChange(forceUpdate), [scopeManager]);

  const resetKey = `${data.id}:${JSON.stringify(data.props ?? {})}`;
  useEffect(() => { setAsyncError(null); }, [resetKey]);

  const maxHeight = clampMaxHeight(data.maxHeight);
  const showResizeHandle = isAtLimit || data.maxHeight !== undefined;

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const update = () => {
      setIsAtLimit(content.scrollHeight >= maxHeight - 1);
    };
    update();

    const observer = new ResizeObserver(update);
    observer.observe(content);
    return () => observer.disconnect();
  }, [maxHeight, resetKey]);

  const onResizePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startY: event.clientY, startHeight: maxHeight, nextHeight: maxHeight };
  }, [maxHeight]);

  const onResizePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const next = clampMaxHeight(dragRef.current.startHeight + event.clientY - dragRef.current.startY);
    dragRef.current.nextHeight = next;
    onActionBarMaxHeightChange?.(next, { saveState: false });
  }, [onActionBarMaxHeightChange]);

  const onResizePointerEnd = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const next = dragRef.current.nextHeight;
    dragRef.current = null;
    onActionBarMaxHeightChange?.(next);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, [onActionBarMaxHeightChange]);

  const onResizeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 24 : 12;
    let next: number | null = null;
    if (event.key === "ArrowUp") next = clampMaxHeight(maxHeight - step);
    if (event.key === "ArrowDown") next = clampMaxHeight(maxHeight + step);
    if (event.key === "Home") next = MIN_MAX_HEIGHT;
    if (event.key === "End") next = MAX_MAX_HEIGHT;
    if (next === null) return;
    event.preventDefault();
    onActionBarMaxHeightChange?.(next);
  }, [maxHeight, onActionBarMaxHeightChange]);

  return (
    <Box
      className="chat-action-bar"
      data-action-bar-id={data.id}
      style={{ maxBlockSize: maxHeight }}
    >
      <Box
        className="chat-action-bar-content"
        ref={contentRef}
        onClickCapture={onInteraction}
        onInputCapture={onInteraction}
        onChangeCapture={onInteraction}
      >
        {asyncError ? (
          <InlineUiErrorCallout
            error={asyncError}
            componentId={data.id}
            source={data.source.type === "file" ? data.source.path : "inline code"}
            chat={chat}
          />
        ) : component?.error ? (
          <InlineUiErrorCallout
            error={new Error(component.error)}
            componentId={data.id}
            source={data.source.type === "file" ? data.source.path : "inline code"}
            chat={chat}
          />
        ) : !CompiledComponent ? (
          <Spinner size="1" />
        ) : (
          <EventErrorBoundary
            resetKey={resetKey}
            onError={onAsyncError}
            renderFallback={(error) => (
              <InlineUiErrorCallout
                error={error}
                componentId={data.id}
                source={data.source.type === "file" ? data.source.path : "inline code"}
                chat={chat}
              />
            )}
          >
            <Suspense fallback={<Spinner size="1" />}>
              <CompiledComponent
                props={componentProps}
                chat={wrappedChat as unknown as Record<string, unknown>}
                scope={scope}
                scopes={wrappedScopes as unknown as Record<string, unknown>}
              />
            </Suspense>
          </EventErrorBoundary>
        )}
      </Box>
      {showResizeHandle && onActionBarMaxHeightChange ? (
        <Box
          className="chat-action-bar-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize action bar"
          aria-valuemin={MIN_MAX_HEIGHT}
          aria-valuemax={MAX_MAX_HEIGHT}
          aria-valuenow={maxHeight}
          tabIndex={0}
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerEnd}
          onPointerCancel={onResizePointerEnd}
          onKeyDown={onResizeKeyDown}
        />
      ) : null}
    </Box>
  );
}

export function ChatActionBar() {
  const { actionBar } = useChatContext();
  if (!actionBar) return null;
  return <ChatActionBarContent actionBar={actionBar} />;
}
