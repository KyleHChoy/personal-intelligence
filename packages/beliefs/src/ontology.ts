import { OntologyType, type OntologyView, type Store } from "@intelligence/contracts";
import {
  AFFILIATION_RELATIONS,
  CLOSENESS,
  CONNECTION_KINDS,
  CONNECTION_TYPE,
  CONSENT_SUBJECTS,
  CONTACT_CHANNELS,
  CONTACT_RULES,
  CURRENCY_CODES,
  INTRO_OFFERS,
  KEY_FIELDS,
  KNOWN_PERSON_TYPE,
  LIFE_DOMAINS,
  LINK_KINDS,
  type MessageLane,
  OWNER_TIE_TYPE,
  PREFERENCE_POLARITIES,
  PROJECT_STATUSES,
  RELATIONSHIP_RELATIONS,
  type SubjectKind,
  TIE_RELATIONS,
} from "@intelligence/contracts/personal";

// The personal ontology. A constant: each entry is parsed with the shared OntologyType, and carries
// what the personal checks read beside it.

// How a text field's value must stand in its passage: a phrase needs word boundaries, a statement
// must be whole sentences or whole lines.
export type Grounding = "phrase" | "statement";

// What a subject or an entity field may be. `project` is a subject kind of the contracts, resolved
// only by an owner's anchor.
type ExtractSubjectKind = SubjectKind;

// `entityKinds` gives, for each entity field, the kinds of entity it may name.
export type PersonalType = OntologyType & {
  lane: MessageLane;
  subjectKinds: ExtractSubjectKind[];
  scope: "thread" | "global";
  meaning: string;
  grounding: Record<string, Grounding>;
  entityKinds: Record<string, SubjectKind[]>;
};

const OWNER: Store = "personal";

const typed = (type: Omit<PersonalType, keyof OntologyType> & { type: unknown }): PersonalType => {
  const { type: raw, ...rest } = type;
  return Object.freeze({ ...OntologyType.parse(raw), ...rest });
};

type Spec = Omit<PersonalType, keyof OntologyType | "lane" | "grounding" | "entityKinds"> & {
  id: string;
  parent?: string;
  beliefKind?: string;
  fields: {
    name: string;
    kind: string;
    values?: readonly string[];
    required: boolean;
    grounding?: Grounding;
    entity?: readonly SubjectKind[];
  }[];
};
const correspondence = ({ id, parent, beliefKind, fields, ...rest }: Spec): PersonalType =>
  typed({
    type: {
      id,
      ...(parent === undefined ? {} : { parent }),
      synonyms: [],
      owner: OWNER,
      ...(beliefKind === undefined ? {} : { beliefKind }),
      fields: fields.map(({ grounding: _g, entity: _e, values, ...field }) => ({
        ...field,
        ...(values === undefined ? {} : { values: [...values] }),
      })),
    },
    lane: "correspondence",
    ...rest,
    grounding: Object.fromEntries(
      fields.flatMap((field) => (field.grounding === undefined ? [] : [[field.name, field.grounding]])),
    ),
    entityKinds: Object.fromEntries(
      fields.flatMap((field) => (field.entity === undefined ? [] : [[field.name, [...field.entity]]])),
    ),
  });

const what = { name: "what", kind: "text", required: true, grounding: "statement" } as const;
const date = (name: string) => ({ name, kind: "date", required: false });
const choice = (name: string, values: readonly string[], required = true) => ({ name, kind: "enum", values, required });
// `acquaintance` is offered by the second-degree versions alone, behind their evaluation and
// switch; every earlier version offers the relations it offered.
const OFFERED_RELATIONS = RELATIONSHIP_RELATIONS.filter((relation) => relation !== "acquaintance");
const relationshipOf = (relations: readonly string[]): PersonalType =>
  correspondence({
    id: "relationship",
    beliefKind: "relationship",
    subjectKinds: ["person"],
    scope: "global",
    meaning:
      "how the subject is related to the counterparty: family, friend, colleague, manager and so on; relation is what the counterparty is to the subject",
    fields: [{ name: "counterparty", kind: "entity", required: true, entity: PEOPLE }, choice("relation", relations)],
  });
