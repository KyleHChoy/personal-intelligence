import { byText } from "../core/db.ts";
import { open, type Sealed } from "../core/seal.ts";
import type { Tx } from "../core/tx.ts";

// The people's names and addresses the pseudonymiser replaces before a model call, read through
// policy.known_identities() under the owner's clearance and opened with this role's keys. A value
// that holds an address is an address, one written as a phone number a phone, and any other a
// handle. Each list is sorted and holds each value once. Nothing here is logged.
const PHONE = /^\+?[\d\s().-]{7,}$/;

export async function knownIdentitiesOf(
  tx: Tx,
): Promise<{ names: string[]; addresses: string[]; phones: string[]; handles: string[] }> {
  const rows = await tx.query<{ source: "alias" | "account"; id: string; value_enc: Sealed; compartments: string[] }>(
    "select source, id, value_enc, compartments from policy.known_identities()",
  );
  const names = new Set<string>();
  const addresses = new Set<string>();
  const phones = new Set<string>();
  const handles = new Set<string>();
  for (const row of rows) {
    // A label this process holds no key for is skipped: its value cannot be in what it sends.
    if (!row.compartments.every((compartment) => tx.keys.compartments.has(compartment))) continue;
    const table = row.source === "alias" ? "knowledge.aliases" : "knowledge.accounts";
    const value = open(tx.keys, row, `${table}.value_enc`, "throw");
    if (row.source === "alias") names.add(value);
    else if (value.includes("@")) addresses.add(value);
    else if (PHONE.test(value)) phones.add(value);
    else handles.add(value);
  }
  const sorted = (values: Set<string>) => [...values].sort(byText);
  return { names: sorted(names), addresses: sorted(addresses), phones: sorted(phones), handles: sorted(handles) };
}
