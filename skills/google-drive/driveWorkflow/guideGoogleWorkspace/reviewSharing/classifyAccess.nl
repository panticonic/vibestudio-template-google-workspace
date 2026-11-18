---
description: Find observed permissions that conflict with an assigned sharing policy.
args:
  request: GoogleSharingRequest
  permissions: GooglePermission[]
returns: string[]
---
Ignore deleted entries. Mark anyone permissions and domain or named principals outside the exact allowedDomains. For a user or group use the domain after its final @, with case-insensitive exact matching. Mark entries whose principal type or domain cannot be established. When allowWriters is false also mark writers and non-owner managers, including organizers and file organizers. An owner permission remains a reportable risk only when its audience violates the domain rule. Return unique source permission IDs in observation order.
