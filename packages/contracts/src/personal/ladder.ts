import { z } from "zod";
import { CardKind } from "./owner.ts";
import { PINNED_POINTS, PINNED_THRESHOLDS } from "./point-pins.generated.ts";
import { Sha256 } from "./primitives.ts";

// The decision point registry's data. The definitions and their pins are here because two pieces
// that may not import each other read them: the ladder loads them and the store writes a point's
// version and hash on each call row. Data only: the rules L1 to L6 are the ladder's.

export const Rung = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type Rung = z.infer<typeof Rung>;

const EffectClass = z.enum(["narrow", "internal_reversible", "external"]);
type EffectClass = z.infer<typeof EffectClass>;

// The design's "What never climbs".
export const OWNER_ONLY_EFFECTS = Object.freeze([
  "confirm_intent",
  "grant_harness_mode",
  "widen_label",
  "declassify",
  "change_clearance",
  "merge_identity",
  "give_consent",
  "first_contact",
  "pay",
] as const);

// hold_message: a message kept from agents until the owner releases it. record_only: an output kept
// for the learning work and nothing else. not_investigated: finish_run's record that a prediction
// of a claim card was refused because the run never read the claim's source.
const NARROW = [
  "record_silence",
  "hold",
  "decline",
  "defer",
  "expire",
  "withhold_item",
  "hold_message",
  "record_only",
  "request_restriction",
  "not_investigated",
] as const;
const INTERNAL = [
  "start_run",
  "set_intention",
  "open_investigation",
  "propose_opportunity",
  "go_internal",
  "clear_internal_move",
  "record_answer",
  "set_lane",
  "to_checker",
  // Contacts and identity's sweep.
  "raise_identity_card",
  // A ranking that reorders candidates and does nothing else.
  "rank_candidate",
  "mark_echo",
  "propose_grouping",
  "supersede_earlier",
  "propose_binding",
  "offer_wake",
  "accept_about_owner",
  "admit_client_preference",
] as const;
// run_research: a research request leaves through the fetcher.
const EXTERNAL = ["clear_external_move", "run_research", ...OWNER_ONLY_EFFECTS] as const;

// A closed set.
export const EffectName = z.enum([...NARROW, ...INTERNAL, ...EXTERNAL]);
export type EffectName = z.infer<typeof EffectName>;

export const EFFECT_CLASS: Readonly<Record<EffectName, EffectClass>> = Object.freeze(
  Object.fromEntries([
    ...NARROW.map((name) => [name, "narrow"]),
    ...INTERNAL.map((name) => [name, "internal_reversible"]),
    ...EXTERNAL.map((name) => [name, "external"]),
  ]) as Record<EffectName, EffectClass>,
);

export const ESCALATING_EFFECTS: readonly EffectName[] = Object.freeze(["propose_binding"] as const);

export const DecisionPointId = z.enum([
  "wake_worth_run",
  "run_outcome",
  "opportunity_go",
  "owner_question",
  "move_clear",
  "extract_triage",
  "extract_claims",
  "extract_injection",
  "extract_sensitivity",
  "send_clear",
  "send_first_contact",
  "draft_disclosure",
  "identity_candidate",
  "identity_ruling",
  "extract_recovery",
  "record_injection",
  "identity_rank",
  "claims_same_fact",
  "belief_change",
  "project_link",
  "record_echo",
  "change_worth_run",
  "forecast_wait",
  "about_you",
  "client_preference",
  "restrict_category",
  // The claim intake's two refuse-only model checks of a quoted proposal.
  "claims_standalone",
  "claims_said",
  "task_go",
]);
export type DecisionPointId = z.infer<typeof DecisionPointId>;

// A threshold's name. For `hold` and `clear` a lower value holds more.
export const ThresholdName = z.enum(["lane", "hold", "clear", "accept", "reject"]);
export type ThresholdName = z.infer<typeof ThresholdName>;

const word = z.string().regex(/^[a-z][a-z0-9_]*$/);
const PromptRef = z.strictObject({ id: z.string().min(1), version: z.string().min(1) });

// Code chooses an output of `onAccept` or `onReject` by band; the model only answers `question`. A rung
// 1 entry names its thresholds, whose defaults, floors and ceilings are the constants pinned in
// THRESHOLD_PINS, never here. A rung 2 entry's `unsure` says where an unsure or unverified answer goes
// (absent: `next`). An empty `onReject` makes a reject answer the next band.
export const ModelEntry = z.discriminatedUnion("rung", [
  z.strictObject({
    rung: z.literal(1),
    prompt: PromptRef,
    question: word,
    onAccept: z.array(word).min(1),
    onReject: z.array(word),
    thresholds: z.strictObject({
      accept: ThresholdName,
      reject: z.union([ThresholdName, z.literal("below_accept"), z.null()]),
    }),
  }),
  z.strictObject({
    rung: z.literal(2),
    prompt: PromptRef,
    question: word,
    onAccept: z.array(word).min(1),
    onReject: z.array(word),
    unsure: z.enum(["next", "reject"]).optional(),
  }),
]);
export type ModelEntry = z.infer<typeof ModelEntry>;

// `models`, `fallback` and `whileWaiting` are optional, so a definition without them
// keeps its hash (canonical JSON leaves an absent field out).
export const DecisionPointDefinition = z.strictObject({
  id: DecisionPointId,
  version: z.number().int().positive(),
  rungs: z.array(Rung).min(1),
  outputs: z.record(word, EffectName),
  queue: CardKind.optional(),
  onNoAnswer: EffectName.optional(),
  expiresAfterDays: z.number().int().positive().optional(),
  prompts: z.array(PromptRef).optional(),
  models: z.array(ModelEntry).optional(),
  fallback: word.optional(),
  whileWaiting: word.optional(),
});
export type DecisionPointDefinition = z.infer<typeof DecisionPointDefinition>;

export const Band = z.enum(["accept", "reject", "next", "fallback"]);
export type Band = z.infer<typeof Band>;

