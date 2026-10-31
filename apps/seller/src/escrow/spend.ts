/*
 * Seller-side Masumi escrow spends (SubmitResult, Withdraw, AuthorizeRefund), built with the
 * Evolution SDK the way the x402-cardano-demo Masumi agent does (masumi/src/chain.ts
 * submitResult / withdraw), signed here with SELLER_SIGNING_KEY. Building evaluates the
 * script (Blockfrost /utils/txs/evaluate/utxos) before anything is signed, so a spend the
 * validator would reject throws instead of risking the Plutus collateral.
 *
 * Every spend: the escrow input with its redeemer, the applied vested_pay v2 script inline
 * (no reference-script UTxO exists), the seller as required signer, a finite validity window
 * (the validator requires a finite upper bound), seller wallet UTxOs for the fee and the
 * Plutus collateral, change back to the seller. Nothing here submits.
 */
import type { MasumiDatumView } from "@x402/cardano";
import { MASUMI_DEFAULT_DEPLOYMENT } from "@x402/cardano";
import {
  Address,
  Assets,
  Data,
  InlineDatum,
  KeyHash,
  PlutusV3,
  PrivateKey,
  ScriptHash,
  SlotConfig,
  Time,
  Transaction,
  TransactionHash,
  TransactionWitnessSet,
  VKey,
} from "@evolution-sdk/evolution";
import type { Client, UTxO } from "@evolution-sdk/evolution";
import type { SellerKey } from "../receipt";
import type { SellerAction } from "./datum";
import { VESTED_PAY_V2_APPLIED_HEX } from "./script";
import { authorizeRefundDatum, ESCROW_STATE, sellerRedeemer, submitResultDatum } from "./datum";

const SLOT = SlotConfig.SLOT_CONFIG_NETWORK.Preprod;
/** vested_pay cooldown_period on the canonical deployment: 420 000 ms. */
export const COOLDOWN_MS = BigInt(MASUMI_DEFAULT_DEPLOYMENT.cooldownPeriod);
/** Validity windows: lower bound a minute behind the tip, upper bound 5 minutes ahead. */
const LOWER_SLACK_MS = 60_000n;
const UPPER_SPAN_MS = 300_000n;
/** SubmitResult's upper bound must sit before submit_result_time; keep this much margin. */
const SUBMIT_MARGIN_MS = 120_000n;
/** Leave at least this much window, or the spend is not attempted. */
const MIN_WINDOW_MS = 30_000n;

/** The POSIX time the ledger shows scripts for a validity bound: the start of its slot. */
export const slotStartMs = (ms: bigint): bigint =>
  Time.slotToUnixTime(Time.unixTimeToSlot(ms, SLOT), SLOT);
/** The first slot start at or after `ms` (lower bounds that must clear a deadline). */
export const ceilToSlotMs = (ms: bigint): bigint =>
  slotStartMs(ms) === ms ? ms : slotStartMs(ms) + BigInt(SLOT.slotLength);

const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

let script: PlutusV3.PlutusV3 | null = null;
/** The applied vested_pay v2 script (10003 bytes; hash a15ce9d8…, the escrow credential). */
function escrowScript(): PlutusV3.PlutusV3 {
  script ??= new PlutusV3.PlutusV3({ bytes: hexBytes(VESTED_PAY_V2_APPLIED_HEX) });
  return script;
}
export const escrowScriptHash = (): string =>
  ScriptHash.toHex(ScriptHash.fromScript(escrowScript()));

export type SpendWindow = { readonly from: bigint; readonly to: bigint };

/** Validity window for an action at chain time `tipMs`, or a reason it cannot run now. */
export function spendWindow(
  action: SellerAction,
  view: MasumiDatumView,
  tipMs: bigint,
): SpendWindow | string {
  let from: bigint;
  let to = tipMs + UPPER_SPAN_MS;
  switch (action) {
    case "SubmitResult":
      from = max(tipMs - LOWER_SLACK_MS, ceilToSlotMs(view.sellerCooldownTime));
      to = min(to, view.submitResultTime - SUBMIT_MARGIN_MS);
      break;
    case "AuthorizeRefund":
      from = max(tipMs - LOWER_SLACK_MS, ceilToSlotMs(view.sellerCooldownTime));
      break;
    case "Withdraw":
      from =
        view.state === ESCROW_STATE.WithdrawAuthorized
          ? tipMs - LOWER_SLACK_MS
          : ceilToSlotMs(view.unlockTime);
      break;
  }
  if (from > tipMs) return "too early (cooldown or unlock time not reached)";
  if (to - tipMs < MIN_WINDOW_MS || to <= from) return "the window for this action has closed";
  return { from, to };
}

