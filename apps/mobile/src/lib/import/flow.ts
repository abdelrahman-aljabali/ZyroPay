import type { ChainFamily, CreateWalletBody, NetworkId, Wallet } from "@zyropay/shared";
import type { ImportedWallet, PasskeySigner } from "@/lib/turnkey/signer";
import type { PhrasePreview } from "./derive";
import { registrationNetwork, verifyImport, type ImportFamily } from "./plan";
import type { KeyFamily } from "./private-key";

/*
 * ADR-003 import sequence, kept out of the screen so it is testable:
 *
 *   1. importToTurnkey   secret -> signer (on-device HPKE to Turnkey's enclave, passkey).
 *                        The caller wipes its SecretDraft right after this resolves or throws.
 *   2. verifyImported    Turnkey's accounts == what the device derived and the user confirmed.
 *   3. registerImported  POST /v1/wallets with the Turnkey id ONLY (no key material exists
 *                        in this step's inputs); the API re-reads the sub-org.
 */

export type ImportPlan =
  | {
      readonly kind: "phrase";
      readonly families: readonly ImportFamily[];
      /** Local derivation the user confirmed (Solana/EVM). */
      readonly preview: PhrasePreview;
    }
  | { readonly kind: "key"; readonly family: KeyFamily; readonly address: string };

function planFamilies(plan: ImportPlan): readonly ChainFamily[] {
  return plan.kind === "phrase" ? plan.families : [plan.family];
}

export function importToTurnkey(
  signer: PasskeySigner,
  input: {
    readonly organizationId: string;
    readonly name: string;
    readonly plan: ImportPlan;
    /** Read at the last moment, from the SecretDraft; never stored by this module. */
    readonly secret: () => string;
  },
): Promise<ImportedWallet> {
  const { plan } = input;
  return plan.kind === "phrase"
    ? signer.importWallet({
        organizationId: input.organizationId,
        name: input.name,
        mnemonic: input.secret(),
        families: plan.families,
      })
    : signer.importPrivateKey({
        organizationId: input.organizationId,
        name: input.name,
        privateKey: input.secret(),
        family: plan.family,
      });
}

export function verifyImported(
  plan: ImportPlan,
  imported: ImportedWallet,
  modeNetworks: readonly NetworkId[],
) {
  const expected =
    plan.kind === "phrase"
      ? plan.preview
      : plan.family === "solana"
        ? { solana: plan.address }
        : { evm: plan.address };
  return verifyImport(planFamilies(plan), expected, imported.accounts, modeNetworks);
}

export function registrationBody(
  plan: ImportPlan,
  imported: ImportedWallet,
  name: string | undefined,
  idempotencyKey: string,
  modeNetworks: readonly NetworkId[],
): CreateWalletBody {
  const network = registrationNetwork(planFamilies(plan), modeNetworks);
  if (network === null) throw new Error("No network of the imported chains is in this build");
  return {
    turnkeyWalletId: imported.turnkeyWalletId,
    network,
    ...(name !== undefined ? { name } : {}),
    idempotencyKey,
  };
}

export function registerImported(
  register: (body: CreateWalletBody) => Promise<Wallet>,
  ...args: Parameters<typeof registrationBody>
): Promise<Wallet> {
  return register(registrationBody(...args));
}