const organization = [
  { name: "organization", kind: "entity", required: false, entity: ["organization"] },
  { name: "organization_name", kind: "text", required: false, grounding: "phrase" },
] as const;
const PEOPLE: SubjectKind[] = ["owner", "person"];
const ANYONE: ExtractSubjectKind[] = ["owner", "person", "organization"];

// The parent of every transaction type. It has no fields, belongs to no lane and is in no
// lane's view, so a model that names it is refused as an unknown type. Only the whole view
// shows it, so `descendants("transaction")` finds a receipt.
export const TRANSACTION_PARENT: OntologyType = Object.freeze(
  OntologyType.parse({ id: "transaction", synonyms: [], fields: [], owner: OWNER }),
);
// The parent of the two project types, in the same way.
export const PROJECT_PARENT: OntologyType = Object.freeze(
  OntologyType.parse({ id: "project", synonyms: [], fields: [], owner: OWNER }),
);

export const PERSONAL_TYPES: readonly PersonalType[] = Object.freeze([
  typed({
    type: {
      id: "transaction.receipt",
      parent: "transaction",
      synonyms: [],
      owner: OWNER,
      fields: [
        { name: "merchant", kind: "text", required: true },
        { name: "amount", kind: "number", required: true },
        { name: "currency", kind: "enum", values: [...CURRENCY_CODES], required: true },
        { name: "date", kind: "date", required: false },
        { name: "order_ref", kind: "text", required: false },
      ],
    },
    lane: "transaction",
    subjectKinds: ["owner"],
    scope: "global",
    meaning: "a purchase or payment the message confirms: who was paid, how much, in which currency, on which day",
    grounding: { merchant: "phrase", order_ref: "phrase" },
    entityKinds: {},
  }),
  typed({
    type: {
      id: "commitment",
      synonyms: [],
      owner: OWNER,
      beliefKind: "commitment",
      fields: [
        { name: "counterparty", kind: "entity", required: true },
        { name: "what", kind: "text", required: true },
        { name: "due", kind: "date", required: false },
      ],
    },
    lane: "correspondence",
    subjectKinds: ["owner", "person"],
    scope: "thread",
    meaning: "something the subject says they will do for the counterparty; the subject is who will do it",
    grounding: { what: "statement" },
    entityKinds: { counterparty: PEOPLE },
  }),
  typed({
    type: {
      id: "plan",
      synonyms: [],
      owner: OWNER,
      fields: [
        { name: "counterparty", kind: "entity", required: false },
        { name: "what", kind: "text", required: true },
        { name: "when", kind: "date", required: true },
      ],
    },
    lane: "correspondence",
    subjectKinds: ["owner", "person"],
    scope: "thread",
    meaning:
      "an arrangement to meet or do something together at a stated date; the subject is who proposed or confirmed it",
    grounding: { what: "statement" },
    entityKinds: { counterparty: PEOPLE },
  }),
  correspondence({
    id: "role",
    beliefKind: "role",
    subjectKinds: ["owner", "person"],
    scope: "global",
    meaning: "the subject's job title or position, at an organization when the message names one",
    fields: [{ name: "title", kind: "text", required: true, grounding: "phrase" }, ...organization],
  }),
  correspondence({
    id: "affiliation",
    beliefKind: "affiliation",
    subjectKinds: ["owner", "person"],
    scope: "global",
    meaning:
      "how the subject belongs to an organization: works there, founded it, studies there, advises it and so on; the organization by its domain, by its name, or both",
    fields: [choice("relation", AFFILIATION_RELATIONS), ...organization],
  }),
  relationshipOf(OFFERED_RELATIONS),
  correspondence({
    id: "need",
    beliefKind: "need",
    subjectKinds: ANYONE,
    scope: "thread",
    meaning: "something the subject says they need or are looking for, by a date when one is given",
    fields: [what, date("by")],
  }),
  correspondence({
    id: "capability",
    beliefKind: "capability",
    subjectKinds: ANYONE,
    scope: "thread",
    meaning: "something the subject can do or offers to others",
    fields: [what],
  }),
  correspondence({
    id: "goal",
    beliefKind: "goal",
    subjectKinds: ANYONE,
    scope: "thread",
    meaning: "something the subject says they want to achieve, by a date when one is given",
    fields: [what, date("by")],
  }),
  correspondence({
    id: "preference",
    beliefKind: "preference",
    subjectKinds: ["owner", "person"],
    scope: "thread",
    meaning: "something the subject says they like, dislike, prefer or avoid",
    fields: [what, choice("polarity", PREFERENCE_POLARITIES)],
  }),
  correspondence({
    id: "constraint",
    beliefKind: "constraint",
    subjectKinds: ANYONE,
    scope: "thread",
    meaning: "something the subject says limits what they can do, until a date when one is given",
    fields: [what, date("until")],
  }),
  correspondence({
    id: "situation",
    beliefKind: "situation",
    subjectKinds: ANYONE,
    scope: "global",
    meaning: "the subject's current circumstances, such as being on leave or moving, until a date when one is given",
    fields: [what, date("until")],
  }),
  correspondence({
    id: "consent",
    beliefKind: "consent",
    subjectKinds: ["person"],
    scope: "global",
    meaning:
      "what the subject says they agree to: sharing their details, an introduction, being quoted or being contacted, to whom when the message names them",
    fields: [
      choice("about", CONSENT_SUBJECTS),
      { name: "to", kind: "entity", required: false, entity: ["person", "organization"] },
      what,
    ],
  }),
  correspondence({
    id: "contact_rule",
    beliefKind: "contact_rule",
    subjectKinds: ["person"],
    scope: "global",
    meaning:
      "how the subject asks to be contacted or not: not at all, only through someone, by a preferred channel, or not before a date",
    fields: [choice("rule", CONTACT_RULES), choice("channel", CONTACT_CHANNELS), what, date("until")],
  }),
  correspondence({
    id: "project.status",
    parent: "project",
    beliefKind: "project_status",
    subjectKinds: ["project"],
    scope: "global",
    meaning: "where the project of this thread stands",
    fields: [choice("status", PROJECT_STATUSES), { ...what, required: false }],
  }),
  correspondence({
    id: "project.decision",
    parent: "project",
    beliefKind: "decision",
    subjectKinds: ["project"],
    scope: "thread",
    meaning: "a decision made in this thread about its project",
    fields: [what],
  }),
  // A person's own offer to introduce the owner to another person, or advice that the owner meet
  // them. No belief kind: it is read as claims. Offered only by the second-degree prompt versions
  // (SECOND_DEGREE_TYPES); check.ts keeps it only first-hand.
  correspondence({
    id: "intro_offer",
    subjectKinds: ["person"],
    scope: "global",
    meaning:
      "the subject's own offer to introduce the owner to a person, or advice that the owner meet them; person is the one to meet and offer says which",
    fields: [{ name: "person", kind: "entity", required: true, entity: ["person"] }, choice("offer", INTRO_OFFERS)],
  }),
]);

