import type { CredentialClient, UrlCredentialHandle } from "@workspace/runtime/credentials";
import { bindingAudience, googleWorkspaceCredential } from "./providers.js";
import { GoogleApiError } from "./google-shared.js";

const GOOGLE_DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const GOOGLE_DRIVE_UPLOAD_API_BASE = "https://www.googleapis.com/upload/drive/v3";
const DEFAULT_FILE_FIELDS =
  "id,name,mimeType,parents,driveId,createdTime,modifiedTime,version,size,trashed,webViewLink,webContentLink,iconLink,owners,capabilities,shortcutDetails";
const DEFAULT_LIST_FIELDS = `nextPageToken,incompleteSearch,files(${DEFAULT_FILE_FIELDS})`;
const DEFAULT_CHANGE_FIELDS = `nextPageToken,newStartPageToken,changes(id,fileId,removed,time,type,changeType,driveId,file(${DEFAULT_FILE_FIELDS}))`;

export const manifest = {
  scopes: {
    "google-workspace": [
      "drive_readonly",
      "drive_files",
      "drive_permissions",
      "drive_changes",
      "drive_shared_drives",
    ],
  },
  endpoints: {
    "google-workspace": [
      { url: "https://www.googleapis.com/drive/v3/about", methods: ["GET"] },
      {
        url: "https://www.googleapis.com/drive/v3/files",
        methods: ["GET", "POST", "PATCH", "DELETE"],
      },
      { url: "https://www.googleapis.com/upload/drive/v3/files", methods: ["POST", "PATCH"] },
      { url: "https://www.googleapis.com/drive/v3/files/*", methods: ["GET", "PATCH", "DELETE"] },
      { url: "https://www.googleapis.com/drive/v3/files/*/copy", methods: ["POST"] },
      { url: "https://www.googleapis.com/drive/v3/files/*/permissions", methods: ["GET", "POST"] },
      {
        url: "https://www.googleapis.com/drive/v3/files/*/permissions/*",
        methods: ["PATCH", "DELETE"],
      },
      { url: "https://www.googleapis.com/drive/v3/files/*/export", methods: ["GET"] },
      { url: "https://www.googleapis.com/drive/v3/files/*/download", methods: ["POST"] },
      { url: "https://www.googleapis.com/drive/v3/changes", methods: ["GET"] },
      { url: "https://www.googleapis.com/drive/v3/changes/startPageToken", methods: ["GET"] },
      { url: "https://www.googleapis.com/drive/v3/drives", methods: ["GET", "POST"] },
      { url: "https://www.googleapis.com/drive/v3/drives/*", methods: ["GET", "PATCH", "DELETE"] },
    ],
  },
} as const;

export type DriveUploadBody = string | Blob | ArrayBuffer | ArrayBufferView;

export interface DriveUploadMedia {
  mimeType: string;
  body: DriveUploadBody;
}

export interface DriveFileBytes {
  bytes: Uint8Array;
  size: number;
  mimeType?: string;
  filename?: string;
  responseUrl?: string;
}

export interface DriveOwner {
  displayName?: string;
  emailAddress?: string;
  kind?: string;
  me?: boolean;
  permissionId?: string;
  photoLink?: string;
  [key: string]: unknown;
}

export interface DriveCapabilities {
  canAddChildren?: boolean;
  canComment?: boolean;
  canCopy?: boolean;
  canDelete?: boolean;
  canDownload?: boolean;
  canEdit?: boolean;
  canListChildren?: boolean;
  canMoveChildrenWithinDrive?: boolean;
  canMoveItemWithinDrive?: boolean;
  canReadRevisions?: boolean;
  canRename?: boolean;
  canShare?: boolean;
  [key: string]: unknown;
}

export interface DriveShortcutDetails {
  targetId?: string;
  targetMimeType?: string;
  targetResourceKey?: string;
  [key: string]: unknown;
}

export interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  parents?: string[];
  driveId?: string;
  createdTime?: string;
  modifiedTime?: string;
  version?: string;
  size?: string;
  trashed?: boolean;
  webViewLink?: string;
  webContentLink?: string;
  iconLink?: string;
  owners?: DriveOwner[];
  capabilities?: DriveCapabilities;
  shortcutDetails?: DriveShortcutDetails;
  [key: string]: unknown;
}

export interface DriveFileList {
  files?: DriveFile[];
  nextPageToken?: string;
  incompleteSearch?: boolean;
  [key: string]: unknown;
}

