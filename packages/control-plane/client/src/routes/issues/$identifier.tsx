import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "../../components/Button";

function IssueDetailPlaceholder() {
  const { identifier } = Route.useParams();

  return (
    <main className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-6 py-8 sm:px-8">
      <div>
        <Button asChild size="sm" variant="ghost">
          <Link to="/">
            <span aria-hidden="true" className="mr-2 text-sm">
              ←
            </span>
            Back to overview
          </Link>
        </Button>
      </div>

      <section className="rounded-xl border border-border-default bg-bg-surface p-6">
        <p className="text-xs uppercase tracking-[0.18em] text-text-muted">
          Issue Detail
        </p>
        <h1 className="mt-2 font-mono text-2xl text-text-primary">
          {identifier}
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-text-secondary">
          Issue detail routing is wired so active run and retry queue rows can
          navigate correctly. The dedicated detail screen will be implemented in
          its own issue.
        </p>
      </section>
    </main>
  );
}

export const Route = createFileRoute("/issues/$identifier")({
  component: IssueDetailPlaceholder,
});
