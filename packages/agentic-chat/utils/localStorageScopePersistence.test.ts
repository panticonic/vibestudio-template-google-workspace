// @vitest-environment jsdom

import { describe, expect, it, beforeEach } from "vitest";
import type { ScopeBlobBackend } from "@workspace/eval";
import { ScopeManager } from "@workspace/eval";
import {
  LocalStorageScopePersistence,
  panelLocalScopeChannelId,
} from "./localStorageScopePersistence";

const set = (manager: ScopeManager, key: string, value: unknown) => {
  manager.current[key] = value;
};

const get = (manager: ScopeManager, key: string) => manager.current[key];

function installLocalStorage(): Map<string, string> {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  return values;
}

function createBlobBackend(): ScopeBlobBackend & { blobs: Map<string, string> } {
  const blobs = new Map<string, string>();
  let counter = 0;
  return {
    blobs,
    async putText(valueJson: string) {
      const digest = `test-digest-${++counter}`;
      blobs.set(digest, valueJson);
      return { digest, size: valueJson.length };
    },
    async getText(digest: string) {
      return blobs.get(digest) ?? null;
    },
  };
}

describe("LocalStorageScopePersistence", () => {
  let localStorageValues: Map<string, string>;
  let blobs: ScopeBlobBackend & { blobs: Map<string, string> };

  beforeEach(() => {
    localStorageValues = installLocalStorage();
    blobs = createBlobBackend();
  });

  it("hydrates one shared UI scope for a panel instance", async () => {
    const persistence = new LocalStorageScopePersistence(blobs);
    const panelA = panelLocalScopeChannelId("chat", "panel-a");
    const panelB = panelLocalScopeChannelId("chat", "panel-b");

    const first = new ScopeManager({ channelId: panelA, panelId: "panel-ui", persistence });
    set(first, "inlineDraft", "one");
    set(first, "feedbackDraft", "same panel");
    await first.api.save();

    const second = new ScopeManager({ channelId: panelB, panelId: "panel-ui", persistence });
    set(second, "inlineDraft", "other panel");
    await second.api.save();

    const restored = new ScopeManager({ channelId: panelA, panelId: "panel-ui", persistence });
    const result = await restored.hydrate();

    expect(result.restored).toEqual(expect.arrayContaining(["inlineDraft", "feedbackDraft"]));
    expect(get(restored, "inlineDraft")).toBe("one");
    expect(get(restored, "feedbackDraft")).toBe("same panel");
  });

  it("persists large serializable values through the supplied blobstore backend", async () => {
    const persistence = new LocalStorageScopePersistence(blobs);
    const channelId = panelLocalScopeChannelId("chat", "panel-a");
    const large = "x".repeat(300 * 1024);

    const writer = new ScopeManager({ channelId, panelId: "panel-ui", persistence });
    set(writer, "large", large);
    set(writer, "fn", () => "live-only");
    await writer.api.save();

    expect(blobs.blobs.size).toBe(1);
    for (const value of localStorageValues.values()) {
      expect(value).not.toContain(large.slice(0, 1024));
    }

    const reader = new ScopeManager({ channelId, panelId: "panel-ui", persistence });
    const result = await reader.hydrate();

    expect(get(reader, "large")).toBe(large);
    expect("fn" in reader.current).toBe(false);
    expect(result.lost).toContain("fn");
  });
});
