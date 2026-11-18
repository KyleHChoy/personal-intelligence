import { KIND_NAMES, KIND_REGISTRY } from "@intelligence/contracts/personal";
import type { PersonalType } from "@intelligence/personal-beliefs";
import type { SECOND_DEGREE_VERSIONS } from "./lane-versions.ts";
import { MEETING_SLOT_EXAMPLE_V6 } from "./meeting-prompts.ts";
import { AT, person, speakerMention } from "./message-prompts.ts";
import { exampleTurns, momentLineSpans } from "./prompt-preamble.ts";

// The fact-kind versions' own wording (prompts.ts, factKindInstructions): their rules, the type
// guide generated from the kind registry, the owner named neutrally in the second wording, and the
// example each lane shows. It imports nothing of prompts.ts, which builds its registry from this at
// load.

type SecondDegreeLane = keyof typeof SECOND_DEGREE_VERSIONS;

export const FACT_KIND_RULES_V1 = [
  "Dated items. A task, a deadline, a bill due, an appointment or a booking on a date is a plan, or a commitment when someone says they will do it, never a situation. A situation is a circumstance of the subject's life lasting more than two weeks.",
  "A view is the subject's own opinion or thesis about the world: view copies the words that state it and topic names what it is about. Only an opinion its subject states is a view; one reported of someone else is no claim.",
  "visited is a place the subject has been, one claim a place, when the day they were there when one is given; a trip still ahead is a plan. view and place are short phrases of at most 12 words, and each takes a domain, as a situation does.",
  "Where an organization's process about the owner stands, such as an application in review, an order shipped or an account suspended, is a status about him, never a situation: organization_name is the organization as written, process what it handles and state where it stands now.",
  "A fact about another person is a claim about that person, its subject that person, never the owner. An instruction to an agent or an assistant on how to work is no claim.",
];
// The second wording's status rule has each field copied, since "what it handles" drew the model's
// own words, which the check refuses as not in the passage.
const STATUS_RULE_V1 = FACT_KIND_RULES_V1[3] as string;
export const FACT_KIND_RULES_V2 = FACT_KIND_RULES_V1.map((rule) =>
  rule === STATUS_RULE_V1
    ? "Where an organization's process about the owner stands, such as an application in review, an order shipped or an account suspended, is a status about him, never a situation. organization_name, process and state each copy the fewest words of the message that name them, never words of your own: organization_name the organization, process what it handles and state where it stands now."
    : rule,
);

// The third wording keeps an objective with a target date a goal: "a deadline on a date is a plan"
// drew dated goals into plans.
const DATED_RULE_V1 = FACT_KIND_RULES_V1[0] as string;
export const FACT_KIND_RULES_V3 = FACT_KIND_RULES_V2.map((rule) =>
  rule === DATED_RULE_V1
    ? "Dated items. A task, a bill due, an appointment or a booking on a date is a plan, or a commitment when someone says they will do it, never a situation. An objective pursued over weeks or longer stays a goal even with a target date or a deadline, its date in by; only an arrangement or a single task due on a date is a plan. A situation is a circumstance of the subject's life lasting more than two weeks."
    : rule,
);

// The fourth wording narrows a plan to what is stated as one and says what it is by itself. The third
// still drew calendar lines restated in a daily brief, headings and remarks into plans, and goals
// stated in passing out of goals.
const DATED_RULE_V3 = FACT_KIND_RULES_V3[0] as string;
export const FACT_KIND_RULES_V4 = FACT_KIND_RULES_V3.flatMap((rule) =>
  rule === DATED_RULE_V3
    ? [
        "Dated items. A plan is an arrangement with a stated date, a real deadline or a single task due on a stated date, stated as such, and its what says what it is by itself, with no other line needed to understand it. One that someone says they will do is a commitment, and none of these is a situation. An objective pursued over weeks or longer stays a goal even with a target date or a deadline, its date in by, and an objective stated in passing with a clear aim is still a goal. A situation is a circumstance of the subject's life lasting more than two weeks.",
        "A schedule, an agenda, a digest or a daily brief that lists the owner's own calendar gives no claim from those lines: a line restating a calendar entry, including a time followed by a title, is no plan and no commitment. An arrangement written out in a sentence, or a deadline someone else sets, is still a plan.",
        "A heading, a name pair or a remark with no stated arrangement is no plan.",
        'Example lines that give no claim: "6:45 AM - Swim" and "2:00 PM - Review" in a daily brief, "Rhea / Sam" as a heading, and "the afternoon looks busy" as a remark. Example lines that each give a plan: "Our review with Rhea is on May 6 at 2." and "The lab report is due May 8."',
      ]
    : [rule],
);

