import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GitClient,
  readExactGitSnapshot,
  type GitCommitTreeEntry,
  type GitLogEntry,
} from "@vibestudio/git";
import { sha256Hex } from "@vibestudio/content-addressing";
import { registerRemoteProvider } from "@workspace/integrations/remoteProviders";
import { TemplatePublishEngine } from "./templatePublish.js";
import type { ProtectedRepositorySnapshot } from "./bridge.js";

const roots: string[] = [];
const resolveOrCreateRepo = vi.fn();
const REMOTE_URL = "https://example.test/acme/news-template.git";

registerRemoteProvider({
  id: "template-publish-test",
  displayName: "Template publication test provider",
  matches: (value) => value === REMOTE_URL,
  createRepo: vi.fn(),
  resolveOrCreateRepo,
  webUrls: () => null,
});

interface RemoteState {
  main: string | null;
  tags: Map<string, string>;
  trees: Map<string, GitCommitTreeEntry[]>;
  history: GitLogEntry[];
  rejectMain: boolean;
  rejectNextTag: boolean;
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
        const bytes = fs.readFileSync(absolute);
        entries.push({
          path: relative,
          type: "blob",
          mode: stat.mode & 0o111 ? 0o100755 : 0o100644,
          oid: sha256Hex(bytes).slice(0, 40),
          bytes,
        });
      }
    }
  };
  visit(root, "");
  return entries;
}

function protectedSnapshot(
  content = "export const answer = 42;\n",
): ProtectedRepositorySnapshot {
  const source = [
    ["index.ts", content],
    [".npmrc", "registry=https://registry.example.test\n"],
  ] as const;
  const files = source.map(([file, fileContent]) => {
    const bytes = Buffer.from(fileContent);
    return {
      path: file,
      contentHash: sha256Hex(bytes),
      size: bytes.byteLength,
      mode: 0o644,
      bytes,
    };
  });
  return {
    repositoryId: "repository:news",
    repoPath: "panels/news",
    eventId: "event:main",
    treeDigest: `v1-sha256:${sha256Hex(Buffer.from(content))}`,
    files,
  };
}

function publicationInput(
  overrides: Partial<Parameters<TemplatePublishEngine["publish"]>[0]> = {},
): Parameters<TemplatePublishEngine["publish"]>[0] {
  const manifest = "systemEpoch: 59\n";
  return {
    operationId: "publish-news-v1",
    expectedMainEventId: "event:main",
    templateName: "News",
    version: "1.0.0",
    manifest,
    manifestDigest: `v1-sha256:${sha256Hex(new TextEncoder().encode(manifest))}`,
    parts: [{ repoPath: "panels/news", subdir: "panels/news" }],
    destination: {
      provider: "template-publish-test",
      owner: "acme",
      name: "news-template",
    },
    ...overrides,
  };
}

function testContext(root: string) {
  return {
    storage: { root: path.join(root, "state") },
    workspace: {
      getInfo: vi.fn(async () => ({
        path: root,
        statePath: path.join(root, "state"),
        id: "ws",
        name: "ws",
      })),
    },
    credentials: { gitHttp: vi.fn(() => ({})) },
    rpc: {
      call: vi.fn(
        async <T>(
          _target: string,
          method: string,
          encoded: string,
        ): Promise<T> => {
          if (method !== "blobstore.putBase64")
            throw new Error(`unexpected RPC ${method}`);
          const bytes = Buffer.from(encoded, "base64");
          return { digest: sha256Hex(bytes), size: bytes.byteLength } as T;
        },
      ),
    },
  };
}

let state: RemoteState;
let nextCommit: number;
let checkoutHeads: Map<string, string>;
let checkoutTags: Map<string, Map<string, string>>;

