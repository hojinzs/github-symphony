## Context

The current workspace creation form asks operators to enter repository owner, repository name, and clone URL manually. That creates two classes of failure:

- invalid or mistyped repositories can be submitted even though the GitHub App installation cannot access them
- semantically correct repositories can still fail later when runtime allowlist checks compare raw clone URL strings and the operator-entered URL does not match GitHub's canonical clone URL

The control plane already uses GitHub App installation credentials for project creation and issue creation. The same brokered token can be used to enumerate repositories that belong to the current installation and to validate workspace selections without introducing a new trust boundary.

## Goals / Non-Goals

**Goals:**
- Let operators choose allowlisted repositories from the GitHub App installation inventory instead of typing raw repository metadata.
- Reuse brokered GitHub App credentials so the repository list is scoped to what the installation can actually access.
- Persist canonical repository metadata from GitHub in existing workspace repository records.
- Reject stale or invalid repository selections during workspace creation with actionable validation errors.

**Non-Goals:**
- Redesign issue creation or runtime repository selection beyond consuming the normalized workspace repository records.
- Add support for arbitrary Git providers or user-supplied personal access tokens.
- Introduce long-lived repository caching beyond what is required for a responsive creation flow.

## Decisions

### Use a dedicated control-plane API endpoint backed by brokered installation credentials

The control plane should expose an authenticated endpoint that returns the repositories visible to the current GitHub App installation. This keeps GitHub access on the server, reuses existing installation-token brokering, and prevents the browser from handling GitHub credentials directly.

Alternative considered: fetch repositories directly from the browser through GitHub OAuth or user tokens.
Why not: it would create a second authentication model and expose repository discovery to credentials outside the platform-managed GitHub App integration.

### Persist existing workspace repository fields using canonical GitHub data

The new selection flow should still store `owner`, `name`, and `cloneUrl`, but those values should come from the GitHub API response rather than operator input. This removes the immediate source of formatting drift without requiring a schema migration before implementation.

Alternative considered: add a new `githubRepositoryId` column immediately.
Why not: a repository ID would improve long-term identity handling, but the current runtime and issue flows already operate on owner/name/clone URL, and the user-reported failure can be addressed without blocking on schema changes.

### Validate submitted repository selections at workspace creation time

The workspace creation API should treat repository IDs or selection keys as untrusted input and resolve them back against the current installation repository inventory before creating the workspace. This avoids persisting stale browser state when installation scope changes between page load and submission.

Alternative considered: trust the client payload after the repository list has been loaded once.
Why not: installation scope can change outside the page session, and trusting client-submitted repository metadata would reintroduce the same class of errors as manual entry.

### Keep the form selection-oriented with searchable UX

The repository inventory can be large, so the frontend should use a search/filter selection model instead of a static dropdown. The selected entries should remain visible as removable chips or cards so the operator can confirm the allowlist before submission.

Alternative considered: preserve the existing repeated freeform inputs and add autocomplete hints.
Why not: autocomplete still leaves the server dependent on operator-entered metadata and does not guarantee canonical clone URL persistence.

## Risks / Trade-offs

- [Large installation repository sets can make the picker slow] → Add server-side pagination or client-side filtering boundaries and expose loading/error states explicitly.
- [Installation scope can change between list load and submit] → Revalidate selections on the POST path and return a specific error when a previously visible repository is no longer available.
- [Runtime allowlist comparisons still use clone URLs] → Persist canonical GitHub clone URLs from the repository discovery API so the current runtime comparison remains stable.
- [The repository discovery endpoint adds another GitHub API dependency during workspace setup] → Reuse existing installation token caching and keep the endpoint read-only with clear degraded-state messaging when GitHub is unavailable.

## Migration Plan

1. Ship the repository discovery endpoint and workspace API validation behind the existing GitHub App bootstrap guard.
2. Update the workspace creation form to request the installation repository inventory and submit selected entries instead of manual repository metadata.
3. Verify new workspaces persist canonical repository metadata and that existing workspaces continue to function unchanged.
4. Roll back by restoring the manual-entry UI and removing the new endpoint if repository discovery proves unstable; stored workspace repository records remain backward compatible because the schema does not change.

## Open Questions

- Should the first implementation fetch all installation repositories or start with paginated retrieval once the installation exceeds a fixed threshold?
- Do we want to surface repository visibility details such as private/public or installation permissions in the picker, or keep the initial UX limited to repository identity only?