// The fifth wording, an agent record's alone, on the fourth's rules: what it may write of the owner and of a project. Code
// resolves both mentions; the finding's own words ground the owner's.
export const OWNER_THIS_RULE =
  'The message\'s owner field lists the names and addresses the owner goes by. The owner is written {"key": {"kind": "source_id", "value": "owner:this"}, "observedAt": DATE} when the segment the span names writes one of them, as subject or in an entity field. A first name alone counts for a subject, never in an entity field, which needs a full name or an address. Where it writes none, no claim names the owner.';
export const PROJECT_THIS_RULE =
  'The project this finding is filed under is written {"key": {"kind": "source_id", "value": "project:this"}, "observedAt": DATE}, the only project mention there is. Code sets which project it is, and drops the claim when the finding is filed under none.';
export const FINDING_RULE =
  "A decision about the project is a project.decision, where it stands a project.status, a detail such as a specification, an order or a part a project.fact, and what to do next on it a project.next_step, each with the project as subject. A next step's who is the owner or the person to do it.";
// What a finding's project types say of a project, in place of a thread's.
export const FINDING_MEANINGS: Readonly<Record<string, string>> = {
  "project.status": "where the project the finding is filed under stands",
  "project.decision": "a decision about the project the finding is filed under",
};

// Correspondence's sixth wording: the message's project, which code found and the slot names. The
// model says only which facts are about it; code drops the claim when it found none.
export const MESSAGE_PROJECT_RULE =
  'A message may have a project field, the project code found it may belong to. A fact about that project has it as subject, written {"key": {"kind": "source_id", "value": "project:this"}, "observedAt": DATE}, the only project mention there is. Where the message has no project field, or the fact is not about that project, no claim has a project as subject.';
export const MESSAGE_PROJECT_STEP_RULE =
  "A decision about the project is a project.decision, where it stands a project.status and what to do next on it a project.next_step, each only when the message states it and each with the project as subject. A next step's who is the person to do it, by the address the message gives; with no such address it is no claim.";
export const MESSAGE_PROJECT_MEANINGS: Readonly<Record<string, string>> = {
  "project.status": "where the message's project stands",
  "project.decision": "a decision about the message's project",
  "project.next_step":
    "one thing to do next on the message's project; what copies the words that state it, who is the person to do it, due is the date when one is given",
};

// The fifth wording, for the mail and chat lanes alone, says what the commitment bar refuses, so a
// remark is not asked for and then dropped. The fourth still drew remarks, asks and promises credited
// the wrong way round.
export const FACT_KIND_RULES_V5 = [
  ...FACT_KIND_RULES_V4,
  "A commitment is a promise to do a stated thing, and its what names the action and its own object, with the words I'll or I will kept when they were said. A promise of it or that counts when the date, the person or the words just before say what it is. A remark is no commitment, and neither is thanks, an apology or a greeting, even when someone is asked to pass it on.",
  "An ask is no commitment of anyone's until the one asked agrees. The subject of a commitment is who will do it: the speaker when the speaker says I will, never the person spoken to.",
  'Example lines that give no commitment: "I\'ll be there", "calling you back in a second", "I\'ll get back to you", "tell her I apologize" and "can you send me the form?". An example line that gives one, its subject the speaker: "I\'ll send you the signed lease by May 8."',
];

