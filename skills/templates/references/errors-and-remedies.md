# Template errors and remedies

Use the error returned by exact inspection, or publication.
There is no installed-template composition operation to resume, no managed
settings to repair, and no template update removal flow.

| Failure | Next action |
| --- | --- |
| Private source needs credentials | Open the standard connection flow, then retry the explicit acquisition with the selected credential. Never store concrete credentials in the snapshot. |
| Snapshot integrity or manifest validation failed | Stop and show the returned details. Do not substitute another source or retry an integrity failure. |
| Remote unavailable | Show which explicit acquisition failed and offer another attempt later. |
| Authoring source changed after inspection | Run `inspectAuthoring` again and review the new fingerprint and required source closure before publishing. |
| Authoring dependency or runtime companion missing | Repair the reported source dependency, then inspect the complete selection again. |
| Publication failed | Inspect the recorded command outcome before retrying. Preserve its command ID for reconciliation; do not assume the remote destination was unchanged. |

Inspection does not integrate source or grant authority. Say that no workspace
source changed only when the operation's outcome establishes it. Workspace
creation, unit admission, selected-file copying, and ordinary VCS merges have
their own outcomes and review flows; do not describe them as template installation.
