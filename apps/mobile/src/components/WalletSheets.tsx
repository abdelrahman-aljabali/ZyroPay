import { router } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import {
  ActionSheet,
  BottomSheet,
  ConfirmationSheet,
  PrimaryButton,
  SecondaryButton,
  SecurityWarning,
  spacing,
  tapHaptic,
  Text,
  TextField,
  WATCH_ONLY_LABEL,
  type ActionSheetAction,
} from "@zyropay/ui";
import { errorMessage } from "@/api";
import { useRemoveWallet, useRenameWallet } from "@/api/hooks";
import { checkWalletName } from "@/lib/wallets";
import { useCopy } from "@/lib/utils";

export interface WalletTarget {
  readonly kind: "wallet" | "watch";
  readonly id: string;
  readonly name: string;
  /** Watch wallets: the address (for "Copy address"). */
  readonly address?: string;
}

type Step = "menu" | "rename" | "remove" | null;

/**
 * Per-wallet actions: rename, and remove (unlink; Turnkey keys are never
 * deleted) or stop watching, each behind its own sheet. `target === null`
 * closes everything.
 */
export function WalletSheets({
  target,
  onClose,
  afterRemove,
}: {
  readonly target: WalletTarget | null;
  readonly onClose: () => void;
  /** e.g. leave the detail screen once the wallet is gone. */
  readonly afterRemove?: () => void;
}) {
  const [step, setStep] = useState<Step>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rename = useRenameWallet();
  const remove = useRemoveWallet();
  const { copy } = useCopy();

  useEffect(() => {
    if (target) {
      setStep("menu");
      setName(target.name);
      setError(null);
    } else {
      setStep(null);
    }
  }, [target]);

  const close = () => {
    setStep(null);
    onClose();
  };

  // iOS can't present a modal while another is still dismissing: let the menu
  // sheet finish leaving before the next one rises.
  const go = (next: Step) => {
    setStep(null);
    setTimeout(() => {
      setStep(next);
    }, 280);
  };

  if (!target) return null;
  const isWatch = target.kind === "watch";
  const nameCheck = checkWalletName(name);
  const nameError = nameCheck.ok ? null : nameCheck.error;

  const actions: ActionSheetAction[] = [
    {
      label: "Rename",
      icon: "pencil",
      onPress: () => {
        setError(null);
        go("rename");
      },
      testID: "wallet-action-rename",
    },
    ...(isWatch && target.address
      ? [
          {
            label: "Copy address",
            icon: "copy" as const,
            onPress: () => {
              copy(target.address ?? "");
              close();
            },
            testID: "wallet-action-copy",
          },
        ]
      : []),
    ...(!isWatch
      ? [
          {
            label: "Receive",
            icon: "arrowDown" as const,
            onPress: () => {
              close();
              router.push({ pathname: "/wallets/[id]/receive", params: { id: target.id } });
            },
            testID: "wallet-action-receive",
          },
        ]
      : []),
    {
      label: isWatch ? "Stop watching" : "Remove from ZyroPay",
      subtitle: isWatch ? undefined : "Keys stay in your Turnkey sub-organization",
      icon: isWatch ? "eyeOff" : "trash",
      destructive: true,
      onPress: () => {
        setError(null);
        go("remove");
      },
      testID: "wallet-action-remove",
    },
  ];

  return (
    <>
      <ActionSheet
        visible={step === "menu"}
        title={target.name}
        subtitle={isWatch ? WATCH_ONLY_LABEL : "Passkey wallet"}
        actions={actions}
        onDismiss={close}
        testID="wallet-actions"
      />
      <BottomSheet
        visible={step === "rename"}
        onDismiss={close}
        blocking={rename.isPending}
        testID="wallet-rename-sheet"
        footer={
          <>
            <PrimaryButton
              label="Save name"
              loading={rename.isPending}
              disabled={!nameCheck.ok || name.trim() === "" || name.trim() === target.name}
              onPress={() => {
                if (!nameCheck.ok || nameCheck.name === undefined) return;
                rename.mutate(
                  { kind: target.kind, id: target.id, name: nameCheck.name },
                  {
                    onSuccess: () => {
                      tapHaptic("success");
                      close();
                    },
                    onError: (e) => {
                      tapHaptic("error");
                      setError(errorMessage(e));
                    },
                  },
                );
              }}
              testID="wallet-rename-save"
            />
            <SecondaryButton label="Cancel" onPress={close} disabled={rename.isPending} />
          </>
        }
      >
        <View style={{ gap: spacing.xs }}>
          <Text variant="headline" accessibilityRole="header">
            Rename
          </Text>
          <Text variant="callout" tone="secondary">
            Only changes the label in ZyroPay. Addresses and keys stay the same.
          </Text>
        </View>
        <TextField
          label="Name"
          value={name}
          onChangeText={setName}
          autoFocus
          maxLength={64}
          returnKeyType="done"
          error={nameError}
          testID="wallet-rename-input"
        />
        {error ? (
          <SecurityWarning severity="danger" title="Couldn't rename" message={error} />
        ) : null}
      </BottomSheet>
      <ConfirmationSheet
        visible={step === "remove"}
        icon={isWatch ? "eyeOff" : "trash"}
        title={isWatch ? `Stop watching ${target.name}?` : `Remove ${target.name}?`}
        message={
          isWatch
            ? "The address disappears from ZyroPay. Nothing on chain changes, and you can watch it again any time."
            : "This unlinks the wallet from ZyroPay. Its keys stay in your Turnkey sub-organization and nothing is deleted: your funds are untouched, and adding the wallet again brings it back."
        }
        confirmLabel={isWatch ? "Stop watching" : "Remove wallet"}
        destructive
        loading={remove.isPending}
        onCancel={close}
        onConfirm={() => {
          remove.mutate(
            { kind: target.kind, id: target.id },
            {
              onSuccess: () => {
                tapHaptic("success");
                close();
                afterRemove?.();
              },
              onError: (e) => {
                tapHaptic("error");
                setError(errorMessage(e));
              },
            },
          );
        }}
        testID="wallet-remove-sheet"
      >
        {error ? <SecurityWarning severity="danger" title="Not removed" message={error} /> : null}
      </ConfirmationSheet>
    </>
  );
}
