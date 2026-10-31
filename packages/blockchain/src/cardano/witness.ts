import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { cardanoKeyHash } from "@zyropay/shared";
import { ChainError } from "../errors";
import { assembleTxFromEntries, decodeCardanoTx, verifyVkeyWitness, witnessEntries } from "./tx";

/** Witness keys an unsigned ZyroPay transaction may already carry (script spends). */
const PRESIGN_WITNESS_KEYS = new Set([5, 7]);

/**
 * Turn the reviewed unsigned transaction plus Turnkey's Ed25519 signature into the signed
 * transaction. Fails closed: the unsigned bytes must be one of ours (no vkey witnesses yet;
 * a script spend may carry redeemers (5) and PlutusV3 scripts (7), which are kept byte for
 * byte because script_data_hash commits to the redeemer bytes), the public key must hash to
 * `expectedKeyHash` (the payment credential of payload.from), and the signature must verify
 * over the body hash before anything is returned.
 */
export function attachCardanoWitness(input: {
  unsignedHex: string;
  publicKey: string;
  /** 64-byte Ed25519 signature (Turnkey r || s), hex. */
  signature: string;
  expectedKeyHash: string;
}): { signedTransaction: string; txHash: string } {
  const unsigned = decodeCardanoTx(hexToBytes(input.unsignedHex.replace(/^0x/, "").toLowerCase()));
  if (unsigned.witnessKeys.some((k) => !PRESIGN_WITNESS_KEYS.has(k)))
    throw new ChainError("BAD_REQUEST", "transaction already has witnesses");
  const publicKey = input.publicKey.toLowerCase();
  const signature = input.signature.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(publicKey) || !/^[0-9a-f]{128}$/.test(signature)) {
    throw new ChainError("BAD_REQUEST", "malformed Ed25519 key or signature");
  }
  if (cardanoKeyHash(publicKey) !== input.expectedKeyHash) {
    throw new ChainError("PAYLOAD_HASH_MISMATCH", "signing key does not own the sending address");
  }
  const witness = { vkey: publicKey, signature };
  if (!verifyVkeyWitness(unsigned.bodyHash, witness)) {
    throw new ChainError(
      "PAYLOAD_HASH_MISMATCH",
      "signature does not verify over the transaction body",
    );
  }
  const entries = [...witnessEntries([witness]), ...unsigned.witnessEntries];
  return {
    signedTransaction: bytesToHex(assembleTxFromEntries(unsigned.bodyBytes, entries)),
    txHash: unsigned.bodyHash,
  };
}
