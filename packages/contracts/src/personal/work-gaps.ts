import { z } from "zod";
import { CARD_ATTEMPT_ASK } from "./card-attempts.ts";
import { CARD_RELAY_ASK } from "./card-relays.ts";
import { DREAM_FINDING_ASK } from "./dream.ts";
import { OWNER_QUEUE_ASK } from "./owner-queue.ts";
import { SAME_PERSON_ASK } from "./same-person.ts";
import { TIERS, Tier } from "./warmth.ts";
import type { GapMissing } from "./work-fields.ts";
import { MERGE_AUDIT_ASK } from "./wrong-merges.ts";

// What raised a gap flag, and what each finds missing. A flag is one research opportunity of the system's
// about who or what it names; one is open per trigger, subject and label. Three triggers of work code
// raises every day, each a read-only task: `meeting_soon` (a meeting soon with someone, missing its prep
// `brief`), `commitment_due` (a commitment falling due, missing its `follow_up`) and `reply_owed` (mail
// from someone the owner corresponds with that the owner has not answered, missing a prepared `reply`,
// which the task never sends). `close_no_tie`, a person in the owner's closest warmth tiers with no tie to
// the owner, missing the `tie` an agent proposes with propose_person for the owner's card. `intro_path`,
// an active goal's target the introduce, missing the `ask` an agent prepares as an `introduction`
// opportunity. `explore`, a frontier node worth researching, under `own` alone; what it lacks is the
// flag's own list, which overrides GAP_MISSING's placeholder.
export const GapTrigger = z.enum([
  "unresolved_mention",
  "no_warm_path",
  "unknown_attendee",
  "close_no_role",
  "meeting_soon",
  "commitment_due",
  "reply_owed",
  "close_no_tie",
  "intro_path",
  "explore",
  "deadline_soon",
  "same_person",
  "defect",
  "defect_untriaged",
  "card_question",
  "merge_audit",
  "card_relay",
  "dream_finding",
  "owner_queue",
  "goal_review",
  "meeting_followup",
]);
export type GapTrigger = z.infer<typeof GapTrigger>;
export const GAP_MISSING: Readonly<Record<GapTrigger, GapMissing>> = Object.freeze({
  unresolved_mention: "identity",
  no_warm_path: "path",
  unknown_attendee: "profile",
  close_no_role: "role",
  meeting_soon: "brief",
  commitment_due: "follow_up",
  reply_owed: "reply",
  close_no_tie: "tie",
  intro_path: "ask",
  // A placeholder: an explore flag serves its own list, `lacks`.
  explore: "profile",
  deadline_soon: "brief",
  same_person: "identity",
  merge_audit: "identity",
  defect: "fix",
  defect_untriaged: "triage",
  card_question: "answer",
  card_relay: "answer",
  owner_queue: "answer",
  goal_review: "brief",
  meeting_followup: "follow_up",
  dream_finding: "answer",
});
// What a frontier node lacks under the flag's label, set by code: an address, domain or LinkedIn
// profile (`identity`); a current role or affiliation (a person); a domain (an organization known
// by name); two edges besides the one that found it (`relations`); a link. Its order is this
// list's.
export const ExploreMissing = z.enum(["identity", "role", "affiliation", "domain", "relations", "links"]);
export type ExploreMissing = z.infer<typeof ExploreMissing>;
export const ExploreLacks = z.array(ExploreMissing).min(1).max(ExploreMissing.options.length);
export type ExploreLacks = z.infer<typeof ExploreLacks>;
// What a close_no_tie or close_no_role task asks, a fixed text of the system's served on its gap (a
// gap flag has no summary). The person is the task's `about`.
export const GAP_ASK: Readonly<Partial<Record<GapTrigger, string>>> = Object.freeze({
  same_person: SAME_PERSON_ASK,
  card_question: CARD_ATTEMPT_ASK,
  merge_audit: MERGE_AUDIT_ASK,
  card_relay: CARD_RELAY_ASK,
  owner_queue: OWNER_QUEUE_ASK,
  dream_finding: DREAM_FINDING_ASK,
  close_no_tie:
    "Read the owner's mail, chats and meetings with the person this task is about, then propose who they are to the owner with propose_person (kind relationship: relation and closeness), and record a finding of what you read, which your done report cites. Never propose_about_you.",
  deadline_soon:
    "Something dated with nobody else on it falls soon on the owner's calendar: the event this task is about. Read its title and what mail and documents say of it. If it is a deadline, record a finding of what it needs and what is ready. If it is a holiday, a birthday or a plain reminder, report failed: nothing to prepare.",
  goal_review:
    "The owner's goal this task names has had no task, finding or work on it lately. Read the goal, what is on file under it, and the owner's recent mail, meetings and documents that bear on it. Record a finding, citing what you read, of what moved, what is stuck and the one next step that would move it; if that step is read-only work for an agent, propose_task it. If the goal looks finished or dropped, the finding says so and what showed it: its status is the owner's to change. Contact no one.",
  meeting_followup:
    "A meeting the owner had with other people ended within the last day or two: the event this task is about. Read what it left: its notes or transcript (read_meeting), and mail and messages with the people on it since. Record a finding, citing what you read, of what was agreed and what each side owes, naming each person in full, with any date said. If nothing was kept of the meeting, report failed: nothing to read. Draft and send nothing.",
  close_no_role:
    "Read the owner's mail, chats and meetings with the person this task is about, and what is on file about them. It ends one of three ways, each a done report citing a finding you record. 1. What you read, or the owner told you, states their current role: record a finding with a claim of type role {title, organization_name} on the person, citing what you read (no cite for the owner's word, which the finding quotes). 2. They are family or a personal friend with no work tie, or have no job (a student, a child, retired): the finding says so and what showed it; if their tie to the owner is not on file, also propose_person kind relationship with the relation, which the owner confirms in one tap. 3. Nothing you can read states a role: the finding says what you read and that none states it. Each of these settles the person, and they are not asked about again. Never guess a role from a name or an address. Report failed only when a tool or source refused you. Contact no one.",
  // introPath names each introducer and goal; explore lists what to fill and every edge that found the
  // node.
  explore:
    "The person or organization this task is about is beyond the owner's own ties. Your brief's explore lists what is missing, every statement that names them (who said it, the fact) and the goals they serve. Research only what is listed, record a finding citing what you read, and contact no one.",
  intro_path:
    "Someone in your brief's introPath said, in mail to the owner, that they know the person this task is about or offered to introduce them. Read that message and its thread, record a finding (who, why, the passage, the goal), then propose_opportunity kind introduction: about the introducer, its basis that message and the person. Contact no one.",
});

