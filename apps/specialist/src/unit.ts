/*
 * The query: a Cardano native-asset policy id (28 bytes, 56 hex) or an asset unit
 * (policy id + asset name of 0..32 bytes, hex), as Blockfrost spells them.
 */

export type TokenQuery =
  | { readonly kind: "policy"; readonly policyId: string }
  | {
      readonly kind: "asset";
      readonly unit: string;
      readonly policyId: string;
      readonly assetNameHex: string;
    };

export type QueryCheck =
  | { readonly ok: true; readonly query: TokenQuery }
  | { readonly ok: false; readonly reason: string };

export function checkUnit(input: string | undefined): QueryCheck {
  const s = input?.trim().toLowerCase() ?? "";
  if (s === "")
    return {
      ok: false,
      reason: "query parameter 'unit' is required (policy id or asset unit, hex)",
    };
  if (s === "lovelace") return { ok: false, reason: "lovelace is not a native token" };
  if (!/^[0-9a-f]+$/.test(s) || s.length % 2 !== 0)
    return { ok: false, reason: "'unit' must be hex (policy id + optional asset name)" };
  if (s.length < 56 || s.length > 120)
    return {
      ok: false,
      reason:
        "'unit' must be a 56-hex policy id, optionally followed by an asset name of up to 32 bytes",
    };
  if (s.length === 56) return { ok: true, query: { kind: "policy", policyId: s } };
  return {
    ok: true,
    query: { kind: "asset", unit: s, policyId: s.slice(0, 56), assetNameHex: s.slice(56) },
  };
}
