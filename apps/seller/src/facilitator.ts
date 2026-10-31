import type { MasumiRegistryValidator } from "@x402/cardano";
import { toFacilitatorCardanoSigner } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/facilitator";
import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/server";
import type { SupportedResponse } from "@x402/core/types";
import type { Config } from "./config";
import { NETWORK } from "./config";

/*
 * The x402 facilitator run inside this worker: the same @x402/cardano code the hosted
 * facilitator runs (every verification check, then submission through Blockfrost), but it
 * answers as soon as the transaction is submitted instead of waiting for a block. The hosted
 * facilitator waits for confirmation behind a ~60 s gateway timeout, so a payment could land
 * while the buyer received a 504 and no resource. The seller holds no keys either way.
 * `registryClaim` vouches for the seller's own Masumi registry claim (escrow/terms.ts
 * ownRegistryClaim): without it @x402/cardano rejects any lock whose terms claim one.
 */
export function embeddedFacilitator(
  config: Config,
  registryClaim?: MasumiRegistryValidator,
): FacilitatorClient {
  const signer = toFacilitatorCardanoSigner({
    network: NETWORK,
    provider: {
      blockfrost: { baseUrl: config.blockfrostBaseUrl, projectId: config.blockfrostProjectId },
    },
    awaitConfirmation: false,
  });
  const facilitator = new x402Facilitator().register(
    NETWORK,
    new ExactCardanoScheme(
      signer,
      registryClaim !== undefined ? { validateRegistryClaim: registryClaim } : {},
    ),
  );
  return {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    getSupported: () => Promise.resolve(facilitator.getSupported() as SupportedResponse),
  };
}
