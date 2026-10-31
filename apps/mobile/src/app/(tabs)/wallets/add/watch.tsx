import { getNetwork, networksForMode, type NetworkId } from "@zyropay/shared";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Platform } from "react-native";
import {
  AddressInput,
  PrimaryButton,
  Row,
  Screen,
  ScreenHeader,
  Section,
  SecondaryButton,
  SecurityWarning,
  spacing,
  tapHaptic,
  TextField,
  WATCH_ONLY_LABEL,
} from "@zyropay/ui";
import { errorMessage, isApiError } from "@/api";
import { useCreateWatchWallet } from "@/api/hooks";
import { ChainPicker } from "@/components/ChainPicker";
import { env } from "@/lib/env";
import { newIdempotencyKey, readClipboard } from "@/lib/utils";
import {
  checkWalletName,
  checkWatchAddress,
  parseScannedAddress,
  siblingNetworks,
} from "@/lib/wallets";
import { useWatchDraft } from "@/state/flows";

const NETWORKS = networksForMode(env.mode);

/** Watch an address: read-only, validated with the shared address helpers for the picked chain. */
export default function WatchAddress() {
  const [network, setNetwork] = useState<NetworkId | null>(NETWORKS[0] ?? null);
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey("watch-create"));
  const create = useCreateWatchWallet();

  // The scanner screen hands its result back through the draft store.
  useFocusEffect(
    useCallback(() => {
      const scanned = useWatchDraft.getState().scanned;
      if (scanned !== null) {
        setAddress(parseScannedAddress(scanned));
        useWatchDraft.getState().setScanned(null);
      }
    }, []),
  );

  const check = network === null || address === "" ? null : checkWatchAddress(network, address);
  const nameCheck = checkWalletName(name);
  const net = network ? getNetwork(network) : null;

  const submit = () => {
    if (network === null || check?.ok !== true || !nameCheck.ok) return;
    setError(null);
    create.mutate(
      {
        network,
        address: check.address,
        ...(nameCheck.name !== undefined ? { name: nameCheck.name } : {}),
        idempotencyKey,
      },
      {
        onSuccess: () => {
          tapHaptic("success");
          router.dismissTo("/wallets");
        },
        onError: (e) => {
          tapHaptic("error");
          if (isApiError(e, "IDEMPOTENCY_CONFLICT"))
            setIdempotencyKey(newIdempotencyKey("watch-create"));
          setError(errorMessage(e));
        },
      },
    );
  };

  return (
    <Screen
      testID="wallets-watch-screen"
      edges={["top", "bottom"]}
      footer={
        <PrimaryButton
          label="Watch address"
          icon="eye"
          loading={create.isPending}
          disabled={check?.ok !== true || !nameCheck.ok}
          onPress={submit}
          testID="wallets-watch-submit"
        />
      }
    >
      <ScreenHeader
        title="Watch an address"
        subtitle="See its balance in ZyroPay without its keys."
        size="inline"
        onBack={() => {
          router.back();
        }}
      />
      <Section title="Chain">
        <ChainPicker
          networks={NETWORKS}
          value={network}
          onChange={(n) => {
            setNetwork(n);
            setError(null);
          }}
          describe={(n) => {
            const siblings = siblingNetworks(n, NETWORKS);
            return siblings.length > 0
              ? `Also covers ${siblings.map((s) => getNetwork(s).displayName).join(", ")}`
              : undefined;
          }}
          testID="watch-chain"
        />
      </Section>
      <AddressInput
        label="Address"
        value={address}
        onChangeText={(t) => {
          setAddress(t);
          setError(null);
        }}
        valid={check === null ? null : check.ok}
        errorMessage={check && !check.ok ? check.error : undefined}
        placeholder={net ? `${net.displayName} address` : "Address"}
        onPaste={() => {
          void readClipboard().then((t) => {
            setAddress(parseScannedAddress(t));
          });
        }}
        testID="wallets-watch-address"
      />
      {Platform.OS !== "web" ? (
        <Row gap={spacing.sm}>
          <SecondaryButton
            label="Scan QR code"
            icon="scan"
            compact
            onPress={() => {
              router.push("/wallets/add/scan");
            }}
            testID="wallets-watch-scan"
          />
        </Row>
      ) : null}
      <TextField
        label="Name (optional)"
        placeholder={net ? `Watched ${net.displayName}` : "Name"}
        value={name}
        onChangeText={setName}
        maxLength={64}
        autoCapitalize="words"
        error={nameCheck.ok ? null : nameCheck.error}
        testID="wallets-watch-name"
      />
      <SecurityWarning
        severity="info"
        title="Read only"
        message={`${WATCH_ONLY_LABEL}. It isn't added to your total balance.`}
      />
      {error ? <SecurityWarning severity="danger" title="Not added" message={error} /> : null}
    </Screen>
  );
}
