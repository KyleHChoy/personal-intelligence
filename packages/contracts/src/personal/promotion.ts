import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { ULID_PATTERN } from "./ids.ts";
import { Hex64 } from "./primitives.ts";
import { SubjectKind } from "./subjects.ts";
import { UntrustedString } from "./tools-args.ts";

// The promotion gate, the only way a fact leaves a personal store, and the intake a receiving
// instance runs. A promotion carries the statements and kinds of the claims the owner approved, and
// nothing else: no id of the sending instance, no key, no label, no evidence. Its provenance is a
// keyed hash only the sender can recompute, so a later deletion notice names the same promotion
// without naming anything else.

// A promotion's id in the sending instance's ledger.
export const PromotionId = z
  .string()
  .regex(new RegExp(`^prm_${ULID_PATTERN}$`))
  .brand<"PromotionId">();
export type PromotionId = z.infer<typeof PromotionId>;

const Provenance = Hex64;

// The most claims one promotion carries, and the longest text value of one.
export const PROMOTION_MOST_CLAIMS = 50;
const PROMOTED_TEXT_MOST = 2000;

// A token shaped like a row id of a personal instance (a prefix and a ULID) or a keyed fingerprint
// (64 hexadecimal characters). Neither may cross: the gate refuses a claim whose text holds one, and
// the intake refuses a promotion that carries one.
const ID_SHAPED = new RegExp(`(?:^|[^a-z])[a-z]{3}_${ULID_PATTERN}|(?:^|[^0-9a-f])[0-9a-f]{64}(?:$|[^0-9a-f])`, "i");
const holdsIdShape = (text: string): boolean => ID_SHAPED.test(text);

const PromotedText = z
  .string()
  .min(1)
  .max(PROMOTED_TEXT_MOST)
  .refine((text) => !holdsIdShape(text), { message: "holds an id" });

// One field of a claim's statement: text, a closed list's member, a number, a date or a flag, as the
// claim's own typed field held it. A field that named an entity is not carried.
const PromotedValue = z.union([PromotedText, z.number(), z.boolean()]);

const FieldName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const ClaimKind = z.string().regex(/^[a-z][a-z0-9_]{0,63}(\.[a-z][a-z0-9_]{0,63})?$/);

// One approved claim. `ref` and `subject.ref` name it and its subject within this promotion alone
// (c1, c2, ... and s1, s2, ... in the order the claims are carried); the receiver mints its own ids.
export const PromotedClaim = z.strictObject({
  ref: z.string().regex(/^c[1-9][0-9]?$/),
  kind: ClaimKind,
  subject: z.strictObject({ ref: z.string().regex(/^s[1-9][0-9]?$/), kind: SubjectKind }),
  statement: z.record(FieldName, PromotedValue).refine((fields) => Object.keys(fields).length > 0, {
    message: "an empty statement",
  }),
  validFrom: Timestamp,
});
export type PromotedClaim = z.infer<typeof PromotedClaim>;

// The release record: the owner approved it, by command, at that time.
export const PromotionRelease = z.strictObject({ by: z.literal("owner"), via: z.literal("command"), at: Timestamp });
export type PromotionRelease = z.infer<typeof PromotionRelease>;

// What the gate emits for one promotion. Strict at every level: a receiver refuses a key it does not
// know, so nothing rides along unseen.
export const PromotionBundle = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal("promotion"),
    origin: z.literal("personal"),
    provenance: Provenance,
    release: PromotionRelease,
    claims: z.array(PromotedClaim).min(1).max(PROMOTION_MOST_CLAIMS),
  })
  .refine((bundle) => new Set(bundle.claims.map((claim) => claim.ref)).size === bundle.claims.length, {
    message: "a repeated claim ref",
  })
  .refine(
    (bundle) =>
      bundle.claims.every(
        (claim) =>
          bundle.claims.find((other) => other.subject.ref === claim.subject.ref)?.subject.kind === claim.subject.kind,
      ),
    { message: "one subject ref with two kinds" },
  );
export type PromotionBundle = z.infer<typeof PromotionBundle>;

// What follows a bundle when the owner revokes the promotion, or when a claim it carried is erased:
// the receiver removes everything the promotion gave it, and takes it again never.
export const PromotionDeletionNotice = z.strictObject({
  version: z.literal(1),
  kind: z.literal("promotion_deletion"),
  origin: z.literal("personal"),
  provenance: Provenance,
  at: Timestamp,
});
export type PromotionDeletionNotice = z.infer<typeof PromotionDeletionNotice>;

// Every message that crosses: one bundle, or one deletion notice.
export const PromotionMessage = z.union([PromotionBundle, PromotionDeletionNotice]);
export type PromotionMessage = z.infer<typeof PromotionMessage>;

// The labels a promoted claim may carry in the sending instance: exactly `own`, or exactly `public`.
// An agent's, an employer's, a restricted or any wider label never crosses.
export const promotableLabel = (compartments: readonly string[]): boolean =>
  compartments.length === 1 && (compartments[0] === "own" || compartments[0] === "public");

// One promotion in the sender's ledger, as the owner lists them: its claims by count, never by text.
export const PromotionView = z.strictObject({
  promotion: PromotionId,
  provenance: Provenance,
  claims: z.number().int().min(1),
  at: Timestamp,
  revokedAt: Timestamp.nullable(),
  // A claim it carried is gone (erased or removed at its source): its deletion notice is due.
  broken: z.boolean(),
});
export type PromotionView = z.infer<typeof PromotionView>;

// What the intake did with one message: `taken` claims written, `already` for a bundle taken
// before, `revoked` for a bundle whose promotion was revoked (it is never taken again), `removed`
// claims a deletion notice removed.
export const PromotionIntakeReport = z.strictObject({
  code: z.enum(["taken", "already", "revoked", "removed"]),
  claims: z.number().int().min(0),
});
export type PromotionIntakeReport = z.infer<typeof PromotionIntakeReport>;

// A promoted claim as the receiving instance serves it to a client: its own ids, the kind, the
// statement's text values as untrusted, and when it was stated.
export const PromotedFactView = z.strictObject({
  id: Hex64,
  kind: ClaimKind,
  subject: z.strictObject({ id: z.string(), kind: SubjectKind }),
  statement: z.record(FieldName, z.union([UntrustedString, z.number(), z.boolean()])),
  validFrom: Timestamp,
});
export type PromotedFactView = z.infer<typeof PromotedFactView>;
