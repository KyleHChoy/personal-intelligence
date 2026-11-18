import { describe, expect, it } from "vitest";
import { VENDOR_RETRY_BASE_MINUTES, VENDOR_RETRY_MAX, vendorRetry } from "./vendor-retry.ts";

const DEFAULTS = { max: VENDOR_RETRY_MAX, baseMinutes: VENDOR_RETRY_BASE_MINUTES };

describe("vendorRetry", () => {
  it("owes a vendor failure a retry, each wait twice the last", () => {
    const waits = Array.from({ length: VENDOR_RETRY_MAX }, (_, retries) =>
      vendorRetry("model_unavailable", retries, DEFAULTS),
    );
    expect(waits.map((one) => one.retries)).toEqual([1, 2, 3, 4, 5]);
    expect(waits.map((one) => one.afterMinutes)).toEqual([1, 2, 4, 8, 16].map((n) => n * VENDOR_RETRY_BASE_MINUTES));
  });

  it("owes none once the tries are spent, and keeps the count so the item reads as exhausted", () => {
    expect(vendorRetry("model_unavailable", VENDOR_RETRY_MAX, DEFAULTS)).toEqual({
      retries: VENDOR_RETRY_MAX,
      afterMinutes: null,
    });
  });

  it("takes the levers' values in place of the defaults", () => {
    expect([VENDOR_RETRY_MAX, VENDOR_RETRY_BASE_MINUTES]).toEqual([5, 30]);
    const limits = { max: 2, baseMinutes: 10 };
    expect(vendorRetry("model_unavailable", 1, limits)).toEqual({ retries: 2, afterMinutes: 20 });
    expect(vendorRetry("model_unavailable", 2, limits)).toEqual({ retries: 2, afterMinutes: null });
    expect(vendorRetry("model_unavailable", 0, { max: 0, baseMinutes: 10 })).toEqual({
      retries: 0,
      afterMinutes: null,
    });
  });

  it("leaves a content failure alone and clears its count", () => {
    for (const code of ["interpret_failed", "cut_off", "model_refused_item", "commit_failed", undefined])
      expect(vendorRetry(code, 3, DEFAULTS)).toEqual({ retries: 0, afterMinutes: null });
  });
});
