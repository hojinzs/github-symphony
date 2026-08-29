---
"@gh-symphony/cli": patch
---

Report `seconds_running` as accumulated worker-session runtime, excluding retry gaps while retaining completed-session runtime across restarts (#750). Retry records now freeze their completed-session boundary so retry scheduling does not extend that measurement.
