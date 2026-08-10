# Google Workspace Troubleshooting

## `accessNotConfigured`

The API is not enabled in the Google Cloud project that owns the OAuth client.
Open the API links in the [SETUP.md](SETUP.md) workflow UI and enable Gmail,
Calendar, and Drive in the same project.

## `invalid_client`

The client ID or client secret is wrong, or the OAuth client was created as a
**Web application** instead of a **Desktop app**. Create Desktop app credentials
and re-save the OAuth client setup.

Check the downloaded JSON:

- Correct: top-level `installed` key.
- Incorrect: top-level `web` key.

Re-save setup after changing either field.

## Token Expires Every 7 Days

The OAuth app is still in Testing mode. Open
<https://console.cloud.google.com/auth/audience> and publish the app to
Production. It can remain unverified while staying under Google's 100-user
unverified-app cap.

After publishing, reconnect the Google account so Google issues a new refresh
token under the Production app.

## `credential-expired` After Restart

The stored Google credential has an expired access token and no usable refresh
token. Older Vibestudio Google connections requested offline access from Google
but did not opt into persisting the returned refresh token in the host
credential store.

Revoke or replace the old Google Workspace credential and run
`connectGoogle({ force: true })` once. New connections persist the refresh token
and should survive app restarts.

## "This App Isn't Verified"

Expected for unverified Google OAuth apps. Users can click **Advanced** and
then continue to the app. File for Google verification later, before the app
approaches 80 connected users.

## `redirect_uri_mismatch`

This should not happen with Desktop app credentials because loopback redirects
are allowed. Check that the OAuth client type is **Desktop app**, not **Web
application**.

## Client Secret Is Not Saved

Run `configureGoogleOAuthClient()` and use the trusted approval UI for OAuth
client material. Do not ask the user to paste secrets into chat. If debugging
the downloaded Desktop app JSON, the relevant Google fields are:

- `clientId` from `installed.client_id`
- `clientSecret` from `installed.client_secret`

Then reload setup status.

## Connected But Verification Fails

Run `getGoogleOnboardingStatus({ verify: true })` and inspect `warnings`.
Common causes:

- The access token was revoked in Google Account permissions.
- APIs were enabled in a different project from the OAuth client.
- The app was connected before publishing to Production and needs reconnecting.
- The stored credential is old; revoke the Google Workspace connection and run
  `connectGoogle()` again.
