import type {
  VcsCommitInput,
  VcsEditChange,
  VcsEditInput,
  VcsStateNodeRef,
} from "@vibestudio/service-schemas/vcs";
import type { ToolEditingVcs } from "../tool-vcs.js";
import { sha256Hex } from "@vibestudio/content-addressing";
import { base64ToBytes } from "../portable-bytes.js";

export interface StubVcsInit {
  files?: Record<string, string>;
  binaryFiles?: Record<string, string>;
  modes?: Record<string, number>;
}

function normalize(path: string): string {
  return path.replace(/^\/+/, "");
}

export class StubVcs implements ToolEditingVcs {
  readonly files = new Map<string, string>();
  readonly binaryFiles = new Map<string, string>();
  readonly modes = new Map<string, number>();
  lastEditInput?: VcsEditInput;
  lastCommitInput?: VcsCommitInput;
  private version = 0;
  private committedEventId = "event:committed";

  constructor(init?: StubVcsInit) {
    for (const [path, text] of Object.entries(init?.files ?? {})) {
      this.files.set(normalize(path), text);
    }
    for (const [path, base64] of Object.entries(init?.binaryFiles ?? {})) {
      this.binaryFiles.set(normalize(path), base64);
    }
    for (const [path, mode] of Object.entries(init?.modes ?? {})) {
      this.modes.set(normalize(path), mode);
    }
  }

  private workingHead(): VcsStateNodeRef {
    return this.version === 0
      ? { kind: "event", eventId: this.committedEventId }
      : { kind: "application", applicationId: `application:${this.version}` };
  }

  private repoPaths(): string[] {
    const paths = new Set([
      "meta",
      "packages/demo",
      "projects/file-tools-smoke",
      "projects/tmp_dir_test_root",
      "projects/note",
    ]);
    for (const file of [...this.files.keys(), ...this.binaryFiles.keys()]) {
      const parts = file.split("/");
      paths.add(parts[0] === "meta" ? "meta" : `${parts[0]}/${parts[1]}`);
    }
    return [...paths];
  }

  read(path: string): string | undefined {
    return this.files.get(normalize(path));
  }

  readBinary(path: string): string | undefined {
    return this.binaryFiles.get(normalize(path));
  }

  async status(input: Parameters<ToolEditingVcs["status"]>[0]) {
    return {
      contextId: input.contextId,
      committed: { kind: "event" as const, eventId: this.committedEventId },
      workingHead: this.workingHead(),
      clean: this.version === 0,
      mainEventId: "event:main",
      mainRelation: "at" as const,
      workingCounts: {
        applications: this.version,
        workUnits: this.version,
        changes: this.version,
      },
      integrating: [],
    };
  }

  async resolveRepository(input: Parameters<ToolEditingVcs["resolveRepository"]>[0]) {
    if (!this.repoPaths().includes(input.repoPath)) return null;
    return {
      state: input.state,
      repositoryId: `repository:${input.repoPath}`,
      repoPath: input.repoPath,
    };
  }

  async readFile(input: Parameters<ToolEditingVcs["readFile"]>[0]) {
    const repoPath = input.repositoryId.slice("repository:".length);
    let requestedPath: string | undefined;
    if (input.file.kind === "path") {
      requestedPath = input.file.path;
    } else {
      const fileId = input.file.fileId;
      requestedPath = [...this.files.keys(), ...this.binaryFiles.keys()]
        .find((path) => `file:${path}` === fileId)
        ?.slice(repoPath.length + 1);
    }
    if (!requestedPath) return null;
    const fullPath = `${repoPath}/${requestedPath}`;
    const text = this.files.get(fullPath);
    const base64 = this.binaryFiles.get(fullPath);
    if (text === undefined && base64 === undefined) return null;
    return {
      repositoryId: `repository:${repoPath}`,
      fileId: `file:${fullPath}`,
      repoPath,
      path: requestedPath,
      contentHash: sha256Hex(
        text !== undefined ? new TextEncoder().encode(text) : base64ToBytes(base64!)
      ),
      authoredChangeId: `change:${this.version}:${fullPath}`,
      authoredByWorkUnitId: `work:${this.version}`,
      contentClass: "internal" as const,
      externalKeys: [],
      mode: this.modes.get(fullPath) ?? 0o644,
      content:
        text !== undefined
          ? { kind: "text" as const, text }
          : { kind: "bytes" as const, base64: base64! },
    };
  }

  async edit(input: VcsEditInput) {
    this.lastEditInput = input;
    for (const change of input.changes) this.applyChange(change);
    this.version += 1;
    return {
      contextId: input.contextId,
      commandId: input.commandId,
      workUnitId: `work:${this.version}`,
      applicationId: `application:${this.version}`,
      changeCount: input.changes.length,
      changeIds: input.changes.map((_, index) => `change:${this.version}:${index}`),
      incorporatedChangeCount: 0,
      incorporatedChangeIds: [],
      decisionIds: [],
      workingHead: this.workingHead(),
    };
  }

  private applyChange(change: VcsEditChange): void {
    if (change.kind === "repository-create") {
      for (const file of change.files) {
        if (file.content.kind !== "text") throw new Error("stub only supports text");
        this.files.set(`${change.repoPath}/${file.path}`, file.content.text);
      }
      return;
    }
    const repoPath = change.repositoryId.slice("repository:".length);
    if (change.kind === "file-create") {
      const fullPath = `${repoPath}/${change.path}`;
      if (change.content.kind === "text") this.files.set(fullPath, change.content.text);
      else this.binaryFiles.set(fullPath, change.content.base64);
      this.modes.set(fullPath, change.mode);
      return;
    }
    const fullPath = [...this.files.keys()].find((path) => `file:${path}` === change.fileId);
    if (!fullPath) throw new Error(`file not found: ${change.fileId}`);
    if (change.kind === "file-delete") {
      this.files.delete(fullPath);
      this.binaryFiles.delete(fullPath);
      this.modes.delete(fullPath);
      return;
    }
    if (change.kind === "file-mode") {
      this.modes.set(fullPath, change.mode);
      return;
    }
    if (change.kind === "binary-replace") {
      this.files.delete(fullPath);
      this.binaryFiles.set(fullPath, change.base64);
      if (change.mode !== undefined) this.modes.set(fullPath, change.mode);
      return;
    }
    let next = this.files.get(fullPath)!;
    for (const edit of [...change.edits].sort((a, b) => b.start - a.start)) {
      next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
    }
    this.files.set(fullPath, next);
    if (change.mode !== undefined) this.modes.set(fullPath, change.mode);
  }

  async commit(input: VcsCommitInput) {
    this.lastCommitInput = input;
    const applications = this.version === 0 ? [] : [`application:${this.version}`];
    this.committedEventId = `event:${this.version + 1}`;
    this.version = 0;
    return {
      contextId: input.contextId,
      event: { kind: "event" as const, eventId: this.committedEventId },
      committedApplicationIds: applications,
      integrationSourceEventIds: [],
    };
  }
}
