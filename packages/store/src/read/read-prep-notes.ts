import type { ClientView, PackItem, Who } from "@intelligence/contracts/personal";
import { organizationDomain } from "@intelligence/personal-core";
import type { PackTemplate } from "@intelligence/personal-core/views";
import { stamp } from "../core/db.ts";
import { type Ctx, Unavailable } from "../core/read-ctx.ts";
import { type AccountRow, served } from "../core/served.ts";
import { OWNER_ADDRESSES } from "./read-fragments.ts";
import { NOTES_LEFT_OUT, type RecordRow, recordItem, sectionOf } from "./read-pack-items.ts";

// meeting_prep@8: what the agents already found about the people in a
// meeting, where a call's purpose and its next move are usually the only place they are written. Every
// row is one the caller's token returns; a term is matched in the masked text the caller would be
// served, so a masked value is no oracle, and nothing is counted or ranked.

// How many of the newest notes and findings one pack opens, as find_records does for a text filter.
const PREP_NOTES_SCAN = 200;

// The last captured meeting with each person: a meeting linked to an event they were at, or one whose
// participant claims name them.
export const LAST_CAPTURES = `
  select e.entity_id, k.id, k.started_at, k.evidence_id
  from unnest($1::text[]) as e (entity_id)
  cross join lateral (
    select c.id, c.started_at, c.evidence_id
    from knowledge.captures c
    where c.kind = 'meeting' and c.started_at <= $2
      and (c.event_id in (select p.event_id from knowledge.event_participants p where p.entity_id = e.entity_id)
        or c.evidence_id in (
          select l.evidence_id from knowledge.claims l join knowledge.claim_entities n on n.claim_id = l.id
          where l.type = 'capture.person' and n.entity_id = e.entity_id))
    order by c.started_at desc, c.id
    limit 1
  ) k
  order by e.entity_id, k.id`;
export type LastCaptureRow = { entity_id: string; id: string; started_at: Date; evidence_id: string };

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wholeWords = (terms: readonly string[], flags: string): RegExp | null =>
  terms.length === 0
    ? null
    : new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.map(escaped).join("|")})(?![\\p{L}\\p{N}])`, flags);
const capital = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

// What a note says when it speaks of this person: the name as the system holds it, whole, and the
// address, in any case. One word alone can be an ordinary word ("Will"), as can an organization's, so
// those match only capitalized. Their organization, by its domain's first word, when it is no consumer
// mail domain and not one of the owner's own, since then every note would match.
function prepTerms(
  who: readonly Who[],
  ownDomains: ReadonlySet<string>,
): { names: string[]; words: string[]; orgs: string[] } {
  const names = new Set<string>();
  const words = new Set<string>();
  const orgs = new Set<string>();
  for (const one of who) {
    const name = one.name?.untrusted.trim();
    if (name !== undefined && name.length >= 3) (/\s/.test(name) ? names : words).add(name);
    const address = one.address?.untrusted;
    if (address === undefined || !address.includes("@")) continue;
    names.add(address);
    const domain = organizationDomain(address);
    const word = domain?.split(".")[0];
    if (domain !== null && !ownDomains.has(domain) && word !== undefined && word.length >= 3) orgs.add(capital(word));
  }
  return { names: [...names], words: [...words], orgs: [...orgs] };
}

// Of the newest notes and findings, those naming an attendee, then those naming only their
// organization, each newest first, at most the section's cap. Null when the template has no notes
// section or the client lacks its view.
export async function prepNotes(
  ctx: Ctx,
  client: ClientView,
  template: PackTemplate,
  who: readonly Who[],
): Promise<PackItem[]> {
  const section = sectionOf(template, "notes");
  if (!client.views.includes(section.view) || who.length === 0) return [];
  const own = await ctx.run<AccountRow>(OWNER_ADDRESSES, []);
  const ownDomains = new Set(
    own.flatMap((row) => organizationDomain(served(ctx, row, "knowledge.accounts.value_enc").untrusted) ?? []),
  );
  const terms = prepTerms(who, ownDomains);
  const names = wholeWords(terms.names, "iu");
  const words = wholeWords(terms.words, "u");
  const orgs = wholeWords(terms.orgs, "u");
  const rows = await ctx.run<RecordRow>(NOTES_LEFT_OUT, [PREP_NOTES_SCAN]);
  const named: RecordRow[] = [];
  const ofOrg: RecordRow[] = [];
  for (const row of rows) {
    // The second barrier of invariant 7, as the bootstrap's notes have it.
    if (!row.compartments.every((one) => client.compartments.includes(one))) throw new Unavailable();
    const whole = recordItem(ctx, row, "notes", false, undefined);
    const text = whole?.kind === "record" ? whole.record.body?.untrusted : undefined;
    if (text === undefined) continue;
    if (names?.test(text) === true || words?.test(text) === true) named.push(row);
    else if (orgs?.test(text) === true) ofOrg.push(row);
  }
  return [...named, ...ofOrg]
    .slice(0, section.cap)
    .flatMap((row) => recordItem(ctx, row, "notes", section.required, section.cutChars) ?? []);
}

export const capturePointer = (row: LastCaptureRow | undefined): { capture: string; at: string } | null =>
  row === undefined ? null : { capture: row.id, at: stamp(row.started_at) };
