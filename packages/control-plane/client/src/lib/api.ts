import axios from "axios";
import type { IssueOrchestrationRecord, ProjectStatusSnapshot } from "@gh-symphony/core";

export type ProjectState = ProjectStatusSnapshot & {
  completedCount: number;
  issues: IssueOrchestrationRecord[];
};

export const api = axios.create({
  baseURL: "/",
  headers: {
    Accept: "application/json",
  },
});

export async function fetchProjectState(): Promise<ProjectState> {
  const response = await api.get<ProjectState>("/api/v1/state");
  return response.data;
}

export async function postRefresh(): Promise<void> {
  await api.post("/api/v1/refresh");
}
