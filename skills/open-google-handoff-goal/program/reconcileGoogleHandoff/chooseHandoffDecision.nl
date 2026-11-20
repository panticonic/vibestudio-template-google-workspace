---
description: Decide what can be used given controlling mail and current Drive evidence.
args:
  goal: string
  mail: MailDecision
  assets: AssetEvidence[]
returns: HandoffDecision
---
1. An incomplete mail or provider observation means incomplete with provider reason. A withdrawn or unresolved decision means held with that reason. Keep the controlling message IDs and leave the asset IDs empty.
2. Evaluate every requested asset and whether the user needs all of them or permits a qualified alternative. Report holds for current approval that points to missing, inaccessible, trashed, or shortcut assets when the user needs that exact original. When required content or audience was unavailable, report incomplete. When actual content or sharing disagrees with the user's requirements, identify content or audience as the hold reason. An expressed allowlist governs only the requested roles. Use directRoles for a direct-only audit. Ignore revoked entries.
3. Use ready with approved reason when the current observations meet the requested conditions. Give only the approved usable asset IDs. Keep the exact controlling mail IDs. For a hold or incomplete outcome no asset is ready. If the user asks what text the selected asset contains, include the exact short quoted value and the file ID in facts.
