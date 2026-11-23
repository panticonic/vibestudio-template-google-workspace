import { isDeepStrictEqual } from "node:util";
import type { AssetEvidence, AssetIntent } from "./program/types.js";
type Reviewed = { intent: AssetIntent; asset: AssetEvidence };
/** Join projections of the same native revision; new revisions replace old evidence. */
export function joinAssetEvidence(previous: Reviewed | undefined, next: Reviewed): Reviewed {
  if (!previous || previous.intent.messageId !== next.intent.messageId || previous.asset.status !== "current" || previous.asset.version === null) return next;
  const base = ({ content: _content, permissions: _permissions, missingChecks: _missing, ...metadata }: AssetEvidence) => metadata;
  if (!isDeepStrictEqual(base(previous.asset), base(next.asset))) return next;
  const hasContent = (mode: AssetIntent["mode"]) => mode === "content" || mode === "content-and-audience";
  const hasAudience = (mode: AssetIntent["mode"]) => mode === "audience" || mode === "content-and-audience";
  const content = hasContent(previous.intent.mode) || hasContent(next.intent.mode);
  const audience = hasAudience(previous.intent.mode) || hasAudience(next.intent.mode);
  const mode = content && audience ? "content-and-audience" : content ? "content" : audience ? "audience" : "metadata";
  // A newly requested projection is authoritative even when unavailable; a
  // metadata-only observation cannot erase an already issued content/audience projection.
  return { intent: { ...next.intent, mode }, asset: { ...next.asset,
    content: hasContent(next.intent.mode) ? next.asset.content : previous.asset.content,
    permissions: hasAudience(next.intent.mode) ? next.asset.permissions : previous.asset.permissions,
    missingChecks: [...new Set([...previous.asset.missingChecks, ...next.asset.missingChecks])].filter(check =>
      check === "content" ? (hasContent(next.intent.mode) ? next.asset.content : previous.asset.content) === null :
      check === "audience" ? (hasAudience(next.intent.mode) ? next.asset.permissions : previous.asset.permissions) === null : true),
  } };
}
