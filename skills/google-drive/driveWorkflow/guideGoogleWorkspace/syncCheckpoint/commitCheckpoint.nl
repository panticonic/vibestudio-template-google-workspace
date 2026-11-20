---
description: Apply one checkpoint transition guarded by the previously saved cursor.
args:
  expected: string
  terminal: string
returns: GoogleCheckpointReceipt
---
Call driveCheckpoint.commit with expected and terminal exactly once. Return the receipt unchanged.
