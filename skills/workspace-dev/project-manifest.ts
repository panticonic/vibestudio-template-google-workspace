import { parseUnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import {
  analyzeModuleImports,
  definitelyTypedCoordinate,
  moduleCoordinate,
  type ModuleImportKind,
  type ModuleImportSyntax,
} from "@vibestudio/module-imports";
import { parse as parseSvelte } from "svelte/compiler";

export const PROJECT_TYPES = ["panel", "package", "skill", "project", "worker"] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export interface ProjectPreflightReport {
  ok: true;
  /** Mutation-free validation of the planned repository, before an exact-state build exists. */
  scope: "planned-repository";
  /** Semantic build/authority validation is performed by the protected publication gate. */
  semanticBuildGate: "pending-publication";
  projectType: ProjectType;
  packageName: string | null;
  entry: string | null;
  authorityRequestCount: number;
  importedPackages: string[];
  checked: string[];
}

export interface ProjectDependencyOccurrence {
  file: string;
  specifier: string;
  kind: ModuleImportKind;
  syntax: ModuleImportSyntax;
  line: number;
  column: number;
}

export interface ProjectDependencyIssue {
  code: "dependency_missing" | "dependency_wrong_field";
  coordinate: string;
  expectedField: "dependencies" | "devDependencies";
  declaredField: "devDependencies" | null;
  acceptedCoordinates: string[];
  occurrences: ProjectDependencyOccurrence[];
  remediation: string;
}

export interface ProjectPreflightFailureData {
  code: "project_preflight_failed";
  stage: "dependency-contract";
  projectType: ProjectType;
  projectName: string;
  packageName: string;
  issues: ProjectDependencyIssue[];
}

export class ProjectPreflightError extends Error {
  readonly errorData: ProjectPreflightFailureData;

  constructor(errorData: ProjectPreflightFailureData) {
    const details = errorData.issues
      .map((issue) => {
        const first = issue.occurrences[0]!;
        return `${issue.coordinate} at ${first.file}:${first.line}:${first.column} -> ${issue.expectedField}`;
      })
      .join("; ");
    super(`Project dependency contract failed: ${details}`);
    this.name = "ProjectPreflightError";
    this.errorData = errorData;
  }
}

export interface BuildProjectManifestInput {
  projectType: Exclude<ProjectType, "project">;
  name: string;
  title: string;
  icon?: string;
  entry?: string;
  template?: string;
  exports?: Record<string, string>;
  exposeModules?: string[];
  durableClasses?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const PACKAGE_SCOPES: Record<Exclude<ProjectType, "project">, string> = {
  panel: "@workspace-panels",
  package: "@workspace",
  skill: "@workspace-skills",
  worker: "@workspace-workers",
};

const EXECUTABLE_BASELINE_AUTHORITY = [
  {
    capability: "context.boundary",
    resource: { kind: "prefix", prefix: "context" },
    tier: "critical",
    evidence: "bounded-dynamic",
  },
] as const;

function assertProjectName(name: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(
      `Project name ${JSON.stringify(name)} is invalid. Use a stable kebab-case identifier matching ` +
        "`^[a-z][a-z0-9-]*$`, for example `todo-list` or " +
        "`todo-list-${Date.now().toString(36)}`. Raw ISO timestamps are invalid because they contain uppercase letters and punctuation."
    );
  }
}

export function assertProjectIdentity(name: string, title: string): void {
  assertProjectName(name);
  if (!title.trim() || /[`\\\r\n"<>{}&*]|\$\{/.test(title)) {
    throw new Error(
      'Project title must be a single non-empty line without code or markup delimiters such as ", <, {, *, backticks, or backslashes.'
    );
  }
}

function canonicalRecord<T>(value: Record<string, T> | undefined): Record<string, T> | undefined {
  if (!value) return undefined;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
  );
}

/** Build the one canonical package manifest shape used by every scaffold template. */
export function buildProjectManifest(input: BuildProjectManifestInput): Record<string, unknown> {
  assertProjectIdentity(input.name, input.title);
  const executable = input.projectType === "panel" || input.projectType === "worker";
  const testRuntime =
    input.projectType === "panel" ? "browser" : input.projectType === "worker" ? "workerd" : null;
  if (executable && !input.entry) {
    throw new Error(`${input.projectType} manifests require an explicit entry`);
  }
  if (!executable && input.entry) {
    throw new Error(`${input.projectType} manifests cannot declare a Vibestudio entry`);
  }
  const manifest: Record<string, unknown> = {
    name: `${PACKAGE_SCOPES[input.projectType]}/${input.name}`,
    version: "0.1.0",
    private: true,
    type: "module",
  };
  if (input.exports) manifest["exports"] = canonicalRecord(input.exports);
  if (executable) {
    manifest["vibestudio"] = {
      title: input.title,
      icon: input.icon ?? (input.projectType === "panel" ? "🧩" : "⚙️"),
      entry: input.entry,
      ...(input.exposeModules ? { exposeModules: [...input.exposeModules] } : {}),
      authority: { requests: EXECUTABLE_BASELINE_AUTHORITY, provides: [] },
      ...(input.template ? { template: input.template } : {}),
      ...(input.durableClasses
        ? {
            durable: {
              classes: input.durableClasses.map((className) => ({ className })),
            },
          }
        : {}),
      tests: [
        {
          name: "unit",
          runtime: testRuntime,
          include: ["**/*.test.ts", "**/*.test.tsx"],
        },
      ],
    };
  }
  if (input.dependencies || testRuntime) {
    manifest["dependencies"] = canonicalRecord({
      ...(input.dependencies ?? {}),
      ...(testRuntime === "browser" ? { "@workspace/runtime": "workspace:*" } : {}),
      ...(testRuntime ? { "@workspace/test-runtime": "workspace:*" } : {}),
    });
  }
  if (input.devDependencies) manifest["devDependencies"] = canonicalRecord(input.devDependencies);
  return manifest;
}

export function serializeProjectManifest(input: BuildProjectManifestInput): string {
  return `${JSON.stringify(buildProjectManifest(input), null, 2)}\n`;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseManifest(source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `package.json must be valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return asRecord(parsed, "package.json");
}

function dependencyOccurrences(
  files: Readonly<Record<string, string | Uint8Array>>
): Array<ProjectDependencyOccurrence & { coordinate: string; testOnly: boolean }> {
  const imports: Array<ProjectDependencyOccurrence & { coordinate: string; testOnly: boolean }> =
    [];
  for (const [path, content] of Object.entries(files)) {
    if (content instanceof Uint8Array || path === "package.json") continue;
    let moduleSource: string;
    if (/\.[cm]?[jt]sx?$/iu.test(path)) {
      moduleSource = content;
    } else if (/\.svelte$/iu.test(path)) {
      const component = parseSvelte(content, { modern: true });
      // Preserve original offsets and line breaks while exposing only
      // grammar-owned script regions to the TypeScript/JSX parser.
      const characters: string[] = content
        .split("")
        .map((character) => (character === "\n" || character === "\r" ? character : " "));
      for (const script of [component.module, component.instance]) {
        const program = script?.content as { start: number; end: number } | undefined;
        if (!program) continue;
        for (let index = program.start; index < program.end; index++) {
          characters[index] = content.charAt(index);
        }
      }
      moduleSource = characters.join("");
    } else {
      continue;
    }
    const testOnly = /(^|\/)(?:__tests__\/|[^/]+\.(?:test|spec)\.[^/]+$)/.test(path);
    for (const reference of analyzeModuleImports(moduleSource)) {
      const coordinate = moduleCoordinate(reference.specifier);
      if (!coordinate) continue;
      imports.push({
        file: path,
        specifier: reference.specifier,
        coordinate,
        testOnly,
        kind: reference.kind,
        syntax: reference.syntax,
        line: reference.line,
        column: reference.column,
      });
    }
  }
  return imports;
}

/**
 * Validate the complete planned repository before any VCS edit occurs.
 * Forks and fresh templates intentionally share this exact gate.
 */
export function preflightProjectFiles(input: {
  projectType: ProjectType;
  name: string;
  files: Readonly<Record<string, string | Uint8Array>>;
}): ProjectPreflightReport {
  assertProjectName(input.name);
  const checked = ["canonical project type", "non-empty repository"];
  if (!PROJECT_TYPES.includes(input.projectType)) {
    throw new Error(`Unknown project type ${JSON.stringify(input.projectType)}`);
  }
  if (Object.keys(input.files).length === 0) {
    throw new Error("A project repository must contain at least one file");
  }
  if (input.projectType === "project") {
    return {
      ok: true,
      scope: "planned-repository",
      semanticBuildGate: "pending-publication",
      projectType: input.projectType,
      packageName: null,
      entry: null,
      authorityRequestCount: 0,
      importedPackages: [],
      checked,
    };
  }

  const packageSource = input.files["package.json"];
  if (typeof packageSource !== "string") {
    throw new Error(`${input.projectType} repositories require a textual package.json`);
  }
  const manifest = parseManifest(packageSource);
  const expectedName = `${PACKAGE_SCOPES[input.projectType]}/${input.name}`;
  if (manifest["name"] !== expectedName) {
    throw new Error(`package.json name must be ${expectedName}`);
  }
  if (manifest["private"] !== true || manifest["type"] !== "module") {
    throw new Error("package.json must declare private: true and type: module");
  }
  checked.push("package identity");

  let entry: string | null = null;
  let authorityRequestCount = 0;
  if (input.projectType === "panel" || input.projectType === "worker") {
    const vibestudio = asRecord(manifest["vibestudio"], "package.json vibestudio");
    if (input.projectType === "panel" && typeof vibestudio["title"] !== "string") {
      throw new Error("Panel package.json must declare a Vibestudio title");
    }
    if (typeof vibestudio["title"] === "string") {
      assertProjectIdentity(input.name, vibestudio["title"]);
    }
    entry = typeof vibestudio["entry"] === "string" ? vibestudio["entry"] : null;
    if (!entry || !(entry in input.files)) {
      throw new Error(`${input.projectType} entry must name a file in the planned repository`);
    }
    authorityRequestCount = parseUnitAuthorityManifest(
      vibestudio["authority"],
      `${expectedName} vibestudio.authority`
    ).requests.length;
    checked.push("executable entry", "authority manifest syntax");
  } else if (manifest["exports"] === undefined) {
    throw new Error(`${input.projectType} package.json must declare exports`);
  }

  if (input.projectType === "skill" && typeof input.files["SKILL.md"] !== "string") {
    throw new Error("Skill repositories require a textual SKILL.md");
  }
  if (input.projectType === "skill") checked.push("skill instructions");

  const occurrences = dependencyOccurrences(input.files).filter(
    (occurrence) => occurrence.coordinate !== expectedName
  );
  const imports = [...new Set(occurrences.map((occurrence) => occurrence.coordinate))].sort();
  const dependencies =
    manifest["dependencies"] === undefined
      ? {}
      : asRecord(manifest["dependencies"], "package.json dependencies");
  const devDependencies =
    manifest["devDependencies"] === undefined
      ? {}
      : asRecord(manifest["devDependencies"], "package.json devDependencies");
  const peerDependencies =
    manifest["peerDependencies"] === undefined
      ? {}
      : asRecord(manifest["peerDependencies"], "package.json peerDependencies");
  const issues = new Map<string, ProjectDependencyIssue>();
  for (const occurrence of occurrences) {
    const expectedField =
      occurrence.testOnly || occurrence.kind === "type" ? "devDependencies" : "dependencies";
    const acceptedCoordinates = [
      occurrence.coordinate,
      ...(occurrence.kind === "type" ? [definitelyTypedCoordinate(occurrence.coordinate)] : []),
    ];
    const productionDeclared = acceptedCoordinates.some(
      (coordinate) => coordinate in dependencies || coordinate in peerDependencies
    );
    const developmentDeclared = acceptedCoordinates.some(
      (coordinate) => coordinate in devDependencies
    );
    if (
      productionDeclared ||
      ((occurrence.testOnly || occurrence.kind === "type") && developmentDeclared)
    ) {
      continue;
    }

    const code =
      expectedField === "dependencies" && developmentDeclared
        ? "dependency_wrong_field"
        : "dependency_missing";
    const key = `${code}:${expectedField}:${occurrence.coordinate}`;
    const existing = issues.get(key);
    const detail: ProjectDependencyOccurrence = {
      file: occurrence.file,
      specifier: occurrence.specifier,
      kind: occurrence.kind,
      syntax: occurrence.syntax,
      line: occurrence.line,
      column: occurrence.column,
    };
    if (existing) {
      existing.occurrences.push(detail);
      continue;
    }
    issues.set(key, {
      code,
      coordinate: occurrence.coordinate,
      expectedField,
      declaredField: developmentDeclared ? "devDependencies" : null,
      acceptedCoordinates,
      occurrences: [detail],
      remediation:
        code === "dependency_wrong_field"
          ? `Move ${occurrence.coordinate} from devDependencies to dependencies because production source imports it.`
          : `Declare ${occurrence.coordinate} in ${expectedField}. Internal workspace packages must use workspace:*.`,
    });
  }
  if (issues.size > 0) {
    throw new ProjectPreflightError({
      code: "project_preflight_failed",
      stage: "dependency-contract",
      projectType: input.projectType,
      projectName: input.name,
      packageName: expectedName,
      issues: [...issues.values()],
    });
  }
  checked.push("module dependency contract");

  return {
    ok: true,
    scope: "planned-repository",
    semanticBuildGate: "pending-publication",
    projectType: input.projectType,
    packageName: expectedName,
    entry,
    authorityRequestCount,
    importedPackages: imports,
    checked,
  };
}
