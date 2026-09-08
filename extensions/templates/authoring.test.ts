import YAML from "yaml";
import { describe, expect, it, vi } from "vitest";
import { inspectTemplateAuthoring } from "./authoring.js";

function observation(eventId: string) {
  return {
    mainEventId: eventId,
    mainState: { kind: "event" as const, eventId },
    runtimeTop: { systemEpoch: 0 },
    localRepoPaths: new Set(["meta", "panels/news"]),
  };
}

function context() {
  return {
    rpc: {
      call: vi.fn(async (_target: string, method: string) => {
        if (method === "vcs.resolveRepository") {
          return { repositoryId: "repository:news", repoPath: "panels/news" };
        }
        if (method === "vcs.readFile") {
          return {
            content: {
              kind: "text",
              text: JSON.stringify({ name: "@workspace-panels/news" }),
            },
          };
        }
        throw new Error(`unexpected method ${method}`);
      }),
    },
  };
}

describe("template authoring source closure", () => {
  it("binds the protected meta repository while keeping it out of runtime repositories", async () => {
    const ctx = context();
    const request = {
      name: "News",
      description: "News workspace",
      parts: ["panels/news"],
    };
    const first = await inspectTemplateAuthoring(
      ctx as never,
      observation("event:one") as never,
      request,
    );
    const second = await inspectTemplateAuthoring(
      ctx as never,
      observation("event:two") as never,
      request,
    );

    expect(first.includedParts).toEqual(["meta", "panels/news"]);
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(YAML.parse(first.manifest).template).toEqual(
      expect.objectContaining({
        repositories: ["panels/news"],
        files: [],
      }),
    );
  });
});
