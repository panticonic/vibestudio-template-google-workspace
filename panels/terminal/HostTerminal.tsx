import { useEffect, useRef, useState } from "react";
import { Button, Flex, Text } from "@radix-ui/themes";
import { callMain } from "@workspace/runtime";
import { createVscodeTerminalFrontend } from "./vscodeTerminalFrontend.js";
import { resolveTerminalTheme, type TerminalAppearance } from "./paneTheme.js";
import type { TerminalFrontend } from "./terminalFrontend.js";

type HostSession = {
  terminalSessionId: string;
  host: string;
  cwd: string;
  shell: string;
};
type Output = { text: string; cursor: number; alive: boolean };

/** Explicit host authority is never restored or opened by a mount effect. */
export function HostTerminal(props: {
  executionPlatform: string | null;
  appearance: TerminalAppearance;
  fontFamily: string;
  fontSize: number;
  onFocusChange(focused: boolean): void;
}) {
  const [session, setSession] = useState<HostSession | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exited, setExited] = useState(false);
  const sessionRef = useRef<HostSession | null>(null);
  const mounted = useRef(true);
  const container = useRef<HTMLDivElement>(null);
  const frontend = useRef<TerminalFrontend | null>(null);
  const openingRef = useRef(false);
  const options = useRef(props);
  options.current = props;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      options.current.onFocusChange(false);
      const selected = sessionRef.current;
      sessionRef.current = null;
      if (selected)
        void callMain("hostTerminal.close", {
          terminalSessionId: selected.terminalSessionId,
        }).catch(() => undefined);
    };
  }, []);

  const open = async () => {
    if (openingRef.current || sessionRef.current) return;
    openingRef.current = true;
    setOpening(true);
    setError(null);
    try {
      const selected = await callMain<HostSession>("hostTerminal.open", {
        columns: 120,
        rows: 36,
      });
      if (!mounted.current) {
        await callMain("hostTerminal.close", {
          terminalSessionId: selected.terminalSessionId,
        });
        return;
      }
      sessionRef.current = selected;
      setSession(selected);
      setExited(false);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      openingRef.current = false;
      if (mounted.current) setOpening(false);
    }
  };

  const close = async () => {
    const selected = sessionRef.current;
    if (!selected) return;
    sessionRef.current = null;
    setSession(null);
    props.onFocusChange(false);
    try {
      const result = await callMain<{ processExited: boolean }>("hostTerminal.close", {
        terminalSessionId: selected.terminalSessionId,
      });
      if (!result.processExited && mounted.current)
        setError(
          "Terminal control closed; process exit was not confirmed. Background host processes may still be running."
        );
    } catch (cause) {
      if (mounted.current) setError(`Terminal close could not be confirmed: ${String(cause)}`);
    }
  };

  useEffect(() => {
    if (!session || !container.current) return;
    const host = container.current;
    const terminalSessionId = session.terminalSessionId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observer: ResizeObserver | undefined;
    let instance: TerminalFrontend | undefined;
    let input: { dispose(): void } | undefined;
    let resize: { dispose(): void } | undefined;
    let queue = Promise.resolve();
    let sequence = 0;
    let cursor = 0;
    let inputFailed = false;
    const fail = (cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    };
    void (async () => {
      instance = await createVscodeTerminalFrontend({
        fontFamily: options.current.fontFamily,
        fontSize: options.current.fontSize,
        theme: resolveTerminalTheme(options.current.appearance, host),
      });
      if (cancelled) {
        instance.dispose();
        return;
      }
      frontend.current = instance;
      instance.open(host);
      input = instance.onInput((data) => {
        queue = queue
          .then(async () => {
            if (cancelled || inputFailed) return;
            await callMain("hostTerminal.write", {
              terminalSessionId,
              sequence: ++sequence,
              data,
            });
          })
          .catch((cause) => {
            inputFailed = true;
            fail(cause);
          });
      });
      resize = instance.onResize(({ cols, rows }) => {
        void callMain("hostTerminal.resize", {
          terminalSessionId,
          columns: Math.max(20, Math.min(1000, cols)),
          rows: Math.max(5, Math.min(1000, rows)),
        }).catch(fail);
      });
      observer = new ResizeObserver(() => instance?.fit());
      observer.observe(host);
      instance.fit();
      instance.focus();
      const poll = async () => {
        if (cancelled) return;
        try {
          const output = await callMain<Output>("hostTerminal.read", {
            terminalSessionId,
            after: cursor,
            maxBytes: 512 * 1024,
          });
          if (cancelled) return;
          cursor = output.cursor;
          if (output.text)
            await new Promise<void>((resolve) => instance!.write(output.text, resolve));
          if (cancelled) return;
          if (!output.alive && !output.text) {
            setExited(true);
            return;
          }
          timer = setTimeout(() => void poll(), output.text ? 0 : 100);
        } catch (cause) {
          fail(cause);
        }
      };
      await poll();
    })().catch(fail);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      observer?.disconnect();
      input?.dispose();
      resize?.dispose();
      instance?.dispose();
      frontend.current = null;
    };
  }, [session]);

  useEffect(() => {
    frontend.current?.setTheme(resolveTerminalTheme(props.appearance, container.current));
  }, [props.appearance]);

  if (props.executionPlatform === "win32") {
    return (
      <Text size="1" color="amber">
        Windows workspace terminals and extensions run with your account's host
        permissions. They can access host files, credentials, processes and
        network. There is no separate protected terminal mode.
      </Text>
    );
  }
  if (!props.executionPlatform)
    return (
      <Text size="1" color="gray">
        Checking the workspace host's terminal permissions…
      </Text>
    );

  return (
    <Flex
      direction="column"
      gap="2"
      p="2"
      style={
        session
          ? {
              height: "45%",
              minHeight: 180,
              borderBottom: "2px solid var(--amber-9)",
            }
          : { flexShrink: 0 }
      }
      onFocusCapture={() => props.onFocusChange(Boolean(session))}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          props.onFocusChange(false);
      }}
    >
      <Flex align="center" justify="between" gap="2">
        {session ? (
          <Text size="2" weight="bold" color="amber">
            Host · {session.host} · Full host access{exited ? " · Exited" : ""}
          </Text>
        ) : (
          <Text size="1" color="gray">
            Workspace terminals are the default. Host access requires separate approval.
          </Text>
        )}
        <Button
          size="1"
          color="amber"
          variant="soft"
          disabled={opening}
          onClick={() => void (session ? close() : open())}
        >
          {session
            ? "Close host terminal"
            : opening
              ? "Waiting for host approval…"
              : "Open host terminal…"}
        </Button>
      </Flex>
      {error ? (
        <Text role="alert" size="2" color="red">
          {error}
        </Text>
      ) : null}
      {session ? (
        <div
          ref={container}
          aria-label={`Host terminal on ${session.host}, full host access`}
          style={{ flex: 1, minHeight: 0, minWidth: 0 }}
        />
      ) : null}
    </Flex>
  );
}