/** A datum address back as a ledger address (payment + optional stake credential). */
function datumAddress(a: MasumiDatumView["buyer"], networkId: number): Address.Address {
  if (a.pointer) throw new Error("pointer stake addresses are not supported");
  const cred = (c: { isScript: boolean; hash: string }) =>
    c.isScript ? ScriptHash.fromHex(c.hash) : KeyHash.fromHex(c.hash);
  return new Address.Address({
    networkId,
    paymentCredential: cred(a.payment),
    ...(a.stake ? { stakingCredential: cred(a.stake) } : {}),
  });
}

/** The seller: its payTo address and payment key (see loadSellerKey). */
export type SpendSeller = SellerKey & { readonly address: string };

export interface SpendInput {
  readonly client: Client.SigningClient;
  readonly seller: SpendSeller;
  readonly action: SellerAction;
  /** The escrow UTxO (with its inline datum), as Evolution loaded it. */
  readonly escrow: UTxO.UTxO;
  readonly view: MasumiDatumView;
  /** Seller wallet UTxOs available for the fee and the Plutus collateral. */
  readonly walletUtxos: readonly UTxO.UTxO[];
  readonly tipMs: bigint;
  /** SubmitResult only: the result hash (hex) to put on chain. */
  readonly resultHash?: string;
}

export interface SignedSpend {
  readonly action: SellerAction;
  readonly txHash: string;
  /** Signed transaction CBOR, hex. */
  readonly cbor: string;
  readonly window: SpendWindow;
  /** The new seller_cooldown_time (SubmitResult / AuthorizeRefund). */
  readonly sellerCooldownTime?: bigint;
  /** Wallet UTxOs after this transaction (for chaining a second spend in the same run). */
  readonly available: readonly UTxO.UTxO[];
}

/** Builds (and evaluates) one seller spend and signs it with the seller key. */
export async function buildSellerSpend(input: SpendInput): Promise<SignedSpend> {
  const { view, escrow, seller, action } = input;
  if (view.seller.payment.isScript || view.seller.payment.hash !== seller.keyHash)
    throw new Error("this escrow does not name this seller");
  if (!(escrow.datumOption instanceof InlineDatum.InlineDatum))
    throw new Error("escrow UTxO has no inline datum");
  if (view.sellerReturnAddress !== null)
    throw new Error("escrows with a seller_return_address are not supported");
  const window = spendWindow(action, view, input.tipMs);
  if (typeof window === "string") throw new Error(window);
  const sellerAddress = Address.fromBech32(seller.address);

  let tx = input.client
    .newTx()
    .collectFrom({ inputs: [escrow], redeemer: sellerRedeemer(action) })
    .attachScript({ script: escrowScript() })
    .addSigner({ keyHash: KeyHash.fromHex(seller.keyHash) })
    .setValidity({ from: window.from, to: window.to });

  let sellerCooldownTime: bigint | undefined;
  if (action === "SubmitResult" || action === "AuthorizeRefund") {
    sellerCooldownTime = slotStartMs(window.to) + COOLDOWN_MS;
    let datum: Data.Data;
    if (action === "SubmitResult") {
      if (input.resultHash === undefined) throw new Error("SubmitResult needs a result hash");
      datum = submitResultDatum(
        escrow.datumOption.data,
        view,
        input.resultHash,
        sellerCooldownTime,
      );
    } else {
      datum = authorizeRefundDatum(escrow.datumOption.data, sellerCooldownTime);
    }
    // Continuing output: same address, the input value exactly (>= per asset is the rule).
    tx = tx.payToAddress({
      address: escrow.address,
      assets: escrow.assets,
      datum: new InlineDatum.InlineDatum({ data: datum }),
    });
  } else if (view.collateralReturnLovelace > 0n) {
    // Withdraw: the buyer's collateral goes back tagged with the escrow's OutputReference.
    tx = tx.payToAddress({
      address: datumAddress(view.buyerReturnAddress ?? view.buyer, sellerAddress.networkId),
      assets: Assets.fromLovelace(view.collateralReturnLovelace),
      datum: new InlineDatum.InlineDatum({
        data: Data.constr(0n, [
          Data.bytearray(TransactionHash.toHex(escrow.transactionId)),
          Data.int(escrow.index),
        ]),
      }),
      autoMinUtxo: true,
    });
  }

  const built = await tx.build({
    changeAddress: sellerAddress,
    availableUtxos: [...input.walletUtxos],
  });
  const chain = built.chainResult();
  const unsigned = Transaction.toCBORHex(await built.toTransaction());
  const vkey = VKey.fromPrivateKey(seller.privateKey);
  const signature = PrivateKey.sign(seller.privateKey, hexBytes(chain.txHash));
  const witnesses = TransactionWitnessSet.fromVKeyWitnesses([
    new TransactionWitnessSet.VKeyWitness({ vkey, signature }),
  ]);
  const cbor = Transaction.addVKeyWitnessesHex(
    unsigned,
    TransactionWitnessSet.toCBORHex(witnesses),
  );
  return {
    action,
    txHash: chain.txHash,
    cbor,
    window,
    ...(sellerCooldownTime !== undefined ? { sellerCooldownTime } : {}),
    available: chain.available,
  };
}

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
}
