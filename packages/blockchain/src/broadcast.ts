import type { Broadcaster, BroadcastResult, NetworkId } from "@zyropay/shared";
import { addressesEqual, chainFamilyOf, evmChainId } from "@zyropay/shared";
import { getBase64Decoder } from "@solana/kit";
import type { Hex } from "viem";
import { keccak256, parseTransaction, recoverTransactionAddress, serializeTransaction } from "viem";
import { ChainError } from "./errors";
import type { HttpOptions } from "./http";
import { JsonRpcError } from "./http";
import { assertFamily, assertSameNetwork } from "./networks";
import { EvmRpc } from "./evm/rpc";
import { bytesEqual, decodeSolanaTransaction } from "./solana/decode";
import type { SolanaCommitment } from "./solana/rpc";
import { SolanaRpc } from "./solana/rpc";
import { isRecord, toBigInt } from "./http";
import {
  assertCardanoSignedMatchesUnsigned,
  cardanoTxHashOfSigned,
  normalizeCardanoSigned,
} from "./cardano/broadcast";

type StatusResult = Awaited<ReturnType<Broadcaster["getStatus"]>>;

export interface SolanaBroadcasterConfig extends HttpOptions {
  readonly rpcUrl: string;
  readonly network: NetworkId;
  /** Commitment at which a transaction counts as confirmed. Default "confirmed". */
  readonly commitment?: SolanaCommitment;
}

export interface EvmBroadcasterConfig extends HttpOptions {
  readonly rpcUrl: string;
  readonly network: NetworkId;
  /** Blocks (including the inclusion block) before a tx counts as confirmed. Default 2. */
  readonly confirmations?: number;
}

const COMMITMENT_RANK: Record<string, number> = { processed: 0, confirmed: 1, finalized: 2 };

const HEX = /^(0x)?([0-9a-fA-F]{2})+$/;

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Bring a signed transaction into the wire encoding the broadcaster and the C7 check use:
 * Solana -> base64 (Turnkey SIGN_TRANSACTION_V2 returns Solana transactions as hex), EVM ->
 * lowercase 0x-prefixed hex (Turnkey returns it without the prefix). Throws on input that is
 * not valid in the given encoding.
 */
export function normalizeSignedTransaction(input: {
  network: NetworkId;
  signedTransaction: string;
  encoding: "base64" | "hex";
}): { signedTransaction: string; encoding: "base64" | "hex" } {
  const family = chainFamilyOf(input.network);
  if (family === "cardano") {
    return {
      signedTransaction: normalizeCardanoSigned(input.signedTransaction, input.encoding),
      encoding: "hex",
    };
  }
  if (family === "solana") {
    if (input.encoding === "base64") {
      return { signedTransaction: input.signedTransaction, encoding: "base64" };
    }
    if (!HEX.test(input.signedTransaction)) {
      throw new ChainError("BAD_REQUEST", "signed Solana transaction is not valid hex");
    }
    return {
      signedTransaction: getBase64Decoder().decode(hexToBytes(input.signedTransaction)),
      encoding: "base64",
    };
  }
  if (input.encoding !== "hex" || !HEX.test(input.signedTransaction)) {
    throw new ChainError("BAD_REQUEST", "signed EVM transactions must be hex");
  }
  const clean = input.signedTransaction.replace(/^0[xX]/, "").toLowerCase();
  return { signedTransaction: `0x${clean}`, encoding: "hex" };
}

/**
 * The transaction id derived from the signed bytes alone (no RPC): Solana = the fee
 * payer's signature (base58), EVM = keccak256 of the signed RLP. Lets the API record the
 * hash BEFORE broadcasting, so a send whose outcome is unknown (timeout, node error) can be
 * reconciled against the chain instead of being marked failed.
 */
export function txHashOfSigned(input: {
  network: NetworkId;
  signedTransaction: string;
  encoding: "base64" | "hex";
}): string {
  const normalized = normalizeSignedTransaction(input);
  if (chainFamilyOf(input.network) === "cardano")
    return cardanoTxHashOfSigned(normalized.signedTransaction);
  if (chainFamilyOf(input.network) === "solana")
    return solanaSignatureOf(normalized.signedTransaction);
  const parsed = parseTransaction(normalized.signedTransaction as Hex);
  if (parsed.r === undefined || parsed.s === undefined) {
    throw new ChainError("BAD_REQUEST", "transaction is not signed");
  }
  return keccak256(normalized.signedTransaction as Hex);
}

