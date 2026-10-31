import { chainFamilyOf, getNetwork, networksForMode, type NetworkId } from "@zyropay/shared";
import { router } from "expo-router";
import { useState } from "react";
import {
  PrimaryButton,
  Screen,
  ScreenHeader,
  Section,
  SecurityWarning,
  tapHaptic,
  TextField,
} from "@zyropay/ui";
import { errorMessage, isApiError } from "@/api";
import { useCreateWallet } from "@/api/hooks";
import { ChainPicker } from "@/components/ChainPicker";
import { env } from "@/lib/env";
import { SignerUnavailableError, useSigner } from "@/lib/turnkey";
import { newIdempotencyKey } from "@/lib/utils";
import { checkWalletName, defaultWalletName, siblingNetworks } from "@/lib/wallets";
import { useSession } from "@/state";

const NETWORKS = networksForMode(env.mode);

type Phase = "idle" | "passkey" | "registering";

/**
 * Create new wallet (ADR-001): the passkey creates the wallet inside the
 * user's own Turnkey sub-organization; only then does the app register its id
 * with the API, which re-reads Turnkey and refuses anything outside that
 * sub-org. No server key is involved at any point.
 */
export default function CreateWallet() {
  const signer = useSigner();
  const subOrg = useSession((s) => s.session?.user.turnkeySubOrganizationId ?? null);
  const create = useCreateWallet();
  const [network, setNetwork] = useState<NetworkId | null>(NETWORKS[0] ?? null);
  const [name, setName] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  // One key per screen visit: a retry after a dropped response returns the same wallet.
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey("wallet-create"));
  const [createdId, setCreatedId] = useState<string | null>(null);

  const nameCheck = checkWalletName(name);
  const unavailable = signer.kind === "unavailable" ? signer.unavailableReason : null;
  const busy = phase !== "idle";

  const submit = async () => {
    if (network === null || subOrg === null || !nameCheck.ok) return;
    setError(null);
    const walletName = nameCheck.name ?? defaultWalletName(network);
    try {
      // Reuse the wallet the passkey already made if only the registration failed.
      let turnkeyWalletId = createdId;
      if (turnkeyWalletId === null) {
        setPhase("passkey");
        turnkeyWalletId = await signer.createWallet({
          organizationId: subOrg,
          name: walletName,
          family: chainFamilyOf(network),
        });
        setCreatedId(turnkeyWalletId);
      }
      setPhase("registering");
      const wallet = await create.mutateAsync({
        turnkeyWalletId,
        network,
        name: walletName,
        idempotencyKey,
      });
      tapHaptic("success");
      router.dismissTo({ pathname: "/wallets/[id]", params: { id: wallet.id, created: "1" } });
    } catch (e) {
      tapHaptic("error");
      setPhase("idle");
      if (isApiError(e, "IDEMPOTENCY_CONFLICT"))
        setIdempotencyKey(newIdempotencyKey("wallet-create"));
      setError(
        e instanceof SignerUnavailableError
          ? e.message
          : isApiError(e, "FORBIDDEN")
            ? "ZyroPay can only add wallets from your own sub-organization, so this one was not added."
            : errorMessage(e),
      );
    }
  };

  return (
    <Screen
      testID="wallets-create-screen"
      edges={["top", "bottom"]}
      footer={
        <PrimaryButton
          label={
            phase === "passkey"
              ? "Confirm with your passkey…"
              : phase === "registering"
                ? "Adding wallet…"
                : createdId
                  ? "Try adding again"
                  : "Create with passkey"
          }
          icon="passkey"
          loading={phase === "registering"}
          disabled={
            busy || network === null || !nameCheck.ok || unavailable !== null || subOrg === null
          }
          onPress={() => {
            void submit();
          }}
          accessibilityHint="Asks for your passkey, then creates the wallet"
          testID="wallets-create-submit"
        />
      }
    >
      <ScreenHeader
        title="Create new wallet"
        subtitle="Pick a chain. You can add more wallets later."
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
            setCreatedId(null);
          }}
          describe={(n) => {
            const siblings = siblingNetworks(n, NETWORKS);
            return siblings.length > 0
              ? `Same address on ${siblings.map((s) => getNetwork(s).displayName).join(", ")}`
              : undefined;
          }}
          testID="create-chain"
        />
      </Section>
      <TextField
        label="Name (optional)"
        placeholder={network ? defaultWalletName(network) : "Wallet name"}
        value={name}
        onChangeText={setName}
        maxLength={64}
        autoCapitalize="words"
        error={nameCheck.ok ? null : nameCheck.error}
        testID="wallets-create-name"
      />
      {unavailable ? (
        <SecurityWarning severity="info" title="Passkey needed" message={unavailable} />
      ) : (
        <SecurityWarning
          severity="info"
          title="Your passkey creates it"
          message="The wallet is made inside your own Turnkey sub-organization. ZyroPay only records its address and never holds a key that can move funds."
        />
      )}
      {error ? (
        <SecurityWarning severity="danger" title="Wallet not added" message={error} />
      ) : null}
    </Screen>
  );
}
