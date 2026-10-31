/*
 * Short-lived provider credentials shared by every isolate, AES-256-GCM encrypted in
 * provider_credentials (key: DELEGATED_KEY_ENCRYPTION_KEY, AAD: "provider:<name>").
 *
 * Transak: refreshing the partner access token invalidates the previous one, so a
 * per-isolate cache would make isolates invalidate each other's tokens. The store keeps the
 * current and the previous token (webhooks may still be signed with the previous one).
 */
import type { TransakTokenStore } from "@zyropay/integrations";
import { decryptSecret, encryptSecret } from "@zyropay/wallet";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import * as t from "../db/tables";

const TokenSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.number(),
  previous: z.string().min(1).optional(),
});

export function createDbTokenStore(
  db: () => Db,
  keyBase64: string,
  provider: string,
): TransakTokenStore {
  const aad = `provider:${provider}`;
  return {
    async get() {
      const [row] = await db()
        .select()
        .from(t.providerCredentials)
        .where(eq(t.providerCredentials.provider, provider));
      if (row === undefined) return null;
      try {
        const parsed = TokenSchema.safeParse(
          JSON.parse(await decryptSecret(row.encryptedValue, keyBase64, aad)),
        );
        return parsed.success ? parsed.data : null;
      } catch {
        // Undecryptable (rotated key) or malformed: treat as absent; the provider refreshes.
        return null;
      }
    },
    async set(value) {
      const encryptedValue = await encryptSecret(JSON.stringify(value), keyBase64, aad);
      const now = new Date();
      await db()
        .insert(t.providerCredentials)
        .values({ provider, encryptedValue, expiresAt: new Date(value.expiresAt), updatedAt: now })
        .onConflictDoUpdate({
          target: t.providerCredentials.provider,
          set: { encryptedValue, expiresAt: new Date(value.expiresAt), updatedAt: now },
        });
    },
  };
}
