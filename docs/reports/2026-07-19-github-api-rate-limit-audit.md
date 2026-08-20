# GitHub API Rate Limit Exhaustion Audit Report

- **Date**: 2026-07-19
- **Scope**: `packages/tracker-github`, `packages/orchestrator`, `packages/tool-github-graphql` — every path that consumes the GitHub API
- **Trigger**: In an orchestrator using a GitHub Project as the tracker, the GraphQL quota was exhausted rapidly when orchestrating multiple repositories
- **Method**: Static trace of the dispatch loop → exhaustive survey of call sites → identification of duplication/N+1 → adversarial validation of removability (attempting to disprove that things really are redundant)
- **Status**: Partially implemented — §2 R1.5 (server-side state filter) shipped via `docs/adr/2026-08-01_github-project-v2-server-side-state-filtering.md` (PR #500, #515). The remaining items are kept as a point-in-time snapshot.

> ✅ **2026-07-19 update: costs have been replaced with measured values.** The first edition's estimate (~245pt per page) was based on the documented node-multiplication formula and turned out to be **an overestimate of roughly 22x — the measured value is 11pt.** Everything has been revised based on the `rateLimit { cost }` returned by the live GitHub API.
>
> Measurement setup: the same nested structure as the current `PROJECT_ITEMS_QUERY`, invoked directly via `gh api graphql`. Identical results confirmed on both a validation board (61 items) and the **actual production board (`PVT_kwDOBB0_W84BRapW`, 90 items)**.
>
> **Items whose conclusions changed relative to the first edition: P1 (cost attribution), P10 (API constraint → resolved), P9 (archive behavior), R1.5 (demoted), Appendix A (fully replaced).**

---

## Summary

Core conclusion: **splitting tokens/keys does not solve the problem.** GitHub's primary rate limit is per authenticated principal (account), not per token, so issuing N PATs under the same account still shares the single 5,000 point/hr bucket.

The real cause is the product of two axes: **① the point cost of a single query** (P1) × **② fetching the entire board regardless of state** (P10). The third axis the first edition blamed — **③ deployment-structure duplication (P2) — does not apply to the current deployment, per measurement.**

**Production measurement conclusion — a single daemon alone exceeds the limit.**

Measuring the actual deployment (`/Users/steve/Projects/ioa-tracker`, single daemon, single repo, 90-item board, 30-second polling):

```
4 pages × cost 11 = 44 pt/cycle × 120 cycle/hr = 5,280 pt/hr
                                    vs. limit 5,000 → 106% (exceeded)
```

**"When orchestrating multiple repositories" was not the precondition. One repo and one daemon already exceed the limit.** Multiple repos merely accelerated the symptom; they are not the cause. Accordingly, **P2 (daemon duplication), which the first edition named as the main culprit, does not apply to the current deployment**, and the actual cause is the two axes **P1 (11x cost per request) × P10 (fetching everything, up to 83 Done items)**.

| ID  | Problem                                                                                                                                                | Severity    | Nature               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | -------------------- |
| P1  | Nested PR `labels`/`assignees` amplify request cost **11x, from 1 → 11pt** (measured)                                                                  | 🔴 Critical | Query design         |
| P10 | Fetches the **entire board** regardless of state (92% of the production board is Done) — server-side filter unused **even though the API supports it** | 🔴 Critical | Fetch path           |
| P2  | Per-repo daemons = N fetches of the same board — **does not apply to the current deployment**, a risk at scale-out                                     | 🟡 Medium   | Deployment structure |
| P3  | Unbounded advisory-comment paging (every cycle, even with no changes)                                                                                  | 🟠 High     | N+1                  |
| P4  | Actual point cost is unobservable                                                                                                                      | 🟠 High     | Observability        |
| P5  | Internal N+1 in `fetchIssueStatesByIds` (sequential, worst case 100 round trips)                                                                       | 🟡 Medium   | N+1                  |
| P6  | `fetchPriorityOptionOrder` re-fetched every cycle                                                                                                      | 🟡 Medium   | Caching              |
| P7  | No handling of 403/429 · `Retry-After`                                                                                                                 | 🟡 Medium   | Resilience           |
| P8  | `tool-github-graphql` consumes the same bucket with no rate-limit guard                                                                                | 🟡 Medium   | Budget leak          |
| P9  | Stale state retained for archived board items                                                                                                          | ⚪ Low      | Consistency          |

---

## 1. Problems

### 🔴 P1. Nested PR fields amplify request cost 11x (measured)

- **Files**: [`packages/tracker-github/src/adapter.ts:1691`](../packages/tracker-github/src/adapter.ts) (`PROJECT_ITEMS_QUERY`), nesting location [`adapter.ts:1810`](../packages/tracker-github/src/adapter.ts) `PullRequestMetadata` fragment, page size [`adapter.ts:10`](../packages/tracker-github/src/adapter.ts) `DEFAULT_PAGE_SIZE = 25`
- **Measurements (`first: 25` fixed, only the field composition varied)**:

  | Query composition                                              | Measured cost |
  | -------------------------------------------------------------- | ------------- |
  | `items` + `content { id }` only                                | **1**         |
  | + `blockedBy(first: 100)`                                      | **1**         |
  | Full current query (incl. nested PR `labels`/`assignees`)      | **11**        |
  | Current query with only nested PR `labels`/`assignees` removed | **1**         |

- **Key point**: The entire 10pt increase comes from **the `labels(20)`/`assignees(20)` nested inside `closedByPullRequestsReferences`**. These two fields are not used in any orchestrator decision; they are only passed through as worker template variables (§2 R1).
- **First-edition correction**: `blockedBy(first: 100)` was blamed as a major cost source, but **its measured contribution is 0**. It is not a removal target.
- **Impact**: Production board (90 items) = 4 pages × 11pt = **44 pt/cycle**. At 30-second polling, **5,280 pt/hr — 106% of the 5,000 limit, exceeded.** Fixing this one item alone brings it down to 9.6% (Appendix A-1).

> **Increasing `pageSize` is cost-neutral — confirmed by measurement.** For `first:` 10/25/50/100 the cost is 4/11/22/44, i.e. linear. That is, 100 items in 1 request (44) = 25 items in 4 requests (4×11=44). The totals are exactly equal, so only latency improves.

### 🔴 P10. The entire board is fetched with the heavy query regardless of state

- **Files**: [`adapter.ts:495-538`](../packages/tracker-github/src/adapter.ts) per-item `flatMap` in `fetchProjectIssues`, state-filtering location [`service.ts:1323`](../packages/orchestrator/src/service.ts) `resolveActionableCandidates`
- **Evidence**: The only filters `fetchProjectIssues` applies are **content type · `assignedOnly` · `repositoryFilter` — three filters, no state filter.** State determination happens locally **after** everything has been fetched. In other words, items that will never be picked up — Backlog, Done, etc. — are fetched with P1's heavy fragment (~980 nodes per item).
- **⚠️ First-edition correction — the API constraint no longer exists.** The first edition cited [`adr/2026-03-19`](./adr/2026-03-19_github-project-v2-state-filtering-cache.md) and stated "Project V2 does not offer query-time filtering," but **a live schema introspection on 2026-07-19 shows that `ProjectV2.items` has a `query: String` argument.** GitHub appears to have added it after the ADR was written.

  ```
  items(first:, after:, before:, last:, orderBy:, archivedStates:, query:)
                                                   ↑ "Search query for filtering items"
  ```

- **Measured validation** (61-item board, Status options `Backlog / Ready / In progress / In review / Land / Done`):

  | `query` argument       | Items returned          |
  | ---------------------- | ----------------------- |
  | (none)                 | 61                      |
  | `status:Backlog`       | 8                       |
  | `status:Done`          | 53                      |
  | `-status:Done`         | **8**                   |
  | `-status:Done,Backlog` | 0                       |
  | `is:open` / `is:issue` | 8 / 56                  |
  | `status:NoSuchState`   | **0 (not an error)** ⚠️ |

  `8 + 53 = 61` is consistent, and negation (`-`), multi-value, and `is:` qualifiers all work.

- **Impact**: Cost scales with **the total board size, not the number of actionable candidates.** It increases monotonically as Done items accumulate, with no upper bound. **83 of the 90 items (92%) on the production board are Done**, and `-status:Done` yields 7 — merely applying the filter cuts 4 pages down to 1.
- **⚠️ Adoption pitfall**: `status:NoSuchState` returns **an empty result, not an error**. With a positive filter (`status:Ready,...`), the moment a Status option name changes on the board, the orchestrator **silently stops all dispatch**. See §2 R1.5 for the countermeasure.

### 🟡 P2. Per-repo daemons = N fetches of the same board (does not apply to current deployment)

> **Demoted by 2026-07-19 measurement.** The first edition named this as the main culprit, but verification shows **only one orchestrator is running** (PID 42112, `gh-symphony repo start --assigned-only`, cwd `/Users/steve/Projects/ioa-tracker`, started 2026-07-17). With a single-project, single-repo configuration, duplicate fetching does not occur.
>
> The structural analysis below remains valid **when scaling to multiple repos**, so the record is kept.

- **Files**: [`service.ts:638`](../packages/orchestrator/src/service.ts) `reconcileProject`, [`orchestrator-adapter.ts:196`](../packages/tracker-github/src/orchestrator-adapter.ts) `resolveRepositoryFilter`, [`adapter.ts:512`](../packages/tracker-github/src/adapter.ts) `isIssueInRepository`
- **Evidence**: One `OrchestratorService` instance = one project config = one Project V2 board. Repo scoping is done by **fetching the entire board and then filtering on the client.** `resolveRepositoryFilter` returns a filter based on `project.repository` when `tracker.settings.repository` is unset, and only the literal `"*"` disables it.
- **Impact**: Running N repos as N daemons fetches **the same entire board N times every cycle.** If consumption scales linearly with the number of repos, the cause is the deployment structure, not an insufficient limit.
- **✅ Verified (§4-1)**: The current deployment has 1 daemon and a single repo, so **this problem does not manifest.** To be revisited when scaling to multiple repos.

### 🟠 P3. Unbounded advisory-comment paging

- **Files**: [`service.ts:1394`](../packages/orchestrator/src/service.ts) `publishLinkedPullRequestActiveAdvisories`, [`adapter.ts:732`](../packages/tracker-github/src/adapter.ts) `upsertIssueComment`, [`adapter.ts:785`](../packages/tracker-github/src/adapter.ts) `findIssueCommentByMarker`
- **Evidence**: Filtered issues are iterated in a **sequential loop**, and for each issue `findIssueCommentByMarker` pages through comments 100 at a time until it finds the marker. The found comment id is not cached across cycles.
- **Impact**: An issue with 500 comments permanently consumes **5 requests every 30 seconds** just to confirm "no changes." Growth is proportional to issue count × comment count, with no upper bound.

### 🟠 P4. Actual point cost is unobservable

- **File**: [`adapter.ts:1629`](../packages/tracker-github/src/adapter.ts) `extractGitHubRateLimits`
- **Evidence**: Rate-limit information is parsed **only from response headers** (`x-ratelimit-*`). The GraphQL `rateLimit { cost remaining }` field is **requested in no query at all.**
- **Impact**: There is no runtime visibility into which query costs how much. This investigation worked around it by measuring externally with `gh api graphql`, but **regression detection in production and verification of tuning effects remain impossible.** The first edition's cost estimate being off by 22x is also due to this observability gap.
- **Note (existing defensive logic does exist)**: [`adapter.ts:1592`](../packages/tracker-github/src/adapter.ts) `guardGraphQLRateLimit` waits until reset when 100 or fewer points remain (up to 60 seconds, [`adapter.ts:14`](../packages/tracker-github/src/adapter.ts)), and [`service.ts:3589`](../packages/orchestrator/src/service.ts) `resolveAdaptivePollIntervalMs` stretches the polling interval by up to 10x when less than 50% remains. In other words, **there are mechanisms that mitigate exhaustion, but nothing that reduces the exhaustion itself.**

### 🟡 P5. Internal N+1 in `fetchIssueStatesByIds`

- **Files**: [`adapter.ts:609`](../packages/tracker-github/src/adapter.ts), [`adapter.ts:1172`](../packages/tracker-github/src/adapter.ts) `resolveIssueProjectItemForStateLookup`
- **Evidence**: For each returned node, `await resolveIssueProjectItemForStateLookup(...)` is called **sequentially**, and if the target project is not among the first 100 `projectItems` of that issue, an additional `ISSUE_PROJECT_ITEMS_PAGE_QUERY` is issued.
- **Impact**: Worst case, 100 serial round trips per batch. Per-request cost is low, but latency accumulates.

### 🟡 P6. `fetchPriorityOptionOrder` re-fetched every cycle

- **Files**: [`adapter.ts:476`](../packages/tracker-github/src/adapter.ts), [`adapter.ts:1429`](../packages/tracker-github/src/adapter.ts)
- **Evidence**: When `priorityFieldName` is configured, `PROJECT_FIELDS_QUERY` is re-issued on every `listIssues` call. Project field definitions effectively never change.
- **Impact**: A permanent +1 request/cycle. Individual cost is small (`fields(first: 100)`).

### 🟡 P7. No handling of 403/429 · `Retry-After`

- **File**: [`adapter.ts:1560`](../packages/tracker-github/src/adapter.ts)
- **Evidence**: All non-2xx responses are thrown as `GitHubTrackerHttpError`, and the cycle catch ([`service.ts:429`](../packages/orchestrator/src/service.ts)) logs and waits for the next poll. There is no retry, no exponential backoff, no `Retry-After` compliance.
- **Impact**: A secondary rate-limit 403 cannot be distinguished from an authentication failure. Dispatch suppression reacts to exactly the string `"Rate limit near exhaustion"` and nothing else ([`service.ts:3654`](../packages/orchestrator/src/service.ts)).

### 🟡 P8. Budget leak in `tool-github-graphql`

- **File**: [`packages/tool-github-graphql/src/tool.ts:25`](../packages/tool-github-graphql/src/tool.ts) `executeGitHubGraphQL`
- **Evidence**: There is **no header parsing, no rate-limit guard, and no retry at all.** It is exposed to agents as an MCP tool ([`mcp-server.ts:22`](../packages/tool-github-graphql/src/mcp-server.ts)) and via the CLI.
- **Impact**: An agent can call it an unlimited number of times per turn, and that consumption eats into the same account bucket **outside** the orchestrator's rate-limit accounting. Even if the orchestrator manages its budget precisely, the worker side can exhaust it.

### ⚪ P9. Stale state for archived board items

- **Files**: [`adapter.ts:1863`](../packages/tracker-github/src/adapter.ts) (`includeArchived: false`), `PROJECT_ITEMS_QUERY` ([`adapter.ts:1691`](../packages/tracker-github/src/adapter.ts)), [`service.ts:1911`](../packages/orchestrator/src/service.ts)
- **⚠️ First-edition correction**: The first edition stated "`PROJECT_ITEMS_QUERY` has no archive filter, making it asymmetric with the by-ids path," but **measurement shows the default value of `archivedStates` on `items()` is `NOT_ARCHIVED`.** Therefore **both paths exclude archived items** and no asymmetry exists.

  ```
  (default)                          → 61
  archivedStates:[ARCHIVED]         → 0
  archivedStates:[ARCHIVED,NOT_ARCHIVED] → 61
  ```

- **Evidence**: When an active run's board item is archived, it **disappears from both paths.** `normalizeIssueStateLookupNode` returns `null` ([`adapter.ts:992`](../packages/tracker-github/src/adapter.ts)), `currentTrackerState` becomes undefined, and the run **passes through unchanged.**
- **Impact**: `issueState` silently stays stale. **R3 does not resolve this** (correcting the first edition) — treating archiving as an explicit state transition requires `archivedStates:[ARCHIVED,NOT_ARCHIVED]` plus fetching `isArchived`.

---

## 2. Proposed Remedies

Sorted by savings-to-risk ratio. **R1 and R2 alone are likely to resolve most of the problem.**

### R0. Add `rateLimit { cost remaining }` instrumentation — **mandatory prerequisite**

- **Target**: All GraphQL queries, especially `PROJECT_ITEMS_QUERY`
- **Effort**: Very small (add the field to queries + parse the response)
- **Effect**: Zero savings. However, **it turns the effect of every subsequent change from an estimate into a measurement.** Tuning without this is all guesswork.
- **Risk**: None

### R1. Remove nested PR `labels`/`assignees` from `PROJECT_ITEMS_QUERY` — **biggest impact**

- **Target**: `labels(first:20)` / `assignees(first:20)` inside the `PullRequestMetadata` fragment at [`adapter.ts:1810`](../packages/tracker-github/src/adapter.ts)
- **Effect (measured)**: Per-request **cost 11 → 1 (11x savings)**. Even larger than the first edition's estimate (5.4x). **The best effect-per-unit-of-work of all measures** — deleting 2 fields yields 11x
- **Risk**: Low. **No orchestrator decision logic reads these two fields.** They are only passed through via [`render.ts:92`](../packages/core/src/workflow/render.ts) as worker template variables.
- **✅ Prerequisite verified (§4-2)**: **Not a single** real workflow template references `linked_pull_requests[].labels` / `.assignees`. The only references are 4 test fixtures, and even those use only `pr.number`/`pr.state` etc. **Complete removal is possible without any scale-down compromise**, and not a single rendered prompt changes.
- **⚠️ Things that must NOT be touched along with this**:
  - `blockedBy(first: 100)` — used by [`explain.ts:542`](../packages/orchestrator/src/explain.ts) `issueHasBlockingDependency` for dispatch-eligibility determination. **Besides, its measured cost contribution is 0, so there is no reason to touch it at all**
  - The `closedByPullRequestsReferences` **body itself** — [`service.ts:252`](../packages/orchestrator/src/service.ts) `resolvePullRequestBranchCheckoutTarget` throws when `headRefName` is absent. PR/issue dedup ([`service.ts:170`](../packages/orchestrator/src/service.ts)) also depends on it

### R1.5. Apply the `items(query:)` server-side filter — reduces page count

- **Target**: Add a `query` variable to `PROJECT_ITEMS_QUERY` at [`adapter.ts:1691`](../packages/tracker-github/src/adapter.ts), pass it through in `fetchProjectItemsPage` at [`adapter.ts:691`](../packages/tracker-github/src/adapter.ts)
- **Effect**: **Per-request cost does not change** (cost is computed from the requested `first:` value, not the number of returned rows — confirmed by measurement). The savings come from **fewer pages**. On the measured board, 61 items → 8 items = **3 pages → 1 page (3x)**. The higher the Done ratio, the bigger the gain, and real-world boards are usually mostly Done.
- **Relationship to R1**: Different axes, so they **multiply.** R1 reduces per-request cost (11→1); R1.5 reduces request count (3→1).
- **⚠️ Filter-expression choice — safety diverges**:

  | Approach                                    | Assessment                                                                                                  |
  | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
  | `-status:Done,<other terminal>` (negative)  | **Recommended.** New states are still included rather than dropped. Failure mode is over-fetching (safe)    |
  | `status:Ready,"In progress",...` (positive) | **Not recommended.** An option rename returns **0 items with no error** → total dispatch shutdown (see P10) |

  If a positive filter is used, **read and validate** the option names via the already-existing `PROJECT_FIELDS_QUERY` ([`adapter.ts:1825`](../packages/tracker-github/src/adapter.ts)) before assembling the expression, and **fail loud** on mismatch.

- **⚠️ Set that must never be excluded by the filter**: If the filter drops an issue belonging to an active run, the suppression branch at [`service.ts:906`](../packages/orchestrator/src/service.ts) **terminates a healthy worker with SIGTERM** (the same trap as R3). A negative filter excluding terminal states carries lower risk, but always verify that the state set of active runs passes the filter.
- **Risk**: Medium. Because filter expressions fail silently, it is recommended to add **before/after item-count comparison logging** when introducing this.
- **Related**: The premise of [`adr/2026-03-19`](./adr/2026-03-19_github-project-v2-state-filtering-cache.md) ("the API does not offer a state filter") has been invalidated, so **that ADR must be superseded.**

> **The first edition's two-phase fetch proposal (thin sweep + selective detail) has been demoted.** The server-side filter achieves the same effect with far less complexity. If the board remains large enough after filtering (thousands of items), it is worth revisiting.

### R2. Move advisory comments to REST + ETag

- **Target**: [`adapter.ts:785`](../packages/tracker-github/src/adapter.ts) `findIssueCommentByMarker`
- **Approach**: Perform the marker search only once and persist the comment id → thereafter `GET /repos/{owner}/{repo}/issues/comments/{id}` + `If-None-Match`
- **Effect**: **REST 304 responses do not consume the rate limit.** In the vast majority of cycles with no changes, the cost becomes effectively zero. In addition, REST uses a **completely separate 5,000 requests/hr bucket** from GraphQL, so the migration itself frees GraphQL budget.
- **Risk**: Low to medium. Requires designing where to persist the comment id (run snapshot or a separate state file)

### R3. Consolidate active-run state synchronization — **prerequisite refactoring required**

- **Target**: [`service.ts:1882`](../packages/orchestrator/src/service.ts) `syncActiveRunIssueStates`
- **⚠️ Naive deletion breaks things.** Adversarial validation shows that what is load-bearing about `fetchIssueStatesByIds` is not field duplication but the property that **"it is called with all active run ids, without applying the filter"**:
  - When `reconcileProject` is called with an `issueIdentifier`, `filteredIssues` is narrowed to that single issue at [`service.ts:710`](../packages/orchestrator/src/service.ts)
  - However, the suppression loop ([`service.ts:893`](../packages/orchestrator/src/service.ts)) iterates over **all** claimed runs
  - Removing the second query now → non-targeted active runs fail lookup → the branch at [`service.ts:906`](../packages/orchestrator/src/service.ts) → **SIGTERM to a healthy worker**, and the run is suppressed with `"tracker issue is no longer tracked"`
  - Issues reassigned during `--assigned-only` ([`adapter.ts:507`](../packages/tracker-github/src/adapter.ts)) and issues transferred to another repo ([`adapter.ts:512`](../packages/tracker-github/src/adapter.ts)) are terminated through the same path
- **Correct order**: ① refactor so that `filteredIssues` is not narrowed before the suppression loop → ② remove the second query
- **Effect**: Removes 1 request per cycle (plus the N+1 tail). **Measured savings are small** — R1/R1.5 already secure a 44x reduction, so from a rate-limit standpoint this is lower priority. The rationale for doing it lies in **de-duplication and P9 consistency**, not in savings.
- **Side effect (correction)**: The first edition claimed P9 (archived stale state) would be resolved along with this, but per the `archivedStates` default measurement (§1 P9), **it is not resolved.** Archive handling requires a separate measure
- **Related ADR**: [`adr/2026-03-19_github-project-v2-state-filtering-cache.md`](./adr/2026-03-19_github-project-v2-state-filtering-cache.md) — this path was deliberately introduced in #60, so any change must supersede that ADR

### R4. Consolidate daemon deployment to per-project

- **Condition**: Only if P2 is confirmed as the actual operating configuration
- **Effect**: Removes the duplication proportional to repo count outright. With 5 repos, a **5x saving**
- **Risk**: Changes to deployment/operational procedures. Code changes are minimal

### R5. Cache `fetchPriorityOptionOrder` results

- **Target**: [`adapter.ts:476`](../packages/tracker-github/src/adapter.ts)
- **Effect**: Small (removes +1 request/cycle). A process-lifetime cache is sufficient
- **Cache policy**: Reuse successful field-list lookups per API URL and project ID for the process lifetime, and compute the per-field-name option order from the cached list. Do not cache lookup failures, so the next call retries.
- **Risk**: Low. Fields created/deleted or options changed at runtime are not reflected until the daemon restarts.

### R6. Add 403/429 · `Retry-After` handling

- **Target**: [`adapter.ts:1560`](../packages/tracker-github/src/adapter.ts)
- **Effect**: **Resilience**, not savings. Distinguishes secondary rate limits from authentication failures and recovers with exponential backoff
- **Risk**: Low

### R7. Apply a rate-limit guard to `tool-github-graphql`

- **Target**: [`tool.ts:25`](../packages/tool-github-graphql/src/tool.ts)
- **Effect**: Brings agent calls into the orchestrator's budget accounting. Extract `guardGraphQLRateLimit` from `adapter.ts` into a shared utility and reuse it
- **Risk**: Low

### R8. Migrate to a GitHub App — deferred

- **Premise**: Only effective if R1–R4 have been done and are still insufficient, **and only when the repositories are spread across multiple orgs**
- **Reason**: Rate-limit buckets are separated **per installation**. If all repos live in one org, there is only one installation, so there is no bucket-multiplication effect (there is scale-up with org size)
- **No public URL needed**: The installation-token flow is entirely outbound (JWT signing → `POST /app/installations/{id}/access_tokens` → GraphQL calls). Without webhooks, no public endpoint is required
- **Migration blockers**:

  | Issue                         | Location                                                                                                                                                                               | Detail                                                                                                                                                                                          |
  | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `GET /user` 403               | [`adapter.ts:823`](../packages/tracker-github/src/adapter.ts) `fetchCurrentUserLogin`                                                                                                  | Cannot be called with an installation token. Fails immediately when `assignedOnly` is used                                                                                                      |
  | `viewer` query                | [`client.ts:848`](../packages/cli/src/github/client.ts), [`client.ts:869`](../packages/cli/src/github/client.ts)                                                                       | Bootstrap/project-discovery paths fail (the daemon loop is unaffected)                                                                                                                          |
  | User-owned projects           | —                                                                                                                                                                                      | If the Project V2 is owned by a personal account, it is **unreachable**. Requires transfer to org ownership                                                                                     |
  | Cache churn on token rotation | [`adapter.ts:1625`](../packages/tracker-github/src/adapter.ts) `fingerprintToken`, [`orchestrator-adapter.ts:254`](../packages/tracker-github/src/orchestrator-adapter.ts) `hashToken` | Cache keys are based on the **token value**. With tokens expiring hourly, every refresh invalidates the entire rate-limit cache and project-items cache. **Top-priority fix at migration time** |

- **Reusable foundation**: [`tool.ts:62`](../packages/tool-github-graphql/src/tool.ts) `resolveGitHubGraphQLToken` already implements the `{ token, expiresAt }` broker pattern (cache file 0600, 60-second reuse window). The tracker does not use it and assumes a static `token: string` ([`adapter.ts:18`](../packages/tracker-github/src/adapter.ts)), so extending to `token: string | (() => Promise<string>)` suffices

---

## 3. Options considered but not adopted

| Option                                              | Rejection rationale                                                                                                                                                                                                                                                     |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Separate PATs per repo/environment**              | No effect. The primary rate limit is per **account**, not per token. N PATs from the same account share the same 5,000pt bucket                                                                                                                                         |
| **Creating multiple machine-user accounts**         | Per-account buckets would be separate, but creating multiple accounts to evade limits risks violating GitHub ToS and incurs seat costs                                                                                                                                  |
| **Increase `pageSize` 25 → 100**                    | **Cost-neutral — confirmed by measurement** (`first:` 10/25/50/100 → cost 4/11/22/44, linear). Only improves latency, so worth considering alongside R1.5                                                                                                               |
| **Move all Project V2 reads to REST**               | **Impossible.** Project V2 has no REST API. Board items, field values, and status must stay on GraphQL                                                                                                                                                                  |
| ~~**Server-side state filtering**~~                 | **Rejection withdrawn — adopted.** The first edition rejected it for lack of API support, but measurement shows `items(query:)` is supported. **Promoted to R1.5**. [`adr/2026-03-19`](./adr/2026-03-19_github-project-v2-state-filtering-cache.md) is to be superseded |
| **Two-phase fetch (thin sweep + selective detail)** | The server-side filter achieves the equivalent effect with less complexity. Revisit if the board is still in the thousands after filtering                                                                                                                              |

---

## 4. Verification items — all resolved

**Every open item from the first edition was resolved by the 2026-07-19 investigation.** No prerequisites remain before filing issues.

| #   | Item                                                                 | Result                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Is the production deployment per-repo daemons?                       | ✅ **No.** One daemon (PID 42112, `repo start --assigned-only`, cwd `/Users/steve/Projects/ioa-tracker`, started 2026-07-17), single project · single repo. **P2 is not a current cause → demoted to 🟡** |
| 2   | Do templates reference `linked_pull_requests[].labels`/`.assignees`? | ✅ **No. R1 is safe.** Details below                                                                                                                                                                      |
| 3   | Does `items()` return archived items?                                | ✅ **Resolved.** `archivedStates` default = `NOT_ARCHIVED` confirmed by measurement. Both paths symmetric (§1 P9 correction)                                                                              |
| 4   | Has a filter argument been added to `items()`?                       | ✅ **`query: String` support confirmed.** ADR supersede required (§1 P10)                                                                                                                                 |
| 5   | Is `service.ts:734-745` dead code?                                   | ✅ **Confirmed.** Details below                                                                                                                                                                           |
| 6   | Who consumed the remaining quota?                                    | ✅ **The single running daemon.** The observed `used=3419` matches the computed value (5,280 pt/hr)                                                                                                       |
| 7   | Is the measured board representative of the production board?        | ✅ **Replaced with direct measurement of the production board.** Appendix A-1 is based on the actual polled board (90 items)                                                                              |

**#2 details — R1's risk is confirmed to be zero.**
`linked_pull_requests` passes the entire PR object ([`render.ts:111`](../packages/core/src/workflow/render.ts); `labels`/`assignees` are preserved via `TrackedPullRequestContext`'s index signature), so a template that explicitly writes `pr.labels` could access them. However, **implicit leakage is impossible** — both the Liquid and legacy paths output `[object Object]` rather than JSON-serializing objects ([`render.ts:194`](../packages/core/src/workflow/render.ts); arrays are skipped at [`render.ts:261`](../packages/core/src/workflow/render.ts)).

An exhaustive survey shows **real workflow templates use no PR variables at all.** The only references are 4 test fixtures ([`render.test.ts:99,104,212`](../packages/core/src/workflow/render.test.ts), [`service.test.ts:3851`](../packages/orchestrator/src/service.test.ts)) — all use only `pr.number`/`pr.state`/`pr.identifier`/`pr.projectState`, never `labels`/`assignees`. `ioa-tracker/WORKFLOW.md` **explicitly states at line 55 that it deliberately avoids the `pull_request_context` variable for compatibility.**

→ **Removal changes not a single rendered prompt.** No scale-down (`first: 5`) compromise is needed; complete removal is possible. If a future third-party `WORKFLOW.md` uses `{{ pr.labels }}`, `strictVariables: true` ([`render.ts:187`](../packages/core/src/workflow/render.ts)) means it will **throw rather than fail silently**, so the regression surfaces explicitly.

**#5 details — it is indeed dead code, but deletion needs a comment.**
The seeding at [`service.ts:723`](../packages/orchestrator/src/service.ts) is unconditional and loop 1 only does `.set()`, so loop 2's `!existing` branch is **unreachable.** The else branch is also value-preserving (the only difference is coercing `rateLimits` from `undefined → null`, and consumers treat the two identically, so it is harmless).

That said, it is worth noting that **loop 2's spread order is the reverse of loop 1's** (`{...synced, ...existing}` vs `{...existing, ...fresh}`). This suggests the two loops were written at different times under different assumptions, and if the line-723 seeding ever becomes conditional, loop 2 would come back to life and enforce its intended precedence. **When deleting, leave a comment recording the invariant: "unnecessary because the line-723 seeding is unconditional."** — Since the map is already seeded at line 723, the `!existing` branch at line 736 appears unreachable. The possibility that it is defensive code anticipating a future rearrangement cannot be ruled out

---

## Appendix A. Per-cycle budget overview

For I issues, A active runs, pages P = ⌈I/25⌉:

```
listIssues                    P requests × 11pt (measured)     ← P1 × P10, dominant
fetchPriorityOptionOrder      +1 request (when priorityFieldName is set)  ← P6
fetchCurrentUserLogin         +1 REST (when assignedOnly)
fetchIssueStatesByIds         ⌈A/100⌉ + up to A extra (N+1)          ← P5
advisory upsert               ⌈comments/100⌉ reads per issue + 0–1 mutation  ← P3
──────────────────────────────────────────────────────────────
Base 30-second period. Interval stretches up to 10x below 50% remaining
```

### A-1. Production board measurements (the basis for the conclusions)

**Target**: `PVT_kwDOBB0_W84BRapW` "Maintenance service project" — the board the running daemon actually polls

| Item                             | Value                                                                 |
| -------------------------------- | --------------------------------------------------------------------- |
| Total items                      | **90**                                                                |
| State distribution               | Done **83 (92%)** / Ready 4 / In progress 2 / In review 1 / Backlog 0 |
| `-status:Done`                   | **7**                                                                 |
| `pageSize` (`DEFAULT_PAGE_SIZE`) | 25 → **4 pages**                                                      |
| Polling period                   | 30,000ms (`WORKFLOW.md` `polling.interval_ms`) → **120 cycle/hr**     |
| Measured cost per request        | **11** (current) / **1** (with R1)                                    |

| Scenario                        | cost/req | Pages | pt/cycle | pt/hr     | vs. limit (5,000)      |
| ------------------------------- | -------- | ----- | -------- | --------- | ---------------------- |
| **Current**                     | 11       | 4     | **44**   | **5,280** | **106% — exceeded**    |
| R1 only (nested fields removed) | 1        | 4     | 4        | 480       | 9.6%                   |
| R1.5 only (`-status:Done`)      | 11       | 1     | 11       | 1,320     | 26%                    |
| **R1 + R1.5**                   | 1        | 1     | **1**    | **120**   | **2.4% (44x savings)** |

**Interpretation — the conclusions are completely different from the first edition:**

1. **One daemon and one repo already exceed the limit at 106%.** "Orchestrating multiple repositories" is not a precondition — it merely accelerated the symptom.
2. **P2 (daemon duplication) is not the cause in the current deployment** — there is only one daemon. The real cause is **P1 × P10**.
3. **P10's share is far larger than the first edition anticipated.** With **92% of the board Done**, 83 items that will never be picked up are fetched with the heavy query every 30 seconds.
4. **R1 alone takes 106% → 9.6%**, resolving the problem immediately. By deleting 2 fields. **Top-priority starting point.**
5. R1 + R1.5 secures 44x (2.4%) and also absorbs a future multi-repo scale-out (P2).

**Observed actual consumption**: At measurement time, `used=3419 / limit=5000 / remaining=1581` (reset 07:13Z). Excluding this investigation's own query consumption (~130pt), most of it is the running daemon's consumption, consistent with the calculation above.

**Caution**: The above accounts only for the `listIssues` path. P3 (advisory-comment paging) accumulates **separately**, proportional to issue and comment counts, with no upper bound. Because the daemon runs with `--assigned-only`, `fetchCurrentUserLogin`'s REST call also occurs every cycle (a separate REST bucket). In addition, P8 (`tool-github-graphql`) agent calls consume the same GraphQL bucket **outside** this accounting.

## Appendix B. Limit structure reference

|                                   | Limit                   | Unit         | Notes                                      |
| --------------------------------- | ----------------------- | ------------ | ------------------------------------------ |
| REST (PAT)                        | 5,000 **requests**/hr   | Account      | ETag 304 responses are not counted         |
| GraphQL (PAT)                     | 5,000 **points**/hr     | Account      | Not 1 per request — based on node count    |
| REST / GraphQL (App installation) | Scales up with org size | Installation | Check current GitHub docs for exact limits |
