import {
  getNetwork,
  isValidAddressForNetwork,
  networksOfFamily,
  WalletNameSchema,
  type ChainFamily,
  type NetworkId,
  type Wallet,
} from "@zyropay/shared";

/*
 * Pure helpers for the Wallets tab and the "Add wallet" flow. Every chain list
 * is derived from the shared network registry (filtered to the build's mode),
 * so a network added there (e.g. Cardano) appears here without UI changes.
 */

/**
 * What a QR or a paste may contain: a bare address, or a payment URI such as
 * `solana:<addr>?amount=1`, `ethereum:<addr>@84532/transfer`, `web+cardano:<addr>`.
 * Returns the address part, trimmed. Validation happens separately.
 */
export function parseScannedAddress(raw: string): string {
  let text = raw.trim();
  const scheme = /^(?:web\+)?[a-z][a-z0-9+.-]*:(?!\/\/)/i.exec(text);
  if (scheme) text = text.slice(scheme[0].length);
  if (text.startsWith("pay-")) text = text.slice(4);
  return text.split(/[?@/#]/)[0]?.trim() ?? "";
}

export type AddressCheck =
  { readonly ok: true; readonly address: string } | { readonly ok: false; readonly error: string };

/** Validate a watch address for a network with the shared helpers (never a regex of our own). */
export function checkWatchAddress(network: NetworkId, raw: string): AddressCheck {
  const address = parseScannedAddress(raw);
  if (address === "") return { ok: false, error: "Enter an address." };
  if (!isValidAddressForNetwork(network, address)) {
    return {
      ok: false,
      error: `That isn't a valid ${getNetwork(network).displayName} address. Check the network and try again.`,
    };
  }
  return { ok: true, address };
}

/** Validate an optional wallet name with the shared schema; "" means "use the default". */
export function checkWalletName(
  raw: string,
): { ok: true; name?: string } | { ok: false; error: string } {
  if (raw.trim() === "") return { ok: true };
  const parsed = WalletNameSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, name: parsed.data }
    : { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid name" };
}

/** Default name for a new wallet on a chain, e.g. "Base wallet" (testnet suffix dropped). */
export function defaultWalletName(network: NetworkId): string {
  const base = getNetwork(network).displayName.replace(
    / (Devnet|Sepolia|Testnet|Preprod|Preview)$/,
    "",
  );
  return `${base} wallet`;
}

/** Networks in `modeNetworks` that share an address with `network` (one EVM key serves every EVM chain). */
export function siblingNetworks(
  network: NetworkId,
  modeNetworks: readonly NetworkId[],
): NetworkId[] {
  const family = getNetwork(network).family;
  return networksOfFamily(family).filter((n) => n !== network && modeNetworks.includes(n));
}

/** The networks of `modeNetworks` that a wallet actually has an account for. */
export function walletNetworks(
  wallet: Pick<Wallet, "addresses">,
  modeNetworks: readonly NetworkId[],
): NetworkId[] {
  const families = new Set<ChainFamily>(wallet.addresses.map((a) => a.family));
  return modeNetworks.filter((n) => families.has(getNetwork(n).family));
}

/**
 * ADR-002: a multi-chain wallet from before Cardano support (the sign-up "Main wallet":
 * Solana + EVM) has no Cardano key yet; the user's passkey can add one to it. A wallet
 * made in the "Add wallet" flow holds exactly the one family the user picked, so it
 * never needs (or gets) a Cardano account added.
 */
export function needsCardanoAccount(
  wallet: Pick<Wallet, "addresses">,
  modeNetworks: readonly NetworkId[],
): boolean {
  const families = new Set<ChainFamily>(wallet.addresses.map((a) => a.family));
  return (
    families.size > 1 &&
    !families.has("cardano") &&
    modeNetworks.some((n) => getNetwork(n).family === "cardano")
  );
}

/** Receive chains: the wallet's own, plus Cardano when `needsCardanoAccount` (to offer adding it). */
export function receiveNetworks(
  wallet: Pick<Wallet, "addresses">,
  modeNetworks: readonly NetworkId[],
): NetworkId[] {
  const own = walletNetworks(wallet, modeNetworks);
  if (!needsCardanoAccount(wallet, modeNetworks)) return own;
  return modeNetworks.filter((n) => own.includes(n) || getNetwork(n).family === "cardano");
}
