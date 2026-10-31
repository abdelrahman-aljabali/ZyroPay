import { Redirect } from "expo-router";

/** Deep-link target for the provider's redirect (zyropay://topup/return). */
export default function TopUpReturn() {
  return <Redirect href="/topup/status" />;
}