export interface DrivePermission {
  id: string;
  type: "user" | "group" | "domain" | "anyone" | string;
  role: "owner" | "organizer" | "fileOrganizer" | "writer" | "commenter" | "reader" | string;
  emailAddress?: string;
  domain?: string;
  displayName?: string;
  allowFileDiscovery?: boolean;
  deleted?: boolean;
  pendingOwner?: boolean;
  [key: string]: unknown;
}

export interface DrivePermissionList {
  permissions?: DrivePermission[];
  [key: string]: unknown;
}

export interface DriveDrive {
  id: string;
  name?: string;
  kind?: string;
  hidden?: boolean;
  createdTime?: string;
  restrictions?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  backgroundImageFile?: DriveFile;
  [key: string]: unknown;
}

export interface DriveDriveList {
  drives?: DriveDrive[];
  nextPageToken?: string;
  [key: string]: unknown;
}

export interface DriveUser {
  displayName?: string;
  emailAddress?: string;
  photoLink?: string;
  kind?: string;
  [key: string]: unknown;
}

export interface DriveStorageQuota {
  limit?: string;
  usage?: string;
  usageInDrive?: string;
  usageInDriveTrash?: string;
  [key: string]: unknown;
}

export interface DriveAbout {
  kind?: string;
  user?: DriveUser;
  storageQuota?: DriveStorageQuota;
  [key: string]: unknown;
}

export interface DriveChange {
  id: string;
  fileId?: string;
  removed?: boolean;
  time?: string;
  type?: string;
  changeType?: string;
  driveId?: string;
  file?: DriveFile;
  [key: string]: unknown;
}

export interface DriveChangeList {
  changes?: DriveChange[];
  nextPageToken?: string;
  newStartPageToken?: string;
  [key: string]: unknown;
}

export interface DriveStartPageToken {
  startPageToken: string;
  [key: string]: unknown;
}

export interface DriveListFilesOptions {
  q?: string;
  pageSize?: number;
  pageToken?: string;
  corpora?: "user" | "domain" | "drive" | "allDrives";
  driveId?: string;
  includeItemsFromAllDrives?: boolean;
  supportsAllDrives?: boolean;
  spaces?: string | string[];
  orderBy?: string | string[];
  fields?: string;
  includeLabels?: string;
}

export interface DriveGetFileOptions {
  fields?: string;
  supportsAllDrives?: boolean;
  includeLabels?: string;
  acknowledgeAbuse?: boolean;
}

export interface DriveFileMutationOptions {
  fields?: string;
  supportsAllDrives?: boolean;
  keepRevisionForever?: boolean;
  useContentAsIndexableText?: boolean;
  includePermissionsForView?: string;
  includeLabels?: string;
  ignoreDefaultVisibility?: boolean;
  ocrLanguage?: string;
}

export interface DriveUpdateFileOptions extends DriveFileMutationOptions {
  addParents?: string | string[];
  removeParents?: string | string[];
}

export interface DriveCopyFileOptions extends DriveFileMutationOptions {
  ignoreDefaultVisibility?: boolean;
}

export interface DriveListPermissionsOptions {
  supportsAllDrives?: boolean;
  fields?: string;
}

export interface DrivePermissionMutationOptions {
  sendNotificationEmail?: boolean;
  transferOwnership?: boolean;
  supportsAllDrives?: boolean;
  fields?: string;
}

export interface DriveListDrivesOptions {
  pageSize?: number;
  pageToken?: string;
  q?: string;
  useDomainAdminAccess?: boolean;
  fields?: string;
}

export interface DriveDriveMutationOptions {
  useDomainAdminAccess?: boolean;
  fields?: string;
}

export interface DriveListChangesOptions {
  pageToken: string;
  pageSize?: number;
  driveId?: string;
  includeRemoved?: boolean;
  includeCorpusRemovals?: boolean;
  includeItemsFromAllDrives?: boolean;
  restrictToMyDrive?: boolean;
  supportsAllDrives?: boolean;
  includeLabels?: string;
  fields?: string;
}

export interface DriveGetStartPageTokenOptions {
  driveId?: string;
  supportsAllDrives?: boolean;
  restrictToMyDrive?: boolean;
}

export interface DriveStartPollingOptions {
  intervalMs?: number;
  pageToken?: string;
  driveId?: string;
  includeRemoved?: boolean;
  includeCorpusRemovals?: boolean;
  includeItemsFromAllDrives?: boolean;
  restrictToMyDrive?: boolean;
  supportsAllDrives?: boolean;
  onChange: (change: DriveChange) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
}

