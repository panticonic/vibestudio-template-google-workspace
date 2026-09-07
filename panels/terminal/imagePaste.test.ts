import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUrlForPaste, stashForPaste, stashPasteBatch } from "./imagePaste.js";
import type { ShellApi } from "./types.js";

describe("imagePaste", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches and stashes dropped http URLs when CORS permits", async () => {
    const stashScratch = vi.fn(async () => ({
      absolutePath: "/workspace/.snug/scratch/drop.png",
      workspaceRelative: ".snug/scratch/drop.png",
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "3" },
    })));

    const result = await fetchUrlForPaste({
      shell: { stashScratch } as unknown as ShellApi,
      url: "https://example.test/drop.png",
      cwd: "/workspace",
      pasteMode: "path",
      imagePasteRelative: false,
    });

    expect(stashScratch).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), "png");
    expect(result?.pasteText).toBe("/workspace/.snug/scratch/drop.png");
  });

  it("skips non-http URLs and non-ok responses", async () => {
    const stashScratch = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));

    await expect(fetchUrlForPaste({
      shell: { stashScratch } as unknown as ShellApi,
      url: "file:///tmp/drop.png",
      cwd: "/workspace",
      pasteMode: "path",
      imagePasteRelative: false,
    })).resolves.toBeUndefined();
    await expect(fetchUrlForPaste({
      shell: { stashScratch } as unknown as ShellApi,
      url: "https://example.test/missing.png",
      cwd: "/workspace",
      pasteMode: "path",
      imagePasteRelative: false,
    })).resolves.toBeUndefined();
    expect(stashScratch).not.toHaveBeenCalled();
  });

  it("rejects URLs over the scratch limit before stashing", async () => {
    const stashScratch = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1]), {
      status: 200,
      headers: { "content-length": String(25 * 1024 * 1024 + 1) },
    })));

    await expect(fetchUrlForPaste({
      shell: { stashScratch } as unknown as ShellApi,
      url: "https://example.test/huge.png",
      cwd: "/workspace",
      pasteMode: "path",
      imagePasteRelative: false,
    })).rejects.toThrow("25MB");
    expect(stashScratch).not.toHaveBeenCalled();
  });

  it("uses relative paths only when the cwd does not require escaping upward", async () => {
    const stashScratch = vi.fn(async () => ({
      absolutePath: "/workspace/.snug/scratch/drop.png",
      workspaceRelative: ".snug/scratch/drop.png",
    }));

    await expect(stashForPaste({
      shell: { stashScratch } as unknown as ShellApi,
      bytes: new Uint8Array([1]),
      mime: "image/png",
      cwd: "/workspace",
      pasteMode: "path",
      imagePasteRelative: true,
    })).resolves.toMatchObject({ pasteText: ".snug/scratch/drop.png" });

    await expect(stashForPaste({
      shell: { stashScratch } as unknown as ShellApi,
      bytes: new Uint8Array([1]),
      mime: "image/png",
      cwd: "/workspace/packages/app",
      pasteMode: "path",
      imagePasteRelative: true,
    })).resolves.toMatchObject({ pasteText: "/workspace/.snug/scratch/drop.png" });
  });

  it("quotes pasted paths with shell-sensitive characters", async () => {
    const stashScratch = vi.fn(async () => ({
      absolutePath: "/workspace/.snug/scratch/drop file's.png",
      workspaceRelative: ".snug/scratch/drop file's.png",
    }));

    await expect(stashForPaste({
      shell: { stashScratch } as unknown as ShellApi,
      bytes: new Uint8Array([1]),
      mime: "image/png",
      cwd: "/workspace",
      pasteMode: "path",
      imagePasteRelative: false,
    })).resolves.toMatchObject({ pasteText: "'/workspace/.snug/scratch/drop file'\\''s.png'" });
  });

  it("rejects oversized data URIs before writing scratch files", async () => {
    const stashScratch = vi.fn();

    await expect(stashForPaste({
      shell: { stashScratch } as unknown as ShellApi,
      bytes: new Uint8Array(5 * 1024 * 1024 + 1),
      mime: "image/png",
      cwd: "/workspace",
      pasteMode: "both",
      imagePasteRelative: false,
    })).rejects.toThrow("5MB");
    expect(stashScratch).not.toHaveBeenCalled();
  });

  it("uses file wording for non-image scratch size limits", async () => {
    const stashScratch = vi.fn();

    await expect(stashForPaste({
      shell: { stashScratch } as unknown as ShellApi,
      bytes: new Uint8Array(25 * 1024 * 1024 + 1),
      mime: "application/pdf",
      cwd: "/workspace",
      pasteMode: "path",
      imagePasteRelative: false,
    })).rejects.toThrow("File exceeds 25MB scratch limit");
    expect(stashScratch).not.toHaveBeenCalled();
  });

  it("uses file wording for non-image data URI size limits", async () => {
    const stashScratch = vi.fn();

    await expect(stashForPaste({
      shell: { stashScratch } as unknown as ShellApi,
      bytes: new Uint8Array(5 * 1024 * 1024 + 1),
      mime: "application/pdf",
      cwd: "/workspace",
      pasteMode: "both",
      imagePasteRelative: false,
    })).rejects.toThrow("File exceeds 5MB data URI limit");
    expect(stashScratch).not.toHaveBeenCalled();
  });

  it("keeps valid files in a multi-file paste when one file is rejected", async () => {
    const stashScratch = vi
      .fn()
      .mockResolvedValueOnce({
        absolutePath: "/workspace/.snug/scratch/one.png",
        workspaceRelative: ".snug/scratch/one.png",
      })
      .mockResolvedValueOnce({
        absolutePath: "/workspace/.snug/scratch/two.pdf",
        workspaceRelative: ".snug/scratch/two.pdf",
      });

    await expect(stashPasteBatch({
      shell: { stashScratch } as unknown as ShellApi,
      items: [
        { bytes: new Uint8Array([1]), mime: "image/png" },
        { bytes: new Uint8Array(), mime: "image/png" },
        { bytes: new Uint8Array([2]), mime: "application/pdf" },
      ],
      cwd: "/workspace",
      pasteMode: "path",
      imagePasteRelative: false,
    })).resolves.toMatchObject({
      stashed: [
        { index: 0, paste: { pasteText: "/workspace/.snug/scratch/one.png" } },
        { index: 2, paste: { pasteText: "/workspace/.snug/scratch/two.pdf" } },
      ],
      errors: [{ index: 1, message: "Empty file, nothing pasted" }],
      pasteText: "/workspace/.snug/scratch/one.png /workspace/.snug/scratch/two.pdf",
    });
    expect(stashScratch).toHaveBeenCalledTimes(2);
  });
});
