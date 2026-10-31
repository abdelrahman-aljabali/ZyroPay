import { Pool as NeonPool } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";

/**
 * Driver-agnostic Drizzle handle (Neon WebSocket pool in Workers, PGlite in tests).
 * A transaction (`db.transaction(tx => …)`) is also a `Db`, so services take `Db` and
 * work both inside and outside a transaction. Inside a transaction, ALWAYS use `tx`.
 */
export type Db = PgDatabase<PgQueryResultHKT>;

/**
 * Pooled client that supports interactive transactions and SELECT … FOR UPDATE.
 * On Workers, create per request and close with `ctx.waitUntil(close())`.
 *
 *  - neon (default): Neon's serverless driver over WebSockets.
 *  - pg: node-postgres over TCP (workerd `connect()` sockets via nodejs_compat), so
 *    `wrangler dev` can use a plain local Postgres. parseConfig allows it in development
 *    only.
 */
export function createWorkerDb(
  databaseUrl: string,
  driver: "neon" | "pg" = "neon",
): { db: Db; close: () => Promise<void> } {
  if (driver === "pg") {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
    const db = drizzlePg({ client: pool }) as unknown as Db;
    return { db, close: () => pool.end() };
  }
  const pool = new NeonPool({ connectionString: databaseUrl });
  const db = drizzleNeon({ client: pool }) as unknown as Db;
  return { db, close: () => pool.end() };
}
