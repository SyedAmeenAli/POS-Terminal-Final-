import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

import * as schema from "./schema.js";
import { env } from "../../env.js";
import { logError } from "../../utils/logger.js";

// Each of the three connection strings (owner/bootstrap/runtime) is resolved
// independently — deriving one shared local/TLS verdict from DATABASE_URL
// alone and applying it to all three broke the moment they pointed at
// different hosts (mirrors the same bug found and fixed in ims-1's db.ts:
// a stale duplicate .env entry left RUNTIME_DATABASE_URL on the real Cloud
// SQL public IP while DATABASE_URL stayed on the local proxy). TLS is a
// property of the target host, not of the process.
const sslConfigFor = (connectionString: string) => {
  const isLocal = connectionString.includes("localhost") || connectionString.includes("127.0.0.1");
  // Cloud Run connects over a unix socket (host=/cloudsql/...). That path is
  // already private, and the server rejects SSL on it — requesting TLS fails
  // with "The server does not support SSL connections".
  const isUnixSocket = connectionString.includes("host=/cloudsql/");
  return isLocal || isUnixSocket ? undefined : { rejectUnauthorized: false };
};

// Connection budget — shared with IMS, which points at the SAME Cloud SQL
// instance (max_connections = 50, ~5 held by Cloud SQL's own agents). These
// pools are per PROCESS, so the total is (pool sizes x running instances):
//
//   POS terminal (maxScale 2): (3 + 7 + 2) x 2 = 24
//   IMS backend  (maxScale 1):  3 + 7 + 3 + 2  = 15
//                                              ---
//                                               39, leaving headroom for
//                                               migrations and operator scripts.
//
// Sized at 10/10/3 these two services could demand 74 connections from a
// 50-connection server — harmless while idle (pools open lazily), a source of
// refused connections under concurrent load. Raising maxScale on EITHER
// service means re-doing this arithmetic in both repos.
//
// T11 — exported so ims-1's scripts/verify-connection-budget.ts (that repo
// owns the cross-repo check, both services share one Cloud SQL instance)
// reads the REAL configured value instead of a second, driftable copy.
export const POOL_MAX = { bootstrap: 2, owner: 3, runtime: 7 } as const;

// Fail a request that cannot get a connection rather than hanging on it
// forever, which is node-pg's default.
const CONNECTION_TIMEOUT_MS = 10_000;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  // Owner role: migrations and scripts/, never the till's request path.
  max: POOL_MAX.owner,
  // Cloud SQL over public IP requires TLS. Local Postgres and the unix socket
  // must not request it.
  ssl: sslConfigFor(env.DATABASE_URL),
});

pool.on("error", (error) => {
  logError("database_idle_client_error", error);
});

type TxDb = NodePgDatabase<typeof schema>;

const pooledDb = drizzle(pool, { schema });

// T1b bootstrap role (Part B) — a separate, minimally-privileged connection
// used ONLY for the one query that must run before tenant identity is known:
// the terminal-token scan in requireTerminal. Mirrors ims-1's db.ts; see
// ims-1's scripts/provision-service-roles.ts (ims-1 owns provisioning, this
// repo just connects with it) for what this role can and can't do.
let bootstrapPool: Pool | undefined;

export const getBootstrapDb = (): TxDb => {
  if (!env.BOOTSTRAP_DATABASE_URL) {
    throw new Error(
      "BOOTSTRAP_DATABASE_URL is not set. Provision app_bootstrap via ims-1's scripts/provision-service-roles.ts and set it before using getBootstrapDb().",
    );
  }

  bootstrapPool ??= new Pool({
    connectionString: env.BOOTSTRAP_DATABASE_URL,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    // One short lookup: the terminal-token scan.
    max: POOL_MAX.bootstrap,
    ssl: sslConfigFor(env.BOOTSTRAP_DATABASE_URL),
  });

  return drizzle(bootstrapPool, { schema });
};

// T1b Part E — the connection every terminal-authenticated request runs on.
// Mirrors ims-1's db.ts exactly; see that file's comments for the full
// reasoning. In short: RLS policies are enabled without FORCE, so the table
// owner (postgres) still bypasses them and migrations/scripts are unaffected,
// while this non-owner, non-BYPASSRLS role is the one policies actually bind
// to. Falls back to the main pool when unset so an un-provisioned dev machine
// still runs.
let runtimePool: Pool | undefined;

const getRequestPool = (): Pool => {
  if (!env.RUNTIME_DATABASE_URL) {
    return pool;
  }

  runtimePool ??= new Pool({
    connectionString: env.RUNTIME_DATABASE_URL,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    // The till's request path — the largest share of the budget.
    max: POOL_MAX.runtime,
    ssl: sslConfigFor(env.RUNTIME_DATABASE_URL),
  });

  return runtimePool;
};

// See ims-1's db.ts for why this is `.run()`-based rather than `enterWith`,
// and why `.transaction` has to be special-cased to a SAVEPOINT when a
// request transaction is already open.
// Mirrors ims-1: the store records whether a transaction is actually open,
// so db.transaction() only nests into a SAVEPOINT when one is.
type ScopedDb = { db: TxDb; inTransaction: boolean };

export const scopedDbStorage = new AsyncLocalStorage<ScopedDb>();

export const db: TxDb = new Proxy(pooledDb, {
  get(target, prop, _receiver) {
    const active = scopedDbStorage.getStore();

    if (prop === "transaction" && active?.inTransaction) {
      const scoped = active.db;
      return async <T>(callback: (tx: TxDb) => Promise<T>): Promise<T> => {
        const savepoint = `sp_${randomUUID().replace(/-/g, "")}`;
        await scoped.execute(sql.raw(`savepoint ${savepoint}`));
        try {
          const result = await callback(db);
          await scoped.execute(sql.raw(`release savepoint ${savepoint}`));
          return result;
        } catch (err) {
          await scoped.execute(sql.raw(`rollback to savepoint ${savepoint}`)).catch(() => {});
          throw err;
        }
      };
    }

    const source = active?.db ?? target;
    const value = Reflect.get(source, prop, source);
    return typeof value === "function" ? value.bind(source) : value;
  },
}) as TxDb;

export type RequestTransactionHandle = {
  client: PoolClient;
  txDb: TxDb;
};

export const beginRequestTransaction = async (
  tenantId: string | undefined,
): Promise<RequestTransactionHandle> => {
  const client = await getRequestPool().connect();
  await client.query("BEGIN");

  if (tenantId) {
    // SET LOCAL cannot take a bind parameter for its value. tenantId comes
    // from the authenticated terminal row, never from request input.
    await client.query(`set local app.current_tenant_id = '${tenantId}'`);
  }

  return { client, txDb: drizzle(client, { schema }) };
};

export const commitRequestTransaction = async (
  handle: RequestTransactionHandle,
): Promise<void> => {
  try {
    await handle.client.query("COMMIT");
  } finally {
    handle.client.release();
  }
};

export const rollbackRequestTransaction = async (
  handle: RequestTransactionHandle,
): Promise<void> => {
  try {
    await handle.client.query("ROLLBACK");
  } catch {
    // Connection may already be broken — release regardless.
  } finally {
    handle.client.release();
  }
};

export const closePool = async (): Promise<void> => {
  await pool.end();
  if (bootstrapPool) {
    await bootstrapPool.end();
  }
  if (runtimePool) {
    await runtimePool.end();
  }
};
