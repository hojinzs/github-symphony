---
name: land
description: Merge an approved PR during the Land state. Runs pre-flight checks through github_graphql, updates the branch server-side when behind, performs the squash merge, completes post-merge bookkeeping, and transitions the issue to Done.
license: MIT
metadata:
  author: gh-symphony
  version: "2.0"
---

# /land — Land State Merge Workflow

## Trigger

Use this skill only when the issue is in the `Land` state. A human has approved the PR and the remaining job is to merge it safely and complete required post-merge bookkeeping.

Work unattended. Do not ask humans for follow-up. Stop only on a genuine blocker (see _Failure Handling_).

## Operating Rules

- The worker has **no** GitHub credentials: `gh` is unauthenticated and `git push` is impossible. Every GitHub read and write in this skill goes through the host-side `github_graphql` tool with named operations and variables scoped to this PR/repository.
- Use `/gh-project` for every tracker state read/transition. Never traverse provider boards or mutate tracker fields directly.
- Land changes no source files. The only local Git operations allowed are `git pull --ff-only origin <head>` after a server-side branch update and resolving a **trivial conflict** (`.changeset/*`, `docs/**`, `CHANGELOG.md`, lockfile) with `git merge origin/<base>` per `/pull`. Never rebase, amend, or switch branches — the host pushes the assigned branch fast-forward only at turn end.
- Land must finish within one or two turns (WORKFLOW.md Runtime Contract 5): waiting for CI happens inside a single turn.
- All issue/PR comments are English, written from a scratch file outside the checkout, passed as GraphQL variables.
- Never modify the issue body.
- Never hardcode `main` for branch-freshness checks — always use the PR's actual base branch (it may be an Epic working branch).
- **Squash merge only** for this repository.
- Record every merge attempt, blocker, and outcome in the Land cycle workpad comment.
- Treat a Project status transition as the final lifecycle mutation for the Land turn. Before requesting it, finish the pre-flight/merge decision and write its exact evidence, reason, and policy-authored status body into the workpad Validation/Progress Log. Send only transition intent through `/gh-project`, then publish the prepared body through `github_graphql` after confirmed readback. A confirmed transition out of `Land` makes the issue non-active, and the worker stops immediately afterward.

## Required Context

Before acting, collect:

1. Issue: state, identifier, title, labels, description, URL, repository.
2. Land cycle workpad comment for this issue (Step 4 created it; adopt one already created for this cycle number by a retried worker; if absent, create one before proceeding).
3. PR (`LandContext` query below): id, number, URL, base branch, head branch, `state`, `merged`, `mergeCommit`, `headRefOid`, `reviewDecision`, reviews, review threads, `mergeable`, `mergeStateStatus`, and the head commit's `statusCheckRollup` with `isRequired` per context.
4. Changeset file path, if the issue carries a `changeset:major|minor|patch` label (`git ls-files .changeset` on the checked-out head).

If no PR is linked to the issue, record the blocker in the workpad and exit.

