import type { CommandHandler } from "../index.js";

export function createRemovedCommandHandler(message: string): CommandHandler {
  return async () => {
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  };
}
