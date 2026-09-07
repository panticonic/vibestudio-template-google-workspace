import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GitClient,
  GitPushRejectedError,
  type GitCommitTreeEntry,
  type GitLogEntry,
} from "@vibestudio/git";
import { sha256Hex } from "@vibestudio/content-addressing";
import { TemplatePushEngine } from "./templatePush.js";
import type { ProtectedRepositorySnapshot } from "./bridge.js";

const BASE = "c".repeat(40);
const roots: string[] = [];

function snapshot(repoPath: string, eventId: string, marker: string): ProtectedRepositorySnapshot {
  const bytes = Buffer.from(`${marker}\n`);
  return {
    repositoryId: `repository:${repoPath}`,
    repoPath,
    eventId,
    treeDigest: `v1-sha256:${marker.repeat(64).slice(0, 64)}`,
    files: [
      {
        path: "index.ts",
        contentHash: sha256Hex(bytes),
        size: bytes.byteLength,
        mode: 0o644,
        bytes,
      },
    ],
  };
}

interface SemanticContext {
  clean: boolean;
  head: { kind: "event"; eventId: string };
  content: string | null;
}

function semanticRpc() {
  const contexts = new Map<string, SemanticContext>();
  let event = 0;
  const call = vi.fn(
    async <T>(
      _target: string,
      method: string,
      args: {
        contextId: string;
        changes: Array<{ content: { text: string } }>;
      }
    ): Promise<T> => {
      if (method === "runtime.createContext") {
        contexts.set(
          args.contextId,
          contexts.get(args.contextId) ?? {
            clean: true,
            head: { kind: "event", eventId: "semantic-main" },
            content: null,
          }
        );
        return undefined as T;
      }
      const id = args.contextId as string | undefined;
      const context = id ? contexts.get(id) : [...contexts.values()][0];
      if (!context) throw new Error(`missing semantic context for ${method}`);
      if (method === "vcs.status") {
        return {
          clean: context.clean,
          workingHead: context.head,
          committed: context.head,
        } as T;
      }
      if (method === "vcs.resolveRepository") {
        return { repositoryId: "repository:meta", repoPath: "meta" } as T;
      }
      if (method === "vcs.readFile") {
        return (
          context.content === null
            ? null
            : {
                fileId: "file:intent",
                path: "template-suggestion-intent.json",
                mode: 0o644,
                content: { kind: "text", text: context.content },
              }
        ) as T;
      }
      if (method === "vcs.edit") {
        const [change] = args.changes;
        if (!change) throw new Error("missing semantic edit");
        context.content = change.content.text;
        context.clean = false;
        context.head = { kind: "event", eventId: `semantic-edit-${++event}` };
        return undefined as T;
      }
      if (method === "vcs.commit") {
        context.clean = true;
        context.head = { kind: "event", eventId: `semantic-commit-${++event}` };
        return undefined as T;
      }
      throw new Error(`unexpected semantic RPC ${method}`);
    }
  );
  return { call, contexts };
}

function diskTree(root: string): GitCommitTreeEntry[] {
  const entries: GitCommitTreeEntry[] = [];
  const visit = (directory: string, prefix: string) => {
    for (const name of fs.readdirSync(directory).sort()) {
      if (name === ".git") continue;
      const absolute = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = fs.statSync(absolute);
      if (stat.isDirectory()) visit(absolute, relative);
      else {
        entries.push({
          path: relative,
          type: "blob",
          mode: stat.mode & 0o111 ? 0o100755 : 0o100644,
          oid: sha256Hex(fs.readFileSync(absolute)).slice(0, 40),
          bytes: fs.readFileSync(absolute),
        });
      }
    }
  };
  visit(root, "");
  return entries;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "template-push-"));
  roots.push(root);
  const statePath = path.join(root, "state");
  const semantic = semanticRpc();
  let news = snapshot("panels/news", "event:news", "a");
  const bridge = {
    readProtectedRepository: vi.fn(async (repoPath: string, eventId: string) => {
      const value = repoPath === "panels/news" ? news : snapshot(repoPath, eventId, "b");
      return { ...value, eventId };
    }),
  };
  const ctx = {
    storage: { root: statePath },
    workspace: { getInfo: vi.fn(async () => ({ path: root, statePath, id: "ws-1" })) },
    credentials: { gitHttp: vi.fn(() => ({})) },
    rpc: semantic,
  };
  return {
    root,
    statePath,
    bridge,
    ctx,
    engine: new TemplatePushEngine(ctx as never, bridge as never),
    changeNews(value: ProtectedRepositorySnapshot) {
      news = value;
    },
  };
}

