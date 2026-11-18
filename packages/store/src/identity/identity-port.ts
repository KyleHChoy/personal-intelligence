import { type IdentityResolver, LocalEntityId, type Resolution } from "@intelligence/contracts";
import type { AccountKind } from "@intelligence/contracts/personal";
import { foldDomain, isProfileKey, normalizeAddress, organizationDomain } from "@intelligence/personal-core";
import { addressKind } from "@intelligence/personal-core/items";
import { makesPerson, markOf } from "../core/account-kinds.ts";
import type { Query } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import { open, type Sealed, sealUnder } from "../core/seal.ts";
import { OWNER_ENTITY } from "../core/statements.ts";
import type { Tx } from "../core/tx.ts";
import { localPartNames } from "./identity-bases.ts";

// The owner, the owner's addresses, and the identity port. An address finds its entity only by
// exact fingerprint. Every row takes the label of the item that showed it: its source compartment,
// and the restricted ones the screen added, so an address seen in an own message and a restricted
// one has a row under each.

// Two labels are one when they hold the same compartments.
export const sameLabel = (a: readonly string[], b: readonly string[]): boolean =>
  [...a].sort().join("\n") === [...b].sort().join("\n");

export const domainOf = (address: string): string => address.slice(address.indexOf("@") + 1);

// The one owner entity, made the first time it is asked for.
export async function ownerEntity(tx: Tx): Promise<LocalEntityId> {
  await tx.query(
    "insert into knowledge.entities (id, kind) values ($1, 'owner') on conflict (kind) where kind = 'owner' do nothing",
    [newId("ent")],
  );
  const [owner] = await tx.query<{ id: string }>(OWNER_ENTITY);
  return LocalEntityId.parse(owner?.id);
}

// Every owner address, under every label, normalized.
export async function ownerAddresses(tx: Tx): Promise<string[]> {
  const rows = await tx.query<{ id: string; compartments: string[]; value_enc: Sealed }>(
    `select a.id, a.compartments, a.value_enc from knowledge.accounts a
     join knowledge.entities e on e.id = a.entity_id where e.kind = 'owner' order by a.id`,
  );
  const addresses = rows.map((row) => open(tx.keys, row, "knowledge.accounts.value_enc", "throw"));
  return [...new Set(addresses)];
}

// It is answered from fingerprints of that one account, and nothing sealed is read or opened. An
// absent address, and one that does not normalize, is not written to. Mail read by its headers
// alone counts only for another such item (`withHeaders`): having answered someone years ago must
// not lift what sync stores in full and extracts from them today.
export async function writtenTo(
  tx: Tx,
  accountId: string,
  sender: string | undefined,
  withHeaders = false,
): Promise<boolean> {
  const address = sender === undefined ? null : normalizeAddress(sender);
  if (address === null) return false;
  const [row] = await tx.query<{ written: boolean }>(
    `select exists (
       select 1 from vault.sent_recipients r join vault.evidence_items e on e.id = r.evidence_id
       where r.account_id = $1 and r.address_fp = $2 and ($3 or not e.headers_only)) as written`,
    [accountId, fingerprint(tx.keys, "address", address), withHeaders],
  );
  return row?.written === true;
}

export async function suppressedFps(tx: Tx, fps: readonly string[]): Promise<Set<string>> {
  if (fps.length === 0) return new Set();
  const rows = await tx.query<{ fp: string }>(
    "select value_fp as fp from knowledge.suppressions where kind = 'address' and value_fp = any($1)",
    [fps],
  );
  return new Set(rows.map((row) => row.fp));
}

// Whether the owner's erasure suppressed any of these keys, of any kind (an address, a profile
// key, a name or an organization's name key).
export async function anySuppressed(query: Query, fps: readonly string[]): Promise<boolean> {
  const [row] = await query<{ yes: boolean }>(
    "select exists (select 1 from knowledge.suppressions where value_fp = any($1::text[])) as yes",
    [fps],
  );
  return row?.yes === true;
}

// Whether the owner's erasure of a person suppressed this address. One that does not normalize is not.
export async function suppressedAddress(tx: Tx, value: string): Promise<boolean> {
  const address = keyOf(value);
  return address !== null && (await suppressedFps(tx, [fingerprint(tx.keys, "address", address)])).size > 0;
}

