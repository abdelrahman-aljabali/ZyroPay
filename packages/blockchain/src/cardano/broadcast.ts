/*
 * Cardano broadcast, confirmation and signed-transaction checks (Blockfrost).
 *
 *  - broadcast: POST /tx/submit with the CBOR bytes. The tx id is blake2b-256 of the body,
 *    computed locally before sending. Ledger rejections come back as HTTP 400 with the
 *    node's error text; they are mapped to stable reasons:
 *      BadInputsUTxO          -> already landed (success) or `inputs_spent` (definitive)
 *      OutsideValidityInterval -> `ttl_expired` (definitive: rebuild and re-sign)
 *      FeeTooSmall / ValueNotConserved / witness errors -> `rejected`
 *  - status: GET /txs/{hash} (404 = not in a block yet); confirmations = tip height -
 *    block height + 1; `valid_contract: false` = failed (collateral consumed).
 *  - track: `expired` only when the tip slot is past the TTL and the tx is still unknown;
 *    `rebroadcastSuggested` when it is neither on chain nor in Blockfrost's mempool.
 */
import type { Broadcaster, BroadcastResult, NetworkId } from "@zyropay/shared";
import { cardanoKeyHash, cardanoPaymentKeyHash } from "@zyropay/shared";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { ChainError } from "../errors";
import type { HttpOptions } from "../http";
import { isRecord } from "../http";
import { assertFamily, assertSameNetwork } from "../networks";
import { BlockfrostClient } from "./blockfrost";
import { decodeCardanoTx, verifyVkeyWitness } from "./tx";

export interface CardanoBroadcasterConfig extends HttpOptions {
  readonly blockfrostProjectId: string;
  readonly network: NetworkId;
  readonly blockfrostBaseUrl?: string;
  /** Blocks (including the inclusion block) before a tx counts as confirmed. Default 3. */
  readonly confirmations?: number;
}

export interface CardanoTrackResult {
  readonly status: "pending" | "confirmed" | "failed" | "expired";
  readonly confirmations: number;
  readonly error: string | null;
  readonly rebroadcastSuggested: boolean;
}

export interface CardanoBroadcaster extends Broadcaster {
  track(input: { txHash: string; validUntilSlot?: string }): Promise<CardanoTrackResult>;
}

const HEX = /^(0x)?([0-9a-fA-F]{2})+$/;
const HASH = /^[0-9a-f]{64}$/;

/** Lowercase hex without 0x (the form Blockfrost and our storage use). */
export function normalizeCardanoSigned(signed: string, encoding: "base64" | "hex"): string {
  if (encoding !== "hex" || !HEX.test(signed)) {
    throw new ChainError("BAD_REQUEST", "signed Cardano transactions must be hex CBOR");
  }
  return signed.replace(/^0[xX]/, "").toLowerCase();
}

/** Tx id of a SIGNED transaction (body hash). Throws unless it carries a vkey witness. */
export function cardanoTxHashOfSigned(signedHex: string): string {
  const tx = decodeCardanoTx(hexToBytes(normalizeCardanoSigned(signedHex, "hex")));
  if (tx.vkeyWitnesses.length === 0)
    throw new ChainError("BAD_REQUEST", "transaction is not signed");
  return tx.bodyHash;
}

/**
 * C7 for Cardano: the signed transaction carries the reviewed body byte for byte, exactly
 * one vkey witness and nothing else, the witness key hashes to the payment credential of
 * `expectedSigner` (payload.from), and the Ed25519 signature verifies over the body hash.
 */
export function assertCardanoSignedMatchesUnsigned(input: {
  signed: string;
  unsigned: string;
  expectedSigner?: string;
}): void {
  const signed = decodeCardanoTx(hexToBytes(normalizeCardanoSigned(input.signed, "hex")));
  const unsigned = decodeCardanoTx(hexToBytes(normalizeCardanoSigned(input.unsigned, "hex")));
  if (bytesToHex(signed.bodyBytes) !== bytesToHex(unsigned.bodyBytes)) {
    throw new ChainError("PAYLOAD_HASH_MISMATCH", "signed body differs from the reviewed one");
  }
  if (!signed.isValid || signed.hasAuxiliaryData) {
    throw new ChainError(
      "PAYLOAD_HASH_MISMATCH",
      "signed transaction changed is_valid/auxiliary data",
    );
  }
  // The signature adds exactly one vkey witness; script witnesses already in the reviewed
  // transaction (redeemers 5, PlutusV3 scripts 7) must be carried over byte for byte.
  if (unsigned.witnessKeys.includes(0)) {
    throw new ChainError("PAYLOAD_HASH_MISMATCH", "the reviewed transaction was already signed");
  }
  const expectedKeys = [0, ...unsigned.witnessKeys].sort((a, b) => a - b).join(",");
  if (
    [...signed.witnessKeys].sort((a, b) => a - b).join(",") !== expectedKeys ||
    signed.vkeyWitnesses.length !== 1
  ) {
    throw new ChainError("PAYLOAD_HASH_MISMATCH", "expected exactly one vkey witness");
  }
  for (const [key, bytes] of unsigned.witnessEntries) {
    const carried = signed.witnessEntries.get(key);
    if (carried === undefined || bytesToHex(carried) !== bytesToHex(bytes)) {
      throw new ChainError("PAYLOAD_HASH_MISMATCH", "signed script witnesses differ");
    }
  }
  const witness = signed.vkeyWitnesses[0];
  if (witness === undefined || !verifyVkeyWitness(signed.bodyHash, witness)) {
    throw new ChainError("PAYLOAD_HASH_MISMATCH", "the witness signature does not verify");
  }
  if (input.expectedSigner !== undefined) {
    const expected = cardanoPaymentKeyHash(input.expectedSigner);
    if (expected === null || cardanoKeyHash(witness.vkey) !== expected) {
      throw new ChainError("PAYLOAD_HASH_MISMATCH", "transaction was signed by another key");
    }
  }
}