// Never stored as knowledge.
export const Rung2Output = z.strictObject({
  answer: z.enum(["yes", "no", "unsure"]),
  cites: z
    .array(
      z.strictObject({
        slot: word,
        text: z
          .string()
          .min(1)
          .refine((text) => [...text].length <= 300, { message: "at most 300 code points" }),
      }),
    )
    .max(5),
});
export type Rung2Output = z.infer<typeof Rung2Output>;

// The decide model's answer to `jev_same_fact`: the probability that the two statements state one fact. A number
// in [0, 1]; any other answer is a rejection.
export const DecideSameFactOutput = z.strictObject({ same_fact: z.number().min(0).max(1) });
export type DecideSameFactOutput = z.infer<typeof DecideSameFactOutput>;

type Definition = DecisionPointDefinition;

// A model entry frozen all the way down: its prompt, its output lists and its threshold names.
const freezeEntry = (entry: ModelEntry): ModelEntry =>
  Object.freeze({
    ...entry,
    prompt: Object.freeze({ ...entry.prompt }),
    onAccept: Object.freeze([...entry.onAccept]) as string[],
    onReject: Object.freeze([...entry.onReject]) as string[],
    ...(entry.rung === 1 && { thresholds: Object.freeze({ ...entry.thresholds }) }),
  }) as ModelEntry;

// A definition frozen as DECISION_POINTS holds it, so no reader can change a point's outputs or
// model entries under its pin.
export const freezeDefinition = (definition: Definition): Readonly<Definition> =>
  Object.freeze({
    ...definition,
    rungs: Object.freeze([...definition.rungs]) as Rung[],
    outputs: Object.freeze({ ...definition.outputs }),
    ...(definition.prompts && {
      prompts: Object.freeze(definition.prompts.map((prompt) => Object.freeze({ ...prompt }))) as Definition["prompts"],
    }),
    ...(definition.models && { models: Object.freeze(definition.models.map(freezeEntry)) as Definition["models"] }),
  });
const freeze = freezeDefinition;

