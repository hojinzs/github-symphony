## Why

The product needs one reliable GitHub credential model for repository discovery, workspace provisioning, issue creation, and runtime GraphQL mutation. The GitHub App path added avoidable setup and recovery complexity, while the machine-user PAT path already covered the required organization-backed workflow more directly.

## What Changes

- Make machine-user PAT bootstrap the only supported system GitHub setup path.
- Remove GitHub App bootstrap, installation, and provider-specific brokering code.
- Persist PAT validation metadata needed to explain ready, degraded, or misconfigured state.
- Update control-plane GitHub operations, runtime credential brokering, and docs to be PAT-only.

## Capabilities

### Modified Capabilities
- `github-app-bootstrap`: replace App-specific bootstrap requirements with PAT-only setup and recovery requirements.
- `workspace-control-plane`: require the validated machine-user PAT for GitHub Project creation and repository discovery.
- `issue-driven-agent-execution`: require the stored machine-user PAT for issue creation and runtime GitHub mutation flows.

## Impact

- Affected code: setup UI and APIs, persisted GitHub integration state, repository discovery, workspace orchestration, issue creation, runtime GitHub credential brokering, docs, and tests.
- Affected APIs: setup-status payloads, GitHub integration helpers, runtime credential broker responses, and setup routes.
- Affected systems: machine-user PAT management, GitHub REST/GraphQL mutation paths, and first-run operator guidance.