beforeEach(() => {
  state = {
    main: null,
    tags: new Map(),
    trees: new Map(),
    history: [],
    rejectMain: false,
    rejectNextTag: false,
  };
  nextCommit = 1;
  checkoutHeads = new Map();
  checkoutTags = new Map();
  vi.restoreAllMocks();
  resolveOrCreateRepo.mockReset();
  resolveOrCreateRepo.mockImplementation(async () => ({
    destination: {
      provider: "template-publish-test",
      owner: "acme",
      name: "news-template",
    },
    cloneUrl: REMOTE_URL,
    webUrl: "https://example.test/acme/news-template",
    created: state.main === null && state.tags.size === 0,
  }));
  vi.spyOn(GitClient.prototype, "getRemoteDefaultBranch").mockImplementation(
    async () => (state.main === null ? null : "main"),
  );
  vi.spyOn(GitClient.prototype, "init").mockResolvedValue();
  vi.spyOn(GitClient.prototype, "clone").mockImplementation(async ({ dir }) => {
    if (state.main) checkoutHeads.set(dir, state.main);
    checkoutTags.set(dir, new Map(state.tags));
  });
  vi.spyOn(GitClient.prototype, "addAll").mockResolvedValue();
  vi.spyOn(GitClient.prototype, "commit").mockImplementation(
    async ({ dir, message, author }) => {
      const commit = nextCommit.toString(16).padStart(40, "0");
      nextCommit += 1;
      checkoutHeads.set(dir, commit);
      state.trees.set(commit, diskTree(dir));
      state.history.unshift({
        oid: commit,
        message,
        author: {
          ...(author ?? { name: "Vibestudio", email: "vibestudio@local" }),
          timestamp: 1,
        },
        parentOids: state.main ? [state.main] : [],
      });
      return commit;
    },
  );
  vi.spyOn(GitClient.prototype, "resolveCommit").mockImplementation(
    async (dir, ref) => {
      if (ref === "refs/heads/main")
        return checkoutHeads.get(dir) ?? state.main;
      if (ref.startsWith("refs/tags/")) {
        return (
          checkoutTags.get(dir)?.get(ref.slice("refs/tags/".length)) ??
          state.tags.get(ref.slice("refs/tags/".length)) ??
          null
        );
      }
      return /^[0-9a-f]{40}$/u.test(ref) ? ref : null;
    },
  );
  vi.spyOn(GitClient.prototype, "getCurrentCommit").mockImplementation(
    async (dir) => checkoutHeads.get(dir) ?? null,
  );
  vi.spyOn(GitClient.prototype, "statusMatrix").mockResolvedValue([]);
  vi.spyOn(GitClient.prototype, "log").mockImplementation(async () => [
    ...state.history,
  ]);
  vi.spyOn(GitClient.prototype, "readCommitTree").mockImplementation(
    async (_dir, commit) => state.trees.get(commit) ?? [],
  );
  vi.spyOn(GitClient.prototype, "createTag").mockImplementation(
    async (dir, tag, commit) => {
      const tags = checkoutTags.get(dir) ?? new Map<string, string>();
      if (tags.has(tag)) throw new Error(`tag ${tag} already exists`);
      tags.set(tag, commit);
      checkoutTags.set(dir, tags);
    },
  );
  vi.spyOn(GitClient.prototype, "push").mockImplementation(
    async ({ dir, ref, remoteRef }) => {
      if (remoteRef === "refs/heads/main") {
        if (state.rejectMain) throw new Error("non-fast-forward");
        state.main = checkoutHeads.get(dir) ?? null;
        return;
      }
      if (remoteRef?.startsWith("refs/tags/")) {
        if (state.rejectNextTag) {
          state.rejectNextTag = false;
          throw new Error("connection lost");
        }
        const tag = remoteRef.slice("refs/tags/".length);
        const commit = checkoutTags.get(dir)?.get(ref ?? tag);
        if (!commit) throw new Error(`missing local tag ${tag}`);
        if (state.tags.has(tag) && state.tags.get(tag) !== commit) {
          throw new Error(`tag ${tag} rejected`);
        }
        state.tags.set(tag, commit);
      }
    },
  );
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function engine(snapshot = protectedSnapshot()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "template-publish-"));
  roots.push(root);
  const bridge = {
    readProtectedRepositories: vi.fn(async (repoPaths: string[]) =>
      repoPaths.map((repoPath) => ({ ...snapshot, repoPath })),
    ),
  };
  return {
    engine: new TemplatePublishEngine(
      testContext(root) as never,
      bridge as never,
    ),
    bridge,
    root,
  };
}

