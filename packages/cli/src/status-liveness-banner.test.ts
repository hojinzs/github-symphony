import { describe, expect, it } from "vitest";
import {
  createStatusLivenessBanner,
  renderStatusLivenessBanner,
} from "./status-liveness-banner.js";

const snapshot = {
  health: "running",
  lastTickAt: "2026-03-30T11:00:00.000Z",
} as const;

describe("status liveness banner", () => {
  it("derives stopped health, restart guidance, and last-known state together", () => {
    const banner = createStatusLivenessBanner(
      snapshot,
      { daemonRunning: false, lastTickStale: false },
      "22d ago"
    );

    expect(banner).toEqual({
      health: "stopped",
      lastTickLabel: "22d ago",
      stale: false,
      restartGuidance: "daemon not running — run 'gh-symphony repo start'",
      lastKnownState: "Last known state: running",
    });
  });

  it("renders the same liveness details for both CLI layouts", () => {
    const banner = createStatusLivenessBanner(
      snapshot,
      { daemonRunning: false, lastTickStale: false },
      "22d ago"
    );

    expect(
      renderStatusLivenessBanner(banner, { layout: "legacy", noColor: true })
    ).toEqual([
      "  ● Health    stopped           Last tick  22d ago",
      "  daemon not running — run 'gh-symphony repo start'",
      "  Last known state: running",
    ]);
    expect(
      renderStatusLivenessBanner(banner, {
        layout: "dashboard",
        noColor: true,
      })
    ).toEqual([
      "  ● Health  stopped     Last tick  22d ago",
      "  daemon not running — run 'gh-symphony repo start'  Last known state: running",
    ]);
  });

  it("keeps live stale state separate from stopped guidance", () => {
    const banner = createStatusLivenessBanner(
      snapshot,
      { daemonRunning: true, lastTickStale: true },
      "2m ago"
    );

    expect(banner.restartGuidance).toBeNull();
    expect(banner.lastKnownState).toBeNull();
    expect(
      renderStatusLivenessBanner(banner, { layout: "dashboard", noColor: true })
    ).toEqual(["  ● Health  running     Last tick  2m ago (stale)"]);
  });
});
