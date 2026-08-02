import axios from "axios";
import type {
  IssueOrchestrationRecord,
  ProjectStatusSnapshot,
} from "@gh-symphony/core";

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

const API_TOKEN_SESSION_KEY = "gh-symphony.http-api-token";

api.interceptors.request.use((config) => {
  const token = resolveBrowserApiToken();
  if (token) {
    config.headers.set("Authorization", `Bearer ${token}`);
  }
  return config;
});

export function resolveBrowserApiToken(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const fragmentToken = fragment.get("token")?.trim();
  if (fragmentToken) {
    window.sessionStorage.setItem(API_TOKEN_SESSION_KEY, fragmentToken);
    fragment.delete("token");
    const nextFragment = fragment.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${nextFragment ? `#${nextFragment}` : ""}`
    );
    return fragmentToken;
  }

  return window.sessionStorage.getItem(API_TOKEN_SESSION_KEY);
}

export async function fetchProjectState(): Promise<ProjectState> {
  const response = await api.get<ProjectState>("/api/v1/state");
  return response.data;
}
