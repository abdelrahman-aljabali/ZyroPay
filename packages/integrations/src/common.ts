import { ChainError } from "@zyropay/blockchain";
import type {
  CanonicalTransactionPayload,
  JsonObject,
  PluginManifest,
  PluginQuote,
  VerificationResult,
} from "@zyropay/shared";
import {
  canonicalize,
  CanonicalTransactionPayloadSchema,
  getPluginManifest,
  JsonObjectSchema,
} from "@zyropay/shared";
import type { z } from "zod";

export function manifestFor(id: string): PluginManifest {
  const manifest = getPluginManifest(id);
  if (manifest === undefined) throw new Error(`no manifest for plugin ${id}`);
  return manifest;
}

/**
 * Structured inputs only: parse plugin params with a strict schema (unknown keys rejected,
 * no free-text "instructions" field anywhere). Failure is VALIDATION_FAILED.
 */
export function parseParams<T extends z.ZodType>(schema: T, params: unknown): z.infer<T> {
  const result = schema.safeParse(params);
  if (!result.success) {
    throw new ChainError(
      "VALIDATION_FAILED",
      `invalid plugin params: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return result.data;
}

export function toJsonObject(value: unknown): JsonObject {
  return JsonObjectSchema.parse(JSON.parse(JSON.stringify(value)));
}

/**
 * The payload an approval binds to must carry exactly the quote's material terms. Called by
 * every adapter's buildTransaction before doing anything.
 */
export function assertPayloadMatchesQuote(
  pluginId: string,
  payload: CanonicalTransactionPayload,
  quote: PluginQuote,
  now: Date,
): void {
  if (payload.plugin !== pluginId || quote.pluginId !== pluginId) {
    throw new ChainError("PAYLOAD_HASH_MISMATCH", `payload is not a ${pluginId} request`);
  }
  if (
    payload.pluginData === null ||
    canonicalize(payload.pluginData) !== canonicalize(quote.pluginData)
  ) {
    throw new ChainError("PAYLOAD_HASH_MISMATCH", "payload pluginData differs from the quote");
  }
  if (payload.amount !== quote.inputAmount) {
    throw new ChainError("PAYLOAD_HASH_MISMATCH", "payload amount differs from the quote");
  }
  if (Date.parse(payload.expiresAt) <= now.getTime()) {
    throw new ChainError("REQUEST_EXPIRED", "payload has expired");
  }
}

/**
 * Shared wrapper for PluginAdapter.verifyTransaction: requires the encoding the adapter
 * builds, a schema-valid payload addressed to this plugin, then runs the decoder. Never
 * throws: any exception becomes {ok: false} (fail closed).
 */
export async function runVerifier(
  pluginId: string,
  expected: "base64" | "hex",
  encoding: "base64" | "hex",
  payload: CanonicalTransactionPayload,
  verify: (
    payload: CanonicalTransactionPayload,
  ) => VerificationResult | Promise<VerificationResult>,
): Promise<VerificationResult> {
  try {
    if (encoding !== expected)
      return { ok: false, reason: `${pluginId} transactions are ${expected}-encoded` };
    const parsed = CanonicalTransactionPayloadSchema.safeParse(payload);
    if (!parsed.success) return { ok: false, reason: "invalid payload" };
    if (parsed.data.plugin !== pluginId)
      return { ok: false, reason: `payload is not a ${pluginId} request` };
    return await verify(parsed.data);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "verification failed" };
  }
}
