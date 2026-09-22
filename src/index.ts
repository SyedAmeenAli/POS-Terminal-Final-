import { buildServer } from "./api/server.js";
import { env } from "./env.js";
import { logError, logJson } from "./utils/logger.js";

const port = process.env.PORT ? Number(process.env.PORT) : 3001;

const start = async (): Promise<void> => {
  void env;

  // T1b: request-scoped transactions carry `app.current_tenant_id` into
  // Postgres, which is what the RLS policies read. Must stay on wherever RLS
  // is enabled, or every policy-protected table correctly reads as empty.
  const app = buildServer({ requestTransactions: true });
  await app.listen({ host: env.HOST, port });
  logJson("info", "server_started", { host: env.HOST, port });
};

start().catch((error: unknown) => {
  logError("server_start_failed", error);
  process.exit(1);
});
