/**
 * Resource loader — fetches the system prompt and skill index from the
 * Vibestudio workspace via RPC.
 *
 * PiRunner uses this at session startup to inject `AGENTS.md` content and
 * a formatted skill index into the agent's system prompt. The skill index
 * is markdown that the LLM can read; actual skill files are read on demand
 * by the read tool from the per-context folder.
 *
 * Contract: `workspace.getAgentsMd` returns the workspace AGENTS.md
 * as a string; `workspace.listSkills` returns an array of `SkillEntry`
 * descriptors (one per repo-embedded SKILL.md).
 */
import type { RpcCaller } from "@vibestudio/rpc";
import { AgentWorkerError } from "./errors.js";

export type { RpcCaller } from "@vibestudio/rpc";

export interface SkillEntry {
  /** Skill identifier from frontmatter, falling back to the containing repo name. */
  name: string;
  /** Short human-readable description shown in the skill index. */
  description: string;
  /** Workspace-relative repo path containing the skill. */
  dirPath: string;
  /** Workspace-relative path to the SKILL.md file. */
  skillPath: string;
}
export interface VibestudioResources {
  /** Contents of `workspace/meta/AGENTS.md`. */
  systemPrompt: string;
  /** Markdown-formatted skill index suitable for appending to the system prompt. */
  skillIndex: string;
  /** Raw skill descriptors. */
  skills: SkillEntry[];
}
export interface ResourceLoaderDeps {
  rpc: RpcCaller;
  signal?: AbortSignal;
}
/**
 * Fetches the workspace system prompt and skill list in parallel and
 * returns a `VibestudioResources` bundle for PiRunner to consume.
 */
export async function loadVibestudioResources(deps: ResourceLoaderDeps): Promise<VibestudioResources> {
  throwIfAborted(deps.signal);
  const [systemPromptRaw, skillsRaw] = await Promise.all([
    abortable(callWorkspace<unknown>(deps, "workspace.getAgentsMd"), deps.signal),
    abortable(callWorkspace<unknown>(deps, "workspace.listSkills"), deps.signal),
  ]);
  const systemPrompt = validateAgentsMd(systemPromptRaw);
  const skills = validateSkillList(skillsRaw);
  const skillIndex = formatSkillIndex(skills);
  return { systemPrompt, skillIndex, skills };
}

function resourceShapeError(method: string, expected: string, received: unknown): AgentWorkerError {
  const actual = Array.isArray(received) ? "array" : typeof received;
  return new AgentWorkerError(
    "resource_loading",
    `${method} returned invalid resource shape: expected ${expected}, received ${actual}`
  );
}

function validateAgentsMd(value: unknown): string {
  if (typeof value !== "string") {
    throw resourceShapeError("workspace.getAgentsMd", "a string", value);
  }
  return value;
}

function validateSkillList(value: unknown): SkillEntry[] {
  if (!Array.isArray(value)) {
    throw resourceShapeError("workspace.listSkills", "an array of skill descriptors", value);
  }
  return value.map((entry, index) => validateSkillEntry(entry, index));
}

function validateSkillEntry(value: unknown, index: number): SkillEntry {
  if (!value || typeof value !== "object") {
    throw resourceShapeError(`workspace.listSkills[${index}]`, "a skill descriptor object", value);
  }
  const record = value as Record<string, unknown>;
  const name = record["name"];
  const description = record["description"];
  const dirPath = record["dirPath"];
  const skillPath = record["skillPath"];
  if (typeof name !== "string" || typeof description !== "string" || typeof dirPath !== "string") {
    throw resourceShapeError(
      `workspace.listSkills[${index}]`,
      "{ name: string, description: string, dirPath: string, skillPath?: string }",
      value
    );
  }
  if (skillPath !== undefined && typeof skillPath !== "string") {
    throw resourceShapeError(
      `workspace.listSkills[${index}]`,
      "{ name: string, description: string, dirPath: string, skillPath?: string }",
      value
    );
  }
  return { name, description, dirPath, skillPath: skillPath ?? `${dirPath}/SKILL.md` };
}

function callWorkspace<T>(deps: ResourceLoaderDeps, method: string): Promise<T> {
  if (deps.signal) return deps.rpc.call<T>("main", method, [], { signal: deps.signal });
  return deps.rpc.call<T>("main", method, []);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw createAbortError(signal);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(createAbortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}

function createAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" ? reason : "Resource loading aborted");
  err.name = "AbortError";
  return err;
}
/**
 * Renders the skill index as a markdown section. Returns an empty string
 * when there are no skills (so the caller can simply concatenate it with
 * the system prompt without conditional logic).
 */
export function formatSkillIndex(skills: SkillEntry[]): string {
  if (skills.length === 0) return "";
  const lines: string[] = ["", "## Available skills", ""];
  for (const s of skills) {
    lines.push(`- **${s.name}** (${s.dirPath}) \u2014 ${s.description}`);
  }
  lines.push("");
  lines.push(
    'Use the read tool to load a skill: `read("<dirPath>/SKILL.md")` using the path shown next to each skill.'
  );
  lines.push(
    "Before acting, read every skill whose description clearly matches the task. A broad neighboring skill does not replace a more specific matching skill; when several match, use all of them."
  );
  lines.push("(Skill files are available in the per-context folder under their repo paths.)");
  lines.push("");
  lines.push(
    "To discover callable services and runtime APIs with typed schemas and access rules, use the `docs_search` and `docs_open` tools (results are filtered to what you can call)."
  );
  return lines.join("\n");
}
