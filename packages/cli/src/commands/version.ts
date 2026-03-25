import type { GlobalOptions } from "../index.js";

declare const __CLI_VERSION__: string;

const handler = async (
  _args: string[],
  options: GlobalOptions
): Promise<void> => {
  const version = __CLI_VERSION__;

  if (options.json) {
    process.stdout.write(JSON.stringify({ version }) + "\n");
  } else {
    process.stdout.write(`gh-symphony v${version}\n`);
  }
};

export default handler;
