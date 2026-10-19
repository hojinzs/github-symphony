import { runFleetControlPlane } from "@gh-symphony/fleet-control-plane/runtime";
import type { CommandHandler } from "../index.js";

const handler: CommandHandler = async (args) => {
  await runFleetControlPlane(args[args.indexOf("--config") + 1]!);
};
export default handler;
