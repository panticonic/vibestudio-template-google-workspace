import { isDeepStrictEqual } from "node:util";
import { canonicalJson, sha256HexSyncText } from "@vibestudio/content-addressing";
import type { DrivePermission } from "@workspace/google-workspace/drive";
import { contextId as actualContextId, fs } from "@workspace/runtime";
import type { AssetEvidence, AssetIntent, HandoffDecision, HandoffOutcome, HandoffReceipt, MailThread } from "./program/types.js";
import { driveShortcut, handoffPermissionFields, mailboxScope, nativeDoc, ownedGoogleHandoffProvider, projectMail,
  type FileState, type ProviderRequest, type ProviderWorld } from "./provider.js";

type Freshness = "current" | "changed" | "unavailable";
type StageAuthority = "none" | "ready" | "decision";
export type OpenGoogleHandoffWorld = {
  id: string;
  goal: string;
  provider: ProviderWorld;
  canStage: StageAuthority;
  expected: {
    reviews: readonly AssetIntent[];
    decision: HandoffDecision;
    verify?: { before: HandoffDecision; result: Freshness };
    stage: boolean;
  };
};

const pageLimit = 8;
const maxBytes = 16 * 1024;
const modeHasContent = (mode: AssetIntent["mode"]) => mode === "content" || mode === "content-and-audience";
const modeHasAudience = (mode: AssetIntent["mode"]) => mode === "audience" || mode === "content-and-audience";
const supportedText = (mime: string | null) => mime === nativeDoc || mime?.startsWith("text/") === true;
const unavailable = (error: unknown) => error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : null;
const permission = (p: DrivePermission) => ({
  id: p.id, type: p.type, role: p.role, address: p.emailAddress ?? p.domain ?? null,
  deleted: p.deleted === true, pendingOwner: p.pendingOwner === true,
  directRoles: Array.isArray(p.permissionDetails) && p.permissionDetails.length
    ? [...new Set(p.permissionDetails.flatMap((detail) => detail.inherited === true || typeof detail.role !== "string" ? [] : [detail.role]))].sort()
    : [p.role],
});
const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);

function emptyAsset(id: string, status: AssetEvidence["status"]): AssetEvidence {
  return { id, status, name: null, mimeType: null, version: null, content: null, permissions: null, missingChecks: [] };
}

function sameIds(actual: string[] | undefined, expected: readonly string[]) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((id) => typeof id === "string") &&
    isDeepStrictEqual([...actual].sort(), [...expected].sort());
}

function sameDecision(value: HandoffDecision | undefined, expected: HandoffDecision) {
  return value?.status === expected.status && value.reason === expected.reason &&
    sameIds(value.mailIds, expected.mailIds) && sameIds(value.assetIds, expected.assetIds) &&
    (expected.facts ?? []).every((fact) => Array.isArray(value.facts) && value.facts.some((row) => isDeepStrictEqual(row, fact)));
}

type Reviewed = { intent: AssetIntent; asset: AssetEvidence };
function handoffBytes(decision: HandoffDecision, threads: MailThread[], reviews: Reviewed[]) {
  const mail = threads.flatMap(({ id: threadId, messages }) => messages
    .filter(({ id }) => decision.mailIds.includes(id))
    .map(({ id, from, subject, receivedAt }) => ({ id, threadId, from, subject, receivedAt })));
  const assets = reviews.map(({ asset, intent }) => {
    const { content, ...metadata } = asset;
    return { ...metadata, messageId: intent.messageId, contentSha256: content?.sha256 ?? null };
  });
  return canonicalJson({
    format: 1, status: decision.status, reason: decision.reason,
    assets: [...decision.assetIds].sort(), mail: mail.toSorted((a, b) => a.id.localeCompare(b.id)),
    reviewed: assets.toSorted((a, b) => a.id.localeCompare(b.id)),
  }) + "\n";
}

function expectedAsset(id: string, frame: FileState | number, mode: AssetIntent["mode"]): AssetEvidence {
  if (typeof frame === "number") return emptyAsset(id, frame === 404 ? "missing" : frame === 403 ? "inaccessible" : "unavailable");
  const mimeType = frame.metadata.mimeType ?? null;
  const status = frame.metadata.trashed ? "trashed" : mimeType === driveShortcut ? "shortcut" : "current";
  const asset = { ...emptyAsset(id, status), mimeType, name: frame.metadata.name ?? null, version: frame.metadata.version ?? null };
  if (status !== "current") return asset;
  if (modeHasContent(mode)) {
    if (typeof frame.bytes === "string" && supportedText(mimeType) && new TextEncoder().encode(frame.bytes).length <= maxBytes)
      asset.content = { text: frame.bytes, sha256: sha256HexSyncText(frame.bytes) };
    else asset.missingChecks.push("content");
  }
  if (modeHasAudience(mode)) {
    const rows = frame.permissions ?? [[]];
    if (rows.length <= pageLimit && rows.every((page) => typeof page !== "number"))
      asset.permissions = rows.flatMap((page) => typeof page === "number" ? [] : page).map(permission).toSorted(byId);
    else asset.missingChecks.push("audience");
  }
  return asset;
}

