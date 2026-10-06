---
"@gh-symphony/cli": patch
---

Carry runtime kind and measured token provenance in worker updates, distinguishing valid measured zero from initialized counters while preserving session deltas. Workers can start with enabled OTLP and unresolved exporter references without inheriting exporter secrets (#990).