// What only the second-degree prompt versions offer. Every earlier version's list leaves them out,
// so its text, its hash and its check are what they were.
export const SECOND_DEGREE_TYPES: readonly string[] = Object.freeze(["intro_offer"]);
export const beforeSecondDegree = (type: PersonalType): boolean => !SECOND_DEGREE_TYPES.includes(type.id);

// Version 4 of the six owner-side kinds, which personal_correspondence version 4 and
// personal_agent_record version 3 list. Each states one proposition: its `domain`, one of the
// closed list, and its key phrase, a short `phrase` slice in place of the `what` statement. Their
// scope stays as version 3's, so a version 1 fact key is unchanged; fact key version 2 decides the
// rest (fact-key.ts).
const keyPhraseField = (name: string) => ({ name, kind: "text", required: true, grounding: "phrase" }) as const;
const lifeDomain = choice("domain", LIFE_DOMAINS);
export const V4_TYPES: readonly PersonalType[] = Object.freeze([
  correspondence({
    id: "need",
    beliefKind: "need",
    subjectKinds: ANYONE,
    scope: "thread",
    meaning:
      "one thing the subject lacks or is looking for that lasts beyond this exchange, by a date when one is given; object is that thing. A question asked in passing, a request for directions, logistics or next steps in this exchange, and a request to meet are not needs",
    fields: [keyPhraseField(KEY_FIELDS.need.phrase), lifeDomain, date("by")],
  }),
  correspondence({
    id: "capability",
    beliefKind: "capability",
    subjectKinds: ANYONE,
    scope: "thread",
    meaning:
      "one skill, expertise, asset or resource the subject has and could bring to others; object is that skill or asset. An offer of courtesy, such as to share more, to send materials, to give a demonstration, to meet or to fit someone's schedule, is not a capability",
    fields: [keyPhraseField(KEY_FIELDS.capability.phrase), lifeDomain],
  }),
  correspondence({
    id: "goal",
    beliefKind: "goal",
    subjectKinds: ANYONE,
    scope: "thread",
    meaning:
      "one objective the subject is pursuing over weeks or longer, by a date when one is given; objective is what they want to achieve. A wish to meet, talk, connect or hear feedback in this exchange, a pleasantry, and a request to a company about an account, a subscription or its settings are not goals",
    fields: [keyPhraseField(KEY_FIELDS.goal.phrase), lifeDomain, date("by")],
  }),
  correspondence({
    id: "preference",
    beliefKind: "preference",
    subjectKinds: ["owner", "person"],
    scope: "thread",
    meaning:
      "one thing the subject says they prefer or avoid in general, beyond this one exchange; object is that thing, written without a negation word, and polarity says whether they prefer it or avoid it",
    fields: [keyPhraseField(KEY_FIELDS.preference.phrase), lifeDomain, choice("polarity", ["prefers", "avoids"])],
  }),
  correspondence({
    id: "constraint",
    beliefKind: "constraint",
    subjectKinds: ANYONE,
    scope: "thread",
    meaning: "one lasting limit on what the subject can do, until a date when one is given; rule is that limit",
    fields: [keyPhraseField(KEY_FIELDS.constraint.phrase), lifeDomain, date("until")],
  }),
  correspondence({
    id: "situation",
    beliefKind: "situation",
    subjectKinds: ANYONE,
    scope: "global",
    meaning:
      "one of the subject's current circumstances, such as being on leave or moving, until a date when one is given; state is that circumstance. momentary is true when it holds for a day or two, such as a trip today or an errand tomorrow",
    fields: [
      keyPhraseField(KEY_FIELDS.situation.phrase),
      lifeDomain,
      date("until"),
      { name: "momentary", kind: "boolean", required: false },
    ],
  }),
]);

