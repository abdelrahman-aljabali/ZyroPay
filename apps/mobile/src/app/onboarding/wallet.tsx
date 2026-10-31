import { router } from "expo-router";
import { View } from "react-native";
import {
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  PrimaryButton,
  Screen,
  ScreenHeader,
  spacing,
  Text,
  WalletCard,
} from "@zyropay/ui";
import { networksForMode } from "@zyropay/shared";
import { errorMessage } from "@/api";
import { env } from "@/lib/env";

const NETWORKS = networksForMode(env.mode);
import { useWallets } from "@/api/hooks";

/** Onboarding 4/7 — wallet creation result (created by the Auth Proxy with the passkey). */
export default function WalletStep() {
  const wallets = useWallets();
  return (
    <Screen
      edges={["top", "bottom"]}
      testID="onboarding-wallet"
      footer={
        <PrimaryButton
          label="Continue"
          disabled={!wallets.isSuccess || wallets.data.length === 0}
          onPress={() => {
            router.push("/onboarding/recovery");
          }}
          testID="wallet-continue"
        />
      }
    >
      <ScreenHeader
        title="Your wallet"
        subtitle="One wallet with a Solana account and an EVM account for Ethereum and Base."
      />
      {wallets.isPending ? (
        <View style={{ gap: spacing.md }}>
          <Text variant="callout" tone="secondary">
            Setting up your wallet…
          </Text>
          <LoadingSkeleton height={140} radius={24} />
        </View>
      ) : wallets.isError ? (
        <ErrorState
          message={errorMessage(wallets.error)}
          onRetry={() => {
            void wallets.refetch();
          }}
        />
      ) : wallets.data.length === 0 ? (
        <EmptyState
          icon="wallet"
          title="No wallet yet"
          message="Your wallet can take a moment to appear. Pull to try again."
          actionLabel="Check again"
          onAction={() => {
            void wallets.refetch();
          }}
        />
      ) : (
        <View style={{ gap: spacing.md }}>
          {wallets.data.map((w) => (
            <WalletCard key={w.id} wallet={w} networks={NETWORKS} />
          ))}
          <Text variant="caption" tone="secondary">
            The same addresses work on mainnet and testnet. This build only uses its own networks.
          </Text>
        </View>
      )}
    </Screen>
  );
}
