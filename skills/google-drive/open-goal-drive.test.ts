import { expect, it } from "vitest";
import { prepareOpenGoalDrive, type OpenDriveWorld } from "./open-goal-drive.js";

const owner = { contextId: "owned-context", caseId: "shared-drive-review" };
const type = "application/vnd.google-apps.document";

function auditWorld(qualifier = "", incomplete = false): OpenDriveWorld {
  const id = qualifier + "target";
  const folderId = qualifier + "main_folder";
  const risk = qualifier + "public_link";
  const tail = qualifier + "tail";
  return {
    goal: "Find the current handoff document and report public direct access without editing sharing.",
    folders: [
      { id: qualifier + "archive_folder", name: "Archive", description: "Old records", driveId: "archive", pages: [
        { cursor: null, response: { files: [] } },
      ] },
      { id: folderId, name: "Current", description: "Latest material", driveId: "current", pages: [
        { cursor: null, response: { nextPageToken: tail, files: [
          { id, name: "Handoff", mimeType: type },
        ] } },
        { cursor: tail, response: incomplete ? null : { files: [] } },
      ] },
    ],
    permissionPages: {
      [id]: [{ cursor: null, response: { permissions: [{ id: risk, type: "anyone", role: "reader" }] } }],
    },
    expected: {
      mode: "audit", folderId, inventoryIds: [id],
      gate: incomplete ? "inventory-partial" : "audited",
      status: incomplete ? "partial" : "complete",
      ids: incomplete ? [] : [risk],
      profile: { allowedDomains: ["example.test"], allowWriters: false },
      requiredTerms: incomplete ? [] : ["anyone"],
    },
  };
}

it("validates the observed inventory and permission audit after provider resource aliases", async () => {
  for (const qualifier of ["", "alias_"]) {
    const prepared = prepareOpenGoalDrive(owner, auditWorld(qualifier));
    const proof = await prepared.qualify();
    expect(proof.passed).toBe(true);
    expect(proof.requests).toEqual([
      { kind: "folder", resource: qualifier + "main_folder", cursor: null, status: 200 },
      { kind: "folder", resource: qualifier + "main_folder", cursor: qualifier + "tail", status: 200 },
      { kind: "permissions", resource: qualifier + "target", cursor: null, status: 200 },
    ]);
  }
});

it("keeps permission reads closed after a partial folder and rejects a claimed complete audit", async () => {
  const prepared = prepareOpenGoalDrive(owner, auditWorld("", true));
  const proof = await prepared.qualify();
  expect(proof.passed).toBe(true);
  expect(proof.requests.at(-1)).toMatchObject({ cursor: "tail", status: 503 });
  await expect(prepared.services.googleWorkspaceRead.readPermissions("target", null))
    .rejects.toThrow("complete Drive listing");
  const claimed = prepared.verify({ status: "complete", action: "none", ids: ["public_link"], checkpoint: null,
      findings: ["anyone link"], inventoryAudit: { gate: "audited", inventoryIds: ["target"] } });
  expect(claimed.checks.boundDriveOutcome).toBe(false);
  expect(claimed.passed).toBe(false);
});

it("uses independent folder cursors and accepts harmless exploration of another authorized folder", async () => {
  const prepared = prepareOpenGoalDrive(owner, auditWorld());
  const { googleGoalDiscovery, googleWorkspaceRead } = prepared.services;
  await googleWorkspaceRead.readiness();
  const scope = await googleGoalDiscovery.discover();
  expect(scope.folders.map(({ id }) => id)).toEqual(["archive_folder", "main_folder"]);
  expect(JSON.stringify(scope)).not.toMatch(/target|tail|audited|anyone/);
  const page = await googleWorkspaceRead.listFolder("main_folder", null);
  await expect(googleWorkspaceRead.listFolder("archive_folder", page.next)).rejects.toThrow("outside this assigned read");
  await googleWorkspaceRead.listFolder("archive_folder", null);
  await expect(googleWorkspaceRead.listFolder("foreign", null)).rejects.toThrow("outside the assigned Drive read");
  await googleWorkspaceRead.listFolder("main_folder", page.next);
  await Promise.all([
    googleWorkspaceRead.readPermissions("target", null),
    googleWorkspaceRead.readPermissions("target", null),
  ]);
  await googleWorkspaceRead.listFolder("main_folder", null);
  await googleWorkspaceRead.readPermissions("target", null);
  const wrong = prepared.verify({ status: "complete", action: "none", ids: ["public_link"], checkpoint: null,
      findings: ["anyone link"], inventoryAudit: { gate: "audited", inventoryIds: ["target"] } });
  expect(wrong.checks.boundDriveOutcome).toBe(true);
  expect(wrong.checks.boundDriveObservations).toBe(true);
  expect(wrong.passed).toBe(true);
});