let remoteHead: string | null;
let nextCommit: number;
let currentByDirectory: Map<string, string>;
let trees: Map<string, GitCommitTreeEntry[]>;
let commits: Map<string, GitLogEntry>;

beforeEach(() => {
  remoteHead = null;
  nextCommit = 1;
  currentByDirectory = new Map();
  trees = new Map([[BASE, []]]);
  commits = new Map();
  vi.restoreAllMocks();
  vi.spyOn(GitClient.prototype, "clone").mockImplementation(async ({ dir, ref }) => {
    currentByDirectory.set(dir, ref ?? BASE);
  });
  vi.spyOn(GitClient.prototype, "createBranch").mockImplementation(async ({ dir, startPoint }) => {
    currentByDirectory.set(dir, startPoint ?? BASE);
  });
  vi.spyOn(GitClient.prototype, "addAll").mockResolvedValue();
  vi.spyOn(GitClient.prototype, "commit").mockImplementation(async ({ dir, message, author }) => {
    const oid = nextCommit.toString(16).padStart(40, "0");
    nextCommit += 1;
    const parent = currentByDirectory.get(dir) ?? BASE;
    currentByDirectory.set(dir, oid);
    trees.set(oid, diskTree(dir));
    commits.set(oid, {
      oid,
      message,
      author: { ...author!, timestamp: 1 },
      parentOids: [parent],
    });
    return oid;
  });
  vi.spyOn(GitClient.prototype, "getCurrentCommit").mockImplementation(
    async (dir) => currentByDirectory.get(dir) ?? null
  );
  vi.spyOn(GitClient.prototype, "readCommitTree").mockImplementation(
    async (_dir, oid) => trees.get(oid) ?? []
  );
  vi.spyOn(GitClient.prototype, "fetch").mockImplementation(async () => ({
    fetchHead: remoteHead,
    fetchHeadDescription: remoteHead ? "branch" : null,
    remoteRefExists: remoteHead !== null,
  }));
  vi.spyOn(GitClient.prototype, "resolveRef").mockImplementation(async () => remoteHead);
  vi.spyOn(GitClient.prototype, "log").mockImplementation(async (_dir, options) => {
    const history: GitLogEntry[] = [];
    let oid = options?.ref ?? remoteHead ?? BASE;
    while (history.length < (options?.depth ?? 10)) {
      if (oid === BASE) {
        history.push({
          oid: BASE,
          message: "base",
          author: { name: "base", email: "base@example.test", timestamp: 0 },
          parentOids: [],
        });
        break;
      }
      const entry = commits.get(oid);
      if (!entry) break;
      history.push(entry);
      oid = entry.parentOids[0]!;
    }
    return history;
  });
  vi.spyOn(GitClient.prototype, "push").mockImplementation(async ({ dir }) => {
    remoteHead = currentByDirectory.get(dir) ?? null;
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const input = {
  operationId: "op-1",
  nodeId: "t-a1",
  alias: "News",
  url: "https://example.test/news.git",
  baseCommit: BASE,
  expectedMainEventId: "event:main",
  parts: [
    { repoPath: "workers/news-agent", subdir: "workers/news-agent" },
    { repoPath: "panels/news", subdir: "panels/news" },
  ],
};

describe("TemplatePushEngine", () => {
  it("publishes from disposable attempts and proves an existing deterministic branch", async () => {
    const fx = fixture();
    const first = await fx.engine.push(input);
    expect(fx.bridge.readProtectedRepository).toHaveBeenCalledWith(
      "panels/news",
      input.expectedMainEventId
    );
    expect(fx.bridge.readProtectedRepository).toHaveBeenCalledWith(
      "workers/news-agent",
      input.expectedMainEventId
    );
    expect(first).toEqual({
      outcome: "pushed",
      operationId: "op-1",
      branch: expect.stringMatching(/^vibestudio\/ws-1\/[0-9a-f]{24}$/u),
      headCommit: expect.stringMatching(/^[0-9a-f]{40}$/u),
      commits: 2,
      parts: ["panels/news", "workers/news-agent"],
    });
    expect(GitClient.prototype.commit).toHaveBeenCalledTimes(2);
    expect(GitClient.prototype.push).toHaveBeenCalledTimes(1);
    expect(
      fs.readdirSync(path.join(fx.statePath, "git-checkouts", "_template-contributions"))
    ).toEqual([]);
    expect(fs.existsSync(path.join(fx.statePath, "workspace-templates"))).toBe(false);

    const second = await fx.engine.push(input);
    expect(second).toMatchObject({
      outcome: "already-at-remote",
      branch: first.branch,
      headCommit: first.headCommit,
      commits: 2,
    });
    expect(GitClient.prototype.clone).toHaveBeenCalledTimes(2);
    expect(GitClient.prototype.push).toHaveBeenCalledTimes(1);
    expect(fx.ctx.rpc.call.mock.calls.filter((call) => call[1] === "vcs.commit")).toHaveLength(1);
  });

  it("binds an operation id to exact semantic source events before Git work", async () => {
    const fx = fixture();
    const panelsOnly = {
      ...input,
      parts: [{ repoPath: "panels/news", subdir: "panels/news" }],
    };
    await fx.engine.push(panelsOnly);
    const clones = vi.mocked(GitClient.prototype.clone).mock.calls.length;
    fx.changeNews(snapshot("panels/news", "event:news-2", "z"));

    await expect(fx.engine.push(panelsOnly)).rejects.toThrow("reused with different exact intent");
    expect(GitClient.prototype.clone).toHaveBeenCalledTimes(clones);
  });

  it("rejects a remote branch whose history does not prove the exact operation", async () => {
    const fx = fixture();
    const first = await fx.engine.push({ ...input, parts: [input.parts[0]!] });
    const existing = commits.get(first.headCommit!)!;
    commits.set(first.headCommit!, { ...existing, message: "unrelated contribution" });

    await expect(fx.engine.push({ ...input, parts: [input.parts[0]!] })).rejects.toThrow(
      "outside its exact intent"
    );
  });

  it("derives nothing-to-suggest from the exact base tree, without a frontier", async () => {
    const fx = fixture();
    const value = await fx.bridge.readProtectedRepository("panels/news", "event:main");
    trees.set(BASE, [
      {
        path: "panels/news/index.ts",
        type: "blob",
        mode: 0o100644,
        oid: "d".repeat(40),
        bytes: value.files[0]!.bytes,
      },
    ]);
    await expect(
      fx.engine.push({
        ...input,
        parts: [{ repoPath: "panels/news", subdir: "panels/news" }],
      })
    ).resolves.toEqual({
      outcome: "nothing-to-suggest",
      operationId: "op-1",
      branch: null,
      headCommit: null,
      commits: 0,
      parts: [],
    });
    expect(GitClient.prototype.commit).not.toHaveBeenCalled();
    expect(GitClient.prototype.push).not.toHaveBeenCalled();
  });

  it("recovers a same-intent concurrent push by observing the winning remote", async () => {
    const fx = fixture();
    vi.mocked(GitClient.prototype.push).mockImplementationOnce(async ({ dir }) => {
      remoteHead = currentByDirectory.get(dir) ?? null;
      throw new GitPushRejectedError("raced");
    });
    await expect(fx.engine.push({ ...input, parts: [input.parts[0]!] })).resolves.toMatchObject({
      outcome: "already-at-remote",
      headCommit: expect.stringMatching(/^[0-9a-f]{40}$/u),
    });
    expect(GitClient.prototype.fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps canonical identity out of transport and uses the declared logical credential", async () => {
    const fx = fixture();
    await fx.engine.push({
      ...input,
      operationId: "op-credentialed",
      url: "git+https://example.test/news.git",
      credential: "company-git",
      parts: [input.parts[0]!],
    });
    expect(fx.ctx.credentials.gitHttp).toHaveBeenCalledWith({
      logicalCredential: {
        name: "company-git",
        remoteUrl: "https://example.test/news.git",
      },
    });
    expect(GitClient.prototype.clone).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.test/news.git", ref: BASE })
    );
  });
});
