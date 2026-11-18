import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { RequestId } from "./ids.ts";
import { Hex64 } from "./primitives.ts";
import { CLAIM_RELATION_KINDS, type SourceCheckVerdict } from "./relations.ts";
import { UntrustedString } from "./tools-args.ts";

// Dreaming cleans up duplicate beliefs and reconciles what is known. The
// shapes that cross a boundary: the switch kinds and their lines, a belief's settlement by an agent
// and its source-check mark as the belief build reads them, the same-person judge's closed answer,
// the pass's names and the trial's counts. A leaf beside relations.ts.

// The kinds a switch row and a line name: every relation kind, and identity merges (`same_person`).
// The connection kinds join in a later step.
export const SWITCH_KINDS = Object.freeze([...CLAIM_RELATION_KINDS, "same_person"] as const);
export const SwitchKind = z.enum(SWITCH_KINDS);
export type SwitchKind = z.infer<typeof SwitchKind>;

// A line the owner sets from the trials: a kind's precision line, or the checker's agreement with
// the owner's marks (`checker`: the rate, and the fewest marks it is read over). A kind or the gate the
// owner never set is absent: a relation kind is then on by each finding's own check, and the checker
// trusted. One the owner unset is null: off, and nothing trusted.
const DREAM_LINE_KINDS = Object.freeze([...SWITCH_KINDS, "checker"] as const);
export const DreamLineKind = z.enum(DREAM_LINE_KINDS);
export type DreamLineKind = z.infer<typeof DreamLineKind>;
export type DreamLines = {
  kinds: Partial<Record<SwitchKind, number | null>>;
  checker?: { rate: number; marks: number } | null;
};

// An agent's settlement of a conflict code could not settle, as the belief build reads
// it: the two claims by claim key, the one held current, when, and its label (the union of the two
// claims'). It applies only for an audience that sees both claims and holds its label; a lifted one
// is never given.
export type BeliefSettlement = { id: string; a: string; b: string; holds: string; at: string; compartments: string[] };

// A model's source check of a belief, as the build reads it: the claim keys it read,
// its verdict, when, and its label. It marks the belief unsupported only for an audience that holds
// its label and whose belief rests on exactly those claims.
export type BeliefCheckMark = { claimKeys: string[]; verdict: SourceCheckVerdict; at: string; compartments: string[] };

// The two passes.
const DREAM_PASSES = Object.freeze(["nightly", "weekly"] as const);
export const DreamPass = z.enum(DREAM_PASSES);
export type DreamPass = z.infer<typeof DreamPass>;

// The same-person judge's closed answer, `personal_same_person@1`: whether the person the `a`
// passages are about and the person the `b` passages are about are one person. `cites` are short
// phrases copied from the passages, each naming its side and number; a `same` cites at least one on
// each side. Code checks every cite against the passages it sent and reads nothing else.
const SAME_PERSON_VERDICTS = Object.freeze(["same", "different", "cant_tell"] as const);
const SamePersonVerdict = z.enum(SAME_PERSON_VERDICTS);
export const SamePersonPairAnswer = z.strictObject({
  verdict: SamePersonVerdict,
  cites: z
    .array(
      z.strictObject({
        side: z.enum(["a", "b"]),
        passage: z.number().int().min(1).max(20),
        text: z
          .string()
          .min(1)
          .refine((text) => [...text].length <= 300, { message: "at most 300 code points" }),
      }),
    )
    .max(8),
});
export type SamePersonPairAnswer = z.infer<typeof SamePersonPairAnswer>;

// An agent's settlement in `report_move`: the finding its task is about, and which of
// the finding's two statements holds now. What it cited is the report's own `refs`.
export const DreamSettle = z.strictObject({
  finding: z.string().regex(/^dfd_[0-9A-HJKMNP-TV-Z]{26}$/),
  holds: z.enum(["a", "b"]),
});
export type DreamSettle = z.infer<typeof DreamSettle>;