// The two triggers a defect of the system's raises: `defect`, one the system filed, at each opening;
// `defect_untriaged`, one an agent filed that stood open and untouched. Their words are the system's,
// with the defect's id and nothing a source or an agent wrote.
const DEFECT_ASK: Readonly<Partial<Record<GapTrigger, string>>> = Object.freeze({
  defect:
    "The system filed a defect and the owner gave defects to your role: one of its own measures or health checks is failing. Read it with list_improvements (improvement: the id below) and get_health, whose measure shows its parts, and whose box shows the holds and switches. What you can change today: a lever list_levers shows with mover agent, or code if you hold a repository. Then say so with update_improvement: in_progress and a fixRef (lever:<key>, pr:<number> or commit:<hash>). A box health card that needs nothing of the owner: mark it seen with mark_health_seen. If the change is not one you can make (a dump, a hold, a card only the owner may mark seen, a lever that is the owner's), set triaged with fixRef none:owners_to_change and a note of what is needed: the defect is then listed for the owner and raises no more tasks. Record a finding of what you found, which your done report cites. The defect closes when its measure recovers, and this task with it; if the task ends and the defect still stands, a new task is raised after a wait.",
  defect_untriaged:
    "A defect an agent filed has stood open for two days with nobody on it. Read it with list_improvements (improvement: the id below), then set its status with update_improvement: triaged, in_progress, duplicate, wont_do or done. Record a finding of what you decided and why, which your done report cites.",
});
// A defect's id, the first part of its task's subject: a system defect's subject also counts its
// openings, so each opening is a gap of its own.
const DEFECT_ID_LENGTH = "imp_".length + 26;
export const defectOfGap = (trigger: GapTrigger, subject: string | null): string | null =>
  DEFECT_ASK[trigger] === undefined || subject === null ? null : subject.slice(0, DEFECT_ID_LENGTH);
// What a gap flag's task asks: its trigger's fixed text, and for a defect's the defect's id.
export function gapAsk(trigger: GapTrigger, subject: string | null): string | undefined {
  const defect = defectOfGap(trigger, subject);
  return defect === null ? GAP_ASK[trigger] : `${DEFECT_ASK[trigger]} The defect: ${defect}.`;
}

