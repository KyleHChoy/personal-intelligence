import type { CardId, NewCard } from "@intelligence/contracts/personal";
import { CARD_OPTIONS } from "@intelligence/contracts/personal";
import { foldDomain } from "@intelligence/personal-core";
import { ignoreNarrowedCase } from "../cards/case-keys.ts";
import { byText, stamp } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { newId, requestIdOf } from "../core/ids.ts";
import { raiseCard } from "../core/queue.ts";
import { open, type Sealed } from "../core/seal.ts";
import { IDENTITY_AUTHOR } from "../core/statements.ts";
import type { Tx } from "../core/tx.ts";
import { domainOf } from "./identity-port.ts";

// An ignored domain survives a refold. A domain ignore ruling holds the keyed fingerprints of
// folded domains, and a fold is the public suffix list's: when the vendored list changes, a
// re-derive keys every account and domain row by the new fold, and a ruling keyed by the old one
// would match nothing, silently. So, before a re-derive deletes the rows, each live domain ruling's
// fingerprints are looked up among the accounts that hold them, each account's address is opened
// and folded again, and the ruling gains the fingerprint of every new fold. It keeps the old ones:
// a domain that folds to an old key under the new list is a subdomain of a domain the ruling
// already covered, so the ruling never covers what it did not. Under an unchanged list every new
// fold is an old one and nothing is written. A ruling none of whose fingerprints an account holds,
// and that covers no address, is left as it is and counted: nothing it covers was ever stored, so
// the owner adds it again if they want it under the new list. A holder whose new fold is above the
// old key (the new registrable domain is a parent of it) is neither left out nor widened to
// (invariant 11): the ruling gains that holder's address fingerprint in `address_fps`, so the veto
// stays exactly in force on every address it covered, and system:identity raises one
// `ignore_narrowed` card naming the ruling, so the owner knows the domain ignore now covers those
// addresses alone, and which new domain to ignore to cover all of it again (its body, the folds, as
// the addresses gave them). A ruling holds at most MAX_IGNORED of each.

const MAX_IGNORED = 1000;

const LIVE = `
  select ruling_id, value_fps, address_fps from knowledge.ignore_rulings
  where lifted_at is null and subject = 'domain'
  order by ruling_id`;

const HOLDERS = `
  select a.id, a.domain_fp, a.value_fp, a.compartments, a.value_enc from knowledge.accounts a
  where a.domain_fp = any($1)
  order by a.id`;

// Each domain key given, mapped to the keys its holders' addresses fold to under the list now:
// `finer`, a fold equal to the old one or under it, and `coarser`, one above it, which would cover
// more than the old key did. The old fold is found among the address's domain and its parents by
// its fingerprint; an address none of whose suffixes has it counts as coarser, so a key is never
// widened on a guess. A coarser holder keeps its new fold, its address's fingerprint, its account's
// compartments and the new fold's own words.
type Coarser = { fold: string; address: string; compartments: string[]; domain: string };
type Folds = { finer: Set<string>; coarser: Coarser[] };
async function foldsOf(tx: Tx, fps: readonly string[]): Promise<Map<string, Folds>> {
  const now = new Map<string, Folds>();
  for (const row of await tx.query<{
    id: string;
    domain_fp: string;
    value_fp: string;
    compartments: string[];
    value_enc: Sealed;
  }>(HOLDERS, [[...new Set(fps)]])) {
    const address = open(tx.keys, row, "knowledge.accounts.value_enc", "throw");
    const domain = domainOf(address);
    const fold = foldDomain(domain);
    const labels = domain.split(".");
    const old = labels
      .map((_, at) => labels.slice(at).join("."))
      .find((suffix) => fingerprint(tx.keys, "domain", suffix) === row.domain_fp);
    const folds = now.get(row.domain_fp) ?? { finer: new Set<string>(), coarser: [] };
    if (old !== undefined && fold.length >= old.length) folds.finer.add(fingerprint(tx.keys, "domain", fold));
    else
      folds.coarser.push({
        fold: fingerprint(tx.keys, "domain", fold),
        address: row.value_fp,
        compartments: row.compartments,
        domain: fold,
      });
    now.set(row.domain_fp, folds);
  }
  return now;
}

