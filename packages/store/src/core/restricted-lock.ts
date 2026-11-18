import { hkdfSync, randomBytes } from "node:crypto";
import { type DataKey, Envelope, EvidenceId } from "@intelligence/contracts";
import { CodedError, isRestricted, RESTRICTED_LOCKED, UNLOCK_WINDOW_MS } from "@intelligence/contracts/personal";
import type { Now } from "@intelligence/personal-core";
import { open, seal } from "./crypto/envelope.ts";
import type { Keys } from "./key-set.ts";

// The passkey lock on the restricted key file. A wrapped file holds each restricted compartment's key
// sealed under a file key, and the file key sealed under each way the owner can unlock it: the
// recovery secret, printed once to the owner's terminal, and the passkey's PRF output for the file's
// salt. Neither secret is on the box, so the file alone opens nothing. An unlock opens the keys in
// memory for a window, then forgets them.

export type Wrapped = {
  version: 2;
  // The restricted compartments the file holds keys for, sorted. Plain, so a process that holds no
  // key can still tell an on category's key is there, locked.
  compartments: string[];
  // What the passkey's PRF is evaluated over, base64url of 32 bytes.
  prfSalt: string;
  recovery: Envelope;
  prf?: { credential: string; key: Envelope };
  keys: Envelope;
};

// How a caller unlocks: the recovery secret, or a passkey's PRF output and its credential's id.
export type UnlockBy = { recovery: Buffer } | { prf: Buffer; credential: string };

const SECRET_BYTES = 32;
const B64URL = /^[A-Za-z0-9_-]{43}$/;
const at = (field: string) => ({ evidenceId: EvidenceId.parse("keyfile/restricted"), field });

// The key that seals the file key for one way in. The recovery secret and a PRF output are each 32
// random bytes, so one HKDF step makes a key of them; each way has its own label.
const wrappingKey = (secret: Buffer, way: "recovery" | "prf"): DataKey =>
  Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), `pi-restricted/${way}/v1`, SECRET_BYTES)).toString(
    "base64",
  ) as DataKey;

const newKey = (): DataKey => randomBytes(SECRET_BYTES).toString("base64") as DataKey;

const refused = (): CodedError => new CodedError("restricted_unlock_refused");

// Whether a key file's text is a wrapped one. Anything else is read as the plain format.
export function isWrapped(text: string): boolean {
  try {
    return (JSON.parse(text) as { version?: unknown }).version === 2;
  } catch {
    return false;
  }
}

// A wrapped file's shape, or `format`.
export function parseWrapped(text: string): Wrapped {
  let file: Partial<Wrapped>;
  try {
    file = JSON.parse(text) as Partial<Wrapped>;
  } catch {
    throw new CodedError("format");
  }
  const ok =
    file.version === 2 &&
    Array.isArray(file.compartments) &&
    file.compartments.length > 0 &&
    file.compartments.every((name) => typeof name === "string" && isRestricted(name)) &&
    typeof file.prfSalt === "string" &&
    B64URL.test(file.prfSalt) &&
    Envelope.safeParse(file.recovery).success &&
    Envelope.safeParse(file.keys).success &&
    (file.prf === undefined ||
      (typeof file.prf.credential === "string" &&
        file.prf.credential.length > 0 &&
        Envelope.safeParse(file.prf.key).success));
  if (!ok) throw new CodedError("format");
  return file as Wrapped;
}

export const wrappedText = (file: Wrapped): string => `${JSON.stringify(file, null, 2)}\n`;

// A new wrapped file over `keys`, every one a restricted compartment's, and the recovery secret
// that opens it, base64url. The secret is the caller's to show the owner once and never to keep.
export function wrapKeys(keys: ReadonlyMap<string, DataKey>): { file: Wrapped; recovery: string } {
  const names = [...keys.keys()].sort();
  if (names.length === 0 || !names.every(isRestricted)) throw new CodedError("format");
  const fileKey = newKey();
  const secret = randomBytes(SECRET_BYTES);
  const file: Wrapped = {
    version: 2,
    compartments: names,
    prfSalt: randomBytes(SECRET_BYTES).toString("base64url"),
    recovery: seal(wrappingKey(secret, "recovery"), Buffer.from(fileKey, "base64"), at("recovery")),
    keys: seal(fileKey, Buffer.from(JSON.stringify(Object.fromEntries(keys))), at("keys")),
  };
  return { file, recovery: secret.toString("base64url") };
}

