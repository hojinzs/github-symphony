import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Slot } from "@radix-ui/react-slot";

export type ButtonVariant = "primary" | "ghost" | "destructive";
export type ButtonSize = "md" | "sm";

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
  children?: ReactNode;
}

const VARIANT_STYLES: Record<ButtonVariant, string> = {
  primary:
    "border-transparent bg-interactive text-white hover:brightness-110",
  ghost:
    "border-border-subtle bg-bg-muted text-text-secondary hover:border-text-secondary/40 hover:text-text-primary",
  destructive:
    "border-transparent bg-status-failed-bg text-status-failed-text hover:brightness-110",
};

const SIZE_STYLES: Record<ButtonSize, string> = {
  md: "px-4 py-2 text-sm leading-[18px]",
  sm: "px-3 py-1.5 text-xs leading-4",
};

function joinClasses(...classes: Array<string | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function Button({
  asChild = false,
  className,
  size = "md",
  variant = "primary",
  type = "button",
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      className={joinClasses(
        "inline-flex items-center justify-center rounded-md border font-medium transition outline-none",
        "focus-visible:ring-2 focus-visible:ring-interactive/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-default",
        "disabled:cursor-not-allowed disabled:opacity-50",
        VARIANT_STYLES[variant],
        SIZE_STYLES[size],
        className
      )}
      type={asChild ? undefined : type}
      {...props}
    />
  );
}