// `ontology/autonomy.json`, the windows of the three triggers, the age at which a deferred card
// expires, and close_no_tie's tiers and cap. Data, not code; the owner's to tune.
export const AutonomyRules = z
  .strictObject({
    version: z.number().int().positive(),
    // A meeting starting within this many hours raises meeting_soon.
    meetingSoonHours: z
      .number()
      .int()
      .min(1)
      .max(14 * 24),
    // An open commitment due within this many hours raises commitment_due.
    commitmentDueHours: z
      .number()
      .int()
      .min(1)
      .max(14 * 24),
    // Mail unanswered this many days raises reply_owed, and mail older than replyOwedWithinDays
    // never.
    replyOwedDays: z.number().int().min(1).max(30),
    replyOwedWithinDays: z.number().int().min(1).max(90),
    // reply_owed's switch: the trigger's tasks are noise (calendar invites, newsletters, broadcasts,
    // conversations already answered) while it reads more than ongoing conversations, so it can be
    // switched off. Absent is on.
    replyOwedOn: z.boolean().optional(),
    // deadline_soon's switch, within commitmentDueHours. Absent is off, unlike the others: each task costs money, and its shape may read noise.
    deadlineSoonOn: z.boolean().optional(),
    // Absent is off, as deadline_soon's: each task costs money.
    goalReviewOn: z.boolean().optional(),
    goalReviewDays: z.number().int().min(3).max(90).optional(),
    // meeting_followup's switch, and the hours after a meeting with people ends within which its
    // follow-up is raised. Absent is off.
    meetingFollowUpOn: z.boolean().optional(),
    meetingFollowUpHours: z
      .number()
      .int()
      .min(1)
      .max(7 * 24)
      .optional(),
    cardAttemptsOn: z.boolean().optional(),
    // The planner's belief_changed runs' switch: those runs cost more than daily sweep and calendar
    // runs and gave proposals the owner would not act on, so they can be muted until their wakes come
    // from narrower triggers. Absent is on.
    beliefChangedRunsOn: z.boolean().optional(),
    // A card deferred this many days expires by the policy.
    deferredCardDays: z.number().int().min(1).max(365),
    // People in these warmth tiers with no tie raise close_no_tie, at most
    // closeNoTiePeople of them at once in one audience, warmest first.
    closeNoTieTiers: z
      .array(Tier)
      .min(1)
      .max(TIERS.length)
      .refine((tiers) => new Set(tiers).size === tiers.length, { message: "each tier once" }),
    closeNoTiePeople: z.number().int().min(1).max(150),
  })
  .refine((rules) => rules.replyOwedWithinDays > rules.replyOwedDays, {
    message: "replyOwedWithinDays is more than replyOwedDays",
  })
  .refine((rules) => rules.goalReviewOn !== true || rules.goalReviewDays !== undefined, {
    message: "goalReviewOn needs goalReviewDays",
  })
  .refine((rules) => rules.meetingFollowUpOn !== true || rules.meetingFollowUpHours !== undefined, {
    message: "meetingFollowUpOn needs meetingFollowUpHours",
  });
export type AutonomyRules = z.infer<typeof AutonomyRules>;

// `ontology/second-degree.json`, the numbers of the second degree and the frontier, which the rules
// below weigh each hop by. Data, not code; the owner's to tune. A hop's weight is 0 to 1.
const hopWeight = z.number().min(0).max(1);
const valueWeight = z.number().min(0).max(1000);
export const SecondDegreeRules = z.strictObject({
  version: z.number().int().positive(),
  namedPerLabelPerDay: z.number().int().min(1).max(1000),
  contactOrgsPerLabelPerDay: z.number().int().min(1).max(100000),
  acquaintanceWeight: hopWeight,
  introOfferWeight: z.strictObject({ offered: hopWeight, suggested: hopWeight }),
  introOfferDays: z.number().int().min(1).max(3650),
  reportedWeight: hopWeight,
  observedWeight: z.strictObject({ shared_thread: hopWeight, met_together: hopWeight, same_domain: hopWeight }),
  maxHops: z.number().int().min(1).max(4),
  namedMeetingHours: z
    .number()
    .int()
    .min(1)
    .max(14 * 24),
  prepPerAttendee: z.number().int().min(1).max(20),
  mapNamedPerNode: z.number().int().min(1).max(50),
  explorePerDay: z.number().int().min(0).max(50),
  goalTargetCardsOpen: z.number().int().min(1).max(50),
  exploreRestDays: z.number().int().min(1).max(365),
  value: z.strictObject({
    goalTarget: valueWeight,
    goalPath: valueWeight,
    meetingSoon: valueWeight,
    perNamer: valueWeight,
    // A node a claim names, with no namer, goal or meeting: kept below one namer of any tier.
    base: valueWeight,
    tierFactor: z.strictObject({
      inner: z.number().min(1).max(10),
      close: z.number().min(1).max(10),
      regular: z.number().min(1).max(10),
    }),
    recencyHalfLifeDays: z.number().int().min(1).max(3650),
  }),
});
export type SecondDegreeRules = z.infer<typeof SecondDegreeRules>;