// The kinds the guide covers: the owner's own kinds and the dated ones a misfiled situation
// belongs to, each in the registry's words, where a lane offers it. The second wording adds role and
// affiliation, which capability's entry points to and a status might otherwise take, and sends none
// of the lasting kinds' near misses to a plan: those exclusions drew preferences, constraints and
// capabilities into plans or into no claim, while the dated-items rule already sends a dated task
// to a plan.
const GUIDE_KINDS_V1 = KIND_NAMES.filter((kind) =>
  [
    "situation",
    "preference",
    "constraint",
    "goal",
    "need",
    "capability",
    "view",
    "status",
    "visited",
    "plan",
    "commitment",
  ].includes(kind),
);
const GUIDE_KINDS_V2 = KIND_NAMES.filter(
  (kind) => GUIDE_KINDS_V1.includes(kind) || kind === "role" || kind === "affiliation",
);
const LASTING = new Set(["preference", "constraint", "need", "goal"]);
// The fourth wording's plan line, here and not in the registry, whose plan entry the classifier's
// type guide and the earlier wordings' pinned text read. "A deadline" alone sent a goal's target
// date to a plan.
export const PLAN_BELONGS_V4 =
  "an arrangement with a stated date, such as a meeting, an appointment, a booking or a trip; a real deadline or a single task due on a stated date, stated as such";
export function ownerGuide(types: readonly PersonalType[], second = false, planV4 = false): string[] {
  const offered = new Set(types.map((type) => type.id));
  const goes = (kind: keyof typeof KIND_REGISTRY.kinds, refusal: string | undefined): string => {
    const type = KIND_REGISTRY.kinds[kind].type;
    if (refusal === "not_about_owner") return "a claim about that person";
    return type !== null && offered.has(type) ? `goes to ${type}` : "no claim here";
  };
  return [
    "Where a fact about the owner goes. For each kind he has: what belongs, then what does not, with where it goes instead.",
    ...(second ? GUIDE_KINDS_V2 : GUIDE_KINDS_V1)
      .filter((kind) => offered.has(KIND_REGISTRY.kinds[kind].type ?? ""))
      .map((kind) => {
        const entry = KIND_REGISTRY.kinds[kind];
        const not = entry.notBelongs.filter((one) => !(second && LASTING.has(kind) && one.goes === "plan"));
        const misfiled = not.map((one) => `${one.what} (${goes(one.goes, one.refusal)})`);
        if (planV4 && kind === "plan")
          return `- plan: ${PLAN_BELONGS_V4}. Not here: ${[
            ...misfiled,
            `an objective with a target date (${goes("goal", undefined)})`,
            "a calendar line restated in a schedule or a digest (no claim here)",
            "a heading, a name pair or a remark with no stated arrangement (no claim here)",
          ].join("; ")}.`;
        return `- ${kind}: ${entry.belongs.join("; ")}. Not here: ${misfiled.join("; ")}.`;
      }),
  ];
}

