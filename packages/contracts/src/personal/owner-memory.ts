import { z } from "zod";
import { BeliefStatus } from "../belief.ts";
import { Timestamp } from "../ids.ts";
import { RestatementAnswer } from "./about-you.ts";
import { CardLine } from "./card-line.ts";
import { VendorRetention } from "./clients.ts";
import { PersonalCompartment } from "./compartments.ts";
import {
  AgentRecordId,
  ClientId,
  ClientName,
  EntityId,
  ErasureId,
  GoalId,
  RetentionRuleId,
  RulingId,
  SealId,
  SourceAccountId,
} from "./ids.ts";
import { MemoryProjectionId } from "./memory.ts";
import { CardKind, RetentionClass, SealKind } from "./owner.ts";
import { count, days, word } from "./owner-fields.ts";
import { FactKeyFp, Hex64 } from "./primitives.ts";
import { FactId } from "./tools-args.ts";
import { FactView } from "./tools-views.ts";

// `erasure` is null on a dry run. `more` holds one count for each erasure hook, by its name.
export const ErasureReport = z.strictObject({
  erasure: ErasureId.nullable(),
  items: count,
  people: count,
  suppressed: count,
  taintedRows: count,
  exposedClients: count,
  more: z.record(word, count),
});
export type ErasureReport = z.infer<typeof ErasureReport>;

// A line of the erasure journal: an erasure, with the account and source fingerprint of every item
// it removed and the address fingerprints it suppressed, or the lift of one; a seal with its kind,
// account and value's fingerprint, the lift of one, and a retention rule. Ids, keyed fingerprints,
// a class, a number of days and a sequence number that rises by one: no field can hold a string of
// content. An erasure of kind `device_forget`: a forget from a Mac settled by `pi erase settle`,
// its items the (account, fingerprint) pairs of stored and unstored keys alike, with nothing to
// suppress.
const seq = z.number().int().positive();
export const ErasureJournalEntry = z.union([
  z.strictObject({
    seq,
    erasure: ErasureId,
    kind: z.enum(["item", "person", "device_forget"]),
    items: z.array(z.strictObject({ account: SourceAccountId, fp: Hex64 })),
    suppress: z.array(Hex64),
    // What a replay must reach again (invariant 10): the goals a goal's erasure removes, and a person's people.
    goals: z.array(GoalId).optional(),
    entities: z.array(EntityId).optional(),
  }),
  z.strictObject({ seq, lift: ErasureId }),
  z.strictObject({ seq, seal: SealId, kind: SealKind, account: SourceAccountId.nullable(), fp: Hex64 }),
  z.strictObject({ seq, unseal: SealId }),
  z.strictObject({ seq, retention: RetentionRuleId, class: RetentionClass, account: SourceAccountId.nullable(), days }),
  // The lift of the owner's release made by this ruling, so a restore from before it lifts the
  // release again (invariant 10).
  z.strictObject({ seq, releaseLift: RulingId }),
]);
export type ErasureJournalEntry = z.infer<typeof ErasureJournalEntry>;

// A ruling on a belief: a `reject` of one claim, a `veto` of a fact key, or a `retire` of a fact key, true until
// restated. `claim` is null for a veto; `claimGone` says the claim the owner named is no longer stored. A
// `domain` or a `kind` of a fact key is the owner's correction of its life domain or its kind, whose value is
// sealed and not listed; and `carried`, present and true when the ruling reaches a claim only by that claim's
// version 1 key.
export const BeliefRulingView = z.strictObject({
  id: RulingId,
  verdict: z.enum(["reject", "veto", "retire", "domain", "kind"]),
  claim: FactId.nullable(),
  factKey: FactKeyFp,
  at: Timestamp,
  liftedAt: Timestamp.nullable(),
  claimGone: z.boolean(),
  carried: z.literal(true).optional(),
});
export type BeliefRulingView = z.infer<typeof BeliefRulingView>;

// One declassification: standing, revoked by the owner, or gone with its claim.
export const DeclassificationView = z.strictObject({
  id: RulingId,
  claim: FactId,
  type: z.string(),
  state: z.enum(["standing", "revoked", "gone"]),
  at: Timestamp,
  revokedAt: Timestamp.nullable(),
});
export type DeclassificationView = z.infer<typeof DeclassificationView>;

