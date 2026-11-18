import { describe, expect, it } from "vitest";
import { fingerprintText, registrationFingerprint } from "./oauth.ts";

describe("registrationFingerprint", () => {
  it("is eight characters of the approval code's alphabet in two groups, from the id's random part", () => {
    expect(registrationFingerprint(`oc_ABCDEFGH${"x".repeat(24)}`)).toBe("0123-4567");
    expect(registrationFingerprint(`oc_abcdefgh${"x".repeat(24)}`)).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
    );
    // Only the first eight characters of the random part count.
    expect(registrationFingerprint(`oc_ABCDEFGH${"y".repeat(24)}`)).toBe("0123-4567");
  });

  it("reads what the owner typed as an approval code is, and refuses anything else", () => {
    const print = registrationFingerprint(`oc_-_Zz09aQ${"x".repeat(24)}`);
    expect(fingerprintText(print)).toBe(print);
    expect(fingerprintText(print.replace("-", "").toLowerCase())).toBe(print);
    expect(fingerprintText(" 0i23 - 4567 ")).toBe("0123-4567");
    for (const typed of ["", "0123-456", "0123-45678", "0123-456U", "not a print"])
      expect(fingerprintText(typed), typed).toBeNull();
  });
});