describe("TemplatePublishEngine", () => {
  it("publishes into a repository that was created but is still empty", async () => {
    resolveOrCreateRepo.mockResolvedValueOnce({
      destination: {
        provider: "template-publish-test",
        owner: "acme",
        name: "news-template",
      },
      cloneUrl: REMOTE_URL,
      webUrl: "https://example.test/acme/news-template",
      created: false,
    });
    const fixture = engine();
    const result = await fixture.engine.publish(publicationInput());

    expect(
      fixture.bridge.readProtectedRepositories,
    ).toHaveBeenCalledExactlyOnceWith(
      ["panels/news"],
      "event:main",
      "publish-news-v1",
    );
    expect(GitClient.prototype.init).toHaveBeenCalledOnce();
    expect(GitClient.prototype.clone).not.toHaveBeenCalled();
    expect(state.main).toBe(result.commit);
    expect(state.tags.get("v1.0.0")).toBe(result.commit);
  });

  it("publishes v1.0.1 as one new commit on an existing v1.0.0 history", async () => {
    const old = "a".repeat(40);
    state.main = old;
    state.tags.set("v1.0.0", old);
    state.trees.set(old, []);
    state.history.push({
      oid: old,
      message: "Publish News v1.0.0",
      author: { name: "Vibestudio", email: "vibestudio@local", timestamp: 0 },
      parentOids: [],
    });

    const result = await engine(
      protectedSnapshot("export const answer = 43;\n"),
    ).engine.publish(
      publicationInput({
        operationId: "publish-news-v1.0.1",
        version: "1.0.1",
      }),
    );

    expect(GitClient.prototype.clone).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: "main",
        singleBranch: false,
        fullHistory: true,
      }),
    );
    expect(state.history[0]?.parentOids).toEqual([old]);
    expect(state.tags.get("v1.0.0")).toBe(old);
    expect(state.tags.get("v1.0.1")).toBe(result.commit);
  });

  it("recovers a retry after main was pushed but the immutable tag was not", async () => {
    const { engine: publisher } = engine();
    state.rejectNextTag = true;
    await expect(publisher.publish(publicationInput())).rejects.toThrow(
      "connection lost",
    );
    const publishedMain = state.main;
    expect(publishedMain).not.toBeNull();
    expect(state.tags.has("v1.0.0")).toBe(false);

    const pushesBeforeRetry = vi.mocked(GitClient.prototype.push).mock.calls
      .length;
    const result = await publisher.publish(publicationInput());

    expect(result.commit).toBe(publishedMain);
    expect(state.tags.get("v1.0.0")).toBe(publishedMain);
    expect(GitClient.prototype.commit).toHaveBeenCalledOnce();
    expect(
      vi.mocked(GitClient.prototype.push).mock.calls.slice(pushesBeforeRetry),
    ).toEqual([
      [
        expect.objectContaining({
          ref: "v1.0.0",
          remoteRef: "refs/tags/v1.0.0",
        }),
      ],
    ]);
  });

  it("returns the existing canonical publication for an identical completed retry", async () => {
    const { engine: publisher } = engine();
    const first = await publisher.publish(publicationInput());
    const pushCount = vi.mocked(GitClient.prototype.push).mock.calls.length;
    const second = await publisher.publish(publicationInput());

    expect(second.commit).toBe(first.commit);
    expect(second.snapshot).toBe(first.snapshot);
    expect(GitClient.prototype.commit).toHaveBeenCalledOnce();
    expect(GitClient.prototype.push).toHaveBeenCalledTimes(pushCount);
  });

  it("refuses an occupied immutable version tag", async () => {
    const other = "e".repeat(40);
    state.main = other;
    state.tags.set("v1.0.0", other);
    state.trees.set(other, []);
    state.history.push({
      oid: other,
      message: "unrelated",
      author: { name: "Other", email: "other@example.test", timestamp: 0 },
      parentOids: [],
    });

    await expect(engine().engine.publish(publicationInput())).rejects.toThrow(
      "Immutable template tag v1.0.0 already exists",
    );
    expect(GitClient.prototype.commit).not.toHaveBeenCalled();
    expect(GitClient.prototype.push).not.toHaveBeenCalled();
  });

  it("refuses reuse of an operation id for a divergent command", async () => {
    const { engine: publisher } = engine();
    await publisher.publish(publicationInput());

    await expect(
      publisher.publish(publicationInput({ version: "1.0.1" })),
    ).rejects.toThrow("already used for a different template publication");
    expect(GitClient.prototype.commit).toHaveBeenCalledOnce();
  });

  it("does not create or push a tag after a non-fast-forward main rejection", async () => {
    state.rejectMain = true;
    await expect(engine().engine.publish(publicationInput())).rejects.toThrow(
      "non-fast-forward",
    );

    expect(GitClient.prototype.createTag).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(GitClient.prototype.push)
        .mock.calls.some(([call]) => call.remoteRef === "refs/tags/v1.0.0"),
    ).toBe(false);
  });

  it("returns the exact admitted snapshot a consumer discovers", async () => {
    const result = await engine().engine.publish(publicationInput());
    checkoutHeads.set("consumer-checkout", result.commit);

    const consumer = await readExactGitSnapshot({
      git: new GitClient(),
      dir: "consumer-checkout",
      commit: result.commit,
      label: "template consumer",
      sink: {
        put: async (bytes) => ({
          digest: sha256Hex(bytes),
          size: bytes.byteLength,
        }),
      },
      reservedPaths: "exclude",
    });

    expect(result.snapshot).toBe(consumer.snapshot);
    expect(consumer.files.map((file) => file.path)).toEqual([
      "meta/vibestudio.yml",
      "panels/news/.npmrc",
      "panels/news/index.ts",
    ]);
    expect(
      state.trees.get(result.commit)?.map((entry) => entry.path),
    ).toContain("panels/news/.npmrc");
  });
});