```graphql
query LandContext($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      number
      url
      state
      merged
      isDraft
      baseRefName
      headRefName
      headRefOid
      mergeCommit {
        oid
      }
      mergeable
      mergeStateStatus
      reviewDecision
      reviews(last: 30) {
        nodes {
          state
          author {
            login
          }
          submittedAt
          commit {
            oid
          }
        }
      }
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          comments(first: 1) {
            nodes {
              createdAt
            }
          }
        }
      }
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              state
              contexts(first: 100) {
                nodes {
                  ... on CheckRun {
                    name
                    status
                    conclusion
                    isRequired(pullRequestNumber: $number)
                  }
                  ... on StatusContext {
                    context
                    state
                    isRequired(pullRequestNumber: $number)
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

## Merged-PR Precedence Guard

Run this guard immediately after loading Required Context and before every pre-flight check or failure classification:

1. Read the linked PR's `state`, `merged`, and `mergeCommit`.
2. If `state` is `MERGED`, skip approval, CI, branch freshness, changeset, mergeability, and every failure classification. Record the merged commit SHA and changeset path (if any) in the Land workpad, prepare the `Land` → `Done` body, transition through `/gh-project`, and exit.
3. Never transition a merged PR's issue to `Ready`, even if its deleted head branch makes a later freshness or mergeability check fail.

## Pre-flight Checks

All must pass before merging. If any fails, record the failure in the workpad and **do not** merge.

1. **At least one human approval on the current head.** A review with `state == APPROVED` from a human (not the orchestration account) whose `commit.oid` is the current `headRefOid`, **or** whose approved commit is an ancestor of the current head where every commit after it is a base-branch merge commit produced by this Land cycle (server-side `updatePullRequestBranch` or a trivial-conflict `git merge`). A merge-update never invalidates an approval under this policy; if branch protection dismissed it anyway, that is an external wait (Failure Handling 6). Save the latest qualifying approval's `submittedAt`; any unresolved actionable review thread whose first comment's `createdAt` is later than that approval fails Land as rework, while unresolved actionable threads created at or before the approval do not block Land.
2. **All required checks green on the head commit.** From `statusCheckRollup.contexts`, consider only entries with `isRequired: true`. Every required `CheckRun` must be `COMPLETED` with conclusion `SUCCESS`/`NEUTRAL`/`SKIPPED`; every required `StatusContext` must be `SUCCESS`. If no required contexts exist, this gate passes without waiting. Optional checks never gate Land.
3. **Branch not behind its base.** `repository { ref(qualifiedName: "refs/heads/<base>") { compare(headRef: "<head>") { aheadBy behindBy } } }` must report `behindBy == 0`. If behind: run the server-side update (`updatePullRequestBranch(input: { pullRequestId, updateMethod: MERGE })`), then `git pull --ff-only origin <head>` locally so the host push at turn end is a no-op, then **restart the Merged-PR Precedence Guard and the full pre-flight sequence** including the CI wait in step 5.
4. **Changeset present if labeled.** If the issue has a `changeset:major|minor|patch` label, confirm at least one `.changeset/*.md` file exists on the head (excluding `README.md` / `config.json`). If absent, this is a rework failure.
5. **CI wait after a fresh head.** When step 3 or a trivial-conflict merge produced a new head, poll `LandContext` every 10 seconds until the previously observed required contexts register on the new head (at most 5 minutes), then keep polling until every required context is terminal (at most 30 minutes). Stay in this turn while waiting. If registration or completion exceeds the limit, classify as Failure Handling 6.
6. **PR mergeable.** `mergeStateStatus` must be `CLEAN` / `HAS_HOOKS` / `UNSTABLE` (the last allowed only when failing checks are all non-required). `BLOCKED` / `DIRTY` / `BEHIND` / `UNKNOWN` (after re-querying twice) → not mergeable; classify per Failure Handling.

## Flow

1. Load context and run the Merged-PR Precedence Guard. The human-owned `In review` → `Land` transition is already confirmed before this worker is dispatched; record it as the Land-cycle trigger and do not issue a duplicate `/gh-project` request or status comment for it.
2. If the PR remains open, run all Pre-flight Checks.
3. Squash-merge:

   ```graphql
   mutation LandMerge(
     $pullRequestId: ID!
     $expectedHeadOid: GitObjectID!
     $headline: String!
   ) {
     mergePullRequest(
       input: {
         pullRequestId: $pullRequestId
         mergeMethod: SQUASH
         expectedHeadOid: $expectedHeadOid
         commitHeadline: $headline
       }
     ) {
       pullRequest {
         merged
         mergeCommit {
           oid
         }
       }
     }
   }
   ```

   `commitHeadline` is the PR title followed by ` (#<number>)`. `expectedHeadOid` is the head you verified in pre-flight; a mismatch means the head moved — restart pre-flight.

4. Delete the head branch: `repository { ref(qualifiedName: "refs/heads/<head>") { id } }` then `deleteRef(input: { refId })`. A failure to delete is recorded but is not a blocker.
5. Update the Land cycle workpad's `### Validation` and `### Progress Log` sections with merge commit SHA, changeset path (if any), timestamp from `date -u`, and the exact `Land → Done` reason. Complete all Land-cycle evidence before the tracker transition.
6. Prepare the `🔁 Status: Land → Done` body (cycle close: land), then send only transition intent through `/gh-project`.
7. If readback confirms `Done`, publish the prepared body through `github_graphql`. If the response is not confirmed, record the failure and do not publish the status comment.

## Failure Handling

1. **Merged-PR precedence is always first.** Re-read the linked PR's `state` before classifying a failure. If it is `MERGED`, discard the pending failure classification, record the merge commit SHA, transition `Land` → `Done` through `/gh-project`, and exit. A deleted head branch is not rework after merge.
2. Record the exact failure (operation, response excerpt, head SHA, timestamp) in the workpad `### Progress Log`.
3. If immediately recoverable in this run (branch behind → server-side update), do so and re-run the merged guard plus pre-flight from scratch. **Trivial conflict** recovery confined to `.changeset/*`, `docs/**`, `CHANGELOG.md`, or the lockfile uses a `/pull` merge, keeps both changesets, regenerates the lockfile when needed, and publishes the merge before re-running the merged guard plus every pre-flight check while remaining in `Land`. No other file may be edited.
4. Do not retry a non-recoverable Land pre-flight failure on later turns. First write its concrete classification, response excerpt, timestamp, exact transition reason, and prepared status body into the workpad; then close the Land cycle after the orchestrator confirms the transition readback and publish the body through `github_graphql`.
5. **Required CI pending or registering** — keep `Land` and wait inside this turn per Pre-flight step 5. When checks complete, restart the merged guard and all pre-flight checks. A failed required check is a rework failure; a green result proceeds to merge.
6. **Approval or other external wait-only failure** — no valid human `APPROVED` review on the current head (per Pre-flight step 1), a dismissed approval, `mergeStateStatus: BLOCKED` by a protection rule the worker cannot satisfy, or a CI wait that exceeded the limits: prepare a status body naming the concrete gate that failed, the head SHA it was evaluated against, and what a human must do; send `Land` → `In review` transition intent through `/gh-project`, then publish the body through `github_graphql` after confirmed readback. This is not a `⛔ Blocker`.
7. **Rework failure** — failed required CI, a source-file merge conflict (`mergeable: CONFLICTING` outside the trivial set), missing labeled Changeset, an unresolved actionable review thread created after the latest qualifying human approval on the current head (compare its first comment's `createdAt` with the approval's `submittedAt`), or another PR/code condition that the worker can address: prepare a status body with reason `Land-return rework: <cause>`, send `Land` → `Ready` transition intent through `/gh-project`, then publish the body through `github_graphql` after confirmed readback. An unresolved actionable thread created at or before that approval is absorbed by the approval and does not block Land. The Ready-return rework guard opens the next work cycle and routes the item to `In progress`.
8. **External or permission blocker** — missing required context, authentication/board failure, or an external dependency the worker cannot resolve: write a `⛔ Blocker` comment with what · why · how to unblock, prepare a status body stating the unblock condition, send `Land` → `Backlog` transition intent through `/gh-project`, then publish the body through `github_graphql` after confirmed readback.

## Guardrails

- Do not merge without ≥1 valid approval and green required CI.
- Do not use merge / rebase / auto-merge — only squash with branch deletion.
- Do not transition the issue to `Done` before the merge succeeds.
- Do not traverse provider boards or mutate tracker fields directly; use `/gh-project`.
- Do not modify the issue body.
- Do not edit source files in a Land cycle; conflicts outside `.changeset/`, `docs/`, `CHANGELOG.md`, and the lockfile go back to `Ready`.
- Do not leave a non-recoverable failure in active `Land`; return it to `In review`, `Ready`, or `Backlog` according to Failure Handling.