export class GoogleDriveApiError extends GoogleApiError {}

export interface DriveClient {
  handle(): Promise<UrlCredentialHandle>;
  about(): Promise<DriveAbout>;
  listFiles(options?: DriveListFilesOptions): Promise<DriveFileList>;
  getFile(fileId: string, options?: DriveGetFileOptions): Promise<DriveFile>;
  downloadFile(fileId: string, options?: DriveGetFileOptions): Promise<Response>;
  downloadFileBytes(fileId: string, options?: DriveGetFileOptions): Promise<DriveFileBytes>;
  exportFile(
    fileId: string,
    mimeType: string,
    options?: { supportsAllDrives?: boolean; fields?: string }
  ): Promise<Response>;
  exportFileBytes(
    fileId: string,
    mimeType: string,
    options?: { supportsAllDrives?: boolean; fields?: string }
  ): Promise<DriveFileBytes>;
  createFile(
    metadata: Partial<DriveFile>,
    options?: DriveFileMutationOptions & { media?: DriveUploadMedia }
  ): Promise<DriveFile>;
  updateFile(
    fileId: string,
    metadata: Partial<DriveFile>,
    options?: DriveUpdateFileOptions & { media?: DriveUploadMedia }
  ): Promise<DriveFile>;
  moveFile(
    fileId: string,
    options: {
      addParents?: string | string[];
      removeParents?: string | string[];
    } & DriveUpdateFileOptions
  ): Promise<DriveFile>;
  trashFile(fileId: string, options?: DriveUpdateFileOptions): Promise<DriveFile>;
  restoreFile(fileId: string, options?: DriveUpdateFileOptions): Promise<DriveFile>;
  deleteFile(fileId: string, options?: { supportsAllDrives?: boolean }): Promise<void>;
  copyFile(
    fileId: string,
    metadata?: Partial<DriveFile>,
    options?: DriveCopyFileOptions
  ): Promise<DriveFile>;
  emptyTrash(): Promise<void>;
  listPermissions(
    fileId: string,
    options?: DriveListPermissionsOptions
  ): Promise<DrivePermissionList>;
  createPermission(
    fileId: string,
    permission: Partial<DrivePermission>,
    options?: DrivePermissionMutationOptions
  ): Promise<DrivePermission>;
  updatePermission(
    fileId: string,
    permissionId: string,
    permission: Partial<DrivePermission>,
    options?: DrivePermissionMutationOptions
  ): Promise<DrivePermission>;
  deletePermission(
    fileId: string,
    permissionId: string,
    options?: DrivePermissionMutationOptions
  ): Promise<void>;
  listDrives(options?: DriveListDrivesOptions): Promise<DriveDriveList>;
  getDrive(driveId: string, options?: DriveDriveMutationOptions): Promise<DriveDrive>;
  createDrive(
    metadata: Partial<DriveDrive>,
    options?: DriveDriveMutationOptions
  ): Promise<DriveDrive>;
  updateDrive(
    driveId: string,
    metadata: Partial<DriveDrive>,
    options?: DriveDriveMutationOptions
  ): Promise<DriveDrive>;
  deleteDrive(driveId: string, options?: DriveDriveMutationOptions): Promise<void>;
  getStartPageToken(options?: DriveGetStartPageTokenOptions): Promise<DriveStartPageToken>;
  listChanges(options: DriveListChangesOptions): Promise<DriveChangeList>;
  startPollingChanges(options: DriveStartPollingOptions): () => void;
}

function toPathSegment(value: string): string {
  return encodeURIComponent(value);
}

function toQueryValue(value: string | string[] | number | boolean | undefined): string | undefined {
  if (typeof value === "undefined") return undefined;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.join(",");
  return value;
}

function appendQuery(
  search: URLSearchParams,
  key: string,
  value: string | string[] | number | boolean | undefined
) {
  const normalized = toQueryValue(value);
  if (typeof normalized !== "undefined" && normalized !== "") {
    search.set(key, normalized);
  }
}

function buildQuery(options: Record<string, unknown> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null) continue;
    if (
      Array.isArray(value) ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      appendQuery(search, key, value as string | string[] | number | boolean);
    }
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

function normalizeFields(fields?: string): string | undefined {
  return fields && fields.trim() ? fields : undefined;
}

function defaultFileFields(fields?: string): string {
  return normalizeFields(fields) ?? DEFAULT_FILE_FIELDS;
}

