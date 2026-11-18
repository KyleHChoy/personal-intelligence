import { OntologyType } from "@intelligence/contracts";
import {
  AFFILIATION_RELATIONS,
  CURRENCY_CODES,
  FactType,
  KEY_FIELDS,
  LIFE_DOMAINS,
  RELATIONSHIP_RELATIONS,
} from "@intelligence/contracts/personal";
import {
  PERSONAL_ONTOLOGY,
  PERSONAL_TYPES,
  PROJECT_PARENT,
  personalType,
  TRANSACTION_PARENT,
  V4_TYPES,
} from "@intelligence/personal-beliefs";
import { describe, expect, it } from "vitest";
import {
  agentOntology,
  CORRESPONDENCE_V4_TYPES,
  DOCUMENT_TYPES,
  MEETING_TYPES,
  MEETING_TYPES_V1,
  ontologyFor,
  TRANSACTION_TYPES_V2,
  TRANSACTION_V2_TYPES,
} from "./lane-versions.ts";

describe("the transaction lane's version 2", () => {
  it("offers the receipt, a situation in version 4's shape and a plan, and no other type; version 1 and an unversioned ask differ only by them", () => {
    expect(TRANSACTION_TYPES_V2).toEqual(["transaction.receipt", "situation", "plan"]);
    expect(TRANSACTION_V2_TYPES.map((type) => type.id)).toEqual([...TRANSACTION_TYPES_V2]);
    for (const view of [ontologyFor("transaction", "2"), ontologyFor("transaction")]) {
      for (const id of TRANSACTION_TYPES_V2) expect(view.get(id)?.id, id).toBe(id);
      for (const id of [
        "commitment",
        "role",
        "affiliation",
        "relationship",
        "need",
        "capability",
        "goal",
        "preference",
        "constraint",
        "consent",
        "contact_rule",
        "project.status",
        "project.decision",
      ])
        expect(view.get(id), id).toBeNull();
      expect(view.get("transaction")).toBeNull();
      expect(view.ownerOf("transaction")).toBeNull();
    }
    // The situation is the one the meeting and moment lanes write: its state phrase and life domain.
    const situation = TRANSACTION_V2_TYPES.find((type) => type.id === "situation");
    expect(situation).toBe(CORRESPONDENCE_V4_TYPES.find((type) => type.id === "situation"));
    expect(situation?.fields.map((field) => field.name)).toEqual(["state", "domain", "until", "momentary"]);
    expect(situation?.subjectKinds).toContain("owner");
    expect(TRANSACTION_V2_TYPES.find((type) => type.id === "plan")?.subjectKinds).toContain("owner");
    // The receipt keeps its one shape.
    expect(TRANSACTION_V2_TYPES[0]).toBe(PERSONAL_TYPES.find((type) => type.id === "transaction.receipt"));
  });
});

