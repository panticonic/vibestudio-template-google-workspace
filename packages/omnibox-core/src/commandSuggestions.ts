/**
 * The command suggestion source and the inline command grammar (spec §2.2,
 * §3.3).
 *
 * Ranking reuses the launcher's tier discipline verbatim — exact beats prefix
 * beats substring, and usage only ever breaks ties *within* a tier — so a
 * command and a panel ranked side by side in mixed mode are comparable numbers
 * rather than two unrelated scales.
 */
import {
  MATCH_PREFIX,
  MATCH_SUBSTRING,
  textMatchScore,
  usageScore,
  type LauncherGroup,
  type LauncherSuggestion,
  type PanelUsage,
} from "./launcherSuggestions";
import {
  commandAvailability,
  validateArgValue,
  type ArgOption,
  type ArgSpec,
  type CommandSpec,
  type SurfaceContext,
} from "./commands";

/** A ranked command row. `inline` carries arguments parsed from the query. */
export interface CommandSuggestion {
  id: string;
  kind: "command";
  command: CommandSpec;
  score: number;
  /** True when `availability` returned `false` (listed, but not runnable). */
  disabled?: boolean;
  /** Arguments pre-filled from an inline utterance (`>move right`). */
  inline?: InlineCommandParse;
}

/** A row offered while an argument is being prompted. */
export interface OptionSuggestion {
  id: string;
  kind: "option";
  option: ArgOption;
  score: number;
}

export type OmniboxSuggestion = LauncherSuggestion | CommandSuggestion | OptionSuggestion;
export type OmniboxKind = OmniboxSuggestion["kind"];

export const OMNIBOX_GROUP_LABELS: Record<OmniboxKind, string> = {
  command: "Commands",
  option: "Options",
  url: "Web address",
  panel: "Panels",
  history: "Recent pages",
  chat: "Ask an agent",
};

/**
 * Bucket a ranked mixed list by kind for display, on the same terms as
 * `groupLauncherSuggestions`: groups appear in order of their best-ranked
 * member unless an explicit idle order is supplied, so the keyboard order and
 * the visual order stay identical.
 */
export function groupOmniboxSuggestions<T extends { kind: OmniboxKind }>(
  suggestions: T[],
  order?: OmniboxKind[]
): LauncherGroup<T>[] {
  const groups: Array<LauncherGroup<T>> = [];
  const byKind = new Map<OmniboxKind, LauncherGroup<T>>();
  for (const suggestion of suggestions) {
    let group = byKind.get(suggestion.kind);
    if (!group) {
      group = {
        kind: suggestion.kind as LauncherSuggestion["kind"],
        label: OMNIBOX_GROUP_LABELS[suggestion.kind],
        items: [],
      };
      byKind.set(suggestion.kind, group);
      groups.push(group);
    }
    group.items.push(suggestion);
  }
  if (!order) return groups;
  const rank = (kind: OmniboxKind) => {
    const index = order.indexOf(kind);
    return index < 0 ? order.length : index;
  };
  return groups.sort((a, b) => rank(a.kind as OmniboxKind) - rank(b.kind as OmniboxKind));
}

/** Terms a command can be matched or addressed by. */
export function commandMatchTerms(command: CommandSpec): string[] {
  const idTail = command.id.split(/[.:]/u).at(-1);
  return [
    command.title,
    ...(command.aliases ?? []),
    ...(idTail ? [idTail] : []),
    command.id,
  ].filter((value): value is string => !!value);
}

const DEFAULT_COMMAND_LIMIT = 20;

export interface CommandSuggestionInput {
  /** The query with any mode prefix already stripped. */
  query: string;
  commands: CommandSpec[];
  ctx: SurfaceContext;
  /** Per-command-id usage, ranked exactly like panel-source usage. */
  usage?: PanelUsage;
  limit?: number;
}

/**
 * Rank commands for the current query.
 *
 * With an empty query this is the idle slate (usage-ranked); with a query it is
 * a tiered match over title, aliases, id tail, and never-displayed keywords.
 * Availability-matched commands are boosted a full tier so, say, `Unpin Panel`
 * over a pinned panel outranks a same-tier match that does not apply here.
 */
export function buildCommandSuggestions(input: CommandSuggestionInput): CommandSuggestion[] {
  const query = input.query.trim();
  const rows: CommandSuggestion[] = [];
  for (const command of input.commands) {
    const availability = commandAvailability(command, input.ctx);
    if (availability === "hidden") continue;
    const usage = input.usage?.[command.id];
    const base = usageScore(usage?.count ?? 0, usage?.lastUsed ?? 0);
    let score: number;
    if (!query) {
      score = base;
    } else {
      const primary = textMatchScore(query, ...commandMatchTerms(command));
      const keyword =
        primary < 0 && command.keywords?.length
          ? Math.min(MATCH_SUBSTRING, textMatchScore(query, ...command.keywords))
          : -1;
      const match = primary >= 0 ? primary : keyword;
      if (match < 0) continue;
      score = match + base;
    }
    if (availability === true) score += MATCH_SUBSTRING / 2;
    rows.push({
      id: `command:${command.id}`,
      kind: "command",
      command,
      score,
      ...(availability === false ? { disabled: true } : {}),
    });
  }
  return rows
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, input.limit ?? DEFAULT_COMMAND_LIMIT);
}

