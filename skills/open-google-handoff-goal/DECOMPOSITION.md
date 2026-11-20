# Recover a Google Workspace decision and its assets

The task starts with the original request. It uses Gmail for the decision
history, Drive for the current state of the linked assets, and workspace
scratch for a handoff when requested. Each service reads bounded owned state.

| Responsibility | Decomposition |
| --- | --- |
| Interpret scope and desired outcome | `chooseHandoffPlan` determines content and sharing review and whether a supported result should be saved. |
| Discover and resolve the decision | The provider client follows the bounded thread search. `resolveMailDecision` delegates to `chooseMailEvidence` to judge authority, scope, supersession, withdrawal, ambiguity, and exact supporting messages. |
| Review linked assets | `reviewLinkedAssets` delegates each selected link to `checkLinkedAsset`. Exact metadata, file bytes, export, permissions, identity binding, and pagination are services. Policy on which asset satisfies the request, required evidence, and sharing belongs in Natlang. |
| Form the result | `chooseHandoffDecision` reconciles the mail decision with current Drive observations. It reports explicit causes when the user cannot use the assets. |
| Verify freshness and save | The service reads back selected mail threads and searched Drive revisions. `finishHandoff` interprets changed or unavailable provider state, and stages an authorized result. Staging and independent scratch readback are exact filesystem operations. |

The managed adapter uses the installed Gmail and Drive clients. An isolated GET
transport returns authored messages, payloads, permissions and changes. The
adapter builds the handoff from observed records and the agent's verified choice.
The verifier compares it with independently authored outcomes and provider reads.
The handoff retains source coordinates, file revisions, reviewed permissions and
content digests. Quoted values the user requests in the outcome must occur in
the actual reviewed bytes.

Mount `program` as `googleHandoff` and call `reconcileGoogleHandoff(goal)` with
the original request. Prepare the four scoped services with
`prepareOpenGoogleHandoffGoal({ contextId, caseId }, world)` from
`@workspace-skills/open-google-handoff-goal/managed` inside the owned evaluation
context. Keep the world and expected decisions with the adapter. Run
`verify(outcome)` for independent verification or `qualify()` to replay the
reference workflow against the same installed clients.