function defaultListFields(fields?: string): string {
  return normalizeFields(fields) ?? DEFAULT_LIST_FIELDS;
}

function defaultChangeFields(fields?: string): string {
  return normalizeFields(fields) ?? DEFAULT_CHANGE_FIELDS;
}

function normalizeUploadBody(body: DriveUploadBody): BlobPart {
  if (typeof body === "string") return body;
  if (body instanceof Blob) return body;
  if (body instanceof ArrayBuffer) return body;
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength) as unknown as BlobPart;
  }
  return body as unknown as BlobPart;
}

function createMultipartRelatedBody(
  metadata: Record<string, unknown>,
  media: DriveUploadMedia
): {
  body: Blob;
  contentType: string;
} {
  const boundary = `drive-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2)}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: ${media.mimeType}\r\n\r\n`,
    normalizeUploadBody(media.body),
    `\r\n--${boundary}--\r\n`,
  ]);
  return {
    body,
    contentType: `multipart/related; boundary=${boundary}`,
  };
}

function getListFilesQuery(options: DriveListFilesOptions = {}): string {
  return buildQuery({
    q: options.q,
    pageSize: options.pageSize,
    pageToken: options.pageToken,
    corpora: options.corpora,
    driveId: options.driveId,
    includeItemsFromAllDrives: options.includeItemsFromAllDrives ?? true,
    supportsAllDrives: options.supportsAllDrives ?? true,
    spaces: options.spaces,
    orderBy: options.orderBy,
    fields: defaultListFields(options.fields),
    includeLabels: options.includeLabels,
  });
}

function getFileQuery(options: DriveGetFileOptions = {}): string {
  return buildQuery({
    fields: defaultFileFields(options.fields),
    supportsAllDrives: options.supportsAllDrives ?? true,
    includeLabels: options.includeLabels,
    acknowledgeAbuse: options.acknowledgeAbuse,
  });
}

function getMutationQuery(options: DriveFileMutationOptions = {}): string {
  return buildQuery({
    fields: defaultFileFields(options.fields),
    supportsAllDrives: options.supportsAllDrives ?? true,
    keepRevisionForever: options.keepRevisionForever,
    useContentAsIndexableText: options.useContentAsIndexableText,
    includePermissionsForView: options.includePermissionsForView,
    includeLabels: options.includeLabels,
    ignoreDefaultVisibility: options.ignoreDefaultVisibility,
    ocrLanguage: options.ocrLanguage,
  });
}

function getUpdateQuery(options: DriveUpdateFileOptions = {}): string {
  return buildQuery({
    fields: defaultFileFields(options.fields),
    supportsAllDrives: options.supportsAllDrives ?? true,
    keepRevisionForever: options.keepRevisionForever,
    useContentAsIndexableText: options.useContentAsIndexableText,
    includePermissionsForView: options.includePermissionsForView,
    includeLabels: options.includeLabels,
    ignoreDefaultVisibility: options.ignoreDefaultVisibility,
    ocrLanguage: options.ocrLanguage,
    addParents: toQueryValue(options.addParents),
    removeParents: toQueryValue(options.removeParents),
  });
}

function getCopyQuery(options: DriveCopyFileOptions = {}): string {
  return buildQuery({
    fields: defaultFileFields(options.fields),
    supportsAllDrives: options.supportsAllDrives ?? true,
    keepRevisionForever: options.keepRevisionForever,
    includePermissionsForView: options.includePermissionsForView,
    includeLabels: options.includeLabels,
    ignoreDefaultVisibility: options.ignoreDefaultVisibility,
    ocrLanguage: options.ocrLanguage,
    useContentAsIndexableText: options.useContentAsIndexableText,
  });
}

function getPermissionsQuery(
  options: DrivePermissionMutationOptions | DriveListPermissionsOptions = {}
): string {
  return buildQuery({
    supportsAllDrives: options.supportsAllDrives ?? true,
    fields: normalizeFields(options.fields),
    sendNotificationEmail:
      "sendNotificationEmail" in options
        ? (options as DrivePermissionMutationOptions).sendNotificationEmail
        : undefined,
    transferOwnership:
      "transferOwnership" in options
        ? (options as DrivePermissionMutationOptions).transferOwnership
        : undefined,
  });
}

