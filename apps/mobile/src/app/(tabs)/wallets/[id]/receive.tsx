import {
  chainFamilyOf,
  getNetwork,
  networksForMode,
  NetworkIdSchema,
  type NetworkId,
} from "@zyropay/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, Share, View } from "react-native";
import {
  AddressText,
  Chip,
  EmptyState,
  LoadingSkeleton,
  NetworkLogo,
  NetworkBadge,
  PrimaryButton,
  Row,
  Screen,
  ScreenHeader,
  SecondaryButton,
  SecurityWarning,
  spacing,
  QRDisplay,
} from "@zyropay/ui";
import { useAddCardanoAccount, useReceiveInfo, useWallet } from "@/api/hooks";
import { QueryView } from "@/components/QueryView";
import { env } from "@/lib/env";
import { firstParam, useCopy } from "@/lib/utils";
import { useSigner } from "@/lib/turnkey";
import { needsCardanoAccount, receiveNetworks } from "@/lib/wallets";
import { usePrefs, useSession } from "@/state";

const NETWORKS = networksForMode(env.mode);

/** Receive: network picker, QR, copy, share and a network warning. */
export default function Receive() {
  const params = useLocalSearchParams<{ id: string; network?: string }>();
  const walletId = firstParam(params.id);
  const preferred = usePrefs((s) => s.preferredNetwork);
  const requested = NetworkIdSchema.safeParse(firstParam(params.network));
  const initial: NetworkId =
    requested.success && NETWORKS.includes(requested.data)
      ? requested.data
      : (preferred ?? NETWORKS[0] ?? "solana-devnet");
  const [chosen, setNetwork] = useState<NetworkId>(initial);
  const wallet = useWallet(walletId);
  // Only chains this wallet has an account for (a new single-chain wallet has one family).
  // Plus Cardano for a legacy multi-chain wallet without a Cardano key, to offer adding one.
  const available = wallet.data ? receiveNetworks(wallet.data, NETWORKS) : NETWORKS;
  const network: NetworkId = available.includes(chosen) ? chosen : (available[0] ?? chosen);
  // ADR-002: wallets created before Cardano support have no Cardano key yet.
  const walletWithoutCardano =
    chainFamilyOf(network) === "cardano" &&
    wallet.data !== undefined &&
    needsCardanoAccount(wallet.data, NETWORKS)
      ? wallet.data
      : null;
  const info = useReceiveInfo(walletId, walletWithoutCardano ? null : network);
  const { copied, copy } = useCopy();
  const net = getNetwork(network);
  const signer = useSigner();
  const orgId = useSession((s) => s.session?.user.turnkeySubOrganizationId ?? "");
  const addCardano = useAddCardanoAccount(signer);
  // Keep the selected chain chip in view (e.g. Cardano, last in the row, opened by deep link).
  const chips = useRef<ScrollView>(null);
  const chipX = useRef(new Map<NetworkId, number>());
  const [laidOut, setLaidOut] = useState(0);
  useEffect(() => {
    const x = chipX.current.get(network);
    if (x !== undefined)
      chips.current?.scrollTo({ x: Math.max(0, x - spacing.lg), animated: false });
  }, [network, laidOut]);

  return (
    <Screen testID="receive-screen">
      <ScreenHeader
        title="Receive"
        subtitle={wallet.data?.name}
        size="inline"
        onBack={() => {
          router.back();
        }}
      />
      <ScrollView
        ref={chips}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: spacing.sm }}
      >
        {available.map((n) => (
          <View
            key={n}
            onLayout={(e) => {
              chipX.current.set(n, e.nativeEvent.layout.x);
              if (n === network) setLaidOut((c) => c + 1);
            }}
          >
            <Chip
              label={getNetwork(n).displayName}
              leading={<NetworkLogo network={n} size={24} />}
              selected={n === network}
              onPress={() => {
                setNetwork(n);
              }}
              testID={`receive-network-${n}`}
            />
          </View>
        ))}
      </ScrollView>
      {walletWithoutCardano !== null ? (
        <EmptyState
          variant="card"
          icon="ada"
          title="Add a Cardano account"
          message="This wallet was created before Cardano support. Your passkey adds a Cardano key to it so you can receive ADA."
          testID="receive-cardano-missing"
        >
          <PrimaryButton
            label={addCardano.isPending ? "Adding…" : "Add a Cardano account"}
            icon="passkey"
            loading={addCardano.isPending}
            disabled={addCardano.isPending || orgId === ""}
            onPress={() => {
              addCardano.mutate({
                organizationId: orgId,
                turnkeyWalletId: walletWithoutCardano.turnkeyWalletId,
              });
            }}
            testID="receive-add-cardano"
          />
          {addCardano.error ? (
            <SecurityWarning
              severity="danger"
              title="Cardano account not added"
              message={addCardano.error.message}
            />
          ) : null}
        </EmptyState>
      ) : (
        <QueryView query={info} loading={<LoadingSkeleton height={300} radius={24} />}>
          {(r) => (
            <View style={{ gap: spacing.xl }}>
              <QRDisplay
                value={r.qrPayload}
                accessibilityLabel={`QR code for your ${net.displayName} address`}
              />
              <View style={{ alignItems: "center", gap: spacing.sm }}>
                <NetworkBadge network={r.network} />
                <View style={{ maxWidth: 300 }}>
                  <AddressText address={r.address} align="center" testID="receive-address" />
                </View>
              </View>
              <Row gap={spacing.md}>
                <View style={{ flex: 1 }}>
                  <PrimaryButton
                    label={copied ? "Copied" : "Copy"}
                    icon={copied ? "check" : "copy"}
                    onPress={() => {
                      copy(r.address);
                    }}
                    testID="receive-copy"
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <SecondaryButton
                    label="Share"
                    icon="share"
                    onPress={() => {
                      void Share.share({
                        message: `My ${net.displayName} address: ${r.address}`,
                      }).catch(() => undefined);
                    }}
                  />
                </View>
              </Row>
              <SecurityWarning
                severity={r.isTestnet ? "warning" : "info"}
                title={`Only send ${net.displayName} assets here`}
                message={r.warnings.join(" ")}
              />
            </View>
          )}
        </QueryView>
      )}
    </Screen>
  );
}
