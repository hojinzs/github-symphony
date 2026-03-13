import { describe, expect, it } from "vitest";
import {
  generateReferenceWorkflow,
  type ReferenceWorkflowInput,
} from "./generate-reference-workflow.js";

const defaultInput: ReferenceWorkflowInput = {
  runtime: "codex",
  statusColumns: [
    { name: "Todo", role: "active" },
    { name: "In Progress", role: "active" },
    { name: "In Review", role: "wait" },
    { name: "Done", role: "terminal" },
  ],
  projectId: "PVT_abc123",
};

describe("generateReferenceWorkflow", () => {
  it("codex runtime produces codex.command containing codex", () => {
    const output = generateReferenceWorkflow({
      ...defaultInput,
      runtime: "codex",
    });
    expect(output).toContain("command: codex app-server");
  });

  it("claude-code runtime produces codex.command containing claude-code", () => {
    const output = generateReferenceWorkflow({
      ...defaultInput,
      runtime: "claude-code",
    });
    expect(output).toContain("command: claude-code");
  });

  it("custom runtime string is used as codex.command verbatim", () => {
    const output = generateReferenceWorkflow({
      ...defaultInput,
      runtime: "node worker.js",
    });
    expect(output).toContain("command: node worker.js");
  });

  it("contains all required section headers", () => {
    const output = generateReferenceWorkflow(defaultInput);

    expect(output).toContain("# Reference WORKFLOW.md — gh-symphony");
    expect(output).toContain("# ═══ FRONT MATTER 필드 참조 ═══");
    expect(output).toContain("# ═══ PROMPT BODY 참조 ═══");
    expect(output).toContain("## Status Map");
    expect(output).toContain("## Default Posture");
    expect(output).toContain("## Related Skills");
    expect(output).toContain("## Step 0: Determine current state and route");
    expect(output).toContain("## Step 1: Start/continue execution");
    expect(output).toContain("## Step 2: Execution phase");
    expect(output).toContain("## Step 3: Human Review and merge handling");
    expect(output).toContain("## Step 4: Rework handling");
    expect(output).toContain("## PR Feedback Sweep Protocol");
    expect(output).toContain("## Completion Bar");
    expect(output).toContain("## Guardrails");
    expect(output).toContain("## Workpad Template");
  });

  it("Status Map contains all column names from input", () => {
    const output = generateReferenceWorkflow(defaultInput);

    expect(output).toContain("Todo");
    expect(output).toContain("In Progress");
    expect(output).toContain("In Review");
    expect(output).toContain("Done");
  });

  it("Status Map contains role action descriptions", () => {
    const output = generateReferenceWorkflow(defaultInput);

    expect(output).toContain(
      "에이전트가 즉시 작업 시작. 워크패드 생성 후 구현 진행."
    );
    expect(output).toContain("PR 생성 완료. 사람 리뷰 대기 중. 에이전트 대기.");
    expect(output).toContain("완료 상태. 에이전트 종료.");
  });

  it("contains all 13 Default Posture items", () => {
    const output = generateReferenceWorkflow(defaultInput);

    expect(output).toContain("1. 이것은 무인 오케스트레이션 세션입니다.");
    expect(output).toContain("2. 진짜 블로커");
    expect(output).toContain(
      "3. 최종 메시지에는 완료된 작업과 블로커만 보고하세요."
    );
    expect(output).toContain(
      "4. 이슈 본문을 계획이나 진행 추적 목적으로 수정하지 마세요."
    );
    expect(output).toContain(
      "5. terminal 상태인 이슈에 대해서는 아무것도 하지 말고 종료하세요."
    );
    expect(output).toContain("6. 범위 밖 개선사항을 발견하면");
    expect(output).toContain("7. 모든 커밋은 논리적 단위로 분리하고");
    expect(output).toContain("8. 테스트가 깨지는 중간 커밋을 하지 마세요.");
    expect(output).toContain(
      "9. PR 생성 전 모든 기존 테스트가 통과하는지 확인하세요."
    );
    expect(output).toContain("10. 워크패드를 이슈 코멘트로 생성하여");
    expect(output).toContain(
      "11. gh-project 스킬을 사용하여 이슈 상태를 관리하세요."
    );
    expect(output).toContain("12. 블로커 발견 시 이슈에 코멘트로 기록하고");
    expect(output).toContain(
      "13. 작업 완료 후 PR이 머지되면 이슈를 Done 상태로 전이하세요."
    );
  });

  it("does NOT contain double-brace template patterns", () => {
    const output = generateReferenceWorkflow(defaultInput);
    expect(output).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it("includes projectId in front matter", () => {
    const output = generateReferenceWorkflow(defaultInput);
    expect(output).toContain("project_id: PVT_abc123");
  });

  it("does not include allowed_repositories in front matter", () => {
    const output = generateReferenceWorkflow(defaultInput);
    expect(output).not.toContain("allowed_repositories:");
  });

  it("includes active states in tracker section", () => {
    const output = generateReferenceWorkflow(defaultInput);
    expect(output).toContain("active_states:");
    expect(output).toContain("    - Todo");
    expect(output).toContain("    - In Progress");
  });

  it("includes terminal states in tracker section", () => {
    const output = generateReferenceWorkflow(defaultInput);
    expect(output).toContain("terminal_states:");
    expect(output).toContain("    - Done");
  });

  it("includes blocker_check_states set to first active column", () => {
    const output = generateReferenceWorkflow(defaultInput);
    expect(output).toContain("blocker_check_states:");
    expect(output).toContain("    - Todo");
  });

  it("includes optional blocked_by_field when provided", () => {
    const output = generateReferenceWorkflow({
      ...defaultInput,
      blockedByFieldName: "Blocked By",
    });
    expect(output).toContain('blocked_by_field: "Blocked By"');
  });

  it("shows commented blocked_by_field when not provided", () => {
    const output = generateReferenceWorkflow(defaultInput);
    expect(output).toContain('# blocked_by_field: "Blocked By"');
  });

  it("handles null role columns in Status Map", () => {
    const output = generateReferenceWorkflow({
      ...defaultInput,
      statusColumns: [
        { name: "Backlog", role: null },
        ...defaultInput.statusColumns,
      ],
    });
    expect(output).toContain("Backlog");
    expect(output).toContain(
      "역할 미정. WORKFLOW.md에서 명시적으로 설정 필요."
    );
  });

  it("includes standard runtime fields", () => {
    const output = generateReferenceWorkflow(defaultInput);
    expect(output).toContain("max_turns: 20");
    expect(output).toContain("read_timeout_ms: 5000");
    expect(output).toContain("turn_timeout_ms: 3600000");
    expect(output).toContain("interval_ms: 30000");
    expect(output).toContain("retry_base_delay_ms: 1000");
    expect(output).toContain("max_retry_backoff_ms: 30000");
  });

  it("includes hooks section with after_create", () => {
    const output = generateReferenceWorkflow(defaultInput);
    expect(output).toContain("after_create: hooks/after_create.sh");
    expect(output).toContain("before_run: null");
    expect(output).toContain("after_run: null");
    expect(output).toContain("before_remove: null");
    expect(output).toContain("timeout_ms: 60000");
  });
});
