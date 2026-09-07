import { describe, expect, it, vi } from "vitest";
import {
  MemoryTemplateRegistryCache,
  TemplateRegistryClient,
  TemplateRegistryUnavailableError,
  type TemplateRegistryAcquirer,
} from "./client.js";
import type { TemplateRegistrySource } from "./contract.js";

const commit = "0123456789abcdef0123456789abcdef01234567";
const snapshot = `v1-sha256:${"a".repeat(64)}`;
const source: TemplateRegistrySource = {
  url: "git+https://github.com/vibestudio/template-registry.git",
  ref: "refs/heads/promoted",
};
const document = `
version: 1
revision: 2026-07-29.3
systemEpoch: 59
entries:
  - id: news
    name: News workspace
    description: Read and discuss news.
    tags: [news, agent]
    recommended: true
    url: git+https://github.com/vibestudio/template-news.git
    promoted:
      ref: refs/tags/v1.2.0
      commit: fedcba9876543210fedcba9876543210fedcba98
      snapshot: v1-sha256:${"b".repeat(64)}
`;

function acquirer(): TemplateRegistryAcquirer {
  return {
    discover: vi.fn(async () => ({
      commit,
      snapshot,
      readFile: (path: string) =>
        path === "registry.yml" ? new TextEncoder().encode(document) : null,
    })),
  };
}

describe("template registry client", () => {
  it("never performs network work for a catalog render", async () => {
    const registryAcquirer = acquirer();
    const client = new TemplateRegistryClient({
      source,
      systemEpoch: 59,
      acquirer: registryAcquirer,
      cache: new MemoryTemplateRegistryCache(),
    });
    await expect(client.catalog()).rejects.toThrow(
      TemplateRegistryUnavailableError,
    );
    expect(registryAcquirer.discover).not.toHaveBeenCalled();
  });

  it("caches only a verified exact snapshot and binds selections to its content", async () => {
    const registryAcquirer = acquirer();
    const cache = new MemoryTemplateRegistryCache();
    const client = new TemplateRegistryClient({
      source,
      systemEpoch: 59,
      acquirer: registryAcquirer,
      cache,
      now: () => new Date("2026-07-29T12:00:00.000Z"),
    });
    await expect(client.refresh()).resolves.toEqual(
      expect.objectContaining({
        revision: "2026-07-29.3",
        coordinates: expect.objectContaining({ commit, snapshot }),
        source: "verified",
        stale: false,
        verifiedAt: "2026-07-29T12:00:00.000Z",
      }),
    );
    await expect(client.catalog()).resolves.toEqual(
      expect.objectContaining({
        revision: "2026-07-29.3",
        source: "cache",
        stale: true,
      }),
    );
    await expect(
      client.resolve({
        catalogId: "news",
        registryCommit: "f".repeat(40),
        registrySnapshot: snapshot,
      }),
    ).rejects.toThrow("catalog changed");
    await expect(
      client.resolve({
        catalogId: "news",
        registryCommit: commit,
        registrySnapshot: snapshot,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        catalogId: "news",
        promoted: expect.objectContaining({
          commit: "fedcba9876543210fedcba9876543210fedcba98",
        }),
      }),
    );
  });

  it("serves the last verified catalog when an explicit refresh is offline", async () => {
    const cache = new MemoryTemplateRegistryCache();
    const first = new TemplateRegistryClient({
      source,
      systemEpoch: 59,
      acquirer: acquirer(),
      cache,
    });
    await first.refresh();
    const offline = new TemplateRegistryClient({
      source,
      systemEpoch: 59,
      acquirer: {
        discover: vi.fn(async () => Promise.reject(new Error("offline"))),
      },
      cache,
    });
    await expect(offline.refresh()).resolves.toEqual(
      expect.objectContaining({
        source: "cache",
        stale: true,
        refreshError: "offline",
      }),
    );
  });

  it("rejects a shown selection when registry content changes under a reused revision", async () => {
    const cache = new MemoryTemplateRegistryCache();
    const first = new TemplateRegistryClient({
      source,
      systemEpoch: 59,
      acquirer: acquirer(),
      cache,
    });
    const shown = await first.refresh();
    const rewrittenCommit = "c".repeat(40);
    const rewrittenSnapshot = `v1-sha256:${"d".repeat(64)}`;
    const second = new TemplateRegistryClient({
      source,
      systemEpoch: 59,
      acquirer: {
        discover: vi.fn(async () => ({
          commit: rewrittenCommit,
          snapshot: rewrittenSnapshot,
          readFile: (path: string) =>
            path === "registry.yml" ? new TextEncoder().encode(document) : null,
        })),
      },
      cache,
    });
    await second.refresh();
    await expect(
      second.resolve({
        catalogId: "news",
        registryCommit: shown.coordinates.commit,
        registrySnapshot: shown.coordinates.snapshot,
      }),
    ).rejects.toThrow("catalog changed");
  });
});
