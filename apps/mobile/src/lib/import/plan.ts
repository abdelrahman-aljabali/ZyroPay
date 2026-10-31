import {
  cardanoEnterpriseAddress,
  getNetwork,
  normalizeAddress,
  type ChainFamily,
  type NetworkId,
} from "@zyropay/shared";
import { walletAccountParams } from "@/lib/turnkey/signer";

/*
 * ADR-003: which accounts an imported phrase gets, and how the result is checked.
 * Families come from the build's networks (shared registry, mode-filtered), so the
 * import offers exactly the chains this build can use; nothing is hard-coded.
 */

/** Every chain family ZyroPay supports can be derived from an imported phrase. */
export type ImportFamily = ChainFamily;

/** Chain families an imported phrase can derive, in the order of the build's networks. */
export function importFamilies(modeNetworks: readonly NetworkId[]): ImportFamily[] {
  const out: ImportFamily[] = [];
  for (const n of modeNetworks) {
    const f = getNetwork(n).family;
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

/** Networks of `family` in this build (one EVM address serves every EVM chain). */
export function familyNetworks(family: ChainFamily, modeNetworks: readonly NetworkId[]) {
  return modeNetworks.filter((n) => getNetwork(n).family === family);
}

/** Turnkey account specs for the chosen families (same paths as "Create new wallet"). */
export function importAccounts(families: readonly ImportFamily[]) {
  return families.map((f) => walletAccountParams(f));
}

/**
 * The network sent to POST /v1/wallets: the API requires the wallet to hold an account of
 * that network's family and then links every account of the wallet.
 */
export function registrationNetwork(
  families: readonly ChainFamily[],
  modeNetworks: readonly NetworkId[],
): NetworkId | null {
  for (const f of families) {
    const n = familyNetworks(f, modeNetworks)[0];
    if (n !== undefined) return n;
  }
  return null;
}

export interface FamilyCopy {
  readonly title: string;
  readonly path: string;
  /** Shown under the toggle; Cardano carries the honest ADR-002 note. */
  readonly note: string;
  readonly caution: boolean;
}

export function familyCopy(family: ImportFamily, modeNetworks: readonly NetworkId[]): FamilyCopy {
  const nets = familyNetworks(family, modeNetworks).map((n) => getNetwork(n).displayName);
  const path = walletAccountParams(family).path;
  switch (family) {
    case "solana":
      return {
        title: nets.join(", ") || "Solana",
        path,
        note: "Standard path, same address as Phantom and Solflare.",
        caution: false,
      };
    case "evm":
      return {
        title: nets.join(", ") || "EVM",
        path,
        note: "Standard path, same address as MetaMask. One address on every EVM chain.",
        caution: false,
      };
    case "cardano":
      return {
        title: nets.join(", ") || "Cardano",
        path,
        note: "ZyroPay's own Cardano derivation (ADR-002). This won't be the address Yoroi, Eternl or Daedalus shows for this phrase, so ADA held there won't appear here.",
        caution: true,
      };
  }
}

export interface ReportedAccount {
  readonly family: ChainFamily;
  /** Solana/EVM: the address. Cardano: Turnkey's compressed Ed25519 public key (hex). */
  readonly address: string;
}

export type ImportVerification =
  | { readonly ok: true; readonly addresses: readonly { family: ChainFamily; address: string }[] }
  | { readonly ok: false; readonly message: string };

/**
 * Compare what Turnkey created with what the device derived and the user confirmed.
 * Every chosen family must be present; Solana/EVM must equal the local preview exactly.
 * Fail closed: on any difference the wallet is not registered with ZyroPay.
 */
export function verifyImport(
  chosen: readonly ChainFamily[],
  expected: { readonly solana?: string; readonly evm?: string },
  reported: readonly ReportedAccount[],
  modeNetworks: readonly NetworkId[],
): ImportVerification {
  const addresses: { family: ChainFamily; address: string }[] = [];
  for (const family of chosen) {
    const account = reported.find((a) => a.family === family);
    if (account === undefined)
      return { ok: false, message: `Turnkey did not create the ${family} account.` };
    if (family === "cardano") {
      const key = account.address.replace(/^0x/, "").toLowerCase();
      const network = familyNetworks("cardano", modeNetworks)[0];
      if (!/^[0-9a-f]{64}$/.test(key) || network === undefined)
        return { ok: false, message: "Turnkey returned an unexpected Cardano key." };
      addresses.push({ family, address: cardanoEnterpriseAddress(key, network) });
      continue;
    }
    const want = family === "solana" ? expected.solana : expected.evm;
    let got: string;
    try {
      got = normalizeAddress(family, account.address);
    } catch {
      return { ok: false, message: `Turnkey returned an invalid ${family} address.` };
    }
    if (want === undefined || normalizeAddress(family, want) !== got) {
      return {
        ok: false,
        message:
          "The address Turnkey derived doesn't match the one this device showed you, so the wallet wasn't added to ZyroPay.",
      };
    }
    addresses.push({ family, address: got });
  }
  return { ok: true, addresses };
}
