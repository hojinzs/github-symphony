# C14 Graphite interaction and accessibility contracts

Status: implementation plan and review contract; prototype verification pending.
Issue: #1018, Epic #983. Baseline: operator-approved C22 / merged PR #1029.

## Ownership and delivery boundary

This is cross-layer Configuration, Integration and Observability operator design.
The [approved management design](2026-10-04-control-plane-management-agents-design.md)
and [Graphite handoff](2026-10-05-ohmysymphony-c22-design-handoff.md) remain authoritative.
The fleet management plane is an explicit repository-local extension above
Symphony. This slice introduces no new upstream divergence: configuration,
tracker adapters, per-project scheduling and execution retain their ownership.
`docs/symphony-spec.md` is unchanged. One operator on a private network manages
existing prepared projects; no UI provisioning or global scheduler is added.

Slice-owned artifacts are this contract, a dated prototype/evidence manifest
under `docs/designs/`, annotations/reactions on the existing Graphite Figma pages,
related design verification fixtures, the documentation index and a CLI patch
changeset. No runtime package or protocol is implemented here. In particular,
`packages/control-plane` remains the shipped per-project web server. New fleet
UI implementation belongs to #1019–#1022 and must preserve the approved service
and protocol boundaries rather than treating this design as a runtime API.

Use existing screen roots on pages `23:379`–`23:383`, dialog/feedback components
on `23:375`, and responsive rules on `23:372` in
[the approved file](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e).
Preserve Graphite foundations and component/widget mapping. Reactions and
annotations are substantive C14 additions; the prior C22 approval does not
approve these additions. Archived decision samples are reference only.

## Shared keyboard and feedback contract

Use native buttons, inputs and links with names derived from visible labels.
Icon controls need explicit action/context names, such as “Close Add environment”.
Disabled lifecycle actions retain an adjacent, readable reason. Status text and
icons supplement color. DOM order follows visual order; never use positive
`tabindex`. All primary actions work with keyboard alone. Visible focus uses
the approved Graphite focus role without being clipped by overflow containers.

Primary navigation uses links with current-page semantics. A within-view OS,
run or stream selector uses its actual control semantics: native select unless
rendered as tabs. Tabs have one tab stop, arrow/Home/End navigation, selected
state and labelled panels; use manual activation where loading is asynchronous.
Do not make every table row an ambiguous nested click target. Project links and
separate row actions expose environment-qualified names.

Announce progress through a polite status region only when the meaningful state
changes. Do not announce every timer tick or every log line. Submission errors
use a readable inline message, an error association and an alert announcement;
focus the first invalid field after validation. Loading leaves context visible,
prevents duplicate submission and explains what is pending. A toast never serves
as the sole error record. Reduced motion avoids unnecessary transitions.

## Dialog contracts

| Dialog                               | Initial focus                                  | Tab order / validation                                                                                          | Close and return                                                                                                     |
| ------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Add environment, before create       | Environment name                               | Name → create → close; blank name produces associated error, focus stays on name                                | Escape/close before issuance returns to opener; no record is implied                                                 |
| Issued enrollment / waiting          | Noninteractive heading with programmatic focus | OS selector → setup copy → token copy while valid → available recovery action → close; trap forward/reverse Tab | Escape/close ends the issuance display, not the saved environment; restore opener or list heading if opener vanished |
| Reopened pending / expired           | Heading describing saved environment           | Regenerate token → help → close; old token absent from visual and accessibility trees                           | Saved ID survives; regeneration explicitly fences previous unused token                                              |
| Enrolled awaiting signal             | Heading                                        | Resume setup/help → close; no enrollment token controls                                                         | Preserve enrolled ID; reopening uses saved identity, not another token                                               |
| Stop project                         | Cancel                                         | Cancel → Stop project → close; identity and observed active-run count are readable                              | Cancel, Escape and close submit nothing; return to Stop opener                                                       |
| Unknown closure, reason              | Reason field                                   | Reason → continue → cancel; trim whitespace and reject blank reason                                             | Escape/cancel submits nothing; reason remains only within this open dialog flow                                      |
| Unknown closure, second confirmation | Cancel                                         | Read identity, reason and consequence → cancel → acknowledge unresolved closure                                 | Back returns to reason entry; final submit once, then return to command context                                      |
| Revoke access                        | Cancel                                         | Warning that local execution continues → cancel → revoke                                                        | Escape/close cancels; successful revoke preserves historical identity                                                |

