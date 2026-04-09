import { Badge } from "../components/Badge";
import { Button } from "../components/Button";

export function FoundationsPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-8 px-6 py-12 sm:px-10">
      <section className="space-y-4">
        <p className="text-sm uppercase tracking-[0.2em] text-text-muted">
          Control Plane Foundations
        </p>
        <div className="space-y-3">
          <h1 className="text-4xl font-semibold tracking-tight text-text-primary">
            GitHub Symphony Control Plane
          </h1>
          <p className="max-w-2xl text-base leading-7 text-text-secondary">
            Dark-mode design tokens and shared controls for the upcoming
            project overview and issue detail surfaces.
          </p>
        </div>
      </section>

      <section className="rounded-2xl border border-border-default bg-bg-surface p-6 shadow-[0_20px_80px_rgb(0_0_0_/_0.35)]">
        <div className="space-y-4">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-text-primary">
              Status Badges
            </h2>
            <p className="text-sm text-text-secondary">
              Shared state labels pulled from the Figma control-plane
              foundations.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Badge variant="running" />
            <Badge variant="retry" />
            <Badge variant="failed" />
            <Badge variant="idle" />
            <Badge variant="completed" />
            <Badge variant="degraded" />
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-border-default bg-bg-elevated p-6">
        <div className="space-y-4">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-text-primary">
              Action Buttons
            </h2>
            <p className="text-sm text-text-secondary">
              Core actions for refresh, secondary navigation, and destructive
              controls.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button>Refresh</Button>
            <Button size="sm">Refresh</Button>
            <Button variant="ghost">Details</Button>
            <Button variant="ghost" size="sm">
              Details
            </Button>
            <Button variant="destructive">Cancel</Button>
            <Button variant="destructive" size="sm">
              Cancel
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}
