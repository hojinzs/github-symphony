---
name: gh-pr-writeup
description: Create and refresh GitHub pull requests through the host-side github_graphql tool. Use when opening the Draft PR after the first pushed commit, refreshing the PR body before handoff, or converting a draft PR to ready for review.
---

# /gh-pr-writeup — GitHub PR Writeup Workflow

## Trigger

Use this skill when creating or updating the PR for the assigned issue.

- **Initial Draft** (WORKFLOW.md Step 2.4): the turn after your first commit, once the assigned branch exists on the remote.
- **Refresh** (WORKFLOW.md Step 2.9): immediately before marking the PR ready, and again on rework cycles before re-handoff.

The worker has no GitHub credentials: `gh pr create` / `gh pr edit` do not work. Every operation below is a `github_graphql` call with the body loaded from a scratch file outside the checkout (`jq -n --rawfile body "$scratch/pr-body.md" …`).

## Flow

1. Confirm the issue number, repository, base branch (from the workpad), and the assigned branch (`git branch --show-current`).
2. **Initial Draft only:** verify the branch is on the remote and ahead of the base:

   ```graphql
   query BranchState(
     $owner: String!
     $name: String!
     $base: String!
     $head: String!
   ) {
     repository(owner: $owner, name: $name) {
       id
       ref(qualifiedName: $base) {
         compare(headRef: $head) {
           aheadBy
           behindBy
         }
       }
     }
   }
   ```

   (`$base` = `refs/heads/<base>`, `$head` = `<branch>`.) If the ref is missing or `aheadBy == 0`, the previous host push did not land; record the diagnostic in the workpad and retry next turn.

3. Run the smallest meaningful validation for the changed area and capture the exact commands (targeted `npx vitest run <file>` for narrow scopes; the full Completion Bar commands before Refresh).
4. Draft the body using the template below, then:
   - **Create** (draft):

     ```graphql
     mutation CreateDraftPr(
       $repositoryId: ID!
       $base: String!
       $head: String!
       $title: String!
       $body: String!
     ) {
       createPullRequest(
         input: {
           repositoryId: $repositoryId
           baseRefName: $base
           headRefName: $head
           title: $title
           body: $body
           draft: true
         }
       ) {
         pullRequest {
           id
           number
           url
           isDraft
         }
       }
     }
     ```

   - **Refresh**:

     ```graphql
     mutation RefreshPr($pullRequestId: ID!, $title: String!, $body: String!) {
       updatePullRequest(
         input: { pullRequestId: $pullRequestId, title: $title, body: $body }
       ) {
         pullRequest {
           id
           url
         }
       }
     }
     ```

   - **Ready for review** (Step 2.9 only, after Refresh):

     ```graphql
     mutation ReadyPr($pullRequestId: ID!) {
       markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
         pullRequest {
           isDraft
         }
       }
     }
     ```

     On rework cycles also re-request review from the reviewers who requested changes: `requestReviews(input: { pullRequestId, userIds, union: true })` (user ids via `user(login:) { id }`).

5. Record the PR URL (create) or the refresh timestamp in the workpad.

## PR Body Template

Follow the repository's `.github/pull_request_template.md` when one exists; this structure satisfies it:

```md
## Issues

- Closes #<issue-number>

## Summary

- TL;DR: what changed and why (2–3 bullets)

## Change-point diagram

- <package/module> → <what it now does> (text diagram or bullet chain of the affected components)

## Start here

- <file:line> — the entry point a reviewer should read first
- <file:line> — the core change

## User-Visible Behavior / Operational Impact

- CLI/runtime behavior, deployment impact, or "None"

## Validation

- `command` — pass/fail (Completion Bar results; flake exceptions cite the follow-up issue)
- Docker E2E / blackbox evidence path or "not applicable: <reason>"

## Changeset

- `.changeset/<file>.md` (`<bump>`) or "Not needed because <reason>"

## Risks & rollback

- Remaining risk, reviewer focus area, rollback plan

## Changed files

- <path> — <one-line purpose>

## Post-merge / human validation

- [ ] Items the agent does not perform (deploy, external smoke, manual UX) — mirrored from the workpad Delegation section

## Security

- [ ] No real tokens, private keys, `.env` files, or generated installation tokens are committed
```

## Rules

- Keep `Post-merge / human validation` and `Security` unchecked; they are for humans.
- `Closes #<n>` under `## Issues` is mandatory so GitHub links and auto-closes the issue.
- Everything in English (WORKFLOW.md Posture 2).
- In `Validation`, list concrete commands and outcomes, never "tests passed".
- On Refresh, rewrite `Summary`, `Change-point diagram`, `Validation`, and `Changed files` so they describe the latest diff.
- Never mark a PR ready before the Completion Bar and changeset policy pass.

## Related Skills

- `/pull` — merge the base branch into the assigned branch when behind (never rebase)
- `/push` — how the host publishes your commits at turn end
- `/land` — merge approved PRs after checks and approvals are green