function getDrivesQuery(options: DriveListDrivesOptions | DriveDriveMutationOptions = {}): string {
  return buildQuery({
    pageSize: "pageSize" in options ? (options as DriveListDrivesOptions).pageSize : undefined,
    pageToken: "pageToken" in options ? (options as DriveListDrivesOptions).pageToken : undefined,
    q: "q" in options ? (options as DriveListDrivesOptions).q : undefined,
    useDomainAdminAccess: options.useDomainAdminAccess,
    fields: normalizeFields(options.fields),
  });
}

function getChangeQuery(options: DriveListChangesOptions | DriveGetStartPageTokenOptions): string {
  return buildQuery({
    pageToken: "pageToken" in options ? (options as DriveListChangesOptions).pageToken : undefined,
    pageSize: "pageSize" in options ? (options as DriveListChangesOptions).pageSize : undefined,
    driveId: options.driveId,
    includeRemoved:
      "includeRemoved" in options ? (options as DriveListChangesOptions).includeRemoved : undefined,
    includeCorpusRemovals:
      "includeCorpusRemovals" in options
        ? (options as DriveListChangesOptions).includeCorpusRemovals
        : undefined,
    includeItemsFromAllDrives:
      "includeItemsFromAllDrives" in options
        ? (options as DriveListChangesOptions).includeItemsFromAllDrives
        : undefined,
    restrictToMyDrive: options.restrictToMyDrive,
    supportsAllDrives: options.supportsAllDrives ?? true,
    includeLabels:
      "includeLabels" in options ? (options as DriveListChangesOptions).includeLabels : undefined,
    fields: normalizeFields((options as DriveListChangesOptions).fields),
  });
}

