---
description: Read back authoritative versions and save the requested handoff.
args:
  plan: HandoffPlan
  decision: HandoffDecision
returns: HandoffOutcome
---
1. If the decision is incomplete, return it with no handoff. Otherwise call googleHandoffFreshness.verify with the decision.
2. When the provider observations changed, return stale with changed reason, the same supporting message IDs and no asset IDs, quotes, or handoff. For unavailable readback, return incomplete with provider reason and no asset IDs, quotes, or handoff.
3. With current evidence, stage a ready decision for a ready or decision plan. Stage a held decision only for a decision plan with at least one supporting message. Call googleHandoffScratch.stage with the original verified decision and return its actual receipt. Otherwise report the decision with no handoff.
