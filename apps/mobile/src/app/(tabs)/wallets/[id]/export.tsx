import { isImportedKeyWallet } from "@zyropay/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import {
  breakAnywhere,
  Card,
  PrimaryButton,
  Row,
  Screen,
  ScreenHeader,
  SecondaryButton,
  SecurityWarning,
  SimulatedBadge,
  spacing,
  Text,
  ToggleRow,
} from "@zyropay/ui";
import { errorMessage } from "@/api";
import { useWallet } from "@/api/hooks";
import { ScreenCaptureWarning } from "@/components/ScreenCaptureWarning";
import { addScreenshotListener, usePreventScreenCapture } from "@/lib/screen-capture";
import { useSigner } from "@/lib/turnkey";
import { firstParam } from "@/lib/utils";
import { useSession } from "@/state";

const AUTO_HIDE_MS = 60_000;

/**
 * Reveal the recovery phrase. Passkey-gated (Turnkey export, decrypted on the
 * device only), screen capture blocked where the OS allows, auto-hides.
 */
export default function ExportKey() {
  const id = firstParam(useLocalSearchParams<{ id: string }>().id);
  const wallet = useWallet(id);
  const signer = useSigner();
  const orgId = useSession((s) => s.session?.user.turnkeySubOrganizationId ?? "");
  const [acks, setAcks] = useState({ control: false, never: false, offline: false });
  const [phrase, setPhrase] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [screenshotTaken, setScreenshotTaken] = useState(false);

  // Android: FLAG_SECURE (no screenshots/recording). iOS: hides content from recordings.
  usePreventScreenCapture("export-phrase");

  useEffect(() => {
    const sub = addScreenshotListener(() => {
      setScreenshotTaken(true);
    });
    return () => {
      sub.remove();
    };
  }, []);

  useEffect(() => {
    if (phrase === null) return;
    const t = setTimeout(() => {
      setPhrase(null);
    }, AUTO_HIDE_MS);
    return () => {
      clearTimeout(t);
    };
  }, [phrase]);

  const allAck = acks.control && acks.never && acks.offline;
  const isKey = wallet.data !== undefined && isImportedKeyWallet(wallet.data);
  const noun = isKey ? "key" : "phrase";

  const reveal = async () => {
    const w = wallet.data;
    if (!w) return;
    setBusy(true);
    setError(null);
    try {
      const family = w.addresses[0]?.family;
      setPhrase(
        isKey && family !== undefined
          ? // ADR-003: an imported raw key has no phrase; Turnkey exports the key itself.
            await signer.exportPrivateKey({
              organizationId: orgId,
              turnkeyPrivateKeyId: w.turnkeyWalletId,
              family,
            })
          : await signer.exportRecoveryPhrase({
              turnkeyWalletId: w.turnkeyWalletId,
              organizationId: orgId,
            }),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const words = phrase?.trim().split(/\s+/) ?? [];

  return (
    <Screen
      edges={["top", "bottom"]}
      testID="export-screen"
      footer={
        phrase === null ? (
          <PrimaryButton
            label="Reveal with passkey"
            icon="passkey"
            disabled={!allAck || signer.kind === "unavailable" || !wallet.isSuccess}
            loading={busy}
            onPress={() => {
              void reveal();
            }}
            testID="export-reveal"
          />
        ) : (
          <SecondaryButton
            label={`Hide ${noun}`}
            icon="eyeOff"
            onPress={() => {
              setPhrase(null);
            }}
          />
        )
      }
    >
      <ScreenHeader
        title={isKey ? "Private key" : "Recovery phrase"}
        subtitle={wallet.data?.name}
        size="inline"
        onBack={() => {
          setPhrase(null);
          router.back();
        }}
      />
      <ScreenCaptureWarning />
      {signer.kind === "unavailable" ? (
        <SecurityWarning
          severity="info"
          title="Export needs Turnkey"
          message={signer.unavailableReason ?? undefined}
        />
      ) : null}
      {phrase === null ? (
        <>
          <SecurityWarning
            severity="danger"
            title={`Anyone with this ${noun} owns your funds`}
            message="ZyroPay will never ask for it. No support agent, website or AI agent needs it."
          />
          <Card style={{ paddingVertical: spacing.xs }}>
            <ToggleRow
              title="It controls all my funds"
              subtitle="On every network, for this wallet."
              value={acks.control}
              onValueChange={(v) => {
                setAcks((a) => ({ ...a, control: v }));
              }}
              testID="ack-control"
            />
            <ToggleRow
              title="I'll never share or paste it"
              subtitle="Not in chats, not into an AI agent."
              value={acks.never}
              onValueChange={(v) => {
                setAcks((a) => ({ ...a, never: v }));
              }}
              testID="ack-never"
            />
            <ToggleRow
              title="I'll write it down offline"
              subtitle="No screenshots or cloud notes."
              value={acks.offline}
              onValueChange={(v) => {
                setAcks((a) => ({ ...a, offline: v }));
              }}
              testID="ack-offline"
            />
          </Card>
        </>
      ) : (
        <View style={{ gap: spacing.lg }}>
          {signer.kind === "simulated" ? <SimulatedBadge /> : null}
          {isKey ? (
            <Card testID="export-key">
              <Text
                variant="mono"
                selectable={false}
                style={[{ letterSpacing: 0.4 }, breakAnywhere]}
              >
                {phrase}
              </Text>
            </Card>
          ) : (
            <Card style={{ gap: spacing.sm }} testID="export-phrase">
              {Array.from({ length: Math.ceil(words.length / 2) }, (_, row) => (
                <Row key={row} gap={spacing.lg}>
                  {[words[row * 2], words[row * 2 + 1]].map((w, col) =>
                    w === undefined ? null : (
                      <Row key={col} gap={spacing.sm} style={{ flex: 1 }}>
                        <Text
                          variant="caption"
                          tone="secondary"
                          style={{ width: 22, fontVariant: ["tabular-nums"] }}
                        >
                          {String(row * 2 + col + 1)}
                        </Text>
                        <Text variant="mono" selectable={false}>
                          {w}
                        </Text>
                      </Row>
                    ),
                  )}
                </Row>
              ))}
            </Card>
          )}
          <Text variant="caption" tone="secondary">
            Hides automatically after a minute.
          </Text>
        </View>
      )}
      {screenshotTaken ? (
        <SecurityWarning
          severity="danger"
          title="Screenshot detected"
          message="Delete the screenshot from your photos and any cloud backup. If it may have been shared, move your funds to a new wallet."
        />
      ) : null}
      {error ? <SecurityWarning severity="danger" title="Export failed" message={error} /> : null}
    </Screen>
  );
}
