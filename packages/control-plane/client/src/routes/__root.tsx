import type { PropsWithChildren } from "react";
import { Callout } from "@radix-ui/themes";
import { Outlet, createRootRoute } from "@tanstack/react-router";
import { Badge, type BadgeVariant } from "../components/Badge";
import { Button } from "../components/Button";
import { useProjectState } from "../hooks/useProjectState";
import { useRefresh } from "../hooks/useRefresh";

function joinClasses(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function mapHealthToBadgeVariant(
  health: "idle" | "running" | "degraded" | undefined
): BadgeVariant {
  if (health === "running") {
    return "running";
  }
  if (health === "degraded") {
    return "degraded";
  }
  return "idle";
}

function Shell({ children }: PropsWithChildren) {
  return (
    <div className="min-h-screen bg-bg-default text-text-primary">
      {children}
    </div>
  );
}

function RootErrorBoundary(props: { error: Error; reset: () => void }) {
  return (
    <Shell>
      <div className="mx-auto flex min-h-screen w-full max-w-[1440px] items-center px-6 py-10 sm:px-8">
        <Callout.Root color="red" className="w-full">
          <Callout.Text>
            {props.error.message || "Unknown application error"}
          </Callout.Text>
          <div className="mt-4">
            <Button size="sm" variant="destructive" onClick={props.reset}>
              Try again
            </Button>
          </div>
        </Callout.Root>
      </div>
    </Shell>
  );
}

function RootLayout() {
  const projectState = useProjectState();
  const refresh = useRefresh();
  const projectName = projectState.data?.slug ?? "project";

  return (
    <Shell>
      <header className="sticky top-0 z-10 border-b border-border-default bg-[#141417]/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[1440px] items-center justify-between gap-4 px-6 sm:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <span className="text-lg font-semibold tracking-tight text-interactive">
              ♪
            </span>
            <span className="text-[15px] font-semibold text-text-primary">
              Symphony
            </span>
            <span
              aria-hidden="true"
              className="h-5 w-px shrink-0 bg-border-subtle"
            />
            <span className="truncate font-mono text-sm text-text-muted">
              {projectName}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <Badge variant={mapHealthToBadgeVariant(projectState.data?.health)} />
            <Button
              size="sm"
              variant="ghost"
              className={joinClasses(
                "gap-2",
                refresh.isPending && "pointer-events-none opacity-70"
              )}
              disabled={refresh.isPending}
              onClick={() => {
                void refresh.mutateAsync();
              }}
            >
              <span
                aria-hidden="true"
                className={joinClasses(
                  "text-sm leading-none",
                  refresh.isPending && "animate-spin"
                )}
              >
                ↻
              </span>
              Refresh
            </Button>
          </div>
        </div>
      </header>

      <Outlet />
    </Shell>
  );
}

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: RootErrorBoundary,
});
