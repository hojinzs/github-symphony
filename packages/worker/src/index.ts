import { buildWorkerRuntimeState, startWorkerStateServer } from "./state-server.js";

const port = Number(process.env.PORT ?? process.env.SYMPHONY_PORT ?? 4141);

const server = startWorkerStateServer({
  port,
  getState: async () => buildWorkerRuntimeState(process.env)
});

console.log(
  JSON.stringify(
    {
      package: "@github-symphony/worker",
      runtime: "self-hosted-sample",
      port
    },
    null,
    2
  )
);

function shutdown(signal: NodeJS.Signals) {
  server.close(() => {
    console.log(`Worker state server stopped on ${signal}`);
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