// A project's detail and next step. A finding holds both and a message in a project its next step; no
// other lane's view holds them, so another lane's model naming one is refused. Their definitions are
// the kind registry's (fact-kind-prompts.test.ts). Neither builds a belief: they are read as claims,
// agent-reported and unconfirmed.
export const PROJECT_FINDING_TYPES: readonly PersonalType[] = Object.freeze([
  correspondence({
    id: "project.fact",
    parent: "project",
    subjectKinds: ["project"],
    scope: "thread",
    meaning:
      "one detail about the project the finding is filed under, such as a specification, an order or a part; what copies the words that state it",
    fields: [{ name: "what", kind: "text", required: true, grounding: "phrase" }],
  }),
  correspondence({
    id: "project.next_step",
    parent: "project",
    subjectKinds: ["project"],
    scope: "thread",
    meaning:
      "one thing to do next on the project the finding is filed under; what copies the words that state it, who is the owner or the person to do it, due is the date when one is given",
    fields: [
      { name: "what", kind: "text", required: true, grounding: "phrase" },
      { name: "who", kind: "entity", required: true, entity: PEOPLE },
      date("due"),
    ],
  }),
]);

// The owner's view, an organization's status about the owner and a place they have been, each one proposition in
// version 4's shape (a domain and a key phrase). Only the fact-kind prompt versions offer them
// (FACT_KIND_VERSIONS); an agent's proposal or typed claim takes them through the whole view
// (personalType). A view's topic is optional here so the owner's kind ruling can move a situation
// to a view (the agent's contract requires one).
const textField = (name: string, required: boolean) => ({ name, kind: "text", required, grounding: "phrase" }) as const;
export const ADDED_FACT_TYPES: readonly PersonalType[] = Object.freeze([
  correspondence({
    id: "view",
    beliefKind: "view",
    subjectKinds: ["owner", "person"],
    scope: "global",
    meaning:
      "one opinion or thesis the subject holds about the world, in their own words; topic is what it is about and view the opinion itself. A plan, a task or a circumstance is not a view",
    fields: [keyPhraseField(KEY_FIELDS.view.phrase), lifeDomain, textField("topic", false)],
  }),
  correspondence({
    id: "status",
    beliefKind: "status",
    subjectKinds: ["owner"],
    scope: "global",
    meaning:
      "where an organization's process about the subject stands: an application in review, an order shipped, an account suspended; organization_name is the organization, process what it is handling and state where it stands now",
    fields: [
      { name: "organization_name", kind: "text", required: true, grounding: "phrase" },
      keyPhraseField(KEY_FIELDS.status.phrase),
      textField("state", true),
      lifeDomain,
      date("since"),
    ],
  }),
  correspondence({
    id: "visited",
    beliefKind: "visited",
    subjectKinds: ["owner", "person"],
    scope: "global",
    meaning:
      "a place the subject has been: a city, a country or a venue; place is that place, and when the day they were there when one is given",
    fields: [keyPhraseField(KEY_FIELDS.visited.phrase), lifeDomain, date("when")],
  }),
]);

