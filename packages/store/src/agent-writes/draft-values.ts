import { messageBodyHash } from "@intelligence/contracts/body-hash";
import type { SendPayload } from "@intelligence/contracts/personal";
import { foldDomain, sha256 } from "@intelligence/personal-core";
import { canonicalPayload } from "@intelligence/personal-core/outbound";
import { byText } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import type { Keys } from "../core/keys.ts";

// The four values a draft's row holds in clear, made from its payload: the one definition `pi mcp`
// stores and `pi send` checks again. Each is keyed: no unkeyed hash of a payload leaves this
// function.
export type DraftValues = { payloadFp: string; bodyFp: string; recipientFps: string[]; recipientDomainFps: string[] };

const sortedOnce = (values: string[]): string[] => [...new Set(values)].sort(byText);

export async function draftValues(keys: Keys, payload: SendPayload): Promise<DraftValues> {
  const addresses = [...payload.to, ...payload.cc];
  return {
    payloadFp: fingerprint(keys, "payload", sha256(canonicalPayload(payload))),
    bodyFp: fingerprint(keys, "body_hash", await messageBodyHash(payload.body)),
    recipientFps: sortedOnce(addresses.map((address) => fingerprint(keys, "address", address))),
    // Each recipient's whole domain and its registrable domain: an organization's veto holds the
    // second, and an older one the first.
    recipientDomainFps: sortedOnce(
      addresses.flatMap((address) => {
        const domain = address.slice(address.lastIndexOf("@") + 1);
        return [domain, foldDomain(domain)].map((one) => fingerprint(keys, "domain", one));
      }),
    ),
  };
}
