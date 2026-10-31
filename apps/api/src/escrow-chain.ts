/*
 * Real EscrowChain (chain.ts) for one Cardano network: Masumi escrow (x402 `masumi`) over
 * Blockfrost with @zyropay/blockchain's escrow codec/builder. Nothing here signs; spends are
 * evaluated by Blockfrost before they are ever shown to the user (a failing script is a
 * build error, so Plutus collateral is never put at risk by a known-bad transaction).
 */
import type { Broadcaster, CanonicalTransactionPayload, NetworkId } from "@zyropay/shared";
import { parseAssetId, parseBaseUnits, payloadHash } from "@zyropay/shared";
import type { CardanoValue, HttpOptions } from "@zyropay/blockchain";
import {
  BlockfrostClient,
  cardanoPosixMsToSlot,
  cardanoSlotToPosixMs,
  ChainError,
  createCardanoEscrowBuilder,
  masumiEscrowAddress,
  verifyCardanoEscrowSpend,
} from "@zyropay/blockchain";
import { masumiEscrowTermsOf, masumiEscrowView } from "@zyropay/integrations";
import type { EscrowChain, EscrowOnChain, EscrowRead, EscrowRef, EscrowSpendInput } from "./chain";

/** Spends of one escrow ZyroPay follows before giving up (request, authorize, ...). */
const MAX_HOPS = 6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** CardanoValue of an EscrowOnChain (lovelace + tokens). */
function escrowValue(utxo: Pick<EscrowOnChain, "lovelace" | "assets">): CardanoValue {
  return {
    coin: BigInt(utxo.lovelace),
    assets: new Map(Object.entries(utxo.assets).map(([unit, q]) => [unit, BigInt(q)])),
  };
}

function parseOutput(txHash: string, out: Record<string, unknown>): EscrowOnChain | null {
  if (typeof out.address !== "string" || !Array.isArray(out.amount)) return null;
  let lovelace = "0";
  const assets: Record<string, string> = {};
  for (const a of out.amount as unknown[]) {
    if (!isRecord(a) || typeof a.unit !== "string" || typeof a.quantity !== "string") return null;
    if (!/^[0-9]+$/.test(a.quantity)) return null;
    if (a.unit === "lovelace") lovelace = a.quantity;
    else assets[a.unit] = a.quantity;
  }
  if (typeof out.inline_datum !== "string") return null;
  return {
    txHash,
    index: Number(out.output_index),
    address: out.address,
    lovelace,
    assets,
    inlineDatum: out.inline_datum.toLowerCase(),
  };
}

