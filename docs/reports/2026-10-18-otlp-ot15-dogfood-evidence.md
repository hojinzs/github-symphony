# OTLP OT-15 supervised dogfood delivery evidence

- Date: 2026-10-18 (run window 2026-10-17 16:23–16:32 UTC)
- Status: Complete — OT-15 delivery proof for [Epic #794](https://github.com/hojinzs/github-symphony/issues/794); unblocks [#998](https://github.com/hojinzs/github-symphony/issues/998)
- Issue: [#1077](https://github.com/hojinzs/github-symphony/issues/1077) (operator-owned, not worker pickup)
- Contract: [OTLP design OT-15](../designs/2026-10-04-otlp-export-design.md), [dogfood plan — Account and dispatch checks / Dogfood evidence after approval](../designs/2026-10-04-otlp-export-dogfood-plan.md)
- Source revision under test: `ae2c39e6d3510f1d30ae4b5828275d0363df7a2b` (`origin/main` when the build worktree was created at 2026-10-17 07:09Z, `gh-symphony v3.0.0`; see [Revision under test](#revision-under-test))
- Symphony Layers: Coordination, Execution, Integration, Observability. Policy is the test repository's committed `WORKFLOW.md`.
- Change classification: documentation only. No runtime, CLI, package, configuration, or `docs/symphony-spec.md` change.
- Evidence bundles (Evidence Browser workspace `github-symphony`):
  [launch and dispatch](https://evidence-browser.dev0.daniworks.kr/w/github-symphony/b/20261018-0123-otlp-k0-ot15-dogfood-attempt1),
  [delivery](https://evidence-browser.dev0.daniworks.kr/w/github-symphony/b/20261018-0132-otlp-k0-ot15-delivery-attempt1)

## Decision

OT-15 passes. A dependency-ready, bot-assigned child was dispatched by an
`--assigned-only` daemon built from `main` `ae2c39e6`. It was delivered through its
own workpad, assigned branch, PR, CI, human approval, Land, and merge, while its
`epic` parent stayed active and was excluded by the pickup-label policy for the
whole session. The OTLP exporter was disabled, as the issue allows; OT-15 does
not depend on OTLP receipt. OT-14 Collector evidence is recorded separately in
[#997](https://github.com/hojinzs/github-symphony/issues/997) /
[PR #1059](https://github.com/hojinzs/github-symphony/pull/1059) and is not
merged into this record.

## Revision under test

`ae2c39e6` was `origin/main` when the build worktree was created (07:09Z), not
at launch (16:23Z). Eight mainline commits landed in between (`1b60bb5a` …
`a01a20b8`, the last at 16:16:53Z). `git diff ae2c39e6 a01a20b8` changes
nothing under `packages/tracker-github`, `packages/worker`, `packages/core`, or
`packages/runtime-codex`. It also leaves the CLI `project start` path untouched;
CLI changes are limited to agent setup, doctor, help, completion, and OTLP
diagnostics. In `packages/orchestrator` it touches only OTLP validation files
(`exporter-environment.ts`, `otlp-validation*.ts`,
`observability/resource-validation.ts`, and the package export map). The one
function on the exporter-disabled dispatch path,
`validateExporterCredentialNames`, only changes its error type, and this
workflow declares no exporter credential references. The tested dispatch,
pickup-label exclusion, and delivery path therefore matches `main` at launch.
This record does not claim delivery on any later revision.

## Divergence from the issue as filed

The operator approved running the dogfood in an isolated project instead of on
Project #14 ([AC amendment](https://github.com/hojinzs/github-symphony/issues/1077#issuecomment-6230887499)).
The production `~/moncher-stack/github-symphony` daemon could not produce the
required evidence as-is:

| Constraint                                                                          | Effect on the evidence                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The daemon ran a Sep 15 build (`dcfcaffc`, #981)                                    | A run there would not exercise any OTLP A–J code. Rebuilding the shared checkout in place would also have changed workers of the running evidence-browser daemon                                                                                                                           |
| It reads an operator-owned `WORKFLOW.md` copy that differs from the repository file | No workflow commit SHA could be attributed                                                                                                                                                                                                                                                 |
| #794 is In progress with `epic` but assigned to `hojinzs`                           | The GitHub adapter applies the pickup-label reason only to issues that are still dispatchable after the assigned-only filter (`packages/tracker-github/src/orchestrator-adapter.ts`, `applyPickupLabelDispatchability`), so #794 shows as an assignment exclusion, not an `epic` exclusion |
| #987–#997 were closed; #998 and #1077 are excluded                                  | No #794 child was available to dispatch                                                                                                                                                                                                                                                    |

The supervised project therefore used a test epic whose only exclusion path is
the label. Supplementary production check: the production runtime
(`~/.gh-symphony/projects/github-symphony-7f2244c6`) held 409 run records at
capture time, none for #794. This is assignment-masked and is not label proof.

## Account and dispatch identity (recorded before launch)

| Field                                          | Value                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dispatch auth login (daemon adapter principal) | `moncher-dev`, via `GITHUB_GRAPHQL_TOKEN` from the project `.env`; daemon output `Authenticated via GITHUB_GRAPHQL_TOKEN as moncher-dev`; tick event `currentUserLogin: moncher-dev`. Local `gh` auth (also `moncher-dev`) was not used as proof                                                                                          |
| Child creator / bot assignee                   | `moncher-dev` / `moncher-dev`                                                                                                                                                                                                                                                                                                             |
| Human reviewer and Land decision               | `hojinzs` (repository write, Project writer)                                                                                                                                                                                                                                                                                              |
| Supervised project                             | Repository [moncher-dev/symphony-dogfood-ot15](https://github.com/moncher-dev/symphony-dogfood-ot15) (public); Project [moncher-dev/projects/7](https://github.com/users/moncher-dev/projects/7) with Project #14's Status options                                                                                                        |
| Project folder                                 | `~/moncher-stack/symphony-dogfood-ot15`                                                                                                                                                                                                                                                                                                   |
| Build                                          | Detached worktree `~/moncher-stack/.builds/symphony-ae2c39e6` at `ae2c39e6`, clean tree; the shared `~/Projects/github-symphony` checkout and `~/symphony-projects` daemons were not touched                                                                                                                                              |
| Workflow revision                              | Test repository commit `d203badb3def13a501c8d29fa293b2ca97478966`; `WORKFLOW.md` sha256 `9f451b47e9a354a30a916b5710681af54d3a59569685ed84fe6ab1504dd34883`, identical in the daemon folder and the repository blob. It keeps `pickup_labels.exclude: [epic]`, `blocker_check_states: [Ready]`, and the production Codex runtime and model |
| Launch command                                 | `SYMPHONY_ALLOW_WORKFLOW_HOOKS=1 GITHUB_GRAPHQL_TOKEN=<project .env> node ~/moncher-stack/.builds/symphony-ae2c39e6/packages/cli/dist/index.js project start --project-dir ~/moncher-stack/symphony-dogfood-ot15 --assigned-only --log-level normal --daemon`                                                                             |
| Exporter                                       | Disabled: status `telemetry.state: disabled`, `disabledReason: workflow`                                                                                                                                                                                                                                                                  |
| Branch protection                              | `main`: 1 approving review, strict required check `test`, enforced for admins                                                                                                                                                                                                                                                             |

The `run-dispatched` event reports `workflowRevision: sha256:66e5962c23d4`. That
value is the parsed-configuration version hash (`calculateWorkflowVersionHash`),
not a hash of the file bytes.

## Delivery proof

| Field            | Value                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Child            | [moncher-dev/symphony-dogfood-ot15#2](https://github.com/moncher-dev/symphony-dogfood-ot15/issues/2), a native sub-issue of test epic [#1](https://github.com/moncher-dev/symphony-dogfood-ot15/issues/1), no blockers, size S                                                                                                                                                                                         |
| Ready scheduling | Operator moved #2 Backlog → Ready at 16:24:18Z                                                                                                                                                                                                                                                                                                                                                                         |
| Claimed runs     | Cycle 1 `symphony-dogfood-ot15-bb39ef96-moncher-dev-symphony-dogfood-ot15-2-mvclx1s1` (Ready → In progress → In review, 16:24:30–16:26:35Z); cycle 2 `symphony-dogfood-ot15-bb39ef96-moncher-dev-symphony-dogfood-ot15-2-mvcm52sf` (Land → Done, 16:30:45–16:32:17Z). Both succeeded with no error under daemon PID 8272. The worker ran from the recorded build (`…/symphony-ae2c39e6/packages/worker/dist/index.js`) |
| Assigned branch  | `symphony/moncher-dev-symphony-dogfood-ot15-2`, published by the host                                                                                                                                                                                                                                                                                                                                                  |
| Workpads         | One per cycle on #2 (Cycle 1, Cycle 2 (Land)), plus status transition comments                                                                                                                                                                                                                                                                                                                                         |
| PR               | [moncher-dev/symphony-dogfood-ot15#3](https://github.com/moncher-dev/symphony-dogfood-ot15/pull/3), author `moncher-dev`, closes #2                                                                                                                                                                                                                                                                                    |
| Head SHA         | `c6b7c49f201c606ee81cf3eaf393c406dc78cf12`                                                                                                                                                                                                                                                                                                                                                                             |
| Tests            | CI `test` succeeded on the head commit (run 39049356633) and on the merge commit (run 39049776055). Independent operator re-run at the merge commit: `npm run lint` passed, `npm test` 6/6 passed, and each acceptance behavior in #2 was checked directly                                                                                                                                                             |
| Human decision   | `hojinzs` APPROVED `c6b7c49f` at 16:30:14Z and moved #2 In review → Land at 16:30:23Z                                                                                                                                                                                                                                                                                                                                  |
| Merge            | Squash merge by the agent at 16:31:20Z, merge commit `42c5710ba05e6ff60b6e9c65499c118ee08aed90`, branch protection satisfied; #2 closed and moved to Done at 16:31:38Z                                                                                                                                                                                                                                                 |

## Parent exclusion

Test epic #1 carried `epic`, was assigned to the dispatch principal, and stayed
In progress (an active state) throughout. With `--assigned-only`, the
assignment filter passes. The build's own `listIssues` reported
`dispatchable: false` with `Issue has excluded pickup label "epic".` before
Ready scheduling, after dispatch, and after merge. The session runtime holds
two runs, both for #2, and zero for #1.

The adapter's `tracker-dispatchability-derived` event reports
`nonDispatchableCount: 0` for this board. Pickup-label dispatchability is
applied after that event is emitted, so the event alone cannot show label
exclusions. The label reason was captured from `listIssues` output through a
read-only probe; see the launch bundle.

## Cleanup

The dogfood daemon was stopped after delivery (`project stop`, no remaining
processes). The test repository and Project remain available so the evidence
links stay valid. The build worktree is retained until this record merges.
