---
name: google-drive
description: Google Drive file browsing, uploads, permissions, shared drives, and change sync on top of verified Google Workspace.
---

# Google Drive Skill

Use this skill when the user wants Vibestudio to work with Google Drive files,
shared drives, permissions, exports, uploads, or change sync. It builds on the
verified `google-workspace` connection and reuses the staged `google-drive`
binding.

## Prerequisite

Google Drive needs no console setup beyond Google Workspace. The user must
first complete [Google Workspace onboarding](../google-workspace/ONBOARDING.md)
and reach the verified stage with Drive permissions. Enable the Drive API in the
same project, then request Drive access explicitly:

```ts
import { connectGoogle } from "@workspace-skills/google-workspace";
import { GOOGLE_DRIVE_SCOPES } from "@workspace/google-workspace/providers";
await connectGoogle({ scopes: [...GOOGLE_DRIVE_SCOPES] });
```

This runs a full Google consent flow and keeps access already granted to other
services. A Gmail-only credential is not ready for Drive.

## Runtime Helpers

```ts
import {
  createGoogleDriveClient,
  getGoogleDriveOnboardingStatus,
  verifyGoogleDriveAccess,
} from "@workspace-skills/google-drive";
```

Recommended flow:

1. Run `getGoogleDriveOnboardingStatus()`.
2. If the stage is `needs-google-workspace`, finish Google Workspace setup
   first.
3. If the stage is `ready`, create a Drive client and use the file, permission,
   shared-drive, or change-sync methods as needed.
4. Run `verifyGoogleDriveAccess()` for a live Drive API check before handing
   the connection to a workflow.

## What The Client Can Do

The client comes from `@workspace/google-workspace/drive` and supports:

- `about()` for account and storage metadata
- `listFiles()`, `getFile()`, `createFile()`, `updateFile()`, `moveFile()`
- `trashFile()`, `restoreFile()`, `deleteFile()`, `copyFile()`
- `downloadFileBytes()` for agent workflows that need bytes and download
  metadata. It returns `{ bytes: Uint8Array, size, mimeType, responseUrl }`.
- `exportFileBytes()` for Google Docs/Sheets/Slides exports that need bytes,
  MIME type, and filename metadata
- `downloadFile()`, `exportFile()` when the caller needs the raw streaming
  `Response`
- `listPermissions()`, `createPermission()`, `updatePermission()`,
  `deletePermission()`
- `listDrives()`, `getDrive()`, `createDrive()`, `updateDrive()`,
  `deleteDrive()`
- `getStartPageToken()`, `listChanges()`, `startPollingChanges()`

Use the Drive client directly for file operations; use this skill for
onboarding, readiness checks, and a stable Drive entry point. Byte-returning
methods produce native `Uint8Array` values that can pass directly to runtime
filesystem and extension RPC calls. Keep raw `Response` objects on the side
that consumes their streaming body.

```ts
import { fs } from "@workspace/runtime";

const downloaded = await drive.downloadFileBytes(fileId);
await fs.writeFile("downloads/drive-file", downloaded.bytes);
```

## Files

| Document                                                                                     | Content                        |
| -------------------------------------------------------------------------------------------- | ------------------------------ |
| [../../packages/google-workspace/src/drive.ts](../../packages/google-workspace/src/drive.ts) | Google Drive API client        |
| [index.ts](index.ts)                                                                         | Importable Drive skill helpers |
