import { NETWORK_IDS, TX_REQUEST_STATES } from "@zyropay/shared";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createDb } from "./client";
import * as schema from "./schema";

describe("db schema", () => {
  it("enums mirror @zyropay/shared", () => {
    expect(schema.networkEnum.enumValues).toEqual([...NETWORK_IDS]);
    expect(schema.txRequestStateEnum.enumValues).toEqual([...TX_REQUEST_STATES]);
  });

  it("idempotency key is unique per user", () => {
    const cfg = getTableConfig(schema.transactionRequests);
    const idx = cfg.indexes.find(
      (i) => i.config.name === "transaction_requests_user_idempotency_uq",
    );
    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.columns.map((c) => ("name" in c ? c.name : ""))).toEqual([
      "user_id",
      "idempotency_key",
    ]);
  });

  it("wallets can be archived (removed = unlinked), and archived_at is nullable", () => {
    const col = getTableConfig(schema.wallets).columns.find((c) => c.name === "archived_at");
    expect(col?.notNull).toBe(false);
  });

  it("watch wallets: one live row per user+family+address, idempotency key unique per user", () => {
    const cfg = getTableConfig(schema.watchWallets);
    const live = cfg.indexes.find((i) => i.config.name === "watch_wallets_user_family_address_uq");
    expect(live?.config.unique).toBe(true);
    expect(live?.config.where).toBeDefined();
    expect(live?.config.columns.map((c) => ("name" in c ? c.name : ""))).toEqual([
      "user_id",
      "family",
      "address",
    ]);
    const idem = cfg.indexes.find((i) => i.config.name === "watch_wallets_user_idempotency_uq");
    expect(idem?.config.unique).toBe(true);
    expect(cfg.foreignKeys).toHaveLength(1);
    // No key material, no Turnkey link: a watch wallet can never sign.
    expect(cfg.columns.map((c) => c.name).filter((n) => /turnkey|key|sign/.test(n))).toEqual([
      "idempotency_key",
    ]);
  });

  it("migration 0003 is purely additive", () => {
    const sql = readFileSync(
      new URL("../drizzle/0003_wallet_management.sql", import.meta.url),
      "utf8",
    );
    expect(sql).not.toMatch(/\b(DROP|RENAME)\b/i);
    expect(sql).toMatch(/ALTER TABLE "wallets" ADD COLUMN "archived_at"/);
  });

  it("migration 0004 (Cardano) only adds enum values and the nullable public_key column", () => {
    const sql = readFileSync(new URL("../drizzle/0004_cardano.sql", import.meta.url), "utf8");
    expect(sql).not.toMatch(/\b(DROP|RENAME)\b/i);
    expect(sql).toMatch(/ALTER TYPE "public"."chain_family" ADD VALUE 'cardano'/);
    expect(sql).toMatch(/ALTER TYPE "public"."network" ADD VALUE 'cardano-preprod'/);
    expect(sql).toMatch(/ALTER TABLE "wallet_addresses" ADD COLUMN "public_key" text;?$/);
  });

  it("webhook events are unique per provider+event_id", () => {
    const cfg = getTableConfig(schema.webhookEvents);
    const idx = cfg.indexes.find((i) => i.config.name === "webhook_events_provider_event_uq");
    expect(idx?.config.unique).toBe(true);
  });

  it("no table stores a raw token or key column", () => {
    const tables = Object.values(schema).filter((v) => is(v, PgTable));
    expect(tables.length).toBe(33);
    for (const table of tables) {
      const cfg = getTableConfig(table);
      for (const col of cfg.columns) {
        if (/token|secret|private_key/.test(col.name)) {
          expect(col.name, `${cfg.name}.${col.name}`).toMatch(
            /_hash$|^encrypted_|^expo_push_token$|^token_endpoint_auth_method$/,
          );
        }
      }
    }
  });

  it("every migration file is registered in drizzle-kit's journal, and no table is created twice", () => {
    const dir = new URL("../drizzle/", import.meta.url);
    const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", dir), "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    const tags = journal.entries.map((e) => e.tag);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.replace(/\.sql$/, ""))
      .sort();
    expect(tags).toEqual(files);
    expect(journal.entries.map((e) => e.idx)).toEqual(tags.map((_, i) => i));
    const created = files.flatMap((f) =>
      [...readFileSync(new URL(`${f}.sql`, dir), "utf8").matchAll(/CREATE TABLE "([a-z_]+)"/g)].map(
        (m) => m[1],
      ),
    );
    expect(new Set(created).size).toBe(created.length);
    const tables = Object.values(schema).filter((v) => is(v, PgTable));
    expect(created.sort()).toEqual(tables.map((t) => getTableConfig(t).name).sort());
  });

  it("createDb refuses an empty URL", () => {
    expect(() => createDb("")).toThrow("DATABASE_URL");
  });
});
