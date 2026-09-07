/** Small value vocabulary shared by the durable semantic state machine and
 * deterministic workspace-fact primitives. This package does not own a second
 * in-memory semantic graph. */

export type StateNodeRef =
  | { kind: "event"; eventId: string }
  | { kind: "application"; applicationId: string };

export type ContentKind = "text" | "bytes";
export type ContentCoordinateKind = "utf16" | "byte";

/** The exact address space of one immutable content state. Byte length serves
 * storage and transport; coordinate extent serves semantic edits and blame. */
export interface ContentDescriptor {
  contentKind: ContentKind;
  byteLength: number;
  coordinateExtent: number;
}

export const contentCoordinateKind = (
  content: Pick<ContentDescriptor, "contentKind">
): ContentCoordinateKind => (content.contentKind === "text" ? "utf16" : "byte");

export interface ContentMapping {
  coordinateKind: ContentCoordinateKind;
  childContentHash: string;
  childStart: number;
  childEnd: number;
  parentContentHash: string;
  parentStart: number;
  parentEnd: number;
  digest: string;
}
