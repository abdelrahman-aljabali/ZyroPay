import { networksForMode, type NetworkId } from "@zyropay/shared";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Platform, Switch, View } from "react-native";
import {
  AddressText,
  Card,
  EmptyState,
  Icon,
  LoadingSkeleton,
  NetworkStack,
  PrimaryButton,
  Row,
  Screen,
  ScreenHeader,
  Section,
  SecondaryButton,
  SecurityWarning,
  SegmentedControl,
  SimulatedBadge,
  spacing,
  tapHaptic,
  Text,
  TextButton,
  TextField,
  useTheme,
} from "@zyropay/ui";
import { errorMessage, isApiError } from "@/api";
import { useCreateWallet } from "@/api/hooks";
import { KeyEntry } from "@/components/import/KeyEntry";
import { PhraseEntry } from "@/components/import/PhraseEntry";
import { PrivacyCover } from "@/components/import/PrivacyCover";
import { env } from "@/lib/env";
import { previewPhraseAddresses, type PhrasePreview } from "@/lib/import/derive";
import { TEST_EVM_KEY, TEST_PHRASE_12, TEST_SOLANA_KEY } from "@/lib/import/fixtures";
import {
  importToTurnkey,
  registrationBody,
  verifyImported,
  type ImportPlan,
} from "@/lib/import/flow";
import { checkPhrase } from "@/lib/import/phrase";
import { familyCopy, familyNetworks, importFamilies, type ImportFamily } from "@/lib/import/plan";
import { checkPrivateKey } from "@/lib/import/private-key";
import { useSecretDraft } from "@/lib/import/secret";
import { ScreenCaptureWarning } from "@/components/ScreenCaptureWarning";
import { addScreenshotListener, usePreventScreenCapture } from "@/lib/screen-capture";
import {
  EXPO_GO_IMPORT_REASON,
  isExpoGo,
  SignerUnavailableError,
  useSigner,
  type ImportedWallet,
} from "@/lib/turnkey";
import { newIdempotencyKey } from "@/lib/utils";
import { checkWalletName } from "@/lib/wallets";
import { useSession } from "@/state";

const NETWORKS = networksForMode(env.mode);
const FAMILIES = importFamilies(NETWORKS);

type Kind = "phrase" | "key";
type Step = "enter" | "review";
type Phase = "idle" | "passkey" | "registering";

/**
 * Import wallet (ADR-003). The recovery phrase or private key is checked and previewed
 * on this device, then HPKE-encrypted here to Turnkey's import enclave and imported with
 * the user's passkey. It never goes to the ZyroPay API, logs, analytics, the query cache,
 * any store or navigation params; the SecretDraft is wiped after the import and when
 * the screen unmounts. ZyroPay then links the new wallet by its Turnkey id only.
 */
