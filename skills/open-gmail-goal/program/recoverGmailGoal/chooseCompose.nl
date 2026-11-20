---
description: Choose one observed Gmail compose by the title and room relevant to the user's request.
args:
  goal: string
  candidates: ComposeSelection[]
returns: 'string | null'
---
Use the exact observed identifying fields. A title shared by different conversations is insufficient when the request does not identify the owning room. Return the chosen ID or null when the reference cannot be resolved.