function expectedReads(world: OpenGoogleHandoffWorld): ProviderRequest[] {
  const rows: ProviderRequest[] = [];
  function add(op: ProviderRequest["op"], id: string | null, status = 200, cursor: string | null = null) {
    rows.push({ op, id, status, cursor });
  }
  function pages<T>(items: readonly (readonly T[] | number)[], op: "mail-list" | "drive-permissions", id: string | null) {
    const values: T[] = [];
    for (const [i, page] of items.slice(0, pageLimit).entries()) {
      add(op, id, typeof page === "number" ? page : 200, i ? "p" + i : null);
      if (typeof page === "number") return null;
      values.push(...page);
    }
    return items.length <= pageLimit ? values : null;
  }
  function mail(fresh: boolean, previous: string[] = []) {
    const found = pages(fresh ? world.provider.nextPages ?? world.provider.pages : world.provider.pages, "mail-list", null);
    if (!found) return null;
    const ids = [...new Set(found)];
    if (fresh && !sameIds(ids, previous)) return null;
    for (const id of ids) {
      const thread = world.provider.threads.find((thread) => thread.id === id)!;
      const record = fresh ? thread.next ?? thread.status ?? 200 : thread.status ?? 200;
      add("mail-thread", id, typeof record === "number" ? record : 200);
    }
    return ids;
  }
  function drive(intent: AssetIntent, fresh: boolean) {
    const file = world.provider.files.find(({ id }) => id === intent.fileId)!;
    const frame = fresh ? file.next ?? file.initial : file.initial;
    add("drive-file", file.id, typeof frame === "number" ? frame : 200);
    if (typeof frame === "number" || frame.metadata.trashed || frame.metadata.mimeType === driveShortcut) return;
    const mime = frame.metadata.mimeType ?? null;
    if (modeHasContent(intent.mode) && supportedText(mime))
      add(mime === nativeDoc ? "drive-export" : "drive-media", file.id, typeof frame.bytes === "number" ? frame.bytes : frame.bytes === undefined ? 404 : 200);
    if (modeHasAudience(intent.mode)) pages(frame.permissions ?? [[]], "drive-permissions", file.id);
  }
  const initial = mail(false);
  for (const intent of world.expected.reviews) drive(intent, false);
  if (world.expected.verify) {
    const current = mail(true, initial ?? []);
    if (current) for (const intent of world.expected.reviews) drive(intent, true);
  }
  return rows;
}

function sameReads(actual: ProviderRequest[], expected: ProviderRequest[]) {
  if (actual.length !== expected.length) return false;
  const ids = new Set(expected.map(({ id }) => id));
  return [...ids].every((id) => isDeepStrictEqual(
    actual.filter((row) => row.id === id), expected.filter((row) => row.id === id),
  ));
}

