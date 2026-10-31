import {
  addressesEqual,
  chainFamilyOf,
  compareBaseUnits,
  isChecksummedEvmAddress,
  isTestnet,
  isValidAddressForNetwork,
  MoneyError,
  toBaseUnits,
  type Balance,
  type Transaction,
  type TransactionRequestResult,
  type TxRequestState,
} from "@zyropay/shared";

/*
 * Pure validation for the send flow (unit-tested). The API re-validates
 * everything; these checks exist so the user sees problems before signing.
 */

export type RecipientCheck =
  | { readonly ok: true; readonly warning: string | null }
  | { readonly ok: false; readonly error: string };

export function checkRecipient(balance: Balance, to: string): RecipientCheck {
  const address = to.trim();
  if (address === "") return { ok: false, error: "Enter an address." };
  if (!isValidAddressForNetwork(balance.network, address)) {
    const family = chainFamilyOf(balance.network);
    return {
      ok: false,
      error:
        family === "evm"
          ? "Not a valid EVM address. Check for typos: EVM addresses start with 0x and have 40 hex characters."
          : family === "cardano"
            ? cardanoAddressError(balance.network)
            : "Not a valid Solana address.",
    };
  }
  if (addressesEqual(chainFamilyOf(balance.network), address, balance.address)) {
    return { ok: false, error: "That's the address you're sending from." };
  }
  if (chainFamilyOf(balance.network) === "evm" && !isChecksummedEvmAddress(address)) {
    return {
      ok: true,
      warning:
        "This address has no checksum, so typos can't be detected. Double-check every character.",
    };
  }
  return { ok: true, warning: null };
}

function cardanoAddressError(network: Balance["network"]): string {
  return isTestnet(network)
    ? "Not a valid Cardano test-network address. It must start with addr_test1 (stake, script and Byron addresses are not supported)."
    : "Not a valid Cardano address. It must start with addr1 (stake, script and Byron addresses are not supported).";
}

export type AmountCheck =
  | { readonly ok: true; readonly baseUnits: string }
  | { readonly ok: false; readonly error: string | null };

export function checkAmount(balance: Balance, human: string): AmountCheck {
  if (human === "" || human === ".") return { ok: false, error: null };
  let baseUnits: string;
  try {
    baseUnits = toBaseUnits(human, balance.asset.decimals);
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof MoneyError
          ? `Use at most ${String(balance.asset.decimals)} decimal places.`
          : "Invalid amount.",
    };
  }
  if (compareBaseUnits(baseUnits, "0") === 0) return { ok: false, error: null };
  if (compareBaseUnits(baseUnits, balance.amount) > 0)
    return { ok: false, error: `More than your ${balance.asset.symbol} balance.` };
  return { ok: true, baseUnits };
}

/**
 * Where a submitted send stands. The submit answer stops at BROADCAST; after that the chain
 * transaction it produced (GET /v1/transactions, matched by hash and, when set, request id)
 * says whether it CONFIRMED or FAILED. Simulated results and final states are returned as is.
 */
export function sendProgress(
  result: TransactionRequestResult,
  transactions: readonly Transaction[] | undefined,
): TxRequestState {
  if (!needsChainFollow(result) || !transactions) return result.state;
  const tx = transactions.find(
    (t) =>
      t.txHash === result.txHash &&
      t.direction !== "in" &&
      (t.transactionRequestId === null || t.transactionRequestId === result.requestId),
  );
  if (tx?.status === "confirmed") return "CONFIRMED";
  if (tx?.status === "failed") return "FAILED";
  return result.state;
}

/** A real, broadcast send whose outcome only the chain can tell. */
export function needsChainFollow(result: TransactionRequestResult): boolean {
  return (
    !result.simulated &&
    result.txHash !== null &&
    result.state !== "CONFIRMED" &&
    result.state !== "FAILED"
  );
}
