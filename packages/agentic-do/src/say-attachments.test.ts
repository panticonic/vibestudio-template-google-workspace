import { describe, expect, it } from "vitest";
import { readSayAttachments } from "./say-attachments.js";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function makeFs(files: Record<string, string | Uint8Array>) {
  return {
    async readFile(path: string): Promise<string | Uint8Array> {
      const contents = files[path];
      if (contents === undefined) throw new Error(`ENOENT: ${path}`);
      return contents;
    },
  };
}

describe("readSayAttachments", () => {
  it("reads image files into base64 channel attachments", async () => {
    const fs = makeFs({ "/shots/page.png": PNG_BYTES });
    const attachments = await readSayAttachments(fs, ["/shots/page.png"]);
    expect(attachments).toEqual([
      {
        id: "att_0",
        data: Buffer.from(PNG_BYTES).toString("base64"),
        mimeType: "image/png",
        name: "page.png",
        size: PNG_BYTES.length,
      },
    ]);
  });

  it("recognizes generated images whose scratch suffix follows the extension", async () => {
    const path = "/.tmp/spectrolite-panel.png-51aac5d798e92a7dd8354759b61a71cd";
    const attachments = await readSayAttachments(makeFs({ [path]: PNG_BYTES }), [path]);

    expect(attachments[0]).toMatchObject({
      mimeType: "image/png",
      name: "spectrolite-panel.png-51aac5d798e92a7dd8354759b61a71cd",
    });
  });

  it("prefers the image signature over a misleading extension", async () => {
    const attachments = await readSayAttachments(makeFs({ "/shots/page.jpg": PNG_BYTES }), [
      "/shots/page.jpg",
    ]);
    expect(attachments[0]?.mimeType).toBe("image/png");
  });

  it("rejects extension-labeled bytes that are not a supported image", async () => {
    await expect(
      readSayAttachments(makeFs({ "/shots/page.png": new Uint8Array([1, 2, 3]) }), [
        "/shots/page.png",
      ])
    ).rejects.toThrow(/unsupported file content/i);
  });

  it("wraps fs errors with the offending path", async () => {
    const fs = makeFs({});
    await expect(readSayAttachments(fs, ["/missing.png"])).rejects.toThrow(
      /say attachment "\/missing.png"/
    );
  });

  it("rejects text file contents", async () => {
    const fs = makeFs({ "/fake.png": "not binary" });
    await expect(readSayAttachments(fs, ["/fake.png"])).rejects.toThrow(/binary image data/);
  });

  it("rejects oversized attachments via the shared validation", async () => {
    const oversizedPng = new Uint8Array(16 * 1024 * 1024);
    oversizedPng.set(PNG_BYTES);
    const fs = makeFs({ "/huge.png": oversizedPng });
    await expect(readSayAttachments(fs, ["/huge.png"])).rejects.toThrow(/too large/i);
  });

  it("returns an empty list for no paths", async () => {
    expect(await readSayAttachments(makeFs({}), [])).toEqual([]);
  });
});
