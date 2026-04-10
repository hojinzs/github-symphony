import type { ReactNode } from "react";
import type { OrchestratorRunStatus } from "@gh-symphony/core";
import { Callout, Skeleton, Table } from "@radix-ui/themes";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Badge, type BadgeVariant } from "../components/Badge";
import type { ProjectState } from "../lib/api";
import { useProjectState } from "../hooks/useProjectState";

type SummaryCardDefinition = {
  label: string;
  value: number;
  accent: string;
};

export function mapRunStatusToBadgeVariant(
  status: OrchestratorRunStatus
): BadgeVariant {
  if (status === "failed") {
    return "failed";
  }
  if (status === "retrying" || status === "suppressed") {
    return "retry";
  }
  if (status === "succeeded") {
    return "completed";
  }
  return "running";
}

export function formatRelativeTime(
  value: string | null | undefined,
  now = new Date()
): string {
  if (!value) {
    return "N/A";
  }

  const target = new Date(value);
  if (Number.isNaN(target.getTime())) {
    return value;
  }

  const diffMs = target.getTime() - now.getTime();
  const isFuture = diffMs > 0;
  const totalSeconds = Math.max(1, Math.round(Math.abs(diffMs) / 1_000));

  const parts: string[] = [];
  const units = [
    { size: 86_400, label: "d" },
    { size: 3_600, label: "h" },
    { size: 60, label: "m" },
    { size: 1, label: "s" },
  ];

  let remainder = totalSeconds;
  for (const unit of units) {
    if (parts.length === 2) {
      break;
    }

    const amount = Math.floor(remainder / unit.size);
    if (amount <= 0 && unit.label !== "s") {
      continue;
    }

    if (amount > 0 || (unit.label === "s" && parts.length === 0)) {
      parts.push(`${amount}${unit.label}`);
      remainder -= amount * unit.size;
    }
  }

  return isFuture ? `in ${parts.join(" ")}` : `${parts.join(" ")} ago`;
}

export function resolveRetryError(
  projectState: Pick<ProjectState, "issues">,
  issueIdentifier: string
): string {
  const issue = projectState.issues.find(
    (candidate) => candidate.identifier === issueIdentifier
  );

  return issue?.retryEntry?.error ?? "No retry error recorded";
}

function getSummaryCards(projectState: ProjectState): SummaryCardDefinition[] {
  return [
    {
      label: "Active Runs",
      value: projectState.summary.activeRuns,
      accent: "#3b82f6",
    },
    {
      label: "Dispatched",
      value: projectState.summary.dispatched,
      accent: "#22c55e",
    },
    {
      label: "Retry Queue",
      value: projectState.retryQueue.length,
      accent: "#facc15",
    },
    {
      label: "Completed",
      value: projectState.completedCount,
      accent: "#22c55e",
    },
  ];
}

function Section(props: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-border-default bg-bg-surface shadow-[0_20px_80px_rgb(0_0_0_/_0.24)]">
      <div className="flex items-center gap-2 px-5 py-4">
        <h2 className="text-[15px] font-semibold text-text-primary">
          {props.title}
        </h2>
        {typeof props.count === "number" ? (
          <span className="rounded-full bg-bg-muted px-2 py-0.5 text-[11px] font-medium text-text-muted">
            {props.count}
          </span>
        ) : null}
      </div>
      {props.children}
    </section>
  );
}

