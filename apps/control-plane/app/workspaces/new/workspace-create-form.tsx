"use client";

import { FormEvent, useEffect, useState } from "react";

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

type AgentCredentialOption = {
  id: string;
  label: string;
  provider: "openai";
  status: "pending" | "ready" | "degraded" | "revoked";
  fingerprint: string;
  isPlatformDefault: boolean;
  degradedReason: string | null;
};

export function WorkspaceCreateForm() {
  const [name, setName] = useState("");
  const [promptGuidelines, setPromptGuidelines] = useState("");
  const [repositories, setRepositories] = useState<RepositoryDraft[]>([EMPTY_REPOSITORY]);
  const [agentCredentialSource, setAgentCredentialSource] = useState<
    "platform_default" | "workspace_override"
  >("platform_default");
  const [agentCredentialId, setAgentCredentialId] = useState("");
  const [credentials, setCredentials] = useState<AgentCredentialOption[]>([]);
  const [platformDefaultCredentialId, setPlatformDefaultCredentialId] = useState<string | null>(
    null
  );
  const [credentialLabel, setCredentialLabel] = useState("");
  const [credentialApiKey, setCredentialApiKey] = useState("");
  const [credentialError, setCredentialError] = useState("");
  const [isCreatingCredential, setIsCreatingCredential] = useState(false);
  const [result, setResult] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const readyCredentials = credentials.filter((credential) => credential.status === "ready");
  const hasReadyPlatformDefault = readyCredentials.some(
    (credential) => credential.id === platformDefaultCredentialId
  );
  const selectedOverride = readyCredentials.find(
    (credential) => credential.id === agentCredentialId
  );
  const canSubmit =
    !isSubmitting &&
    (agentCredentialSource === "platform_default"
      ? hasReadyPlatformDefault
      : Boolean(selectedOverride));

  useEffect(() => {
    void loadCredentials();
  }, []);

  async function loadCredentials() {
    const response = await fetch("/api/agent-credentials");
    const payload = (await response.json()) as {
      credentials?: AgentCredentialOption[];
      platformDefaultCredentialId?: string | null;
      error?: string;
    };

    if (!response.ok) {
      setCredentialError(payload.error ?? "Could not load agent credentials.");
      return;
    }

    setCredentials(payload.credentials ?? []);
    setPlatformDefaultCredentialId(payload.platformDefaultCredentialId ?? null);
    setCredentialError("");
  }

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
        agentCredentialSource,
        ...(agentCredentialSource === "workspace_override"
          ? {
              agentCredentialId
            }
          : {}),
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

  async function handleCreateCredential() {
    setCredentialError("");
    setIsCreatingCredential(true);

    const response = await fetch("/api/agent-credentials", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        label: credentialLabel,
        apiKey: credentialApiKey,
        provider: "openai"
      })
    });
    const payload = (await response.json()) as {
      credential?: AgentCredentialOption;
      error?: string;
    };

    if (!response.ok || !payload.credential) {
      setCredentialError(payload.error ?? "Could not create the agent credential.");
      setIsCreatingCredential(false);
      return;
    }

    setCredentialLabel("");
    setCredentialApiKey("");
    setAgentCredentialId(payload.credential.id);
    setAgentCredentialSource("workspace_override");
    await loadCredentials();
    setIsCreatingCredential(false);
  }

  async function handleSetPlatformDefault(credentialId: string) {
    setCredentialError("");
    const response = await fetch("/api/agent-credentials/default", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        credentialId
      })
    });
    const payload = (await response.json()) as { error?: string };

    if (!response.ok) {
      setCredentialError(payload.error ?? "Could not update the platform default.");
      return;
    }

    await loadCredentials();
    setAgentCredentialSource("platform_default");
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

      <section className="grid gap-4 rounded-[28px] border border-black/10 bg-mist/60 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-2xl text-ink">Agent credentials</h2>
            <p className="text-sm text-ink/60">
              Workspaces can inherit the platform default credential or bind their own
              override.
            </p>
          </div>
          <div className="rounded-2xl border border-black/10 bg-white/80 px-4 py-3 text-sm text-ink/70">
            Ready platform default: {hasReadyPlatformDefault ? "Yes" : "No"}
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <label className="grid gap-2 rounded-2xl border border-black/10 bg-white/80 p-4">
            <span className="text-sm uppercase tracking-[0.18em] text-ink/60">
              Credential source
            </span>
            <select
              className="rounded-2xl border border-black/10 px-4 py-3"
              value={agentCredentialSource}
              onChange={(event) =>
                setAgentCredentialSource(
                  event.target.value as "platform_default" | "workspace_override"
                )
              }
            >
              <option value="platform_default">Platform default</option>
              <option value="workspace_override">Workspace override</option>
            </select>
          </label>

          <label className="grid gap-2 rounded-2xl border border-black/10 bg-white/80 p-4">
            <span className="text-sm uppercase tracking-[0.18em] text-ink/60">
              Override credential
            </span>
            <select
              className="rounded-2xl border border-black/10 px-4 py-3"
              disabled={agentCredentialSource !== "workspace_override"}
              value={agentCredentialId}
              onChange={(event) => setAgentCredentialId(event.target.value)}
            >
              <option value="">Select a ready credential</option>
              {readyCredentials.map((credential) => (
                <option key={credential.id} value={credential.id}>
                  {credential.label}
                  {credential.isPlatformDefault ? " (default)" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          {credentials.length > 0 ? (
            credentials.map((credential) => (
              <article
                key={credential.id}
                className="grid gap-3 rounded-2xl border border-black/10 bg-white/80 p-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-semibold text-ink">{credential.label}</h3>
                  <span className="rounded-full bg-mist px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-ink/60">
                    {credential.status}
                  </span>
                </div>
                <p className="font-mono text-xs text-ink/45">{credential.fingerprint}</p>
                <p className="text-sm text-ink/65">
                  {credential.degradedReason ??
                    (credential.isPlatformDefault
                      ? "Selected as the platform default credential."
                      : "Available for workspace overrides.")}
                </p>
                <button
                  className="rounded-full border border-black/10 px-4 py-2 text-sm disabled:opacity-50"
                  disabled={credential.status !== "ready" || credential.isPlatformDefault}
                  onClick={() => void handleSetPlatformDefault(credential.id)}
                  type="button"
                >
                  {credential.isPlatformDefault ? "Platform default" : "Make default"}
                </button>
              </article>
            ))
          ) : (
            <article className="rounded-2xl border border-dashed border-black/20 bg-white/60 p-4 text-sm text-ink/60 md:col-span-3">
              No agent credentials are registered yet. Create one below before creating a
              workspace.
            </article>
          )}
        </div>

        <div className="rounded-2xl border border-black/10 bg-white/80 p-4">
          <div className="mb-3">
            <h3 className="font-semibold text-ink">Register a new agent credential</h3>
            <p className="text-sm text-ink/60">
              The API key is validated on save and only encrypted secret material is
              stored.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-[1fr,1.4fr,auto]">
            <input
              className="rounded-2xl border border-black/10 px-4 py-3"
              value={credentialLabel}
              onChange={(event) => setCredentialLabel(event.target.value)}
              placeholder="Platform default"
            />
            <input
              className="rounded-2xl border border-black/10 px-4 py-3"
              value={credentialApiKey}
              onChange={(event) => setCredentialApiKey(event.target.value)}
              placeholder="sk-..."
              type="password"
            />
            <button
              className="rounded-full bg-ink px-5 py-3 text-sm font-semibold uppercase tracking-[0.2em] text-white disabled:opacity-50"
              disabled={isCreatingCredential}
              onClick={() => void handleCreateCredential()}
              type="button"
            >
              {isCreatingCredential ? "Saving..." : "Save credential"}
            </button>
          </div>
          {credentialError ? (
            <p className="mt-3 text-sm text-red-600">{credentialError}</p>
          ) : null}
        </div>

        {agentCredentialSource === "platform_default" && !hasReadyPlatformDefault ? (
          <p className="text-sm text-red-600">
            A ready platform-default agent credential is required before this workspace
            can be created.
          </p>
        ) : null}
        {agentCredentialSource === "workspace_override" && !selectedOverride ? (
          <p className="text-sm text-red-600">
            Select a ready workspace override credential before creating the workspace.
          </p>
        ) : null}
      </section>

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
        disabled={!canSubmit}
        type="submit"
      >
        {isSubmitting ? "Creating..." : "Create workspace"}
      </button>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {result ? <p className="text-sm text-emerald-700">{result}</p> : null}
    </form>
  );
}