// Every version registered stays here beside the later ones, for the rows that name it; a reader
// that wants a point by its id takes `currentDefinition`. The extraction points are copied from
// EXTRACT_DECISION_POINTS.
export const DECISION_POINTS: readonly Readonly<Definition>[] = Object.freeze([
  freeze({ id: "wake_worth_run", version: 1, rungs: [0], outputs: { run: "start_run", skip: "record_silence" } }),
  freeze({
    id: "run_outcome",
    version: 1,
    rungs: [3],
    outputs: {
      ignore: "record_silence",
      remind: "set_intention",
      investigate: "open_investigation",
      propose: "propose_opportunity",
    },
    prompts: [{ id: "personal_run", version: "1" }],
  }),
  freeze({
    id: "opportunity_go",
    version: 1,
    rungs: [0, 4],
    outputs: { go: "go_internal", no_go: "decline", later: "defer" },
    queue: "opportunity_decision",
    onNoAnswer: "expire",
    expiresAfterDays: 14,
  }),
  freeze({
    id: "owner_question",
    version: 1,
    rungs: [4],
    outputs: { confirm: "record_answer", reject: "decline", skip: "defer" },
    queue: "owner_question",
    onNoAnswer: "expire",
    expiresAfterDays: 14,
  }),
  freeze({ id: "move_clear", version: 1, rungs: [0], outputs: { clear: "clear_internal_move", refuse: "hold" } }),
  // The extraction points, copied from EXTRACT_DECISION_POINTS (packages/extract/src/
  // decision-points.ts). A test in apps/pi holds the copy equal to the source.
  // extract_triage version 3 in version 2's place, with the lane `document`; version 2's
  // pin stays below for the records already made.
  freeze({
    id: "extract_triage",
    version: 3,
    rungs: [0, 1],
    outputs: { correspondence: "set_lane", transaction: "set_lane", skip: "set_lane", document: "set_lane" },
    prompts: [{ id: "jev_screen", version: "1" }],
  }),
  // extract_claims version 4 in version 3's place: version 3, which added the document prompt, with
  // personal_correspondence version 2. The registry holds one definition for each point, and the pins
  // of versions 1 to 3 stay below for the records already made.
  freeze({
    id: "extract_claims",
    version: 4,
    rungs: [2],
    outputs: {
      none: "to_checker",
      participants_only: "to_checker",
      special_category: "withhold_item",
      quarantine: "withhold_item",
    },
    prompts: [
      { id: "personal_correspondence", version: "2" },
      { id: "personal_transaction", version: "1" },
      { id: "personal_agent_record", version: "1" },
      { id: "personal_document", version: "1" },
    ],
  }),
  freeze({
    id: "extract_injection",
    version: 1,
    rungs: [1],
    outputs: { quarantine: "withhold_item", none: "record_silence" },
    prompts: [{ id: "jev_screen", version: "1" }],
  }),
  freeze({
    id: "extract_sensitivity",
    version: 1,
    rungs: [1],
    outputs: { special_category: "withhold_item", none: "record_silence" },
    prompts: [{ id: "jev_screen", version: "1" }],
  }),
  freeze({
    id: "send_clear",
    version: 1,
    rungs: [0, 4],
    outputs: { clear: "clear_external_move", refuse: "hold" },
    queue: "draft_waiting",
    onNoAnswer: "expire",
    expiresAfterDays: 7,
  }),
  freeze({
    id: "send_first_contact",
    version: 1,
    rungs: [4],
    outputs: { clear: "first_contact", refuse: "decline" },
    queue: "draft_waiting",
    onNoAnswer: "expire",
    expiresAfterDays: 7,
  }),
  freeze({
    id: "draft_disclosure",
    version: 1,
    rungs: [0, 4],
    outputs: { hold: "hold", no_finding: "record_silence" },
    queue: "draft_waiting",
    onNoAnswer: "expire",
    expiresAfterDays: 7,
  }),
  // Contacts and identity: rung 0 is the sweep's plain queries, whose card is its output; rung 4 is
  // the owner's ruling, merge_identity being the owner's alone. No model rung.
  freeze({ id: "identity_candidate", version: 1, rungs: [0], outputs: { raise: "raise_identity_card" } }),
  freeze({
    id: "identity_ruling",
    version: 1,
    rungs: [4],
    outputs: { same: "merge_identity", different: "record_answer" },
    queue: "same_person",
    onNoAnswer: "defer",
  }),
  // The recovery screen, the record screen and the identity ranking. The two screens are copied
  // from EXTRACT_DECISION_POINTS, and identity_rank from the store's identity points; a test in
  // apps/pi holds each copy equal to its source.
  freeze({
    id: "extract_recovery",
    version: 1,
    rungs: [1],
    outputs: { recovery: "hold_message", none: "record_silence" },
    prompts: [{ id: "jev_recovery", version: "1" }],
  }),
  freeze({
    id: "record_injection",
    version: 1,
    rungs: [1],
    outputs: { quarantine: "withhold_item", none: "record_silence" },
    prompts: [{ id: "jev_record", version: "1" }],
  }),
  freeze({
    id: "identity_rank",
    version: 1,
    rungs: [0, 1],
    outputs: { rank: "rank_candidate" },
    prompts: [{ id: "jev_identity", version: "1" }],
  }),
  freeze({
    id: "record_echo",
    version: 1,
    rungs: [0],
    outputs: { echo: "mark_echo", stale: "mark_echo", new: "record_silence", undecided: "record_silence" },
  }),
  freeze({
    id: "about_you",
    version: 1,
    rungs: [4],
    outputs: { confirm: "accept_about_owner", reject: "decline" },
    queue: "about_you",
    onNoAnswer: "expire",
    expiresAfterDays: 30,
  }),
  freeze({
    id: "client_preference",
    version: 1,
    rungs: [4],
    outputs: { confirm: "admit_client_preference", reject: "decline" },
    queue: "client_preference",
    onNoAnswer: "expire",
    expiresAfterDays: 30,
  }),
  // An output names its category with an underscore, since an output is a word: restrict_health is the category
  // `restrict:health`.
  freeze({
    id: "restrict_category",
    version: 1,
    rungs: [0, 1],
    outputs: {
      restrict_health: "request_restriction",
      restrict_money: "request_restriction",
      restrict_legal: "request_restriction",
      restrict_intimate: "request_restriction",
      none: "record_silence",
    },
    prompts: [{ id: "jev_screen", version: "2" }],
  }),
  // One threshold per hold point, default 0.7, low enough to hold about what a middle band would.
  // The definitions are version 1's but for the version; the new default is in POINT_THRESHOLDS.
  // Version 1 of each stays registered for the rows that name it.
  freeze({
    id: "extract_injection",
    version: 2,
    rungs: [1],
    outputs: { quarantine: "withhold_item", none: "record_silence" },
    prompts: [{ id: "jev_screen", version: "1" }],
  }),
  freeze({
    id: "extract_sensitivity",
    version: 2,
    rungs: [1],
    outputs: { special_category: "withhold_item", none: "record_silence" },
    prompts: [{ id: "jev_screen", version: "1" }],
  }),
  freeze({
    id: "record_injection",
    version: 2,
    rungs: [1],
    outputs: { quarantine: "withhold_item", none: "record_silence" },
    prompts: [{ id: "jev_record", version: "1" }],
  }),
  // jev_record version 2, which reads an agent's own judgment about its work as reporting.
  // Version 2 stays registered for the rows that name it.
  freeze({
    id: "record_injection",
    version: 3,
    rungs: [1],
    outputs: { quarantine: "withhold_item", none: "record_silence" },
    prompts: [{ id: "jev_record", version: "2" }],
  }),
  // extract_claims version 5: version 4 with personal_agent_record version 2, which lists every
  // correspondence type. Version 4 stays registered for the rows that name it.
  freeze({
    id: "extract_claims",
    version: 5,
    rungs: [2],
    outputs: {
      none: "to_checker",
      participants_only: "to_checker",
      special_category: "withhold_item",
      quarantine: "withhold_item",
    },
    prompts: [
      { id: "personal_correspondence", version: "2" },
      { id: "personal_transaction", version: "1" },
      { id: "personal_agent_record", version: "2" },
      { id: "personal_document", version: "1" },
    ],
  }),
  // run_outcome version 2: version 1 with personal_run version 2, the planner. Version 1 stays
  // registered for the runs that name it.
  freeze({
    id: "run_outcome",
    version: 2,
    rungs: [3],
    outputs: {
      ignore: "record_silence",
      remind: "set_intention",
      investigate: "open_investigation",
      propose: "propose_opportunity",
    },
    prompts: [{ id: "personal_run", version: "2" }],
  }),
  // run_outcome version 3: version 2 with personal_run version 3, the planner that reads the stores
  // only and learns from the owner's answers. Versions 1 and 2 stay registered for the runs that
  // name them.
  freeze({
    id: "run_outcome",
    version: 3,
    rungs: [3],
    outputs: {
      ignore: "record_silence",
      remind: "set_intention",
      investigate: "open_investigation",
      propose: "propose_opportunity",
    },
    prompts: [{ id: "personal_run", version: "3" }],
  }),
  // run_outcome version 4: the planner split. Three stages, each its own prompt: an
  // ideas run writes ideas, a translate run proposes the work for one idea, and a lessons run
  // proposes planning lessons, each kept for the owner's card and nothing else until they confirm
  // it. The first prompt is the one a wake queues by default. Versions 1 to 3 stay registered.
  freeze({
    id: "run_outcome",
    version: 4,
    rungs: [3],
    outputs: {
      ignore: "record_silence",
      remind: "set_intention",
      investigate: "open_investigation",
      propose: "propose_opportunity",
      idea: "open_investigation",
      lesson: "record_only",
    },
    prompts: [
      { id: "personal_ideas", version: "1" },
      { id: "personal_translate", version: "1" },
      { id: "personal_lessons", version: "1" },
    ],
  }),
  // run_outcome version 5: translate version 2, whose proposals are about what the
  // idea is about, not the goal. Version 4 stays registered for the runs that name it.
  freeze({
    id: "run_outcome",
    version: 5,
    rungs: [3],
    outputs: {
      ignore: "record_silence",
      remind: "set_intention",
      investigate: "open_investigation",
      propose: "propose_opportunity",
      idea: "open_investigation",
      lesson: "record_only",
    },
    prompts: [
      { id: "personal_ideas", version: "1" },
      { id: "personal_translate", version: "2" },
      { id: "personal_lessons", version: "1" },
    ],
  }),
  // run_outcome version 6: ideas 2, translate 3 and lessons 2, which ask for more and longer, since
  // no tight limits apply while the planner is being tried. Version 5 stays registered for the runs
  // that name it.
  freeze({
    id: "run_outcome",
    version: 6,
    rungs: [3],
    outputs: {
      ignore: "record_silence",
      remind: "set_intention",
      investigate: "open_investigation",
      propose: "propose_opportunity",
      idea: "open_investigation",
      lesson: "record_only",
    },
    prompts: [
      { id: "personal_ideas", version: "2" },
      { id: "personal_translate", version: "3" },
      { id: "personal_lessons", version: "2" },
    ],
  }),
  // run_outcome version 7: ideas 3, translate 4 and lessons 3, which say a fact
  // from an agent record is cited by its record. Version 6 stays registered for the runs that
  // name it.
  freeze({
    id: "run_outcome",
    version: 7,
    rungs: [3],
    outputs: {
      ignore: "record_silence",
      remind: "set_intention",
      investigate: "open_investigation",
      propose: "propose_opportunity",
      idea: "open_investigation",
      lesson: "record_only",
    },
    prompts: [
      { id: "personal_ideas", version: "3" },
      { id: "personal_translate", version: "4" },
      { id: "personal_lessons", version: "3" },
    ],
  }),
  // run_outcome version 8: version 7 with a fourth stage, predict, whose run predicts
  // the owner's answers on review cards and records each, in shadow, changing nothing else.
  // Version 7 stays registered for the runs that name it.
  freeze({
    id: "run_outcome",
    version: 8,
    rungs: [3],
    outputs: {
      ignore: "record_silence",
      remind: "set_intention",
      investigate: "open_investigation",
      propose: "propose_opportunity",
      idea: "open_investigation",
      lesson: "record_only",
      predict: "record_only",
    },
    prompts: [
      { id: "personal_ideas", version: "3" },
      { id: "personal_translate", version: "4" },
      { id: "personal_lessons", version: "3" },
      { id: "personal_predict", version: "1" },
    ],
  }),
  // run_outcome version 9: version 8 with ideas 4, translate 5 and predict 2, which start from the
  // self block, the owner's brief. Version 8 stays registered for the runs that name it.
  freeze({
    id: "run_outcome",
    version: 9,
    rungs: [3],
    outputs: {
      ignore: "record_silence",
      remind: "set_intention",
      investigate: "open_investigation",
      propose: "propose_opportunity",
      idea: "open_investigation",
      lesson: "record_only",
      predict: "record_only",
    },
    prompts: [
      { id: "personal_ideas", version: "4" },
      { id: "personal_translate", version: "5" },
      { id: "personal_lessons", version: "3" },
      { id: "personal_predict", version: "2" },
    ],
  }),
  // run_outcome version 10: version 9 with predict 3, which reads the answers block,
  // the owner's recent about_you and agent_claim answers. Version 9 stays registered for the runs
  // that name it.
  freeze({
    id: "run_outcome",
    version: 10,
    rungs: [3],
    outputs: {
      ignore: "record_silence",
      remind: "set_intention",
      investigate: "open_investigation",
      propose: "propose_opportunity",
      idea: "open_investigation",
      lesson: "record_only",
      predict: "record_only",
    },
    prompts: [
      { id: "personal_ideas", version: "4" },
      { id: "personal_translate", version: "5" },
      { id: "personal_lessons", version: "3" },
      { id: "personal_predict", version: "3" },
    ],
  }),
  // run_outcome version 11: version 10 with lessons 4, which asks for each lesson's
  // appliesTo and supersedes. Version 10 stays registered for the runs that name it.
  freeze({
    id: "run_outcome",
    version: 11,
    rungs: [3],
    outputs: {
      ignore: "record_silence",
      remind: "set_intention",
      investigate: "open_investigation",
      propose: "propose_opportunity",
      idea: "open_investigation",
      lesson: "record_only",
      predict: "record_only",
    },
    prompts: [
      { id: "personal_ideas", version: "4" },
      { id: "personal_translate", version: "5" },
      { id: "personal_lessons", version: "4" },
      { id: "personal_predict", version: "3" },
    ],
  }),
  // run_outcome version 12: version 11 with predict 4, which reads each
  // card's target and sources before it predicts and predicts same_fact cards; finish_run writes a
  // prediction of a claim card only when the run read the claim's source. Version 11 stays
  // registered for the runs that name it.
  freeze({
    id: "run_outcome",
    version: 12,
    rungs: [3],
    outputs: {
      ignore: "record_silence",
      remind: "set_intention",
      investigate: "open_investigation",
      propose: "propose_opportunity",
      idea: "open_investigation",
      lesson: "record_only",
      predict: "record_only",
    },
    prompts: [
      { id: "personal_ideas", version: "4" },
      { id: "personal_translate", version: "5" },
      { id: "personal_lessons", version: "4" },
      { id: "personal_predict", version: "4" },
    ],
  }),
  // run_outcome version 13: version 12 with personal_run version 4, which reads the
  // owner's mission and confirmed lessons; `one_pass` runs it, found by its id. Version 12 stays
  // registered for the runs that name it.
  freeze({
    id: "run_outcome",
    version: 13,
    rungs: [3],
    outputs: {
      ignore: "record_silence",
      remind: "set_intention",
      investigate: "open_investigation",
      propose: "propose_opportunity",
      idea: "open_investigation",
      lesson: "record_only",
      predict: "record_only",
    },
    prompts: [
      { id: "personal_ideas", version: "4" },
      { id: "personal_translate", version: "5" },
      { id: "personal_lessons", version: "4" },
      { id: "personal_predict", version: "4" },
      { id: "personal_run", version: "4" },
    ],
  }),
  // Versions 3 and 5 stay registered for the rows that name them.
  freeze({
    id: "extract_triage",
    version: 4,
    rungs: [0, 1],
    outputs: {
      correspondence: "set_lane",
      transaction: "set_lane",
      skip: "set_lane",
      document: "set_lane",
      meeting: "set_lane",
    },
    prompts: [{ id: "jev_screen", version: "1" }],
  }),
  freeze({
    id: "extract_claims",
    version: 6,
    rungs: [2],
    outputs: {
      none: "to_checker",
      participants_only: "to_checker",
      special_category: "withhold_item",
      quarantine: "withhold_item",
    },
    prompts: [
      { id: "personal_correspondence", version: "2" },
      { id: "personal_transaction", version: "1" },
      { id: "personal_agent_record", version: "2" },
      { id: "personal_document", version: "1" },
      { id: "personal_meeting", version: "1" },
    ],
  }),
  // Versions 4 and 6 stay registered for the rows that name them.
  freeze({
    id: "extract_triage",
    version: 5,
    rungs: [0, 1],
    outputs: {
      correspondence: "set_lane",
      transaction: "set_lane",
      skip: "set_lane",
      document: "set_lane",
      meeting: "set_lane",
      moment: "set_lane",
    },
    prompts: [{ id: "jev_screen", version: "1" }],
  }),
  freeze({
    id: "extract_claims",
    version: 7,
    rungs: [2],
    outputs: {
      none: "to_checker",
      participants_only: "to_checker",
      special_category: "withhold_item",
      quarantine: "withhold_item",
    },
    prompts: [
      { id: "personal_correspondence", version: "2" },
      { id: "personal_transaction", version: "1" },
      { id: "personal_agent_record", version: "2" },
      { id: "personal_document", version: "1" },
      { id: "personal_meeting", version: "1" },
      { id: "personal_moment", version: "1" },
    ],
  }),
  // extract_claims version 8, version 7 with personal_correspondence version 3,
  // copied from EXTRACT_DECISION_POINTS. Version 7 stays registered for the rows that name it.
  freeze({
    id: "extract_claims",
    version: 8,
    rungs: [2],
    outputs: {
      none: "to_checker",
      participants_only: "to_checker",
      special_category: "withhold_item",
      quarantine: "withhold_item",
    },
    prompts: [
      { id: "personal_correspondence", version: "3" },
      { id: "personal_transaction", version: "1" },
      { id: "personal_agent_record", version: "2" },
      { id: "personal_document", version: "1" },
      { id: "personal_meeting", version: "1" },
      { id: "personal_moment", version: "1" },
    ],
  }),
  // extract_claims version 10, version 8 with personal_meeting version 2, copied
  // from EXTRACT_DECISION_POINTS. Version 9 was set aside for another change and is not
  // registered.
  freeze({
    id: "extract_claims",
    version: 10,
    rungs: [2],
    outputs: {
      none: "to_checker",
      participants_only: "to_checker",
      special_category: "withhold_item",
      quarantine: "withhold_item",
    },
    prompts: [
      { id: "personal_correspondence", version: "3" },
      { id: "personal_transaction", version: "1" },
      { id: "personal_agent_record", version: "2" },
      { id: "personal_document", version: "1" },
      { id: "personal_meeting", version: "2" },
      { id: "personal_moment", version: "1" },
    ],
  }),
  // extract_claims version 11, version 10 with personal_moment version 2, copied
  // from EXTRACT_DECISION_POINTS.
  freeze({
    id: "extract_claims",
    version: 11,
    rungs: [2],
    outputs: {
      none: "to_checker",
      participants_only: "to_checker",
      special_category: "withhold_item",
      quarantine: "withhold_item",
    },
    prompts: [
      { id: "personal_correspondence", version: "3" },
      { id: "personal_transaction", version: "1" },
      { id: "personal_agent_record", version: "2" },
      { id: "personal_document", version: "1" },
      { id: "personal_meeting", version: "2" },
      { id: "personal_moment", version: "2" },
    ],
  }),
  // extract_claims version 12, version 11 with personal_moment version 3, copied
  // from EXTRACT_DECISION_POINTS.
  freeze({
    id: "extract_claims",
    version: 12,
    rungs: [2],
    outputs: {
      none: "to_checker",
      participants_only: "to_checker",
      special_category: "withhold_item",
      quarantine: "withhold_item",
    },
    prompts: [
      { id: "personal_correspondence", version: "3" },
      { id: "personal_transaction", version: "1" },
      { id: "personal_agent_record", version: "2" },
      { id: "personal_document", version: "1" },
      { id: "personal_meeting", version: "2" },
      { id: "personal_moment", version: "3" },
    ],
  }),
  // extract_claims version 13, version 12 with personal_meeting version 3, copied
  // from EXTRACT_DECISION_POINTS.
  freeze({
    id: "extract_claims",
    version: 13,
    rungs: [2],
    outputs: {
      none: "to_checker",
      participants_only: "to_checker",
      special_category: "withhold_item",
      quarantine: "withhold_item",
    },
    prompts: [
      { id: "personal_correspondence", version: "3" },
      { id: "personal_transaction", version: "1" },
      { id: "personal_agent_record", version: "2" },
      { id: "personal_document", version: "1" },
      { id: "personal_meeting", version: "3" },
      { id: "personal_moment", version: "3" },
    ],
  }),
  // extract_claims version 14, version 13 with personal_meeting version 4, copied
  // from EXTRACT_DECISION_POINTS.
  freeze({
    id: "extract_claims",
    version: 14,
    rungs: [2],
    outputs: {
      none: "to_checker",
      participants_only: "to_checker",
      special_category: "withhold_item",
      quarantine: "withhold_item",
    },
    prompts: [
      { id: "personal_correspondence", version: "3" },
      { id: "personal_transaction", version: "1" },
      { id: "personal_agent_record", version: "2" },
      { id: "personal_document", version: "1" },
      { id: "personal_meeting", version: "4" },
      { id: "personal_moment", version: "3" },
    ],
  }),
  // extract_claims version 15, version 14 with personal_meeting version 5.
  freeze({
    id: "extract_claims",
    version: 15,
    rungs: [2],
    outputs: {
      none: "to_checker",
      participants_only: "to_checker",
      special_category: "withhold_item",
      quarantine: "withhold_item",
    },
    prompts: [
      { id: "personal_correspondence", version: "3" },
      { id: "personal_transaction", version: "1" },
      { id: "personal_agent_record", version: "2" },
      { id: "personal_document", version: "1" },
      { id: "personal_meeting", version: "5" },
      { id: "personal_moment", version: "3" },
    ],
  }),
  // extract_claims version 16, version 15 with personal_meeting version 6.
  freeze({
    id: "extract_claims",
    version: 16,
    rungs: [2],
    outputs: {
      none: "to_checker",
      participants_only: "to_checker",
      special_category: "withhold_item",
      quarantine: "withhold_item",
    },
    prompts: [
      { id: "personal_correspondence", version: "3" },
      { id: "personal_transaction", version: "1" },
      { id: "personal_agent_record", version: "2" },
      { id: "personal_document", version: "1" },
      { id: "personal_meeting", version: "6" },
      { id: "personal_moment", version: "3" },
    ],
  }),
  // extract_claims version 17, version 16 with personal_meeting version 7.
  freeze({
    id: "extract_claims",
    version: 17,
    rungs: [2],
    outputs: {
      none: "to_checker",
      participants_only: "to_checker",
      special_category: "withhold_item",
      quarantine: "withhold_item",
    },
    prompts: [
      { id: "personal_correspondence", version: "3" },
      { id: "personal_transaction", version: "1" },
      { id: "personal_agent_record", version: "2" },
      { id: "personal_document", version: "1" },
      { id: "personal_meeting", version: "7" },
      { id: "personal_moment", version: "3" },
    ],
  }),
  // extract_claims version 18, version 17 with personal_moment version 4.
  freeze({
    id: "extract_claims",
    version: 18,
    rungs: [2],
    outputs: {
      none: "to_checker",
      participants_only: "to_checker",
      special_category: "withhold_item",
      quarantine: "withhold_item",
    },
    prompts: [
      { id: "personal_correspondence", version: "3" },
      { id: "personal_transaction", version: "1" },
      { id: "personal_agent_record", version: "2" },
      { id: "personal_document", version: "1" },
      { id: "personal_meeting", version: "7" },
      { id: "personal_moment", version: "4" },
    ],
  }),
  // extract_claims version 19, version 18 with personal_moment version 5.
  freeze({
    id: "extract_claims",
    version: 19,
    rungs: [2],
    outputs: {
      none: "to_checker",
      participants_only: "to_checker",
      special_category: "withhold_item",
      quarantine: "withhold_item",
    },
    prompts: [
      { id: "personal_correspondence", version: "3" },
      { id: "personal_transaction", version: "1" },
      { id: "personal_agent_record", version: "2" },
      { id: "personal_document", version: "1" },
      { id: "personal_meeting", version: "7" },
      { id: "personal_moment", version: "5" },
    ],
  }),
  // extract_claims version 20, version 19 with personal_moment version 6.
  freeze({
    id: "extract_claims",
    version: 20,
    rungs: [2],
    outputs: {
      none: "to_checker",
      participants_only: "to_checker",
      special_category: "withhold_item",
      quarantine: "withhold_item",
    },
    prompts: [
      { id: "personal_correspondence", version: "3" },
      { id: "personal_transaction", version: "1" },
      { id: "personal_agent_record", version: "2" },
      { id: "personal_document", version: "1" },
      { id: "personal_meeting", version: "7" },
      { id: "personal_moment", version: "6" },
    ],
  }),
  // extract_claims version 22, version 20 with personal_transaction version 2. It skips 21,
  // which records had named for another change, so none of them names the wrong version.
  freeze({
    id: "extract_claims",
    version: 22,
    rungs: [2],
    outputs: {
      none: "to_checker",
      participants_only: "to_checker",
      special_category: "withhold_item",
      quarantine: "withhold_item",
    },
    prompts: [
      { id: "personal_correspondence", version: "3" },
      { id: "personal_transaction", version: "2" },
      { id: "personal_agent_record", version: "2" },
      { id: "personal_document", version: "1" },
      { id: "personal_meeting", version: "7" },
      { id: "personal_moment", version: "6" },
    ],
  }),
  // extract_claims version 23, version 22 with personal_moment version 7.
  freeze({
    id: "extract_claims",
    version: 23,
    rungs: [2],
    outputs: {
      none: "to_checker",
      participants_only: "to_checker",
      special_category: "withhold_item",
      quarantine: "withhold_item",
    },
    prompts: [
      { id: "personal_correspondence", version: "3" },
      { id: "personal_transaction", version: "2" },
      { id: "personal_agent_record", version: "2" },
      { id: "personal_document", version: "1" },
      { id: "personal_meeting", version: "7" },
      { id: "personal_moment", version: "7" },
    ],
  }),
  // extract_claims version 24, version 23 with the atomic versions, personal_correspondence version
  // 4 and personal_agent_record version 3, copied from EXTRACT_DECISION_POINTS. Version 23 stays
  // registered for the rows that name it.
  freeze({
    id: "extract_claims",
    version: 24,
    rungs: [2],
    outputs: {
      none: "to_checker",
      participants_only: "to_checker",
      special_category: "withhold_item",
      quarantine: "withhold_item",
    },
    prompts: [
      { id: "personal_correspondence", version: "4" },
      { id: "personal_transaction", version: "2" },
      { id: "personal_agent_record", version: "3" },
      { id: "personal_document", version: "1" },
      { id: "personal_meeting", version: "7" },
      { id: "personal_moment", version: "7" },
    ],
  }),
  // extract_claims version 25, version 24 with personal_moment version 8. Version 24
  // stays registered for the rows that name it.
  freeze({
    id: "extract_claims",
    version: 25,
    rungs: [2],
    outputs: {
      none: "to_checker",
      participants_only: "to_checker",
      special_category: "withhold_item",
      quarantine: "withhold_item",
    },
    prompts: [
      { id: "personal_correspondence", version: "4" },
      { id: "personal_transaction", version: "2" },
      { id: "personal_agent_record", version: "3" },
      { id: "personal_document", version: "1" },
      { id: "personal_meeting", version: "7" },
      { id: "personal_moment", version: "8" },
    ],
  }),
  // extract_claims version 26, version 25 with personal_moment version 9. Version 25
  // stays registered for the rows that name it.
  freeze({
    id: "extract_claims",
    version: 26,
    rungs: [2],
    outputs: {
      none: "to_checker",
      participants_only: "to_checker",
      special_category: "withhold_item",
      quarantine: "withhold_item",
    },
    prompts: [
      { id: "personal_correspondence", version: "4" },
      { id: "personal_transaction", version: "2" },
      { id: "personal_agent_record", version: "3" },
      { id: "personal_document", version: "1" },
      { id: "personal_meeting", version: "7" },
      { id: "personal_moment", version: "9" },
    ],
  }),
  // Rung 0 is code's (a split, a join, equal phrases); rung 1 the decide model's probability under accept 0.95 and
  // reject 0.2; rung 2 the extract model's cited answer; rung 4 the owner's same_fact card. `same` only proposes a
  // grouping, which code checks and, in `shadow`, the owner answers on a card before anything groups.
  freeze({
    id: "claims_same_fact",
    version: 1,
    rungs: [0, 1, 2, 4],
    outputs: { same: "propose_grouping", different: "record_silence" },
    queue: "same_fact",
    onNoAnswer: "record_silence",
    expiresAfterDays: 14,
    prompts: [
      { id: "jev_same_fact", version: "1" },
      { id: "luna_same_fact", version: "1" },
    ],
    models: [
      {
        rung: 1,
        prompt: { id: "jev_same_fact", version: "1" },
        question: "same_fact",
        onAccept: ["same"],
        onReject: ["different"],
        thresholds: { accept: "accept", reject: "reject" },
      },
      {
        rung: 2,
        prompt: { id: "luna_same_fact", version: "1" },
        question: "same_fact",
        onAccept: ["same"],
        onReject: ["different"],
      },
    ],
  }),
  // Version 2: the same point, its rung 2 asked with luna_same_fact version 2.
  freeze({
    id: "claims_same_fact",
    version: 2,
    rungs: [0, 1, 2, 4],
    outputs: { same: "propose_grouping", different: "record_silence" },
    queue: "same_fact",
    onNoAnswer: "record_silence",
    expiresAfterDays: 14,
    prompts: [
      { id: "jev_same_fact", version: "1" },
      { id: "luna_same_fact", version: "2" },
    ],
    models: [
      {
        rung: 1,
        prompt: { id: "jev_same_fact", version: "1" },
        question: "same_fact",
        onAccept: ["same"],
        onReject: ["different"],
        thresholds: { accept: "accept", reject: "reject" },
      },
      {
        rung: 2,
        prompt: { id: "luna_same_fact", version: "2" },
        question: "same_fact",
        onAccept: ["same"],
        onReject: ["different"],
      },
    ],
  }),
  // Before a quoted proposal raises its card, the decide model answers whether its rendered
  // line makes sense on its own (claims_standalone), then, beside the quote, whether it says what
  // the quote says (claims_said). One rung 1 question each, since the first must be answered with
  // no quote in sight. Below the accept line the claim is withheld, filed unmapped; an answer that
  // is no answer falls back to the same refusal. Nothing a model answers changes a field.
  freeze({
    id: "claims_standalone",
    version: 1,
    rungs: [1],
    outputs: { stands: "record_silence", not_standalone: "withhold_item" },
    prompts: [{ id: "jev_standalone", version: "1" }],
    models: [
      {
        rung: 1,
        prompt: { id: "jev_standalone", version: "1" },
        question: "standalone",
        onAccept: ["stands"],
        onReject: ["not_standalone"],
        thresholds: { accept: "accept", reject: "below_accept" },
      },
    ],
    fallback: "not_standalone",
  }),
  freeze({
    id: "claims_said",
    version: 1,
    rungs: [1],
    outputs: { said: "record_silence", not_what_was_said: "withhold_item" },
    prompts: [{ id: "jev_said", version: "1" }],
    models: [
      {
        rung: 1,
        prompt: { id: "jev_said", version: "1" },
        question: "said",
        onAccept: ["said"],
        onReject: ["not_what_was_said"],
        thresholds: { accept: "accept", reject: "below_accept" },
      },
    ],
    fallback: "not_what_was_said",
  }),
  // Rung 0 goes or declines; work the owner said no to, or a card still undecided on the same work, goes
  // to the owner's queue as an opportunity_decision card. Version 1 sent every case ever carded there.
  freeze({
    id: "task_go",
    version: 1,
    rungs: [0, 4],
    outputs: { go: "go_internal", no_go: "decline" },
    queue: "opportunity_decision",
    onNoAnswer: "expire",
    expiresAfterDays: 14,
  }),
  freeze({
    id: "task_go",
    version: 2,
    rungs: [0, 4],
    outputs: { go: "go_internal", no_go: "decline" },
    queue: "opportunity_decision",
    onNoAnswer: "expire",
    expiresAfterDays: 14,
  }),
]);