// One account row for an address under a label, of its kind, unless that entity already has it.
async function addAccount(
  tx: Tx,
  entity: string,
  address: string,
  label: string[],
  kind: AccountKind = "email",
): Promise<void> {
  const id = newId("adr");
  await tx.query(
    `insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, value_enc, compartments, local_name_fps)
     values ($1, $2, $7, $3, $4, $5, $6, $8)
     on conflict (value_fp, compartments, entity_id) do nothing`,
    [
      id,
      entity,
      fingerprint(tx.keys, "address", address),
      // Under the address's registrable domain, the key its organization's domain row has. A
      // profile key has no domain: its own key stands in, so it names no organization and no domain
      // ruling reaches it.
      fingerprint(tx.keys, "domain", isProfileKey(address) ? address : foldDomain(domainOf(address))),
      sealUnder(tx.keys, label, { table: "knowledge.accounts", id, column: "value_enc" }, address),
      label,
      kind,
      // The full names its local part spells, fingerprinted, so ledger.policy_merge can check the
      // local-part basis without opening the address.
      localNameFps(tx, address),
    ],
  );
}

export const localNameFps = (tx: Pick<Tx, "keys">, address: string): string[] =>
  [...new Set(localPartNames(address).map((name) => fingerprint(tx.keys, "name", name)))].sort();

// An owner address under a label: an account row of the owner entity, and no domain row. It
// rewrites nothing itself: a person who held the address keeps its rows until a re-derive, which
// the owner's `add-address` runs in its own transaction and a sync runs at its end. Until then
// every reader withholds that person (policy.entity_withheld).
export async function addOwnerAddress(tx: Tx, address: string, label: string[]): Promise<void> {
  await addAccount(tx, await ownerEntity(tx), address, label);
}

// The addresses given that normalize, each once, as owner addresses under the account's
// compartment; returns how many.
export async function addOwnerAddresses(tx: Tx, compartment: string, given: readonly string[]): Promise<number> {
  const addresses = [...new Set(given.flatMap((one) => normalizeAddress(one) ?? []))].sort();
  for (const address of addresses) await addOwnerAddress(tx, address, [compartment]);
  return addresses.length;
}

// Each account with no local_name_fps gets them, from its opened address; only where still null,
// so a second run changes nothing.
export async function backfillLocalNames(tx: Tx): Promise<{ filled: number }> {
  const rows = await tx.query<{ id: string; value_enc: Sealed; compartments: string[] }>(
    "select id, value_enc, compartments from knowledge.accounts where local_name_fps is null order by id",
  );
  let filled = 0;
  for (const row of rows) {
    let address: string;
    try {
      address = open(tx.keys, row, "knowledge.accounts.value_enc", "throw");
    } catch {
      // An address whose key this process lacks keeps none: its local-part pairs are carded.
      continue;
    }
    filled += (
      await tx.query(
        "update knowledge.accounts set local_name_fps = $2 where id = $1 and local_name_fps is null returning id",
        [row.id, localNameFps(tx, address)],
      )
    ).length;
  }
  return { filled };
}

// The ids a re-derive keeps: a person's by its address fingerprint, an organization's by its domain
// fingerprint. Absent outside a re-derive.
export type KeptIds = { people: ReadonlyMap<string, string>; organizations: ReadonlyMap<string, string> };

// The domain row of an organization domain under a label, pointing at the domain's
// organization, which is made when no label has the domain yet: under the id it had before a
// re-derive, when it had one.
async function addDomain(tx: Tx, domain: string, label: string[], kept?: KeptIds): Promise<void> {
  const domainFp = fingerprint(tx.keys, "domain", domain);
  const rows = await tx.query<{ entity_id: string; compartments: string[] }>(
    "select entity_id, compartments from knowledge.domains where domain_fp = $1 order by id",
    [domainFp],
  );
  if (rows.some((row) => sameLabel(row.compartments, label))) return;
  let organization = rows[0]?.entity_id;
  if (organization === undefined) {
    organization = kept?.organizations.get(domainFp) ?? newId("ent");
    await tx.query("insert into knowledge.entities (id, kind) values ($1, 'organization')", [organization]);
  }
  const id = newId("dom");
  await tx.query(
    "insert into knowledge.domains (id, domain_fp, entity_id, domain_enc, compartments) values ($1, $2, $3, $4, $5)",
    [
      id,
      domainFp,
      organization,
      sealUnder(tx.keys, label, { table: "knowledge.domains", id, column: "domain_enc" }, domain),
      label,
    ],
  );
}

