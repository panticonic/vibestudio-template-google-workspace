import { fs } from "@workspace/runtime";
import { customCommandsFileSchema, type CustomCommand } from "./customCommands.js";
import type { CommandRunTarget } from "./commandLauncherModel.js";

export type CommandSuggestion =
  | { id: string; kind: "recent"; label: string; command: string; subtitle?: string; defaultTarget?: CommandRunTarget }
  | { id: string; kind: "project"; label: string; command: string; subtitle?: string; defaultTarget?: CommandRunTarget }
  | { id: string; kind: "builtin"; label: string; action: BuiltinAction; subtitle?: string }
  | { id: string; kind: "raw"; label: string; command: string; subtitle?: string; defaultTarget?: CommandRunTarget };

export type BuiltinAction = "newPane" | "splitRight" | "splitDown" | "clear" | "toggleFind" | "toggleNotifications";

export async function loadCommandSuggestions(args: {
  query: string;
  cwd?: string;
  history: string[];
}): Promise<CommandSuggestion[]> {
  const query = args.query.trim();
  const suggestions: CommandSuggestion[] = [];
  suggestions.push(...args.history.slice(0, 20).map((command) => ({
    id: `recent:${command}`,
    kind: "recent" as const,
    label: command,
    command,
    subtitle: "Recent",
  })));
  suggestions.push(...await loadProjectCommands(args.cwd));
  suggestions.push(
    { id: "builtin:newPane", kind: "builtin", label: "New pane", action: "newPane", subtitle: "Open a shell beside this pane" },
    { id: "builtin:splitRight", kind: "builtin", label: "Split right", action: "splitRight", subtitle: "Open a shell beside this pane" },
    { id: "builtin:splitDown", kind: "builtin", label: "Split down", action: "splitDown", subtitle: "Open a shell below this pane" },
    { id: "builtin:clear", kind: "builtin", label: "Clear scrollback", action: "clear", subtitle: "Clear the focused pane" },
    { id: "builtin:toggleFind", kind: "builtin", label: "Toggle find", action: "toggleFind", subtitle: "Search the focused pane" },
    { id: "builtin:toggleNotifications", kind: "builtin", label: "Toggle notifications", action: "toggleNotifications", subtitle: "Show or hide the drawer" },
  );
  if (query) suggestions.push({ id: `raw:${query}`, kind: "raw", label: `Run "${query}"`, command: query, subtitle: args.cwd ?? "Current pane" });
  return rankSuggestions(suggestions, query);
}

async function loadProjectCommands(cwd?: string): Promise<CommandSuggestion[]> {
  const commands: CommandSuggestion[] = [];
  const dirs = parentDirs(cwd);
  const customCommands = await readFirstCustomCommands(dirs);
  for (const custom of customCommands) {
    commands.push({
      id: `custom:${custom.id}`,
      kind: "project",
      label: custom.label,
      command: [custom.command, ...(custom.args ?? []).map(shellQuote)].join(" "),
      subtitle: ".snug/commands.json",
      defaultTarget: customCommandTarget(custom),
    });
  }
  const packageJson = await readFirstJsonFile(dirs.map((dir) => `${dir}/package.json`));
  const scripts = packageJson && typeof packageJson === "object" && "scripts" in packageJson ? packageJson.scripts : undefined;
  if (scripts && typeof scripts === "object") {
    for (const [name] of Object.entries(scripts)) {
      commands.push({ id: `script:${name}`, kind: "project", label: `pnpm ${name}`, command: `pnpm ${name}`, subtitle: "package.json script" });
    }
  }
  return commands;
}

function customCommandTarget(command: CustomCommand): CommandRunTarget | undefined {
  if (command.splitDirection === "down") return "splitDown";
  if (command.splitDirection === "right") return "splitRight";
  if (command.openInNewPane === false) return "here";
  if (command.openInNewPane === true) return "splitRight";
  return undefined;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

async function readCustomCommands(cwd?: string): Promise<CustomCommand[]> {
  const parsed = await readJsonFile(`${cwd ?? "."}/.snug/commands.json`);
  if (!parsed) return [];
  const result = customCommandsFileSchema.safeParse(parsed);
  return result.success ? result.data.commands : [];
}

async function readFirstCustomCommands(dirs: string[]): Promise<CustomCommand[]> {
  for (const dir of dirs) {
    const commands = await readCustomCommands(dir);
    if (commands.length) return commands;
  }
  return [];
}

async function readFirstJsonFile(paths: string[]): Promise<unknown | undefined> {
  for (const path of paths) {
    const parsed = await readJsonFile(path);
    if (parsed) return parsed;
  }
  return undefined;
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    const content = await fs.readFile(path, "utf8");
    return JSON.parse(String(content));
  } catch {
    return undefined;
  }
}

function rankSuggestions(suggestions: CommandSuggestion[], query: string): CommandSuggestion[] {
  if (!query) return suggestions.slice(0, 200);
  const needle = query.toLowerCase();
  return suggestions
    .filter((suggestion) => `${suggestion.label} ${"command" in suggestion ? suggestion.command : ""} ${suggestion.subtitle ?? ""}`.toLowerCase().includes(needle))
    .slice(0, 200);
}

function parentDirs(cwd?: string): string[] {
  const start = (cwd?.trim() || ".").replace(/\/+$/, "") || ".";
  const dirs: string[] = [];
  let current = start;
  for (let i = 0; i < 12; i += 1) {
    dirs.push(current);
    const next = parentDir(current);
    if (next === current) break;
    current = next;
  }
  return dirs;
}

function parentDir(dir: string): string {
  if (dir === "." || dir === "/" || /^[A-Za-z]:[\\/]?$/.test(dir)) return dir;
  const normalized = dir.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index < 0) return ".";
  if (index === 0) return "/";
  return normalized.slice(0, index);
}
