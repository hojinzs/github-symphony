import type { ProjectStatusSnapshot } from "@gh-symphony/core";
import { bold, dim, green, red, stripAnsi, yellow } from "./ansi.js";

export type StatusLivenessRuntime = {
  daemonRunning: boolean;
  lastTickStale: boolean;
};

export type StatusLivenessBanner = {
  health: ProjectStatusSnapshot["health"] | "stopped";
  lastTickLabel: string;
  stale: boolean;
  restartGuidance: string | null;
  lastKnownState: string | null;
};

type BannerLayout = "legacy" | "dashboard";

export function relativeTime(
  isoString: string,
  nowMs: number = Date.now()
): string {
  const now = new Date(nowMs);
  const then = new Date(isoString);
  const diffMs = now.getTime() - then.getTime();
  const diffS = Math.floor(diffMs / 1000);
  const diffM = Math.floor(diffS / 60);
  const diffH = Math.floor(diffM / 60);
  const diffD = Math.floor(diffH / 24);

  if (diffS < 60) return `${diffS}s ago`;
  if (diffM < 60) return `${diffM}m ago`;
  if (diffH >= 48) return `${diffD}d ago`;
  return `${diffH}h ago`;
}

export function createStatusLivenessBanner(
  snapshot: Pick<ProjectStatusSnapshot, "health" | "lastTickAt">,
  runtime: StatusLivenessRuntime,
  lastTickLabel: string = relativeTime(snapshot.lastTickAt),
  startCommandName = "gh-symphony repo start"
): StatusLivenessBanner {
  const stopped = !runtime.daemonRunning;

  return {
    health: stopped ? "stopped" : snapshot.health,
    lastTickLabel,
    stale: runtime.daemonRunning && runtime.lastTickStale,
    restartGuidance: stopped
      ? `daemon not running — run '${startCommandName}'`
      : null,
    lastKnownState: stopped ? `Last known state: ${snapshot.health}` : null,
  };
}

function healthIcon(health: StatusLivenessBanner["health"]): string {
  switch (health) {
    case "idle":
    case "running":
      return green("●");
    case "degraded":
    case "stopped":
      return red("●");
  }
}

function applyColor(noColor: boolean, value: string): string {
  return noColor ? stripAnsi(value) : value;
}

export function renderStatusLivenessBanner(
  banner: StatusLivenessBanner,
  options: { layout: BannerLayout; noColor: boolean }
): string[] {
  const healthLabel = options.layout === "dashboard" ? dim("Health") : "Health";
  const healthValue =
    options.layout === "dashboard" ? bold(banner.health) : banner.health;
  const healthText = applyColor(
    options.noColor,
    `${healthIcon(banner.health)} ${healthLabel}${options.layout === "legacy" ? "    " : "  "}${healthValue}`
  );
  const lastTickLabel =
    options.layout === "dashboard" ? dim("Last tick") : "Last tick";
  const lastTickText = applyColor(
    options.noColor,
    `${lastTickLabel}  ${banner.lastTickLabel}${banner.stale ? yellow(" (stale)") : ""}`
  );

  const lines = [
    options.layout === "legacy"
      ? `  ${healthText}${" ".repeat(Math.max(0, 30 - stripAnsi(healthText).length))}${lastTickText}`
      : `  ${healthText}     ${lastTickText}`,
  ];

  if (banner.restartGuidance && banner.lastKnownState) {
    if (options.layout === "legacy") {
      lines.push(
        applyColor(options.noColor, `  ${yellow(banner.restartGuidance)}`)
      );
      lines.push(
        applyColor(options.noColor, `  ${dim(banner.lastKnownState)}`)
      );
    } else {
      lines.push(
        applyColor(
          options.noColor,
          `  ${yellow(banner.restartGuidance)}  ${dim(banner.lastKnownState)}`
        )
      );
    }
  }

  return lines;
}
