# Google Workspace setup

Set up Google Workspace with the checked-in
[GoogleWorkspaceSetup.tsx](GoogleWorkspaceSetup.tsx) component. Render it with
`inline_ui`; do not turn this guide into chat prose or feedback forms.

The component runs the workflow:

1. It reads the current Google setup state.
2. It explains and opens the required Google Cloud pages.
3. Its **Save Desktop app details** button calls `configureGoogleOAuthClient()`;
   the host prompt collects the client ID and secret.
4. Its **Connect Google** button calls `connectGoogle()`.
5. It verifies the live connection and shows errors and retry in the card.

Secrets never go in chat or component state. The component must not hand
choices back to the agent to turn into an eval call.

## Google Cloud requirements

Use the same project for every step:

- For Gmail, enable the Gmail API. For All Workspace apps, also enable the
  Calendar, Drive, Docs, Sheets, Slides, and People APIs.
- Configure the OAuth consent screen.
- Publish the app to Production. In Testing mode, refresh tokens for these
  user-data scopes can expire after seven days.
- Create an OAuth client with application type **Desktop app**.

For personal use the app can stay unverified, within Google's user cap for
unverified apps. The user may need to click through Google's **Advanced**
warning.

The setup component links to:

- Project creation: `https://console.cloud.google.com/projectcreate`
- API library: `https://console.cloud.google.com/apis/library`
- OAuth setup: `https://console.cloud.google.com/auth/overview`
- OAuth clients: `https://console.cloud.google.com/auth/clients`

It opens these in the user's normal browser by default, which is useful for
existing sign-in, passkeys, and password managers. The user can also open each
step inside Vibestudio.

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
`googlePubSubTopicName`, the worker keeps syncing by polling.
