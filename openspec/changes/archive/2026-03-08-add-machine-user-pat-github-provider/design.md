## Context

The control plane now relies on a machine-user PAT to perform repository discovery, workspace project provisioning, issue creation, and runtime GraphQL mutation. GitHub App support was removed so the setup model, persistence model, and runtime broker all align with the single supported GitHub credential path.

## Goals / Non-Goals

**Goals:**
- Use a machine-user PAT classic GitHub provider as the only supported first-run integration path.
- Validate that the stored PAT can list repositories, create organization-owned Projects, create issues, and perform runtime GraphQL mutations before marking setup ready.
- Remove GitHub App bootstrap, installation, and provider-specific routing paths from setup, brokering, and recovery flows.
- Make the setup UI explicit about requiring organization-backed machine-user credentials.
- Route all GitHub repository, issue, project, and runtime credential operations through one PAT-backed broker.

**Non-Goals:**
- Support personal-account PAT guidance beyond clearly discouraging that path for project-backed workspaces.
- Add per-workspace GitHub credential selection or multiple concurrent system GitHub providers.
- Introduce fine-grained PAT support before classic PAT compatibility is proven against the required Project APIs.

## Decisions

### Model the system GitHub integration as one PAT-backed singleton

The persisted singleton GitHub integration record stores encrypted PAT material, token fingerprint, validated actor login, and validated owner metadata. App-specific fields and provider branching are removed so the readiness model matches the only supported setup path.

### Make machine-user PAT bootstrap the only setup flow

The setup UI presents one flow: PAT entry plus intended organization owner. Removing the App manifest/install branch keeps setup, recovery, and operator guidance aligned with the actual supported path.

### Validate PAT readiness against the exact operations the product depends on

PAT bootstrap requires successful checks for actor lookup, repository inventory, organization owner lookup, and Project capability before the integration is marked ready.

### Introduce one PAT-backed GitHub credential broker

Repository discovery, workspace provisioning, issue creation, and runtime GitHub credential brokering resolve credentials through one broker interface that always returns the decrypted stored PAT plus validated owner metadata.

## Risks / Trade-offs

- [PAT classic is a long-lived high-value secret] → Reuse encrypted secret storage, expose token fingerprint only, and keep setup/recovery guidance explicit about rotation.
- [PAT classic is broader than least-privilege GitHub App tokens] → Recommend machine-user accounts and organization-scoped operational ownership in docs and setup copy.
- [Migrating away from existing App-based deployments could require operator action] → Keep PAT setup and recovery explicit in docs and make degraded-state messaging point back to the PAT bootstrap flow.
- [GitHub may further constrain classic PAT usage over time] → Keep the PAT broker and validation path evolvable so the system can later adopt fine-grained PAT or another credential type if GitHub closes required gaps.

## Migration Plan

1. Simplify persisted GitHub integration state to PAT-only fields.
2. Remove GitHub App setup APIs, UI, and helper code.
3. Route repository, project, issue, and runtime credential flows through the PAT-backed broker.
4. Update runtime artifact naming and docs to remove GitHub App terminology.
5. Roll back by restoring the previous GitHub App implementation if PAT-only support proves insufficient.

## Open Questions

- Should we add a dedicated PAT rotation endpoint later, or is re-running setup sufficient?
- Do we want to support fine-grained PATs after the classic PAT path proves stable?
