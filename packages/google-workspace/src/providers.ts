import type {
  CredentialBinding,
  UrlAudience,
} from "@vibestudio/credential-client";
import {
  audiencesFromBindings,
  bearerTokenInjection,
  type UrlCredentialDescriptor,
} from "@workspace/integrations/providers";

export {
  bearerTokenInjection,
  bindingAudience,
} from "@workspace/integrations/providers";

export const GOOGLE_IDENTITY_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/userinfo.email",
] as const;

export const GOOGLE_WORKSPACE_BROAD_SCOPES = [
  ...GOOGLE_IDENTITY_SCOPES,
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.metadata",
  "https://www.googleapis.com/auth/contacts",
  "https://www.googleapis.com/auth/contacts.other.readonly",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/presentations",
] as const;

/** Permissions needed for the first mail workflow; other apps opt in later. */
export const GOOGLE_GMAIL_SCOPES = [
  ...GOOGLE_IDENTITY_SCOPES,
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.settings.basic",
] as const;

export const GOOGLE_DRIVE_SCOPES = [
  ...GOOGLE_IDENTITY_SCOPES,
  "https://www.googleapis.com/auth/drive",
] as const;

const googleFetch = (
  id: string,
  label: string,
  audience: UrlAudience[],
): CredentialBinding => ({
  id,
  label,
  use: "fetch",
  audience,
  injection: bearerTokenInjection,
});

export const googleWorkspaceBindings = {
  gmail: googleFetch("google-gmail", "Google Gmail", [
    {
      url: "https://gmail.googleapis.com/gmail/v1/users/me/",
      match: "path-prefix",
    },
    {
      url: "https://gmail.googleapis.com/batch/gmail/v1",
      match: "path-prefix",
    },
  ]),
  calendar: googleFetch("google-calendar", "Google Calendar", [
    { url: "https://www.googleapis.com/calendar/v3/", match: "path-prefix" },
  ]),
  drive: googleFetch("google-drive", "Google Drive", [
    { url: "https://www.googleapis.com/drive/v3/", match: "path-prefix" },
    {
      url: "https://www.googleapis.com/upload/drive/v3/",
      match: "path-prefix",
    },
  ]),
  docs: googleFetch("google-docs", "Google Docs", [
    { url: "https://docs.googleapis.com/v1/", match: "path-prefix" },
  ]),
  sheets: googleFetch("google-sheets", "Google Sheets", [
    { url: "https://sheets.googleapis.com/v4/", match: "path-prefix" },
  ]),
  slides: googleFetch("google-slides", "Google Slides", [
    { url: "https://slides.googleapis.com/v1/", match: "path-prefix" },
  ]),
  people: googleFetch("google-people", "Google People", [
    { url: "https://people.googleapis.com/v1/", match: "path-prefix" },
  ]),
  identity: googleFetch("google-identity", "Google identity", [
    {
      url: "https://www.googleapis.com/oauth2/v1/userinfo",
      match: "path-prefix",
    },
    {
      url: "https://www.googleapis.com/oauth2/v3/userinfo",
      match: "path-prefix",
    },
  ]),
} satisfies Record<string, CredentialBinding>;

export const googleWorkspaceCredential: UrlCredentialDescriptor = {
  id: "google-workspace",
  displayName: "Google Workspace",
  audiences: audiencesFromBindings(Object.values(googleWorkspaceBindings)),
  bindings: Object.values(googleWorkspaceBindings),
  upstreamScopes: [...GOOGLE_WORKSPACE_BROAD_SCOPES],
};

/** Bind only the APIs authorized by the selected OAuth scopes. */
export function googleBindingsForScopes(
  scopes: readonly string[],
): CredentialBinding[] {
  const granted = (service: string) =>
    scopes.some(
      (scope) =>
        scope === `https://www.googleapis.com/auth/${service}` ||
        scope.startsWith(`https://www.googleapis.com/auth/${service}.`),
    );
  return [
    googleWorkspaceBindings.identity,
    ...(granted("gmail") ? [googleWorkspaceBindings.gmail] : []),
    ...(granted("calendar") ? [googleWorkspaceBindings.calendar] : []),
    ...(granted("drive") ? [googleWorkspaceBindings.drive] : []),
    ...(granted("documents") ? [googleWorkspaceBindings.docs] : []),
    ...(granted("spreadsheets") ? [googleWorkspaceBindings.sheets] : []),
    ...(granted("presentations") ? [googleWorkspaceBindings.slides] : []),
    ...(granted("contacts") ? [googleWorkspaceBindings.people] : []),
  ];
}