/** Rank the options offered for one argument. */
export function buildArgSuggestions(
  arg: ArgSpec,
  query: string,
  ctx: SurfaceContext
): OptionSuggestion[] {
  const options = arg.suggest ? arg.suggest(query, ctx) : (arg.options ?? []);
  const trimmed = query.trim();
  const rows: OptionSuggestion[] = [];
  for (const option of options) {
    const match = trimmed ? textMatchScore(trimmed, option.label, option.value) : MATCH_PREFIX;
    if (match < 0) continue;
    rows.push({ id: `option:${arg.name}:${option.value}`, kind: "option", option, score: match });
  }
  // A `suggest` provider already ranks its own rows; preserve that order when
  // nothing is typed, and only re-sort once there is a query to rank against.
  if (!trimmed) return rows;
  return rows.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Inline grammar
// ---------------------------------------------------------------------------

export interface InlineCommandParse {
  command: CommandSpec;
  /** The text that named the command. */
  head: string;
  /** Values resolved from the trailing words, keyed by argument name. */
  filled: Record<string, string>;
  /** Text that could not be assigned; seeds the prompted session. */
  residual: string;
  /** True when every required argument is filled and nothing is left over. */
  complete: boolean;
}

function tokenize(value: string): string[] {
  return value.trim().split(/\s+/u).filter(Boolean);
}

/** Whether `head` names `command` at a word boundary. */
function headNamesCommand(command: CommandSpec, head: string): boolean {
  const normalized = head.toLowerCase();
  return commandMatchTerms(command).some((term) => {
    const candidate = term.toLowerCase();
    if (candidate === normalized) return true;
    if (!candidate.startsWith(normalized)) return false;
    // Only a whole leading word may abbreviate a command; "mo" must not claim
    // "Move Panel" and swallow the rest of the line as arguments.
    return candidate[normalized.length] === " " || candidate[normalized.length] === "-";
  });
}

function matchOption(options: ArgOption[], token: string): ArgOption | null {
  const normalized = token.toLowerCase();
  return (
    options.find((o) => o.value.toLowerCase() === normalized || o.label.toLowerCase() === normalized) ??
    options.find(
      (o) => o.value.toLowerCase().startsWith(normalized) || o.label.toLowerCase().startsWith(normalized)
    ) ??
    null
  );
}

/** Consume the tail into the command's arguments, left to right. */
function fillFromTail(
  command: CommandSpec,
  tail: string,
  ctx: SurfaceContext
): { filled: Record<string, string>; residual: string } {
  const args = command.args ?? [];
  const filled: Record<string, string> = {};
  let rest = tail.trim();
  for (let index = 0; index < args.length && rest; index += 1) {
    const arg = args[index]!;
    const isLast = index === args.length - 1;
    const options = arg.type === "enum" ? (arg.options ?? []) : arg.suggest?.(rest, ctx) ?? null;
    if (options) {
      const tokens = tokenize(rest);
      const token = tokens[0]!;
      const option = matchOption(options, token);
      if (!option) break;
      filled[arg.name] = option.value;
      rest = tokens.slice(1).join(" ");
      continue;
    }
    // Free text: the final argument absorbs the whole remainder (so
    // `>ask why is this slow` works), earlier ones take a single token.
    const candidate = isLast ? rest : tokenize(rest)[0]!;
    if (validateArgValue(arg, candidate) !== null) break;
    filled[arg.name] = candidate;
    rest = isLast ? "" : tokenize(rest).slice(1).join(" ");
  }
  return { filled, residual: rest.trim() };
}

/**
 * Parse a full inline utterance (`>move right`, `>theme dark`).
 *
 * Only fires when there is a trailing tail — a bare command name is ordinary
 * ranking, not an inline utterance. An ambiguous or invalid tail still returns
 * a parse, but with `complete: false` and the leftover text in `residual`, so
 * the caller can drop into the prompted argument session with the tail as the
 * first argument's query (spec §3.3).
 */
export function parseInlineCommand(
  query: string,
  commands: CommandSpec[],
  ctx: SurfaceContext
): InlineCommandParse | null {
  const tokens = tokenize(query);
  if (tokens.length < 2) return null;
  const available = commands.filter((command) => commandAvailability(command, ctx) !== "hidden");
  for (let take = tokens.length - 1; take >= 1; take -= 1) {
    const head = tokens.slice(0, take).join(" ");
    const matches = available.filter((command) => headNamesCommand(command, head));
    if (matches.length !== 1) continue;
    const command = matches[0]!;
    if (!command.args?.length) continue;
    const tail = tokens.slice(take).join(" ");
    const { filled, residual } = fillFromTail(command, tail, ctx);
    const complete =
      !residual && command.args.every((arg) => !arg.required || filled[arg.name] !== undefined);
    return { command, head, filled, residual, complete };
  }
  return null;
}