// The field names version 4 gives a type and version 3 does not: what a version 1 fact key of a
// version 4 claim leaves out (fact-key.ts, `legacyFactKey`).
export function v4FieldsOf(id: string): string[] {
  const v3 = PERSONAL_TYPES.find((type) => type.id === id)?.fields ?? [];
  const v4 = V4_TYPES.find((type) => type.id === id)?.fields ?? [];
  return v4.filter((field) => !v3.some((old) => old.name === field.name)).map((field) => field.name);
}

// A field is required only when both versions require it, so `what` is optional and every field
// version 4 adds is optional; an enum keeps version 3's values, which hold version 4's.
function union(v3: PersonalType, v4: PersonalType): PersonalType {
  const both = (name: string) => v4.fields.some((field) => field.name === name && field.required);
  const added = v4.fields.filter((field) => !v3.fields.some((old) => old.name === field.name));
  const { lane: _lane, subjectKinds, scope, meaning, grounding, entityKinds, ...type } = v3;
  return typed({
    type: {
      ...type,
      fields: [
        ...v3.fields.map((field) => ({ ...field, required: field.required && both(field.name) })),
        ...added.map((field) => ({ ...field, required: false })),
      ],
    },
    lane: v3.lane,
    subjectKinds,
    scope,
    meaning,
    grounding: { ...grounding, ...v4.grounding },
    entityKinds: { ...entityKinds, ...v4.entityKinds },
  });
}

// The relationship the second-degree versions offer, with every relation of the contracts,
// `acquaintance` among them.
export const RELATIONSHIP_SD: PersonalType = relationshipOf(RELATIONSHIP_RELATIONS);

// Every type as fact keys, beliefs and the checks read it: version 3's, each owner-side kind as the
// union of its two versions, and the relationship with every relation.
const WHOLE_TYPES: readonly PersonalType[] = Object.freeze([
  ...PERSONAL_TYPES.map((type) => {
    if (type.id === RELATIONSHIP_SD.id) return RELATIONSHIP_SD;
    const v4 = V4_TYPES.find((next) => next.id === type.id);
    return v4 === undefined ? type : union(type, v4);
  }),
  ...ADDED_FACT_TYPES,
  ...PROJECT_FINDING_TYPES,
]);

