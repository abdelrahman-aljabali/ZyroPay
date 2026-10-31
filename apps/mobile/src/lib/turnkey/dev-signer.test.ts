import { describe, expect, it } from "vitest";
import { devMockTurnkeySigner } from "./signer";

/*
 * The dev passkey must produce exactly what @zyropay/wallet's `mockPasskeyStamp` produces,
 * or the local API's MockTurnkey refuses it. The vector below was generated with
 * mockPasskeyStamp("dev-0011223344556677", body).
 */
const CREDENTIAL = "dev-0011223344556677";
const EXPECTED = {
  url: "https://api.turnkey.com/public/v1/query/whoami",
  body: '{"organizationId":"mock-org-93a939746a6315f2"}',
  stamp: {
    stampHeaderName: "X-Stamp-Webauthn",
    stampHeaderValue:
      '{"authenticatorData":"bW9jaw","clientDataJson":"eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiT1RrME5EYzVZV1JrTURJME56STFaVGRqWkRsaU1ESmhOMll6TURRM016VmxZekUyT1RGaE5qUTBOV1JqWVRsak5qY3dNVEEyWkRBeVlUbGpZak5sTlEiLCJvcmlnaW4iOiJodHRwczovL21vY2suenlyb3BheSJ9","credentialId":"dev-0011223344556677","signature":"3a59f10962b9e84a77da2a0c44feb5ca391fc87b698e4802d3c005c7ab52bdcf"}',
  },
};

describe("dev MockTurnkey passkey (development only)", () => {
  const signer = devMockTurnkeySigner(() => Promise.resolve(CREDENTIAL));

  it("stamps whoami byte-for-byte like @zyropay/wallet mockPasskeyStamp", async () => {
    expect(await signer.logIn()).toEqual(EXPECTED);
    expect(signer.kind).toBe("simulated");
  });

  it("fails closed for everything that needs real Turnkey", async () => {
    await expect(
      signer.createDelegatedUser({ organizationId: "o", publicKey: "02ab" }),
    ).rejects.toThrow(/real Turnkey/);
    await expect(signer.stampCreatePolicies({ organizationId: "o", policies: [] })).rejects.toThrow(
      /real Turnkey/,
    );
    await expect(
      signer.exportRecoveryPhrase({ turnkeyWalletId: "w", organizationId: "o" }),
    ).rejects.toThrow(/real Turnkey/);
  });
});