// Throws for a point with no definition, so no caller misses one silently.
export function currentDefinition(id: DecisionPointId): Readonly<Definition> {
  let current: Readonly<Definition> | undefined;
  for (const definition of DECISION_POINTS)
    if (definition.id === id && (current === undefined || definition.version > current.version)) current = definition;
  if (current === undefined) throw new Error(`no decision point ${id}`);
  return current;
}

// Null when the entry has no reject threshold, does not name `name`, or the point has no model entries.
export function thresholdPair(
  definition: DecisionPointDefinition,
  name: string,
): { other: ThresholdName; side: "accept" | "reject" } | null {
  const entry = definition.models?.find((one) => one.rung === 1);
  if (entry?.rung !== 1) return null;
  const { accept, reject } = entry.thresholds;
  if (reject === null || reject === "below_accept") return null;
  if (name === accept) return { other: reject, side: "accept" };
  if (name === reject) return { other: accept, side: "reject" };
  return null;
}

// `<id>@<version>` to the SHA-256 of that definition's canonical JSON, keys sorted. A change to a
// definition is a new version with a new pin; the ladder refuses one changed under its pin. Generated,
// append-only, by `node packages/ladder/src/pins.ts` (point-pins.generated.ts).
export const DECISION_POINT_PINS: Readonly<Record<string, Sha256>> = PINNED_POINTS;