describe("the personal ontology", () => {
  it("every type parses, has an owner of personal, and belongs to one lane", () => {
    // capture.person and the two capture links are made by code and are no model's type. So is a
    // link, made by code from a contact, and the owner's activity facts, made by the activity step.
    expect(PERSONAL_TYPES.map((type) => type.id)).toEqual(
      // View, status and visited (ADDED_FACT_TYPES) and a project's detail and next step
      // (PROJECT_FINDING_TYPES) are no lane's type.
      FactType.options.filter(
        (type) =>
          !type.startsWith("capture.") &&
          !type.startsWith("activity.") &&
          ![
            "link",
            "known_person",
            "owner_tie",
            "connection",
            "view",
            "status",
            "visited",
            "project.fact",
            "project.next_step",
          ].includes(type),
      ),
    );
    for (const type of PERSONAL_TYPES) {
      const {
        lane: _lane,
        subjectKinds: _kinds,
        scope: _scope,
        meaning: _meaning,
        grounding: _grounding,
        entityKinds: _entities,
        ...shared
      } = type;
      expect(OntologyType.parse(shared)).toEqual(shared);
      expect(type.owner).toBe("personal");
      expect(["correspondence", "transaction"]).toContain(type.lane);
      expect(PERSONAL_ONTOLOGY.ownerOf(type.id)).toBe("personal");
    }
    expect(PERSONAL_TYPES.find((type) => type.id === "transaction.receipt")?.lane).toBe("transaction");
    expect(PERSONAL_TYPES.filter((type) => type.lane === "transaction").map((type) => type.id)).toEqual([
      "transaction.receipt",
    ]);
  });

  it("a lane's view shows its own types and no other, and never the parent", () => {
    // Transaction version 1's view is the receipt alone.
    const transaction = ontologyFor("transaction", "1");
    const correspondence = ontologyFor("correspondence");
    expect(transaction.get("transaction.receipt")?.id).toBe("transaction.receipt");
    expect(transaction.get("commitment")).toBeNull();
    expect(transaction.get("plan")).toBeNull();
    expect(transaction.get("situation")).toBeNull();
    expect(transaction.get("transaction")).toBeNull();
    expect(transaction.ownerOf("transaction")).toBeNull();
    expect(correspondence.get("commitment")?.id).toBe("commitment");
    expect(correspondence.get("plan")?.id).toBe("plan");
    expect(correspondence.get("transaction.receipt")).toBeNull();
    expect(correspondence.get("transaction")).toBeNull();
    expect(correspondence.resolvePhrase("commitment")).toEqual([]);
    // The whole view shows the parent, so a receipt is found under it.
    expect(PERSONAL_ONTOLOGY.get("transaction")).toEqual(TRANSACTION_PARENT);
    expect(PERSONAL_ONTOLOGY.descendants("transaction")).toEqual(["transaction.receipt"]);
  });

  it("every text field has a grounding, and no other field has one", () => {
    for (const type of PERSONAL_TYPES) {
      const text = type.fields
        .filter((field) => field.kind === "text")
        .map((field) => field.name)
        .sort();
      expect(Object.keys(type.grounding).sort()).toEqual(text);
      for (const how of Object.values(type.grounding)) expect(["phrase", "statement"]).toContain(how);
    }
  });

  it("the currency field takes the contract's list", () => {
    const receipt = PERSONAL_TYPES.find((type) => type.id === "transaction.receipt");
    const currency = receipt?.fields.find((field) => field.name === "currency");
    expect(currency?.kind).toBe("enum");
    expect(currency?.values).toEqual([...CURRENCY_CODES]);
  });

  it("belief-kinds: belief kinds only on the kinds that build a belief", () => {
    const kinds = Object.fromEntries(
      PERSONAL_TYPES.flatMap((type) => (type.beliefKind === undefined ? [] : [[type.id, type.beliefKind]])),
    );
    expect(kinds).toEqual({
      commitment: "commitment",
      role: "role",
      affiliation: "affiliation",
      relationship: "relationship",
      need: "need",
      capability: "capability",
      goal: "goal",
      preference: "preference",
      constraint: "constraint",
      situation: "situation",
      consent: "consent",
      contact_rule: "contact_rule",
      "project.status": "project_status",
      "project.decision": "decision",
    });
  });

  it("belief-kinds: the table's subject kinds, scopes, closed lists and entity kinds", () => {
    const row = (id: string) => personalType(id);
    expect(row("role")).toMatchObject({
      subjectKinds: ["owner", "person"],
      scope: "global",
      grounding: { title: "phrase", organization_name: "phrase" },
      entityKinds: { organization: ["organization"] },
    });
    expect(row("relationship")).toMatchObject({
      subjectKinds: ["person"],
      scope: "global",
      entityKinds: { counterparty: ["owner", "person"] },
    });
    expect(row("need")).toMatchObject({
      subjectKinds: ["owner", "person", "organization"],
      scope: "thread",
      grounding: { what: "statement" },
    });
    expect(row("situation")?.scope).toBe("global");
    expect(row("project.status")).toMatchObject({ parent: "project", subjectKinds: ["project"] });
    expect(row("affiliation")?.fields.find((field) => field.name === "relation")?.values).toEqual([
      ...AFFILIATION_RELATIONS,
    ]);
    expect(row("relationship")?.fields.find((field) => field.name === "relation")?.values).toEqual([
      ...RELATIONSHIP_RELATIONS,
    ]);
    for (const view of [
      ontologyFor("correspondence"),
      ontologyFor("correspondence", "4"),
      ontologyFor("meeting", "7"),
      ontologyFor("moment", "9"),
    ])
      expect(view.get("relationship")?.fields.find((field) => field.name === "relation")?.values).toEqual(
        RELATIONSHIP_RELATIONS.filter((relation) => relation !== "acquaintance"),
      );
    // Every entity field has its kinds, and nothing else does.
    for (const type of PERSONAL_TYPES)
      expect(Object.keys(type.entityKinds).sort(), type.id).toEqual(
        type.fields
          .filter((field) => field.kind === "entity")
          .map((field) => field.name)
          .sort(),
      );
    expect(PERSONAL_ONTOLOGY.get("project")).toEqual(PROJECT_PARENT);
    expect(PERSONAL_ONTOLOGY.descendants("project")).toEqual([
      "project.decision",
      "project.fact",
      "project.next_step",
      "project.status",
    ]);
    expect(ontologyFor("correspondence").get("project")).toBeNull();
  });

  it("agentOntology: version 1 shows commitment and plan only, version 2 every correspondence type, and neither a parent", () => {
    const correspondence = PERSONAL_TYPES.filter(
      (type) => type.lane === "correspondence" && type.id !== "intro_offer",
    ).map((type) => type.id);
    expect(agentOntology("2").get("intro_offer")).toBeNull();
    for (const id of correspondence) {
      expect(agentOntology("2").get(id)?.id).toBe(id);
      expect(agentOntology("1").get(id)?.id ?? null).toBe(["commitment", "plan"].includes(id) ? id : null);
    }
    for (const id of ["project", "transaction", "transaction.receipt"]) {
      expect(agentOntology("1").get(id)).toBeNull();
      expect(agentOntology("2").get(id)).toBeNull();
    }
  });

  it("version 4: the six owner-side kinds carry a domain of the closed list and a phrase-grounded key phrase in place of what", () => {
    // The three fact kinds are ADDED_FACT_TYPES, held to the kind registry (fact-guide.test.ts).
    expect(V4_TYPES.map((type) => type.id).sort()).toEqual(
      Object.keys(KEY_FIELDS)
        .filter((kind) => !["view", "status", "visited"].includes(kind))
        .sort(),
    );
    for (const type of V4_TYPES) {
      const kind = KEY_FIELDS[type.id as keyof typeof KEY_FIELDS];
      expect(type.fields.find((field) => field.name === "domain")).toEqual({
        name: "domain",
        kind: "enum",
        values: [...LIFE_DOMAINS],
        required: true,
      });
      expect(type.fields.find((field) => field.name === kind.phrase)).toEqual({
        name: kind.phrase,
        kind: "text",
        required: true,
      });
      expect(type.grounding).toEqual({ [kind.phrase]: "phrase" });
      expect(type.fields.some((field) => field.name === "what")).toBe(false);
      for (const name of kind.key)
        expect(
          type.fields.some((field) => field.name === name),
          `${type.id}.${name}`,
        ).toBe(true);
      // Each keeps version 3's subject kinds, scope and belief kind, so a version 1 key is unchanged.
      const v3 = PERSONAL_TYPES.find((one) => one.id === type.id);
      expect([type.subjectKinds, type.scope, type.beliefKind]).toEqual([v3?.subjectKinds, v3?.scope, v3?.beliefKind]);
    }
    expect(personalType("situation")?.fields.find((field) => field.name === "momentary")).toEqual({
      name: "momentary",
      kind: "boolean",
      required: false,
    });
    for (const id of ["role", "affiliation", "relationship"])
      expect(
        CORRESPONDENCE_V4_TYPES.find((type) => type.id === id)?.fields.some((field) => field.name === "domain"),
      ).toBe(false);
  });

  it("E14: the whole view is the union, every field version 4 adds optional and what no longer required; version 3's types and its lane view are unchanged", () => {
    for (const type of V4_TYPES) {
      const whole = PERSONAL_ONTOLOGY.get(type.id);
      const v3 = PERSONAL_TYPES.find((one) => one.id === type.id);
      expect(whole?.fields.map((field) => field.name)).toEqual([
        ...new Set([...(v3?.fields ?? []), ...type.fields].map((field) => field.name)),
      ]);
      for (const field of whole?.fields ?? [])
        if (field.name !== "polarity") expect(field.required, `${type.id}.${field.name}`).toBe(false);
      expect(personalType(type.id)?.grounding).toEqual({
        what: "statement",
        [KEY_FIELDS[type.id as keyof typeof KEY_FIELDS].phrase]: "phrase",
      });
      expect(ontologyFor("correspondence").get(type.id)).toEqual(v3);
      expect(ontologyFor("correspondence", "3").get(type.id)).toEqual(v3);
      expect(ontologyFor("correspondence", "4").get(type.id)).toEqual(type);
    }
    expect(PERSONAL_ONTOLOGY.get("preference")?.fields.find((field) => field.name === "polarity")).toMatchObject({
      required: true,
      values: ["likes", "dislikes", "prefers", "avoids"],
    });
    expect(ontologyFor("correspondence", "4").get("commitment")).toEqual(
      ontologyFor("correspondence").get("commitment"),
    );
    expect(agentOntology("3")).toBe(ontologyFor("correspondence", "4"));
    expect(agentOntology("2")).toBe(ontologyFor("correspondence"));
  });

  it("ontologyFor document shows commitment and plan only, and no type's lane is document", () => {
    expect([...DOCUMENT_TYPES]).toEqual(["commitment", "plan"]);
    const document = ontologyFor("document");
    expect(document.get("commitment")?.id).toBe("commitment");
    expect(document.get("plan")?.id).toBe("plan");
    expect(document.get("transaction.receipt")).toBeNull();
    expect(document.get("transaction")).toBeNull();
    expect(document.ownerOf("commitment")).toBe("personal");
    expect(document.ownerOf("transaction.receipt")).toBeNull();
    for (const type of PERSONAL_TYPES) expect(["correspondence", "transaction"]).toContain(type.lane);
  });

  it("the meeting lane's types by prompt version: version 1 extraction's two, version 2 eleven, the owner-side kinds as version 4 writes them", () => {
    expect([...MEETING_TYPES_V1]).toEqual(["commitment", "plan"]);
    expect([...MEETING_TYPES]).toEqual([
      "commitment",
      "plan",
      "role",
      "affiliation",
      "relationship",
      "need",
      "capability",
      "goal",
      "preference",
      "constraint",
      "situation",
    ]);
    const v1 = ontologyFor("meeting", "1");
    const v2 = ontologyFor("meeting", "2");
    expect(v1.get("goal")).toBeNull();
    expect(v1.get("commitment")?.id).toBe("commitment");
    for (const id of MEETING_TYPES)
      expect(v2.get(id), id).toEqual(CORRESPONDENCE_V4_TYPES.find((type) => type.id === id));
    expect(v2.get("goal")?.fields.map((field) => field.name)).toEqual(["objective", "domain", "by"]);
    // Not offered: the project kinds, consent, contact rules and receipts.
    for (const id of [
      "consent",
      "contact_rule",
      "project.status",
      "project.decision",
      "transaction.receipt",
      "capture.person",
    ])
      expect(v2.get(id), id).toBeNull();
    expect(v2.ownerOf("situation")).toBe("personal");
    // A run asks the latest version; with none given, the lane's view is the latest.
    expect(ontologyFor("meeting")).toBe(v2);
  });
});
