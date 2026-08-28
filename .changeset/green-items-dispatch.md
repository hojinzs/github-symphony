---
"@gh-symphony/cli": minor
---

Expose GitHub Project dispatch eligibility for unassigned, out-of-scope, label-ineligible, and fork pull request items with explainable reasons (#687). The GitHub eligibility event is now `tracker-dispatchability-derived`, retaining assignment/scope context and a reason breakdown; fork PR Project items are reported as non-dispatchable instead of degrading project status.
