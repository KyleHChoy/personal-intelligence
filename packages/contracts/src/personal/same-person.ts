import { z } from "zod";
import { ULID_PATTERN } from "./ids.ts";

// Same-person questions that go to agents, and rules from the owner's own answers.

const IdentityQuestionId = z.string().regex(new RegExp(`^idq_${ULID_PATTERN}$`));
const QuestionRuleId = z.string().regex(new RegExp(`^qrl_${ULID_PATTERN}$`));

// What the evidence shows beyond a shared name. A name is no answer, so no code here is one.
const SamePersonBecause = z.enum([
  "shared_address",
  "shared_phone",
  "says_so",
  "same_role_and_org",
  "signature",
  "thread",
  "conflicting_role_or_org",
  "conflicting_place",
  "other_evidence",
  // What a person's records hold, which code compares.
  "same_company",
  "same_link",
  "address_matches_company",
  "rare_full_name",
]);
// Why an agent could not settle it, which the owner's card says in a line.
const CantTellWhy = z.enum(["no_evidence", "name_only", "conflicting_evidence"]);

const text = (most: number) =>
  z
    .string()
    .refine((value) => value.trim() !== "" && [...value].length <= most, { message: `1 to ${most} code points` })
    .refine((value) => !value.includes("\u0000"), { message: "a NUL" });

// On an identity_policy decision: an `agent` basis names who said it, why and the answer; a `rule` basis,
// the rule the owner confirmed.
export const POLICY_ATTRIBUTION = {
  client: z.string().optional(),
  because: z.string().optional(),
  answer: z.string().optional(),
  rule: z.string().optional(),
  agrees: z.string().optional(),
} as const;

// One message an answer cites, with the words in it that show what it says.
const Cited = z.strictObject({
  message: z.string().regex(new RegExp(`^msg_${ULID_PATTERN}$`)),
  quote: text(500),
});

// A value on one of a person's records, which code finds there: a name, an address, or a field of a contact.
const RecordField = z.enum(["name", "address", "company", "phone", "link"]);
const CitedRecord = z.strictObject({ record: z.string(), field: RecordField, value: text(500) });

// An agent's answer on one question of its batch.
export const SamePersonAnswer = z.discriminatedUnion("verdict", [
  z.strictObject({
    question: IdentityQuestionId,
    verdict: z.enum(["same", "different"]),
    because: SamePersonBecause,
    sources: z
      .array(z.union([Cited, CitedRecord]))
      .min(1)
      .max(20),
  }),
  z.strictObject({ question: IdentityQuestionId, verdict: z.literal("cant_tell"), why: CantTellWhy }),
]);
export type SamePersonAnswer = z.infer<typeof SamePersonAnswer>;

export const SamePersonAnswers = z
  .array(SamePersonAnswer)
  .min(1)
  .max(200)
  .refine((answers) => new Set(answers.map((one) => one.question)).size === answers.length, {
    message: "one answer per question",
  })
  .describe("One per pair you can answer.");

export type SamePersonAnswers = z.infer<typeof SamePersonAnswers>;

// What a same_person task asks, a fixed text of the system's, served on its gap.
export const SAME_PERSON_ASK =
  "Your brief's samePerson lists pairs of records that may be one person, with what each person's records hold: names, addresses, mail counts, contact cards and their recent messages (id, date and subject: read one with read_message and cite its words). For each, answer in report.samePerson: same or different, with because and the sources it rests on, or cant_tell with why. Joining two people wrongly is the worst outcome, so cant_tell is a good answer whenever the records don't settle it. A source is {record, field, value}: a person's id from the brief, name, address, company, phone or link, and the value as the brief gives it; or {message, quote}: a message you read and its words. Because: same_company, same_link, shared_address and address_matches_company compare a value from each person; same_link is a link to that person's own profile, never a firm's page; those but a LinkedIn profile also take a name they share. A name proves nothing, however unusual, nor does a shared phone: a family or an office shares one. Different companies or places don't make two people: a job change is one person, so answer different only on something that shows two, otherwise cant_tell. A same or a different takes two agents agreeing. Card details are for this answer only, never to pass on. Every pair in the brief answered by you already: release the task. Never contact anyone.";

