/**
 * The argument session (spec §3.3).
 *
 * Selecting a command that takes arguments does not execute it — it enters a
 * session rendered as breadcrumb chips, which walks the argument list in order.
 * This module is the whole state machine: a pure reducer over an explicit
 * state, so the desktop overlay, the mobile sheet, and tests all drive
 * identical behavior.
 *
 *   Enter on suggestion/valid text → fill activeIndex, advance (or execute
 *                                    when the last argument is passed)
 *   Enter on empty + optional arg  → skip
 *   Backspace on empty input       → pop last filled arg (or exit the session)
 *   Esc                            → exit, restoring the typed query
 */
import { validateArgValue, type ArgSpec, type CommandSpec } from "./commands";

export interface ArgSession {
  spec: CommandSpec;
  /** Values collected so far, keyed by argument name. Skipped args are absent. */
  filled: Record<string, string>;
  /** Index into `spec.args` currently being prompted. */
  activeIndex: number;
  error: string | null;
  /** Text typed for the active argument. */
  query: string;
  /**
   * What the user had typed when the session opened, restored on Esc so
   * backing out of a command never loses the query that found it.
   */
  restoreQuery: string;
}

export type ArgSessionAction =
  | { type: "input"; value: string }
  /** Enter. `value` is the chosen suggestion, or the typed text. */
  | { type: "enter"; value?: string }
  /** Backspace with an empty input. */
  | { type: "backspace" }
  | { type: "escape" };

export type ArgSessionOutcome =
  | { kind: "session"; session: ArgSession }
  | { kind: "execute"; command: CommandSpec; args: Record<string, string> }
  | { kind: "exit"; restoreQuery: string };

function args(spec: CommandSpec): ArgSpec[] {
  return spec.args ?? [];
}

function activeArg(session: ArgSession): ArgSpec | undefined {
  return args(session.spec)[session.activeIndex];
}

/** The argument being prompted right now, if the session is still collecting. */
export function activeArgSpec(session: ArgSession): ArgSpec | undefined {
  return activeArg(session);
}

/** Ordered chips: every argument with a value, in declaration order. */
export function filledArgChips(session: ArgSession): Array<{ arg: ArgSpec; value: string }> {
  return args(session.spec).flatMap((arg) => {
    const value = session.filled[arg.name];
    return value === undefined ? [] : [{ arg, value }];
  });
}

function completed(spec: CommandSpec, filled: Record<string, string>): ArgSessionOutcome {
  return { kind: "execute", command: spec, args: filled };
}

/**
 * Open a session for `command`, optionally seeded by an inline parse.
 *
 * Returns `execute` straight away when the command takes no arguments, or when
 * an inline utterance already supplied everything required — that is what makes
 * `>move right` a single Enter.
 */
export function startArgSession(
  command: CommandSpec,
  options?: {
    /** Values already resolved (e.g. from the inline grammar). */
    prefilled?: Record<string, string>;
    /** Leftover inline text; becomes the first prompted argument's query. */
    seedQuery?: string;
    /** Query to restore if the session is abandoned. */
    restoreQuery?: string;
  }
): ArgSessionOutcome {
  const list = args(command);
  const filled = { ...(options?.prefilled ?? {}) };
  const restoreQuery = options?.restoreQuery ?? "";
  if (list.length === 0) return completed(command, filled);
  const activeIndex = list.findIndex((arg) => filled[arg.name] === undefined);
  if (activeIndex < 0) return completed(command, filled);
  return {
    kind: "session",
    session: {
      spec: command,
      filled,
      activeIndex,
      error: null,
      query: options?.seedQuery ?? "",
      restoreQuery,
    },
  };
}

/** Advance past `index`, executing once the last argument has been passed. */
function advance(
  session: ArgSession,
  filled: Record<string, string>,
  from: number
): ArgSessionOutcome {
  const next = from + 1;
  if (next >= args(session.spec).length) return completed(session.spec, filled);
  return {
    kind: "session",
    session: { ...session, filled, activeIndex: next, error: null, query: "" },
  };
}

export function reduceArgSession(
  session: ArgSession,
  action: ArgSessionAction
): ArgSessionOutcome {
  switch (action.type) {
    case "input":
      // Typing is what clears a validation error; the session never closes on one.
      return { kind: "session", session: { ...session, query: action.value, error: null } };

    case "escape":
      return { kind: "exit", restoreQuery: session.restoreQuery };

    case "backspace": {
      const chips = filledArgChips(session);
      const last = chips.at(-1);
      if (!last) return { kind: "exit", restoreQuery: session.restoreQuery };
      const filled = { ...session.filled };
      delete filled[last.arg.name];
      const index = args(session.spec).indexOf(last.arg);
      return {
        kind: "session",
        // Popping restores the popped value as the query so it can be edited
        // rather than retyped.
        session: { ...session, filled, activeIndex: index, error: null, query: last.value },
      };
    }

    case "enter": {
      const arg = activeArg(session);
      if (!arg) return completed(session.spec, session.filled);
      const raw = (action.value ?? session.query).trim();
      if (!raw) {
        if (arg.required) {
          return {
            kind: "session",
            session: { ...session, error: `${arg.label} is required.` },
          };
        }
        // Skipping an optional argument leaves it absent, not empty.
        const filled = { ...session.filled };
        delete filled[arg.name];
        return advance(session, filled, session.activeIndex);
      }
      const error = validateArgValue(arg, raw);
      if (error) return { kind: "session", session: { ...session, error } };
      return advance(session, { ...session.filled, [arg.name]: raw }, session.activeIndex);
    }
  }
}
