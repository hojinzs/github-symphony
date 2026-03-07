## 1. Workflow Contract And GitHub Access

- [x] 1.1 Extend workspace workflow artifact generation and parsing to include approval-lifecycle state mappings for planning, human review, implementation, awaiting merge, and completion.
- [x] 1.2 Expand GitHub App permissions and runtime credential brokering to support repository write operations and pull request creation with short-lived workspace-scoped credentials.
- [x] 1.3 Add runtime-side git authentication support so agent runs can push branches without persisting long-lived tokens in the checkout or workflow files.

## 2. Phase-Aware Worker Execution

- [x] 2.1 Implement phase-aware tracker handling so the worker distinguishes planning-active, implementation-active, and non-actionable handoff states.
- [x] 2.2 Add planning-phase execution that posts a structured issue comment and transitions the project item into the human-review state.
- [x] 2.3 Add implementation-phase execution that resumes after approval, creates or updates a linked pull request, posts a completion comment, and transitions the project item into the awaiting-merge state.
- [x] 2.4 Add idempotency and re-entry handling so repeated planning or implementation runs do not create duplicate comments, branches, or pull requests.

## 3. Merge Completion And Safeguards

- [x] 3.1 Configure and validate the merge-driven completion path so linked pull request merges close the tracked issue and move the project item to the completed state.
- [x] 3.2 Add worker safeguards so issues in human-review or awaiting-merge states are never treated as actionable and active runs stop or decline work when an issue leaves an active state.
- [x] 3.3 Update setup and operational documentation with required GitHub repository and project settings for approval-gated execution.

## 4. Verification

- [x] 4.1 Add unit coverage for workflow parsing, tracker phase selection, and renewable git credential handling.
- [x] 4.2 Add integration tests for planning handoff, approval-triggered implementation, PR reporting, and merge-driven completion.
- [x] 4.3 Add an end-to-end platform test that covers the full lifecycle from issue creation through plan comment, human approval, PR creation, merge, and final completion.