// The types of personal_correspondence version 1, whose text is pinned by its hash.
export const VERSION_1_TYPES: readonly string[] = Object.freeze(["commitment", "plan"]);

export const personalType = (id: string): PersonalType | undefined => WHOLE_TYPES.find((type) => type.id === id);

// One view over a list of types. `ownerOf` answers personal, `resolvePhrase` answers nothing,
// and `descendants` follows `parent`, the type itself left out, as the shared view does.
export function viewOf(types: readonly OntologyType[]): OntologyView {
  const descendants = (id: string): string[] =>
    types.filter((type) => type.parent === id).flatMap((child) => [child.id, ...descendants(child.id)]);
  return Object.freeze({
    get: (id: string) => types.find((type) => type.id === id) ?? null,
    ownerOf: (id: string) => (types.some((type) => type.id === id) ? OWNER : null),
    resolvePhrase: () => [],
    descendants: (id: string) => descendants(id).sort(),
  });
}

// A meeting's title link, made by the link step by code and by no model, so it is in no lane's view
// and no prompt lists it, and the extraction check refuses it from a model as an unknown type. It
// is in the whole view, so the belief build finds its kind. It has no field: its subject is the
// project, and its claim cites its item.
export const CAPTURE_PROJECT: OntologyType = Object.freeze(
  OntologyType.parse({ id: "capture.project", synonyms: [], fields: [], owner: OWNER, beliefKind: "capture_project" }),
);

// A link on a person, made by code from a contact or an import (personal-core's linkClaims) and by
// no model, so, as capture.project, it is in no lane's view and no prompt lists it. It builds no
// belief. Its kind and label are values: only its URL says which fact it is (fact-key.ts).
export const PERSON_LINK: OntologyType = Object.freeze(
  OntologyType.parse({
    id: "link",
    synonyms: [],
    owner: OWNER,
    fields: [
      { name: "url", kind: "text", required: true },
      { name: "kind", kind: "enum", values: [...LINK_KINDS], required: true },
      { name: "label", kind: "text", required: false },
    ],
  }),
);

// The three types code builds from an agent's propose_person record, by no model, so, as `link`,
// they are in no lane's view and no prompt lists them, and build no belief. A known person is about
// the owner and names no entity: the person exists only once the owner confirms it. A tie is a person's,
// to the owner; a connection a person's, to another person or an organization.
const KNOWN_PERSON: OntologyType = Object.freeze(
  OntologyType.parse({
    id: KNOWN_PERSON_TYPE,
    synonyms: [],
    owner: OWNER,
    fields: [
      { name: "name", kind: "text", required: true },
      { name: "known_how", kind: "text", required: true },
      { name: "email", kind: "text", required: false },
      { name: "phone", kind: "text", required: false },
      { name: "linkedin", kind: "text", required: false },
    ],
  }),
);
const OWNER_TIE: OntologyType = Object.freeze(
  OntologyType.parse({
    id: OWNER_TIE_TYPE,
    synonyms: [],
    owner: OWNER,
    fields: [
      { name: "relation", kind: "enum", values: [...TIE_RELATIONS], required: true },
      { name: "closeness", kind: "enum", values: [...CLOSENESS], required: true },
    ],
  }),
);
const CONNECTION: OntologyType = Object.freeze(
  OntologyType.parse({
    id: CONNECTION_TYPE,
    synonyms: [],
    owner: OWNER,
    fields: [
      { name: "kind", kind: "enum", values: [...CONNECTION_KINDS], required: true },
      { name: "other", kind: "entity", required: true },
      { name: "inferred", kind: "boolean", required: true },
    ],
  }),
);

// Every type, the parent with them: what fact keys and beliefs are made under. The owner-side kinds
// are the union of their versions, so `declaredFields` keeps every version 1 key as it is.
export const PERSONAL_ONTOLOGY: OntologyView = viewOf([
  TRANSACTION_PARENT,
  PROJECT_PARENT,
  ...WHOLE_TYPES,
  CAPTURE_PROJECT,
  PERSON_LINK,
  KNOWN_PERSON,
  OWNER_TIE,
  CONNECTION,
]);
