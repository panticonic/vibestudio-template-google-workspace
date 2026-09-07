import { describe, expect, it } from "vitest";
import { parseApprovedOpenUrl } from "./approvedOpenUrl.js";

describe("approved open url handoff", () => {
  it("accepts approved http and https URL metadata", () => {
    expect(parseApprovedOpenUrl({ id: "open-1", url: "https://example.test", requestedAt: 1 }))
      .toEqual({ id: "open-1", url: "https://example.test", requestedAt: 1 });
  });

  it("rejects malformed or non-http URL metadata", () => {
    expect(parseApprovedOpenUrl({ id: "open-1", url: "file:///tmp/report.html", requestedAt: 1 })).toBeUndefined();
    expect(parseApprovedOpenUrl({ id: "", url: "https://example.test", requestedAt: 1 })).toBeUndefined();
    expect(parseApprovedOpenUrl({ id: "open-1", url: "https://example.test", requestedAt: Number.NaN })).toBeUndefined();
  });
});