export function createRealEscrowChain(input: {
  network: NetworkId;
  blockfrostProjectId: string;
  broadcaster: Broadcaster;
  http?: HttpOptions;
  now?: () => Date;
}): EscrowChain {
  const { network, broadcaster } = input;
  const http = input.http ?? {};
  const client = new BlockfrostClient({ ...http, projectId: input.blockfrostProjectId, network });
  const builder = createCardanoEscrowBuilder({
    ...http,
    blockfrostProjectId: input.blockfrostProjectId,
    network,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  const escrowAddress = masumiEscrowAddress(network);

  async function txOutputs(txHash: string): Promise<Record<string, unknown>[] | null> {
    const tx = await client.getOrNull(`/txs/${txHash}/utxos`, "txs/utxos");
    if (tx === null) return null;
    if (!isRecord(tx) || !Array.isArray(tx.outputs))
      throw new ChainError("UPSTREAM_UNAVAILABLE", "txs/utxos: malformed");
    return (tx.outputs as unknown[]).filter(isRecord);
  }

  const toEscrowUtxo = (utxo: EscrowOnChain) => ({
    txHash: utxo.txHash,
    index: utxo.index,
    address: utxo.address,
    value: escrowValue(utxo),
  });

  return {
    network,
    escrowAddress,

    async coinsPerUtxoByte() {
      return (await client.protocolParams()).coinsPerUtxoByte;
    },

    slotOf: (ms, rounding) => cardanoPosixMsToSlot(network, ms, rounding),
    posixOf: (slot) => cardanoSlotToPosixMs(network, slot),

    async tipSlot() {
      return (await client.tip()).slot;
    },

    async buildLock(payload: CanonicalTransactionPayload, options) {
      const escrow = masumiEscrowTermsOf(payload.pluginData);
      if (escrow === null) throw new ChainError("VALIDATION_FAILED", "not a masumi payload");
      if (payload.to !== escrowAddress || escrow.escrowAddress !== escrowAddress)
        throw new ChainError("VALIDATION_FAILED", "the payload does not pay the escrow");
      const token = parseAssetId(payload.asset.id).tokenAddress;
      const plan = await builder.buildLock({
        from: payload.from,
        lovelace: BigInt(escrow.lockedLovelace),
        ...(token !== null
          ? { assets: new Map([[token.toLowerCase(), parseBaseUnits(payload.amount)]]) }
          : {}),
        datumCbor: escrow.datumCbor,
        payByTimeMs: BigInt(escrow.payByTime),
        feeCap: parseBaseUnits(payload.feeCap),
        maxValiditySeconds: options.maxValiditySeconds,
      });
      return {
        family: "cardano",
        network,
        payloadHash: payloadHash(payload),
        encoding: "hex",
        serialized: plan.serialized,
        estimatedFee: plan.fee.toString(),
        validUntil: new Date(Number(cardanoSlotToPosixMs(network, plan.ttlSlot))).toISOString(),
        simulated: false,
        bodyHash: plan.bodyHash,
        ttlSlot: plan.ttlSlot.toString(),
        escrowLockedLovelace: escrow.lockedLovelace,
      };
    },

    async read(ref: EscrowRef, hint): Promise<EscrowRead> {
      let current = ref;
      for (let hop = 0; hop < MAX_HOPS; hop++) {
        const outputs = await txOutputs(current.txHash);
        if (outputs === null) return { status: "missing" };
        const out = outputs.find((o) => Number(o.output_index) === current.index);
        if (out === undefined) return { status: "missing" };
        const consumedBy = out.consumed_by_tx;
        if (typeof consumedBy !== "string") {
          const utxo = parseOutput(current.txHash, out);
          if (utxo === null || utxo.address !== escrowAddress)
            throw new ChainError("VALIDATION_FAILED", "the escrow output is not at the escrow");
          return { status: "unspent", utxo };
        }
        // Follow the continuing output: at the escrow, same reference_signature.
        const next = await txOutputs(consumedBy);
        const continuation = (next ?? []).find((o) => {
          if (o.address !== escrowAddress || typeof o.inline_datum !== "string") return false;
          return masumiEscrowView(o.inline_datum)?.referenceSignature === hint.referenceSignature;
        });
        if (continuation === undefined) return { status: "spent", spentBy: consumedBy };
        current = { txHash: consumedBy, index: Number(continuation.output_index) };
      }
      throw new ChainError("UPSTREAM_UNAVAILABLE", "the escrow moved too many times to follow");
    },

    async buildSpend(spend: EscrowSpendInput) {
      const plan = await builder.buildSpend({
        action: spend.action,
        from: spend.from,
        escrow: toEscrowUtxo(spend.utxo),
        ...(spend.continuingDatumCbor !== undefined
          ? { continuingDatumCbor: spend.continuingDatumCbor }
          : {}),
        validityStartSlot: spend.validityStartSlot,
        ttlSlot: spend.ttlSlot,
        feeCap: spend.feeCap,
      });
      return { serialized: plan.serialized, bodyHash: plan.bodyHash, fee: plan.fee.toString() };
    },

    async verifySpend(serialized, spend) {
      // Fresh parameters: this is the independent check before the user signs / we submit.
      const params = await client.scriptProtocolParams({ fresh: true });
      return verifyCardanoEscrowSpend(serialized, {
        network,
        action: spend.action,
        from: spend.from,
        escrow: toEscrowUtxo(spend.utxo),
        ...(spend.continuingDatumCbor !== undefined
          ? { continuingDatumCbor: spend.continuingDatumCbor }
          : {}),
        plutusV3CostModel: params.plutusV3CostModel,
        collateralPercent: params.collateralPercent,
        validityStartSlot: spend.validityStartSlot,
        ttlSlot: spend.ttlSlot,
        feeCap: spend.feeCap,
      });
    },

    async submit(signedTransaction) {
      const result = await broadcaster.broadcast({
        network,
        signedTransaction,
        encoding: "hex",
      });
      return { txHash: result.txHash };
    },
  };
}
