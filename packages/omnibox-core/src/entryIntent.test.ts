import { describe, expect, it } from "vitest";
import { browserUrlFromEntry } from "./entryIntent";

describe("browserUrlFromEntry", () => {
  it("keeps explicit HTTP(S) addresses and normalizes them", () => {
    expect(browserUrlFromEntry(" https://example.com/docs?q=one ")).toBe(
      "https://example.com/docs?q=one"
    );
    expect(browserUrlFromEntry("http://localhost:8080/app")).toBe("http://localhost:8080/app");
  });

  it("recognizes protocol-free public and local addresses", () => {
    expect(browserUrlFromEntry("example.com/docs")).toBe("https://example.com/docs");
    expect(browserUrlFromEntry("example.com:8443/docs")).toBe("https://example.com:8443/docs");
    expect(browserUrlFromEntry("www.example.com")).toBe("https://www.example.com/");
    expect(browserUrlFromEntry("localhost:5173")).toBe("http://localhost:5173/");
    expect(browserUrlFromEntry("127.0.0.1:3000/test")).toBe("http://127.0.0.1:3000/test");
    expect(browserUrlFromEntry("192.168.1.1/settings")).toBe("http://192.168.1.1/settings");
    expect(browserUrlFromEntry("[::1]:4173")).toBe("http://[::1]:4173/");
  });

  it("leaves prose, ambiguous words, and unsupported schemes for chat", () => {
    expect(browserUrlFromEntry("explain example.com to me")).toBeNull();
    expect(browserUrlFromEntry("vibestudio")).toBeNull();
    expect(browserUrlFromEntry("person@example.com")).toBeNull();
    expect(browserUrlFromEntry("javascript:alert(1)")).toBeNull();
    expect(browserUrlFromEntry("file:///tmp/example.html")).toBeNull();
  });
});
