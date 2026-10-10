---
"@gh-symphony/cli": patch
---

Ship the typed management-agent module with protected enrollment persistence and a foreground HTTPS heartbeat/poll runtime, exclusive sessions and bounded reconnect recovery (#1009, Epic #983).

The fleet store upgrades lifecycle schema v2 to session schema v3 while preserving commands; version-2 fleet binaries reject the upgraded database.