/** Signature of the fee payer = the transaction id. Throws if any signature is missing. */
export function solanaSignatureOf(signedBase64: string): string {
  const tx = decodeSolanaTransaction(signedBase64);
  const missing = tx.signatures.filter((s) => s.signature === null);
  if (missing.length > 0) {
    throw new ChainError("BAD_REQUEST", "transaction is not fully signed");
  }
  const first = tx.signatures[0]?.signature;
  if (first === undefined || first === null) throw new ChainError("BAD_REQUEST", "no signature");
  return first;
}

export function createSolanaBroadcaster(config: SolanaBroadcasterConfig): Broadcaster {
  assertFamily(config.network, "solana");
  const rpc = new SolanaRpc(config);
  const commitment = config.commitment ?? "confirmed";

  return {
    async broadcast(input): Promise<BroadcastResult> {
      assertSameNetwork(config.network, input.network);
      // Turnkey returns signed Solana transactions hex-encoded; the RPC takes base64.
      const signedBase64 = normalizeSignedTransaction(input).signedTransaction;
      const txHash = solanaSignatureOf(signedBase64);
      try {
        const sig = await rpc.call<unknown>("sendTransaction", [
          signedBase64,
          { encoding: "base64", skipPreflight: false, preflightCommitment: commitment },
        ]);
        if (sig !== txHash) {
          throw new ChainError("BROADCAST_FAILED", "node returned an unexpected signature");
        }
        return { txHash, simulated: false };
      } catch (error) {
        const mapped = mapSolanaSendError(error, txHash);
        // The cluster already has this exact transaction: rebroadcast is idempotent.
        if (mapped === null) return { txHash, simulated: false };
        throw mapped;
      }
    },

    async getStatus(input): Promise<StatusResult> {
      assertSameNetwork(config.network, input.network);
      const result = await rpc.call<unknown>("getSignatureStatuses", [
        [input.txHash],
        { searchTransactionHistory: true },
      ]);
      const value: unknown =
        isRecord(result) && Array.isArray(result.value) ? result.value[0] : undefined;
      if (value === null || value === undefined) {
        return { status: "pending", confirmations: 0, error: null, simulated: false };
      }
      if (!isRecord(value)) throw new ChainError("UPSTREAM_UNAVAILABLE", "malformed status");
      if (value.err !== null && value.err !== undefined) {
        return {
          status: "failed",
          confirmations: 0,
          error: JSON.stringify(value.err),
          simulated: false,
        };
      }
      const level =
        typeof value.confirmationStatus === "string" ? value.confirmationStatus : "processed";
      const confirmations =
        value.confirmations === null || value.confirmations === undefined
          ? level === "finalized"
            ? 32
            : 0
          : Number(toBigInt(value.confirmations, "confirmations"));
      const reached = (COMMITMENT_RANK[level] ?? 0) >= (COMMITMENT_RANK[commitment] ?? 1);
      return {
        status: reached ? "confirmed" : "pending",
        confirmations,
        error: null,
        simulated: false,
      };
    },
  };
}

/** Map a sendTransaction failure; null means "already processed" (a success). */
function mapSolanaSendError(error: unknown, txHash: string): ChainError | null {
  if (error instanceof JsonRpcError) {
    const msg = `${error.rpcMessage} ${JSON.stringify(error.rpcData ?? null)}`;
    if (/already been processed|AlreadyProcessed/i.test(msg)) return null;
    if (/Blockhash not found|BlockhashNotFound/i.test(msg)) {
      return new ChainError("BROADCAST_FAILED", "blockhash expired; rebuild and re-sign", {
        details: { reason: "blockhash_expired", txHash },
        cause: error,
      });
    }
    if (/insufficient (funds|lamports)|InsufficientFunds|AccountNotFound|"Custom":1\}/i.test(msg)) {
      return new ChainError("INSUFFICIENT_FUNDS", "insufficient funds", { cause: error });
    }
    return new ChainError("BROADCAST_FAILED", `send failed: ${error.rpcMessage}`, {
      details: { txHash },
      cause: error,
    });
  }
  if (error instanceof ChainError) return error;
  return new ChainError("BROADCAST_FAILED", "send failed", { cause: error });
}