// `rulings`: each ruling to write, with all its domain and address fingerprints. `narrowed`: the
// rulings that gain addresses because a new fold is coarser, each with the compartments of the
// accounts it now covers by address and the new domains they fold to, for its card; `coarser`
// counts them.
type IgnoreRekey = {
  rulings: { id: string; fps: string[]; addressFps: string[] }[];
  narrowed: { id: string; compartments: string[]; domains: string[] }[];
  unmatched: number;
  coarser: number;
};

// What a refold would write: each live domain ruling whose fingerprints grow, with all of them,
// and how many rulings no stored account holds a fingerprint of. It reads and opens; it writes
// nothing.
export async function ignoreRekeys(tx: Tx): Promise<IgnoreRekey> {
  const live = await tx.query<{ ruling_id: string; value_fps: string[]; address_fps: string[] }>(LIVE);
  if (live.length === 0) return { rulings: [], narrowed: [], unmatched: 0, coarser: 0 };
  const now = await foldsOf(
    tx,
    live.flatMap((one) => one.value_fps),
  );
  const rulings: IgnoreRekey["rulings"] = [];
  const narrowed: IgnoreRekey["narrowed"] = [];
  let unmatched = 0;
  for (const one of live) {
    // A ruling that covers addresses still covers what was stored.
    if (!one.value_fps.some((fp) => now.has(fp)) && one.address_fps.length === 0) unmatched += 1;
    const grown = one.value_fps
      .flatMap((fp) => [...(now.get(fp)?.finer ?? [])])
      .filter((fp) => !one.value_fps.includes(fp));
    // A holder whose coarser fold the ruling does not already cover keeps its veto by address.
    const above = one.value_fps
      .flatMap((fp) => now.get(fp)?.coarser ?? [])
      .filter((holder) => !one.value_fps.includes(holder.fold));
    const addresses = [...new Set(above.map((holder) => holder.address))]
      .filter((fp) => !one.address_fps.includes(fp))
      .sort(byText);
    if (addresses.length > 0)
      narrowed.push({
        id: one.ruling_id,
        compartments: [...new Set(above.flatMap((holder) => holder.compartments))].sort(),
        domains: [...new Set(above.map((holder) => holder.domain))].sort(),
      });
    if (grown.length === 0 && addresses.length === 0) continue;
    rulings.push({
      id: one.ruling_id,
      fps: [...one.value_fps, ...[...new Set(grown)].sort(byText)].slice(0, MAX_IGNORED),
      addressFps: [...one.address_fps, ...addresses].slice(0, MAX_IGNORED),
    });
  }
  return { rulings, narrowed, unmatched, coarser: narrowed.length };
}

// The owner's card for a narrowed ruling: the ruling by its case key, and the new domains to ignore
// as its body, sealed under the accounts' compartments; one line a domain. One undecided card per
// ruling, by its case key.
const narrowedCard = (one: { id: string; compartments: string[]; domains: string[] }, now: Date): NewCard => ({
  id: newId("crd") as CardId,
  requestId: requestIdOf(`ignore_narrowed:${one.id}:${stamp(now)}`),
  kind: "ignore_narrowed",
  author: IDENTITY_AUTHOR,
  options: [...CARD_OPTIONS.ignore_narrowed],
  target: null,
  refs: [],
  compartments: one.compartments,
  expiresAt: null,
  expiresAfterDays: null,
  caseKey: ignoreNarrowedCase(one.id),
  run: null,
  body: one.domains.join("\n"),
  bodyFrom: "source",
});