const NOT_A_PERSON: Resolution = { outcome: "not_a_person" };

// An identifier as the port keys it: an address normalized, or a profile-only imported row's
// LinkedIn key, checked for its exact shape. Null for neither.
const keyOf = (value: string): string | null => (isProfileKey(value) ? value : normalizeAddress(value));

// The identity port for one transaction. `requestId` is not read. A database error rejects. An answer
// is given when asked, but a person's account and domain rows are written by `write`, under the item's
// label, once the facts have decided it: nothing is written under the source compartment alone first.
// An address asked twice is answered once.
export function identityPort(
  tx: Tx,
  kept?: KeptIds,
): { resolver: IdentityResolver; resolved: Set<string>; write(label: string[]): Promise<void> } {
  const resolved = new Set<string>();
  const answered = new Map<string, Resolution>();
  // The rows to write: each address, its entity, and the labels its rows already have.
  const pending: { entity: string; address: string; kind: AccountKind; labels: string[][] }[] = [];
  const resolver: IdentityResolver = {
    async resolve(mention, store) {
      if (store !== "people" || mention.key.kind !== "address") return NOT_A_PERSON;
      const address = keyOf(mention.key.value);
      if (address === null) return NOT_A_PERSON;
      const known = answered.get(address);
      if (known !== undefined) return known;
      const answer = await answerFor(address);
      // Asked again, the person is known: linked, as a second lookup of its row would say.
      answered.set(address, answer.outcome === "created" ? { ...answer, outcome: "linked" } : answer);
      return answer;
    },
  };
  async function answerFor(address: string): Promise<Resolution> {
    const addressFp = fingerprint(tx.keys, "address", address);
    const holders = await tx.query<{ entity_id: string; kind: string; compartments: string[] }>(
      `select a.entity_id, e.kind, a.compartments from knowledge.accounts a
       join knowledge.entities e on e.id = a.entity_id where a.value_fp = $1 order by a.id`,
      [addressFp],
    );
    // An owner address is the owner's, even while a person's row still holds it.
    const owner = holders.find((row) => row.kind === "owner");
    if (owner !== undefined) return { outcome: "linked", entity: LocalEntityId.parse(owner.entity_id), epoch: 0 };
    if (await suppressedAddress(tx, address)) return NOT_A_PERSON;
    // A role or bulk address makes no person and no organization, also when an earlier person still holds it: that
    // one is reclassified, never extended. A shared one keeps its entity. A profile key is a person's: no list or
    // mark reads it.
    const kind = isProfileKey(address) ? "email" : addressKind(address, await markOf(tx.query, addressFp));
    if (!makesPerson(kind)) return NOT_A_PERSON;

    const known = holders[0]?.entity_id;
    const entity = known ?? kept?.people.get(addressFp) ?? newId("ent");
    if (known === undefined)
      await tx.query("insert into knowledge.entities (id, kind) values ($1, 'person')", [entity]);
    pending.push({ entity, address, kind, labels: holders.map((row) => row.compartments) });
    resolved.add(entity);
    return { outcome: known === undefined ? "created" : "linked", entity: LocalEntityId.parse(entity), epoch: 0 };
  }
  // The first time an address is seen under this label: its account row, and its domain's.
  async function write(label: string[]): Promise<void> {
    for (const { entity, address, kind, labels } of pending.splice(0)) {
      if (labels.some((one) => sameLabel(one, label))) continue;
      await addAccount(tx, entity, address, label, kind);
      const domain = organizationDomain(address);
      if (domain !== null) await addDomain(tx, domain, label, kept);
    }
  }
  return { resolver, resolved, write };
}
