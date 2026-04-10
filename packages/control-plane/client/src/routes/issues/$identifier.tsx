import { createFileRoute } from "@tanstack/react-router";
import { Tooltip } from "@radix-ui/themes";
import { isAxiosError } from "axios";
import type { ReactNode } from "react";
import type { IssueStatusEvent, IssueStatusSnapshot } from "@gh-symphony/core";
import { Badge, type BadgeVariant } from "../../components/Badge";
import { Button } from "../../components/Button";
import { useIssueDetail } from "../../hooks/useIssueDetail";
import { useRefresh } from "../../hooks/useRefresh";

export const Route = createFileRoute("/issues/$identifier")({
  component: IssueDetailRoute,
});

type EventTone = "default" | "success" | "warning" | "muted";

const EVENT_STYLES: Record<EventTone, string> = {
  default: "text-text-secondary",
  success: "text-[#4dda80]",
  warning: "text-status-retry-text",
  muted: "text-text-muted",
};

function IssueDetailRoute() {
  const { identifier } = Route.useParams();
  const issueDetailQuery = useIssueDetail(identifier);
  const refreshMutation = useRefresh();
  const statusCode = getStatusCode(issueDetailQuery.error);

  if (statusCode === 404) {
    return <IssueNotFoundView identifier={identifier} />;
  }

  return (
    <IssueDetailView
      detail={issueDetailQuery.data ?? null}
      error={issueDetailQuery.error}
      isRefreshing={refreshMutation.isPending}
      lastUpdatedAt={issueDetailQuery.dataUpdatedAt}
      onRefresh={() => refreshMutation.mutate()}
    />
  );
}

export function IssueDetailView({
  detail,
  error,
  isRefreshing,
  lastUpdatedAt,
  onRefresh,
}: {
  detail: IssueStatusSnapshot | null;
  error: unknown;
  isRefreshing: boolean;
  lastUpdatedAt: number;
  onRefresh: () => void;
}) {
  const staleData = Boolean(error && detail);
  const phaseLabel = getPhaseLabel(detail);
  const runDetails = detail?.running;
  const tokenDetails = runDetails?.tokens;
  const lastEventLabel = getLastEventLabel(detail);

  return (
    <main className="min-h-screen bg-bg-default text-text-primary">
      <header className="border-b border-border-default bg-[#161618]">
        <div className="mx-auto flex w-full max-w-[1440px] items-center justify-between gap-4 px-6 py-3 sm:px-8">
          <div className="flex items-center gap-4 overflow-hidden">
            <a
              className="text-sm font-medium text-interactive no-underline transition hover:text-blue-300"
              href="/"
            >
              ← Overview
            </a>
            <div className="h-5 w-px bg-border-subtle" />
            <span className="truncate font-mono text-[13px] text-text-muted">
              {detail?.issue_identifier ?? "Issue detail"}
            </span>
          </div>
          <Button
            disabled={isRefreshing}
            size="sm"
            variant="ghost"
            onClick={onRefresh}
          >
            {isRefreshing ? "Refreshing..." : "Refresh"}
          </Button>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-6 py-6 sm:px-8">
        {staleData ? (
          <div
            aria-live="polite"
            className="rounded-lg border border-status-retry-text/30 bg-status-retry-bg/40 px-4 py-3 text-sm text-status-retry-text"
          >
            Showing stale data due to a network error. Last updated:{" "}
            {formatDateTime(lastUpdatedAt)}
          </div>
        ) : null}

        {detail ? (
          <>
            <section className="space-y-3">
              <h1 className="font-mono text-3xl font-medium tracking-[-0.03em] text-text-primary">
                {detail.issue_identifier}
              </h1>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={mapStatusVariant(detail.status)} />
                {phaseLabel ? <PhaseBadge label={phaseLabel} /> : null}
                <span className="text-[13px] text-text-muted">
                  {formatAttemptSummary(detail)}
                </span>
              </div>
            </section>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,820px)_minmax(0,1fr)]">
              <div className="space-y-3">
                <DetailCard title="Run Details">
                  <DetailRow label="Session ID" value={runDetails?.session_id} />
                  <DetailRow
                    label="Started"
                    value={
                      runDetails?.started_at ? (
                        <Tooltip content={runDetails.started_at}>
                          <time
                            className="font-mono text-[13px] text-text-primary"
                            dateTime={runDetails.started_at}
                          >
                            {formatDateTime(runDetails.started_at)}
                          </time>
                        </Tooltip>
                      ) : undefined
                    }
                  />
                  <DetailRow
                    label="Turn count"
                    value={formatNumericValue(runDetails?.turn_count)}
                  />
                  <DetailRow
                    label="Workspace path"
                    value={detail.workspace.path}
                    multiline
                  />
                  <DetailRow label="Last event" value={lastEventLabel} />
                </DetailCard>

                <DetailCard title="Token Usage">
                  <DetailRow
                    label="Input tokens"
                    value={formatNumericValue(tokenDetails?.input_tokens)}
                  />
                  <DetailRow
                    label="Output tokens"
                    value={formatNumericValue(tokenDetails?.output_tokens)}
                  />
                  <DetailRow
                    label="Total tokens"
                    value={formatNumericValue(tokenDetails?.total_tokens)}
                  />
                  <DetailRow
                    label="Cumulative total"
                    value={formatCumulativeTotal(detail)}
                  />
                </DetailCard>
              </div>

              <DetailCard title="Recent Events" className="self-start">
                <RecentEvents events={detail.recent_events} />
              </DetailCard>
            </div>
          </>
        ) : (
          <IssueUnavailableView />
        )}
      </div>
    </main>
  );
}

