import {
  ClaimRecord,
  LinkKind,
  OWNER_WORDS,
  type OwnerWordsView,
  PERSON_LINKS,
  type PersonLinkView,
} from "@intelligence/contracts/personal";
import { type Ctx, Unavailable } from "../core/read-ctx.ts";
import type { SealedRow } from "../core/seal.ts";
import { servedJson } from "../core/served.ts";

// What get_entity serves of a person beside a saved contact's details, from the
// same contacts detailsOf reads (the owner's own, `own`, newest first, at most DETAIL_CONTACTS):
// their `link` claims about the person (claims are the authority), and the owner's own words about
// the person in an imported contact's tags and notes, which are in no claim. Every value is
// wrapped as untrusted; nothing here is fetched or followed.

// The link claims of the given contacts' evidence that name one of the members, newest first.
// Always one statement, whatever the contacts were, so a read sends the same statements for every
// person; the row policy returns only claims of the caller's own labels.
const LINKS = `
  select c.id, c.compartments, c.content_enc, c.evidence_id
  from knowledge.claims c
  where c.type = 'link' and c.evidence_id = any($1)
    and exists (select 1 from knowledge.claim_entities n where n.claim_id = c.id and n.entity_id = any($2))
  order by c.valid_from desc, c.id`;

// Each URL once, the newest claim's, at most PERSON_LINKS; `bound`, the evidence of each served,
// which the read log binds as find_facts binds a contact's claim.
export async function linksOf(
  ctx: Ctx,
  evidence: readonly string[],
  members: readonly string[],
): Promise<{ links: PersonLinkView[]; bound: string[] }> {
  const rows = await ctx.run<SealedRow<"knowledge.claims.content_enc"> & { evidence_id: string }>(LINKS, [
    evidence,
    members,
  ]);
  const links: PersonLinkView[] = [];
  const bound = new Set<string>();
  for (const row of rows) {
    if (links.length >= PERSON_LINKS) break;
    const parsed = ClaimRecord.safeParse(servedJson(ctx, row, "knowledge.claims.content_enc"));
    if (!parsed.success) throw new Unavailable();
    const { url, kind, label } = parsed.data.claim.content.fields as Record<string, unknown>;
    const linkKind = LinkKind.safeParse(kind);
    if (typeof url !== "string" || !linkKind.success) throw new Unavailable();
    if (links.some((one) => one.url.untrusted === url)) continue;
    links.push({
      disclosure: "use_only",
      url: { untrusted: url },
      kind: linkKind.data,
      label: typeof label === "string" ? { untrusted: label } : null,
    });
    bound.add(row.evidence_id);
  }
  return { links, bound: [...bound] };
}

// What an imported contact's sealed facts hold of the owner's words (contact-import.ts' extras).
export type SealedWords = {
  imported?: { tags?: { key: string; value: string }[]; notes?: (string | { key: string; value: string })[] };
};

// A value's code points at most, and the values' together: a note may hold 5 000, and every entity
// view (a card, a pack's person, a mirror entry) must stay bounded however many the contacts hold.
export const OWNER_WORD_CODE_POINTS = 1_000;
export const OWNER_WORDS_CODE_POINTS = 8_000;
// A key (a column's header) at most this many code points: a long header is served in a short form,
// so it never crowds out its value.
export const OWNER_WORD_KEY_CODE_POINTS = 60;

// The owner's tags and notes of the given contacts, in their order, each tag and note once, at most
// OWNER_WORDS and the code points above; a value cut short says `cut`. An older stored note may
// have no column.
export function ownerWordsOf(contacts: readonly SealedWords[]): OwnerWordsView[] {
  const words: OwnerWordsView[] = [];
  const seen = new Set<string>();
  let room = OWNER_WORDS_CODE_POINTS;
  const add = (kind: "tag" | "note", key: string | null, value: string): void => {
    const id = JSON.stringify([kind, key, value]);
    if (seen.has(id) || words.length >= OWNER_WORDS || room <= 0) return;
    const shortKey = key === null ? null : Array.from(key).slice(0, OWNER_WORD_KEY_CODE_POINTS).join("");
    const keyPoints = shortKey === null ? 0 : Array.from(shortKey).length;
    if (room - keyPoints <= 0) {
      room = 0;
      return;
    }
    seen.add(id);
    const points = Array.from(value);
    const kept = points.slice(0, Math.min(OWNER_WORD_CODE_POINTS, room - keyPoints));
    room -= keyPoints + kept.length;
    words.push({
      by: "owner",
      kind,
      key: shortKey === null ? null : { untrusted: shortKey },
      value: { untrusted: kept.join("") },
      ...(kept.length < points.length ? { cut: true as const } : {}),
    });
  };
  for (const { imported } of contacts) {
    for (const tag of imported?.tags ?? []) add("tag", tag.key, tag.value);
    for (const note of imported?.notes ?? []) {
      if (typeof note === "string") add("note", null, note);
      else add("note", note.key, note.value);
    }
  }
  return words;
}