export const SAME_PERSON_HINTS = {
  same_person_not_asked:
    "Only a same_person task's report takes report.samePerson, and only on a pair its brief lists: remove the rest.",
  needs_same_person:
    "A same_person task is done only with report.samePerson answering at least one pair of its brief. Nothing to answer: release the task.",
  same_person_no_evidence:
    "A source must stand where it says: {record, field, value} on that person's records as your brief gives them, {message, quote} in a message on one person's log only, saying more than their names or a signature, all under the pair's own label. For same, a source from each person, and what they cite must agree from different rows, a card listing both people being no agreement: one company, one profile link or one address, or an address at the other's company; a quote may give one side's value. A name or a shared phone alone is not enough, and a third person with the name, one phone or differing companies hold a same back unless an exact address or a LinkedIn profile settles it. Your report keeps the answers that pass and names the rest in samePersonRefused. Otherwise answer cant_tell with why.",
} as const;

// Why code would not take one answer: the rest of its report stands.
const SamePersonRefusal = z.enum([
  "not_asked",
  "not_on_record",
  "not_on_one_log",
  "no_record_cites",
  "quote_not_found",
  "name_only",
  "claim_unproved",
  "no_agreement",
  "common_name",
  "differing_companies",
  "shared_line",
  "no_evidence",
  "cite_label",
]);
export const SamePersonRefused = z.strictObject({ question: z.string(), code: SamePersonRefusal });
export type SamePersonRefused = z.infer<typeof SamePersonRefused>;

// One pair in a task's brief.
const words = z.strictObject({ untrusted: z.string() });
// The most recent messages a brief lists for each person.
export const SAME_PERSON_RECENT_MOST = 5;
const SamePersonRecords = z.strictObject({
  names: z.array(words),
  addresses: z.array(words),
  mail: z.strictObject({ inbound: z.number().int(), outbound: z.number().int() }),
  // The person's latest messages under the pair's label, newest first: the id to read and cite, when
  // it was sent, and its subject as its source wrote it, or null when it has none.
  recent: z
    .array(z.strictObject({ message: z.string(), at: z.string(), subject: words.nullable() }))
    .max(SAME_PERSON_RECENT_MOST)
    .optional(),
  cards: z.array(
    z.strictObject({
      disclosure: z.literal("use_only"),
      names: z.array(words),
      phones: z.array(words),
      companies: z.array(z.strictObject({ name: words.nullable(), title: words.nullable() })),
      links: z.array(words),
    }),
  ),
});
export const SamePersonBriefPair = z.strictObject({
  question: IdentityQuestionId,
  a: z.string(),
  b: z.string(),
  basis: z.string(),
  // What each person's records hold, the whole person, under the pair's own label.
  records: z.strictObject({ a: SamePersonRecords, b: SamePersonRecords }),
});
export type SamePersonBriefPair = z.infer<typeof SamePersonBriefPair>;

// `ontology/questions.json`.
export const QuestionRulesData = z.strictObject({
  version: z.number().int().positive(),
  // Pairs one agent's task holds; a whole cluster is never split unless it alone is larger. Set by
  // what one claim's brief can build within its deadline, not to slow anything.
  batchPairs: z.number().int().min(1).max(200),
  // Pairs the owner's one card holds: what a person can read in one sitting.
  ownerCardPairs: z.number().int().min(1).max(200),
  // Offers to agents before a pair nobody settled reaches the owner, saying nobody answered.
  maxOffers: z.number().int().min(1).max(20),
  // The last this many answers on a pattern must all agree before code proposes a rule.
  ruleAfterAnswers: z.number().int().min(3).max(100),
  // Whether a rare full name alone can carry a same. Off until the owner rules on it: a name alone must
  // not merge.
  rareFullName: z.boolean(),
});
export type QuestionRulesData = z.infer<typeof QuestionRulesData>;

const QuestionRuleStatus = z.enum(["proposed", "confirmed", "declined", "lifted"]);
export const QuestionRuleView = z.strictObject({
  id: QuestionRuleId,
  kind: z.string(),
  pattern: z.string(),
  answer: z.string(),
  answers: z.number().int(),
  status: QuestionRuleStatus,
  proposedAt: z.string(),
  decidedAt: z.string().nullable(),
  liftedAt: z.string().nullable(),
});
export type QuestionRuleView = z.infer<typeof QuestionRuleView>;

// An agent's answer, for the owner's audit: who said what, citing what, and what code made of it.
export const IdentityAnswerView = z.strictObject({
  question: IdentityQuestionId,
  a: z.string(),
  b: z.string(),
  client: z.string(),
  verdict: z.enum(["same", "different", "cant_tell"]),
  because: z.string().nullable(),
  cites: z.array(z.string()),
  at: z.string(),
  ruling: z.string().nullable(),
  lifted: z.boolean(),
  refused: z.string().nullable(),
});
export type IdentityAnswerView = z.infer<typeof IdentityAnswerView>;
