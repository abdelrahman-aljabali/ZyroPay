import { describe, expect, it } from "vitest";
import { isFramingPasskeyError, parseFrameParents, resolveParentOrigin } from "./embed";

const LANDING = "https://zyropay.online";
const DEV = "http://localhost:4321";

describe("embed allowlist", () => {
  it("keeps bare https origins and http localhost only", () => {
    expect(parseFrameParents(`${LANDING} ${DEV}`)).toEqual([LANDING, DEV]);
    expect(parseFrameParents(`${LANDING},${LANDING}`)).toEqual([LANDING]);
    expect(
      parseFrameParents("* http://evil.example https://a.example/path https://b.example/ x"),
    ).toEqual([]);
    expect(parseFrameParents(undefined)).toEqual([]);
    expect(parseFrameParents("")).toEqual([]);
  });

  it("resolves the parent only when it is allowlisted", () => {
    const allowed = [LANDING, DEV];
    expect(resolveParentOrigin(allowed, [LANDING], "")).toBe(LANDING);
    expect(resolveParentOrigin(allowed, ["https://evil.example"], `${LANDING}/`)).toBeNull();
    expect(resolveParentOrigin(allowed, undefined, `${DEV}/some/page`)).toBe(DEV);
    expect(resolveParentOrigin(allowed, undefined, "")).toBeNull();
    expect(resolveParentOrigin(allowed, undefined, "not a url")).toBeNull();
  });
});

describe("framing passkey errors", () => {
  const dom = (name: string) => Object.assign(new Error("x"), { name });

  it("recognises WebAuthn refusals, also when wrapped", () => {
    expect(isFramingPasskeyError(dom("NotAllowedError"))).toBe(true);
    expect(isFramingPasskeyError(dom("SecurityError"))).toBe(true);
    expect(
      isFramingPasskeyError(
        new Error("Turnkey: signing failed", { cause: dom("NotAllowedError") }),
      ),
    ).toBe(true);
    expect(
      isFramingPasskeyError(
        new Error("The 'publickey-credentials-get' feature is not enabled in this document."),
      ),
    ).toBe(true);
  });

  it("ignores unrelated failures", () => {
    expect(isFramingPasskeyError(new Error("network down"))).toBe(false);
    expect(isFramingPasskeyError(dom("AbortError"))).toBe(false);
    expect(isFramingPasskeyError("NotAllowedError")).toBe(false);
    expect(isFramingPasskeyError(null)).toBe(false);
  });
});
