import { normalizePath, getFileName, resolvePath } from "./pathUtils.js";

describe("normalizePath", () => {
  it("replaces backslashes with forward slashes", () => {
    expect(normalizePath("C:\\Users\\test\\file.txt")).toBe("C:/Users/test/file.txt");
  });

  it("leaves forward slashes unchanged", () => {
    expect(normalizePath("/home/user/file.txt")).toBe("/home/user/file.txt");
  });

  it("handles mixed slashes", () => {
    expect(normalizePath("path\\to/mixed\\slashes")).toBe("path/to/mixed/slashes");
  });
});

describe("getFileName", () => {
  it("extracts the last segment after /", () => {
    expect(getFileName("/home/user/file.txt")).toBe("file.txt");
  });

  it("returns the input if no / is present", () => {
    expect(getFileName("file.txt")).toBe("file.txt");
  });

  it("handles paths ending with /", () => {
    // parts = ["", "home", "user", ""], last element is ""
    // falls back to filePath since last element is empty string (falsy)
    expect(getFileName("/home/user/")).toBe("/home/user/");
  });
});

describe("resolvePath", () => {
  it("returns absolute relativePath as-is", () => {
    expect(resolvePath("/base/path", "/absolute/path")).toBe("/absolute/path");
  });

  it("joins base and relative paths", () => {
    expect(resolvePath("/base/path", "relative/file.txt")).toBe("/base/path/relative/file.txt");
  });

  it("handles trailing slash on base path", () => {
    expect(resolvePath("/base/path/", "relative/file.txt")).toBe("/base/path/relative/file.txt");
  });

  it("handles base without trailing slash", () => {
    expect(resolvePath("/base", "file.txt")).toBe("/base/file.txt");
  });
});
