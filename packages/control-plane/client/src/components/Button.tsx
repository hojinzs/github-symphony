import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  KeyboardEvent,
  MouseEvent,
  ReactElement,
} from "react";
import { Slot } from "@radix-ui/react-slot";

export type ButtonVariant = "primary" | "ghost" | "destructive";
export type ButtonSize = "md" | "sm";

interface ButtonSharedProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}

type ButtonAsButtonProps = ButtonSharedProps &
  ButtonHTMLAttributes<HTMLButtonElement> & {
    asChild?: false;
  };

type ButtonAsChildProps = ButtonSharedProps &
  Omit<
    AnchorHTMLAttributes<HTMLAnchorElement>,
    "children" | "className" | "disabled"
  > & {
    asChild: true;
    children: ReactElement;
    disabled?: boolean;
  };

export type ButtonProps = ButtonAsButtonProps | ButtonAsChildProps;

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

function blockDisabledEvent(
  event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>
) {
  event.preventDefault();
  event.stopPropagation();
}

export function Button(props: ButtonProps) {
  if (props.asChild) {
    const {
      asChild: _asChild,
      children,
      className,
      disabled = false,
      onClick,
      onKeyDown,
      size = "md",
      variant = "primary",
      ...childProps
    } = props;

    return (
      <Slot
        aria-disabled={disabled || undefined}
        className={joinClasses(
          "inline-flex items-center justify-center rounded-md border font-medium transition outline-none",
          "focus-visible:ring-2 focus-visible:ring-interactive/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-default",
          "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
          VARIANT_STYLES[variant],
          SIZE_STYLES[size],
          className
        )}
        data-disabled={disabled ? "" : undefined}
        onClick={(event) => {
          if (disabled) {
            blockDisabledEvent(event);
            return;
          }

          onClick?.(event as unknown as MouseEvent<HTMLAnchorElement>);
        }}
        onKeyDown={(event) => {
          if (
            disabled &&
            (event.key === "Enter" || event.key === " " || event.key === "Spacebar")
          ) {
            blockDisabledEvent(event);
            return;
          }

          onKeyDown?.(event as unknown as KeyboardEvent<HTMLAnchorElement>);
        }}
        tabIndex={disabled ? -1 : childProps.tabIndex}
        {...childProps}
      >
        {children}
      </Slot>
    );
  }

  const {
    asChild: _asChild,
    className,
    size = "md",
    type = "button",
    variant = "primary",
    ...buttonProps
  } = props;

  return (
    <button
      className={joinClasses(
        "inline-flex items-center justify-center rounded-md border font-medium transition outline-none",
        "focus-visible:ring-2 focus-visible:ring-interactive/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-default",
        "disabled:cursor-not-allowed disabled:opacity-50",
        VARIANT_STYLES[variant],
        SIZE_STYLES[size],
        className
      )}
      type={type}
      {...buttonProps}
    />
  );
}
