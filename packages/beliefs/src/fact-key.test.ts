import { LocalEntityId } from "@intelligence/contracts";
import {
  factKey,
  KEY_V2_GENERATION,
  keyVersionOf,
  legacyFactKey,
  legacyFactKeys,
  matchKey,
  noticeFactKey,
  noticeSource,
  noticeSubject,
  PERSONAL_ONTOLOGY,
  personalFactKey,
  releasedFactKey,
} from "@intelligence/personal-beliefs";
import { sha256 } from "@intelligence/personal-core";
import {
  CONTACT_CLAIMS_V1,
  CONTACT_CLAIMS_V2,
  CONTACT_CLAIMS_V3,
  contactClaims,
  importClaims,
  linkClaims,
} from "@intelligence/personal-core/items";
import { describe, expect, it } from "vitest";

const subject = LocalEntityId.parse("ent_00000000000000000000000001");
const counterparty = LocalEntityId.parse("ent_00000000000000000000000002");
const alder = LocalEntityId.parse("ent_00000000000000000000000003");
const commitment = {
  type: "commitment",
  subject,
  fields: { counterparty, what: "I will send it.", due: "2026-03-01" },
};
const role = (fields: Record<string, unknown>) => ({
  type: "role",
  subject,
  fields: { title: "Head of Finance", ...fields },
});

