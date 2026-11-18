import { createHash, createHmac } from "node:crypto";
import { Fingerprint } from "./ids.ts";

// Its own entry point, "@intelligence/contracts/alias-key", so a browser bundle never loads it.
//
// The normal form of an alias key and its fingerprint, shared by the pipeline, which sends a
// subject's keys with each claim, by intake, which writes them, and by the provider, which
// looks a query up by them. Two keys are equal in their normal form, as the identity service
// judges them: an address is trimmed and lower-cased, with no
// Unicode folding; a source id is taken as written; a name is folded (NFKC), trimmed, its
// white space collapsed, and lower-cased.

export type AliasKeyKind = "address" | "source_id" | "name";

export function aliasKeyNormal(kind: AliasKeyKind, value: string): string {
  if (kind === "address") return value.trim().toLowerCase();
  if (kind === "source_id") return value;
  return value.normalize("NFKC").trim().replaceAll(/\s+/gu, " ").toLowerCase();
}

// HMAC-SHA-256 under the deployment's fingerprint key (`fingerprint`, one of the
// deployment's keys) over the kind and the normal form, as a JSON array so no two
// inputs share an encoding. With no key it is the plain hash, which only a process whose row
// names no fingerprint key runs with, a test's own stack say. An empty normal form
// fingerprints nothing: the caller refuses it.
export function aliasFingerprint(kind: AliasKeyKind, value: string, key?: Uint8Array): Fingerprint {
  const normal = aliasKeyNormal(kind, value);
  if (normal === "") throw new Error("empty_alias_key");
  return digest(["alias", kind, normal], key);
}

function digest(parts: string[], key: Uint8Array | undefined): Fingerprint {
  const text = JSON.stringify(parts);
  return Fingerprint.parse(
    key === undefined
      ? createHash("sha256").update(text, "utf8").digest("hex")
      : createHmac("sha256", key).update(text, "utf8").digest("hex"),
  );
}