// The owner's view of one claim before they rule on it, for a terminal only: the fact, its fact key, its
// label, how many audiences hold a belief of it and their statuses, the rulings and the declassification
// that name it, and its lines as code renders them. An owner shape holds real ids only. FactView takes a
// handle in each id a client is given, so the owner's copy refuses one in every id field it holds.
const handleFree = (value: unknown, key = ""): boolean => {
  if (typeof value === "string") return !(["id", "message", "document"].includes(key) && value.startsWith("hdl_"));
  if (typeof value !== "object" || value === null) return true;
  return Object.entries(value).every(([name, one]) => handleFree(one, Array.isArray(value) ? key : name));
};

export const FactDetail = z.strictObject({
  fact: FactView.refine((fact) => handleFree(fact), { message: "an owner shape holds no handle" }),
  factKey: FactKeyFp,
  compartments: z.array(PersonalCompartment),
  beliefs: z.strictObject({ audiences: count, status: z.array(BeliefStatus) }),
  rulings: z.array(RulingId),
  declassification: RulingId.nullable(),
  lines: z.array(CardLine),
});
export type FactDetail = z.infer<typeof FactDetail>;

// What waits for the owner, as counts only: no id, name, subject, compartment or text.
export const Digest = z.strictObject({
  pending: z.record(CardKind, count),
  deferred: count,
  oldestPendingDays: count.nullable(),
  heldMessages: count,
  withheldItems: count,
});
export type Digest = z.infer<typeof Digest>;

// What each client's memory file was given and what its adapter reported, for `pi memory
// status`. A client is in step when `unconfirmed` and `endedNotAbsent` are both 0.
export const MemoryStatusView = z.strictObject({
  clients: z.array(
    z.strictObject({
      client: ClientId,
      name: ClientName,
      status: z.enum(["active", "revoked"]),
      retention: VendorRetention,
      lastSyncAt: Timestamp.nullable(),
      live: count,
      unconfirmed: count,
      endedNotAbsent: count,
      exposures: z.strictObject({ pending: count, reported: count, notPossible: count }),
    }),
  ),
});
export type MemoryStatusView = z.infer<typeof MemoryStatusView>;

// Every projection that rested on something deleted, newest first, for `pi memory exposures`.
export const MemoryExposureView = z.strictObject({
  exposures: z.array(
    z.strictObject({
      id: z.number().int().positive(),
      client: ClientId,
      name: ClientName,
      projection: MemoryProjectionId,
      firstServedAt: Timestamp,
      recordedAt: Timestamp,
      retention: VendorRetention,
      // The adapter's latest report, revised by every sync: nothing it reports is final.
      removal: z.enum(["pending", "reported", "not_possible"]),
      removalAt: Timestamp.nullable(),
      // Its first report that the entry was gone or could not be deleted, kept.
      firstRemoval: z.enum(["reported", "not_possible"]).nullable(),
      firstRemovalAt: Timestamp.nullable(),
    }),
  ),
  more: z.boolean(),
});
export type MemoryExposureView = z.infer<typeof MemoryExposureView>;

// The restatement marks, newest first, for `pi restatements list`. Ids, codes and times only; a claim
// key's first 16 characters. `reached` is null exactly for `new`, which matched nothing.
export const RestatementView = z.array(
  z
    .strictObject({
      id: z.number().int().positive(),
      client: ClientName,
      recordId: AgentRecordId,
      claimKeyPrefix: z.string().regex(/^[0-9a-f]{16}$/),
      answer: RestatementAnswer,
      reached: z.enum(["read", "held"]).nullable(),
      checkedAt: Timestamp,
      clearedAt: Timestamp.nullable(),
    })
    .refine((row) => (row.reached === null) === (row.answer === "new"), { message: "reached is null exactly for new" }),
);
export type RestatementView = z.infer<typeof RestatementView>;

// Memory changes counted by client and mark, with the latest import time. No locator and no text.
export const MemoryImportView = z.strictObject({
  clients: z.array(
    z.strictObject({
      client: ClientId,
      name: ClientName,
      marks: z.strictObject({ new: count, echo: count, stale: count, refused: count }),
      latestAt: Timestamp.nullable(),
    }),
  ),
});
export type MemoryImportView = z.infer<typeof MemoryImportView>;
