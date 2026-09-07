/**
 * Notification client — shared between panels and workers.
 *
 * Allows callers to push notifications to the shell chrome area
 * (info toasts, errors, warnings, success confirmations).
 */
import type { RpcClient } from "@vibestudio/rpc";

type NotificationAction = {
  id?: string;
  label: string;
  variant?: "solid" | "soft" | "ghost";
  onClick?: () => void | Promise<void>;
};

type NotificationShowOptions = {
  type?: "info" | "success" | "warning" | "error" | "consent";
  title: string;
  message?: string;
  ttl?: number;
  actions?: NotificationAction[];
};

export interface NotificationClient {
  /** Show a notification. Returns the notification ID. */
  show(opts: NotificationShowOptions): Promise<string>;
  /** Dismiss a notification by ID. */
  dismiss(id: string): Promise<void>;
}
type NotificationRpc = Pick<RpcClient, "call" | "on">;

export function createNotificationClient(rpc: NotificationRpc): NotificationClient {
  const actionHandlers = new Map<string, Map<string, () => void | Promise<void>>>();
  let unsubscribeDirectActions: (() => void) | undefined;

  const handleAction = (payload: unknown): void => {
    const action = parseNotificationAction(payload);
    if (!action) return;
    const handlers = actionHandlers.get(action.id);
    if (action.actionId === "dismiss") {
      actionHandlers.delete(action.id);
      return;
    }
    const handler = handlers?.get(action.actionId);
    if (!handler) return;
    actionHandlers.delete(action.id);
    void Promise.resolve(handler()).catch((err) => {
      console.warn("notification action failed", err);
    });
  };

  function ensureActionSubscription(): void {
    unsubscribeDirectActions ??= rpc.on("notification:action", ({ payload }) =>
      handleAction(payload)
    );
  }

  return {
    async show(opts) {
      const handlers = new Map<string, () => void | Promise<void>>();
      const actions = opts.actions?.map(({ onClick, ...action }, index) => {
        const id = action.id ?? actionIdFor(action.label, index);
        if (onClick) handlers.set(id, onClick);
        return { ...action, id };
      });
      const id = await rpc.call<string>("main", "notification.show", [
        { type: "info", ...opts, actions },
      ]);
      if (handlers.size > 0) {
        actionHandlers.set(id, handlers);
        if (opts.ttl && opts.ttl > 0) {
          setTimeout(() => actionHandlers.delete(id), opts.ttl + 1000);
        }
        ensureActionSubscription();
      }
      return id;
    },
    async dismiss(id) {
      actionHandlers.delete(id);
      await rpc.call("main", "notification.dismiss", [id]);
    },
  };
}

function parseNotificationAction(payload: unknown): { id: string; actionId: string } | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  return typeof record["id"] === "string" && typeof record["actionId"] === "string"
    ? { id: record["id"], actionId: record["actionId"] }
    : undefined;
}

function actionIdFor(label: string, index: number): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug ? `${slug}-${index}` : `action-${index}`;
}
