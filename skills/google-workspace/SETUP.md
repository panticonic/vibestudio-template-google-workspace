# Google Workspace setup

The normal setup experience is the checked-in
[GoogleWorkspaceSetup.tsx](GoogleWorkspaceSetup.tsx) component. Render it with
`inline_ui`; do not translate this guide into chat prose or feedback forms.

The component owns the workflow:

1. It reads the current Google setup state.
2. It explains and opens the required Google Cloud pages.
3. Its **Save Desktop app details** button calls
   `configureGoogleOAuthClient()`; the host-owned prompt collects the client ID
   and secret.
4. Its **Connect Google** button calls `connectGoogle()`.
5. It verifies the live connection and keeps errors and retry in the card.

No secret belongs in chat or component state. The component must not return
choices to the agent for conversion into an eval call.

## Google Cloud requirements

Use one project throughout:

- Enable Gmail, Calendar, Drive, Docs, Sheets, Slides, and People APIs.
- Configure the OAuth consent screen.
- Publish the app to Production. Testing mode can expire refresh tokens after
  seven days for these user-data scopes.
- Create an OAuth client with application type **Desktop app**.

The app may remain unverified for personal use under Google's unverified-app
user cap. The user may need to continue through Google's **Advanced** warning.

The setup component links to:

- Project creation: `https://console.cloud.google.com/projectcreate`
- API library: `https://console.cloud.google.com/apis/library`
- OAuth setup: `https://console.cloud.google.com/auth/overview`
- OAuth clients: `https://console.cloud.google.com/auth/clients`

It lets the user open each step inside Vibestudio or in their normal browser.
The latter is useful for existing sign-in, passkeys, and password managers.

## Optional Gmail push notifications

Without push, the Gmail agent polls the history API. Push requires a Google
Cloud Pub/Sub topic and a Vibestudio server reachable through the callback
relay.

1. Create the topic and grant Gmail publish rights:

   ```bash
   gcloud pubsub topics create gmail-push
   gcloud pubsub topics add-iam-policy-binding gmail-push \
     --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
     --role=roles/pubsub.publisher
   ```

2. Create a generic Vibestudio webhook subscription with
   `webhooks.createSubscription()`, using a query-token verifier and the Gmail
   worker's `onWebhookDelivery` method.
3. Create a Google Pub/Sub push subscription targeting that public webhook
   URL.
4. Pass
   `googlePubSubTopicName: "projects/<project>/topics/gmail-push"` to
   `setupGmailAgent()`.

The Gmail worker renews `users.watch` daily. Without
`googlePubSubTopicName`, polling remains the sync driver.