// The rekeys written, each to a ruling still in force, and a card for each ruling narrowed. A
// re-derive calls this after its taint lock (rederive.ts), the one order in which the owner's
// lift, which takes the shared taint lock before the ruling's row, cannot wait on it while it
// waits on the lift.
export async function rekeyIgnores(tx: Tx, rekey: IgnoreRekey, now: Date = new Date()): Promise<void> {
  for (const one of rekey.rulings) {
    await tx.query(
      "update knowledge.ignore_rulings set value_fps = $2, address_fps = $3 where ruling_id = $1 and lifted_at is null",
      [one.id, one.fps, one.addressFps],
    );
  }
  for (const one of rekey.narrowed) await raiseCard(tx.query, narrowedCard(one, now), { now, keys: tx.keys });
}

// ---------------------------------------------------------------------------------------------
// Organization names: the owner's name for an organization is keyed by its folded domain's
// fingerprint, so a refold moves it the same way. Each live name's key is looked up among the
// accounts that hold it and each address folded again: a name whose key is still one of the new
// folds stays; one whose addresses all fold to one new key moves to it, unless a name that stays on
// its key is there or a newer one moves there first (the owner's latest naming wins). A name no
// stored account holds the key of, one whose addresses now fold to several keys or to a coarser
// one, and one that loses to another are left on their key and counted: the owner names that
// organization again if they want it named under the new list. Every name left on its key holds it,
// so no name moves onto it. Nothing is opened but the addresses, and no name is lifted.
// ---------------------------------------------------------------------------------------------

const LIVE_NAMES = `
  select id, domain_fp from knowledge.organization_names
  where lifted_at is null
  order by created_at desc, id`;

type NameRekey = { names: { id: string; fp: string }[]; unmatched: number; coarser: number };

// What a refold would write; it reads and opens, and writes nothing.
export async function nameRekeys(tx: Tx): Promise<NameRekey> {
  const live = await tx.query<{ id: string; domain_fp: string }>(LIVE_NAMES);
  if (live.length === 0) return { names: [], unmatched: 0, coarser: 0 };
  const folds = await foldsOf(
    tx,
    live.map((one) => one.domain_fp),
  );
  let coarser = 0;
  let unmatched = 0;
  // The names that could move, newest first: each whose holders all fold to one key under its
  // old one. A name moves only to a fold under its old key, never to one that covers more.
  let moving: NameRekey["names"] = [];
  for (const one of live) {
    const of = folds.get(one.domain_fp);
    if (of?.finer.has(one.domain_fp) === true) continue;
    if ((of?.coarser.length ?? 0) > 0) {
      coarser += 1;
      continue;
    }
    const [fp, ...more] = [...(of?.finer ?? [])];
    if (fp === undefined || more.length > 0) unmatched += 1;
    else moving.push({ id: one.id, fp });
  }
  // Every name that does not move holds its key. A moving name that lands on a held key, or on
  // one a newer moving name took, stays, and then holds its own key too, which may turn back a
  // move already accepted onto it: so again, until every move is accepted. Each round drops one
  // name or more, so it ends.
  for (;;) {
    const goes = new Set(moving.map((one) => one.id));
    const taken = new Set(live.filter((one) => !goes.has(one.id)).map((one) => one.domain_fp));
    const accepted = moving.filter((one) => {
      if (taken.has(one.fp)) return false;
      taken.add(one.fp);
      return true;
    });
    if (accepted.length === moving.length) break;
    unmatched += moving.length - accepted.length;
    moving = accepted;
  }
  return { names: moving, unmatched, coarser };
}

// In two steps: each moving name first to a key of its own that is no
// domain's, then to its new key, so a name moving onto a key another moving name leaves never
// meets it in the one-live-name index, whatever their order.
export async function rekeyNames(tx: Tx, rekey: NameRekey): Promise<void> {
  if (rekey.names.length === 0) return;
  const ids = rekey.names.map((one) => one.id);
  await tx.query(
    "update knowledge.organization_names set domain_fp = encode(sha256(convert_to('moving ' || id, 'UTF8')), 'hex') where id = any($1) and lifted_at is null",
    [ids],
  );
  await tx.query(
    "update knowledge.organization_names n set domain_fp = m.fp from unnest($1::text[], $2::text[]) as m (id, fp) where n.id = m.id and n.lifted_at is null",
    [ids, rekey.names.map((one) => one.fp)],
  );
}