it("binds each reported change to its latest provider disposition", async () => {
  const prepared = prepareOpenGoalDrive(owner, {
    goal: "Summarize each final change in the current feed.",
    folders: [],
    changeSource: { cursor: "initial", name: "Current", driveId: "current", pages: [
      { cursor: "initial", response: { nextPageToken: "tail", changes: [
        { fileId: "draft", file: { name: "Draft" } }, { fileId: "map", file: { name: "Map" } },
      ] } },
      { cursor: "tail", response: { newStartPageToken: "verified", changes: [{ fileId: "draft", removed: true }] } },
    ] },
    expected: { mode: "changes", status: "complete", ids: ["draft", "map"],
      checkpoint: "verified", requiredTerms: ["remov", "updat"] },
  });
  expect((await prepared.qualify()).passed).toBe(true);
  await prepared.services.googleWorkspaceRead.readChanges("initial");
  const repeated=prepared.verify({status:"complete",action:"none",ids:["draft","map"],checkpoint:"verified",findings:["Draft removed","Map updated"],driveDelta:[
    {fileId:"draft",removed:true,name:null,time:null},{fileId:"map",removed:false,name:"Map",time:null}]});
  expect(repeated.passed).toBe(true);expect(repeated.observed.terminal).toBe("verified");
  const swapped = prepared.verify({ status: "complete", action: "none", ids: ["draft", "map"], checkpoint: "verified",
      findings: ["Draft updated", "Map removed"], driveDelta: [
        { fileId: "draft", name: null, time: null, removed: false },
        { fileId: "map", name: "Map", time: null, removed: true },
      ] });
  expect(swapped.checks.groundedDriveFindings).toBe(true);
  expect(swapped.checks.boundDriveOutcome).toBe(false);
  expect(swapped.passed).toBe(false);
});

it("preserves the saved checkpoint and exact observed delta when continuation is unavailable",async()=>{
  const world:OpenDriveWorld={goal:"Hand over observed changes and preserve the checkpoint when the rest is unavailable.",folders:[],
    changeSource:{cursor:"saved",name:"Current",driveId:"current",pages:[{cursor:"saved",response:{nextPageToken:"tail",changes:[{fileId:"map",file:{name:"Map"}}]}},{cursor:"tail",response:null}]},
    expected:{mode:"changes",status:"partial",ids:["map"],checkpoint:"saved",requiredTerms:["updat"]}};
  const prepared=prepareOpenGoalDrive(owner,world);
  const report={status:"partial",action:"none",ids:["map"],checkpoint:"saved",findings:["Map updated; partial coverage. Resume from the saved checkpoint."],driveDelta:[{fileId:"map",removed:false,name:"Map",time:null}]};
  await prepared.services.googleWorkspaceRead.readiness();await prepared.services.googleGoalDiscovery.discover();
  expect(prepared.verify(report).checks.boundDriveObservations).toBe(false);
  await prepared.services.googleWorkspaceRead.readChanges("saved");
  expect(prepared.verify(report).checks.boundDriveObservations).toBe(false);
  await expect(prepared.services.googleWorkspaceRead.readChanges("tail")).rejects.toThrow();
  const proof=prepared.verify(report);expect(proof.passed).toBe(true);
  expect(proof.observed.terminal).toBeNull();expect(proof.observed.frontier).toBe("tail");
  expect(prepared.verify({...report,status:"complete",checkpoint:"invented"}).passed).toBe(false);
  expect(prepared.verify({...report,checkpoint:"tail"}).passed).toBe(false);
  expect(prepared.verify({...report,driveDelta:[{...report.driveDelta[0],removed:true}]}).passed).toBe(false);
  expect((await prepareOpenGoalDrive(owner,world).qualify()).passed).toBe(true);
});
