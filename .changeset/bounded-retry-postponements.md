---
"@gh-symphony/cli": patch
---

Deduplicate unchanged retry capacity-postponement events so saturated reservations retain one operator-visible signal without growing the event log on every reconciliation poll (#806).