describe("the fact key", () => {
  it("two commitments in two threads are two facts", () => {
    expect(personalFactKey(commitment, "thread-a", ["own"])).not.toBe(personalFactKey(commitment, "thread-b", ["own"]));
  });

  it("two in one thread with the same parties and date are one, in any compartment", () => {
    const other = { ...commitment, fields: { ...commitment.fields, what: "Yes, I will." } };
    expect(personalFactKey(other, "thread-a", ["own"])).toBe(personalFactKey(commitment, "thread-a", ["own"]));
    // A thread is in one mailbox, so a thread-scoped type takes no compartment part.
    expect(personalFactKey(commitment, "thread-a", ["employer:example"])).toBe(
      personalFactKey(commitment, "thread-a", ["own"]),
    );
  });

  it("a global type is keyed by its content and the item's compartment", () => {
    const receipt = {
      type: "transaction.receipt",
      subject,
      fields: { merchant: "Alder", amount: 3, currency: "USD", date: "2026-03-01" },
    };
    expect(personalFactKey(receipt, "thread-a", ["own"])).toBe(
      sha256(`${factKey(receipt, { ontology: PERSONAL_ONTOLOGY })}\ncompartment:own`),
    );
    expect(personalFactKey(receipt, "thread-b", ["own"])).toBe(personalFactKey(receipt, "thread-a", ["own"]));
  });

  it("a global fact of an item under several compartments is keyed by its whole label, sorted and joined by commas", () => {
    const at = role({ organization: alder });
    const base = factKey(at, { ontology: PERSONAL_ONTOLOGY });
    expect(personalFactKey(at, "t", ["own", "employer:example"])).toBe(
      sha256(`${base}\ncompartment:employer:example,own`),
    );
    expect(personalFactKey(at, "t", ["employer:example", "own"])).toBe(
      personalFactKey(at, "t", ["own", "employer:example"]),
    );
    expect(personalFactKey(at, "t", ["employer:example", "own"])).not.toBe(personalFactKey(at, "t", ["own"]));
  });

  it("knowledge-model, fourth part: a finding's global fact is keyed by agent: and its evidence id in place of its label, and its thread-scoped one by its evidence id as thread", () => {
    const at = role({ organization: alder });
    const base = factKey(at, { ontology: PERSONAL_ONTOLOGY });
    expect(personalFactKey(at, "ev-1", ["agent:alpha", "own"], "ev-1")).toBe(sha256(`${base}\nagent:ev-1`));
    expect(personalFactKey(at, "ev-1", ["own"], "ev-1")).toBe(
      personalFactKey(at, "ev-1", ["agent:alpha", "own"], "ev-1"),
    );
    expect(personalFactKey(at, "ev-2", ["agent:alpha", "own"], "ev-2")).not.toBe(
      personalFactKey(at, "ev-1", ["agent:alpha", "own"], "ev-1"),
    );
    for (const label of [["own"], ["agent:alpha", "own"]])
      expect(personalFactKey(at, "ev-1", ["agent:alpha", "own"], "ev-1")).not.toBe(personalFactKey(at, "ev-1", label));
    // A thread-scoped type is unchanged: its thread is the record's evidence id.
    expect(personalFactKey(commitment, "ev-1", ["agent:alpha", "own"], "ev-1")).toBe(
      personalFactKey(commitment, "ev-1", ["own"]),
    );
  });

  it("a person's role stated in own and in employer mail is two facts", () => {
    const at = role({ organization: alder });
    expect(personalFactKey(at, "thread-a", ["own"])).not.toBe(personalFactKey(at, "thread-a", ["employer:example"]));
  });

  it("two titles at two named organizations are two facts; a new title at one is one fact", () => {
    const cedar = personalFactKey(role({ organization_name: "Cedar Works" }), "t", ["own"]);
    expect(personalFactKey(role({ organization_name: "Birch Labs" }), "t", ["own"])).not.toBe(cedar);
    expect(
      personalFactKey(
        {
          ...role({ organization_name: "Cedar Works" }),
          fields: { title: "Chief of Staff", organization_name: "Cedar Works" },
        },
        "t",
        ["own"],
      ),
    ).toBe(cedar);
    // With an organization entity, its name plays no part.
    expect(personalFactKey(role({ organization: alder, organization_name: "Alder" }), "t", ["own"])).toBe(
      personalFactKey(role({ organization: alder }), "t", ["own"]),
    );
    // An affiliation is keyed by its relation as well.
    const affiliation = (relation: string) => ({
      type: "affiliation",
      subject,
      fields: { relation, organization_name: "Cedar Works" },
    });
    expect(personalFactKey(affiliation("advisor"), "t", ["own"])).not.toBe(
      personalFactKey(affiliation("investor"), "t", ["own"]),
    );
  });

  it("the name part of the key is the slice in normal form", () => {
    const base = factKey(role({ organization_name: "Cedar  Works" }), { ontology: PERSONAL_ONTOLOGY });
    const named = sha256(`${base}\nname:cedar works`);
    expect(personalFactKey(role({ organization_name: "Cedar  Works" }), "t", ["own"])).toBe(
      sha256(`${named}\ncompartment:own`),
    );
    expect(personalFactKey(role({ organization_name: "CEDAR WORKS" }), "t", ["own"])).toBe(
      personalFactKey(role({ organization_name: "Cedar  Works" }), "t", ["own"]),
    );
  });

  it("knowledge-model, third part: a type's value fields are left out of its key", () => {
    const status = (value: string) => ({ type: "project.status", subject, fields: { status: value } });
    expect(personalFactKey(status("active"), "t", ["own"])).toBe(personalFactKey(status("done"), "t", ["own"]));
    const situation = (until?: string) => ({
      type: "situation",
      subject,
      fields: { what: "I am on leave.", ...(until === undefined ? {} : { until }) },
    });
    expect(personalFactKey(situation("2026-11-01"), "t", ["own"])).toBe(
      personalFactKey(situation("2026-12-01"), "t", ["own"]),
    );
    expect(personalFactKey(situation("2026-11-01"), "t", ["own"])).toBe(personalFactKey(situation(), "t", ["own"]));
    const need = (by: string) => ({ type: "need", subject, fields: { what: "I need a designer.", by } });
    expect(personalFactKey(need("2026-04-01"), "t", ["own"])).toBe(personalFactKey(need("2026-05-01"), "t", ["own"]));
    // A commitment keeps due in its key.
    expect(
      personalFactKey({ ...commitment, fields: { ...commitment.fields, due: "2026-04-01" } }, "t", ["own"]),
    ).not.toBe(personalFactKey(commitment, "t", ["own"]));
  });
});

// The role and affiliation claims code makes from a contact carry the key
// this package's personalFactKey gives the same content, so a contact's role and one read from
// mail about the same person, organization and mailbox are one fact.
describe("contactClaims keys", () => {
  it("every contact claim's fact key is personalFactKey of its content, its organization written any way", () => {
    for (const name of ["Example Works", "  Example  Works ", "O’Neil – Partners", "Ｅxample​Works", null]) {
      for (const compartments of [["own"], ["employer:example"]]) {
        const input = {
          evidenceId: "evd_1",
          compartments,
          readers: ["m-owner"],
          observedAt: "2026-09-01T09:00:00.000Z",
          people: [{ entity: subject }],
          organizations: [{ name, title: "Head of  Finance" }],
          addresses: ["maren@harbor.example"],
        };
        const records = contactClaims(input, CONTACT_CLAIMS_V1);
        expect(records.length).toBe(name === null ? 1 : 2);
        for (const record of records)
          expect(record.factKey, `${String(name)} ${record.claim.content.type}`).toBe(
            personalFactKey(record.claim.content, "evd_1", compartments),
          );
        // contact-claims@2 keys at version 2, its version 1 key beside it; contact-claims@3 the
        // same.
        for (const record of [...contactClaims(input, CONTACT_CLAIMS_V2), ...contactClaims(input, CONTACT_CLAIMS_V3)]) {
          expect(record.factKey, `${String(name)} ${record.claim.content.type} v2`).toBe(
            personalFactKey(record.claim.content, "evd_1", compartments, undefined, 2),
          );
          expect(record.legacyFactKey).toBe(personalFactKey(record.claim.content, "evd_1", compartments));
        }
      }
    }
  });
});

