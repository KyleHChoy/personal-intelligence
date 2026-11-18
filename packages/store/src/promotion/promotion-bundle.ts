// What one promotion carries, made by code from the claims the owner approved: each claim's kind,
// its subject's kind and its typed fields, with every field that named an entity left out. No id,
// key, label or evidence of this instance is carried; refs name a claim and a subject within the
// promotion alone. Pure: the gate reads and writes, this only shapes.

import {
  type ClaimRecord,
  PROMOTION_MOST_CLAIMS,
  PromotedClaim,
  PromotionBundle,
  PromotionDeletionNotice,
  type PromotionRelease,
  promotableLabel,
} from "@intelligence/contracts/personal";

// The origins whose claims may cross: what a source said, and the owner's own words. An agent's
// record, close or research never crosses, nor a released copy of an agent's proposal.
const PROMOTABLE_ORIGINS: ReadonlySet<string> = new Set(["source", "owner_command"]);

// Why a claim may not be promoted, as a code, or undefined when it may: its label is not exactly
// `own` or `public`, an agent wrote it, it holds a third party's use-only fact, or nothing of its
// statement can cross.
export function whyNotPromotable(compartments: readonly string[], record: ClaimRecord): string | undefined {
  if (!promotableLabel(compartments)) return "label";
  if (!PROMOTABLE_ORIGINS.has(record.origin) || record.released !== undefined) return "origin";
  if (record.disclosure.includes("third_party")) return "third_party";
  return statementOf(record) === undefined ? "statement" : undefined;
}

// A claim's statement as it crosses: each typed field but those that name an entity. Undefined when
// a field holds a value no promotion carries (a list, an object, text shaped like an id), or when
// nothing is left.
function statementOf(record: ClaimRecord): Record<string, string | number | boolean> | undefined {
  const statement: Record<string, string | number | boolean> = {};
  for (const [field, value] of Object.entries(record.claim.content.fields).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (value === undefined || value === null || record.fieldKinds[field] === "entity") continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return undefined;
    statement[field] = value;
  }
  return Object.keys(statement).length === 0 ? undefined : statement;
}

// The claims of one promotion, in the order given (the gate gives them by their ids): refs c1, c2,
// ... and a subject ref for each distinct subject, s1, s2, ... in order of first appearance.
// Undefined when any claim may not be promoted or the result is not a promotion's claims.
export function promotedClaims(records: readonly ClaimRecord[]): PromotedClaim[] | undefined {
  if (records.length === 0 || records.length > PROMOTION_MOST_CLAIMS) return undefined;
  const subjects = new Map<string, string>();
  const claims: PromotedClaim[] = [];
  for (const [index, record] of records.entries()) {
    const statement = statementOf(record);
    if (statement === undefined) return undefined;
    const subject = record.claim.content.subject;
    const ref = subjects.get(subject) ?? `s${subjects.size + 1}`;
    subjects.set(subject, ref);
    const parsed = PromotedClaim.safeParse({
      ref: `c${index + 1}`,
      kind: record.claim.content.type,
      subject: { ref, kind: record.subjectKind },
      statement,
      validFrom: record.claim.validFrom,
    });
    if (!parsed.success) return undefined;
    claims.push(parsed.data);
  }
  return claims;
}

// The bundle, its keys in one fixed order, so the same promotion is the same bytes each time it is
// emitted.
export function bundleOf(provenance: string, release: PromotionRelease, claims: PromotedClaim[]): PromotionBundle {
  return PromotionBundle.parse({
    version: 1,
    kind: "promotion",
    origin: "personal",
    provenance,
    release: { by: release.by, via: release.via, at: release.at },
    claims: claims.map((claim) => ({
      ref: claim.ref,
      kind: claim.kind,
      subject: { ref: claim.subject.ref, kind: claim.subject.kind },
      statement: claim.statement,
      validFrom: claim.validFrom,
    })),
  });
}

export const noticeOf = (provenance: string, at: string): PromotionDeletionNotice =>
  PromotionDeletionNotice.parse({ version: 1, kind: "promotion_deletion", origin: "personal", provenance, at });
