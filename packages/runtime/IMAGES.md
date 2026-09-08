# Images in running panels

`images` from `@workspace/runtime` is the same workspace service client in panels,
workers, Durable Objects, and agent eval. Provider credentials remain managed by
the connected model provider. The native `imagegen` tool uses this service too;
its optional `outputPath` is an ordinary semantic VCS save of the original bytes.
Generation does not rebuild a panel or change its source.


Initialized panel runtimes can use the global client:

```ts
import { images } from "@workspace/runtime";
```

Workers and Durable Objects such as `AiChatWorker` that receive a scoped RPC
but do not initialize the global runtime must construct the same client from
that RPC. This keeps calls on the admitted execution and uses the identical
service protocol:

```ts
import { createImagesClient } from "@workspace/runtime/images";

const images = createImagesClient(execution?.rpc ?? this.rpc);
const job = await images.generate({
  requestId,
  prompt,
});
const completed = await images.wait(job.id);
```

Do not initialize a second global runtime or create a parallel image transport
for this case.

Persist a job ID as soon as generation starts, then observe it from any reopened
view. Persist the returned `ImageAsset` in application state, never bytes, data
URLs, or local object URLs. Replaying an identical `requestId` returns its job;
`retry(job.id)` retries an explicitly failed attempt. Stopping a `wait` observer
leaves the job alive; `cancel(job.id)` explicitly cancels the operation.

```tsx
import { images } from "@workspace/runtime";
import { GeneratedImage } from "@workspace/react";

const job = await images.generate({
  requestId: scene.generationRequestId,
  prompt: scene.description,
  artDirection: campaign.artDirection,
  references: scene.previousImage ? [scene.previousImage] : [],
});
await campaign.savePendingJob(scene.id, job.id);
const completed = await images.wait(job.id);
if (completed.status === "succeeded" && completed.asset) {
  await images.retain({ assetId: completed.asset.id, owner: campaign.id });
  // The application decides if this result still belongs to the selected scene.
  await campaign.attachImageIfCurrent(scene.id, job.id, completed.asset);
}

// Changes to asset render immediately in the already running panel.
<GeneratedImage asset={scene.image} alt={scene.description} />;
```

The component supplies loading/error states, accepts ordinary image attributes,
and releases decoded images and object URLs on replacement/unmount. Use
`useGeneratedImage(asset)` for custom React rendering. For Canvas or an isolated
renderer, construct `createImageLoader(images)` from
`@workspace/runtime/image-loader`, await `loader.load(asset)`, draw its decoded
`image`, and call the returned `release()` after use. Call `loader.dispose()` when
the renderer shuts down. An isolated realm needs its own loader and authenticated
runtime client; it must not receive another realm's object URL.

Generation accepts up to 16 distinct reference assets in total, including the
selected art direction’s references.

Style resources are immutable versions:

```ts
const direction = await images.putArtDirection({
  id: "campaign-watercolors",
  brief: "Restrained watercolor, warm lamplight, faded indigo shadows, no lettering.",
  references: [approvedKeyArt],
});
// Store {id: direction.id, version: direction.version} with the campaign.
```

Successful jobs retain their original and reference images. Transfer ownership
with `retain({assetId, owner})` before `forgetJob(id)` releases the job's roots.
Forget only terminal jobs. On campaign deletion release that campaign's owner;
`deleteArtDirection({id,version})` releases a discarded style resource's roots.
Imported files use `importAsset({base64,owner})`; release that owner after moving
ownership to the app. Copying between workspaces explicitly reads in the source
workspace and imports in the destination. Asset IDs/digests alone do not grant
access. Imported copies receive import provenance rather than forged generation
provenance.

A panel or worker declares the installed service in its package manifest. Keep
other requests required by the app alongside these entries:

```json
{
  "dependencies": {
    "@workspace/runtime": "workspace:*",
    "@workspace/react": "workspace:*"
  },
  "vibestudio": {
    "authority": {
      "provides": [],
      "requests": [
        {
          "capability": "workspace-service:images",
          "resource": { "kind": "exact", "key": "do:workers/images:ImagesDO:workspace" },
          "tier": "gated",
          "evidence": "exact"
        }
      ],
      "serviceRequests": [{ "protocol": "vibestudio.images.v1", "availability": "required" }]
    }
  }
}
```

The normal workspace installation/publication review covers this declaration.
The Images service owns provider access; an app does not request or store the
provider credential itself. Apps persisting panel navigation via `panel.stateArgs`
also declare `workspace.runtime-state.manage` and a `vibestudio.stateArgs` schema;
worker-owned campaign state uses the app's ordinary durable storage service.
