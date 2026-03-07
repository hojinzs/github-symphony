"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type WorkspaceSummary = {
  id: string;
  name: string;
  repositories: Array<{
    owner: string;
    name: string;
  }>;
};

export function IssueCreateForm() {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [repositoryKey, setRepositoryKey] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/workspaces")
      .then((response) => response.json())
      .then((payload: { workspaces: WorkspaceSummary[] }) => {
        setWorkspaces(payload.workspaces);
      })
      .catch(() => {
        setError("Could not load workspaces.");
      });
  }, []);

  const repositories = useMemo(() => {
    const workspace = workspaces.find((entry) => entry.id === workspaceId);
    return workspace?.repositories ?? [];
  }, [workspaceId, workspaces]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");

    const [repositoryOwner = "", repositoryName = ""] = repositoryKey.split("/");
    const response = await fetch("/api/issues", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        workspaceId,
        repositoryOwner,
        repositoryName,
        title,
        body
      })
    });

    const payload = (await response.json()) as { error?: string; issue?: { url?: string } };

    if (!response.ok) {
      setError(payload.error ?? "Issue creation failed.");
      return;
    }

    setMessage(payload.issue?.url ?? "Issue created.");
  }

  return (
    <form
      className="grid gap-6 rounded-[32px] border border-black/10 bg-white/80 p-8 shadow-[0_30px_120px_rgba(13,20,28,0.08)]"
      onSubmit={handleSubmit}
    >
      <select
        className="rounded-2xl border border-black/10 px-4 py-3"
        value={workspaceId}
        onChange={(event) => {
          setWorkspaceId(event.target.value);
          setRepositoryKey("");
        }}
        required
      >
        <option value="">Select workspace</option>
        {workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.name}
          </option>
        ))}
      </select>
      <select
        className="rounded-2xl border border-black/10 px-4 py-3"
        value={repositoryKey}
        onChange={(event) => setRepositoryKey(event.target.value)}
        required
      >
        <option value="">Select repository</option>
        {repositories.map((repository) => {
          const value = `${repository.owner}/${repository.name}`;
          return (
            <option key={value} value={value}>
              {value}
            </option>
          );
        })}
      </select>
      <input
        className="rounded-2xl border border-black/10 px-4 py-3"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Issue title"
        required
      />
      <textarea
        className="min-h-40 rounded-2xl border border-black/10 px-4 py-3"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Describe the task for the coding agent."
        required
      />
      <button className="rounded-full bg-ink px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-white" type="submit">
        Create issue
      </button>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {message ? <p className="text-sm text-emerald-700">{message}</p> : null}
    </form>
  );
}
