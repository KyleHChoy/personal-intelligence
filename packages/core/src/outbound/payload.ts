import { SendPayload } from "@intelligence/contracts/personal";
import { canonicalJson } from "../json.ts";

// A draft's payload in its canonical form: its JSON with keys in sorted order at every level and no
// white space, after parsing with SendPayload, as UTF-8. Arrays keep their order. Pure. A payload
// that does not parse throws.
export function canonicalPayload(payload: SendPayload): Uint8Array {
  return new TextEncoder().encode(canonicalJson(SendPayload.parse(payload)));
}
