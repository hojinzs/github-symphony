import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Badge, type BadgeVariant } from "./Badge.js";
import { Button } from "./Button.js";

describe("Badge", () => {
  it.each<[BadgeVariant, string, string]>([
    ["running", "RUNNING", "bg-status-running-bg"],
    ["retry", "RETRY", "bg-status-retry-bg"],
    ["failed", "FAILED", "bg-status-failed-bg"],
    ["idle", "IDLE", "bg-status-idle-bg"],
    ["completed", "COMPLETED", "bg-status-completed-bg"],
    ["degraded", "DEGRADED", "bg-status-degraded-bg"],
  ])("renders %s badge styles", (variant, label, containerClass) => {
    const markup = renderToStaticMarkup(<Badge variant={variant} />);

    expect(markup).toContain(label);
    expect(markup).toContain(containerClass);
  });
});

describe("Button", () => {
  it("renders a primary button by default", () => {
    const markup = renderToStaticMarkup(<Button>Refresh</Button>);

    expect(markup).toContain("type=\"button\"");
    expect(markup).toContain("bg-interactive");
    expect(markup).toContain("px-4");
    expect(markup).toContain("Refresh");
  });

  it("renders ghost and destructive variants with requested sizes", () => {
    const ghostMarkup = renderToStaticMarkup(
      <Button variant="ghost" size="sm">
        Details
      </Button>
    );
    const destructiveMarkup = renderToStaticMarkup(
      <Button variant="destructive">Cancel</Button>
    );

    expect(ghostMarkup).toContain("border-border-subtle");
    expect(ghostMarkup).toContain("px-3");
    expect(destructiveMarkup).toContain("bg-status-failed-bg");
    expect(destructiveMarkup).toContain("Cancel");
  });

  it("renders the child element directly when asChild is enabled", () => {
    const markup = renderToStaticMarkup(
      <Button asChild variant="ghost">
        <a href="/issues/demo">Details</a>
      </Button>
    );

    expect(markup).toContain("<a");
    expect(markup).toContain("href=\"/issues/demo\"");
    expect(markup).not.toContain("<button");
  });
});