// Contact import: the claims code makes from an imported contact carry the key
// personalFactKey gives the same content too, at both versions, so an imported role and one read
// from mail about the same person, organization and mailbox are one fact.
describe("importClaims keys", () => {
  it("every imported claim's fact key is personalFactKey of its content", () => {
    const imported = {
      kind: "person" as const,
      profiles: [],
      pastRoles: [{ title: "Analyst", organization: "Fern  Bank Example", to: "2019-06-30" }],
      industries: [],
      education: ["North College Example"],
      boards: [{ organization: "O’Neil – Arts" }],
      relations: [{ kind: "works_at" as const, name: "Bright Group Example" }],
      tags: [],
      notes: [],
      provenance: { adapter: "mapped-csv" as const },
    };
    for (const compartments of [["own"], ["employer:example"]]) {
      const input = {
        evidenceId: "evd_1",
        compartments,
        readers: ["m-owner"],
        observedAt: "2026-09-01T09:00:00.000Z",
        people: [{ entity: subject }],
        organizations: [{ name: "Example Works", title: "Head of  Finance" }],
        imported,
        addresses: ["maren@harbor.example"],
      };
      const records = importClaims(input);
      expect(records.length).toBe(7);
      for (const record of records)
        expect(record.factKey, record.claim.content.type).toBe(
          personalFactKey(record.claim.content, "evd_1", compartments),
        );
      for (const record of [...importClaims(input, CONTACT_CLAIMS_V2), ...importClaims(input, CONTACT_CLAIMS_V3)]) {
        expect(record.factKey).toBe(personalFactKey(record.claim.content, "evd_1", compartments, undefined, 2));
        expect(record.legacyFactKey).toBe(personalFactKey(record.claim.content, "evd_1", compartments));
      }
    }
  });
});

// A link claim carries the key personalFactKey gives it, at both versions: its URL
// alone, so one URL on one person is one fact whatever its kind or label.
describe("linkClaims keys", () => {
  it("every link claim's fact key is personalFactKey of its content, at both versions", () => {
    const links = [
      { url: "https://linkedin.com/in/maren-holt-example", kind: "linkedin" as const },
      { url: "https://maren-holt.example", kind: "personal_site" as const, label: "Site" },
    ];
    for (const compartments of [["own"], ["employer:example"]]) {
      const records = linkClaims(
        {
          evidenceId: "evd_1",
          compartments,
          readers: ["m-owner"],
          observedAt: "2026-09-01T09:00:00.000Z",
          links,
          people: [{ entity: subject }],
        },
        "contact-claims@1",
      );
      expect(records).toHaveLength(2);
      for (const record of records) {
        expect(record.factKey).toBe(personalFactKey(record.claim.content, "evd_1", compartments));
        expect(record.factKey).toBe(personalFactKey(record.claim.content, "evd_1", compartments, undefined, 2));
      }
    }
    const [one] = linkClaims(
      {
        evidenceId: "evd_1",
        compartments: ["own"],
        readers: [],
        observedAt: "2026-09-01T09:00:00.000Z",
        links: [links[1]!],
        people: [{ entity: subject }],
      },
      "v",
    );
    expect(
      personalFactKey({ ...one!.claim.content, fields: { url: "https://maren-holt.example", kind: "other" } }, "t", [
        "own",
      ]),
    ).toBe(one!.factKey);
  });
});