// A dream_finding task's brief: its finding, the subject, and the two claims, each as a fact id the
// read tools serve (`a` and `b`, as report.settle names them).
export const DreamFindingBrief = z.strictObject({
  finding: z.string(),
  a: Hex64,
  b: Hex64,
});
export type DreamFindingBrief = z.infer<typeof DreamFindingBrief>;

export const DREAM_FINDING_ASK =
  "Two things on file about the person or matter this task is about disagree, and the system's rules could not settle which holds now: your brief's dreamFinding names the two facts, a and b. Read each with your read tools, and what the owner's mail, chats, meetings and records say of them. Record a finding of what you read and what it shows, citing it, then report done with report.settle.finding set to the brief's finding and report.settle.holds set to a or b, the one that holds now, and report.sources citing that finding. If what you can read does not settle it, report failed with why: a wrong settlement costs the owner more than an open question. Your settlement is marked as an agent's, never the owner's; the owner's word outranks it. Contact no one, and change nothing else.";

export const DREAM_SETTLE_HINTS = {
  settle_not_asked: "Only a dream_finding task's done report takes report.settle: remove it.",
  needs_settle:
    "A dream_finding task is done only with report.settle naming its finding and which of a and b holds. Nothing settles it: report failed with why.",
  settle_refused:
    "The settlement was not taken: the finding is not this task's, it is already settled, or you are not cleared for both facts. Report failed with why, or release the task.",
} as const;

// The owner's weekly sample of each kind's checks, as the Work room shows it: the second
// model's sample check of a finding, and the owner's mark when the owner made one. Ids, codes and times only.
export const DREAM_SAMPLE_PER_KIND = 5;
export const DreamSampleCheck = z.strictObject({
  check: z.string().regex(/^[1-9][0-9]{0,18}$/),
  target: z.enum(["relation", "identity"]),
  kind: z.string(),
  finding: z.string().nullable(),
  judge: z.string().nullable(),
  checker: z.string(),
  verdict: z.string().nullable(),
  at: Timestamp,
  mark: z.enum(["right", "wrong"]).nullable(),
  newToMe: z.boolean().nullable(),
  // What the finding says: the claims it reads, a relation's `from` first, each by its fact id, its
  // type and its words as its source gave them.
  claims: z.array(z.strictObject({ fact: z.string(), type: z.string(), phrase: UntrustedString })).max(20),
});
export type DreamSampleCheck = z.infer<typeof DreamSampleCheck>;
export const DreamSampleView = z.strictObject({
  week: z.string(),
  checks: z.array(DreamSampleCheck).max(DREAM_SAMPLE_PER_KIND * (SWITCH_KINDS.length + 4)),
});
export type DreamSampleView = z.infer<typeof DreamSampleView>;
// The owner's mark on one: right or wrong, and whether it was new to the owner. Marking again adds the owner's newer mark.
export const DreamMarkBody = z.strictObject({
  check: z.string().regex(/^[1-9][0-9]{0,18}$/),
  mark: z.enum(["right", "wrong"]),
  newToMe: z.boolean(),
  requestId: RequestId,
});
export type DreamMarkBody = z.infer<typeof DreamMarkBody>;

// `pia dream findings`: the model relations themselves, newest first, so the owner can read what
// dreaming found and judge it. Each with whether it takes effect now and whether its kind's switch is
// on, the second model's latest check, whether its two claims sit on one fact key, and the two claims
// (the `from` first) as the sample shows them. `summary` counts every model relation, filters aside;
// `acrossFactKeys` those linking two fact keys, the ones that change what a read gives.
export const DREAM_FINDINGS_LIMIT = { unset: 20, most: 100 } as const;
export type DreamFindingsView = {
  summary: { total: number; effective: number; byKind: Record<string, number>; acrossFactKeys: number };
  findings: {
    id: string;
    kind: string;
    judge: string;
    judgedAt: string;
    effective: boolean;
    switchOn: boolean;
    check: { checker: string; verdict: string | null; code: string | null } | null;
    sameFactKey: boolean | null;
    claims: DreamSampleCheck["claims"];
  }[];
};
