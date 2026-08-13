# TC-13: standalone 프로젝트 모델 Docker E2E

## Setup

`pnpm e2e:standalone-project`는 entrypoint를 우회한 일회성 컨테이너에서 같은
local seed repository를 참조하는 `project-alpha`, `project-beta`를 만든다. 각 폴더에
`WORKFLOW.md`, `.mcp.json`, `.env`, `.agent/skills/<name>/SKILL.md`를 둔다.

## Steps

1. 두 프로젝트를 `gh-symphony project add`로 하나의 registry에 등록한다.
2. label mapping이 서로소인 두 file-tracker 이슈를 준비한다.
3. 각 project ID의 orchestrator `run-once`를 실행한다.
4. bare cache, worktree, branch, MCP/skill 주입, `git status`, worker log를 검사한다.

## Expected

- 두 프로젝트가 같은 `<config-dir>/repos/test-owner/test-repo.git` bare cache 하나를 공유한다.
- 같은 통합 fixture에서 각각은 자기 label 이슈만 dispatch하고
  `symphony/project-alpha/test-owner-test-repo-101`,
  `symphony/project-beta/test-owner-test-repo-102`의 서로 다른 브랜치에서 실행한다.
- project skill 주입 뒤 `git status --porcelain`은 비어 있고, worker가 project MCP server를
  compose한 뒤 두 worker 모두 `status=completed`를 기록한다.

## Cleanup

일회성 컨테이너 종료와 함께 `/tmp` runtime 및 cache가 제거된다.
