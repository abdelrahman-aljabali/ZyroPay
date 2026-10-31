/*
 * Chain access for the escrow side: Blockfrost reads the seller makes itself (tip, escrow
 * UTxO pages, a transaction's outputs, submission) plus the Evolution client used to load
 * UTxOs and build spends. Blockfrost OpenAPI shapes: block_content, address_utxo_content,
 * tx_content_utxo; POST /tx/submit takes application/cbor and returns the tx id as JSON.
 */
import type { UTxO } from "@evolution-sdk/evolution";
import {
  Address,
  Client,
  preprod,
  PrivateKey,
  TransactionHash,
  TransactionInput,
} from "@evolution-sdk/evolution";

const TIMEOUT_MS = 8_000;
const PAGE_SIZE = 100;

export interface BfAmountRow {
  readonly unit: string;
  readonly quantity: string;
}

/** GET /addresses/{a}/utxos element (fields used here). */
export interface BfUtxoRow {
  readonly tx_hash: string;
  readonly output_index: number;
  readonly amount: readonly BfAmountRow[];
  readonly inline_datum: string | null;
  readonly reference_script_hash: string | null;
}

/** GET /txs/{hash}/utxos outputs element (fields used here). */
export interface BfTxOutputRow {
  readonly address: string;
  readonly output_index: number;
  readonly amount: readonly BfAmountRow[];
  readonly inline_datum: string | null;
  readonly collateral: boolean;
  readonly consumed_by_tx?: string | null;
}

class ChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainError";
  }
}

export const lovelaceOf = (amount: readonly BfAmountRow[]): bigint => {
  const q = amount.find((a) => a.unit === "lovelace")?.quantity;
  return q !== undefined && /^[0-9]+$/.test(q) ? BigInt(q) : 0n;
};

export class EscrowChain {
  constructor(
    readonly baseUrl: string,
    private readonly projectId: string,
  ) {}

  private async request(
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: Uint8Array<ArrayBuffer>;
    } = {},
  ): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { project_id: this.projectId, accept: "application/json", ...init.headers },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ChainError("Blockfrost unreachable");
    }
  }

  /** JSON body; null on 404; ChainError otherwise. */
  private async get<T>(path: string): Promise<T | null> {
    const res = await this.request(path);
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new ChainError(`Blockfrost ${path.split("?")[0]} returned ${res.status}`);
    }
    return res.json<T>();
  }

  /** Chain time of the latest block (validity windows come from it, not the local clock). */
  async tipMs(): Promise<bigint> {
    const block = await this.get<{ time: number }>("/blocks/latest");
    if (block === null || !Number.isInteger(block.time)) throw new ChainError("no chain tip");
    return BigInt(block.time) * 1000n;
  }

  /** Unspent outputs at `address`, newest first (one page of 100). */
  async addressUtxos(address: string, page: number): Promise<BfUtxoRow[]> {
    const a = encodeURIComponent(address);
    return (
      (await this.get<BfUtxoRow[]>(
        `/addresses/${a}/utxos?order=desc&count=${PAGE_SIZE}&page=${page}`,
      )) ?? []
    );
  }

  /** A transaction's outputs, or null while it is unknown (not yet on chain). */
  async txOutputs(txHash: string): Promise<BfTxOutputRow[] | null> {
    const body = await this.get<{ outputs: BfTxOutputRow[] }>(`/txs/${txHash}/utxos`);
    return body?.outputs ?? null;
  }

  /** Submits a signed transaction; returns its id. */
  async submit(cborHex: string): Promise<string> {
    const res = await this.request("/tx/submit", {
      method: "POST",
      headers: { "content-type": "application/cbor" },
      body: Uint8Array.from(cborHex.match(/../g) ?? [], (b) => parseInt(b, 16)),
    });
    const text = await res.text();
    if (!res.ok)
      throw new ChainError(`submit rejected (HTTP ${res.status}): ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text) as string;
    } catch {
      return text;
    }
  }
}

/** Evolution client on preprod Blockfrost, holding the seller key (used to build spends). */
export function sellerClient(
  baseUrl: string,
  projectId: string,
  privateKey: PrivateKey.PrivateKey,
): Client.SigningClient {
  return Client.make(preprod)
    .withBlockfrost({ baseUrl, projectId })
    .withPrivateKey({ paymentKey: PrivateKey.toBech32(privateKey), addressType: "Enterprise" });
}

/** One escrow UTxO as Evolution models it (address, assets, inline datum). */
export async function loadEscrowUtxo(
  client: Client.SigningClient,
  txHash: string,
  index: number,
): Promise<UTxO.UTxO> {
  const [utxo] = await client.getUtxosByOutRef([
    new TransactionInput.TransactionInput({
      transactionId: TransactionHash.fromHex(txHash),
      index: BigInt(index),
    }),
  ]);
  if (utxo === undefined) throw new ChainError(`escrow UTxO ${txHash}#${index} not found`);
  return utxo;
}

/** The seller wallet's UTxOs, minus any carrying a reference script. */
export async function walletUtxos(
  client: Client.SigningClient,
  address: string,
): Promise<UTxO.UTxO[]> {
  const all = await client.getUtxos(Address.fromBech32(address));
  return all.filter((u) => u.scriptRef === undefined);
}
