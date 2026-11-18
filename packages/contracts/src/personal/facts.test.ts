import { BeliefKind } from "@intelligence/contracts";
import {
  AFFILIATION_RELATIONS,
  BELIEF_KINDS_BY_SUBJECT,
  BELIEF_TYPES,
  Cite,
  CompiledBelief,
  CompiledFacts,
  EntityView,
  FactType,
  FactTypeFilter,
  FactView,
  FindFactsArgs,
  PackItem,
  PackSection,
  PersonalBeliefKind,
  RELATIONSHIP_RELATIONS,
  SelfView,
  VIEW_OF_SUBJECT,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";

// Made-up values only.
const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const at = "2026-03-04T10:00:00Z";
const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;
const person = {
  id: `ent_${ULID}`,
  kind: "person",
  name: { untrusted: "Alex Example" },
  address: { untrusted: "alex@example.com" },
};
const org = { id: `ent_${ULID}`, kind: "organization", name: null, address: { untrusted: "alder.example" } };
const base = {
  id: "a".repeat(64),
  subject: person,
  statedBy: person,
  basis: "explicit_self",
  statementKind: "stated_fact",
  at,
  message: `msg_${ULID}`,
  document: null,
  passage: null,
  page: null,
  capture: null,
  segment: null,
  thirdParty: true,
  agentReported: false,
  provenance: "source",
};
const text = (value: string) => ({ untrusted: value });

const facts = {
  role: {
    ...base,
    type: "role",
    fields: { title: text("Head of Finance"), organization: org, organization_name: text("Alder") },
  },
  affiliation: { ...base, type: "affiliation", fields: { relation: "employee", organization_name: text("Alder") } },
  relationship: { ...base, type: "relationship", fields: { counterparty: person, relation: "sibling" } },
  need: { ...base, type: "need", fields: { what: text("I need a designer."), by: "2026-04-01" } },
  capability: { ...base, type: "capability", fields: { what: text("I design kitchens.") } },
  goal: { ...base, type: "goal", fields: { what: text("I want to run a marathon.") } },
  preference: { ...base, type: "preference", fields: { what: text("I prefer mornings."), polarity: "prefers" } },
  constraint: {
    ...base,
    type: "constraint",
    validTo: "2026-05-01T23:59:59.999Z",
    fields: { what: text("I cannot travel."), until: "2026-05-01" },
  },
  situation: { ...base, type: "situation", fields: { what: text("I am on leave.") } },
  // The view, status and visit types.
  view: {
    ...base,
    type: "view",
    fields: { what: text("remote teams ship faster"), topic: text("remote work"), domain: "career" },
  },
  status: {
    ...base,
    type: "status",
    fields: {
      what: text("visa application"),
      organization_name: text("Consulate"),
      state: text("in review"),
      since: "2026-04-01",
      domain: "travel",
    },
  },
  visited: { ...base, type: "visited", fields: { what: text("Lisbon"), when: "2026-03-10", domain: "travel" } },
  consent: { ...base, type: "consent", fields: { about: "introduce", to: org, what: text("Happy to be introduced.") } },
  contact_rule: {
    ...base,
    type: "contact_rule",
    fields: { rule: "do_not_contact", channel: "phone", what: text("Please don't call me at work.") },
  },
  "project.status": { ...base, type: "project.status", fields: { status: "blocked" } },
  "project.decision": { ...base, type: "project.decision", fields: { what: text("We chose the oak.") } },
  "project.fact": { ...base, type: "project.fact", fields: { what: { untrusted: "two firebricks" } } },
  "project.next_step": {
    ...base,
    type: "project.next_step",
    fields: { what: { untrusted: "order the firebricks" }, who: person },
  },
};

const belief = {
  fact: "a".repeat(64),
  state: "b".repeat(64),
  kind: "role",
  type: "role",
  status: "active",
  disputed: false,
  provenance: "source",
  confirmedAt: at,
  reviewAfter: null,
  subject: person,
  values: { organization: org },
  cites: [facts.role],
};

const owner = { id: `ent_${ULID}`, kind: "owner", name: null, address: null };
const activity = {
  ...base,
  subject: owner,
  statedBy: null,
  basis: "system_observed",
  message: null,
  capture: `cap_${ULID}`,
  validTo: "2026-03-04T11:00:00Z",
  thirdParty: false,
  tier: "observed",
};
const activities = {
  "activity.worked_on": {
    ...activity,
    type: "activity.worked_on",
    fields: { repository: text("github.com/example/alder") },
  },
  "activity.researched": {
    ...activity,
    type: "activity.researched",
    fields: { category: "research", host: text("docs.example.org") },
  },
  "activity.messaged": { ...activity, type: "activity.messaged", thirdParty: true, fields: { counterparty: person } },
  "activity.met": { ...activity, type: "activity.met", thirdParty: true, fields: { counterparty: person } },
};

describe("activity facts", () => {
  it("FactView accepts each activity type as code makes it", () => {
    for (const [type, value] of Object.entries(activities)) expect(accepts(FactView, value), type).toBe(true);
    expect(accepts(FactView, { ...activities["activity.worked_on"], fields: { project: person } })).toBe(true);
    expect(
      accepts(FactView, {
        ...activities["activity.researched"],
        fields: { project: person, host: text("docs.example.org") },
      }),
    ).toBe(true);
  });

  it("refuses a theme of none or two, a category outside the list, a span, a message and an agent's", () => {
    expect(accepts(FactView, { ...activities["activity.worked_on"], fields: {} })).toBe(false);
    expect(
      accepts(FactView, {
        ...activities["activity.worked_on"],
        fields: { repository: text("github.com/example/alder"), document: text("~/notes/plan.md") },
      }),
    ).toBe(false);
    expect(
      accepts(FactView, { ...activities["activity.researched"], fields: { host: text("docs.example.org") } }),
    ).toBe(false);
    expect(
      accepts(FactView, {
        ...activities["activity.researched"],
        fields: { category: "gaming", host: text("docs.example.org") },
      }),
    ).toBe(false);
    expect(
      accepts(FactView, { ...activities["activity.worked_on"], fields: { repository: "github.com/example/alder" } }),
    ).toBe(false);
    expect(accepts(FactView, { ...activities["activity.met"], segment: { from: 0, to: 4 } })).toBe(false);
    expect(accepts(FactView, { ...activities["activity.met"], message: `msg_${ULID}` })).toBe(false);
    expect(
      accepts(FactView, { ...activities["activity.met"], agentReported: true, provenance: "agent_reported" }),
    ).toBe(false);
    expect(accepts(FactView, { ...activities["activity.met"], capture: null })).toBe(false);
  });

  it("system_observed is a basis a fact may carry, and the tier observed", () => {
    expect(accepts(FactView, { ...facts.role, basis: "system_observed" })).toBe(true);
    expect(accepts(FactView, { ...facts.role, basis: "web_derived" })).toBe(false);
    expect(accepts(FactView, { ...facts.role, tier: "observed" })).toBe(true);
  });
});

describe("fact types", () => {
  it("FactType holds transaction.receipt, commitment and plan and the thirteen others; a filter may also name either parent", () => {
    // capture.person, then the two capture links, each made by code; a link, made by code from a
    // contact; the owner's four activity facts, each made by code.
    expect(FactType.options).toEqual([
      "transaction.receipt",
      "commitment",
      "plan",
      ...Object.keys(facts),
      "capture.person",
      "capture.anchor",
      "capture.project",
      "link",
      "known_person",
      "owner_tie",
      "connection",
      "activity.worked_on",
      "activity.researched",
      "activity.messaged",
      "activity.met",
      "intro_offer",
    ]);
    for (const type of [...FactType.options, "transaction", "project", "capture", "activity"])
      expect(accepts(FindFactsArgs, { type }), type).toBe(true);
    expect(FactTypeFilter.options).toContain("project");
    expect(FactTypeFilter.options).toContain("capture");
    expect(FactTypeFilter.options).toContain("activity");
    expect(accepts(FindFactsArgs, { type: "role.title" })).toBe(false);
  });

  it("FactView accepts each new type, and refuses an unknown type, a text value outside untrusted, and a relation outside its list", () => {
    for (const [type, value] of Object.entries(facts)) expect(accepts(FactView, value), type).toBe(true);
    expect(accepts(FactView, { ...facts.role, type: "role.title" })).toBe(false);
    expect(accepts(FactView, { ...facts.role, fields: { ...facts.role.fields, title: "Head of Finance" } })).toBe(
      false,
    );
    expect(accepts(FactView, { ...facts.need, fields: { what: "I need a designer." } })).toBe(false);
    expect(
      accepts(FactView, { ...facts.relationship, fields: { ...facts.relationship.fields, relation: "rival" } }),
    ).toBe(false);
    expect(accepts(FactView, { ...facts.affiliation, fields: { ...facts.affiliation.fields, relation: "fan" } })).toBe(
      false,
    );
    expect(accepts(FactView, { ...facts.preference, fields: { ...facts.preference.fields, polarity: "loves" } })).toBe(
      false,
    );
    expect(accepts(FactView, { ...facts.contact_rule, fields: { ...facts.contact_rule.fields, channel: "fax" } })).toBe(
      false,
    );
    // Strict: no field of another type, and no validTo on a type without `until`.
    expect(accepts(FactView, { ...facts.capability, fields: { ...facts.capability.fields, by: "2026-04-01" } })).toBe(
      false,
    );
    expect(accepts(FactView, { ...facts.role, validTo: at })).toBe(false);
    // `until` is a field, never a top-level key, on the types that have one.
    for (const type of ["constraint", "situation", "contact_rule"] as const)
      expect(accepts(FactView, { ...facts[type], until: "2026-05-01" }), type).toBe(false);
  });

  it("a role with no title is refused, and an affiliation with neither organization nor organization_name is refused", () => {
    expect(accepts(FactView, { ...facts.role, fields: { organization: org } })).toBe(false);
    expect(accepts(FactView, { ...facts.role, fields: { title: text("Head of Finance") } })).toBe(true);
    expect(accepts(FactView, { ...facts.affiliation, fields: { relation: "employee" } })).toBe(false);
    expect(accepts(FactView, { ...facts.affiliation, fields: { relation: "employee", organization: org } })).toBe(true);
  });

  it("the closed lists hold exactly the expected words", () => {
    expect(AFFILIATION_RELATIONS).toEqual([
      "employee",
      "founder",
      "owner",
      "member",
      "student",
      "alumnus",
      "advisor",
      "investor",
      "board",
      "contractor",
      "volunteer",
      "other",
    ]);
    expect(RELATIONSHIP_RELATIONS).toEqual([
      "spouse",
      "partner",
      "parent",
      "child",
      "sibling",
      "family",
      "friend",
      "colleague",
      "manager",
      "report",
      "mentor",
      "mentee",
      "assistant",
      "client",
      "vendor",
      "classmate",
      "neighbor",
      "other",
      "acquaintance",
    ]);
    expect(Object.isFrozen(AFFILIATION_RELATIONS)).toBe(true);
  });
});

describe("compiled facts", () => {
  it("a CompiledBelief has at least one citing claim and at most three, and values strict for its kind", () => {
    expect(accepts(CompiledBelief, belief)).toBe(true);
    // Its review date, as BeliefItem's.
    expect(accepts(CompiledBelief, { ...belief, reviewAfter: at })).toBe(true);
    const { reviewAfter: _left, ...without } = belief;
    expect(accepts(CompiledBelief, without)).toBe(false);
    expect(accepts(CompiledBelief, { ...belief, cites: [] })).toBe(false);
    expect(accepts(CompiledBelief, { ...belief, cites: [facts.role, facts.role, facts.role] })).toBe(true);
    expect(accepts(CompiledBelief, { ...belief, cites: [facts.role, facts.role, facts.role, facts.role] })).toBe(false);
    expect(accepts(CompiledBelief, { ...belief, values: { organization: org, title: text("Head") } })).toBe(false);
    expect(accepts(CompiledBelief, { ...belief, values: {} })).toBe(true);
    expect(
      accepts(CompiledBelief, {
        ...belief,
        kind: "relationship",
        type: "relationship",
        values: { counterparty: person, relation: "friend" },
      }),
    ).toBe(true);
    expect(
      accepts(CompiledBelief, {
        ...belief,
        kind: "relationship",
        type: "relationship",
        values: { relation: "friend" },
      }),
    ).toBe(false);
    expect(accepts(CompiledBelief, { ...belief, subject: { ...person, name: "Alex" } })).toBe(false);
    expect(accepts(CompiledBelief, { ...belief, extra: 1 })).toBe(false);
  });

  it("a cite is a FactView, or a held cite with no text: its claim id, type and time alone", () => {
    const held = { held: true, fact: "c".repeat(64), type: "role", at };
    expect(accepts(Cite, held)).toBe(true);
    expect(accepts(Cite, facts.role)).toBe(true);
    // A finding's claim is a FactView whose message is null (find_facts' shape), never a held cite.
    expect(accepts(Cite, { ...facts.role, message: null, agentReported: true, provenance: "agent_reported" })).toBe(
      true,
    );
    // Strict: no text, no message, no subject, and held is true or it is no held cite.
    expect(accepts(Cite, { ...held, fields: { title: text("Head of Finance") } })).toBe(false);
    expect(accepts(Cite, { ...held, message: `msg_${ULID}` })).toBe(false);
    expect(accepts(Cite, { ...held, subject: person })).toBe(false);
    expect(accepts(Cite, { ...held, held: false })).toBe(false);
    expect(accepts(Cite, { ...held, type: "role.title" })).toBe(false);
    expect(accepts(Cite, { ...held, fact: "not-a-claim-id" })).toBe(false);
    // A belief may cite held claims beside FactViews, or held claims only, still at most three.
    expect(accepts(CompiledBelief, { ...belief, cites: [facts.role, held] })).toBe(true);
    expect(accepts(CompiledBelief, { ...belief, cites: [held] })).toBe(true);
    expect(accepts(CompiledBelief, { ...belief, cites: [held, held, held, held] })).toBe(false);
  });

  it("CompiledFacts is strict, and EntityView refuses a facts value that is not CompiledFacts", () => {
    const compiled = { beliefs: [belief], claims: [facts.need], more: false };
    expect(accepts(CompiledFacts, compiled)).toBe(true);
    expect(accepts(CompiledFacts, { beliefs: [belief], claims: [] })).toBe(false);
    expect(accepts(CompiledFacts, { ...compiled, claims: Array.from({ length: 21 }, () => facts.need) })).toBe(false);
    const view = {
      id: `ent_${ULID}`,
      kind: "person",
      names: [text("Alex Example")],
      addresses: [text("alex@example.com")],
      organization: null,
      people: [],
      mail: { inbound: 0, outbound: 0, firstAt: null, lastAt: null },
      lastMeeting: null,
      nextMeeting: null,
      details: [],
      shared: false,
      facts: compiled,
    };
    expect(accepts(EntityView, view)).toBe(true);
    const { facts: _left, ...without } = view;
    expect(accepts(EntityView, without)).toBe(true);
    expect(accepts(EntityView, { ...view, facts: [] })).toBe(false);
    expect(accepts(EntityView, { ...view, facts: { ...compiled, beliefs: [{ ...belief, cites: [] }] } })).toBe(false);
  });

  it("EntityView takes a project, its name among its names and its status, which only a project's view carries", () => {
    const project = {
      id: `ent_${ULID}`,
      kind: "project",
      names: [text("Lighthouse")],
      addresses: [],
      organization: null,
      people: [],
      mail: { inbound: 0, outbound: 0, firstAt: null, lastAt: null },
      lastMeeting: null,
      nextMeeting: null,
      details: [],
      shared: false,
      facts: { beliefs: [], claims: [], more: false },
      status: "active",
    };
    expect(accepts(EntityView, project)).toBe(true);
    for (const status of ["active", "merged", "closed"])
      expect(accepts(EntityView, { ...project, status }), status).toBe(true);
    expect(accepts(EntityView, { ...project, status: "done" })).toBe(false);
    expect(accepts(EntityView, { ...project, names: ["Lighthouse"] })).toBe(false);
  });
});

describe("belief kinds by subject", () => {
  it("PersonalBeliefKind is the shared BeliefKind", () => {
    expect(PersonalBeliefKind).toBe(BeliefKind);
  });

  it("BELIEF_KINDS_BY_SUBJECT is the table of belief kinds by subject kind, with its project row, and frozen", () => {
    expect(BELIEF_KINDS_BY_SUBJECT).toEqual({
      // A view, a status and a visit of the owner's; a person's view and visit.
      owner: [
        "goal",
        "preference",
        "need",
        "capability",
        "constraint",
        "commitment",
        "situation",
        "view",
        "status",
        "visited",
      ],
      person: [
        "need",
        "capability",
        "role",
        "affiliation",
        "relationship",
        "goal",
        "constraint",
        "preference",
        "situation",
        "consent",
        "contact_rule",
        "commitment",
        "view",
        "visited",
      ],
      organization: [
        "need",
        "capability",
        "role",
        "affiliation",
        "relationship",
        "goal",
        "constraint",
        "preference",
        "situation",
        "consent",
        "contact_rule",
      ],
      project: ["project_status", "decision", "commitment", "capture_project"],
    });
    for (const kinds of Object.values(BELIEF_KINDS_BY_SUBJECT))
      for (const kind of kinds) expect(BeliefKind.options).toContain(kind);
    expect(Object.isFrozen(BELIEF_KINDS_BY_SUBJECT)).toBe(true);
    expect(Object.isFrozen(BELIEF_KINDS_BY_SUBJECT.person)).toBe(true);
    expect(VIEW_OF_SUBJECT).toEqual({ owner: "self", person: "people", organization: "people", project: "work" });
    expect(Object.isFrozen(VIEW_OF_SUBJECT)).toBe(true);
  });
});

describe("the owner's stated facts", () => {
  const owner = { id: `ent_${ULID}`, kind: "owner", name: null, address: text("owner@example.org") };
  const goal = {
    ...belief,
    kind: "goal",
    type: "goal",
    subject: owner,
    values: {},
    cites: [{ ...facts.goal, subject: owner, statedBy: owner }],
  };
  const preference = {
    ...belief,
    kind: "preference",
    type: "preference",
    subject: owner,
    values: { polarity: "prefers" },
    cites: [{ held: true, fact: "c".repeat(64), type: "preference", at }],
  };
  const self = {
    addresses: [text("owner@example.org")],
    timeZone: null,
    upcoming: [],
    contacts: [],
    stated: { beliefs: [goal, preference], claims: [], more: false },
    changes: [],
  };

  it("BELIEF_TYPES holds goal, preference, constraint, situation, consent and the two project types among the belief types", () => {
    expect([...BELIEF_TYPES].sort()).toEqual([
      "affiliation",
      "capability",
      "capture.project",
      "commitment",
      "consent",
      "constraint",
      "contact_rule",
      "goal",
      "need",
      "preference",
      "project.decision",
      "project.status",
      "relationship",
      "role",
      "situation",
      "status",
      "view",
      "visited",
    ]);
  });

  it("SelfView takes no stated: sections replace it", () => {
    const { stated, ...without } = self;
    expect(accepts(SelfView, without)).toBe(true);
    expect(accepts(SelfView, { ...without, stated })).toBe(false);
  });

  it("a pack may hold a facts section of belief items", () => {
    expect(PackSection.options).toContain("facts");
    const item = {
      id: goal.fact,
      section: "facts",
      required: false,
      provenance: "source",
      asOf: at,
      kind: "belief",
      belief: goal,
    };
    expect(accepts(PackItem, item)).toBe(true);
    expect(accepts(PackItem, { ...item, belief: { ...goal, cites: [] } })).toBe(false);
    expect(accepts(PackItem, { ...item, belief: { ...goal, extra: 1 } })).toBe(false);
  });
});

describe("the person_brief pack", () => {
  const compiled = { beliefs: [belief], claims: [], more: false };
  const person = {
    id: `ent_${ULID}`,
    kind: "person",
    names: [text("Alex Example")],
    addresses: [text("alex@example.com")],
    organization: null,
    people: [],
    mail: { inbound: 1, outbound: 2, firstAt: at, lastAt: at },
    lastMeeting: null,
    nextMeeting: null,
    details: [],
    shared: false,
  };
  const item = {
    id: person.id,
    section: "person",
    required: true,
    provenance: "source",
    asOf: at,
    kind: "entity",
    entity: person,
  };

  it("a pack may hold a person section of one entity item: get_entity's view without its facts, which the facts section serves", () => {
    expect(PackSection.options).toContain("person");
    expect(accepts(PackItem, item)).toBe(true);
    // The facts are the facts section's, cut to its cap: the entity item holds none.
    expect(accepts(PackItem, { ...item, entity: { ...person, facts: compiled } })).toBe(false);
    expect(accepts(EntityView, { ...person, facts: compiled })).toBe(true);
    // Strict, and evidence text only inside untrusted.
    expect(accepts(PackItem, { ...item, entity: { ...person, extra: 1 } })).toBe(false);
    expect(accepts(PackItem, { ...item, entity: { ...person, names: ["Alex Example"] } })).toBe(false);
  });

  it("a facts item may hold a consent belief, with what was agreed to and to whom, and no words", () => {
    const consent = {
      ...belief,
      kind: "consent",
      type: "consent",
      values: { about: "introduce", to: org },
      cites: [facts.consent],
    };
    expect(
      accepts(PackItem, {
        id: consent.fact,
        section: "facts",
        required: true,
        provenance: "source",
        asOf: at,
        kind: "belief",
        belief: consent,
      }),
    ).toBe(true);
    expect(
      accepts(CompiledBelief, {
        ...consent,
        values: { about: "introduce", to: org, what: text("Happy to be introduced.") },
      }),
    ).toBe(false);
    expect(accepts(CompiledBelief, { ...consent, values: { about: "marry" } })).toBe(false);
  });
});

describe("the two link facts", () => {
  const project = { id: `ent_${ULID}`, kind: "project", name: { untrusted: "Lighthouse" }, address: null };
  const link = {
    id: "d".repeat(64),
    subject: project,
    statedBy: null,
    basis: "third_party",
    statementKind: "stated_fact",
    at,
    message: null,
    document: null,
    passage: null,
    page: null,
    capture: `cap_${ULID}`,
    segment: null,
    thirdParty: false,
    agentReported: false,
    provenance: "source",
  };
  const anchored = { ...link, type: "capture.anchor", fields: { anchor: `pan_${ULID}` } };
  const titled = { ...link, type: "capture.project", fields: {} };

  it("a capture.anchor fact takes an anchor id and nothing else, and a capture.project fact takes no field", () => {
    expect(accepts(FactView, anchored)).toBe(true);
    expect(accepts(FactView, titled)).toBe(true);
    expect(accepts(FactView, { ...anchored, fields: {} })).toBe(false);
    expect(accepts(FactView, { ...anchored, fields: { anchor: `ent_${ULID}` } })).toBe(false);
    expect(accepts(FactView, { ...anchored, fields: { anchor: `pan_${ULID}`, kind: "host" } })).toBe(false);
    expect(accepts(FactView, { ...titled, fields: { anchor: `pan_${ULID}` } })).toBe(false);
    expect(accepts(FactView, { ...titled, fields: { title: { untrusted: "Lighthouse review" } } })).toBe(false);
  });

  it("both are source facts: agentReported false, provenance source, capture set, segment null", () => {
    for (const fact of [anchored, titled]) {
      expect(accepts(FactView, { ...fact, capture: `msg_${ULID}` }), fact.type).toBe(false);
      expect(accepts(FactView, { ...fact, capture: null }), fact.type).toBe(false);
      expect(accepts(FactView, { ...fact, capture: null, message: `msg_${ULID}` }), fact.type).toBe(false);
      expect(accepts(FactView, { ...fact, segment: { from: 0, to: 1 } }), fact.type).toBe(false);
      expect(accepts(FactView, { ...fact, agentReported: true, provenance: "agent_reported" }), fact.type).toBe(false);
      expect(accepts(FactView, { ...fact, provenance: "owner" }), fact.type).toBe(false);
    }
    // And a filter on either, or on their parent, is a filter find_facts takes.
    for (const type of ["capture.anchor", "capture.project", "capture"])
      expect(accepts(FindFactsArgs, { type }), type).toBe(true);
  });

  it("a confirmed title link is a CompiledBelief of kind capture_project, citing capture.project facts only", () => {
    const confirmed = {
      ...belief,
      kind: "capture_project",
      type: "capture.project",
      subject: project,
      values: {},
      cites: [titled],
    };
    expect(accepts(CompiledBelief, confirmed)).toBe(true);
    expect(accepts(CompiledBelief, { ...confirmed, cites: [anchored] })).toBe(false);
    expect(accepts(CompiledBelief, { ...confirmed, values: { project } })).toBe(false);
    expect(accepts(CompiledFacts, { beliefs: [confirmed], claims: [], more: false })).toBe(true);
  });
});
