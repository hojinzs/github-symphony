"use client";

import { FormEvent, useState } from "react";

type RepositoryDraft = {
  owner: string;
  name: string;
  cloneUrl: string;
};

const EMPTY_REPOSITORY: RepositoryDraft = {
  owner: "",
  name: "",
  cloneUrl: ""
};

export function WorkspaceCreateForm() {
  const [name, setName] = useState("");
  const [promptGuidelines, setPromptGuidelines] = useState("");
  const [repositories, setRepositories] = useState<RepositoryDraft[]>([EMPTY_REPOSITORY]);
  const [result, setResult] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError("");
    setResult("");

    const response = await fetch("/api/workspaces", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name,
        promptGuidelines,
        repositories: repositories.filter(
          (repository) =>
            repository.owner && repository.name && repository.cloneUrl
        )
      })
    });

    const payload = (await response.json()) as { error?: string; workspace?: { name: string } };

    if (!response.ok) {
      setError(payload.error ?? "Workspace creation failed.");
      setIsSubmitting(false);
      return;
    }

    setResult(`Workspace created: ${payload.workspace?.name ?? name}`);
    setIsSubmitting(false);
  }

  return (
    <form
      className="grid gap-6 rounded-[32px] border border-black/10 bg-white/80 p-8 shadow-[0_30px_120px_rgba(13,20,28,0.08)]"
      onSubmit={handleSubmit}
    >
      <div className="grid gap-6 md:grid-cols-2">
        <label className="grid gap-2">
          <span className="text-sm uppercase tracking-[0.2em] text-ink/60">Workspace name</span>
          <input
            className="rounded-2xl border border-black/10 px-4 py-3"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Platform Ops"
            required
          />
        </label>
        <div className="rounded-2xl border border-black/10 bg-mist px-4 py-3 text-sm text-ink/70">
          Trusted-operator mode uses the stored GitHub App installation automatically.
        </div>
      </div>

      <label className="grid gap-2">
        <span className="text-sm uppercase tracking-[0.2em] text-ink/60">Prompt guidelines</span>
        <textarea
          className="min-h-40 rounded-2xl border border-black/10 px-4 py-3"
          value={promptGuidelines}
          onChange={(event) => setPromptGuidelines(event.target.value)}
          placeholder="Prefer minimal changes, add tests for worker logic, and explain risky operations."
          required
        />
      </label>

      <section className="grid gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-2xl text-ink">Repository allowlist</h2>
            <p className="text-sm text-ink/60">Add one or more repositories this workspace may clone.</p>
          </div>
          <button
            className="rounded-full border border-black/10 px-4 py-2 text-sm"
            type="button"
            onClick={() => setRepositories((current) => [...current, EMPTY_REPOSITORY])}
          >
            Add repository
          </button>
        </div>

        {repositories.map((repository, index) => (
          <div key={`${repository.cloneUrl}-${index}`} className="grid gap-3 rounded-2xl border border-black/10 p-4 md:grid-cols-3">
            <input
              className="rounded-2xl border border-black/10 px-4 py-3"
              value={repository.owner}
              onChange={(event) =>
                setRepositories((current) =>
                  current.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, owner: event.target.value } : item
                  )
                )
              }
              placeholder="owner"
            />
            <input
              className="rounded-2xl border border-black/10 px-4 py-3"
              value={repository.name}
              onChange={(event) =>
                setRepositories((current) =>
                  current.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, name: event.target.value } : item
                  )
                )
              }
              placeholder="repository"
            />
            <input
              className="rounded-2xl border border-black/10 px-4 py-3"
              value={repository.cloneUrl}
              onChange={(event) =>
                setRepositories((current) =>
                  current.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, cloneUrl: event.target.value } : item
                  )
                )
              }
              placeholder="https://github.com/acme/platform.git"
            />
          </div>
        ))}
      </section>

      <button
        className="rounded-full bg-ink px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-white disabled:opacity-50"
        disabled={isSubmitting}
        type="submit"
      >
        {isSubmitting ? "Creating..." : "Create workspace"}
      </button>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {result ? <p className="text-sm text-emerald-700">{result}</p> : null}
    </form>
  );
}