function IssueNotFoundView({ identifier }: { identifier: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg-default px-6 text-text-primary">
      <div className="w-full max-w-xl rounded-2xl border border-border-default bg-bg-surface p-8 text-center">
        <p className="mb-3 font-mono text-sm text-text-muted">{identifier}</p>
        <h1 className="text-2xl font-semibold">Issue not found</h1>
        <p className="mt-3 text-sm text-text-secondary">
          The requested issue detail could not be loaded.
        </p>
        <a
          className="mt-6 inline-flex text-sm font-medium text-interactive no-underline hover:text-blue-300"
          href="/"
        >
          ← Overview
        </a>
      </div>
    </main>
  );
}

function IssueUnavailableView() {
  return (
    <div className="rounded-2xl border border-border-default bg-bg-surface p-8">
      <h2 className="text-lg font-semibold text-text-primary">
        Issue detail unavailable
      </h2>
      <p className="mt-2 text-sm text-text-secondary">
        Waiting for the first successful response from `/api/v1/:identifier`.
      </p>
    </div>
  );
}

function DetailCard({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={[
        "overflow-hidden rounded-xl border border-border-default bg-bg-surface",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="border-b border-border-default bg-bg-muted px-4 py-3 text-[13px] font-semibold text-text-primary">
        {title}
      </div>
      {children}
    </section>
  );
}

function DetailRow({
  label,
  value,
  multiline = false,
}: {
  label: string;
  value?: ReactNode;
  multiline?: boolean;
}) {
  return (
    <div className="grid gap-2 border-b border-border-default px-4 py-3 last:border-b-0 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-4">
      <dt className="text-[13px] text-text-muted">{label}</dt>
      <dd
        className={[
          "m-0 font-mono text-[13px] text-text-primary",
          multiline ? "break-all" : "truncate",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {value ?? "—"}
      </dd>
    </div>
  );
}

function PhaseBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex rounded-full border border-border-subtle bg-bg-muted px-2 py-[3px] font-mono text-[12px] leading-4 text-text-secondary">
      {label}
    </span>
  );
}

function RecentEvents({ events }: { events: IssueStatusEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="px-4 py-6 text-sm text-text-secondary">
        No recent events recorded.
      </div>
    );
  }

  return (
    <ul className="m-0 max-h-[480px] list-none overflow-y-auto p-0">
      {events
        .slice()
        .reverse()
        .map((event, index) => {
          const tone = classifyEventTone(event);

          return (
            <li
              className="grid grid-cols-[84px_minmax(0,1fr)] gap-4 border-b border-border-default px-4 py-3 last:border-b-0"
              key={`${event.at}-${event.event}-${index}`}
            >
              <time
                className="font-mono text-[11px] text-text-muted"
                dateTime={event.at}
              >
                {formatEventTime(event.at)}
              </time>
              <span className={`text-[13px] ${EVENT_STYLES[tone]}`}>
                {event.message ?? event.event}
              </span>
            </li>
          );
        })}
    </ul>
  );
}

function getStatusCode(error: unknown) {
  if (isAxiosError(error)) {
    return error.response?.status ?? null;
  }

  return null;
}

function getPhaseLabel(detail: IssueStatusSnapshot | null) {
  const tracked = detail?.tracked ?? {};
  const executionPhase = tracked.execution_phase;
  const runPhase = tracked.run_phase;

  if (typeof executionPhase === "string" && executionPhase.length > 0) {
    return executionPhase;
  }

  if (typeof runPhase === "string" && runPhase.length > 0) {
    return runPhase;
  }

  return null;
}

export function mapStatusVariant(status: string): BadgeVariant {
  switch (status.toLowerCase()) {
    case "running":
    case "active":
      return "running";
    case "retry":
    case "retrying":
      return "retry";
    case "failed":
    case "error":
      return "failed";
    case "completed":
    case "done":
      return "completed";
    case "degraded":
      return "degraded";
    default:
      return "idle";
  }
}

export function formatAttemptSummary(detail: IssueStatusSnapshot) {
  const attempt = Math.max(detail.attempts.current_retry_attempt, 1);
  const restarts = Math.max(detail.attempts.restart_count, 0);
  const restartLabel = restarts === 1 ? "restart" : "restarts";

  return `Attempt ${attempt} · ${restarts} ${restartLabel}`;
}

function getLastEventLabel(detail: IssueStatusSnapshot | null) {
  const lastEventAt = detail?.running?.last_event_at;
  if (!lastEventAt) {
    return detail?.running?.last_event ?? detail?.last_error ?? null;
  }

  return formatRelativeTime(lastEventAt);
}

function formatCumulativeTotal(detail: IssueStatusSnapshot) {
  const total = detail.running?.tokens?.cumulative_total_tokens;
  if (typeof total !== "number") {
    return "—";
  }

  const runs = detail.attempts.restart_count + 1;
  return `${formatNumber(total)} (across ${runs} runs)`;
}

function formatNumericValue(value: number | null | undefined) {
  if (typeof value !== "number") {
    return "—";
  }

  return formatNumber(value);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatDateTime(value: string | number) {
  const date = typeof value === "number" ? new Date(value) : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
  })
    .format(date)
    .replace(",", "")
    .concat(" UTC");
}

function formatEventTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--:--:--";
  }

  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date);
}

function formatRelativeTime(value: string) {
  const eventTime = new Date(value).getTime();
  if (Number.isNaN(eventTime)) {
    return "—";
  }

  const deltaSeconds = Math.max(0, Math.round((Date.now() - eventTime) / 1000));
  if (deltaSeconds < 60) {
    return `${deltaSeconds}s ago`;
  }

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h ago`;
  }

  const deltaDays = Math.floor(deltaHours / 24);
  return `${deltaDays}d ago`;
}

export function classifyEventTone(event: IssueStatusEvent): EventTone {
  const timestamp = Date.parse(event.at);
  if (!Number.isNaN(timestamp) && Date.now() - timestamp > 5 * 60 * 1000) {
    return "muted";
  }

  const text = `${event.event} ${event.message ?? ""}`.toLowerCase();
  if (text.includes("worker started")) {
    return "success";
  }

  if (text.includes("convergence")) {
    return "warning";
  }

  return "default";
}