// The owner's verdict on the question a point asked, and where it was given.
export const PointVerdict = z.enum(["yes", "no"]);
export type PointVerdict = z.infer<typeof PointVerdict>;
export const VerdictSource = z.enum(["review", "card", "lane_retry"]);
export type VerdictSource = z.infer<typeof VerdictSource>;

const unit = z.number().min(0).max(1);
export const ThresholdBounds = z
  .strictObject({ default: unit, floor: unit, ceiling: unit })
  .refine((bounds) => bounds.floor <= bounds.default && bounds.default <= bounds.ceiling, {
    message: "floor <= default <= ceiling",
  });
export type ThresholdBounds = z.infer<typeof ThresholdBounds>;
export type PointThresholds = Readonly<Partial<Record<ThresholdName, Readonly<ThresholdBounds>>>>;

const bounds = (value: number, floor: number, ceiling: number): Readonly<ThresholdBounds> =>
  Object.freeze({ default: value, floor, ceiling });

// Every rung 1 point version's thresholds: the registry's copy of the constants beside each
// definition in code (EXTRACT_DECISION_POINTS for the extraction points and the two screens, the
// store's identity points for identity_rank, which has none, and the harness send's own for
// draft_disclosure@2). A point version's default, floor and ceiling never change: a new value is a
// new version.
export const POINT_THRESHOLDS: Readonly<Record<string, PointThresholds>> = Object.freeze({
  "extract_triage@3": Object.freeze({ lane: bounds(0.5, 0.2, 0.8) }),
  // Version 4 keeps version 3's line.
  "extract_triage@4": Object.freeze({ lane: bounds(0.5, 0.2, 0.8) }),
  // Version 5 keeps it too.
  "extract_triage@5": Object.freeze({ lane: bounds(0.5, 0.2, 0.8) }),
  "extract_injection@1": Object.freeze({ hold: bounds(0.9, 0.5, 0.99) }),
  "extract_sensitivity@1": Object.freeze({ hold: bounds(0.9, 0.5, 0.99) }),
  "extract_recovery@1": Object.freeze({ hold: bounds(0.7, 0.3, 0.95) }),
  "record_injection@1": Object.freeze({ hold: bounds(0.8, 0.5, 0.99) }),
  "identity_rank@1": Object.freeze({}),
  "draft_disclosure@2": Object.freeze({ hold: bounds(0.3, 0.1, 0.5), clear: bounds(0.05, 0.01, 0.1) }),
  // The four hold points at 0.7, as the recovery screen already was.
  "extract_injection@2": Object.freeze({ hold: bounds(0.7, 0.5, 0.99) }),
  "extract_sensitivity@2": Object.freeze({ hold: bounds(0.7, 0.5, 0.99) }),
  "record_injection@2": Object.freeze({ hold: bounds(0.7, 0.5, 0.99) }),
  "record_injection@3": Object.freeze({ hold: bounds(0.7, 0.5, 0.99) }),
  // 0.8 for each category; the floor and ceiling are the other hold points' (provisional).
  "restrict_category@1": Object.freeze({ hold: bounds(0.8, 0.5, 0.99) }),
  "claims_same_fact@1": Object.freeze({ accept: bounds(0.95, 0.8, 0.99), reject: bounds(0.2, 0.05, 0.5) }),
  "claims_same_fact@2": Object.freeze({ accept: bounds(0.95, 0.8, 0.99), reject: bounds(0.2, 0.05, 0.5) }),
  // Provisional: a line is kept when Jev's yes is at or above 0.5 (0.2 to 0.9).
  "claims_standalone@1": Object.freeze({ accept: bounds(0.5, 0.2, 0.9) }),
  "claims_said@1": Object.freeze({ accept: bounds(0.5, 0.2, 0.9) }),
});

// `<id>@<version>` to the SHA-256 of the canonical JSON of that version's thresholds, keys
// sorted, `{ name: { ceiling, default, floor } }`. The ladder refuses a rung 1 definition whose
// thresholds have no pin or do not hash to it; thresholds are pinned apart, so no definition's
// hash changes for them.
export const THRESHOLD_PINS: Readonly<Record<string, Sha256>> = PINNED_THRESHOLDS;

export const DecisionPointCall = z.strictObject({
  point: DecisionPointId,
  version: z.number().int().positive(),
  definitionHash: Sha256,
  rung: Rung,
  inputHash: Sha256,
  output: z.string().nullable(),
  effect: EffectName.nullable(),
  effectClass: EffectClass.nullable(),
  escalated: z.boolean(),
  // The band of a model rung's answer, the saved call it rests on (`vault.model_calls` or
  // `vault.decision_calls`), the threshold grants in force, and the run of a rung 3 call.
  band: Band.nullable().optional(),
  savedCall: z.string().min(1).nullable().optional(),
  thresholdIds: z.array(z.string().min(1)).optional(),
  run: z.string().min(1).nullable().optional(),
});
export type DecisionPointCall = z.infer<typeof DecisionPointCall>;
