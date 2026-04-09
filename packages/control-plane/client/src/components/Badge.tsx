import { Badge as RadixBadge } from "@radix-ui/themes";

export type BadgeVariant =
  | "running"
  | "retry"
  | "failed"
  | "idle"
  | "completed"
  | "degraded";

export interface BadgeProps {
  variant: BadgeVariant;
  className?: string;
}

const BADGE_STYLES: Record<
  BadgeVariant,
  { container: string; dot: string; label: string }
> = {
  running: {
    container: "bg-status-running-bg",
    dot: "bg-status-running-text",
    label: "text-status-running-text",
  },
  retry: {
    container: "bg-status-retry-bg",
    dot: "bg-status-retry-text",
    label: "text-status-retry-text",
  },
  failed: {
    container: "bg-status-failed-bg",
    dot: "bg-status-failed-text",
    label: "text-status-failed-text",
  },
  idle: {
    container: "bg-status-idle-bg",
    dot: "bg-status-idle-text",
    label: "text-status-idle-text",
  },
  completed: {
    container: "bg-status-completed-bg",
    dot: "bg-status-completed-text",
    label: "text-status-completed-text",
  },
  degraded: {
    container: "bg-status-degraded-bg",
    dot: "bg-status-degraded-text",
    label: "text-status-degraded-text",
  },
};

function joinClasses(...classes: Array<string | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function Badge({ variant, className }: BadgeProps) {
  const styles = BADGE_STYLES[variant];

  return (
    <RadixBadge asChild>
      <span
        className={joinClasses(
          "inline-flex items-center gap-1.5 rounded-full px-2 py-[3px] font-medium uppercase tracking-[0.06em]",
          "text-[12px] leading-4",
          styles.container,
          className
        )}
      >
        <span
          aria-hidden="true"
          className={joinClasses("size-2 rounded-full", styles.dot)}
        />
        <span className={styles.label}>{variant.toUpperCase()}</span>
      </span>
    </RadixBadge>
  );
}
