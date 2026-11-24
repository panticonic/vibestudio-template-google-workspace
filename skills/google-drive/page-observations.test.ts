import { expect, it } from "vitest";
import { observePages, observePageChain } from "./page-observations.js";
it("replaces retried pages and excludes stale continuations from a changed provider chain", () => {
  const pages = new Map<string | null, { next: string | null; rows: string[] }>([
    [null, { next: "tail", rows: ["original"] }], ["tail", { next: null, rows: ["later"] }],
  ]);
  expect(observePages(pages)).toEqual({ rows: ["original", "later"], complete: true, incomplete: false });
  pages.set(null, { next: null, rows: ["current"] });
  expect(observePages(pages)).toEqual({ rows: ["current"], complete: true, incomplete: false });
  pages.set(null, { next: "unread", rows: ["current"] });
  expect(observePages(pages).complete).toBe(false);
});

it("binds an interrupted change chain to its actual continuation and rejects a loop",()=>{
  const pages=new Map<string|null,{next:string|null;rows:string[]}>([["saved",{next:"tail",rows:["observed"]}]]);
  expect(observePageChain(pages,"saved")).toEqual({rows:["observed"],complete:false,incomplete:false,cursors:["saved"],frontier:"tail"});
  pages.set("tail",{next:"saved",rows:[]});
  expect(observePageChain(pages,"saved")).toMatchObject({complete:false,incomplete:true,frontier:"saved"});
});
