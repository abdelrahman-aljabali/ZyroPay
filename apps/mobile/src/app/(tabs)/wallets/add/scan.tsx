import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { useRef } from "react";
import { Platform, View } from "react-native";
import {
  EmptyState,
  IconButton,
  PrimaryButton,
  radii,
  Screen,
  ScreenHeader,
  spacing,
  tapHaptic,
  Text,
} from "@zyropay/ui";
import { useWatchDraft } from "@/state/flows";

/** QR scanner for "Watch an address". The result goes back to the form for validation. */
export default function ScanAddress() {
  const [permission, requestPermission] = useCameraPermissions();
  const done = useRef(false);

  const back = () => {
    router.back();
  };

  if (Platform.OS === "web") {
    return (
      <Screen>
        <ScreenHeader title="Scan" size="inline" onBack={back} />
        <EmptyState
          icon="camera"
          title="Scanning needs the app"
          message="Paste the address instead."
        />
      </Screen>
    );
  }

  if (!permission?.granted) {
    return (
      <Screen testID="scan-permission">
        <ScreenHeader title="Scan a QR code" size="inline" onBack={back} />
        <EmptyState
          icon="camera"
          title="Allow camera access"
          message="ZyroPay only uses the camera to read the address in a QR code. Nothing is recorded."
        >
          <PrimaryButton
            label={
              permission?.canAskAgain === false
                ? "Camera access is off in Settings"
                : "Allow camera"
            }
            disabled={permission?.canAskAgain === false}
            onPress={() => {
              void requestPermission();
            }}
          />
        </EmptyState>
      </Screen>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#000000" }} testID="scan-screen">
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={(result) => {
          if (done.current) return;
          done.current = true;
          tapHaptic("success");
          useWatchDraft.getState().setScanned(result.data);
          router.back();
        }}
      />
      <View
        pointerEvents="box-none"
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, padding: spacing.xl }}
      >
        <View style={{ paddingTop: spacing.huge }}>
          <IconButton icon="close" accessibilityLabel="Close scanner" onPress={back} />
        </View>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.xl }}>
          <View
            style={{
              width: 248,
              height: 248,
              borderRadius: radii.card,
              borderWidth: 2,
              borderColor: "rgba(255,255,255,0.9)",
            }}
          />
          <Text variant="calloutStrong" style={{ color: "#FFFFFF" }} align="center">
            Point at an address QR code
          </Text>
        </View>
      </View>
    </View>
  );
}
