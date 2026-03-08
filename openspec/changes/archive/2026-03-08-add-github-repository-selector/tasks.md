## 1. Repository Discovery Backend

- [x] 1.1 Add a control-plane GitHub service that lists repositories available to the configured installation and returns canonical owner, name, and clone URL metadata.
- [x] 1.2 Add a workspace-facing API endpoint for repository discovery and validate submitted repository selections against the live installation inventory on workspace creation.
- [x] 1.3 Add backend tests that cover repository listing, stale-selection rejection, and degraded GitHub setup behavior.

## 2. Workspace Creation UX

- [x] 2.1 Replace manual repository allowlist inputs in the workspace creation form with a search-and-select experience backed by the repository discovery API.
- [x] 2.2 Preserve selected repositories in the form state, show actionable loading and validation errors, and submit only installation-backed selections.
- [x] 2.3 Add frontend tests for loading repositories, selecting/removing entries, and handling repository refresh errors.

## 3. Integration Verification

- [x] 3.1 Persist canonical GitHub repository metadata in existing workspace repository records and confirm runtime provisioning continues to use those values.
- [x] 3.2 Add regression coverage for workspace creation and issue flows to verify selected repositories remain usable after provisioning.
