export type ReferenceWorkflowInput = {
  runtime: "codex" | "claude-code" | string;
  statusColumns: Array<{
    name: string;
    role: "active" | "wait" | "terminal" | null;
  }>;
  repositories: Array<{ owner: string; name: string }>;
  projectId: string;
  blockedByFieldName?: string;
};

export function generateReferenceWorkflow(
  input: ReferenceWorkflowInput
): string {
  const lines: string[] = [];

  lines.push("# Reference WORKFLOW.md — gh-symphony");
  lines.push("# 이 파일은 WORKFLOW.md 작성 시 참고용 참조 템플릿입니다.");
  lines.push(
    "# /gh-symphony 스킬을 통해 AI 에이전트가 이 파일을 참고하여 WORKFLOW.md를 설계합니다."
  );
  lines.push("# 직접 수정하지 마세요.");
  lines.push("");
  lines.push("---");
  lines.push("");

  lines.push("# ═══ FRONT MATTER 필드 참조 ═══");
  lines.push(
    "# 아래는 gh-symphony 파서가 지원하는 모든 front matter 필드입니다."
  );
  lines.push("");

  lines.push(`github_project_id: ${input.projectId}`);
  lines.push("");

  if (input.repositories.length > 0) {
    lines.push("allowed_repositories:");
    for (const repo of input.repositories) {
      lines.push(`  - ${repo.owner}/${repo.name}`);
    }
  } else {
    lines.push("allowed_repositories:");
    lines.push("  - {owner}/{name}");
  }
  lines.push("");

  const activeColumns = input.statusColumns.filter((c) => c.role === "active");
  const waitColumns = input.statusColumns.filter((c) => c.role === "wait");
  const terminalColumns = input.statusColumns.filter(
    (c) => c.role === "terminal"
  );
  const firstActive = activeColumns[0];

  lines.push("lifecycle:");
  lines.push("  state_field: Status");

  if (activeColumns.length > 0) {
    lines.push("  active_states:");
    for (const col of activeColumns) {
      lines.push(`    - ${col.name}`);
    }
  } else {
    lines.push("  active_states: [{active column names}]");
  }

  if (terminalColumns.length > 0) {
    lines.push("  terminal_states:");
    for (const col of terminalColumns) {
      lines.push(`    - ${col.name}`);
    }
  } else {
    lines.push("  terminal_states: [{terminal column names}]");
  }

  if (firstActive) {
    lines.push("  blocker_check_states:");
    lines.push(`    - ${firstActive.name}`);
  } else {
    lines.push("  blocker_check_states: [{first active state}]");
  }

  if (input.blockedByFieldName) {
    lines.push(`  blocked_by_field: "${input.blockedByFieldName}"`);
  } else {
    lines.push('  # blocked_by_field: "Blocked By"  # 텍스트 필드명 (선택)');
  }
  lines.push("");

  const agentCommand = resolveAgentCommand(input.runtime);
  lines.push("runtime:");
  lines.push(`  agent_command: ${agentCommand}`);
  lines.push("  max_turns: 20");
  lines.push("  read_timeout_ms: 5000");
  lines.push("  turn_timeout_ms: 3600000");
  lines.push("");

  const hookComment = resolveHookComment(input.runtime);
  lines.push("hooks:");
  lines.push(`  after_create: hooks/after_create.sh  # ${hookComment}`);
  lines.push("  before_run: null");
  lines.push("  after_run: null");
  lines.push("  before_remove: null");
  lines.push("");

  lines.push("scheduler:");
  lines.push("  poll_interval_ms: 30000");
  lines.push("");

  lines.push("retry:");
  lines.push("  base_delay_ms: 1000");
  lines.push("  max_delay_ms: 30000");
  lines.push("");

  lines.push("---");
  lines.push("");

  lines.push("# ═══ PROMPT BODY 참조 ═══");
  lines.push(
    "# 아래는 Elixir Symphony를 GitHub Project 버전으로 번역한 참조입니다."
  );
  lines.push("");

  lines.push("## Status Map");
  lines.push("");
  lines.push("| 상태 | 역할 | 에이전트 행동 |");
  lines.push("| ---- | ---- | ------------- |");

  for (const col of input.statusColumns) {
    const roleLabel = col.role ?? "미정";
    const action = resolveRoleAction(col.role);
    lines.push(`| ${col.name} | ${roleLabel} | ${action} |`);
  }

  if (waitColumns.length > 0) {
    lines.push("");
    lines.push("**Wait 상태 (PR 리뷰 대기):**");
    for (const col of waitColumns) {
      lines.push(
        `- **${col.name}**: PR 생성 완료. 사람 리뷰 대기 중. 에이전트 대기.`
      );
    }
  }

  lines.push("");

  lines.push("## Default Posture");
  lines.push("");
  lines.push(
    "1. 이것은 무인 오케스트레이션 세션입니다. 사람에게 후속 작업을 요청하지 마세요."
  );
  lines.push("2. 진짜 블로커(필수 권한/시크릿 누락)일 때만 조기 중단하세요.");
  lines.push(
    '3. 최종 메시지에는 완료된 작업과 블로커만 보고하세요. "다음 단계"를 포함하지 마세요.'
  );
  lines.push("4. 이슈 본문을 계획이나 진행 추적 목적으로 수정하지 마세요.");
  lines.push(
    "5. terminal 상태인 이슈에 대해서는 아무것도 하지 말고 종료하세요."
  );
  lines.push(
    "6. 범위 밖 개선사항을 발견하면 현재 범위를 확장하지 말고 별도 이슈를 생성하세요."
  );
  lines.push(
    "7. 모든 커밋은 논리적 단위로 분리하고 conventional commit 형식을 따르세요."
  );
  lines.push("8. 테스트가 깨지는 중간 커밋을 하지 마세요.");
  lines.push("9. PR 생성 전 모든 기존 테스트가 통과하는지 확인하세요.");
  lines.push("10. 워크패드를 이슈 코멘트로 생성하여 진행 상황을 추적하세요.");
  lines.push("11. gh-project 스킬을 사용하여 이슈 상태를 관리하세요.");
  lines.push(
    "12. 블로커 발견 시 이슈에 코멘트로 기록하고 상태를 적절히 전이하세요."
  );
  lines.push("13. 작업 완료 후 PR이 머지되면 이슈를 Done 상태로 전이하세요.");
  lines.push("");

  lines.push("## Related Skills");
  lines.push("");
  lines.push(
    "- **gh-project**: GitHub Project v2 이슈 상태 관리 및 필드 업데이트"
  );
  lines.push("- **commit**: 논리적 단위 커밋 생성 (conventional commit 형식)");
  lines.push("- **push**: 브랜치 푸시 및 원격 저장소 동기화");
  lines.push("- **pull**: 최신 변경사항 가져오기 및 충돌 해결");
  lines.push("- **land**: PR 생성, 리뷰 요청, 머지 처리");
  lines.push("");

  lines.push("## Step 0: Determine current state and route");
  lines.push("");
  lines.push("현재 이슈 상태를 확인하고 적절한 단계로 라우팅합니다:");
  lines.push("");

  if (terminalColumns.length > 0) {
    const terminalNames = terminalColumns.map((c) => c.name).join(", ");
    lines.push(`- **${terminalNames}** → 즉시 종료. 아무것도 하지 마세요.`);
  }

  if (waitColumns.length > 0) {
    const waitNames = waitColumns.map((c) => c.name).join(", ");
    lines.push(`- **${waitNames}** → Step 3으로 이동 (리뷰 대기 처리).`);
  }

  if (activeColumns.length > 0) {
    const activeNames = activeColumns.map((c) => c.name).join(", ");
    lines.push(`- **${activeNames}** → Step 1으로 이동 (실행 시작/계속).`);
  }

  lines.push("- **기타 상태** → 이슈 코멘트로 상태 불명확 기록 후 종료.");
  lines.push("");

  lines.push("## Step 1: Start/continue execution");
  lines.push("");
  lines.push("1. 이슈 본문과 코멘트를 읽어 현재 진행 상황을 파악합니다.");
  lines.push(
    "2. 기존 워크패드 코멘트가 있으면 계속 진행, 없으면 새 워크패드를 생성합니다."
  );
  lines.push("3. 워크패드 형식은 아래 'Workpad Template'을 참조하세요.");
  lines.push(
    "4. 브랜치가 없으면 `{issue.repository}` 기반으로 feature 브랜치를 생성합니다."
  );
  lines.push("5. Step 2로 이동합니다.");
  lines.push("");

  lines.push("## Step 2: Execution phase");
  lines.push("");
  lines.push("1. 이슈 설명에 따라 구현을 진행합니다.");
  lines.push(
    "2. 변경사항을 논리적 단위로 커밋합니다 (conventional commit 형식)."
  );
  lines.push("3. 기존 테스트가 모두 통과하는지 확인합니다.");
  lines.push("4. 새 기능에 대한 테스트를 작성합니다.");
  lines.push("5. Completion Bar 체크리스트를 모두 충족하면 PR을 생성합니다.");
  lines.push("6. PR 생성 후 이슈 상태를 Human Review 상태로 전이합니다.");
  lines.push("7. Step 3으로 이동합니다.");
  lines.push("");

  lines.push("## Step 3: Human Review and merge handling");
  lines.push("");
  lines.push("1. PR이 이미 존재하는 경우 리뷰 코멘트를 확인합니다.");
  lines.push("2. 리뷰 코멘트가 없으면 대기 상태를 유지합니다.");
  lines.push("3. PR이 머지되면 이슈를 terminal 상태로 전이합니다.");
  lines.push("4. 리뷰 요청 변경사항이 있으면 Step 4로 이동합니다.");
  lines.push("");

  lines.push("## Step 4: Rework handling");
  lines.push("");
  lines.push("1. PR 리뷰 코멘트를 모두 읽고 요청된 변경사항을 파악합니다.");
  lines.push("2. PR Feedback Sweep Protocol을 따라 변경사항을 처리합니다.");
  lines.push("3. 변경사항 구현 후 커밋하고 PR을 업데이트합니다.");
  lines.push("4. 이슈 상태를 다시 Human Review 상태로 전이합니다.");
  lines.push("5. Step 3으로 돌아갑니다.");
  lines.push("");

  lines.push("## PR Feedback Sweep Protocol");
  lines.push("");
  lines.push("PR 리뷰 피드백 처리 순서:");
  lines.push("");
  lines.push("1. **모든 코멘트 수집**: 미해결 리뷰 코멘트를 모두 나열합니다.");
  lines.push(
    "2. **우선순위 분류**: blocking 코멘트 → non-blocking 코멘트 순으로 처리합니다."
  );
  lines.push(
    "3. **변경사항 구현**: 각 코멘트에 대응하는 코드 변경을 수행합니다."
  );
  lines.push("4. **코멘트 응답**: 각 리뷰 코멘트에 처리 내용을 답변합니다.");
  lines.push(
    "5. **커밋**: 변경사항을 `fix: address PR review feedback` 형식으로 커밋합니다."
  );
  lines.push("6. **재검토 요청**: 리뷰어에게 재검토를 요청합니다.");
  lines.push("");

  lines.push("## Completion Bar");
  lines.push("");
  lines.push("PR 생성 전 아래 체크리스트를 모두 충족해야 합니다:");
  lines.push("");
  lines.push("- [ ] 이슈 설명의 모든 요구사항이 구현되었습니다.");
  lines.push("- [ ] 모든 기존 테스트가 통과합니다.");
  lines.push("- [ ] 새 기능에 대한 테스트가 작성되었습니다.");
  lines.push("- [ ] 코드 스타일이 프로젝트 컨벤션을 따릅니다.");
  lines.push("- [ ] PR 설명이 변경사항을 명확히 설명합니다.");
  lines.push("- [ ] 관련 문서가 업데이트되었습니다 (필요한 경우).");
  lines.push("");

  lines.push("## Guardrails");
  lines.push("");
  lines.push("- **범위 제한**: 이슈 범위 밖의 변경은 절대 하지 마세요.");
  lines.push(
    "- **비밀 정보**: 토큰, 비밀번호, API 키를 코드에 하드코딩하지 마세요."
  );
  lines.push(
    "- **파괴적 변경**: 기존 API나 인터페이스를 무단으로 변경하지 마세요."
  );
  lines.push("- **강제 푸시**: main/master 브랜치에 force push하지 마세요.");
  lines.push(
    "- **이슈 수정**: 이슈 본문을 진행 추적 목적으로 수정하지 마세요."
  );
  lines.push(
    "- **무한 루프**: 같은 작업을 3회 이상 반복 실패하면 블로커로 기록하고 종료하세요."
  );
  lines.push("");

  lines.push("## Workpad Template");
  lines.push("");
  lines.push("이슈 코멘트로 생성할 워크패드 형식:");
  lines.push("");
  lines.push("```markdown");
  lines.push("## Workpad — {issue.identifier}");
  lines.push("");
  lines.push("**상태**: {current phase}");
  lines.push("**브랜치**: {branch name}");
  lines.push("**PR**: {PR URL or 미생성}");
  lines.push("");
  lines.push("### 계획");
  lines.push("");
  lines.push("- [ ] {task 1}");
  lines.push("- [ ] {task 2}");
  lines.push("");
  lines.push("### 진행 로그");
  lines.push("");
  lines.push("- {timestamp}: {action taken}");
  lines.push("");
  lines.push("### 블로커");
  lines.push("");
  lines.push("없음");
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}

function resolveAgentCommand(runtime: string): string {
  switch (runtime) {
    case "codex":
      return "bash -lc codex app-server";
    case "claude-code":
      return "bash -lc claude-code";
    default:
      return runtime;
  }
}

function resolveHookComment(runtime: string): string {
  switch (runtime) {
    case "codex":
      return "npm/yarn/pnpm install script";
    case "claude-code":
      return "npm/yarn/pnpm install script";
    default:
      return "package-manager-specific script";
  }
}

function resolveRoleAction(
  role: "active" | "wait" | "terminal" | null
): string {
  switch (role) {
    case "active":
      return "에이전트가 즉시 작업 시작. 워크패드 생성 후 구현 진행.";
    case "wait":
      return "PR 생성 완료. 사람 리뷰 대기 중. 에이전트 대기.";
    case "terminal":
      return "완료 상태. 에이전트 종료.";
    case null:
      return "역할 미정. WORKFLOW.md에서 명시적으로 설정 필요.";
  }
}
