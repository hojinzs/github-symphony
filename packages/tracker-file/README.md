# @gh-symphony/tracker-file

File-backed tracker adapter used only by local and Docker E2E environments.

## Adapter profile

Fixtures can provide `dispatchable: false` and `dispatchReason` directly. This
allows E2E coverage of the scheduler's adapter-neutral eligibility gate without
duplicating GitHub or Linear provider rules. Omitted `dispatchable` defaults to
`true`; production adapters, not the scheduler, derive their own eligibility.
