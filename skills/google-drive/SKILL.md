---
name: google-drive
description: Google Drive file browsing, uploads, permissions, shared drives, and change sync on top of verified Google Workspace.
---

# Google Drive Skill

Use this skill when the user wants Vibestudio to work with Google Drive files,
shared drives, permissions, exports, uploads, or change sync. This skill sits
on top of the verified `google-workspace` connection and reuses the staged
`google-drive` binding.

## Prerequisite

Google Drive has no separate console setup beyond Google Workspace. The user
must first complete
[Google Workspace onboarding](../google-workspace/ONBOARDING.md) and
reach the verified stage.

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
4. Run `verifyGoogleDriveAccess()` when you want a live Drive API check before
   handing the connection to a workflow.

## What The Client Can Do

The underlying client comes from `@workspace/google-workspace/drive` and supports:

- `about()` for account and storage metadata
- `listFiles()`, `getFile()`, `createFile()`, `updateFile()`, `moveFile()`
- `trashFile()`, `restoreFile()`, `deleteFile()`, `copyFile()`
- `downloadFileBytes()` for agent workflows that need bytes and download
  metadata. It returns `{ bytes: Uint8Array, size, mimeType, responseUrl }`.
- `exportFileBytes()` for Google Docs/Sheets/Slides exports that need bytes,
  MIME type, and filename metadata
- `downloadFile()`, `exportFile()` when a caller explicitly needs the raw
  streaming `Response`
- `listPermissions()`, `createPermission()`, `updatePermission()`,
  `deletePermission()`
- `listDrives()`, `getDrive()`, `createDrive()`, `updateDrive()`,
  `deleteDrive()`
- `getStartPageToken()`, `listChanges()`, `startPollingChanges()`

Use the Drive client directly for file operations; use this skill for
onboarding, readiness checks, and a stable Drive-facing entrypoint. Prefer the
byte helpers before writing Drive downloads to runtime fs so raw `Response`
objects do not cross JSON/RPC/tool-result boundaries.

When passing `downloadFileBytes().bytes` into an extension invocation or any
other RPC/tool boundary, convert or wrap the bytes first. Do not rely on
`Uint8Array` identity to survive another JSON/RPC hop:

```ts
const downloaded = await drive.downloadFileBytes(fileId);
const extensionBytes = {
  __bin: true,
  data: Buffer.from(downloaded.bytes).toString("base64"),
};
```

## Files

| Document                                                                                     | Content                        |
| -------------------------------------------------------------------------------------------- | ------------------------------ |
| [../../packages/google-workspace/src/drive.ts](../../packages/google-workspace/src/drive.ts) | Google Drive API client        |
| [index.ts](index.ts)                                                                         | Importable Drive skill helpers |