export async function prepareOpenGoogleHandoffGoal(input: { contextId: string; caseId: string }, world: OpenGoogleHandoffWorld) {
  if (input.contextId !== actualContextId || input.caseId !== world.id) throw new Error("Use the owned handoff workspace context");
  const provider = ownedGoogleHandoffProvider(world.provider);
  let listing: { ids: string[]; complete: boolean } | null = null;
  const threads = new Map<string, MailThread | null>();
  const reviews = new Map<string, Reviewed>();
  let verified: { decision: HandoffDecision; result: Freshness } | null = null;
  let artifact: HandoffReceipt | null = null;
  let busy = false;

  async function exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (busy) throw new Error("Wait for the current provider operation");
    busy = true;
    try { return await run(); }
    finally { busy = false; }
  }
  async function listMail() {
    const ids = new Set<string>();
    let pageToken: string | undefined;
    try {
      for (let page = 0; page < pageLimit; page++) {
        const result = await provider.gmail.listThreads({ q: mailboxScope, pageToken });
        for (const { id } of result.threads) ids.add(id);
        pageToken = result.nextPageToken;
        if (!pageToken) return { ids: [...ids], complete: true };
      }
    } catch (error) {
      if (!unavailable(error)) throw error;
    }
    return { ids: [], complete: false };
  }
  async function readMail(id: string) {
    try { return projectMail(await provider.gmail.getThread(id, { format: "full" })); }
    catch (error) { if (!unavailable(error)) throw error; return null; }
  }
  const observedThreads = () => [...threads.values()].filter((thread): thread is MailThread => thread !== null);
  const observedReviews = () => [...reviews.values()];
  const completeMail = () => listing?.complete === true && listing.ids.every((id) => threads.get(id));
  const supportedFacts = (decision: HandoffDecision | undefined) =>
    decision?.facts === undefined || (Array.isArray(decision.facts) && decision.facts.every((fact) =>
      typeof fact?.quote === "string" && fact.quote.trim().length > 0 && fact.quote.length <= 160 &&
      decision.assetIds.includes(fact.fileId) && reviews.get(fact.fileId)?.asset.content?.text.includes(fact.quote)));

  async function readAudience(id: string) {
    const values = [];
    let pageToken: string | undefined;
    try {
      for (let page = 0; page < pageLimit; page++) {
        const result = await provider.drive.listPermissions(id, { pageToken, fields: handoffPermissionFields });
        values.push(...(result.permissions ?? []).map(permission));
        pageToken = result.nextPageToken;
        if (!pageToken) return values.toSorted(byId);
      }
    } catch (error) { if (!unavailable(error)) throw error; }
    return null;
  }
  async function readAsset({ fileId: id, mode }: AssetIntent) {
    const asset = emptyAsset(id, "current");
    try {
      const { id: observedId, name, mimeType, version, trashed } = await provider.drive.getFile(id);
      if (observedId !== id) throw new Error("Drive returned metadata for another asset");
      Object.assign(asset, { name: name ?? null, mimeType: mimeType ?? null, version: version ?? null });
      if (trashed) asset.status = "trashed";
      else if (mimeType === driveShortcut) asset.status = "shortcut";
    } catch (error) {
      const status = unavailable(error);
      if (!status) throw error;
      return emptyAsset(id, status === 404 ? "missing" : status === 403 ? "inaccessible" : "unavailable");
    }
    if (asset.status !== "current") return asset;
    if (modeHasContent(mode)) {
      try {
        if (supportedText(asset.mimeType)) {
          const body = asset.mimeType === nativeDoc ? await provider.drive.exportFileBytes(id, "text/plain") :
            await provider.drive.downloadFileBytes(id);
          if (body.bytes.length <= maxBytes) {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(body.bytes);
            asset.content = { text, sha256: sha256HexSyncText(text) };
          }
        }
      } catch (error) { if (!unavailable(error) && !(error instanceof TypeError)) throw error; }
      if (!asset.content) asset.missingChecks.push("content");
    }
    if (modeHasAudience(mode)) {
      asset.permissions = await readAudience(id);
      if (!asset.permissions) asset.missingChecks.push("audience");
    }
    return asset;
  }
  const services = {
    googleHandoffMail: {
      discover: () => exclusive(async () => {
        listing ??= await listMail();
        return structuredClone(listing);
      }),
      read: (id: string) => exclusive(async () => {
        if (!listing?.complete || !listing.ids.includes(id) || verified)
          throw new Error("Read only a thread discovered in this mail scope");
        if (!threads.has(id)) threads.set(id, await readMail(id));
        return structuredClone(threads.get(id) ?? null);
      }),
    },
    googleHandoffDrive: {
      inspect: (intent: AssetIntent) => exclusive(async () => {
        const message = observedThreads().flatMap(({ messages }) => messages).find(({ id }) => id === intent.messageId);
        if (!completeMail() || !message?.fileIds.includes(intent.fileId) || reviews.has(intent.fileId) || verified ||
            !["metadata", "content", "audience", "content-and-audience"].includes(intent.mode))
          throw new Error("Review each observed message link once with the required Drive evidence");
        const asset = await readAsset(intent);
        reviews.set(asset.id, { intent: structuredClone(intent), asset });
        return structuredClone(asset);
      }),
    },
    googleHandoffFreshness: {
      verify: (decision: HandoffDecision) => exclusive(async () => {
        const mail = observedThreads().flatMap(({ messages }) => messages);
        if (!completeMail() || verified || !supportedFacts(decision) || !decision.mailIds.every((id) => mail.some((message) => message.id === id)) ||
            !decision.assetIds.every((id) => reviews.has(id)) || (decision.status !== "ready" && decision.status !== "held"))
          throw new Error("Verify an observed completed handoff decision once");
        const current = await listMail();
        let result: Freshness = !current.complete ? "unavailable" : sameIds(current.ids, listing!.ids) ? "current" : "changed";
        if (result === "current") {
          for (const id of current.ids) {
            const thread = await readMail(id);
            if (!thread) result = "unavailable";
            else if (result === "current" && !isDeepStrictEqual(thread, threads.get(id))) result = "changed";
          }
          for (const { intent, asset } of reviews.values()) {
            const fresh = await readAsset(intent);
            if (fresh.status === "unavailable" || fresh.missingChecks.length) result = "unavailable";
            else if (result === "current" && !isDeepStrictEqual(fresh, asset)) result = "changed";
          }
        }
        verified = { decision: structuredClone(decision), result };
        return result;
      }),
    },
    googleHandoffScratch: {
      stage: (decision: HandoffDecision) => exclusive(async () => {
        const permitted = world.canStage === "decision" || (world.canStage === "ready" && decision.status === "ready");
        if (!permitted || artifact || verified?.result !== "current" || !sameDecision(decision, verified.decision) || !supportedFacts(decision) ||
            !decision.mailIds.length || (decision.status === "ready" && (!decision.assetIds.length ||
              decision.assetIds.some((id) => reviews.get(id)?.asset.status !== "current" || reviews.get(id)?.asset.missingChecks.length))))
          throw new Error("Save an authorized, current decision supported by observed provider evidence");
        const path = (await fs.mkdtemp("google-workspace-handoff")) + "/handoff.json";
        const bytes = handoffBytes(decision, observedThreads(), observedReviews());
        await fs.writeFile(path, bytes);
        if (await fs.readFile(path, "utf8") !== bytes) throw new Error("The handoff did not retain the verified decision");
        artifact = { path, sha256: sha256HexSyncText(bytes) };
        return { ...artifact };
      }),
    },
  };

  async function verify(value: unknown) {
    const outcome = value as Partial<HandoffOutcome> | null;
    const witness = verified as { decision: HandoffDecision; result: Freshness } | null;
    const trace = provider.trace();
    const handoffText = artifact ? await fs.readFile(artifact.path, "utf8") : null;
    const statuses = expectedReads(world);
    const expectedReviews = world.expected.reviews.map((intent) => {
      const file = world.provider.files.find(({ id }) => id === intent.fileId)!;
      return { intent, asset: expectedAsset(file.id, file.initial, intent.mode) };
    });
    const checks = {
      reconciledGoogleHandoffDecision: sameDecision(outcome?.decision, world.expected.decision) && supportedFacts(outcome?.decision),
      verifiedGoogleHandoffProviderReads: sameReads(trace.requests, statuses),
      boundGoogleHandoffAssets: reviews.size === expectedReviews.length &&
        expectedReviews.every((review) => isDeepStrictEqual(reviews.get(review.intent.fileId), review)),
      verifiedGoogleHandoffFreshness: world.expected.verify ? witness?.result === world.expected.verify.result &&
        sameDecision(witness.decision, world.expected.verify.before) : witness === null,
      verifiedGoogleHandoffArtifact: world.expected.stage ? Boolean(artifact && handoffText &&
        isDeepStrictEqual(outcome?.handoff, artifact) && artifact.sha256 === sha256HexSyncText(handoffText) &&
        handoffText === handoffBytes(world.expected.decision, observedThreads(), expectedReviews)) :
        artifact === null && outcome?.handoff === null,
      preservedGoogleHandoffAuthority: trace.denied === 0 && sameIds(trace.credentialIds,
        world.expected.reviews.length ? ["handoff-mail-fixture", "handoff-drive-fixture"] : ["handoff-mail-fixture"]),
    };
    return { ok: Object.values(checks).every(Boolean), checks, threads: observedThreads(),
      reviews: observedReviews(), providerRequests: trace.requests, freshness: witness, handoff: artifact, handoffText };
  }
  async function qualify() {
    const found = await services.googleHandoffMail.discover();
    if (found.complete) for (const id of found.ids) await services.googleHandoffMail.read(id);
    for (const intent of world.expected.reviews) await services.googleHandoffDrive.inspect(intent);
    if (world.expected.verify) await services.googleHandoffFreshness.verify(world.expected.verify.before);
    const decision = world.expected.decision;
    const handoff = world.expected.stage ? await services.googleHandoffScratch.stage(decision) : null;
    return verify({ decision, handoff });
  }
  return { goal: world.goal, services, verify, qualify };
}
