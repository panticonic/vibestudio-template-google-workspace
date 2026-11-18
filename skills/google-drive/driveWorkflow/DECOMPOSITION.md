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
