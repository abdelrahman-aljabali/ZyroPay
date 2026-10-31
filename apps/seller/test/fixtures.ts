/*
 * Blockfrost FIXTURES: synthetic data in the documented response shapes
 * (https://docs.blockfrost.io; OpenAPI schemas named in each file's `_shape`).
 * Not real chain data. Fixed clock for every test that uses them.
 */
import account from "./fixtures/blockfrost-account.fixture.json";
import address from "./fixtures/blockfrost-address.fixture.json";
import notFound from "./fixtures/blockfrost-404.fixture.json";
import total from "./fixtures/blockfrost-address-total.fixture.json";
import txsAsc from "./fixtures/blockfrost-address-transactions-asc.fixture.json";
import txsDesc from "./fixtures/blockfrost-address-transactions-desc.fixture.json";
import utxos from "./fixtures/blockfrost-address-utxos.fixture.json";
import type {
  AddressData,
  BfAccount,
  BfAddress,
  BfAddressTotal,
  BfAddressTx,
  BfUtxo,
} from "../src/blockfrost";
import type { Route } from "./helpers";
import { BLOCKFROST, json, TEST_BASE_ADDRESS, TEST_STAKE_ADDRESS } from "./helpers";

/** 2026-10-30T12:00:00Z: the fixtures' timestamps are relative to this. */
export const FIXTURE_NOW = new Date("2026-10-30T12:00:00Z");

export const fx = {
  address: address.body as BfAddress,
  total: total.body as BfAddressTotal,
  txsDesc: txsDesc.body as BfAddressTx[],
  txsAsc: txsAsc.body as BfAddressTx[],
  utxos: utxos.body as BfUtxo[],
  account: account.body as BfAccount,
  notFound: notFound.body,
};

/** The AddressData BlockfrostClient assembles from the fixtures. */
export const ACTIVE_DATA: AddressData = {
  address: fx.address,
  total: fx.total,
  recentTxs: fx.txsDesc,
  firstTx: fx.txsAsc[0]!,
  utxos: fx.utxos,
  account: fx.account,
};

export const UNUSED_DATA: AddressData = {
  address: null,
  total: null,
  recentTxs: [],
  firstTx: null,
  utxos: [],
  account: null,
};

/** fetch routes serving the fixtures for TEST_BASE_ADDRESS (exact Blockfrost paths). */
export function blockfrostRoutes(): Record<string, Route> {
  const a = `${BLOCKFROST}/addresses/${TEST_BASE_ADDRESS}`;
  return {
    [a]: () => json(fx.address),
    [`${a}/total`]: () => json(fx.total),
    [`${a}/transactions?order=desc&count=20`]: () => json(fx.txsDesc),
    [`${a}/transactions?order=asc&count=1`]: () => json(fx.txsAsc),
    [`${a}/utxos?count=100`]: () => json(fx.utxos),
    [`${BLOCKFROST}/accounts/${TEST_STAKE_ADDRESS}`]: () => json(fx.account),
  };
}
