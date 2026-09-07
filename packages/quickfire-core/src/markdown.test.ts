import { describe, expect, it } from "vitest";
import { markdownToPlainText, parseInline, parseMarkdown } from "./markdown";

describe("markdown blocks", () => {
  it("projects common block structure for both renderers", () => {
    expect(
      parseMarkdown(
        "## Result\n\n- **ready**\n- use `panel_eval`\n\n> live state\n\n```ts title=a.ts\nconst ok = true;\n```",
      ),
    ).toEqual([
      expect.objectContaining({ kind: "heading", level: 2 }),
      expect.objectContaining({ kind: "list", ordered: false, tight: true }),
      expect.objectContaining({ kind: "quote" }),
      { kind: "code", language: "ts", meta: "title=a.ts", text: "const ok = true;" },
    ]);
  });

  it("keeps nested list structure instead of flattening it", () => {
    const [list] = parseMarkdown("- outer\n  - inner one\n  - inner two\n- second");
    expect(list).toMatchObject({ kind: "list", ordered: false });
    if (list?.kind !== "list") throw new Error("expected a list");
    expect(list.items).toHaveLength(2);
    expect(list.items[0]?.children[1]).toMatchObject({
      kind: "list",
      items: [expect.anything(), expect.anything()],
    });
  });

  it("reads ordered lists, their start number, and task state", () => {
    const [list] = parseMarkdown("3. first\n4. second");
    expect(list).toMatchObject({ kind: "list", ordered: true, start: 3 });

    const [tasks] = parseMarkdown("- [x] shipped\n- [ ] pending");
    if (tasks?.kind !== "list") throw new Error("expected a list");
    expect(tasks.items.map((item) => item.checked)).toEqual([true, false]);
    expect(markdownToPlainText([tasks])).toContain("[x] shipped");
  });

  it("parses GFM tables with alignment", () => {
    const [table] = parseMarkdown(
      "| Panel | State |\n| :--- | ---: |\n| Chat | open |\n| Terminal | closed |",
    );
    if (table?.kind !== "table") throw new Error("expected a table");
    expect(table.align).toEqual(["left", "right"]);
    expect(table.head.map((cell) => markdownToPlainText([{ kind: "paragraph", children: cell }]))).toEqual([
      "Panel",
      "State",
    ]);
    expect(table.rows).toHaveLength(2);
  });

  it("keeps loose and tight lists apart", () => {
    const [tight] = parseMarkdown("- a\n- b");
    const [loose] = parseMarkdown("- a\n\n- b");
    expect(tight).toMatchObject({ tight: true });
    expect(loose).toMatchObject({ tight: false });
  });

  it("reads setext headings, rules and indented code", () => {
    expect(parseMarkdown("Title\n=====")).toEqual([
      expect.objectContaining({ kind: "heading", level: 1 }),
    ]);
    expect(parseMarkdown("***")).toEqual([{ kind: "rule" }]);
    expect(parseMarkdown("    const a = 1;")).toEqual([
      { kind: "code", text: "const a = 1;", language: null, meta: null },
    ]);
  });

  it("shows markup it will not execute rather than dropping it", () => {
    expect(parseMarkdown("<div onclick='steal()'>hi</div>")).toEqual([
      { kind: "embed", label: "HTML", text: "<div onclick='steal()'>hi</div>" },
    ]);
    expect(parseMarkdown("```mdx\n<Chart data={rows} />\n```")).toEqual([
      { kind: "embed", label: "MDX", text: "<Chart data={rows} />" },
    ]);
  });

  it("treats an unterminated fence as code to the end, the way a stream looks", () => {
    expect(parseMarkdown("```py\nprint(1)\nprint(2)")).toEqual([
      { kind: "code", language: "py", meta: null, text: "print(1)\nprint(2)" },
    ]);
  });
});

describe("markdown inlines", () => {
  it("reads both emphasis spellings, strikethrough and nesting", () => {
    expect(parseInline("**bold** _italic_ ~~gone~~")).toEqual([
      { kind: "strong", children: [{ kind: "text", text: "bold" }] },
      { kind: "text", text: " " },
      { kind: "emphasis", children: [{ kind: "text", text: "italic" }] },
      { kind: "text", text: " " },
      { kind: "strike", children: [{ kind: "text", text: "gone" }] },
    ]);
    expect(parseInline("**bold with `code`**")).toMatchObject([
      { kind: "strong", children: [{ kind: "text" }, { kind: "code", text: "code" }] },
    ]);
  });

  it("leaves snake_case identifiers alone", () => {
    expect(parseInline("call panel_describe_tool now")).toEqual([
      { kind: "text", text: "call panel_describe_tool now" },
    ]);
  });

  it("links only destinations it would actually open", () => {
    expect(parseInline("[docs](https://example.com)")).toEqual([
      { kind: "link", href: "https://example.com", children: [{ kind: "text", text: "docs" }] },
    ]);
    // The words survive even though the destination is refused.
    expect(parseInline("[do not run](javascript:evil)")).toEqual([
      { kind: "text", text: "do not run" },
    ]);
  });

  it("autolinks bare and angled URLs without swallowing the sentence", () => {
    expect(parseInline("see https://example.com/a, then stop")).toEqual([
      { kind: "text", text: "see " },
      {
        kind: "link",
        href: "https://example.com/a",
        children: [{ kind: "text", text: "https://example.com/a" }],
      },
      { kind: "text", text: ", then stop" },
    ]);
    expect(parseInline("<https://example.com>")).toMatchObject([{ kind: "link" }]);
  });

  it("keeps images, escapes, entities and hard breaks", () => {
    expect(parseInline("![shot](https://example.com/a.png)")).toEqual([
      { kind: "image", src: "https://example.com/a.png", alt: "shot" },
    ]);
    expect(parseInline("2 \\* 3 &lt; 7")).toEqual([{ kind: "text", text: "2 * 3 < 7" }]);
    expect(parseInline("one  \ntwo")).toEqual([
      { kind: "text", text: "one" },
      { kind: "break" },
      { kind: "text", text: "two" },
    ]);
  });

  it("never eats text on an unmatched delimiter", () => {
    expect(parseInline("2 * 3 = 6 and 4 * 5")).toEqual([
      { kind: "text", text: "2 * 3 = 6 and 4 * 5" },
    ]);
    expect(parseInline("a `unclosed span")).toEqual([{ kind: "text", text: "a `unclosed span" }]);
  });
});
