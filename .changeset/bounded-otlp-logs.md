---
"@gh-symphony/cli": patch
---

Add the orchestrator's internal structured Logs OTLP/protobuf pipeline with bounded queues, retries and shutdown, isolated resource identity, and safe local loss diagnostics (#993). Production OTLP activation remains gated until the complete pipeline passes packaged audits.
