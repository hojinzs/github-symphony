"use client";

import { useEffect, useState } from "react";

type DashboardWorkspace = {
  id: string;
  name: string;
  slug: string;
  status: string;
  agentCredential: {
    source: "platform_default" | "workspace_override";
    status: "ready" | "missing" | "degraded";
    label: string | null;
    message: string;
  };
  runtime: null | {
    status: string;
    port: number;
    state: unknown;
  };
};

export function DashboardClient() {
  const [workspaces, setWorkspaces] = useState<DashboardWorkspace[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let isMounted = true;

    async function load() {
      try {
        const response = await fetch("/api/dashboard");
        const payload = (await response.json()) as { workspaces: DashboardWorkspace[] };

        if (isMounted) {
          setWorkspaces(payload.workspaces);
        }
      } catch {
        if (isMounted) {
          setError("Could not load dashboard data.");
        }
      }
    }

    void load();
    const interval = window.setInterval(() => {
      void load();
    }, 5000);

    return () => {
      isMounted = false;
      window.clearInterval(interval);
    };
  }, []);

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>;
  }

  return (
    <section className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
      {workspaces.map((workspace) => (
        <article
          key={workspace.id}
          className="rounded-[24px] border border-black/10 bg-white/80 p-6 shadow-[0_20px_60px_rgba(13,20,28,0.06)]"
        >
          <div className="flex items-center justify-between">
            <h2 className="font-display text-2xl text-ink">{workspace.name}</h2>
            <span className="rounded-full bg-mist px-3 py-1 text-xs uppercase tracking-[0.2em] text-ink/60">
              {workspace.status}
            </span>
          </div>
          <p className="mt-2 font-mono text-sm text-ink/45">{workspace.slug}</p>
          <div className="mt-4 rounded-2xl border border-black/10 bg-mist/60 p-4 text-sm text-ink/75">
            <p className="font-semibold text-ink">
              Agent credential:{" "}
              {workspace.agentCredential.label ??
                (workspace.agentCredential.source === "platform_default"
                  ? "Platform default"
                  : "Workspace override")}
            </p>
            <p className="mt-1 uppercase tracking-[0.16em] text-[11px] text-ink/55">
              {workspace.agentCredential.status.replace("_", " ")}
            </p>
            <p className="mt-2">{workspace.agentCredential.message}</p>
          </div>
          {workspace.runtime ? (
            <div className="mt-6 space-y-3 text-sm text-ink/70">
              <p>Runtime status: {workspace.runtime.status}</p>
              <p>Port: {workspace.runtime.port}</p>
              <pre className="overflow-x-auto rounded-2xl bg-ink p-4 text-xs text-mist">
                {JSON.stringify(workspace.runtime.state, null, 2)}
              </pre>
            </div>
          ) : (
            <p className="mt-6 text-sm text-ink/60">No worker instance provisioned yet.</p>
          )}
        </article>
      ))}
      {workspaces.length === 0 ? (
        <article className="rounded-[24px] border border-dashed border-black/20 bg-white/70 p-6 text-sm text-ink/60">
          No workspaces yet. Create one first, then provision a worker to see runtime state here.
        </article>
      ) : null}
    </section>
  );
}
