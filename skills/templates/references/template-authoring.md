# Authoring a workspace snapshot

List protected-main repositories with `authoringParts`. Pass the selected
repositories to `inspectAuthoring` with a name and description. The inspection
adds workspace package dependencies and referenced runtime units, then returns a
self-contained manifest and fingerprint.

```js
const templates = "@workspace-extensions/templates";
const inspection = await extensions.invoke(templates, "inspectAuthoring", [{
  name: "News",
  description: "A focused news workspace",
  parts: ["panels/news", "workers/news"],
}]);
```

Review `requestedParts`, `requiredParts`, and `includedParts`. Publish only
that unchanged plan:

```js
const publication = await extensions.invoke(templates, "publishAuthoring", [{
  commandId: crypto.randomUUID(),
  intent: inspection.request,
  expectedFingerprint: inspection.fingerprint,
  version: "1.0.0",
  destination: { provider: "github", owner: "example", name: "news-workspace" },
  creation: { private: true },
  credentialId: "explicit-connected-account",
}]);
```

The snapshot owns its selected runtime configuration, including provider and
trust declarations that refer to included units. A fresh workspace still starts
without inherited grants or credentials. Never add template dependencies,
composition disables, workspace identity, concrete secrets, or author identity
to the published manifest.