export function createEvmBroadcaster(config: EvmBroadcasterConfig): Broadcaster {
  assertFamily(config.network, "evm");
  const rpc = new EvmRpc(config);
  const required = config.confirmations ?? 2;

  return {
    async broadcast(input): Promise<BroadcastResult> {
      assertSameNetwork(config.network, input.network);
      const signed = normalizeSignedTransaction(input).signedTransaction as Hex;
      const parsed = parseTransaction(signed);
      if (parsed.r === undefined || parsed.s === undefined) {
        throw new ChainError("BAD_REQUEST", "transaction is not signed");
      }
      if (parsed.chainId !== evmChainId(config.network)) {
        throw new ChainError("NETWORK_MODE_MISMATCH", "signed transaction is for another chain");
      }
      const txHash = keccak256(signed);
      try {
        const returned = await rpc.sendRawTransaction(signed);
        if (returned.toLowerCase() !== txHash.toLowerCase()) {
          throw new ChainError("BROADCAST_FAILED", "node returned an unexpected hash");
        }
        return { txHash, simulated: false };
      } catch (error) {
        if (error instanceof JsonRpcError) {
          const msg = error.rpcMessage.toLowerCase();
          if (msg.includes("already known") || msg.includes("known transaction")) {
            return { txHash, simulated: false };
          }
          if (msg.includes("nonce too low")) {
            // Fine if it is OUR transaction that consumed the nonce (earlier broadcast).
            const known = await rpc.getTransaction(txHash);
            if (known !== null) return { txHash, simulated: false };
            throw new ChainError("BROADCAST_FAILED", "nonce already used by another transaction", {
              details: { reason: "nonce_too_low" },
              cause: error,
            });
          }
          if (msg.includes("insufficient funds")) {
            throw new ChainError(
              "INSUFFICIENT_FUNDS",
              "insufficient funds for gas * price + value",
              { cause: error },
            );
          }
          if (
            msg.includes("underpriced") ||
            msg.includes("fee cap less than block base fee") ||
            msg.includes("max fee per gas less than block base fee")
          ) {
            throw new ChainError("BROADCAST_FAILED", `fee too low: ${error.rpcMessage}`, {
              details: { reason: "underpriced" },
              cause: error,
            });
          }
          throw new ChainError("BROADCAST_FAILED", `send failed: ${error.rpcMessage}`, {
            cause: error,
          });
        }
        throw error;
      }
    },

    async getStatus(input): Promise<StatusResult> {
      assertSameNetwork(config.network, input.network);
      const receipt = await rpc.getReceipt(input.txHash);
      if (receipt === null) {
        return { status: "pending", confirmations: 0, error: null, simulated: false };
      }
      const head = await rpc.blockNumber();
      const confirmations =
        head >= receipt.blockNumber ? Number(head - receipt.blockNumber + 1n) : 0;
      if (receipt.status === "reverted") {
        return { status: "failed", confirmations, error: "execution reverted", simulated: false };
      }
      return {
        status: confirmations >= required ? "confirmed" : "pending",
        confirmations,
        error: null,
        simulated: false,
      };
    },
  };
}

/**
 * C7 helper: before broadcasting, check that the signed transaction is exactly the unsigned
 * transaction that was reviewed (same message bytes / same fields), and optionally that the
 * EVM signer is the expected address.
 */
export async function assertSignedMatchesUnsigned(input: {
  encoding: "base64" | "hex";
  signed: string;
  unsigned: string;
  expectedSigner?: string;
  /** Required for Cardano (hex like EVM); without it hex is treated as EVM. */
  network?: NetworkId;
}): Promise<void> {
  if (input.network !== undefined && chainFamilyOf(input.network) === "cardano") {
    assertCardanoSignedMatchesUnsigned(input);
    return;
  }
  if (input.encoding === "base64") {
    const signed = decodeSolanaTransaction(input.signed);
    const unsigned = decodeSolanaTransaction(input.unsigned);
    if (!bytesEqual(signed.messageBytes, unsigned.messageBytes)) {
      throw new ChainError("PAYLOAD_HASH_MISMATCH", "signed message differs from the reviewed one");
    }
    if (signed.signatures.some((s) => s.signature === null)) {
      throw new ChainError("BAD_REQUEST", "transaction is not fully signed");
    }
    if (input.expectedSigner !== undefined && signed.feePayer !== input.expectedSigner) {
      throw new ChainError("PAYLOAD_HASH_MISMATCH", "unexpected fee payer");
    }
    return;
  }
  const signed = parseTransaction(input.signed as Hex);
  if (signed.r === undefined) throw new ChainError("BAD_REQUEST", "transaction is not signed");
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- legacy `v` must be stripped too
  const { r: _r, s: _s, v: _v, yParity: _y, ...rest } = signed;
  const reserialized = serializeTransaction(rest);
  if (reserialized.toLowerCase() !== input.unsigned.toLowerCase()) {
    throw new ChainError(
      "PAYLOAD_HASH_MISMATCH",
      "signed transaction differs from the reviewed one",
    );
  }
  if (input.expectedSigner !== undefined) {
    const signer = await recoverTransactionAddress({
      serializedTransaction: input.signed as Parameters<
        typeof recoverTransactionAddress
      >[0]["serializedTransaction"],
    });
    if (!addressesEqual("evm", signer, input.expectedSigner)) {
      throw new ChainError("PAYLOAD_HASH_MISMATCH", "transaction was signed by another address");
    }
  }
}
