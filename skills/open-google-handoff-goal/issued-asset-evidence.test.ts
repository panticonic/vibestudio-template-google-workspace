import { expect, it } from "vitest";
import { joinAssetEvidence } from "./issued-asset-evidence.js";
const base = { id: "owned", status: "current" as const, name: "Owned asset", mimeType: "text/plain", version: "1", content: null, permissions: null, missingChecks: [] };
const content = { intent: { messageId: "mail", fileId: "owned", mode: "content" as const }, asset: { ...base, content: { text: "actual bytes", sha256: "actual-hash" } } };
const audience = { intent: { ...content.intent, mode: "audience" as const }, asset: { ...base, permissions: [] } };
it("joins same-revision projections in either order without losing stronger issued evidence", () => {
  const combined = joinAssetEvidence(content, audience);
  expect(combined).toEqual(joinAssetEvidence(audience, content));
  expect(combined.intent.mode).toBe("content-and-audience");
  expect(joinAssetEvidence(combined, { intent: { ...content.intent, mode: "metadata" }, asset: base })).toEqual(combined);
});
it("never joins foreign source coordinates or stale/unknown versions", () => {
  for (const next of [{ ...audience, intent: { ...audience.intent, messageId: "foreign" } }, { ...audience, asset: { ...audience.asset, version: "2" } }])
    expect(joinAssetEvidence(content, next)).toEqual(next);
  expect(joinAssetEvidence({ ...content, asset: { ...content.asset, version: null } }, audience)).toEqual(audience);
});
