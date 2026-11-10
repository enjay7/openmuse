import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { readConfig } from "./config.ts";
import { createStore } from "./db.ts";
import { stopAcpRuns } from "./engine/acp-agent.ts";

const config = readConfig();
const db = await createStore({
  dataDir: `${config.dataDir}/postgres`,
  databaseUrl: config.databaseUrl,
});
await db.recoverInterruptedActions();
const { app, agent, localThreads } = await createApp(db, config);
if (config.taskWorkerEnabled) agent.start();
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () =>
  console.log(`OpenMuse ${config.mode} API ready at ${config.publicUrl}`),
);
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  void Promise.all([closed, agent.stop(), localThreads.stop()])
    .then(() => stopAcpRuns())
    .then(() => db.close())
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