function SummaryCards(props: { projectState: ProjectState | undefined }) {
  const cards = props.projectState ? getSummaryCards(props.projectState) : null;

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {(cards ?? Array.from({ length: 4 })).map((card, index) => (
        <article
          key={card ? card.label : `loading-${index}`}
          className="rounded-xl border border-border-default bg-bg-surface px-5 py-4 shadow-[0_18px_48px_rgb(0_0_0_/_0.18)]"
        >
          <div
            className="mb-3 h-0.5 w-6 rounded-full"
            style={{ backgroundColor: card?.accent ?? "#3f3f46" }}
          />
          {card ? (
            <>
              <div className="text-4xl font-semibold tracking-tight text-text-primary">
                {card.value}
              </div>
              <div className="mt-1 text-sm text-text-secondary">{card.label}</div>
            </>
          ) : (
            <div className="space-y-2">
              <Skeleton height="34px" width="48px" />
              <Skeleton height="16px" width="120px" />
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

function TableHeaderCell(props: { children: ReactNode; className?: string }) {
  return (
    <Table.ColumnHeaderCell
      className={`bg-bg-muted text-[10px] uppercase tracking-[0.18em] text-[#71717a] ${props.className ?? ""}`}
    >
      {props.children}
    </Table.ColumnHeaderCell>
  );
}

function StatePill(props: { label: string }) {
  return (
    <span className="inline-flex rounded-full border border-white/8 bg-white/4 px-2 py-0.5 text-[11px] font-medium text-text-secondary">
      {props.label}
    </span>
  );
}

function LoadingTable(props: { columns: string[] }) {
  return (
    <div className="px-5 pb-5">
      <div className="overflow-hidden rounded-lg border border-border-default">
        <Table.Root>
          <Table.Header>
            <Table.Row>
              {props.columns.map((column) => (
                <TableHeaderCell key={column}>{column}</TableHeaderCell>
              ))}
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {Array.from({ length: 3 }).map((_, rowIndex) => (
              <Table.Row key={`skeleton-${rowIndex}`}>
                {props.columns.map((column) => (
                  <Table.Cell key={`${column}-${rowIndex}`}>
                    <Skeleton height="16px" width="100%" />
                  </Table.Cell>
                ))}
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </div>
    </div>
  );
}

function ActiveRunsTable(props: { projectState: ProjectState }) {
  if (props.projectState.activeRuns.length === 0) {
    return (
      <div className="px-5 pb-5 text-sm text-text-secondary">No active runs</div>
    );
  }

  return (
    <div className="px-5 pb-5">
      <div className="overflow-hidden rounded-lg border border-border-default">
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <TableHeaderCell>Issue</TableHeaderCell>
              <TableHeaderCell>State</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Started</TableHeaderCell>
              <TableHeaderCell className="w-[46%]">Last Event</TableHeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {props.projectState.activeRuns.map((run) => (
              <Table.Row key={run.runId}>
                <Table.Cell>
                  <Link
                    to="/issues/$identifier"
                    params={{ identifier: run.issueIdentifier }}
                    className="font-mono text-sm text-text-primary no-underline hover:text-interactive"
                  >
                    {run.issueIdentifier}
                  </Link>
                </Table.Cell>
                <Table.Cell>
                  <StatePill label={run.issueState} />
                </Table.Cell>
                <Table.Cell>
                  <Badge variant={mapRunStatusToBadgeVariant(run.status)} />
                </Table.Cell>
                <Table.Cell className="text-sm text-text-secondary">
                  {formatRelativeTime(run.startedAt)}
                </Table.Cell>
                <Table.Cell className="text-sm text-text-secondary">
                  {run.lastEvent ?? "No recent events"}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </div>
    </div>
  );
}

function RetryQueueTable(props: { projectState: ProjectState }) {
  if (props.projectState.retryQueue.length === 0) {
    return (
      <div className="px-5 pb-5 text-sm text-text-secondary">
        No items in retry queue
      </div>
    );
  }

  return (
    <div className="px-5 pb-5">
      <div className="overflow-hidden rounded-lg border border-border-default">
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <TableHeaderCell>Issue</TableHeaderCell>
              <TableHeaderCell>Kind</TableHeaderCell>
              <TableHeaderCell>Retry At</TableHeaderCell>
              <TableHeaderCell className="w-[42%]">Error</TableHeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {props.projectState.retryQueue.map((entry) => (
              <Table.Row key={entry.runId}>
                <Table.Cell>
                  <Link
                    to="/issues/$identifier"
                    params={{ identifier: entry.issueIdentifier }}
                    className="font-mono text-sm text-text-primary no-underline hover:text-interactive"
                  >
                    {entry.issueIdentifier}
                  </Link>
                </Table.Cell>
                <Table.Cell>
                  <StatePill label={entry.retryKind} />
                </Table.Cell>
                <Table.Cell className="text-sm text-text-secondary">
                  {formatRelativeTime(entry.nextRetryAt)}
                </Table.Cell>
                <Table.Cell className="text-sm text-text-secondary">
                  {resolveRetryError(props.projectState, entry.issueIdentifier)}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </div>
    </div>
  );
}

function DataStatus(props: { projectState: ProjectState }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-text-secondary">
      <span>Last tick {formatRelativeTime(props.projectState.lastTickAt)}</span>
      <span>Tracker {props.projectState.tracker.bindingId}</span>
      {props.projectState.lastError ? (
        <span className="text-status-failed-text">
          Last error: {props.projectState.lastError}
        </span>
      ) : null}
    </div>
  );
}

function ProjectOverviewRoute() {
  const projectState = useProjectState();

  return (
    <main className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-6 py-6 sm:px-8">
      {projectState.isError ? (
        <Callout.Root color="red">
          <Callout.Text>
            {projectState.error instanceof Error
              ? projectState.error.message
              : "Failed to load project overview"}
          </Callout.Text>
        </Callout.Root>
      ) : null}

      <SummaryCards projectState={projectState.data} />

      {projectState.data ? <DataStatus projectState={projectState.data} /> : null}

      <Section
        title="Active Runs"
        count={projectState.data?.summary.activeRuns}
      >
        {projectState.isLoading ? (
          <LoadingTable
            columns={["Issue", "State", "Status", "Started", "Last Event"]}
          />
        ) : projectState.data ? (
          <ActiveRunsTable projectState={projectState.data} />
        ) : (
          <div className="px-5 pb-5 text-sm text-text-secondary">
            Project state unavailable
          </div>
        )}
      </Section>

      <Section title="Retry Queue" count={projectState.data?.retryQueue.length}>
        {projectState.isLoading ? (
          <LoadingTable columns={["Issue", "Kind", "Retry At", "Error"]} />
        ) : projectState.data ? (
          <RetryQueueTable projectState={projectState.data} />
        ) : (
          <div className="px-5 pb-5 text-sm text-text-secondary">
            Project state unavailable
          </div>
        )}
      </Section>
    </main>
  );
}

export const Route = createFileRoute("/")({
  component: ProjectOverviewRoute,
});
