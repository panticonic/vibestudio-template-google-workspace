import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorityReviewFromPackageJson } from "@vibestudio/unit-host";

const mocks = vi.hoisted(() => {
  const files = new Map<string, string | Uint8Array>();
  const dirs = new Set<string>();
  const status = vi.fn();
  const edit = vi.fn();
  const commit = vi.fn();
  const push = vi.fn();
  return { files, dirs, status, edit, commit, push };
});

function normalize(p: string): string {
  return p.replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
}

function addDir(p: string): void {
  const normalized = normalize(p);
  if (!normalized) return;
  const parts = normalized.split("/");
  for (let i = 1; i <= parts.length; i++)
    mocks.dirs.add(parts.slice(0, i).join("/"));
}

function addFile(p: string, content: string | Uint8Array): void {
  const normalized = normalize(p);
  const parent = normalized.split("/").slice(0, -1).join("/");
  addDir(parent);
  mocks.files.set(normalized, content);
}

vi.mock("@workspace/runtime", () => ({
  vcs: {
    status: mocks.status,
    edit: mocks.edit,
    commit: mocks.commit,
    push: mocks.push,
  },
  contextId: "ctx:test",
  fs: {
    async exists(p: string): Promise<boolean> {
      const normalized = normalize(p);
      return mocks.files.has(normalized) || mocks.dirs.has(normalized);
    },
    async readdir(
      p: string,
      opts?: { withFileTypes?: boolean },
    ): Promise<string[] | Array<{ name: string; isDirectory(): boolean }>> {
      const normalized = normalize(p);
      const prefix = normalized ? `${normalized}/` : "";
      const names = new Map<string, boolean>();
      for (const file of mocks.files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const [name, ...tail] = rest.split("/");
        names.set(name!, tail.length > 0);
      }
      for (const dir of mocks.dirs) {
        if (!dir.startsWith(prefix) || dir === normalized) continue;
        const rest = dir.slice(prefix.length);
        const [name, ...tail] = rest.split("/");
        names.set(name!, tail.length > 0 || mocks.dirs.has(`${prefix}${name}`));
      }
      if (opts?.withFileTypes) {
        return [...names].map(([name, isDir]) => ({
          name,
          isDirectory: () => isDir,
        }));
      }
      return [...names.keys()];
    },
    async readFile(p: string, encoding?: string): Promise<string | Uint8Array> {
      const content = mocks.files.get(normalize(p));
      if (content === undefined)
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (encoding && content instanceof Uint8Array)
        return new TextDecoder().decode(content);
      return content;
    },
    async mkdir(p: string): Promise<void> {
      addDir(p);
    },
    async writeFile(p: string, content: string | Uint8Array): Promise<void> {
      addFile(p, content);
    },
  },
}));

function resetRuntimeMocks(): void {
  mocks.files.clear();
  mocks.dirs.clear();
  mocks.status.mockReset();
  mocks.edit.mockReset();
  mocks.commit.mockReset();
  mocks.push.mockReset();
  mocks.status.mockResolvedValue({
    contextId: "ctx:test",
    committed: { kind: "event", eventId: "event:committed" },
    workingHead: { kind: "application", applicationId: "application:working" },
    clean: false,
    mainEventId: "event:main",
    mainRelation: "ahead",
    workingCounts: { applications: 1, workUnits: 0, changes: 0 },
    integrating: [],
  });
  mocks.edit.mockImplementation(
    async (input: {
      changes: Array<{
        kind: string;
        repoPath: string;
        files: Array<{
          path: string;
          content:
            | { kind: "text"; text: string }
            | { kind: "bytes"; base64: string };
        }>;
      }>;
    }) => {
      for (const change of input.changes) {
        for (const file of change.files) {
          addFile(
            `${change.repoPath}/${file.path}`,
            file.content.kind === "text"
              ? file.content.text
              : Uint8Array.from(atob(file.content.base64), (character) =>
                  character.charCodeAt(0),
                ),
          );
        }
      }
      return {
        workingHead: {
          kind: "application",
          applicationId: "application:created",
        },
      };
    },
  );
  mocks.commit.mockResolvedValue({
    event: { kind: "event", eventId: "event:committed" },
  });
  mocks.push.mockResolvedValue({
    contextId: "ctx:test",
    eventId: "event:committed",
    mainEventId: "event:committed",
    effectId: "effect:published",
    appliedAt: "2026-07-24T00:00:00.000Z",
  });
}