function rejectionReason(text: string): "inputs_spent" | "ttl_expired" | "rejected" | null {
  if (/BadInputsUTxO/.test(text)) return "inputs_spent";
  if (/OutsideValidityIntervalUTxO/.test(text)) return "ttl_expired";
  if (/UTxO|UTXOW|ApplyTxError|ShelleyTxValidationError/i.test(text)) return "rejected";
  return null;
}

export function createCardanoBroadcaster(config: CardanoBroadcasterConfig): CardanoBroadcaster {
  assertFamily(config.network, "cardano");
  const client = new BlockfrostClient({
    ...config,
    projectId: config.blockfrostProjectId,
    ...(config.blockfrostBaseUrl !== undefined ? { baseUrl: config.blockfrostBaseUrl } : {}),
  });
  const required = config.confirmations ?? 3;

  async function lookup(txHash: string) {
    const tx = await client.getOrNull(`/txs/${txHash}`, "txs");
    if (tx === null) return null;
    if (!isRecord(tx) || typeof tx.block_height !== "number") {
      throw new ChainError("UPSTREAM_UNAVAILABLE", "tx status: malformed");
    }
    return { height: BigInt(tx.block_height), validContract: tx.valid_contract !== false };
  }

  async function inMempool(txHash: string): Promise<boolean> {
    return (await client.getOrNull(`/mempool/${txHash}`, "mempool")) !== null;
  }

  async function status(txHash: string) {
    if (!HASH.test(txHash)) throw new ChainError("BAD_REQUEST", "malformed Cardano tx hash");
    const found = await lookup(txHash);
    if (found === null) {
      return {
        status: "pending" as const,
        confirmations: 0,
        error: null,
        simulated: false as const,
      };
    }
    const tip = await client.tip();
    const confirmations = tip.height >= found.height ? Number(tip.height - found.height) + 1 : 1;
    if (!found.validContract) {
      return {
        status: "failed" as const,
        confirmations,
        error: "script validation failed (collateral consumed)",
        simulated: false as const,
      };
    }
    return {
      status: confirmations >= required ? ("confirmed" as const) : ("pending" as const),
      confirmations,
      error: null,
      simulated: false as const,
    };
  }

  return {
    async broadcast(input): Promise<BroadcastResult> {
      assertSameNetwork(config.network, input.network);
      const signedHex = normalizeCardanoSigned(input.signedTransaction, input.encoding);
      const txHash = cardanoTxHashOfSigned(signedHex);
      try {
        const reported = await client.submit(hexToBytes(signedHex));
        if (reported !== txHash) {
          throw new ChainError(
            "BROADCAST_FAILED",
            "Blockfrost reported a different transaction id",
          );
        }
        return { txHash, simulated: false };
      } catch (error) {
        if (!(error instanceof ChainError)) throw error;
        const status = error.details?.status;
        if (status === 425) {
          throw new ChainError("UPSTREAM_UNAVAILABLE", "Cardano mempool is full; retry", {
            retryable: true,
            details: { status },
          });
        }
        const body = typeof error.details?.body === "string" ? error.details.body : "";
        const reason = status === 400 ? rejectionReason(body) : null;
        if (reason === "inputs_spent") {
          // Our own transaction may already have landed (a rebroadcast) or sit in the mempool.
          if (
            (await lookup(txHash).catch(() => null)) !== null ||
            (await inMempool(txHash).catch(() => false))
          ) {
            return { txHash, simulated: false };
          }
        }
        if (reason !== null) {
          throw new ChainError(
            "BROADCAST_FAILED",
            `Cardano node rejected the transaction (${reason})`,
            {
              details: { reason },
            },
          );
        }
        throw error;
      }
    },

    getStatus(input) {
      assertSameNetwork(config.network, input.network);
      return status(input.txHash);
    },

    async track({ txHash, validUntilSlot }) {
      const s = await status(txHash);
      if (s.status !== "pending" || s.confirmations > 0) {
        return {
          status: s.status,
          confirmations: s.confirmations,
          error: s.error,
          rebroadcastSuggested: false,
        };
      }
      if (validUntilSlot !== undefined && /^\d+$/.test(validUntilSlot)) {
        const tip = await client.tip();
        if (tip.slot > BigInt(validUntilSlot)) {
          const again = await status(txHash);
          if (again.status !== "pending" || again.confirmations > 0) {
            return {
              status: again.status,
              confirmations: again.confirmations,
              error: again.error,
              rebroadcastSuggested: false,
            };
          }
          return {
            status: "expired",
            confirmations: 0,
            error: "validity interval (TTL) passed",
            rebroadcastSuggested: false,
          };
        }
      }
      return {
        status: "pending",
        confirmations: 0,
        error: null,
        rebroadcastSuggested: !(await inMempool(txHash)),
      };
    },
  };
}
