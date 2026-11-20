---
description: Read all mail threads in the bounded relevant search.
args: {}
returns: MailObservation
---
Call googleHandoffMail.discover. When discovery is incomplete, return an incomplete observation. Otherwise read every discovered thread through googleHandoffMail.read. Return all readable threads and set complete when every thread was readable.
