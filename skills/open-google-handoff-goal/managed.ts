import {assessObservedApplicationOutcome} from "@workspace/application-outcomes/observed-application-outcome";
import type {InvocationObservations} from "@workspace/application-outcomes/observed-invocation";
import type {SemanticOutcomeContract} from "@workspace/application-outcomes/semantic-outcome-contract";
import { joinAssetEvidence } from "./issued-asset-evidence.js";
import { isDeepStrictEqual } from "node:util";
import { serializeByKey } from "@vibestudio/shared/keyedSerializer";
import { canonicalJson, sha256HexSyncText } from "@vibestudio/content-addressing";
import type { DrivePermission } from "@workspace/google-workspace/drive";
import { contextId as actualContextId, fs } from "@workspace/runtime";
import type { AssetEvidence, AssetIntent, HandoffDecision, HandoffOutcome, HandoffReceipt, MailThread } from "./program/types.js";
import { driveShortcut, handoffPermissionFields, mailboxScope, nativeDoc, ownedGoogleHandoffProvider, projectMail,
  type FileState, type ProviderWorld } from "./provider.js";

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

type HandoffFact = NonNullable<HandoffDecision["facts"]>[number];
function sameDecision(value: HandoffDecision | undefined, expected: HandoffDecision,
  matchFact: (actual: HandoffFact, required: HandoffFact) => boolean = isDeepStrictEqual) {
  return value?.status === expected.status && value.reason === expected.reason &&
    sameIds(value.mailIds, expected.mailIds) && sameIds(value.assetIds, expected.assetIds) &&
    (expected.facts ?? []).every((fact) => Array.isArray(value.facts) && value.facts.some((row) => matchFact(row, fact)));
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

export async function prepareOpenGoogleHandoffGoal(input: { contextId: string; caseId: string }, world: OpenGoogleHandoffWorld) {
  if (input.contextId !== actualContextId || input.caseId !== world.id) throw new Error("Use the owned handoff workspace context");
  const provider = ownedGoogleHandoffProvider(world.provider);
  let listing: { ids: string[]; complete: boolean } | null = null;
  const threads = new Map<string, MailThread | null>();
  const reviews = new Map<string, Reviewed>();
  let verified: { decision: HandoffDecision; result: Freshness } | null = null;
  let artifact: HandoffReceipt | null = null;
  let stagedBytes:string|null=null;
  const pending = new Map<string, Promise<unknown>>();

  function runInOrder<T>(run: () => Promise<T>): Promise<T> {
    return serializeByKey(pending, "provider", run);
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
  const reviewKey = (intent: AssetIntent) => JSON.stringify([intent.messageId, intent.fileId]);
  const observedReviews = () => [...reviews.values()];
  const reviewsForFile = (id: string) => observedReviews().filter(({ asset }) => asset.id === id);
  const completeMail = () => listing?.complete === true && listing.ids.every((id) => threads.get(id));
  const supportedFacts = (decision: HandoffDecision | undefined) =>
    decision?.facts === undefined || (Array.isArray(decision.facts) && decision.facts.every((fact) =>
      typeof fact?.quote === "string" && fact.quote.trim().length > 0 && fact.quote.length <= 160 &&
      decision.assetIds.includes(fact.fileId) && reviewsForFile(fact.fileId).some(({ asset }) => asset.content?.text.includes(fact.quote))));
  const meetsExpectedDecision = (decision: HandoffDecision | undefined, expected: HandoffDecision) =>
    sameDecision(decision, expected, (excerpt, anchor) =>
      excerpt?.fileId === anchor.fileId && typeof excerpt.quote === "string" && excerpt.quote.includes(anchor.quote)) &&
    supportedFacts(decision);

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
      discover: () => runInOrder(async () => {
        listing ??= await listMail();
        return structuredClone(listing);
      }),
      read: (id: string) => runInOrder(async () => {
        if (!listing?.complete || !listing.ids.includes(id))
          throw new Error("Read only a thread discovered in this mail scope");
        if (!threads.has(id)) threads.set(id, await readMail(id));
        return structuredClone(threads.get(id) ?? null);
      }),
    },
    googleHandoffDrive: {
      inspect: (intent: AssetIntent) => runInOrder(async () => {
        const cached = reviews.get(reviewKey(intent));
        if (cached && cached.asset.status !== "unavailable" && !cached.asset.missingChecks.length && isDeepStrictEqual(cached.intent, intent)) return structuredClone(cached.asset);
        const message = observedThreads().flatMap(({ messages }) => messages).find(({ id }) => id === intent.messageId);
        if (!completeMail() || !message?.fileIds.includes(intent.fileId) || artifact ||
            !["metadata", "content", "audience", "content-and-audience"].includes(intent.mode))
          throw new Error("Review an observed message link with the required Drive evidence");
        const asset = await readAsset(intent);
        const joined = joinAssetEvidence(cached, { intent: structuredClone(intent), asset });
        if (!isDeepStrictEqual(cached, joined)) verified = null;
        reviews.set(reviewKey(intent), joined);
        return structuredClone(asset);
      }),
    },
    googleHandoffFreshness: {
      verify: (decision: HandoffDecision) => runInOrder(async () => {
        if (verified && sameDecision(decision, verified.decision)) return verified.result;
        const mail = observedThreads().flatMap(({ messages }) => messages);
        if (!completeMail() || artifact || !supportedFacts(decision) || !decision.mailIds.every((id) => mail.some((message) => message.id === id)) ||
            !decision.assetIds.every((id) => reviewsForFile(id).length > 0) || (decision.status !== "ready" && decision.status !== "held"))
          throw new Error("Verify an observed completed handoff decision");
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
      stage: (decision: HandoffDecision) => runInOrder(async () => {
        if (artifact && verified && sameDecision(decision, verified.decision)) return { ...artifact };
        const permitted = world.canStage === "decision" || (world.canStage === "ready" && decision.status === "ready");
        if (!permitted || artifact || verified?.result !== "current" || !sameDecision(decision, verified.decision) || !supportedFacts(decision) ||
            !decision.mailIds.length || (decision.status === "ready" && (!decision.assetIds.length ||
              decision.assetIds.some((id) => reviewsForFile(id).some(({ asset }) => asset.status !== "current" || asset.missingChecks.length)))))
          throw new Error("Save an authorized, current decision supported by observed provider evidence");
        const path = (await fs.mkdtemp("google-workspace-handoff")) + "/handoff.json";
        const bytes = handoffBytes(decision, observedThreads(), observedReviews());
        stagedBytes=bytes;
        await fs.writeFile(path, bytes);
        if (await fs.readFile(path, "utf8") !== bytes) throw new Error("The handoff did not retain the verified decision");
        artifact = { path, sha256: sha256HexSyncText(bytes) };
        return { ...artifact };
      }),
    },
  };

  async function verify(value: unknown,invocation?:InvocationObservations) {
    const outcome = value as Partial<HandoffOutcome> | null;
    const witness = verified as { decision: HandoffDecision; result: Freshness } | null;
    const trace = provider.trace();
    const handoffText = artifact ? await fs.readFile(artifact.path, "utf8") : null;
    const expectedReviews = world.expected.reviews.map((intent) => {
      const file = world.provider.files.find(({ id }) => id === intent.fileId)!;
      return { intent, asset: expectedAsset(file.id, file.initial, intent.mode) };
    });
    const checks = {
      returnedGoogleHandoff:isDeepStrictEqual(outcome?.handoff,artifact),
      reconciledGoogleHandoffDecision: meetsExpectedDecision(outcome?.decision, world.expected.decision),
      boundGoogleHandoffAssets: expectedReviews.every(({ intent }) => {
        const actual = reviews.get(reviewKey(intent));
        const source = world.provider.files.find(file => file.id === intent.fileId)!;
        return Boolean(actual && (!modeHasContent(intent.mode) || modeHasContent(actual.intent.mode)) &&
          (!modeHasAudience(intent.mode) || modeHasAudience(actual.intent.mode)) &&
          isDeepStrictEqual(actual.asset, expectedAsset(source.id, source.initial, actual.intent.mode)));
      }),
      verifiedGoogleHandoffFreshness: world.expected.verify ? witness?.result === world.expected.verify.result &&
        meetsExpectedDecision(witness.decision, world.expected.verify.before) : witness === null,
      verifiedGoogleHandoffArtifact: world.expected.stage ? Boolean(artifact && handoffText &&
        artifact.sha256 === sha256HexSyncText(handoffText) &&
        handoffText === stagedBytes) :
        artifact === null,
      preservedGoogleHandoffAuthority: trace.denied === 0 && sameIds(trace.credentialIds,
        reviews.size ? ["handoff-mail-fixture", "handoff-drive-fixture"] : ["handoff-mail-fixture"]),
    };
    const contract:SemanticOutcomeContract={effects:{checks:["boundGoogleHandoffAssets", "verifiedGoogleHandoffFreshness", "verifiedGoogleHandoffArtifact", "preservedGoogleHandoffAuthority"],rationale:"Independent native observations, authority and persisted state establish application effects."},returnedValue:{checks:["reconciledGoogleHandoffDecision"],required:true,rationale:"These are the actual requested domain findings or query values; mutation-only calls retain their separately observed effects."},incidentalValues:{checks:["returnedGoogleHandoff"],rationale:"Optional incorrect mutation returns are recorded against the actual invocation, without invalidating correct native effects."}};

    const assessed=await assessObservedApplicationOutcome({ passed: Object.values(checks).every(Boolean), contextId: input.contextId, caseId: input.caseId,
      goal: world.goal, checks, threads: observedThreads(),
      reviews: observedReviews(), providerRequests: trace.requests, freshness: witness, handoff: artifact, handoffText },contract,value,invocation,[{checks:["returnedGoogleHandoff","reconciledGoogleHandoffDecision"],rootPath:["handoff"],producerSourceSuffix:"reconcileGoogleHandoff/finishHandoff.nl",producerPath:["handoff"]}]);
    const {observedChecks,...dimensions}=assessed;
    return {...dimensions,checks:observedChecks};
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
