# Google Workspace Troubleshooting

## `accessNotConfigured`

The API is not enabled in the Google Cloud project that owns the OAuth client.
Use the API library links in the setup component (see [SETUP.md](SETUP.md)) and
enable Gmail, Calendar, and Drive in that same project.

## `invalid_client`

The client ID or secret is wrong, or the OAuth client was created as a **Web
application** instead of a **Desktop app**. Create Desktop app credentials and
save the OAuth client details again.

Check the downloaded JSON:

- Correct: top-level `installed` key.
- Incorrect: top-level `web` key.

Save the details again after changing either field.

## Token Expires Every 7 Days

The OAuth app is still in Testing mode. Open
<https://console.cloud.google.com/auth/audience> and publish the app to
Production. It can stay unverified while under Google's 100-user cap for
unverified apps.

After publishing, reconnect the Google account so Google issues a new refresh
token for the Production app.

## `credential-expired` After Restart

The stored Google credential has an expired access token and no usable refresh
token. Older Vibestudio Google connections requested offline access but did not
save the returned refresh token in the host credential store.

Revoke or replace the old Google Workspace credential and run
`connectGoogle({ force: true })` once. New connections save the refresh token
and should survive app restarts.

## "This App Isn't Verified"

This is expected for unverified Google OAuth apps. Users can click **Advanced**
and continue to the app. Apply for Google verification later, before the app
nears 80 connected users.

## `redirect_uri_mismatch`

This should not happen with Desktop app credentials, because Google allows
loopback redirects for them. Check that the OAuth client type is **Desktop
app**, not **Web application**.

## Client Secret Is Not Saved

Run `configureGoogleOAuthClient()` and enter the OAuth client details in the
trusted prompt. Do not ask the user to paste secrets into chat. When debugging
the downloaded Desktop app JSON, the relevant fields are:

- `clientId` from `installed.client_id`
- `clientSecret` from `installed.client_secret`

Then reload the setup status.

## Connected But Verification Fails

Run `getGoogleOnboardingStatus({ verify: true })` and check `warnings`. Common
causes:

- The access token was revoked in the user's Google Account permissions.
- The APIs were enabled in a different project from the OAuth client.
- The app was connected before it was published to Production and needs
  reconnecting.
- The stored credential is old; revoke the Google Workspace connection and run
  `connectGoogle()` again.
