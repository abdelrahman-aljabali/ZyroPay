import {
  allowanceAppliedScript,
  CARDANO_SLOT_CONFIG,
  cardanoAddressBytes,
  cardanoPaymentKeyHash,
  cardanoUnsignedBodyHash,
  encodeAllowanceDatumHex,
  type AllowanceDatumView,
} from "@zyropay/shared";

/*
 * DEV MOCK: real (unsigned, canonical CBOR) Cardano transactions for the simulated allowance,
 * so the app's on-device checks (checkCardanoAllowanceCreateTx / ...OwnerSpendTx) decode and
 * verify them exactly as they do a real API's. Inputs are made-up UTxOs and the script data
 * hash is a placeholder: nothing here is ever submitted.
 */

type Cbor =
  | { readonly u: bigint }
  | { readonly b: Uint8Array }
  | { readonly a: readonly Cbor[] }
  | { readonly m: readonly (readonly [Cbor, Cbor])[] }
  | { readonly t: number; readonly v: Cbor }
  | { readonly raw: Uint8Array }
  | { readonly s: boolean | null };

function head(major: number, n: bigint): number[] {
  const m = major << 5;
  if (n < 24n) return [m | Number(n)];
  for (const [ai, len] of [
    [24, 1],
    [25, 2],
    [26, 4],
    [27, 8],
  ] as const) {
    if (n < 1n << BigInt(8 * len)) {
      const out = [m | ai];
      for (let i = len - 1; i >= 0; i--) out.push(Number((n >> BigInt(8 * i)) & 0xffn));
      return out;
    }
  }
  throw new Error("CBOR integer out of range");
}

function enc(c: Cbor): number[] {
  if ("u" in c) return head(0, c.u);
  if ("b" in c) return [...head(2, BigInt(c.b.length)), ...c.b];
  if ("a" in c) return [...head(4, BigInt(c.a.length)), ...c.a.flatMap(enc)];
  if ("m" in c) {
    // Canonical: keys sorted by encoded length, then bytewise.
    const pairs = c.m.map(([k, v]) => [enc(k), enc(v)] as const);
    pairs.sort(([x], [y]) => {
      if (x.length !== y.length) return x.length - y.length;
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
      return 0;
    });
    return [...head(5, BigInt(pairs.length)), ...pairs.flatMap(([k, v]) => [...k, ...v])];
  }
  if ("t" in c) return [...head(6, BigInt(c.t)), ...enc(c.v)];
  if ("raw" in c) return [...c.raw];
  return [c.s === null ? 0xf6 : c.s ? 0xf5 : 0xf4];
}

const hex = (bytes: readonly number[] | Uint8Array) =>
  [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

const u = (n: bigint | number): Cbor => ({ u: BigInt(n) });
const set = (items: Cbor[]): Cbor => ({ t: 258, v: { a: items } });
const addr = (a: string): Cbor => ({ b: cardanoAddressBytes(a) });
const plainOut = (a: string, lovelace: bigint): Cbor => ({ a: [addr(a), u(lovelace)] });

function slotAt(ms: number): bigint {
  const c = CARDANO_SLOT_CONFIG["cardano-preprod"];
  if (c === undefined) throw new Error("no preprod slot config");
  return BigInt(Math.floor((ms - c.zeroTimeMs) / c.slotLengthMs) + c.zeroSlot);
}

/** Slot-aligned ISO time (what a real validity window shows). */
export function slotAlignedIso(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString();
}

export interface MockTx {
  readonly hex: string;
  readonly bodyHash: string;
}

function finish(body: Cbor, witnesses: Cbor): MockTx {
  const h = hex(enc({ a: [body, witnesses, { s: true }, { s: null }] }));
  return { hex: h, bodyHash: cardanoUnsignedBodyHash(h) ?? "" };
}

function input(utxo: string): Cbor {
  const [txHash = "", index = "0"] = utxo.split("#");
  return { a: [{ b: fromHex(txHash) }, u(Number(index))] };
}

/** Allowance create: lock + agent float + change, body keys {0,1,2,3}, no witnesses. */
export function mockCreateTx(e: {
  readonly fundingUtxo: string;
  readonly owner: string;
  readonly script: string;
  readonly agent: string;
  readonly allowanceLovelace: bigint;
  readonly floatLovelace: bigint;
  readonly changeLovelace: bigint;
  readonly datum: AllowanceDatumView;
  readonly fee: bigint;
  readonly ttlMs: number;
}): MockTx {
  const lock: Cbor = {
    m: [
      [u(0), addr(e.script)],
      [u(1), u(e.allowanceLovelace)],
      [u(2), { a: [u(1), { t: 24, v: { b: fromHex(encodeAllowanceDatumHex(e.datum)) } }] }],
    ],
  };
  const body: Cbor = {
    m: [
      [u(0), set([input(e.fundingUtxo)])],
      [
        u(1),
        {
          a: [
            lock,
            plainOut(e.agent, e.floatLovelace),
            ...(e.changeLovelace > 0n ? [plainOut(e.owner, e.changeLovelace)] : []),
          ],
        },
      ],
      [u(2), u(e.fee)],
      [u(3), u(slotAt(e.ttlMs))],
    ],
  };
  return finish(body, { m: [] });
}

/** Owner spend of the allowance (top-up continues it, revoke empties it to the owner). */
export function mockOwnerSpendTx(e: {
  readonly utxo: string;
  /** Extra wallet input (top-up funds); also the collateral. */
  readonly walletUtxo: string;
  readonly owner: string;
  readonly script: string;
  /** top_up: what the allowance keeps; null for revoke. */
  readonly cont: { readonly lovelace: bigint; readonly datum: AllowanceDatumView } | null;
  /** revoke: everything to the owner; top_up: change to the owner. */
  readonly ownerLovelace: bigint;
  readonly fee: bigint;
  readonly validFromMs: number;
  readonly validUntilMs: number;
}): MockTx {
  const ownerKh = cardanoPaymentKeyHash(e.owner) ?? "";
  const inputs = [e.utxo, e.walletUtxo].sort();
  const at = inputs.indexOf(e.utxo);
  const outputs: Cbor[] = [];
  if (e.cont !== null)
    outputs.push({
      m: [
        [u(0), addr(e.script)],
        [u(1), u(e.cont.lovelace)],
        [u(2), { a: [u(1), { t: 24, v: { b: fromHex(encodeAllowanceDatumHex(e.cont.datum)) } }] }],
      ],
    });
  outputs.push(plainOut(e.owner, e.ownerLovelace));
  const collateral = 5_000_000n;
  const body: Cbor = {
    m: [
      [u(0), set(inputs.map(input))],
      [u(1), { a: outputs }],
      [u(2), u(e.fee)],
      [u(3), u(slotAt(e.validUntilMs))],
      [u(8), u(slotAt(e.validFromMs))],
      [u(11), { b: new Uint8Array(32).fill(0x5d) }],
      [u(13), set([input(e.walletUtxo)])],
      [u(14), set([{ b: fromHex(ownerKh) }])],
      [u(16), plainOut(e.owner, collateral - (e.fee * 3n) / 2n)],
      [u(17), u((e.fee * 3n) / 2n)],
    ],
  };
  const witnesses: Cbor = {
    m: [
      [
        u(5),
        {
          m: [
            [
              { a: [u(0), u(at)] },
              { a: [{ raw: fromHex("d87a80") }, { a: [u(14_000), u(5_000_000)] }] },
            ],
          ],
        },
      ],
      [u(7), set([{ b: allowanceAppliedScript(ownerKh) }])],
    ],
  };
  return finish(body, witnesses);
}