All dialogs use labelled modal semantics, background inertness, a focus trap,
a reachable close button and focus return. Backdrop click cancels destructive
confirmations; enrollment backdrop close follows the same persistence rule as
Escape. At 390px, dialog content scrolls within the viewport, with the heading
and action region reachable by keyboard; no hidden action or body scroll trap.
Do not silently dismiss a submitted confirmation while the result is pending:
if closing the progress presentation is allowed, retain the command in history.

## Enrollment and clipboard contract — #1019

Creating an environment persists its ID and exposes a synthetic ten-minute,
one-use token only for that issuance session. Copy setup command and Copy token
are separate controls. Commands contain no token argument: use the approved
hidden prompt or token-stdin contract. Design fixtures contain synthetic values
only, never secrets. Copy success says which item was copied; failure says
“Could not copy” and offers accessible manual selection in the current issuance
session. Failure does not announce success, dismiss the dialog or extend expiry.

Closing discards the displayed token. Reopen shows the saved environment and
regeneration action without fetching or recovering the old token. Expiry disables
copying the token and exposes regeneration; no deadline reset on reopen.
Regeneration preserves environment ID and invalidates the previous unused token.
An enrolled identity instead offers setup resume with saved identity.

Render server-derived transitions automatically: pending → enrolled/awaiting
first signal → online. Enrollment exchange alone is not online. An authenticated
current-session heartbeat or inventory signal establishes online, even with zero
projects. The successful empty view explains local folder registration, never UI
project creation. Revoked/offline/error states preserve identity and explain
remediation. Token/TLS/service errors are distinguishable; do not expose raw
credentials in error messages or announcement text.

## Fleet and lifecycle contract — #1020 / #1021

Rows, project detail and commands use environment-qualified identity. Inventory
is observation, not authority to execute. Stale/offline rows retain historical
state and timestamps but do not contribute to fresh running totals; mutation
controls explain their disabled state. Invalid workflow can block Start while
verified Stop remains possible. Unmanaged and revoked states state that management
ends while local orchestrators continue. Incompatible versions explain why the
action is unavailable; do not promise adapter migration.

Start submits one intent and renders accepted/progress separately from verified
running process state. Stop confirmation names environment/project, target and
observed active work; Cancel performs no submission. Stop uses graceful shutdown,
never force-kill. Acceptance or signal delivery is not successful completion.
Verified Stop requires exit/lock evidence from its implementation owner. A
superseded target cannot be described as successfully stopped replacement work.

Unknown outcome retains the original command and evidence. No Retry or replacement
command is offered. Recovery can reconcile a durable result; insufficient evidence
leads to explicit unresolved closure. Closure requires a nonblank reason and a
second confirmation explaining that it releases the command slot without proving
the original outcome. Retain the unknown outcome, reason and audit history after
closure. UI does not claim lock release or process termination from acknowledgement.

## Runs and logs contract — #1022

Run and stream selection remain visible through loading, empty, missing and
expired-read states. Distinguish empty content from unavailable content. Follow
is bounded and pausable; user scrolling away pauses follow rather than forcing
scroll position. Resume follow is an explicit named action. Disconnect retains
content with historical timestamps and paused-follow explanation. Reconnect must
not imply freshness until a current observation/read is available.

Rotation/cursor mismatch displays a reset explanation and explicit Reset cursor
control. Reset changes the read cursor, not command/run identity; never silently
concatenate incompatible streams. New run/stream selection clears the old cursor
and contextual status. Render logs as safe text; no HTML or terminal escape
execution. Errors expose remediation without filesystem secrets. Live-region
announcements describe stream state transitions, not unbounded log payloads.

## Responsive verification cases

| Width | Required interaction check                                                                                                                      |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1440  | Fleet scan, contextual actions, dialog trap/return and log selectors remain distinct; no overlap or clipped focus                               |
| 1024  | Tablet columns retain identity and action labels; navigation and dialogs remain reachable without horizontal page scroll                        |
| 390   | Stacked state/identity, wrapping errors and scrollable modal; all controls reachable; log content may scroll horizontally inside its own region |

