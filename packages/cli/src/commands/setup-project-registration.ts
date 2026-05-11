import * as p from "@clack/prompts";
import type { LinkedRepository, ProjectDetail } from "../github/client.js";
import { abortIfCancelled } from "./init.js";

export type ProjectRegistrationOptions = {
  assignedOnly: boolean;
  selectedRepos: LinkedRepository[];
  workspaceDir: string;
};

export async function promptProjectRegistrationOptions(input: {
  projectDetail: ProjectDetail;
  defaultWorkspaceDir: string;
  assignedOnlyMessage?: string;
  assignedOnlyInitialValue?: boolean;
}): Promise<ProjectRegistrationOptions> {
  const assignedOnly = await abortIfCancelled(
    p.confirm({
      message:
        input.assignedOnlyMessage ??
        "Only process issues assigned to the authenticated GitHub user?",
      initialValue: input.assignedOnlyInitialValue ?? false,
    })
  );

  const customizeAdvancedOptions = await abortIfCancelled(
    p.confirm({
      message: "Customize advanced options? (default: No)",
      initialValue: false,
    })
  );

  let selectedRepos = input.projectDetail.linkedRepositories;
  let workspaceDir = input.defaultWorkspaceDir;

  if (customizeAdvancedOptions) {
    if (input.projectDetail.linkedRepositories.length > 0) {
      const filterRepositories = await abortIfCancelled(
        p.confirm({
          message: "Filter specific repositories? (default: No)",
          initialValue: false,
        })
      );

      if (filterRepositories) {
        selectedRepos = await abortIfCancelled(
          p.multiselect({
            message: "Select repositories to orchestrate:",
            options: input.projectDetail.linkedRepositories.map((repo) => ({
              value: repo,
              label: `${repo.owner}/${repo.name}`,
            })),
            required: true,
          })
        );
      }
    }

    workspaceDir = await abortIfCancelled(
      p.text({
        message: "Workspace root directory:",
        placeholder: input.defaultWorkspaceDir,
        defaultValue: input.defaultWorkspaceDir,
        validate(value: string) {
          return value.trim().length > 0
            ? undefined
            : "Workspace directory is required.";
        },
      })
    );
  }

  return {
    assignedOnly,
    selectedRepos,
    workspaceDir,
  };
}

export function renderProjectRegistrationSummary(input: {
  login: string;
  projectTitle: string;
  repoSummary: string;
  assignedOnly: boolean;
  workspaceDir: string;
}): string {
  return [
    `User:       ${input.login}`,
    `Project:    ${input.projectTitle}`,
    `Repos:      ${input.repoSummary}`,
    `Assigned:   ${input.assignedOnly ? `Only issues assigned to ${input.login}` : "All project issues"}`,
    `Workspace:  ${input.workspaceDir}`,
  ].join("\n");
}
