import { defineConfig } from "drizzle-kit";

// `generate` needs no database. `migrate`/`check` connect directly: Neon's pooled endpoint
// (PgBouncer, transaction mode) is for app traffic, so prefer DATABASE_URL_UNPOOLED, which
// `neon env pull` writes next to the pooled DATABASE_URL.
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  casing: "snake_case",
  strict: true,
  verbose: true,
  dbCredentials: { url },
});