Use at least 24×24 CSS-pixel targets or the WCAG spacing exception; prefer 44×44
for primary mobile and modal actions. Measure actual interactive bounds, not the
text glyph box. Verify visible focus, 200% zoom/reflow, contrast, accessible names
and long content in the consuming UI. Figma geometry is design evidence only.

## Operator walkthrough test cases and evidence routing

Each case needs its own artifact/result entry. “Planned” is not “passed”. Record
prototype-link inspection, rendered/model review, human review, browser/assistive
technology execution and real OS evidence separately. A synthetic transition
never establishes backend enforcement. C22 approval is inherited only for its
unchanged visual foundations; C14 human review is pending.

| Case | Normal / invalid / recovery procedure                                                                                               | Design contract                           | Later executable boundary                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------- |
| W01  | Enroll then register two prepared folders; inspect distinct aggregate rows; duplicate local IDs across hosts stay separate          | U01–U03, local registration guidance      | CP-01/02/21; #1019/#1020 inventory and registration owners            |
| W02  | Start stopped project, inspect acceptance then verified running; repeat submission while pending                                    | U04 command/progress; no duplicate intent | CP-03/04/13; #1020/#1021 lock/arbitration                             |
| W03  | Open Stop with active work, cancel once, reopen and confirm; signal delivery remains pending                                        | U05 Cancel versus Stop, focus return      | CP-08; #1021 verified target/exit/locks                               |
| W04  | Disconnect running host; retain history, exclude from fresh totals, explain disabled mutation                                       | U01/U04 offline/stale                     | CP-05/06/10/17; #1020 session/freshness                               |
| W05  | Lose claimed result; inspect unknown, reject blank reason, second-confirm closure and retain audit                                  | U06 unknown/recovery                      | CP-07/09/18/19; #1021 durable recovery/ownership fencing              |
| W06  | Select run/stream, pause/resume follow, rotate/reset cursor, disconnect/reconnect; distinguish missing and expired reads from empty | U07 logs                                  | CP-12; #1022 bounded safe reads                                       |
| W07  | Remove local registration or revoke access; historical identity remains and local execution is explained                            | U03/U04 revoked/unmanaged                 | CP-11/14; #1019/#1020 management authority                            |
| W08  | Keyboard every primary action, reverse Tab in dialogs, Escape/return, non-color status and names/announcements                      | Shared contracts, U01–U08                 | Browser and assistive-technology verification by #1019–#1022          |
| W09  | Create/copy success and failure/close/reopen without old token; expire/regenerate/enroll/wait/current signal with zero projects     | U02/U08 enrollment                        | CP-20/21; #1019 token/session transitions                             |
| W10  | Inspect saved-identity setup retry, lock conflict, Linux linger and macOS logout guidance                                           | U02 setup/resume                          | CP-22/23; actual Linux/macOS service stop/restart/uninstall isolation |

CP-15 (credential exclusion) and CP-16 (same-origin/CSRF/audit) are backend-only
security verification. The UI must not expose secrets or offer unsupported auth
flows, but this slice cannot claim those checks passed. CP-17 adapter overlap,
CP-18 replay claim time and CP-19 stale ownership likewise require backend evidence
beyond their visible contract. All CP-01–CP-23 are accounted for above without
turning presentation evidence into protocol or OS acceptance.

## Planned concrete verification and handoff

1. Inspect approved page roots and interactive descendants; retain their IDs.
2. Wire normal, invalid and recovery flows using existing state compositions;
   attach accessibility implementation notes where Figma cannot execute semantics.
3. Read back reaction source/destination IDs and interactive target geometry;
   render changed frames at 1440/1024/390 and record findings/repairs.
4. Exercise typed synthetic state/event fixtures against design contracts where
   runtime dependencies are absent; label them as fixtures, not implemented APIs.
5. Publish dated walkthrough/evidence matrix with actual outcomes and limitations.
   Run required repository checks and mutation-check any added automated tests.
6. Hand off additions for operator review with downstream browser/runtime/OS gates
   explicitly pending. No native OS result or human approval is inferred.
