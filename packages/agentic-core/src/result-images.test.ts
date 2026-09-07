import { describe, expect, it } from "vitest";
import { base64ByteLength, extractResultImages, imageDataUrl } from "./result-images";

describe("result images", () => {
  it("finds an image a tool returned as its own details record", () => {
    // The shape `panel_screenshot` returns.
    expect(
      extractResultImages({ data: "aGk=", mimeType: "image/png", width: 1280, height: 800 })
    ).toEqual([{ data: "aGk=", mimeType: "image/png", width: 1280, height: 800 }]);
  });

  it("finds images inside a model content array", () => {
    expect(
      extractResultImages({
        content: [
          { type: "text", text: "Screenshot of panel-1." },
          { type: "image", data: "aGk=", mimeType: "image/jpeg" },
        ],
      })
    ).toEqual([{ data: "aGk=", mimeType: "image/jpeg" }]);
  });

  it("ignores non-image payloads and survives cycles", () => {
    const cyclic: Record<string, unknown> = { data: "not an image", mimeType: "text/plain" };
    cyclic["self"] = cyclic;
    expect(extractResultImages(cyclic)).toEqual([]);
    expect(extractResultImages("plain output")).toEqual([]);
    expect(extractResultImages(undefined)).toEqual([]);
  });

  it("measures and addresses what it found", () => {
    expect(base64ByteLength("aGVsbG8=")).toBe(5);
    expect(imageDataUrl({ mimeType: "image/png", data: "aGk=" })).toBe(
      "data:image/png;base64,aGk="
    );
  });
});
