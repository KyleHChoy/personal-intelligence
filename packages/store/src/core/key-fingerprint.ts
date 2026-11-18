import { createHmac } from "node:crypto";
import { isRestricted, OWN } from "@intelligence/contracts/personal";
import type { AdminContext } from "./admin-context.ts";
import { closeHealth, raiseHealth } from "./box-health.ts";
import { type Query, stamp } from "./db.ts";
import type { Keys } from "./keys.ts";
import { open, type Sealed, sealUnder, secretAt } from "./seal.ts";

// The key file's recorded identity. The key file opens everything, and a file that was swapped, damaged or put back from an older copy shows
// only when a read fails. So the box records, at its first start, which keys it holds, and compares at every start after.
//
// What is recorded is no key and nothing a key can be found from: for each key, the HMAC-SHA-256
// of a fixed text and the key's name, under that key. It says only "the same key as before" to
// someone who already holds the key. The record is one sealed row of policy.secrets under the
// `own` key, so nothing new is kept in clear; a record that no longer opens is itself a changed
// key. The restricted root is a second file that not every process reads, so its keys are left
// out: the record is of the general file alone.

const IDENTITY_TEXT = "pi-key-identity";
export const KEY_RECORD = "box/key-fingerprint";
const ABOUT = "key_file";

type KeyIdentity = { fingerprint: string; compartments: Record<string, string> };

const mark = (key: Buffer, name: string): string =>
  createHmac("sha256", key).update(`${IDENTITY_TEXT}\0${name}`).digest("hex");

export function keyIdentity(keys: Keys): KeyIdentity {
  const names = [...keys.compartments.keys()].filter((name) => !isRestricted(name)).sort();
  return {
    fingerprint: mark(keys.fingerprintKey, "fingerprint"),
    compartments: Object.fromEntries(
      names.map((name) => [name, mark(Buffer.from(keys.compartments.get(name) as string, "base64"), name)]),
    ),
  };
}

// What differs from the record: `fingerprint`, and each compartment whose key is another or is
// gone. A compartment the record lacks is a key added since, which is no change.
export function keyChanges(recorded: KeyIdentity, now: KeyIdentity): string[] {
  const changed = Object.entries(recorded.compartments)
    .filter(([name, was]) => now.compartments[name] !== was)
    .map(([name]) => name);
  return [...(recorded.fingerprint === now.fingerprint ? [] : ["fingerprint"]), ...changed.sort()];
}

const isIdentity = (value: unknown): value is KeyIdentity => {
  if (typeof value !== "object" || value === null) return false;
  const { fingerprint, compartments } = value as Record<string, unknown>;
  return (
    typeof fingerprint === "string" &&
    typeof compartments === "object" &&
    compartments !== null &&
    Object.values(compartments).every((one) => typeof one === "string")
  );
};

// The record as it opens under the keys held now, or null when it does not.
function recordOf(keys: Keys, sealed: Sealed): KeyIdentity | null {
  const text = open(
    keys,
    { id: KEY_RECORD, compartments: [OWN], value_enc: sealed },
    "policy.secrets.value_enc",
    "null",
  );
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isIdentity(value) ? value : null;
  } catch {
    return null;
  }
}

const write = (query: Query, context: AdminContext, identity: KeyIdentity): Promise<unknown> =>
  query(
    `insert into policy.secrets (name, value_enc, updated_at) values ($1, $2, $3)
     on conflict (name) do update set value_enc = excluded.value_enc, updated_at = excluded.updated_at`,
    [
      KEY_RECORD,
      sealUnder(context.keys, ["own"], secretAt(KEY_RECORD), JSON.stringify(identity)),
      stamp(context.now()),
    ],
  );

export type KeyCheck = "recorded" | "same" | "added" | "changed";

// Admin.checkKeys (`pi health keys`, the timer's at each start): `recorded` the first time, `same`,
// `added` when the file holds keys the record lacked (the record takes them), or `changed`, which
// raises one `key_changed` box health card and logs how many keys differ, never which or what. A
// check that finds the keys as recorded closes the card.
export function checkKeys(context: AdminContext): Promise<KeyCheck> {
  const now = keyIdentity(context.keys);
  return context.transaction(async (query) => {
    const [row] = await query<{ value_enc: Sealed }>(
      "select value_enc from policy.secrets where name = $1 for update",
      [KEY_RECORD],
    );
    if (row === undefined) {
      await write(query, context, now);
      return "recorded";
    }
    const recorded = recordOf(context.keys, row.value_enc);
    const changed = recorded === null ? ["own"] : keyChanges(recorded, now);
    if (recorded === null || changed.length > 0) {
      await raiseHealth(query, context.now(), context.log, "key_changed", ABOUT);
      context.log.error({ event: "key_file_changed", code: "key_changed", counts: { keys: changed.length } });
      return "changed";
    }
    await closeHealth(query, context.now(), "key_changed", ABOUT);
    if (Object.keys(now.compartments).every((name) => name in recorded.compartments)) return "same";
    await write(query, context, now);
    return "added";
  });
}

// Admin.acceptKeys (`pia keys accept-fingerprint`): the owner's word that the key file changed on
// purpose. The record becomes the keys held now, and the card is closed.
export function acceptKeys(context: AdminContext): Promise<void> {
  return context.transaction(async (query) => {
    await write(query, context, keyIdentity(context.keys));
    await closeHealth(query, context.now(), "key_changed", ABOUT);
  });
}