// One example each: an opinion, a place visited and an appointment, the appointment a plan.
const FK_LINES = [
  "I think small teams ship faster.",
  "I was in Lisbon on March 1.",
  "My dentist appointment is on March 9 at 10.",
] as const;
const fkClaims = (
  subject: unknown,
  spans: readonly [string, string, string],
  basis: string,
  what: string = FK_LINES[2],
) => ({
  claims: [
    {
      type: "view",
      subject,
      fields: { view: "small teams ship faster", topic: "small teams", domain: "career" },
      statementKind: "stated_fact",
      basis,
      span: spans[0],
    },
    {
      type: "visited",
      subject,
      fields: { place: "Lisbon", domain: "travel", when: "2026-03-01" },
      statementKind: "stated_fact",
      basis,
      span: spans[1],
    },
    {
      type: "plan",
      subject,
      fields: { what, when: "2026-03-09" },
      statementKind: "stated_fact",
      basis,
      span: spans[2],
    },
  ],
  narrowing: "none",
});
const FK_OWN = FK_LINES.join("\n");
const FK_SPAN = `chars:0-${FK_OWN.length}`;
const FK_MESSAGE = {
  citable: true,
  from: "rhea@alder.example",
  to: ["owner@birch.example"],
  date: AT,
  segments: [
    { span: "subject:chars:0-6", author: "rhea@alder.example", quoted: false, text: "Spring" },
    { span: FK_SPAN, author: "rhea@alder.example", quoted: false, text: FK_OWN },
  ],
};
const FK_FINDING_APPOINTMENT = "rhea@alder.example has a dentist appointment on March 9 at 10.";
const FK_FINDING = `rhea@alder.example wrote: I think small teams ship faster. rhea@alder.example was in Lisbon on March 1. ${FK_FINDING_APPOINTMENT}`;
const FK_FINDING_SPAN = `chars:0-${FK_FINDING.length}`;
// An agent record's version 9 example: a decision, a detail and a next step of the project the
// finding is filed under, the next step the owner's, by the name it writes.
const FP_DECISION = "The Alder kiln build will use the gas burner.";
const FP_DETAIL = "two firebricks of grade 23";
const FP_NEXT = "order the firebricks by Friday";
const FP_FINDING = `${FP_DECISION} The order is for ${FP_DETAIL}. Rhea Alder will ${FP_NEXT}.`;
const FP_SPAN = `chars:0-${FP_FINDING.length}`;
const fpClaim = (type: string, fields: Record<string, unknown>) => ({
  type,
  subject: { key: { kind: "source_id", value: "project:this" }, observedAt: AT },
  fields,
  statementKind: "stated_fact",
  basis: "third_party",
  span: FP_SPAN,
});
export const FP_EXAMPLE: readonly [string, unknown] = [
  FP_FINDING,
  {
    claims: [
      fpClaim("project.decision", { what: FP_DECISION }),
      fpClaim("project.fact", { what: FP_DETAIL }),
      fpClaim("project.next_step", {
        what: FP_NEXT,
        who: { key: { kind: "source_id", value: "owner:this" }, observedAt: AT },
      }),
    ],
    narrowing: "none",
  },
];
// Correspondence's sixth wording's example: a status and a next step of the project the slot names.
const MP_STATUS = "The kiln build is blocked on the burner.";
const MP_NEXT = "order the firebricks by Friday";
const MP_TEXT = `${MP_STATUS} I will ${MP_NEXT}.`;
const MP_SPAN = `chars:0-${MP_TEXT.length}`;
const mpClaim = (type: string, fields: Record<string, unknown>) => ({
  ...fpClaim(type, fields),
  basis: "explicit_self",
  span: MP_SPAN,
});
export const MP_EXAMPLE: readonly [unknown, unknown] = [
  {
    citable: true,
    from: "rhea@alder.example",
    to: ["sam@alder.example"],
    date: AT,
    project: "Alder Kiln",
    segments: [{ span: MP_SPAN, author: "rhea@alder.example", quoted: false, text: MP_TEXT }],
  },
  {
    claims: [
      mpClaim("project.status", { status: "blocked", what: MP_STATUS }),
      mpClaim("project.next_step", {
        what: MP_NEXT,
        who: { key: { kind: "address", value: "rhea@alder.example" }, observedAt: AT },
      }),
    ],
    narrowing: "none",
  },
];

// The moment version told of a project: code found it from the owner's own lines, and only those
// lines can say anything about it. Its example is the prompt's own.
export const MOMENT_PROJECT_RULE =
  'A moment may have a project field, the project code found the owner naming. A decision about that project is a project.decision and where it stands a project.status, each only when a passage with speaker owner states it, citing that passage by its span as given, with basis third_party and with the project as subject, written {"key": {"kind": "source_id", "value": "project:this"}, "observedAt": DATE}, the only project mention there is. A passage of anyone else says nothing about a project. Where the moment has no project field, or the fact is not about that project, no claim has a project as subject.';
