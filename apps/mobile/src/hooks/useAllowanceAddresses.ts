import { useMemo } from "react";
import { useWallets } from "@/api/hooks";
import { allowanceAddressesOf } from "@/lib/allowance";

/**
 * The auto-pay allowance contract addresses of the user's own Cardano wallets, derived on the
 * device from each wallet's payment key (never taken from the API): the history labels
 * transfers into and out of them (tx-kind.ts).
 */
export function useAllowanceAddresses(): ReadonlySet<string> {
  const wallets = useWallets();
  return useMemo(() => allowanceAddressesOf(wallets.data ?? []), [wallets.data]);
}
