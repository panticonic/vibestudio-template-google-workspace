import { PaneView } from "./PaneView.js";
import { SplitPane } from "./SplitPane.js";
import type { ReactNode } from "react";
import type { ParsedNotification } from "./notificationParser.js";
import type { TerminalAppearance } from "./paneTheme.js";
import type {
  NotificationSeverity,
  SessionInfo,
  ShellApi,
  SplitNode,
  TerminalNotification,
} from "./types.js";

export function SplitTree(props: {
  node: SplitNode;
  path?: Array<"a" | "b">;
  sessions: Record<string, SessionInfo>;
  notifications: TerminalNotification[];
  focusedSessionId?: string;
  settingsControl?: ReactNode;
  shell: ShellApi;
  fontSize: number;
  fontFamily: string;
  appearance: TerminalAppearance;
  pasteMode: "path" | "dataUri" | "both";
  imagePasteRelative: boolean;
  resizeKey?: number;
  onFocus(sessionId: string): void;
  onClose(sessionId: string): void;
  onSplit(sessionId: string, direction: "row" | "column"): void;
  onOpenPort(sessionId: string, port: number): void;
  onOpenUrl(sessionId: string, url: string): void;
  onClear(sessionId: string): void;
  onDuplicate(sessionId: string): void;
  onRestart(sessionId: string): void;
  onRestartCommand(sessionId: string): void;
  onFind(sessionId: string): void;
  onZoom(sessionId: string): void;
  onOpenScratch(): void;
  onRatioChange(path: Array<"a" | "b">, ratio: number): void;
  onNotification(sessionId: string, notification: ParsedNotification): void;
}) {
  const path = props.path ?? [];
  if (props.node.kind === "leaf") {
    const session = props.sessions[props.node.sessionId];
    if (!session) return null;
    return (
      <PaneView
        shell={props.shell}
        session={session}
        fontSize={props.fontSize}
        fontFamily={props.fontFamily}
        appearance={props.appearance}
        pasteMode={props.pasteMode}
        imagePasteRelative={props.imagePasteRelative}
        resizeKey={props.resizeKey}
        focused={props.focusedSessionId === session.sessionId}
        settingsControl={
          props.focusedSessionId === session.sessionId ? props.settingsControl : undefined
        }
        severity={sessionSeverity(session, props.notifications)}
        onFocus={() => props.onFocus(session.sessionId)}
        onClose={() => props.onClose(session.sessionId)}
        onSplitRight={() => props.onSplit(session.sessionId, "row")}
        onSplitDown={() => props.onSplit(session.sessionId, "column")}
        onOpenPort={(port) => props.onOpenPort(session.sessionId, port)}
        onOpenUrl={(url) => props.onOpenUrl(session.sessionId, url)}
        onClear={() => props.onClear(session.sessionId)}
        onDuplicate={() => props.onDuplicate(session.sessionId)}
        onRestart={() => props.onRestart(session.sessionId)}
        onRestartCommand={() => props.onRestartCommand(session.sessionId)}
        onFind={() => props.onFind(session.sessionId)}
        onZoom={() => props.onZoom(session.sessionId)}
        onOpenScratch={props.onOpenScratch}
        onNotification={(notification) => props.onNotification(session.sessionId, notification)}
      />
    );
  }
  return (
    <SplitPane
      direction={props.node.direction}
      ratio={props.node.ratio}
      onRatioChange={(ratio) => props.onRatioChange(path, ratio)}
    >
      <SplitTree {...props} path={[...path, "a"]} node={props.node.a} />
      <SplitTree {...props} path={[...path, "b"]} node={props.node.b} />
    </SplitPane>
  );
}

export function sessionSeverity(
  session: Pick<SessionInfo, "sessionId" | "alive" | "exit">,
  notifications: TerminalNotification[]
): NotificationSeverity {
  if (!session.alive && (session.exit?.code !== 0 || session.exit?.signal)) return "failure";
  const severities = notifications
    .filter((item) => item.sessionId === session.sessionId && !item.read)
    .map((item) => item.severity);
  if (severities.includes("failure")) return "failure";
  if (severities.includes("approval")) return "approval";
  if (severities.includes("waiting")) return "waiting";
  if (severities.includes("done")) return "done";
  return "info";
}
