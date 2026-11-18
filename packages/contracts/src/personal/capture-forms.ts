import { sendAddress } from "./primitives.ts";
// The capture, anchor and mirror constants' freeze, and Lens's handle forms, apart from capture.ts
// so mac-contacts.ts and capture.ts both import them without a cycle.

// Every level of a value, frozen in place.
export const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
};

// Anything else a source holds (a short code, a business id, a national number) is no person and
// Lens sends none.
export const E164_PHONE = /^\+[1-9][0-9]{6,14}$/;
// An email handle in primitives.ts's `sendAddress` form, already in lower case.
export const isSourceAddress = (text: string): boolean => sendAddress(text) === text;
