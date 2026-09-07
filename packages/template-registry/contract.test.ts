import { describe, expect, it } from "vitest";
import {
  TemplateRegistryEpochError,
  TemplateRegistrySelectionError,
  parseTemplateRegistry,
  resolveTemplateRegistrySelection,
} from "./contract.js";

const commit = "0123456789abcdef0123456789abcdef01234567";
const snapshot = `v1-sha256:${"a".repeat(64)}`;
const coordinates = {
  url: "git+https://github.com/vibestudio/template-registry.git",
  ref: "refs/heads/promoted",
  commit,
  snapshot,
};

function registryValue() {
  return {
    version: 1,
    revision: "2026-07-29.3",
    systemEpoch: 59,
    entries: [
      {
        id: "news",
        name: "News workspace",
        description: "Read and discuss news.",
        tags: ["news", "agent"],
        recommended: true,
        url: "https://github.com/vibestudio/template-news.git",
        promoted: { ref: "refs/tags/v1.2.0", commit, snapshot },
      },
    ],
  };
}

describe("template registry contract", () => {
  it("normalizes registry URLs and returns only exact promoted coordinates", () => {
    const registry = parseTemplateRegistry(registryValue());
    expect(registry.entries[0]).toEqual({
      id: "news",
      name: "News workspace",
      description: "Read and discuss news.",
      tags: ["news", "agent"],
      recommended: true,
      url: "git+https://github.com/vibestudio/template-news.git",
      promoted: { ref: "refs/tags/v1.2.0", commit, snapshot },
    });
    expect(
      resolveTemplateRegistrySelection(
        registry,
        {
          catalogId: "news",
          registryCommit: commit,
          registrySnapshot: snapshot,
        },
        coordinates,
        59,
      ),
    ).toEqual({
      catalogId: "news",
      registryCommit: commit,
      registrySnapshot: snapshot,
      name: "News workspace",
      url: "git+https://github.com/vibestudio/template-news.git",
      promoted: { ref: "refs/tags/v1.2.0", commit, snapshot },
    });
  });

  it("rejects stale selections and incompatible epochs", () => {
    const registry = parseTemplateRegistry(registryValue());
    expect(() =>
      resolveTemplateRegistrySelection(
        registry,
        {
          catalogId: "news",
          registryCommit: "f".repeat(40),
          registrySnapshot: snapshot,
        },
        coordinates,
      ),
    ).toThrow(TemplateRegistrySelectionError);
    expect(() =>
      resolveTemplateRegistrySelection(
        registry,
        {
          catalogId: "news",
          registryCommit: commit,
          registrySnapshot: snapshot,
        },
        coordinates,
        57,
      ),
    ).toThrow(TemplateRegistryEpochError);
  });

  it("rejects duplicate identities and moving or malformed coordinates", () => {
    const duplicate = registryValue();
    duplicate.entries.push({ ...duplicate.entries[0]! });
    expect(() => parseTemplateRegistry(duplicate)).toThrow(
      "Duplicate template registry id",
    );

    expect(() =>
      parseTemplateRegistry({
        ...registryValue(),
        entries: [
          {
            ...registryValue().entries[0],
            promoted: { ref: "main", commit: "abc", snapshot: "sha256:abc" },
          },
        ],
      }),
    ).toThrow("canonical branch or tag ref");
  });
});
