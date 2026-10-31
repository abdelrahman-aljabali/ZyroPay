/*
 * Real AllowanceChain (chain.ts) for one Cardano network: the agent allowance
 * (contracts/allowance, docs/AUTOPAY.md) over Blockfrost with @zyropay/blockchain's planners.
 * Script spends are measured by Blockfrost's evaluator (`measureAllowanceSpend`, exact units)
 * before they are returned, so a spend the validator would refuse is a build error and its
 * collateral is never put at risk. Nothing here signs.
 *
 * Workers CPU: the owner-applied script is a byte-level wrapper (no UPLC library), and each
 * build is one coin selection plus two or three evaluations done by Blockfrost, not here.
 */
import type { AllowanceDatumView, NetworkId } from "@zyropay/shared";
import type { AllowanceDatum, HttpOptions } from "@zyropay/blockchain";
import {
  BlockfrostClient,
  cardanoPosixMsToSlot,
  cardanoSlotToPosixMs,
  createCardanoAllowanceBuilder,
  planAllowanceFloatSweep,
} from "@zyropay/blockchain";
import type { AllowanceChain, AllowanceOnChain } from "./chain";

export function datumFromView(v: AllowanceDatumView): AllowanceDatum {
  return {
    agentKeyHash: v.agentKeyHash,
    perPaymentMax: BigInt(v.perPaymentMax),
    periodMs: BigInt(v.periodMs),
    periodCap: BigInt(v.periodCap),
    periodStart: BigInt(v.periodStart),
    spentInPeriod: BigInt(v.spentInPeriod),
    allowedPayees: v.allowedPayees.map((p) => ({ kind: p.kind, hash: p.hash })),
    expiresAt: BigInt(v.expiresAt),
  };
}

export function datumToView(d: AllowanceDatum): AllowanceDatumView {
  return {
    agentKeyHash: d.agentKeyHash,
    perPaymentMax: d.perPaymentMax.toString(),
    periodMs: d.periodMs.toString(),
    periodCap: d.periodCap.toString(),
    periodStart: d.periodStart.toString(),
    spentInPeriod: d.spentInPeriod.toString(),
    allowedPayees: d.allowedPayees.map((p) => ({ kind: p.kind, hash: p.hash })),
    expiresAt: d.expiresAt.toString(),
  };
}

const allowanceUtxo = (a: AllowanceOnChain) => ({
  txHash: a.txHash,
  index: a.index,
  value: { coin: a.lovelace, assets: new Map<string, bigint>() },
  datum: datumFromView(a.datum),
});

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function createRealAllowanceChain(input: {
  network: NetworkId;
  blockfrostProjectId: string;
  http?: HttpOptions;
}): AllowanceChain {
  const { network } = input;
  const http = input.http ?? {};
  const client = new BlockfrostClient({ ...http, projectId: input.blockfrostProjectId, network });
  const builder = createCardanoAllowanceBuilder({
    ...http,
    blockfrostProjectId: input.blockfrostProjectId,
    network,
  });
  const pureAda = (u: { amount: readonly { unit: string }[] }) =>
    u.amount.every((a) => a.unit === "lovelace");

  return {
    network,
    slotOf: (ms, rounding) => cardanoPosixMsToSlot(network, ms, rounding),
    posixOf: (slot) => cardanoSlotToPosixMs(network, slot),
    async tipSlot() {
      return (await client.tip()).slot;
    },
    async read(ownerKeyHash, agentKeyHash) {
      const all = await builder.readAllowances(ownerKeyHash);
      return all
        .filter((a) => a.datum.agentKeyHash === agentKeyHash && a.value.assets.size === 0)
        .map((a) => ({
          txHash: a.txHash,
          index: a.index,
          lovelace: a.value.coin,
          datum: datumToView(a.datum),
        }));
    },
    async adaBalance(address) {
      const utxos = await client.utxos(address);
      return utxos
        .filter((u) => pureAda(u) && u.reference_script_hash === null)
        .reduce((sum, u) => sum + BigInt(u.amount[0]?.quantity ?? "0"), 0n);
    },
    async buildCreate({ owner, lovelace, datum, float, ttlSlot }) {
      const plan = await builder.buildCreate({
        from: owner,
        lovelace,
        datum: datumFromView(datum),
        float,
        ttlSlot,
      });
      return { serialized: plan.serialized, fee: plan.fee };
    },
    async buildAgentPay(i) {
      const plan = await builder.buildAgentPay({
        ownerKeyHash: i.ownerKeyHash,
        allowance: allowanceUtxo(i.allowance),
        agent: i.agent,
        payee: i.payee,
        lovelace: i.lovelace,
        validityStartSlot: i.validityStartSlot,
        ttlSlot: i.ttlSlot,
      });
      return { serialized: plan.serialized, fee: plan.fee, nextDatum: datumToView(plan.nextDatum) };
    },
    async buildOwnerSpend(i) {
      const plan = await builder.buildOwnerSpend({
        owner: i.owner,
        allowance: allowanceUtxo(i.allowance),
        ...(i.continuing !== undefined
          ? {
              continuing: {
                lovelace: i.continuing.lovelace,
                datum: datumFromView(i.continuing.datum),
              },
            }
          : {}),
        validityStartSlot: i.validityStartSlot,
        ttlSlot: i.ttlSlot,
      });
      return { serialized: plan.serialized, fee: plan.fee };
    },
    async buildFloatSweep({ from, to, ttlSlot }) {
      const [params, utxos] = await Promise.all([client.protocolParams(), client.utxos(from)]);
      const plan = planAllowanceFloatSweep({ network, from, to, utxos, params, ttlSlot });
      return plan === null ? null : { serialized: plan.serialized, fee: plan.fee };
    },
    async submit(signedTransaction) {
      return { txHash: await client.submit(hexToBytes(signedTransaction)) };
    },
  };
}
