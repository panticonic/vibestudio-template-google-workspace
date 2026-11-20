# Google Workspace and Drive workflow

Google Workspace setup separates observed OAuth readiness from the user's next action. Drive demands a verified Drive API call beyond account identity. The program reads both, then chooses a bounded folder inventory, a sharing review, or continuation from a supplied change checkpoint. It returns a report for the caller.

| Responsibility | Owner |
| --- | --- |
| Sanitize connection state and retain selected credential custody | TypeScript adapter around the existing setup and Drive skill bindings. |
| Select the next setup stage or a bounded Drive skill | `guideGoogleWorkspace.nl` and its readiness tree. The existing setup panel owns configuration and consent. |
| Traverse an assigned folder and identify material for a handoff | `inspectFolder` and `selectRows`. The adapter provides distinct source IDs and committed Drive metadata. |
| Review direct sharing against stated constraints | `reviewSharing` and `classifyAccess`. The adapter accepts only an assigned file and opaque continuation token. |
| Resume a change feed without skipping material | `continueSync` and `summarizeDelta`. The adapter follows only returned tokens after the assigned initial checkpoint. |
| Validate task outcomes | Independent scenario expectations and raw client request observations. |

The caller retains OAuth, UI, file mutations, permission changes and durable storage. The workflow reads metadata, permissions, and change pages through the canonical Drive client. Paging has a caller-owned per-run request cap and matching observed tokens. Partial lists cannot establish completion, and a change cursor advances only after a terminal page.

The live setup review composes Drive readiness with the welcome panel in the same workspace. The
entry reads the workspace credential state, then delegates the journey to `reviewSetupJourney`.
That lambda calls the existing `explainReadiness` for the next account action and delegates the
browser evidence to `reviewSetupPanel`. The browser lambda calls the exact `observeSetupPanel`
service bridge and chooses the check-specific lambda for owner routes, the Gmail launch gate, or
viewport overflow. Evidence collection through CDP, viewport changes, and reloading the assigned
panel are typed TypeScript operations. They accept no arbitrary selectors, URLs, or panel IDs
from the model.

Setup choice journeys exercise the real app-scope selector, the browser
preference buttons, and reload. The caller specifies allowed steps. The
panel bridge returns a before and after observation for each step. The
Natlang program checks the consent boundary, then delegates comparison
of the two choices and the resulting guidance to a nested lambda. The
browser bridge clicks only the controls that set a local preference.
The user owns any subsequent action that opens Google or requests consent.

A caller may assign one managed checkpoint file. The checkpoint workflow
reads its current cursor, delegates pagination and per-file reconciliation to
the existing change feed subtree, and calls a commit lambda only after a
terminal checkpoint is observed. The bound service checks the terminal cursor
and the last-read cursor before replacing the file and reading it back.
The managed cases use the installed Drive HTTP client with an assigned test
transport and an actual workspace file. Google account setup remains separate.

The shared workflow can follow a checkpoint review with the Base scratch
handoff. The handoff reads the cursor that survived storage verification
alongside the terminal candidate, including when a competing writer's saved
cursor takes precedence. The runner releases the handoff source after the
Drive transport and write outcome have been checked.

The inventory-to-sharing review calls the existing inventory skill before
deciding whether the assigned file can be audited. A separate Natlang
decision requires a complete listing and the exact selected ID. The
permission reviewer runs only when the decision permits it. The managed
transport checks the same prerequisite before releasing any permission
page and retains the exact folder and permission requests for verification.

For an open goal, `workOnDriveGoal` receives only the user's words. It discovers
the named Drive folders and saved change sources available to the caller.
`chooseGoalRoute` selects the relevant resource, whether the user wants a
folder inventory, a direct-access review, or a change summary, and which
filters and sharing policy the user stated. It holds an ambiguous request.
`reviewFolderGoal` calls the existing inventory subtree. For a requested
access review, it delegates to the existing sharing subtree only when the
inventory is complete and selected exactly one current document. Change
summaries use the existing continuation subtree without writing a checkpoint.

The managed binding uses the installed Drive client with a caller-owned HTTP
test transport. Its TypeScript binds authorized resource identities, cursor
paginations and the read-only provider contract. It protects permission reads
until a complete non-shortcut source listing has been observed. The outcome
verifier runs after the Natlang call and checks actual requests and readback
against expectations held outside the model context. The reference drives
those same effects. Negative checks cover wrong choices and invented
completion. Alias checks vary provider resource identities.