// The file key, by either way in, or `restricted_unlock_refused`. A PRF output opens only the slot
// of the credential that made it.
function fileKeyOf(file: Wrapped, by: UnlockBy): DataKey {
  try {
    if ("recovery" in by)
      return Buffer.from(open(wrappingKey(by.recovery, "recovery"), file.recovery, at("recovery"))).toString(
        "base64",
      ) as DataKey;
    if (file.prf === undefined || file.prf.credential !== by.credential) throw refused();
    return Buffer.from(open(wrappingKey(by.prf, "prf"), file.prf.key, at("prf"))).toString("base64") as DataKey;
  } catch {
    throw refused();
  }
}

// The restricted keys a wrapped file holds, opened by `by`. The opened names must be the listed ones.
export function unwrap(file: Wrapped, by: UnlockBy): { keys: Map<string, DataKey>; fileKey: DataKey } {
  const fileKey = fileKeyOf(file, by);
  let opened: Record<string, DataKey>;
  try {
    opened = JSON.parse(Buffer.from(open(fileKey, file.keys, at("keys"))).toString("utf8")) as Record<string, DataKey>;
  } catch {
    throw refused();
  }
  if (Object.keys(opened).sort().join() !== file.compartments.join()) throw new CodedError("format");
  return { keys: new Map(Object.entries(opened)), fileKey };
}

// The file with this credential's PRF slot, replacing any earlier one: one passkey at a time, as
// the dashboard keeps one.
export const withPrf = (file: Wrapped, fileKey: DataKey, credential: string, prf: Buffer): Wrapped => ({
  ...file,
  prf: { credential, key: seal(wrappingKey(prf, "prf"), Buffer.from(fileKey, "base64"), at("prf")) },
});

// The unlock a long-running process holds: the restricted keys, opened for `windowMs` from the
// unlock and forgotten at the first look after it. Nothing here reads or writes a file.
export type RestrictedUnlock = {
  unlock(keys: ReadonlyMap<string, DataKey>): Date;
  // The keys while the window is open, else none.
  held(): ReadonlyMap<string, DataKey>;
  until(): Date | null;
  lock(): void;
};

export function createRestrictedUnlock(now: Now, windowMs = UNLOCK_WINDOW_MS): RestrictedUnlock {
  let opened: { keys: ReadonlyMap<string, DataKey>; until: number } | null = null;
  const current = () => {
    if (opened !== null && now().getTime() >= opened.until) opened = null;
    return opened;
  };
  return {
    unlock(keys) {
      if (![...keys.keys()].every(isRestricted)) throw new CodedError("format");
      opened = { keys: new Map(keys), until: now().getTime() + windowMs };
      return new Date(opened.until);
    },
    held: () => current()?.keys ?? new Map(),
    until() {
      const held = current();
      return held === null ? null : new Date(held.until);
    },
    lock() {
      opened = null;
    },
  };
}

// `base` with the unlock's keys beside its own while the window is open, read afresh at each use,
// so a holder of the result (an Admin made once at the start) sees them come and go. A restricted
// compartment `base` names as locked stays locked until the unlock holds its key.
export function withUnlock(base: Keys, unlock: RestrictedUnlock): Keys {
  return {
    get compartments() {
      const held = unlock.held();
      return held.size === 0 ? base.compartments : new Map([...base.compartments, ...held]);
    },
    fingerprintKey: base.fingerprintKey,
    get locked() {
      const held = unlock.held();
      return new Set([...(base.locked ?? [])].filter((name) => !held.has(name)));
    },
  };
}

// The refusal for a compartment whose key is locked, or null when it is not.
export const lockedRefusal = (keys: Pick<Keys, "locked">, compartment: string): CodedError | null =>
  keys.locked?.has(compartment) === true ? new CodedError(RESTRICTED_LOCKED) : null;
