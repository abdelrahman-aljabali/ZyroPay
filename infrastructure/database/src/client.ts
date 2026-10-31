import { neon, Pool } from "@neondatabase/serverless";
import { drizzle as drizzleHttp } from "drizzle-orm/neon-http";
import { drizzle as drizzleWs } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

/**
 * Pooled (WebSocket) client: supports interactive transactions, `SELECT ... FOR UPDATE`
 * and optimistic locking, which transaction requests and spending reservations need.
 *
 * On Cloudflare Workers create it per request and close it when done:
 *   const { db, close } = createDb(env.DATABASE_URL); ctx.waitUntil(close());
 */
export function createDb(databaseUrl: string) {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzleWs({ client: pool, schema });
  return { db, close: () => pool.end() };
}

/** Stateless HTTP client for single queries / non-interactive batches (cheap reads). */
export function createHttpDb(databaseUrl: string) {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  return drizzleHttp({ client: neon(databaseUrl), schema });
}

export type Database = ReturnType<typeof createDb>["db"];
export type HttpDatabase = ReturnType<typeof createHttpDb>;
