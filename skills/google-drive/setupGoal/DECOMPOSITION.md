# Open Google setup goals

The pinned `google-live-setup-journey` already connects `panels/welcome`, `GoogleWorkspaceSetup.tsx`, `prepareGoogleSetupJourney`, and the Google and Gmail workflow. Its scripted checks exercise renderer routes, launch gate, workspace scope, browser opening choice, and responsive layout. The default account source reads host credential metadata and verifies through Google's userinfo URL. The host-protected configure and consent controls initiate operations on that account source.

| Stage | Implementation |
| --- | --- |
| Discover the current owned setup | A narrow service reads the actual installed welcome component in its disposable renderer, joins it to the renderer's owning setup profile and its retained confirmations, and returns typed observations. |
| Choose what to investigate or change | A typed Natlang child plans authorized reversible display changes, including scope, browser route, responsive view, reload, and resulting readback. Only the actual renderer selectors implement effects. |
| Decide route and explain retained work | A typed Natlang child separates configuration, consent, verification, revoked/stale confirmation, Gmail launch readiness, and separate Workspace permission coverage. It uses the rendered gate, actual stable profile facts, and retained confirmation identities. |
| Stage an owner handoff when requested | A typed Natlang child decides the supported next step. The exact service revalidates the observation and profile, writes only the owned renderer's local handoff, and rereads it. |
| Independently verify | A fresh renderer and owned profile readback verify the exact disposition, permitted visible changes, retained checkpoints and local handoff. Reference, wrong-route, and foreign-revision replays distinguish real effects from reported claims. |

The real welcome entry uses the normal account source. The disposable runner reuses the same rendered component with an owned read-only setup profile. This profile contains structured status and inert identifiers. It has no tokens, passwords, OAuth client material, or network address. Account mutation and external navigation are unavailable in that mounted rehearsal. The test never follows Gmail launch links.