async function parseJsonResponse<T>(response: Response, serviceName: string): Promise<T> {
  if (!response.ok) {
    throw new GoogleDriveApiError(
      serviceName,
      response.status,
      response.statusText,
      await response.text()
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function parseRawResponse(response: Response, serviceName: string): Promise<Response> {
  if (!response.ok) {
    throw new GoogleDriveApiError(
      serviceName,
      response.status,
      response.statusText,
      await response.text()
    );
  }
  return response;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function splitHeaderParameters(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === ";" && !quoted) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function unquoteHeaderValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  return trimmed;
}

function decodeExtendedHeaderValue(value: string): string {
  const normalized = unquoteHeaderValue(value);
  const match = /^([^']*)'[^']*'(.*)$/.exec(normalized);
  const encoded = match ? (match[2] ?? "") : normalized;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function filenameFromContentDisposition(value: string | null): string | undefined {
  if (!value) return undefined;
  const params = new Map<string, string>();
  for (const part of splitHeaderParameters(value).slice(1)) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim().toLowerCase();
    const paramValue = part.slice(separator + 1);
    if (name) params.set(name, paramValue);
  }
  const extended = params.get("filename*");
  if (extended) return decodeExtendedHeaderValue(extended);
  const filename = params.get("filename");
  return filename ? unquoteHeaderValue(filename) : undefined;
}

async function responseToDriveFileBytes(
  response: Response,
  operation: string
): Promise<DriveFileBytes> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new Error(`${operation} response body read failed: ${getErrorMessage(error)}`);
  }
  const mimeType = response.headers.get("content-type") ?? undefined;
  const filename = filenameFromContentDisposition(response.headers.get("content-disposition"));
  const responseUrl = response.url || undefined;
  return {
    bytes,
    size: bytes.byteLength,
    ...(mimeType ? { mimeType } : {}),
    ...(filename ? { filename } : {}),
    ...(responseUrl ? { responseUrl } : {}),
  };
}

async function executeJson<T>(
  auth: UrlCredentialHandle,
  url: string,
  init: RequestInit | undefined,
  serviceName: string
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await auth.fetch(url, { ...init, headers });
  return parseJsonResponse<T>(response, serviceName);
}

async function executeRaw(
  auth: UrlCredentialHandle,
  url: string,
  init: RequestInit | undefined,
  serviceName: string
): Promise<Response> {
  const headers = new Headers(init?.headers);
  const response = await auth.fetch(url, { ...init, headers });
  return parseRawResponse(response, serviceName);
}

function ensureMultipartUpload(
  metadata: Record<string, unknown>,
  media: DriveUploadMedia
): { body: Blob; contentType: string } {
  return createMultipartRelatedBody(metadata, media);
}

export function createDriveClient(
  credentials: CredentialClient,
  opts: { credentialId?: string } = {}
): DriveClient {
  let handlePromise: Promise<UrlCredentialHandle> | null = null;
  const handle = (): Promise<UrlCredentialHandle> => {
    if (!handlePromise) {
      const p = credentials.forAudience({
        ...bindingAudience(googleWorkspaceCredential, "google-drive", opts),
        label: googleWorkspaceCredential.displayName,
      });
      p.catch(() => {
        if (handlePromise === p) handlePromise = null;
      });
      handlePromise = p;
    }
    return handlePromise;
  };

  const withHandle = async <T>(fn: (auth: UrlCredentialHandle) => Promise<T>): Promise<T> =>
    fn(await handle());

  const apiUrl = (path: string, base = GOOGLE_DRIVE_API_BASE): string => `${base}${path}`;

  const listFiles = async (options: DriveListFilesOptions = {}): Promise<DriveFileList> =>
    withHandle((auth) =>
      executeJson<DriveFileList>(
        auth,
        apiUrl(`/files${getListFilesQuery(options)}`),
        undefined,
        "Google Drive"
      )
    );

  const getFile = async (fileId: string, options: DriveGetFileOptions = {}): Promise<DriveFile> =>
    withHandle((auth) =>
      executeJson<DriveFile>(
        auth,
        apiUrl(`/files/${toPathSegment(fileId)}${getFileQuery(options)}`),
        undefined,
        "Google Drive"
      )
    );

  const downloadFile = async (
    fileId: string,
    options: DriveGetFileOptions = {}
  ): Promise<Response> =>
    withHandle((auth) =>
      executeRaw(
        auth,
        apiUrl(
          `/files/${toPathSegment(fileId)}${buildQuery({
            supportsAllDrives: options.supportsAllDrives ?? true,
            acknowledgeAbuse: options.acknowledgeAbuse,
          })}&alt=media`
        ),
        undefined,
        "Google Drive"
      )
    );

  const downloadFileBytes = async (
    fileId: string,
    options: DriveGetFileOptions = {}
  ): Promise<DriveFileBytes> =>
    responseToDriveFileBytes(await downloadFile(fileId, options), "Google Drive download");

  const exportFile = async (
    fileId: string,
    mimeType: string,
    options: { supportsAllDrives?: boolean; fields?: string } = {}
  ): Promise<Response> =>
    withHandle((auth) =>
      executeRaw(
        auth,
        apiUrl(
          `/files/${toPathSegment(fileId)}/export${buildQuery({
            mimeType,
            supportsAllDrives: options.supportsAllDrives ?? true,
            fields: options.fields,
          })}`
        ),
        undefined,
        "Google Drive"
      )
    );

  const exportFileBytes = async (
    fileId: string,
    mimeType: string,
    options: { supportsAllDrives?: boolean; fields?: string } = {}
  ): Promise<DriveFileBytes> =>
    responseToDriveFileBytes(await exportFile(fileId, mimeType, options), "Google Drive export");

  const createFile = async (
    metadata: Partial<DriveFile>,
    options: DriveFileMutationOptions & { media?: DriveUploadMedia } = {}
  ): Promise<DriveFile> =>
    withHandle(async (auth) => {
      const query = getMutationQuery(options);
      if (!options.media) {
        return executeJson<DriveFile>(
          auth,
          apiUrl(`/files${query}`),
          { method: "POST", body: JSON.stringify(metadata) },
          "Google Drive"
        );
      }
      const multipart = ensureMultipartUpload(metadata, options.media);
      return executeJson<DriveFile>(
        auth,
        apiUrl(
          `/files?uploadType=multipart${query ? `&${query.slice(1)}` : ""}`,
          GOOGLE_DRIVE_UPLOAD_API_BASE
        ),
        {
          method: "POST",
          body: multipart.body,
          headers: { "Content-Type": multipart.contentType },
        },
        "Google Drive"
      );
    });

  const updateFile = async (
    fileId: string,
    metadata: Partial<DriveFile>,
    options: DriveUpdateFileOptions & { media?: DriveUploadMedia } = {}
  ): Promise<DriveFile> =>
    withHandle(async (auth) => {
      const query = getUpdateQuery(options);
      if (!options.media) {
        return executeJson<DriveFile>(
          auth,
          apiUrl(`/files/${toPathSegment(fileId)}${query}`),
          { method: "PATCH", body: JSON.stringify(metadata) },
          "Google Drive"
        );
      }
      const multipart = ensureMultipartUpload(metadata, options.media);
      return executeJson<DriveFile>(
        auth,
        apiUrl(
          `/files/${toPathSegment(fileId)}?uploadType=multipart${query ? `&${query.slice(1)}` : ""}`,
          GOOGLE_DRIVE_UPLOAD_API_BASE
        ),
        {
          method: "PATCH",
          body: multipart.body,
          headers: { "Content-Type": multipart.contentType },
        },
        "Google Drive"
      );
    });

  const moveFile = async (
    fileId: string,
    options: {
      addParents?: string | string[];
      removeParents?: string | string[];
    } & DriveUpdateFileOptions
  ): Promise<DriveFile> => updateFile(fileId, {}, options);

  const trashFile = async (
    fileId: string,
    options: DriveUpdateFileOptions = {}
  ): Promise<DriveFile> => updateFile(fileId, { trashed: true }, options);

  const restoreFile = async (
    fileId: string,
    options: DriveUpdateFileOptions = {}
  ): Promise<DriveFile> => updateFile(fileId, { trashed: false }, options);

  const deleteFile = async (
    fileId: string,
    options: { supportsAllDrives?: boolean } = {}
  ): Promise<void> =>
    withHandle(async (auth) => {
      await executeJson<void>(
        auth,
        apiUrl(
          `/files/${toPathSegment(fileId)}${buildQuery({ supportsAllDrives: options.supportsAllDrives ?? true })}`
        ),
        { method: "DELETE" },
        "Google Drive"
      );
    });

  const copyFile = async (
    fileId: string,
    metadata: Partial<DriveFile> = {},
    options: DriveCopyFileOptions = {}
  ): Promise<DriveFile> =>
    withHandle(async (auth) => {
      const query = getCopyQuery(options);
      return executeJson<DriveFile>(
        auth,
        apiUrl(`/files/${toPathSegment(fileId)}/copy${query}`),
        {
          method: "POST",
          body: JSON.stringify(metadata),
        },
        "Google Drive"
      );
    });

  const emptyTrash = async (): Promise<void> =>
    withHandle(async (auth) => {
      await executeJson<void>(auth, apiUrl("/files/trash"), { method: "DELETE" }, "Google Drive");
    });

  const listPermissions = async (
    fileId: string,
    options: DriveListPermissionsOptions = {}
  ): Promise<DrivePermissionList> =>
    withHandle((auth) =>
      executeJson<DrivePermissionList>(
        auth,
        apiUrl(`/files/${toPathSegment(fileId)}/permissions${getPermissionsQuery(options)}`),
        undefined,
        "Google Drive"
      )
    );

  const createPermission = async (
    fileId: string,
    permission: Partial<DrivePermission>,
    options: DrivePermissionMutationOptions = {}
  ): Promise<DrivePermission> =>
    withHandle((auth) =>
      executeJson<DrivePermission>(
        auth,
        apiUrl(`/files/${toPathSegment(fileId)}/permissions${getPermissionsQuery(options)}`),
        {
          method: "POST",
          body: JSON.stringify(permission),
        },
        "Google Drive"
      )
    );

  const updatePermission = async (
    fileId: string,
    permissionId: string,
    permission: Partial<DrivePermission>,
    options: DrivePermissionMutationOptions = {}
  ): Promise<DrivePermission> =>
    withHandle((auth) =>
      executeJson<DrivePermission>(
        auth,
        apiUrl(
          `/files/${toPathSegment(fileId)}/permissions/${toPathSegment(permissionId)}${getPermissionsQuery(options)}`
        ),
        {
          method: "PATCH",
          body: JSON.stringify(permission),
        },
        "Google Drive"
      )
    );

  const deletePermission = async (
    fileId: string,
    permissionId: string,
    options: DrivePermissionMutationOptions = {}
  ): Promise<void> =>
    withHandle(async (auth) => {
      await executeJson<void>(
        auth,
        apiUrl(
          `/files/${toPathSegment(fileId)}/permissions/${toPathSegment(permissionId)}${getPermissionsQuery(options)}`
        ),
        { method: "DELETE" },
        "Google Drive"
      );
    });

  const listDrives = async (options: DriveListDrivesOptions = {}): Promise<DriveDriveList> =>
    withHandle((auth) =>
      executeJson<DriveDriveList>(
        auth,
        apiUrl(`/drives${getDrivesQuery(options)}`),
        undefined,
        "Google Drive"
      )
    );

  const getDrive = async (
    driveId: string,
    options: DriveDriveMutationOptions = {}
  ): Promise<DriveDrive> =>
    withHandle((auth) =>
      executeJson<DriveDrive>(
        auth,
        apiUrl(`/drives/${toPathSegment(driveId)}${getDrivesQuery(options)}`),
        undefined,
        "Google Drive"
      )
    );

  const createDrive = async (
    metadata: Partial<DriveDrive>,
    options: DriveDriveMutationOptions = {}
  ): Promise<DriveDrive> =>
    withHandle((auth) =>
      executeJson<DriveDrive>(
        auth,
        apiUrl(`/drives${getDrivesQuery(options)}`),
        {
          method: "POST",
          body: JSON.stringify(metadata),
        },
        "Google Drive"
      )
    );

  const updateDrive = async (
    driveId: string,
    metadata: Partial<DriveDrive>,
    options: DriveDriveMutationOptions = {}
  ): Promise<DriveDrive> =>
    withHandle((auth) =>
      executeJson<DriveDrive>(
        auth,
        apiUrl(`/drives/${toPathSegment(driveId)}${getDrivesQuery(options)}`),
        {
          method: "PATCH",
          body: JSON.stringify(metadata),
        },
        "Google Drive"
      )
    );

  const deleteDrive = async (
    driveId: string,
    options: DriveDriveMutationOptions = {}
  ): Promise<void> =>
    withHandle(async (auth) => {
      await executeJson<void>(
        auth,
        apiUrl(`/drives/${toPathSegment(driveId)}${getDrivesQuery(options)}`),
        { method: "DELETE" },
        "Google Drive"
      );
    });

  const about = async (): Promise<DriveAbout> =>
    withHandle((auth) =>
      executeJson<DriveAbout>(
        auth,
        apiUrl("/about?fields=kind,user,storageQuota"),
        undefined,
        "Google Drive"
      )
    );

  const getStartPageToken = async (
    options: DriveGetStartPageTokenOptions = {}
  ): Promise<DriveStartPageToken> =>
    withHandle((auth) =>
      executeJson<DriveStartPageToken>(
        auth,
        apiUrl(`/changes/startPageToken${getChangeQuery(options)}`),
        undefined,
        "Google Drive"
      )
    );

  const listChanges = async (options: DriveListChangesOptions): Promise<DriveChangeList> =>
    withHandle((auth) =>
      executeJson<DriveChangeList>(
        auth,
        apiUrl(`/changes${getChangeQuery(options)}`),
        undefined,
        "Google Drive"
      )
    );

  const startPollingChanges = (options: DriveStartPollingOptions): (() => void) => {
    const intervalMs = options.intervalMs ?? 60_000;
    let active = true;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let pageToken = options.pageToken;

    const scheduleNext = () => {
      if (!active) return;
      timeoutId = setTimeout(() => {
        void poll();
      }, intervalMs);
    };

    const poll = async () => {
      try {
        if (!pageToken) {
          const token = await getStartPageToken({
            driveId: options.driveId,
            supportsAllDrives: options.supportsAllDrives,
            restrictToMyDrive: options.restrictToMyDrive,
          });
          pageToken = token.startPageToken;
        }

        const result = await listChanges({
          pageToken,
          pageSize: undefined,
          driveId: options.driveId,
          includeRemoved: options.includeRemoved,
          includeCorpusRemovals: options.includeCorpusRemovals,
          includeItemsFromAllDrives: options.includeItemsFromAllDrives,
          restrictToMyDrive: options.restrictToMyDrive,
          supportsAllDrives: options.supportsAllDrives,
          fields: defaultChangeFields(),
        });

        for (const change of result.changes ?? []) {
          await options.onChange(change);
        }

        if (result.newStartPageToken) {
          pageToken = result.newStartPageToken;
        } else if (result.nextPageToken) {
          pageToken = result.nextPageToken;
        }
      } catch (error) {
        if (error instanceof GoogleDriveApiError && error.status === 410) {
          pageToken = undefined;
        } else if (options.onError) {
          await options.onError(error instanceof Error ? error : new Error(String(error)));
        }
      } finally {
        scheduleNext();
      }
    };

    void poll();
    return () => {
      active = false;
      if (timeoutId) clearTimeout(timeoutId);
    };
  };

  return {
    handle,
    about,
    listFiles,
    getFile,
    downloadFile,
    downloadFileBytes,
    exportFile,
    exportFileBytes,
    createFile,
    updateFile,
    moveFile,
    trashFile,
    restoreFile,
    deleteFile,
    copyFile,
    emptyTrash,
    listPermissions,
    createPermission,
    updatePermission,
    deletePermission,
    listDrives,
    getDrive,
    createDrive,
    updateDrive,
    deleteDrive,
    getStartPageToken,
    listChanges,
    startPollingChanges,
  };
}