// Fact key version 2.
describe("fact key version 2", () => {
  // Every stored shape's version 1 key, computed by the version 1 code (349cbff1), in a message
  // ("thread-a", own) and in a finding ("ev-1", agent:alpha and own). Version 2 changes none of
  // them.
  const SHAPES: [string, Record<string, unknown>, string, string][] = [
    [
      "commitment",
      { counterparty, what: "I will send it.", due: "2026-03-01" },
      "5c4eafea85412aa133f66e6fe0cfefd9ddee5d2f6a8c37a59816df03453b5850",
      "b35b1d93dab3151492980f437ad6abb02f181eb4d48ac51caf838360cb51deb3",
    ],
    [
      "plan",
      { counterparty, what: "Lunch on Friday.", when: "2026-03-06" },
      "ccb6752969728fa595cbf1d0a4e3a375fc8b1955a8d0a996e8608d26072fc163",
      "51a527aa9f314be6fc4f1a49e7285444cf1b7c5845f8e04cd44cbdbfadc5f301",
    ],
    [
      "transaction.receipt",
      { merchant: "Alder Books", amount: 24.5, currency: "USD", date: "2026-03-02", order_ref: "AB-1" },
      "0210b779ee9f1a4d6770b5f52b6b42bb4c8268c036b37dfab9d4310624b248f1",
      "8017b7e8ec1054c98ef11a17147f015df8e0c1a92f427fcbcb7126df7e879d59",
    ],
    [
      "role",
      { title: "Head of Finance", organization: alder },
      "1e0276a3a77a52739460ec0a4fd0814c1aa555e1692c57104ed9b98f2708266d",
      "f5ed1dd9782524b6231e316e86f7278ce6a3e1e8b5d3c7f27b9ba7ae8ba84253",
    ],
    [
      "role",
      { title: "Head of Finance", organization_name: "Cedar Works" },
      "8ee1f112b5f568919f6fc4251de4a7474bd20299536e28b80c4622ee13b6ab86",
      "63d252afefb082945a7b64907188b784bb12d123cb4e5cca43ad92ae9df91cfc",
    ],
    [
      "affiliation",
      { relation: "advisor", organization_name: "Cedar Works" },
      "4e4b01529ed975edda3c06433c20e8b7252919596ffc9fccbc6595895dfd6633",
      "4d887e0f9bc4c9673b3cbe82beea37e15d040c9cbaf2904c7ade10cee2e36499",
    ],
    [
      "relationship",
      { counterparty, relation: "sibling" },
      "9512dec43b5da510fa57e98718565ea0bbbdc0e217cce26404984bb77da09bda",
      "04a6770b8e28b22d20bd70d073342d71b20b5a59eee46b5d676f9d0e8eb86635",
    ],
    [
      "need",
      { what: "I need a designer.", by: "2026-04-01" },
      "3450b6e3db7053d47e428ea132e9854b015021653813faa94189a6efc12571e8",
      "f063635f9f4034671d0538c398c520ceeff86b5d4231aaa8f2d455e2d56e4d03",
    ],
    [
      "capability",
      { what: "I can review contracts." },
      "c69a9121825e4610c82da7737605c0eb80e1f1fb4aee917dc2723110a4e485b1",
      "95e1e57266b8023c83b46174bd0e578b70783dfd72ca903017a612c9fd0a3680",
    ],
    [
      "goal",
      { what: "I want to run a marathon.", by: "2027-01-01" },
      "4f828cb2eca834803de49f6a132abbd6ae37c139aa3400a522b0941da0e78421",
      "c72e2c473bb7a1bc793d2ebfb436a503a0f0198c6274685c9aa36cfc8820c9e1",
    ],
    [
      "preference",
      { what: "No em dashes.", polarity: "avoids" },
      "70018bf0464b1c83a5829ba1e1a4d63defc53d4ffc110493030484fcfaa061b5",
      "af40b5ba52d14a83d45adac250e6e6050967f7d61056ad38ce665ad136d2c535",
    ],
    [
      "constraint",
      { what: "I cannot travel in June.", until: "2026-07-01" },
      "cb093ce1b621241503597aff7075c3080291b6b116e21009ec4a72d5c4a71c5a",
      "66dd111f69ade4828293d3ccee154bbee0a586a32be94d270e0d6aa539c7eb2f",
    ],
    [
      "situation",
      { what: "I am on leave.", until: "2026-11-01" },
      "037d19ec8d706979de82dc77b2c7d074f41338c174d2ed5be72c4481638dd4dc",
      "d53c50b9b0641b4eb7dd9043f152bf1ce8ababaed5731b5cdb4013d0e4eaae4e",
    ],
    [
      "consent",
      { about: "introduce", what: "Happy to be introduced." },
      "054963558a2955ca68097c7846b264c6ecb730c1bd08a748b0f2f7c93c208015",
      "8229d6ccde9dfdcb00d87258b14d3e79f0f1ba1d731ee5ab92bedc3d0c0057fb",
    ],
    [
      "contact_rule",
      { rule: "prefers_channel", channel: "email", what: "Email me." },
      "9c2cf7020523bf07cfb09d91412fed57e9aa306d613c4cbdc87b1cffc1e55a84",
      "8cbd1ef515c7699b18fda9f8773ddb6a8953c3d9862251fad6d8267b3687a1a3",
    ],
    [
      "project.status",
      { status: "active" },
      "04edb57a7d7ad04abd12e604c241442466b8d3f057f59c12a42704678dce0633",
      "89e84792cdef3973efd179f9c5bf7010eb327cbb0e971204458bb68702635524",
    ],
    [
      "project.decision",
      { what: "We chose Alder." },
      "9c2be87659e029fba7d6e72a233eef6bef81f63d6f5439db5f77a247054202e4",
      "75660a6be79104f790878fbd4553325d709e25ccca728fd21ae6032a8ac06c93",
    ],
    [
      "capture.project",
      {},
      "c332da46b8a6a9f49ca6aa574dc896ea825bc1efa47827a194a1a6cfa2695d1e",
      "c332da46b8a6a9f49ca6aa574dc896ea825bc1efa47827a194a1a6cfa2695d1e",
    ],
  ];
  const content = (type: string, fields: Record<string, unknown>) => ({ type, subject, fields });

  it("version 1 is unchanged for every stored shape, pinned against main's values, and so is version 2 for each but a role's", () => {
    for (const [type, fields, message, finding] of SHAPES) {
      const one = content(type, fields);
      expect(personalFactKey(one, "thread-a", ["own"]), type).toBe(message);
      expect(personalFactKey(one, "ev-1", ["agent:alpha", "own"], "ev-1"), type).toBe(finding);
      expect(personalFactKey(one, "thread-a", ["own"], undefined, 1), type).toBe(message);
      // A legacy shape, `what` and no key phrase, keeps its version 1 key at version 2: no two
      // legacy goals of a subject join for want of a phrase. A role takes its title.
      if (type === "role") expect(personalFactKey(one, "thread-a", ["own"], undefined, 2), type).not.toBe(message);
      else expect(personalFactKey(one, "thread-a", ["own"], undefined, 2), type).toBe(message);
    }
  });

  it("keyVersionOf gives 2 from generation 5, the go's, and 1 before", () => {
    expect(KEY_V2_GENERATION).toBe(5);
    expect([0, 3, 4, 5, 6].map(keyVersionOf)).toEqual([1, 1, 1, 2, 2]);
  });

  const goal = (objective: string, domain = "ventures", by?: string) =>
    content("goal", { objective, domain, ...(by === undefined ? {} : { by }) });

  it("one goal stated in two threads is one fact, and two compartments keep it two", () => {
    // A standalone article is dropped wherever it stands, but last.
    expect(personalFactKey(goal("raise a seed round"), "thread-a", ["own"], undefined, 2)).toBe(
      personalFactKey(goal("Raise the seed-round!", "ventures", "2026-06-30"), "thread-b", ["own"], undefined, 2),
    );
    expect(personalFactKey(goal("raise a seed round"), "thread-a", ["own"], undefined, 2)).not.toBe(
      personalFactKey(goal("raise a seed round"), "thread-a", ["employer:example"], undefined, 2),
    );
    // At version 1 it is thread-scoped, as today.
    expect(personalFactKey(goal("raise a seed round"), "thread-a", ["own"])).not.toBe(
      personalFactKey(goal("raise a seed round"), "thread-b", ["own"]),
    );
    // A finding keeps its own part, so a finding's fact is never a message's.
    expect(personalFactKey(goal("raise a seed round"), "ev-1", ["agent:alpha", "own"], "ev-1", 2)).not.toBe(
      personalFactKey(goal("raise a seed round"), "thread-a", ["agent:alpha", "own"], undefined, 2),
    );
  });

  it("the domain and the key phrase are in the key; a value field is not", () => {
    const key = (one: ReturnType<typeof content>) => personalFactKey(one, "t", ["own"], undefined, 2);
    expect(key(goal("raise a seed round", "career"))).not.toBe(key(goal("raise a seed round")));
    expect(key(goal("hire two engineers"))).not.toBe(key(goal("raise a seed round")));
    const state = (fields: Record<string, unknown>) =>
      content("situation", { state: "on leave", domain: "career", ...fields });
    expect(key(state({ until: "2026-11-01", momentary: true }))).toBe(key(state({})));
    expect(key(state({}))).toBe(
      sha256(`${sha256(`${factKey(state({}), { ontology: PERSONAL_ONTOLOGY })}\nstate:on leave`)}\ncompartment:own`),
    );
  });

  it("knowledge-model: `no em dashes`, `never em dashes` and `avoid em dashes` give one key, the object em dashes avoided", () => {
    const preference = (object: string, polarity: string) =>
      personalFactKey(content("preference", { object, domain: "career", polarity }), "t", ["own"], undefined, 2);
    const avoided = preference("em dashes", "avoids");
    for (const [object, polarity] of [
      ["no em dashes", "prefers"],
      ["Never em-dashes", "prefers"],
      ["avoid em dashes", "likes"],
      ["em dashes", "dislikes"],
    ] as const)
      expect(preference(object, polarity), object).toBe(avoided);
    expect(preference("em dashes", "prefers")).not.toBe(avoided);
    expect(preference("em dashes", "likes")).toBe(preference("em dashes", "prefers"));
    // Only `prefers` flips: a negation with `avoids` is a double negative, kept apart.
    expect(preference("never em dashes", "avoids")).not.toBe(avoided);
    expect(preference("never em dashes", "avoids")).not.toBe(preference("em dashes", "prefers"));
  });

  it("a negation inside a hyphenated compound is part of the object, not a polarity", () => {
    const preference = (object: string, polarity: string) =>
      personalFactKey(content("preference", { object, domain: "money", polarity }), "t", ["own"], undefined, 2);
    expect(preference("no-name brands", "avoids")).not.toBe(preference("name brands", "avoids"));
    expect(preference("no-code tools", "prefers")).not.toBe(preference("code tools", "avoids"));
    expect(preference("no-code tools", "prefers")).toBe(preference("No-Code tools", "prefers"));
  });

  it("legacyFactKeys finds a stored version 1 preference under either of its polarity's words", () => {
    const v4 = (polarity: string) => content("preference", { object: "em dashes", domain: "career", polarity });
    const v1 = (polarity: string) =>
      personalFactKey(content("preference", { what: "No em dashes.", polarity }), "thread-a", ["own"]);
    // The stored key of { what: "No em dashes.", polarity: "avoids" }, pinned above.
    const stored = "70018bf0464b1c83a5829ba1e1a4d63defc53d4ffc110493030484fcfaa061b5";
    expect(legacyFactKeys(v4("avoids"), "thread-a", ["own"])).toEqual([stored, v1("dislikes")]);
    expect(legacyFactKeys(v4("prefers"), "thread-a", ["own"])).toEqual([v1("prefers"), v1("likes")]);
    expect(legacyFactKey(v4("avoids"), "thread-a", ["own"])).toBe(stored);
    // Every other claim has one.
    expect(legacyFactKeys(goal("raise a seed round"), "thread-a", ["own"])).toEqual([
      legacyFactKey(goal("raise a seed round"), "thread-a", ["own"]),
    ]);
    expect(
      legacyFactKeys(content("preference", { what: "No em dashes.", polarity: "avoids" }), "thread-a", ["own"]),
    ).toEqual([stored]);
  });

  it("an article that is a key phrase's last word, or joined to a slash, stays in its key", () => {
    expect(personalFactKey(goal("Plan A"), "t", ["own"], undefined, 2)).not.toBe(
      personalFactKey(goal("Plan"), "t", ["own"], undefined, 2),
    );
    expect(personalFactKey(goal("vitamin A"), "t", ["own"], undefined, 2)).not.toBe(
      personalFactKey(goal("vitamin"), "t", ["own"], undefined, 2),
    );
    expect(personalFactKey(goal("A/B testing"), "t", ["own"], undefined, 2)).not.toBe(
      personalFactKey(goal("B testing"), "t", ["own"], undefined, 2),
    );
  });

  it("a role takes its title's key phrase at version 2, after its name part", () => {
    const at = (title: string) =>
      personalFactKey(role({ title, organization_name: "Cedar Works" }), "t", ["own"], undefined, 2);
    expect(at("Head of Finance")).toBe(at("head of  finance"));
    expect(at("Chief of Staff")).not.toBe(at("Head of Finance"));
    const base = factKey(role({ organization_name: "Cedar Works" }), { ontology: PERSONAL_ONTOLOGY });
    expect(at("Head of Finance")).toBe(
      sha256(`${sha256(`${sha256(`${base}\nname:cedar works`)}\ntitle:head of finance`)}\ncompartment:own`),
    );
  });

  it("at version 2 a mail role naming its organization's entity and name, and a released proposal by name, are one key", () => {
    const mail = personalFactKey(
      role({ organization: alder, organization_name: "Cedar Works" }),
      "thread",
      ["own"],
      undefined,
      2,
    );
    const proposed = { ...role({ organization_name: "cedar  works" }), subject };
    expect(releasedFactKey(proposed, "evd_record", ["own"], 2)).toBe(mail);
    // The record's own claim keeps its finding part; version 1 keeps the entity.
    expect(personalFactKey(proposed, "evd_record", ["agent:alpha", "own"], "evd_record", 2)).not.toBe(mail);
    expect(personalFactKey(role({ organization: alder, organization_name: "Cedar Works" }), "t", ["own"])).toBe(
      personalFactKey(role({ organization: alder }), "t", ["own"]),
    );
    // An affiliation too; and with no name the entity keys it.
    const affiliation = (fields: Record<string, unknown>) => ({
      type: "affiliation",
      subject,
      fields: { relation: "employee", ...fields },
    });
    expect(releasedFactKey(affiliation({ organization_name: "Cedar Works" }), "evd_record", ["own"], 2)).toBe(
      personalFactKey(
        affiliation({ organization: alder, organization_name: "Cedar Works" }),
        "t",
        ["own"],
        undefined,
        2,
      ),
    );
    expect(personalFactKey(role({ organization: alder }), "t", ["own"], undefined, 2)).not.toBe(
      personalFactKey(role({ organization: counterparty }), "t", ["own"], undefined, 2),
    );
  });

  it("legacyFactKey is version 1 with the version 4 fields left out: a version 4 goal's is the version 3 goal's in its thread", () => {
    const v3 = content("goal", { what: "We hope to raise a seed round.", by: "2026-06-30" });
    expect(legacyFactKey(goal("raise a seed round", "ventures", "2026-06-30"), "thread-a", ["own"])).toBe(
      personalFactKey(v3, "thread-a", ["own"]),
    );
    const situation = content("situation", { state: "at the dentist today", domain: "health", momentary: true });
    expect(legacyFactKey(situation, "t", ["own"])).toBe(
      personalFactKey(content("situation", { what: "At the dentist today." }), "t", ["own"]),
    );
    // A type version 2 does not change: its legacy key is its key.
    expect(legacyFactKey(commitment, "thread-a", ["own"])).toBe(personalFactKey(commitment, "thread-a", ["own"]));
  });
});

