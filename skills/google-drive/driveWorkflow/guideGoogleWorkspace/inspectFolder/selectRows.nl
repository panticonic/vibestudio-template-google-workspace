---
description: Identify files that match the requested handoff purpose and exact media and time filters.
args:
  request: GoogleInventoryRequest
  rows: GoogleFolderRow[]
returns: string[]
---
Select files for the requested handoff purpose using the names and types from already eligible rows. Exclude folder rows unless the goal explicitly calls for folders. Return selected source IDs in observation order. Similar names do not establish identity.
