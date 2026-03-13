import type { WorkflowLifecycleConfig } from "@gh-symphony/core";
import { generateStatusMap } from "../mapping/smart-defaults.js";
import type { StateMapping } from "../config.js";

export type GenerateWorkflowInput = {
  projectId: string;
  stateFieldName: string;
  mappings: Record<string, StateMapping>;
  lifecycle: WorkflowLifecycleConfig;
  repositories: Array<{ owner: string; name: string }>;
  runtime: string;
  pollIntervalMs?: number;
  concurrency?: number;
  blockedByFieldName?: string;
};

export function generateWorkflowMarkdown(input: GenerateWorkflowInput): string {
  const frontMatter = buildFrontMatter(input);
  const promptBody = buildPromptBody(input.mappings);
  return `---\n${frontMatter}---\n${promptBody}\n`;
}

function buildFrontMatter(input: GenerateWorkflowInput): string {
  const lines: string[] = [];

  lines.push(`github_project_id: ${input.projectId}`);

  if (input.repositories.length > 0) {
    lines.push("allowed_repositories:");
    for (const repo of input.repositories) {
      lines.push(`  - ${repo.owner}/${repo.name}`);
    }
  }

  lines.push("lifecycle:");
  lines.push(`  state_field: ${input.stateFieldName}`);

  if (input.lifecycle.activeStates.length > 0) {
    lines.push("  active_states:");
    for (const state of input.lifecycle.activeStates) {
      lines.push(`    - ${state}`);
    }
  }

  if (input.lifecycle.terminalStates.length > 0) {
    lines.push("  terminal_states:");
    for (const state of input.lifecycle.terminalStates) {
      lines.push(`    - ${state}`);
    }
  }

  if (input.lifecycle.blockerCheckStates.length > 0) {
    lines.push("  blocker_check_states:");
    for (const state of input.lifecycle.blockerCheckStates) {
      lines.push(`    - ${state}`);
    }
  }

  if (input.blockedByFieldName) {
    lines.push(`  blocked_by_field: "${input.blockedByFieldName}"`);
  }

  const agentCommand = resolveAgentCommand(input.runtime);
  lines.push("runtime:");
  lines.push(`  agent_command: ${agentCommand}`);

  lines.push("hooks:");
  lines.push("  after_create: hooks/after_create.sh");

  lines.push("scheduler:");
  lines.push(`  poll_interval_ms: ${input.pollIntervalMs ?? 30000}`);

  lines.push("retry:");
  lines.push("  base_delay_ms: 1000");
  lines.push("  max_delay_ms: 30000");

  return lines.join("\n") + "\n";
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

function buildPromptBody(mappings: Record<string, StateMapping>): string {
  const statusMap = generateStatusMapWithDescriptions(mappings);
  const template = `${statusMap}

## Agent Instructions

You are an AI coding agent working on issue {{issue.identifier}}: "{{issue.title}}".

**Repository:** {{issue.repository}}
**Current state:** {{issue.state}}

### Task

{{issue.description}}

### Default Posture

1. 이것은 무인 오케스트레이션 세션입니다. 사람에게 후속 작업을 요청하지 마세요.
2. 진짜 블로커(필수 권한/시크릿 누락)일 때만 조기 중단하세요.
3. 최종 메시지에는 완료된 작업과 블로커만 보고하세요. "다음 단계"를 포함하지 마세요.

### Workflow

1. 이슈 설명을 읽고 요구사항을 이해하세요.
2. 코드베이스를 탐색하여 관련 코드 구조를 파악하세요.
3. 프로젝트의 코딩 컨벤션을 따라 변경을 구현하세요.
4. 변경 사항을 커버하는 테스트를 작성하거나 업데이트하세요.
5. 모든 기존 테스트가 통과하는지 확인하세요.
6. 변경 사항에 대한 명확한 설명과 함께 PR을 생성하세요.

### Guardrails

- 이슈 본문을 계획이나 진행 추적 목적으로 수정하지 마세요.
- terminal 상태인 이슈에 대해서는 아무것도 하지 말고 종료하세요.
- 범위 밖 개선사항을 발견하면 현재 범위를 확장하지 말고 별도 이슈를 생성하세요.

### Workpad Template

이슈 코멘트에 아래 구조의 워크패드를 생성하여 진행 상황을 추적하세요:

\`\`\`md
## Workpad

### Plan

- [ ] 1. 작업 항목

### Acceptance Criteria

- [ ] 기준 1

### Validation

- [ ] 테스트: \`명령어\`

### Notes

- 진행 메모
\`\`\``;

  return template;
}

function generateStatusMapWithDescriptions(
  mappings: Record<string, StateMapping>
): string {
  const roleDescriptions: Record<string, string> = {
    active: "에이전트가 즉시 작업 시작",
    wait: "PR 생성 완료, 사람 리뷰 대기",
    terminal: "완료, 에이전트 종료",
  };

  const lines: string[] = ["## Status Map", ""];

  for (const [columnName, mapping] of Object.entries(mappings)) {
    const rolePart = `[${mapping.role}]`;
    const goalPart = mapping.goal ? ` — ${mapping.goal}` : "";
    const descPart = roleDescriptions[mapping.role]
      ? ` *(${roleDescriptions[mapping.role]})*`
      : "";
    lines.push(`- **${columnName}** ${rolePart}${goalPart}${descPart}`);
  }

  return lines.join("\n");
}
