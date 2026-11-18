import { BELIEF_TYPES, type ClaimRecord } from "@intelligence/contracts/personal";
import { beliefsFor } from "@intelligence/personal-beliefs";
import type { Query } from "../core/db.ts";
import { byText } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import type { Keys } from "../core/keys.ts";
import { OWNER_ENTITY } from "../core/statements.ts";
import { readBeliefInputsUnder } from "./belief-inputs.ts";
import type { keyedClaim } from "./code-relations.ts";

// The owner's own claims for the relation step and the dream pass. Extraction never links a claim to
// the owner (a claim's entities leave the owner out), so the owner's own claims are the belief-type
// claims linked to no entity.
// A claim as the relation step holds it: its row and its opened record.
export type Held = { row: Parameters<typeof keyedClaim>[1]; record: ClaimRecord };

export const UNLINKED = "not exists (select 1 from knowledge.claim_entities x where x.claim_id = c.id)";

// The belief inputs read takes at most this many fact keys a call.
const KEYS_A_READ = 200;
// How long the owner's current claims, read once, serve the subjects a pass asks for.
const OWNER_SUPPORT_MS = 10 * 60 * 1000;
const SHOWN_STATUS: ReadonlySet<string> = new Set(["closed", "expired"]);

// An owner's claim is weighed only against the owner's claims of its life domain, or of its type when it
// has none: the owner holds hundreds of claims, and a goal against a home address is never a relation.
export const groupOf = (one: Held): string => {
  const domain = one.record.claim.content.fields.domain;
  return typeof domain === "string" && domain !== "" ? `domain:${domain}` : `type:${one.record.claim.content.type}`;
};

export function ownerSupport(deps: {
  query: Query;
  keys: Keys;
  claimsById: (ids: readonly string[]) => Promise<Held[]>;
}): {
  ownerId(): Promise<string | null>;
  // The owner's current claims of `claim`'s group, newest first, the first `cap` of other items, each
  // read again so a claim released or removed since is left out; none when `claim` is in no current
  // belief of the owner's (it has nothing to settle).
  // `skip`: claims left out before the cap.
  candidates(
    claim: Held,
    owner: readonly string[],
    now: string,
    cap: number,
    skip?: ReadonlySet<string>,
  ): Promise<Held[]>;
} {
  const { query, keys, claimsById } = deps;
  let idRead: Promise<string | null> | null = null;
  const ownerId = (): Promise<string | null> =>
    (idRead ??= query<{ id: string }>(OWNER_ENTITY).then(([row]) => row?.id ?? null));

  let cache: { at: number; ids: Set<string>; factKeys: Set<string>; byGroup: Map<string, Held[]> } | null = null;
  async function read(owner: readonly string[], now: string, fresh: boolean) {
    if (cache !== null && !fresh && Date.now() - cache.at < OWNER_SUPPORT_MS) return cache;
    const factKeys = (
      await query<{ fact_key_fp: string }>(
        `select distinct c.fact_key_fp from knowledge.claims c
         where c.type = any ($1::text[]) and c.compartments <@ $2::text[] and not c.released and not c.closes and ${UNLINKED}
         order by 1`,
        [[...BELIEF_TYPES], owner],
      )
    ).map((row) => row.fact_key_fp);
    const ids = new Set<string>();
    for (let at = 0; at < factKeys.length; at += KEYS_A_READ) {
      const page = factKeys.slice(at, at + KEYS_A_READ);
      const inputs = await readBeliefInputsUnder(query, keys, owner, page, now);
      for (const one of beliefsFor(inputs, owner, now, page).rows)
        if (!SHOWN_STATUS.has(one.belief.status))
          // A belief cites its claims by the claim's own id; the row's id is its keyed fingerprint.
          for (const id of one.belief.support) ids.add(fingerprint(keys, "claim", id));
    }
    const byGroup = new Map<string, Held[]>();
    for (const one of await claimsById([...ids]))
      byGroup.set(groupOf(one), [...(byGroup.get(groupOf(one)) ?? []), one]);
    for (const group of byGroup.values())
      group.sort((a, b) => byText(b.record.claim.validFrom, a.record.claim.validFrom) || byText(a.row.id, b.row.id));
    cache = { at: Date.now(), ids, factKeys: new Set(factKeys), byGroup };
    return cache;
  }

  return {
    ownerId,
    async candidates(claim, owner, now, cap, skip = new Set()) {
      let mine = await read(owner, now, false);
      // Not in what was read: settled when its fact key was read (it supports no current belief) or when
      // it is linked to an entity (not the owner's own); otherwise it is newer than the read, read again.
      if (!mine.ids.has(claim.row.id) && !mine.factKeys.has(claim.row.fact_key_fp)) {
        const [linked] = await query<{ id: string }>(
          "select claim_id as id from knowledge.claim_entities where claim_id = $1 limit 1",
          [claim.row.id],
        );
        if (linked === undefined) mine = await read(owner, now, true);
      }
      if (!mine.ids.has(claim.row.id)) return [];
      const ids = (mine.byGroup.get(groupOf(claim)) ?? [])
        .filter(
          (one) =>
            one.row.id !== claim.row.id && one.row.evidence_id !== claim.row.evidence_id && !skip.has(one.row.id),
        )
        .slice(0, cap)
        .map((one) => one.row.id);
      const order = new Map(ids.map((id, at) => [id, at]));
      return (await claimsById(ids)).sort((a, b) => (order.get(a.row.id) ?? 0) - (order.get(b.row.id) ?? 0));
    },
  };
}