describe("createProjects", () => {
  beforeEach(resetRuntimeMocks);

  it("scaffolds a plain project as a content repo under projects/", async () => {
    const { createProjects } = await import("./create-project.js");

    const [result] = await createProjects([
      {
        projectType: "project",
        name: "scratch-notes",
        title: "Scratch Notes",
      },
    ]);

    expect(result).toMatchObject({
      created: "projects/scratch-notes",
      files: ["README.md"],
      preflight: {
        ok: true,
        scope: "planned-repository",
        semanticBuildGate: "pending-publication",
        projectType: "project",
      },
      publication: {
        published: true,
        committedEventId: "event:committed",
        publishedEventId: "event:committed",
        mainEventId: "event:committed",
        effectId: "effect:published",
        appliedAt: "2026-07-24T00:00:00.000Z",
      },
    });
    expect(mocks.files.get("projects/scratch-notes/README.md")).toBe(
      "# Scratch Notes\n\nPlain workspace project.\n",
    );
    expect(mocks.files.has("projects/scratch-notes/package.json")).toBe(false);
    expect(mocks.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedWorkingHead: {
          kind: "application",
          applicationId: "application:created",
        },
      }),
    );
    expect(mocks.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedWorkingHead: {
          kind: "application",
          applicationId: "application:working",
        },
        changes: [
          expect.objectContaining({
            kind: "repository-create",
            repoPath: "projects/scratch-notes",
          }),
        ],
      }),
    );
    expect(mocks.push).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedCommittedEventId: "event:committed",
        expectedMainEventId: "event:main",
      }),
    );
  });

  it("rejects removed agent scaffolding", async () => {
    const { createProjects } = await import("./create-project.js");

    await expect(
      createProjects([{ projectType: "agent", name: "helper" }]),
    ).rejects.toThrow(/panel, package, skill, project, worker/);
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("declares the generated panel entry explicitly", async () => {
    const { createProjects } = await import("./create-project.js");

    await createProjects([
      { projectType: "panel", name: "hello", title: "Hello" },
    ]);

    expect(
      JSON.parse(mocks.files.get("panels/hello/package.json") as string),
    ).toMatchObject({
      vibestudio: {
        title: "Hello",
        entry: "index.tsx",
        authority: {
          requests: [
            {
              capability: "context.boundary",
              resource: { kind: "prefix", prefix: "context" },
              tier: "critical",
              evidence: "bounded-dynamic",
            },
          ],
          provides: [],
        },
        exposeModules: expect.arrayContaining(["react", "react/jsx-runtime"]),
      },
    });
  });

  it("materializes a curated Lucide identity without adding an icon runtime", async () => {
    addFile(
      "skills/workspace-dev/assets/icons/lucide/messages-square.svg",
      '<svg stroke="currentColor"><path d="M1 1" /></svg>',
    );
    const { createProjects } = await import("./create-project.js");

    await createProjects([
      {
        projectType: "panel",
        name: "inbox",
        title: "Inbox",
        icon: "lucide:messages-square",
      },
    ]);

    expect(
      JSON.parse(mocks.files.get("panels/inbox/package.json") as string),
    ).toMatchObject({
      vibestudio: { icon: "./assets/icon.svg" },
    });
    expect(mocks.files.get("panels/inbox/assets/icon.svg")).toBe(
      '<svg stroke="#8B5CF6"><path d="M1 1" /></svg>',
    );
  });

  it("discovers the exact curated icon catalog instead of requiring guessed names", async () => {
    addFile("skills/workspace-dev/assets/icons/lucide/database.svg", "<svg />");
    addFile(
      "skills/workspace-dev/assets/icons/lucide/messages-square.svg",
      "<svg />",
    );
    for (const name of [
      "claude",
      "git",
      "gmail",
      "gnubash",
      "javascript",
      "react",
      "svelte",
      "typescript",
    ]) {
      addFile(
        `skills/workspace-dev/assets/icons/brands/${name}.svg`,
        "<svg />",
      );
    }
    const { listProjectIcons, searchProjectCatalog } =
      await import("./create-project.js");

    await expect(listProjectIcons()).resolves.toEqual([
      "brand:claude",
      "brand:git",
      "brand:gmail",
      "brand:gnubash",
      "brand:javascript",
      "brand:react",
      "brand:svelte",
      "brand:typescript",
      "lucide:database",
      "lucide:messages-square",
    ]);
    await expect(
      searchProjectCatalog({
        resource: "icon",
        query: "message square",
        limit: 1,
      }),
    ).resolves.toMatchObject({
      protocol: "workspace-dev-catalog.v1",
      resource: "icon",
      query: "message square",
      total: 10,
      entries: [
        { resource: "icon", id: "lucide:messages-square", family: "lucide" },
      ],
      truncated: 9,
    });
  });

  it("returns a structured catalog repair plan before creating an unknown icon", async () => {
    addFile("skills/workspace-dev/assets/icons/lucide/database.svg", "<svg />");
    const { createProjects, ProjectIconError } =
      await import("./create-project.js");

    const failure = await createProjects([
      { projectType: "panel", name: "board", icon: "lucide:columns-3" },
    ]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProjectIconError);
    expect(
      (failure as InstanceType<typeof ProjectIconError>).errorData,
    ).toEqual({
      code: "project_icon_invalid",
      icon: "lucide:columns-3",
      kind: "lucide",
      name: "columns-3",
      suggestions: ["lucide:database"],
      catalogQuery: {
        resource: "icon",
        query: "columns-3",
        families: ["lucide"],
        limit: 12,
      },
      catalog: {
        protocol: "workspace-dev-catalog.v1",
        resource: "icon",
        query: "columns-3",
        total: 1,
        entries: [
          {
            resource: "icon",
            id: "lucide:database",
            family: "lucide",
            name: "database",
          },
        ],
        truncated: 0,
      },
      recovery: {
        action: "correct-request",
        instruction: expect.stringContaining("errorData.catalog.entries"),
      },
    });
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("keeps the built-in default panel deterministic without consulting template files", async () => {
    addFile(
      "templates/default/template.json",
      JSON.stringify({ framework: "svelte" }),
    );
    const { createProjects } = await import("./create-project.js");

    await createProjects([
      { projectType: "panel", name: "default-panel", title: "Default Panel" },
    ]);

    expect(mocks.files.has("panels/default-panel/index.tsx")).toBe(true);
    expect(mocks.files.has("panels/default-panel/App.svelte")).toBe(false);
  });

  it("generates every executable template with a publication-valid authority contract", async () => {
    addFile(
      "templates/svelte/template.json",
      JSON.stringify({ framework: "svelte" }),
    );
    const { createProjects } = await import("./create-project.js");

    await createProjects([
      { projectType: "panel", name: "react-panel", title: "React Panel" },
    ]);
    await createProjects([
      {
        projectType: "panel",
        name: "svelte-panel",
        title: "Svelte Panel",
        template: "svelte",
      },
    ]);
    await createProjects([
      { projectType: "worker", name: "plain-worker", title: "Plain Worker" },
    ]);
    await createProjects([
      {
        projectType: "worker",
        name: "durable-worker",
        title: "Durable Worker",
        template: "durable-service",
      },
    ]);
    await createProjects([
      {
        projectType: "worker",
        name: "agent-worker",
        title: "Agent Worker",
        template: "agentic",
      },
    ]);

    for (const [path, packageName] of [
      ["panels/react-panel/package.json", "@workspace-panels/react-panel"],
      ["panels/svelte-panel/package.json", "@workspace-panels/svelte-panel"],
      ["workers/plain-worker/package.json", "@workspace-workers/plain-worker"],
      [
        "workers/durable-worker/package.json",
        "@workspace-workers/durable-worker",
      ],
      ["workers/agent-worker/package.json", "@workspace-workers/agent-worker"],
    ] as const) {
      const source = mocks.files.get(path);
      expect(typeof source).toBe("string");
      expect(
        authorityReviewFromPackageJson(source as string, packageName).requests,
      ).toEqual([expect.objectContaining({ capability: "context.boundary" })]);
    }
    const durableManifest = JSON.parse(
      mocks.files.get("workers/durable-worker/package.json") as string,
    );
    expect(durableManifest.vibestudio.durable.classes).toEqual([
      { className: "DurableWorker" },
    ]);
    expect(durableManifest.vibestudio.durable.classes[0]).not.toHaveProperty(
      "rpcSchema",
    );
    expect(mocks.files.get("workers/durable-worker/index.ts")).toContain(
      'from "@workspace/runtime/worker/kernel"',
    );
  });

  it("keeps the default panel at baseline authority instead of exposing the runtime umbrella", async () => {
    const { createProjects } = await import("./create-project.js");

    await createProjects([
      { projectType: "panel", name: "minimal", title: "Minimal" },
    ]);

    const manifest = JSON.parse(
      mocks.files.get("panels/minimal/package.json") as string,
    );
    expect(manifest.dependencies).toEqual({
      "@workspace/runtime": "workspace:*",
      "@workspace/test-runtime": "workspace:*",
      react: "19.2.4",
      "react-dom": "19.2.4",
    });
    expect(manifest.vibestudio.exposeModules).toEqual([
      "react",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
    ]);
    expect(mocks.files.get("panels/minimal/index.tsx")).not.toMatch(
      /@workspace\/(?:runtime|react|ui)/u,
    );
  });

  it("rejects names and titles that would produce invalid generated source", async () => {
    const { createProjects } = await import("./create-project.js");

    await expect(
      createProjects([{ projectType: "panel", name: "Bad Name" }]),
    ).rejects.toThrow(/Project name/);
    await expect(
      createProjects([
        { projectType: "panel", name: "valid-name", title: 'Broken " title' },
      ]),
    ).rejects.toThrow(/Project title/);
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("does not report a scaffold as published when protected publication is refused", async () => {
    mocks.push.mockRejectedValueOnce(
      Object.assign(new Error("Protected publication is not authorized"), {
        errorData: {
          code: "Unauthorized",
          operation: "vcs.push",
          authorityFailure: { reasonCode: "missing-grant" },
        },
      }),
    );
    const { createProjects, ScaffoldPublicationError } =
      await import("./create-project.js");

    const failure = await createProjects([
      { projectType: "panel", name: "broken" },
    ]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ScaffoldPublicationError);
    expect(
      (failure as InstanceType<typeof ScaffoldPublicationError>).errorData,
    ).toMatchObject({
      code: "scaffold_publication_failed",
      stage: "push",
      created: "panels/broken",
      files: ["panels/broken/index.tsx", "panels/broken/package.json"],
      committedEventId: "event:committed",
      published: false,
      publicationRequest: {
        contextId: "ctx:test",
        expectedCommittedEventId: "event:committed",
        expectedMainEventId: "event:main",
        commandId: expect.stringContaining("workspace-dev:publish:ctx:test:"),
      },
      vcsError: {
        code: "Unauthorized",
        message: "Protected publication is not authorized",
        errorData: {
          code: "Unauthorized",
          operation: "vcs.push",
          authorityFailure: { reasonCode: "missing-grant" },
        },
      },
      retry: {
        operation: "vcs.push",
        statusRequest: { contextId: "ctx:test" },
        commandIdPolicy: "reobserve-status-and-use-new-command",
      },
    });
  });

  it("recovers an uncertain publication by replaying the exact push command and receipt", async () => {
    mocks.push.mockRejectedValueOnce(
      Object.assign(new Error("Host response was lost"), {
        errorData: {
          code: "ExternalEffectFailed",
          effectId: "effect:uncertain",
        },
      }),
    );
    const {
      createProjects,
      recoverProjectPublication,
      ScaffoldPublicationError,
    } = await import("./create-project.js");
    const failure = await createProjects([
      {
        projectType: "panel",
        name: "recoverable",
      },
    ]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ScaffoldPublicationError);
    const typedFailure = failure as InstanceType<
      typeof ScaffoldPublicationError
    >;
    const originalRequest = typedFailure.errorData.publicationRequest;
    mocks.status.mockResolvedValueOnce({
      contextId: "ctx:test",
      committed: { kind: "event", eventId: "event:committed" },
      workingHead: { kind: "event", eventId: "event:committed" },
      clean: true,
      mainEventId: "event:main",
      mainRelation: "ahead",
      workingCounts: { applications: 0, workUnits: 0, changes: 0 },
      integrating: [],
    });

    await expect(recoverProjectPublication(typedFailure)).resolves.toEqual({
      published: true,
      committedEventId: "event:committed",
      publishedEventId: "event:committed",
      mainEventId: "event:committed",
      effectId: "effect:published",
      appliedAt: "2026-07-24T00:00:00.000Z",
    });
    expect(mocks.push).toHaveBeenLastCalledWith(originalRequest);
    expect(mocks.edit).toHaveBeenCalledTimes(1);
    expect(mocks.commit).toHaveBeenCalledTimes(1);
  });

  it("reobserves after a known refusal and uses a fresh command identity", async () => {
    mocks.push.mockRejectedValueOnce(
      Object.assign(new Error("Main advanced"), {
        errorData: { code: "RevisionChanged" },
      }),
    );
    const {
      createProjects,
      recoverProjectPublication,
      ScaffoldPublicationError,
    } = await import("./create-project.js");
    const failure = (await createProjects([
      {
        projectType: "panel",
        name: "reobserved",
      },
    ]).catch((error: unknown) => error)) as InstanceType<
      typeof ScaffoldPublicationError
    >;
    mocks.status.mockResolvedValueOnce({
      contextId: "ctx:test",
      committed: { kind: "event", eventId: "event:committed" },
      workingHead: { kind: "event", eventId: "event:committed" },
      clean: true,
      mainEventId: "event:new-main",
      mainRelation: "ahead",
      workingCounts: { applications: 0, workUnits: 0, changes: 0 },
      integrating: [],
    });

    await recoverProjectPublication(failure);

    const recoveredRequest = mocks.push.mock.calls.at(-1)?.[0];
    expect(recoveredRequest).toMatchObject({
      expectedCommittedEventId: "event:committed",
      expectedMainEventId: "event:new-main",
      commandId: expect.stringContaining(
        "workspace-dev:recover-publication:ctx:test:",
      ),
    });
    expect(recoveredRequest.commandId).not.toBe(
      failure.errorData.publicationRequest.commandId,
    );
  });

  it("refuses to retry a source-invalid scaffold commit", async () => {
    mocks.push.mockRejectedValueOnce(
      Object.assign(new Error("Build gate failed"), {
        errorData: {
          code: "BuildGateFailed",
          diagnostics: [{ source: "tsc", message: "index.tsx is invalid" }],
        },
      }),
    );
    const {
      createProjects,
      recoverProjectPublication,
      ScaffoldPublicationError,
    } = await import("./create-project.js");
    const failure = (await createProjects([
      {
        projectType: "panel",
        name: "source-invalid",
      },
    ]).catch((error: unknown) => error)) as InstanceType<
      typeof ScaffoldPublicationError
    >;

    expect(failure.errorData.retry.commandIdPolicy).toBe(
      "repair-source-and-recommit",
    );
    expect(failure.errorData.recovery).toEqual({
      action: "repair-source",
      instruction: expect.stringContaining("repair the committed source"),
    });
    await expect(recoverProjectPublication(failure)).rejects.toMatchObject({
      errorData: {
        stage: "repair-source",
        cause: { code: "BuildGateFailed" },
        retry: { safeToRerun: false },
      },
    });
    expect(mocks.status).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });

  it("refuses recovery when the context no longer points exactly at the scaffold commit", async () => {
    mocks.push.mockRejectedValueOnce(
      Object.assign(new Error("Main advanced"), {
        errorData: { code: "RevisionChanged" },
      }),
    );
    const {
      createProjects,
      recoverProjectPublication,
      ScaffoldPublicationRecoveryError,
    } = await import("./create-project.js");
    const failure = await createProjects([
      {
        projectType: "panel",
        name: "changed",
      },
    ]).catch((error: unknown) => error);
    mocks.status.mockResolvedValueOnce({
      contextId: "ctx:test",
      committed: { kind: "event", eventId: "event:committed" },
      workingHead: { kind: "application", applicationId: "application:later" },
      clean: false,
      mainEventId: "event:new-main",
      mainRelation: "diverged",
      workingCounts: { applications: 1, workUnits: 1, changes: 1 },
      integrating: [],
    });

    await expect(
      recoverProjectPublication(
        failure as Parameters<typeof recoverProjectPublication>[0],
      ),
    ).rejects.toMatchObject({
      constructor: ScaffoldPublicationRecoveryError,
      errorData: {
        stage: "validate-context",
        cause: { code: "ContextChanged" },
        retry: { safeToRerun: false },
      },
    });
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });

  it("stops automatic recovery when the publication receipt fails integrity validation", async () => {
    mocks.push.mockResolvedValueOnce({
      eventId: "event:different",
      mainEventId: "event:different",
      effectId: "effect:invalid",
      appliedAt: "2026-07-24T00:00:00.000Z",
    });
    const {
      createProjects,
      recoverProjectPublication,
      ScaffoldPublicationError,
      ScaffoldPublicationRecoveryError,
    } = await import("./create-project.js");
    const failure = await createProjects([
      {
        projectType: "panel",
        name: "invalid-receipt",
      },
    ]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ScaffoldPublicationError);
    expect(
      (failure as InstanceType<typeof ScaffoldPublicationError>).errorData.retry
        .commandIdPolicy,
    ).toBe("stop-integrity-investigation");
    await expect(
      recoverProjectPublication(
        failure as Parameters<typeof recoverProjectPublication>[0],
      ),
    ).rejects.toBeInstanceOf(ScaffoldPublicationRecoveryError);
    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(mocks.status).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid executable manifest before the first VCS edit", async () => {
    const { preflightProjectFiles } = await import("./project-manifest.js");

    expect(() =>
      preflightProjectFiles({
        projectType: "panel",
        name: "invalid",
        files: {
          "package.json": JSON.stringify({
            name: "@workspace-panels/invalid",
            private: true,
            type: "module",
            vibestudio: { title: "Invalid", entry: "index.tsx" },
          }),
          "index.tsx": "export default function Invalid() { return null; }\n",
        },
      }),
    ).toThrow(/authority/);
    expect(mocks.edit).not.toHaveBeenCalled();
  });

  it("returns the exact invalid project name and a valid generated-name recipe", async () => {
    const { createProjects } = await import("./create-project.js");

    await expect(
      createProjects([
        {
          projectType: "panel",
          name: "todo-2026-07-24T20:30:00.000Z",
        },
      ]),
    ).rejects.toThrow(
      /Project name "todo-2026-07-24T20:30:00\.000Z" is invalid.*Date\.now\(\)\.toString\(36\).*Raw ISO timestamps/u,
    );
    expect(mocks.edit).not.toHaveBeenCalled();
  });
});

describe("forkProject", () => {
  beforeEach(resetRuntimeMocks);

  it("does not report a fork as committed when protected publication is refused", async () => {
    addFile(
      "packages/source/package.json",
      JSON.stringify({
        name: "@workspace/source",
        private: true,
        type: "module",
        exports: { ".": "./index.ts" },
      }),
    );
    addFile("packages/source/index.ts", "export const source = true;\n");
    mocks.push.mockRejectedValueOnce(
      Object.assign(new Error("Main advanced"), {
        errorData: {
          code: "RevisionChanged",
          actual: { kind: "event", eventId: "event:new" },
        },
      }),
    );
    const { forkProject, ScaffoldPublicationError } =
      await import("./create-project.js");

    const failure = await forkProject({
      from: "packages/source",
      to: "packages/new",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ScaffoldPublicationError);
    expect(
      (failure as InstanceType<typeof ScaffoldPublicationError>).errorData,
    ).toMatchObject({
      created: "packages/new",
      committedEventId: "event:committed",
      published: false,
      vcsError: { code: "RevisionChanged" },
      retry: { commandIdPolicy: "reobserve-status-and-use-new-command" },
    });
  });

  it("rewrites a single-class worker fork and preserves binary files", async () => {
    addDir("workers/source/.git");
    addFile("workers/source/.gad/CHECKOUT.json", "{}");
    addFile("workers/source/.env", "SECRET=yes\n");
    addFile("workers/source/debug.log", "debug\n");
    addFile(
      "workers/source/node_modules/pkg/index.js",
      "module.exports = {}\n",
    );
    addFile(
      "workers/source/package.json",
      JSON.stringify({
        name: "@workspace-workers/source",
        private: true,
        type: "module",
        vibestudio: {
          entry: "source-worker.ts",
          authority: { requests: [], provides: [] },
          durable: { classes: [{ className: "SourceWorker" }] },
        },
      }),
    );
    addFile(
      "workers/source/source-worker.ts",
      'export class SourceWorker { readonly source = "workers/source"; }\n',
    );
    addFile("workers/source/icon.png", new Uint8Array([1, 2, 3]));

    const { forkProject } = await import("./create-project.js");
    const result = await forkProject({
      from: "workers/source",
      to: "workers/new",
      title: "New Worker",
    });

    expect(result.committed).toBe(true);
    expect(result.publication).toMatchObject({
      published: true,
      committedEventId: "event:committed",
    });
    expect(result.files).toContain("new-worker.ts");
    // Managed writes authored the local chain, then one commit + push finished it.
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledTimes(1);
    // The repository lifecycle transition seeded the projected files.
    expect(
      JSON.parse(mocks.files.get("workers/new/package.json") as string),
    ).toMatchObject({
      name: "@workspace-workers/new",
      vibestudio: {
        title: "New Worker",
        entry: "new-worker.ts",
        durable: { classes: [{ className: "NewWorker" }] },
      },
    });
    expect(mocks.files.get("workers/new/new-worker.ts")).toContain(
      "class NewWorker",
    );
    expect(mocks.files.get("workers/new/new-worker.ts")).toContain(
      "workers/new",
    );
    expect(mocks.files.get("workers/new/icon.png")).toBeInstanceOf(Uint8Array);
    expect(result.files).not.toContain(".gad/CHECKOUT.json");
    expect(result.files).not.toContain(".env");
    expect(result.files).not.toContain("debug.log");
    expect(result.files).not.toContain("node_modules/pkg/index.js");
    expect(mocks.files.has("workers/new/.gad/CHECKOUT.json")).toBe(false);
    expect(mocks.files.has("workers/new/.env")).toBe(false);
    expect(mocks.files.has("workers/new/debug.log")).toBe(false);
    expect(mocks.files.has("workers/new/node_modules/pkg/index.js")).toBe(
      false,
    );
  });

  it("does not textually rewrite a structurally rewritten worker manifest", async () => {
    addFile(
      "workers/source/package.json",
      JSON.stringify({
        name: "@workspace-workers/source",
        private: true,
        type: "module",
        vibestudio: {
          title: "Source",
          entry: "source-worker.ts",
          authority: { requests: [], provides: [] },
          durable: { classes: [{ className: "SourceWorker" }] },
        },
      }),
    );
    addFile(
      "workers/source/source-worker.ts",
      'export class SourceWorker { readonly source = "workers/source"; }\n',
    );

    const { forkProject } = await import("./create-project.js");
    await forkProject({
      from: "workers/source",
      to: "workers/source-copy",
      title: "Source Copy",
    });

    expect(
      JSON.parse(mocks.files.get("workers/source-copy/package.json") as string),
    ).toMatchObject({
      name: "@workspace-workers/source-copy",
      vibestudio: {
        title: "Source Copy",
        entry: "source-copy-worker.ts",
        durable: { classes: [{ className: "SourceCopyWorker" }] },
      },
    });
    expect(mocks.files.has("workers/source-copy/source-copy-worker.ts")).toBe(
      true,
    );
    expect(
      mocks.files.get("workers/source-copy/source-copy-worker.ts"),
    ).toContain("class SourceCopyWorker");
    expect(
      mocks.files.get("workers/source-copy/source-copy-worker.ts"),
    ).toContain("workers/source-copy");
  });

  it("rejects an invalid fork identity before repository mutation", async () => {
    addFile(
      "packages/source/package.json",
      JSON.stringify({
        name: "@workspace/source",
        private: true,
        type: "module",
        exports: { ".": "./index.ts" },
      }),
    );
    addFile("packages/source/index.ts", "export {};\n");
    const { forkProject } = await import("./create-project.js");

    await expect(
      forkProject({
        from: "packages/source",
        to: "packages/new",
        title: "unsafe\nfrontmatter",
      }),
    ).rejects.toThrow(/Project title/);
    expect(mocks.edit).not.toHaveBeenCalled();
  });
});

describe("scaffold runtime contract", () => {
  beforeEach(resetRuntimeMocks);

  it("pins the panel scaffold's React to the exact runtime Base declares", async () => {
    const { BASE_PANEL_REACT_VERSION, createProjects } =
      await import("./create-project.js");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    // The shell realm provides this exact React; packages/react peers on it.
    const baseRoot = join(import.meta.dirname, "..", "..");
    const reactPackage = JSON.parse(
      readFileSync(join(baseRoot, "packages", "react", "package.json"), "utf8"),
    ) as { peerDependencies?: Record<string, string> };
    expect(reactPackage.peerDependencies?.["react"]).toBe("^19.0.0");
    expect(reactPackage.peerDependencies?.["react-dom"]).toBe("^19.0.0");
    const shellPackage = JSON.parse(
      readFileSync(join(baseRoot, "apps", "shell", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(shellPackage.dependencies?.["react"]).toBe("^19.0.0");

    // And the generated scaffold carries exactly that pin.
    await createProjects([
      {
        projectType: "panel",
        name: "react-pin-probe",
        title: "React Pin Probe",
      },
    ]);
    const manifest = JSON.parse(
      String(mocks.files.get("panels/react-pin-probe/package.json")),
    ) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies).toEqual({
      "@workspace/runtime": "workspace:*",
      "@workspace/test-runtime": "workspace:*",
      react: BASE_PANEL_REACT_VERSION,
      "react-dom": BASE_PANEL_REACT_VERSION,
    });
  });
});