export const MOMENT_PROJECT_MEANINGS: Readonly<Record<string, string>> = {
  "project.status": "where the moment's project stands",
  "project.decision": "a decision about the moment's project",
};
const CHAT_PROJECT_LINES = [
  "Alder Kiln is blocked on the permit",
  "which one did you pick",
  "we chose the smaller kiln",
];
const chatProjectSpan = (line: number): string => {
  const from = CHAT_PROJECT_LINES.slice(0, line).reduce((sum, one) => sum + one.length + 1, 0);
  return `mom:0:${from}-${from + (CHAT_PROJECT_LINES[line] as string).length}`;
};
export const MOMENT_PROJECT_EXAMPLE: readonly [unknown, unknown] = [
  {
    participants: [{ label: "P1", name: "Rhea Alder" }],
    moments: [
      {
        kind: "chat",
        seen: AT,
        project: "Alder Kiln",
        passages: CHAT_PROJECT_LINES.map((text, line) => ({
          span: chatProjectSpan(line),
          speaker: line === 1 ? "P1" : "owner",
          text,
        })),
      },
    ],
  },
  {
    claims: [
      { ...fpClaim("project.status", { status: "blocked", what: CHAT_PROJECT_LINES[0] }), span: chatProjectSpan(0) },
      { ...fpClaim("project.decision", { what: CHAT_PROJECT_LINES[2] }), span: chatProjectSpan(2) },
    ],
    narrowing: "none",
  },
];
const FK_MEETING_TURNS = exampleTurns([
  ["S2", FK_LINES[0]],
  ["S1", "Fair."],
  ["S2", FK_LINES[1]],
  ["S1", "Nice."],
  ["S2", FK_LINES[2]],
]);
const fkTurn = (line: string): string =>
  (FK_MEETING_TURNS.find((one) => one.text.includes(line)) as { span: string }).span;
const FK_MEETING = {
  ...(MEETING_SLOT_EXAMPLE_V6 as Record<string, unknown>),
  labels: "reliable",
  passages: FK_MEETING_TURNS.map((one) => ({ span: one.span, speaker: one.speaker, text: one.text })),
};
const FK_MOMENT_LINES = [
  { speaker: "P1", text: FK_LINES[0] },
  { speaker: "owner", text: "fair" },
  { speaker: "P1", text: FK_LINES[1] },
  { speaker: "owner", text: "nice" },
  { speaker: "P1", text: FK_LINES[2] },
];
const fkMomentSpans = momentLineSpans(FK_MOMENT_LINES);
const FK_MOMENTS = {
  participants: [{ label: "P1", name: "Rhea Alder" }],
  moments: [
    {
      kind: "chat",
      seen: AT,
      passages: FK_MOMENT_LINES.map((line, n) => ({ span: fkMomentSpans[n], speaker: line.speaker, text: line.text })),
    },
  ],
};
export const FK_EXAMPLES: Readonly<Record<SecondDegreeLane, [string, unknown, unknown]>> = {
  correspondence: [
    "message",
    FK_MESSAGE,
    fkClaims(person("rhea@alder.example"), [FK_SPAN, FK_SPAN, FK_SPAN], "explicit_self"),
  ],
  agent: [
    "finding",
    FK_FINDING,
    fkClaims(
      person("rhea@alder.example"),
      [FK_FINDING_SPAN, FK_FINDING_SPAN, FK_FINDING_SPAN],
      "third_party",
      FK_FINDING_APPOINTMENT,
    ),
  ],
  meeting: [
    "meeting",
    FK_MEETING,
    fkClaims(speakerMention("S2"), [fkTurn(FK_LINES[0]), fkTurn(FK_LINES[1]), fkTurn(FK_LINES[2])], "explicit_self"),
  ],
  moment: [
    "chat",
    FK_MOMENTS,
    fkClaims(
      speakerMention("P1"),
      [fkMomentSpans[0] as string, fkMomentSpans[2] as string, fkMomentSpans[4] as string],
      "explicit_self",
    ),
  ],
};

// The second wording names the owner as the owner, never by a gendered pronoun, outside its
// examples, whose text is the example's own.
const NEUTRAL: readonly [RegExp, string][] = [
  [/\bHis\b/g, "The owner's"],
  [/\bHe\b/g, "The owner"],
  [/\bhis\b/g, "the owner's"],
  [/\bhim(self)?\b/g, "the owner"],
  [/\bhe\b/g, "the owner"],
];
export const neutral = (line: string): string =>
  line.startsWith("Example ") ? line : NEUTRAL.reduce((text, [word, owner]) => text.replace(word, owner), line);