export default function ImportWallet() {
  const signer = useSigner();
  const { colors } = useTheme();
  const subOrg = useSession((s) => s.session?.user.turnkeySubOrganizationId ?? null);
  const create = useCreateWallet();
  const { draft, snapshot } = useSecretDraft();
  const simulated = env.mocksActive;
  const blocked = isExpoGo && !simulated ? EXPO_GO_IMPORT_REASON : signer.importUnavailableReason;

  const [kind, setKind] = useState<Kind>("phrase");
  const [step, setStep] = useState<Step>("enter");
  const [families, setFamilies] = useState<readonly ImportFamily[]>(
    FAMILIES.filter((f) => f !== "cardano"),
  );
  const [preview, setPreview] = useState<PhrasePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [name, setName] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [imported, setImported] = useState<ImportedWallet | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const [pasted, setPasted] = useState(false);
  const [clipboardCleared, setClipboardCleared] = useState(false);
  const [screenshotTaken, setScreenshotTaken] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey("wallet-import"));

  // Android: FLAG_SECURE (no screenshots/recording). iOS: hides content from recordings.
  usePreventScreenCapture("import-secret");
  useEffect(() => {
    const sub = addScreenshotListener(() => {
      setScreenshotTaken(true);
    });
    return () => {
      sub.remove();
    };
  }, []);

  const phraseCheck = kind === "phrase" ? checkPhrase(snapshot.words) : null;
  const keyCheck = kind === "key" && snapshot.key !== "" ? checkPrivateKey(snapshot.key) : null;
  const nameCheck = checkWalletName(name);
  const busy = phase !== "idle";
  const entryValid = kind === "phrase" ? phraseCheck?.ok === true : keyCheck?.ok === true;
  const invalidWords = phraseCheck && !phraseCheck.ok ? phraseCheck.unknown : [];
  const allTyped = snapshot.words.every((w) => w !== "");
  const phraseMessage =
    phraseCheck &&
    !phraseCheck.ok &&
    (showErrors ||
      phraseCheck.reason === "unknown_words" ||
      (allTyped && phraseCheck.reason === "checksum"))
      ? phraseCheck.message
      : null;
  const keyMessage =
    keyCheck && !keyCheck.ok && (showErrors || snapshot.key.length >= 40) ? keyCheck.message : null;

  // Derive the Solana/EVM preview on this device once the phrase is valid and reviewed.
  const phrase = phraseCheck?.ok === true ? phraseCheck.phrase : null;
  useEffect(() => {
    if (step !== "review" || kind !== "phrase" || phrase === null) return;
    let cancelled = false;
    setPreview(null);
    setPreviewError(null);
    previewPhraseAddresses(phrase, ["solana", "evm"])
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch(() => {
        if (!cancelled) setPreviewError("Couldn't derive the addresses on this device.");
      });
    return () => {
      cancelled = true;
    };
  }, [step, kind, phrase]);

  const switchKind = (next: Kind) => {
    if (next === kind || busy) return;
    draft.wipe();
    setKind(next);
    setShowErrors(false);
    setError(null);
    setPasted(false);
  };

  const paste = async () => {
    let text: string;
    try {
      text = await Clipboard.getStringAsync();
    } catch {
      return;
    }
    if (kind === "phrase") draft.fillFromText(text);
    else draft.setKey(text);
    setPasted(true);
    setClipboardCleared(false);
  };

  const clearClipboard = async () => {
    try {
      await Clipboard.setStringAsync("");
      setClipboardCleared(true);
      tapHaptic("success");
    } catch {
      setClipboardCleared(false);
    }
  };

  const fillTestVector = (which: "phrase" | "evm" | "solana") => {
    if (which === "phrase") draft.fillFromText(TEST_PHRASE_12);
    else draft.setKey(which === "evm" ? TEST_EVM_KEY : TEST_SOLANA_KEY);
  };

  const toReview = () => {
    setShowErrors(true);
    if (!entryValid) {
      tapHaptic("error");
      return;
    }
    setError(null);
    setStep("review");
  };

  const currentPlan = useMemo<ImportPlan | null>(() => {
    if (kind === "phrase") {
      if (preview === null || families.length === 0) return null;
      return { kind: "phrase", families, preview };
    }
    if (keyCheck?.ok !== true) return null;
    return { kind: "key", family: keyCheck.family, address: keyCheck.address };
  }, [kind, preview, families, keyCheck]);

  const defaultName = kind === "phrase" ? "Imported wallet" : "Imported key";

  const submit = async () => {
    if (subOrg === null || !nameCheck.ok) return;
    const label = nameCheck.name ?? defaultName;
    setError(null);
    try {
      let result = imported;
      let usedPlan = plan;
      if (result === null) {
        if (currentPlan === null) return;
        usedPlan = currentPlan;
        setPhase("passkey");
        const secret =
          kind === "phrase"
            ? () => {
                const c = checkPhrase(draft.getWords());
                if (!c.ok) throw new Error(c.message);
                return c.phrase;
              }
            : () => {
                const c = checkPrivateKey(draft.getKey());
                if (!c.ok) throw new Error(c.message);
                return c.privateKey;
              };
        result = await importToTurnkey(signer, {
          organizationId: subOrg,
          name: label,
          plan: currentPlan,
          secret,
        });
        // In Turnkey now: nothing on this device needs the secret any more.
        draft.wipe();
        setImported(result);
        setPlan(currentPlan);
        const verified = verifyImported(currentPlan, result, NETWORKS);
        if (!verified.ok) {
          tapHaptic("error");
          setMismatch(true);
          setPhase("idle");
          setError(verified.message);
          return;
        }
      }
      if (usedPlan === null) return;
      setPhase("registering");
      const wallet = await create.mutateAsync(
        registrationBody(usedPlan, result, label, idempotencyKey, NETWORKS),
      );
      tapHaptic("success");
      router.dismissTo({ pathname: "/wallets/[id]", params: { id: wallet.id, imported: "1" } });
    } catch (e) {
      tapHaptic("error");
      setPhase("idle");
      if (isApiError(e, "IDEMPOTENCY_CONFLICT"))
        setIdempotencyKey(newIdempotencyKey("wallet-import"));
      // Never show a raw upstream error here: it could quote what was sent.
      setError(
        e instanceof SignerUnavailableError
          ? e.message
          : isApiError(e, "FORBIDDEN")
            ? "ZyroPay can only add wallets from your own sub-organization, so this one was not added."
            : isApiError(e)
              ? errorMessage(e)
              : "The import didn't finish. Nothing was added to ZyroPay. Check your passkey and try again.",
      );
    }
  };

  const header = (
    <ScreenHeader
      title="Import wallet"
      subtitle={
        step === "enter"
          ? "Bring a wallet you already have, secured by your passkey from now on."
          : "Check the addresses, then import."
      }
      size="inline"
      onBack={() => {
        if (step === "review" && imported === null && !busy) setStep("enter");
        else router.back();
      }}
    />
  );

  if (blocked !== null) {
    return (
      <Screen testID="wallets-import-screen" edges={["top", "bottom"]}>
        {header}
        <EmptyState
          icon="device"
          title="Import needs the ZyroPay app build"
          message={blocked}
          variant="card"
          secondaryLabel="Back"
          onSecondary={() => {
            router.back();
          }}
          testID="import-unavailable"
        />
      </Screen>
    );
  }

  const footer =
    step === "enter" ? (
      <PrimaryButton
        label="Continue"
        disabled={!entryValid}
        onPress={toReview}
        testID="import-continue"
      />
    ) : mismatch ? (
      <SecondaryButton
        label="Close"
        onPress={() => {
          router.back();
        }}
        testID="import-close"
      />
    ) : (
      <PrimaryButton
        label={
          phase === "passkey"
            ? "Confirm with your passkey…"
            : phase === "registering"
              ? "Adding wallet…"
              : imported
                ? "Try adding again"
                : "Import with passkey"
        }
        icon="passkey"
        loading={phase === "registering"}
        disabled={
          busy || (imported === null && currentPlan === null) || !nameCheck.ok || subOrg === null
        }
        onPress={() => {
          void submit();
        }}
        accessibilityHint="Asks for your passkey, then imports the wallet into your Turnkey sub-organization"
        testID="import-submit"
      />
    );

  return (
    <View style={{ flex: 1 }}>
      <Screen testID="wallets-import-screen" edges={["top", "bottom"]} footer={footer}>
        {header}
        {step === "enter" ? (
          <>
            <SegmentedControl<Kind>
              options={[
                { value: "phrase", label: "Recovery phrase" },
                { value: "key", label: "Private key" },
              ]}
              value={kind}
              onChange={switchKind}
              testID="import-kind"
            />
            <SecurityWarning
              severity="danger"
              title={
                kind === "phrase"
                  ? "Never share your recovery phrase"
                  : "Never share your private key"
              }
              message="ZyroPay staff will never ask for it, and no support chat, website or AI agent needs it. It is encrypted on this device and sent only to Turnkey's secure enclave, never to ZyroPay."
            />
            <ScreenCaptureWarning />
            {simulated ? (
              <View style={{ gap: spacing.md }} testID="import-simulated">
                <Row gap={spacing.sm}>
                  <SimulatedBadge />
                  <Text variant="footnote" tone="secondary" style={{ flex: 1 }}>
                    Demo mode uses public test vectors only. Typing and pasting are off.
                  </Text>
                </Row>
                <Row gap={spacing.sm} style={{ flexWrap: "wrap" }}>
                  {kind === "phrase" ? (
                    <SecondaryButton
                      label="Use the BIP-39 test phrase"
                      compact
                      onPress={() => {
                        fillTestVector("phrase");
                      }}
                      testID="import-fill-test"
                    />
                  ) : (
                    <>
                      <SecondaryButton
                        label="Test EVM key"
                        compact
                        onPress={() => {
                          fillTestVector("evm");
                        }}
                        testID="import-fill-test-evm"
                      />
                      <SecondaryButton
                        label="Test Solana key"
                        compact
                        onPress={() => {
                          fillTestVector("solana");
                        }}
                        testID="import-fill-test-solana"
                      />
                    </>
                  )}
                </Row>
              </View>
            ) : null}
            {kind === "phrase" ? (
              <PhraseEntry
                draft={draft}
                snapshot={snapshot}
                invalid={invalidWords}
                readOnly={simulated}
              />
            ) : (
              <KeyEntry draft={draft} snapshot={snapshot} error={keyMessage} readOnly={simulated} />
            )}
            {phraseMessage ? (
              <Text
                variant="footnote"
                tone="danger"
                accessibilityRole="alert"
                testID="import-phrase-error"
              >
                {phraseMessage}
              </Text>
            ) : phraseCheck?.ok === true ? (
              <Row gap={spacing.xs}>
                <Icon name="checkCircle" size={16} color={colors.success} />
                <Text variant="footnote" style={{ color: colors.success }}>
                  Valid recovery phrase
                </Text>
              </Row>
            ) : null}
            <Row gap={spacing.sm} style={{ flexWrap: "wrap" }}>
              {!simulated ? (
                <SecondaryButton
                  label="Paste"
                  icon="clipboard"
                  compact
                  onPress={() => {
                    void paste();
                  }}
                  testID="import-paste"
                />
              ) : null}
              <SecondaryButton
                label="Clear"
                icon="close"
                compact
                onPress={() => {
                  draft.wipe();
                  setShowErrors(false);
                }}
                testID="import-clear"
              />
            </Row>
            {pasted ? (
              <SecurityWarning
                severity="warning"
                title={clipboardCleared ? "Clipboard cleared" : "Clear your clipboard"}
                message={
                  clipboardCleared
                    ? Platform.OS === "android"
                      ? "Also delete it from your keyboard's clipboard history (Gboard and others keep their own)."
                      : "Other apps can no longer paste it."
                    : "Your phrase is still on the clipboard, where other apps can read it."
                }
              >
                {!clipboardCleared ? (
                  <View style={{ alignSelf: "flex-start", marginTop: spacing.xs }}>
                    <TextButton
                      label="Clear clipboard"
                      onPress={() => {
                        void clearClipboard();
                      }}
                      testID="import-clear-clipboard"
                    />
                  </View>
                ) : null}
              </SecurityWarning>
            ) : null}
          </>
        ) : (
          <ReviewStep
            kind={kind}
            families={families}
            onToggle={(f, on) => {
              setFamilies((prev) =>
                on
                  ? FAMILIES.filter((x) => x === f || prev.includes(x))
                  : prev.filter((x) => x !== f),
              );
            }}
            preview={preview}
            previewError={previewError}
            keyFamily={keyCheck?.ok === true ? keyCheck.family : null}
            keyAddress={keyCheck?.ok === true ? keyCheck.address : null}
            locked={busy || imported !== null}
            simulated={simulated}
          />
        )}
        {step === "review" ? (
          <>
            <TextField
              label="Name (optional)"
              placeholder={defaultName}
              value={name}
              onChangeText={setName}
              maxLength={64}
              autoCapitalize="words"
              editable={!busy}
              error={nameCheck.ok ? null : nameCheck.error}
              testID="import-name"
            />
            <SecurityWarning
              severity="info"
              title="What happens next"
              message="Your passkey approves twice: once to open Turnkey's import channel, once to import. This phone encrypts the secret to Turnkey's enclave; ZyroPay only records the new wallet's addresses."
            />
          </>
        ) : null}
        {screenshotTaken ? (
          <SecurityWarning
            severity="danger"
            title="Screenshot detected"
            message="Delete the screenshot from your photos and any cloud backup. If it may have been shared, move your funds to a new wallet."
          />
        ) : null}
        {error ? (
          <SecurityWarning
            severity="danger"
            title={mismatch ? "Addresses don't match" : "Wallet not added"}
            message={error}
          />
        ) : null}
      </Screen>
      <PrivacyCover />
    </View>
  );
}

