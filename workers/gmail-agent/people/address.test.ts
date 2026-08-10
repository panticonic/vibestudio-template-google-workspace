import { describe, expect, it } from "vitest";
import { isBareEmailAddress, parseAddressEntries } from "./address.js";

describe("parseAddressEntries", () => {
  it("parses bare addresses", () => {
    expect(parseAddressEntries("A@Example.com")).toEqual([{ email: "a@example.com" }]);
  });

  it("parses named addresses and lowercases emails", () => {
    expect(parseAddressEntries("Alice Smith <Alice@Example.com>")).toEqual([
      { email: "alice@example.com", name: "Alice Smith" },
    ]);
  });

  it("parses mixed lists", () => {
    expect(parseAddressEntries("Alice <a@x.com>, b@y.org , \"Carol C\" <c@z.io>")).toEqual([
      { email: "a@x.com", name: "Alice" },
      { email: "b@y.org" },
      { email: "c@z.io", name: "Carol C" },
    ]);
  });

  it("handles quoted names containing commas", () => {
    expect(parseAddressEntries('"Smith, Alice" <a@x.com>, b@y.org')).toEqual([
      { email: "a@x.com", name: "Smith, Alice" },
      { email: "b@y.org" },
    ]);
  });

  it("dedupes by email keeping the first (named) occurrence", () => {
    expect(parseAddressEntries("Alice <a@x.com>, a@x.com")).toEqual([
      { email: "a@x.com", name: "Alice" },
    ]);
  });

  it("drops invalid entries and tolerates undefined/arrays", () => {
    expect(parseAddressEntries("not-an-address, <also bad>")).toEqual([]);
    expect(parseAddressEntries(undefined)).toEqual([]);
    expect(parseAddressEntries(["a@x.com", "Bob <b@y.org>"])).toEqual([
      { email: "a@x.com" },
      { email: "b@y.org", name: "Bob" },
    ]);
  });

  it("does not use an email-shaped display part as a name", () => {
    expect(parseAddressEntries("a@x.com <a@x.com>")).toEqual([{ email: "a@x.com" }]);
  });
});

describe("isBareEmailAddress", () => {
  it("accepts bare addresses and rejects display strings", () => {
    expect(isBareEmailAddress("a@x.com")).toBe(true);
    expect(isBareEmailAddress(" a@x.com ")).toBe(true);
    expect(isBareEmailAddress("Alice <a@x.com>")).toBe(false);
    expect(isBareEmailAddress("nope")).toBe(false);
  });
});
