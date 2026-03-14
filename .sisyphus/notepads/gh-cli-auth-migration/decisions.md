# Decisions — gh-cli-auth-migration

## Token Caching Strategy
- Orchestrator caches token at startup (1x `gh auth token` call), not per-poll
- Avoids subprocess overhead in 30s polling hot path

## Scope Check Behavior
- Fine-grained PATs report empty scopes → treat as valid (skip scope check)
- Required scopes: `["repo", "read:org", "project"]`

## Token Broker
- `GITHUB_TOKEN_BROKER_URL/SECRET` pattern MUST NOT be modified
- Keep existing broker code intact

## control-plane
- Explicitly out of scope — separate auth system, do not touch
