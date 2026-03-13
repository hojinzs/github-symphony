// ── ANSI color and formatting utilities ────────────────────────────────────

export const ESC = "\x1b[";

let noColor = false;

const _bold = (s: string) => `${ESC}1m${s}${ESC}0m`;
const _dim = (s: string) => `${ESC}2m${s}${ESC}0m`;
const _green = (s: string) => `${ESC}32m${s}${ESC}0m`;
const _red = (s: string) => `${ESC}31m${s}${ESC}0m`;
const _yellow = (s: string) => `${ESC}33m${s}${ESC}0m`;
const _cyan = (s: string) => `${ESC}36m${s}${ESC}0m`;
const _magenta = (s: string) => `${ESC}35m${s}${ESC}0m`;
const _blue = (s: string) => `${ESC}34m${s}${ESC}0m`;

export function bold(s: string): string {
  return noColor ? s : _bold(s);
}

export function dim(s: string): string {
  return noColor ? s : _dim(s);
}

export function green(s: string): string {
  return noColor ? s : _green(s);
}

export function red(s: string): string {
  return noColor ? s : _red(s);
}

export function yellow(s: string): string {
  return noColor ? s : _yellow(s);
}

export function cyan(s: string): string {
  return noColor ? s : _cyan(s);
}

export function magenta(s: string): string {
  return noColor ? s : _magenta(s);
}

export function blue(s: string): string {
  return noColor ? s : _blue(s);
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
}

export function setNoColor(value: boolean): void {
  noColor = value;
}

export function getNoColor(): boolean {
  return noColor;
}

export function clearScreen(): string {
  return "\x1b[2J\x1b[H";
}

export function hideCursor(): string {
  return "\x1b[?25l";
}

export function showCursor(): string {
  return "\x1b[?25h";
}