function ReviewStep({
  kind,
  families,
  onToggle,
  preview,
  previewError,
  keyFamily,
  keyAddress,
  locked,
  simulated,
}: {
  readonly kind: Kind;
  readonly families: readonly ImportFamily[];
  readonly onToggle: (family: ImportFamily, on: boolean) => void;
  readonly preview: PhrasePreview | null;
  readonly previewError: string | null;
  readonly keyFamily: "solana" | "evm" | null;
  readonly keyAddress: string | null;
  readonly locked: boolean;
  readonly simulated: boolean;
}) {
  const { colors } = useTheme();
  if (kind === "key") {
    const nets: NetworkId[] = keyFamily ? familyNetworks(keyFamily, NETWORKS) : [];
    return (
      <Section
        title="Your key's address"
        badge={simulated ? <SimulatedBadge /> : undefined}
        footer="Check it matches the address your old wallet shows. An imported key has no recovery phrase and no other accounts."
      >
        <Card style={{ gap: spacing.md }} testID="import-key-review">
          <Row gap={spacing.md}>
            {nets.length > 0 ? <NetworkStack networks={nets} size={24} /> : null}
            <Text variant="calloutStrong" style={{ flex: 1 }}>
              {keyFamily ? familyCopy(keyFamily, NETWORKS).title : ""}
            </Text>
          </Row>
          {keyAddress ? <AddressText address={keyAddress} /> : null}
        </Card>
      </Section>
    );
  }
  return (
    <Section
      title="Chains"
      badge={simulated ? <SimulatedBadge /> : undefined}
      footer="Derived on this phone from your phrase. Check they match the addresses your old wallet shows."
    >
      <View style={{ gap: spacing.md }}>
        {FAMILIES.map((f) => {
          const copy = familyCopy(f, NETWORKS);
          const on = families.includes(f);
          const address = f === "solana" ? preview?.solana : f === "evm" ? preview?.evm : undefined;
          return (
            <Card key={f} style={{ gap: spacing.md }} testID={`import-chain-${f}`}>
              <Row gap={spacing.md} align="flex-start">
                <NetworkStack networks={familyNetworks(f, NETWORKS)} size={24} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="calloutStrong">{copy.title}</Text>
                  <Text variant="caption" tone="secondary">
                    {copy.path}
                  </Text>
                </View>
                <Switch
                  value={on}
                  disabled={locked || (on && families.length === 1)}
                  onValueChange={(v) => {
                    onToggle(f, v);
                  }}
                  accessibilityLabel={`Import ${copy.title}`}
                  trackColor={{ false: colors.surfaceStrong, true: colors.success }}
                  testID={`import-toggle-${f}`}
                />
              </Row>
              <Text variant="footnote" tone={copy.caution ? "caution" : "secondary"}>
                {copy.note}
              </Text>
              {on && f !== "cardano" ? (
                address ? (
                  <View style={{ gap: spacing.xs }}>
                    <Text variant="caption" tone="secondary">
                      Address
                    </Text>
                    <AddressText address={address} />
                  </View>
                ) : previewError ? (
                  <Text variant="footnote" tone="danger">
                    {previewError}
                  </Text>
                ) : (
                  <View style={{ gap: spacing.xs }}>
                    <Text variant="caption" tone="secondary">
                      Deriving on this phone…
                    </Text>
                    <LoadingSkeleton height={20} width="90%" />
                  </View>
                )
              ) : null}
              {on && f === "cardano" ? (
                <Text variant="caption" tone="secondary">
                  Address shown after import (Turnkey creates this key).
                </Text>
              ) : null}
            </Card>
          );
        })}
      </View>
    </Section>
  );
}
