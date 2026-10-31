import { z } from "zod";
import { AddressSchema } from "../addresses";
import { IsoDateTimeSchema } from "../common";
import { ChainFamilySchema } from "../networks";

/** One derived account of a Turnkey HD wallet. EVM addresses serve every EVM network. */
export const WalletAddressSchema = z.object({
  id: z.uuid(),
  walletId: z.uuid(),
  family: ChainFamilySchema,
  address: AddressSchema,
  /** e.g. m/44'/501'/0'/0' (Solana) or m/44'/60'/0'/0/0 (EVM); IMPORTED_KEY_DERIVATION_PATH for an imported private key. */
  derivationPath: z.string().min(1).max(64),
  createdAt: IsoDateTimeSchema,
});
export type WalletAddress = z.infer<typeof WalletAddressSchema>;

/**
 * ADR-003: `derivationPath` of the one account of a wallet that is an imported raw private
 * key (a Turnkey private key, not an HD wallet). There is no derivation path, no recovery
 * phrase and no further accounts; exporting it yields the private key.
 */
export const IMPORTED_KEY_DERIVATION_PATH = "imported-private-key";

/** True when the wallet is one imported raw private key (ADR-003), not an HD wallet. */
export function isImportedKeyWallet(wallet: {
  readonly addresses: readonly { readonly derivationPath: string }[];
}): boolean {
  return (
    wallet.addresses.length > 0 &&
    wallet.addresses.every((a) => a.derivationPath === IMPORTED_KEY_DERIVATION_PATH)
  );
}

export const WalletSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  name: z.string().min(1).max(64),
  /** Turnkey sub-organization holding the keys (one per user). */
  turnkeySubOrganizationId: z.string().min(1),
  turnkeyWalletId: z.string().min(1),
  addresses: z.array(WalletAddressSchema),
  createdAt: IsoDateTimeSchema,
});
export type Wallet = z.infer<typeof WalletSchema>;

export const UserSchema = z.object({
  id: z.uuid(),
  email: z.email().nullable(),
  displayName: z.string().max(64).nullable(),
  turnkeySubOrganizationId: z.string().min(1),
  createdAt: IsoDateTimeSchema,
});
export type User = z.infer<typeof UserSchema>;