// A notice's situation, keyed by its sender and its normalized subject line, never by its domain.
describe("noticeFactKey", () => {
  const subject = LocalEntityId.parse("ent_00000000000000000000000001");
  const situation = (state: string, domain: string) => ({ type: "situation", subject, fields: { state, domain } });
  const office = noticeSource("DoNotReply@Passports.example") as string;
  const PASSPORT = "Passport Application Status";

  it("the source is the sender's normalized address, any case; a sender with no address has none", () => {
    expect(office).toBe(noticeSource("donotreply@passports.example"));
    expect(noticeSource(undefined)).toBeUndefined();
    expect(noticeSource("not an address")).toBeUndefined();
  });

  it("a subject line is read lowercased, with no date, time, month or reference number's label, its whitespace collapsed; an identifier with a digit stays", () => {
    expect(noticeSubject(PASSPORT)).toBe("passport application status");
    expect(noticeSubject("  Passport  application STATUS, 21 Oct 2026 10:30 AM ")).toBe("passport application status");
    expect(noticeSubject("Passport Application Status — October 21st, 2026-10-21 9am")).toBe(
      "passport application status",
    );
    expect(noticeSubject("Passport application status: ref A12-3456")).toBe("passport application status a12 3456");
    expect(noticeSubject("Statement no. 5 (#88213) reference 7 nr 9")).toBe("statement 5 88213 7 9");
    expect(noticeSubject(undefined)).toBe("");
    expect(noticeSubject("21 Oct 2026")).toBe("");
  });

  // A month's word only beside a day or a year, a numeric date only in a full date's shape.
  it("a month's word alone and a short numeric identifier stay; a full date in any shape is left out", () => {
    expect(noticeSubject("Claim 3-1 update")).toBe("claim 3 1 update");
    expect(noticeSubject("Claim 3-1 update")).not.toBe(noticeSubject("Claim 3-2 update"));
    expect(noticeSubject("Ticket 10/21 opened")).toBe("ticket 10 21 opened");
    expect(noticeSubject("You may now book")).toBe("you may now book");
    expect(noticeSubject("March madness: Jan's order")).toBe("march madness jan s order");
    for (const dated of [
      "Status 2026-10-18",
      "Status 10/18/2026",
      "Status 18.10.2026",
      "Status 18 Oct 2026",
      "Status October 18th, 2026",
      "Status Oct 2026",
      "Status May 3, 2026",
      "Status 3 May 2026",
      "Status May 2026",
    ])
      expect(noticeSubject(dated), dated).toBe("status");
  });

  // "may" is a month only beside a year, and a numeric date needs a 4-digit year.
  it("a modal may after a number and a version's dotted identifier stay, so two such notices are two keys", () => {
    expect(noticeSubject("Your claim 12 may be delayed")).toBe("your claim 12 may be delayed");
    expect(noticeSubject("Your claim 12 may be delayed")).not.toBe(noticeSubject("Your claim 13 may be delayed"));
    expect(noticeSubject("Status May 3")).toBe("status may 3");
    expect(noticeSubject("iOS 17.1.12 update ready")).toBe("ios 17 1 12 update ready");
    expect(noticeSubject("iOS 17.1.12 update ready")).not.toBe(noticeSubject("iOS 17.1.13 update ready"));
    expect(noticeSubject("Status 18.10.26")).toBe("status 18 10 26");
  });

  it("one sender and subject is one key whatever the state or the domain the model chose; another sender, subject or compartment is another; the owner's own situation's key is never one", () => {
    const key = noticeFactKey(
      situation("passport application is In Process", "travel"),
      ["own"],
      office,
      PASSPORT,
      "msg-1",
    );
    expect(
      noticeFactKey(
        situation("supporting documents were mailed", "travel"),
        ["own"],
        office,
        `${PASSPORT}, Oct 21 10:30`,
        "msg-2",
      ),
    ).toBe(key);
    expect(
      noticeFactKey(situation("supporting documents were mailed", "admin"), ["own"], office, PASSPORT, "msg-2"),
    ).toBe(key);
    expect(
      noticeFactKey(
        situation("passport application is In Process", "travel"),
        ["own"],
        noticeSource("noreply@parcels.example") as string,
        PASSPORT,
        "msg-1",
      ),
    ).not.toBe(key);
    expect(
      noticeFactKey(situation("passport application is In Process", "travel"), ["work"], office, PASSPORT, "msg-1"),
    ).not.toBe(key);
    for (const version of [1, 2] as const)
      expect(
        personalFactKey(situation("passport application is In Process", "travel"), "", ["own"], undefined, version),
      ).not.toBe(key);
  });

  it("one bank's card notice and its mortgage notice, of one domain, are two keys", () => {
    const bank = noticeSource("alerts@bank.example") as string;
    expect(
      noticeFactKey(
        situation("card ending 1234 shipped", "money"),
        ["own"],
        bank,
        "Your new card is on its way",
        "msg-1",
      ),
    ).not.toBe(
      noticeFactKey(
        situation("mortgage application in review", "money"),
        ["own"],
        bank,
        "Mortgage application update",
        "msg-2",
      ),
    );
  });

  // An identifier in the subject keeps one sender's notices of two orders, or two
  // applications, apart, so the newer never closes the other's status.
  it("one retailer's notices of two orders, and one office's of two references, are two keys", () => {
    const shop = noticeSource("orders@shop.example") as string;
    expect(
      noticeFactKey(situation("order shipped", "admin"), ["own"], shop, "Order A12 has shipped", "msg-1"),
    ).not.toBe(noticeFactKey(situation("order shipped", "admin"), ["own"], shop, "Order B34 has shipped", "msg-2"));
    expect(
      noticeFactKey(situation("in review", "admin"), ["own"], office, "Application ref 111: in review", "msg-1"),
    ).not.toBe(
      noticeFactKey(situation("in review", "admin"), ["own"], office, "Application ref 222: in review", "msg-2"),
    );
  });

  it("a subject that normalizes to nothing keys by its message, so two such notices of one sender never share a key", () => {
    const key = noticeFactKey(situation("documents mailed", "travel"), ["own"], office, "", "msg-1");
    expect(noticeFactKey(situation("documents mailed", "travel"), ["own"], office, "21 Oct 2026", "msg-2")).not.toBe(
      key,
    );
    expect(noticeFactKey(situation("documents mailed", "travel"), ["own"], office, "", "msg-2")).not.toBe(key);
    expect(noticeFactKey(situation("documents mailed", "travel"), ["own"], office, "21 Oct", "msg-1")).toBe(key);
  });
});

describe("matchKey", () => {
  const goal = { type: "goal", subject, fields: { domain: "health", objective: "Run a marathon" } };

  it("a proposal's match key equals its released claim's fact key at version 2", () => {
    expect(matchKey(goal, 2)).toBeDefined();
    expect(matchKey(goal, 2)).toBe(releasedFactKey(goal, "ev-1", ["own"], 2));
  });

  it("two findings' match keys are equal where their fact keys differ", () => {
    const other = { ...goal, fields: { ...goal.fields, objective: "run  a Marathon" } };
    expect(personalFactKey(goal, "ev-1", ["agent:alpha", "own"], "ev-1", 2)).not.toBe(
      personalFactKey(other, "ev-2", ["agent:beta", "own"], "ev-2", 2),
    );
    expect(matchKey(goal, 2)).toBe(matchKey(other, 2));
  });

  it("a thread-scoped claim has none", () => {
    expect(matchKey(commitment, 2)).toBeUndefined();
  });
});
