import {
  AgentRecordId,
  ContextPack,
  LEARNINGS_SHOWN,
  type PackItem,
  PackSection,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { sha256 } from "../hash.ts";
import { canonicalJson } from "../json.ts";
import { COURTESY_DAYS } from "./commitment-lapse.ts";
import {
  assemblePack,
  PACK_TEMPLATES,
  type PackTemplate,
  packHash,
  SELECTOR_IN_ORDER,
  type Selector,
  selectInOrder,
  templateFor,
} from "./packs.ts";

// Made-up values only. Every item is an address item: assemblePack never reads an item's
// value, so the kind does not matter to it.
const AS_OF = "2026-10-04T12:00:00.000Z";

const item = (section: PackSection, id: string, required = false, value = `value ${id}`): PackItem => ({
  kind: "address",
  id,
  section,
  required,
  provenance: "source",
  asOf: AS_OF,
  value: { untrusted: value },
});

const items = (section: PackSection, count: number, required = false): PackItem[] =>
  Array.from({ length: count }, (_, n) => item(section, `${section}:${n}`, required));

const template = (
  purpose: "agent_bootstrap" | "meeting_prep" | "person_brief" | "project_brief",
  version: number,
): PackTemplate => {
  const found = PACK_TEMPLATES.find((entry) => entry.purpose === purpose && entry.version === version);
  if (found === undefined) throw new Error("no such template");
  return found;
};

const BOOTSTRAP = template("agent_bootstrap", 1);
const PREP = template("meeting_prep", 1);
const BOOTSTRAP_2 = template("agent_bootstrap", 2);
const PREP_2 = template("meeting_prep", 2);
const BOOTSTRAP_3 = template("agent_bootstrap", 3);
const PREP_3 = template("meeting_prep", 3);
const BOOTSTRAP_4 = template("agent_bootstrap", 4);
const BOOTSTRAP_5 = template("agent_bootstrap", 5);
const BOOTSTRAP_6 = template("agent_bootstrap", 6);
const BOOTSTRAP_7 = template("agent_bootstrap", 7);
const BOOTSTRAP_8 = template("agent_bootstrap", 8);
const BOOTSTRAP_9 = template("agent_bootstrap", 9);
const BOOTSTRAP_10 = template("agent_bootstrap", 10);
const BOOTSTRAP_11 = template("agent_bootstrap", 11);
const BOOTSTRAP_12 = template("agent_bootstrap", 12);
const BOOTSTRAP_13 = template("agent_bootstrap", 13);
const BOOTSTRAP_14 = template("agent_bootstrap", 14);
const BOOTSTRAP_15 = template("agent_bootstrap", 15);
const BOOTSTRAP_16 = template("agent_bootstrap", 16);
const PREP_4 = template("meeting_prep", 4);
const BRIEF = template("person_brief", 1);
const PREP_5 = template("meeting_prep", 5);
const BRIEF_2 = template("person_brief", 2);
const PREP_6 = template("meeting_prep", 6);
const BRIEF_3 = template("person_brief", 3);
const PREP_7 = template("meeting_prep", 7);
const PREP_8 = template("meeting_prep", 8);
const BRIEF_4 = template("person_brief", 4);
const BRIEF_5 = template("person_brief", 5);

const ids = (pack: ContextPack, section?: PackSection): string[] =>
  pack.items.filter((entry) => section === undefined || entry.section === section).map((entry) => entry.id);
const bytes = (pack: ContextPack): string => JSON.stringify(pack);

// A full bootstrap input: every section over its cap.
const fullBootstrap = () => ({
  asOf: AS_OF,
  sections: {
    owner: items("owner", 3, true),
    handoff: items("handoff", 1, true),
    upcoming: items("upcoming", 4, true),
    contacts: items("contacts", 20),
    notes: items("notes", 12),
  },
});

describe("the templates", () => {
  // A change to a template without a new version fails here.
  it("K2: each template's hash is the pinned one: earlier versions' hashes are unchanged and the new one is pinned", () => {
    const pinned: Record<string, string> = {
      "agent_bootstrap@1": "4fc3b58ab0b9e74b445e4bd5a64d0091ecd33a87b144446f09c924c5bf971078",
      "meeting_prep@1": "5d7ea80597da9a9a825f6e846373dae72185c35c6845442e25ffe1b1c5b9e5aa",
      "agent_bootstrap@2": "f3ec532b97450d8c9d3faa1df1cf3ee80ef57466a84105c46569868774f08cc0",
      "meeting_prep@2": "17c218caf99c1c76ffd3b2a1558eb7fe099958445b3231a34f576d6d17b058f5",
      "agent_bootstrap@3": "2432a627981d5b10edc194bce8630b9edc3c9b437379331830fbee280b7f1606",
      "meeting_prep@3": "dae36a02526e68215339597abdd220d38c8a7c49bb23b7003598a920f257eac6",
      "agent_bootstrap@4": "45557ebeca52798ca7f6af0c0542fda76af6b7006648f8f4738fff3620c341ae",
      "meeting_prep@4": "bc3ead2436dfe2e970423cc8d236b8ee9dcea6d9ca9f44068a00dc13ec76d0db",
      "person_brief@1": "cf66d65ac2d8e4ba9504e847bf209973eca15d4305c5d18e2c54cb244b2b38ff",
      "agent_bootstrap@5": "8c9c917859dcc33c7883d44961db10f46fd6c22961a274db92d54999a63efa72",
      "agent_bootstrap@6": "7ac891908876523320f035618fb58eb1881ef0e89a3302319a944c0a51f82dc1",
      "meeting_prep@5": "a19df5116d175901f7172ad46edd5dda147be1fefdb08e59af725ae817dd7540",
      "person_brief@2": "f40bdab7f9127ebd10c6fe0592ec9286399a6133d5e478b5cc93fea25a456733",
      "agent_bootstrap@7": "f3a5071845748b3bfb3fda0e09307f73ddfa78f112e20f93a6213beb6811200f",
      "agent_bootstrap@8": "6e1da9160debf9a550aab2e0270d4947c80d8c2526b8bad837f245c554f231f0",
      "agent_bootstrap@9": "f58a384271e2a1b9c491d298d2793e48a21955ad344985bd18f518b37c9d5225",
      "meeting_prep@6": "a5ae82c162c1cdf1c6aac4bc9185b334544a045102afeb40d9efaee0fd619dac",
      "person_brief@3": "7e0329f132385a8edc1c8dcf25ce68f23f2140a459905b06a254c4a8a42dc0f9",
      "meeting_prep@7": "3427f3a2ff38833466a027f918c124093109ec2281a928d068965157c90d6abc",
      "meeting_prep@8": "d3bfe04120253a2283c879ccef97e4cb8a0db69c21c189f7fae89e48ef1f7194",
      "person_brief@4": "596847f1fb05abea665e2861819d113b80b764e04e67d871549ae8a5ef2be37d",
      "person_brief@5": "352444f881a9cd49533fbd28c5a3f6ec5d148ebcc4718bb2f63d16810257c303",
      "agent_bootstrap@10": "15792ccb3eda15999fd354afac2f0c23ecbff87e51df484ccba0df6e8aa2df1c",
      "agent_bootstrap@11": "4be75052465c82c3327ebd621cd582ccdafd93b84dc806c4e1240559ceb6518d",
      "agent_bootstrap@12": "6dc16b112299574037b15c57d04979304bb8037d9092b2097b13f71bd037d73a",
      "project_brief@1": "0503057ac5c821b2005b9b1ccc138c801a3688f63f73c2fd88b96959af92fe53",
      "agent_bootstrap@13": "6bb3badcebe6bc8f029aa0bd9aa169c7bfd4808b557e20f853a45d2f96d37997",
      "agent_bootstrap@14": "71ec691ed7feae31ae60385c8e753d9ff3e27afb8baeb661aa409e9035f3aed1",
      "agent_bootstrap@15": "c7ead2ae55087d36a2e59f3d0af5f27bf3d39af93d7ff7b612072d950607ca12",
      "agent_bootstrap@16": "13a5bd2cec00d52301769d2cefaab4c68b815eb58b2e1ba6b5dd911a43ba605e",
    };
    const actual = Object.fromEntries(
      PACK_TEMPLATES.map((entry) => [`${entry.purpose}@${entry.version}`, sha256(canonicalJson(entry))]),
    );
    expect(actual).toEqual(pinned);
  });

  it("the templates are as the expected table", () => {
    expect(BOOTSTRAP.sections).toEqual([
      { name: "owner", view: "self", required: true, cap: 10 },
      { name: "handoff", view: "self", required: true, cap: 1 },
      { name: "upcoming", view: "self", required: true, cap: 20 },
      { name: "contacts", view: "people", required: false, cap: 10 },
      { name: "notes", view: "self", required: false, cap: 10, cutChars: 2000 },
    ]);
    expect(PREP.sections).toEqual([
      { name: "event", view: "people", required: true, cap: 1 },
      { name: "attendees", view: "people", required: true, cap: 25 },
      { name: "recent_messages", view: "people", required: false, cap: 30 },
    ]);
  });

  it("version 2 adds the required commitments section of the work view, cap 20, after upcoming and after attendees", () => {
    const commitments = { name: "commitments", view: "work", required: true, cap: 20 };
    expect(BOOTSTRAP_2.sections).toEqual([
      ...BOOTSTRAP.sections.slice(0, 3),
      commitments,
      ...BOOTSTRAP.sections.slice(3),
    ]);
    expect(PREP_2.sections).toEqual([...PREP.sections.slice(0, 2), commitments, ...PREP.sections.slice(2)]);
  });

  it("version 3 is version 2 with the commitments section ordered source first, and nothing else", () => {
    const sourceFirst = (entry: PackTemplate) =>
      entry.sections.map((section) =>
        section.name === "commitments" ? { ...section, order: "source_first" } : section,
      );
    expect(BOOTSTRAP_3.sections).toEqual(sourceFirst(BOOTSTRAP_2));
    expect(PREP_3.sections).toEqual(sourceFirst(PREP_2));
  });

  it("agent_bootstrap@4 is version 3 with the optional facts section of the self view, cap 20, after commitments, and nothing else", () => {
    const facts = { name: "facts", view: "self", required: false, cap: 20 };
    const at = BOOTSTRAP_3.sections.findIndex((section) => section.name === "commitments") + 1;
    expect(BOOTSTRAP_4.sections).toEqual([
      ...BOOTSTRAP_3.sections.slice(0, at),
      facts,
      ...BOOTSTRAP_3.sections.slice(at),
    ]);
  });

  it("agent_bootstrap@5 is version 4 with the optional preferences section of the self view, cap 20, after facts, and nothing else", () => {
    const preferences = { name: "preferences", view: "self", required: false, cap: 20 };
    const at = BOOTSTRAP_4.sections.findIndex((section) => section.name === "facts") + 1;
    expect(BOOTSTRAP_5.sections).toEqual([
      ...BOOTSTRAP_4.sections.slice(0, at),
      preferences,
      ...BOOTSTRAP_4.sections.slice(at),
    ]);
    // No other purpose's template has the section.
    for (const entry of PACK_TEMPLATES)
      if (entry.purpose !== "agent_bootstrap" || entry.version < 5)
        expect(entry.sections.map((section) => section.name)).not.toContain("preferences");
  });

  // A courtesy commitment lapses after COURTESY_DAYS.
  it("agent_bootstrap@6 is version 5 with its commitments section's lapse set to courtesy, and nothing else", () => {
    expect(BOOTSTRAP_6.sections).toEqual(
      BOOTSTRAP_5.sections.map((section) =>
        section.name === "commitments" ? { ...section, lapse: "courtesy" } : section,
      ),
    );
    expect(COURTESY_DAYS).toBe(30);
    // No earlier template lapses anything.
    for (const entry of PACK_TEMPLATES)
      if (
        ![
          BOOTSTRAP_6,
          BOOTSTRAP_7,
          BOOTSTRAP_8,
          BOOTSTRAP_9,
          BOOTSTRAP_10,
          BOOTSTRAP_11,
          BOOTSTRAP_12,
          BOOTSTRAP_13,
          BOOTSTRAP_14,
          BOOTSTRAP_15,
          BOOTSTRAP_16,
          PREP_5,
          BRIEF_2,
          PREP_6,
          BRIEF_3,
          PREP_7,
          PREP_8,
          BRIEF_4,
          BRIEF_5,
        ].includes(entry)
      )
        for (const section of entry.sections)
          expect(section.lapse, `${entry.purpose}@${entry.version}`).toBeUndefined();
  });

  // The lapse wherever a pack serves commitments.
  it("meeting_prep@5 is version 4 and person_brief@2 is version 1, each with its commitments section's lapse set to courtesy, and nothing else", () => {
    const lapsing = (entry: PackTemplate) =>
      entry.sections.map((section) => (section.name === "commitments" ? { ...section, lapse: "courtesy" } : section));
    expect(PREP_5.sections).toEqual(lapsing(PREP_4));
    expect(BRIEF_2.sections).toEqual(lapsing(BRIEF));
  });

  it("meeting_prep@6 is version 5 and person_brief@3 is version 2, each with the required second_degree section of the people view after commitments, and nothing else", () => {
    const secondDegree = (cap: number) => ({ name: "second_degree", view: "people", required: true, cap });
    const after = (entry: PackTemplate, cap: number) => {
      const at = entry.sections.findIndex((section) => section.name === "commitments") + 1;
      return [...entry.sections.slice(0, at), secondDegree(cap), ...entry.sections.slice(at)];
    };
    // At most prepPerAttendee (5) for each of the 25 attendees shown, and for the one person.
    expect(PREP_6.sections).toEqual(after(PREP_5, 125));
    expect(BRIEF_3.sections).toEqual(after(BRIEF_2, 5));
    for (const entry of PACK_TEMPLATES)
      if (![PREP_6, BRIEF_3, PREP_7, PREP_8, BRIEF_4, BRIEF_5].includes(entry))
        expect(entry.sections.map((section) => section.name)).not.toContain("second_degree");
  });

  it("meeting_prep@7 and person_brief@4 are the versions before them", () => {
    expect(PREP_7.sections).toEqual(PREP_6.sections);
    expect(BRIEF_4.sections).toEqual(BRIEF_3.sections);
  });

  it("person_brief@5 is version 4, and is in force", () => {
    const brief = templateFor("person_brief");
    expect(brief.version).toBe(5);
    expect(brief.sections).toEqual(BRIEF_4.sections);
  });

  it("meeting_prep@8 is version 7 with the notes section after the attendees, and is in force", () => {
    const notes = { name: "notes", view: "self", required: false, cap: 5, cutChars: 2000, superseded: "left_out" };
    const at = PREP_7.sections.findIndex((section) => section.name === "attendees") + 1;
    expect(PREP_8.sections).toEqual([...PREP_7.sections.slice(0, at), notes, ...PREP_7.sections.slice(at)]);
    expect(templateFor("meeting_prep")).toBe(PREP_8);
  });

  it("meeting_prep@4 is version 3 with the optional facts section of the people view, cap 40, after commitments, and nothing else", () => {
    const facts = { name: "facts", view: "people", required: false, cap: 40 };
    const at = PREP_3.sections.findIndex((section) => section.name === "commitments") + 1;
    expect(PREP_4.sections).toEqual([...PREP_3.sections.slice(0, at), facts, ...PREP_3.sections.slice(at)]);
  });

  it("person_brief@1 holds the person, their beliefs, their open commitments with the owner, source first, and their latest messages", () => {
    expect(BRIEF.sections).toEqual([
      { name: "person", view: "people", required: true, cap: 1 },
      { name: "facts", view: "people", required: true, cap: 40 },
      { name: "commitments", view: "work", required: true, cap: 20, order: "source_first" },
      { name: "recent_messages", view: "people", required: false, cap: 10 },
    ]);
  });

  it("the templates are frozen at every depth", () => {
    expect(Object.isFrozen(PACK_TEMPLATES)).toBe(true);
    expect(() => {
      (PACK_TEMPLATES as PackTemplate[]).push(BOOTSTRAP);
    }).toThrow(TypeError);
    for (const entry of PACK_TEMPLATES) {
      expect(() => {
        (entry as { version: number }).version = 9;
      }).toThrow(TypeError);
      expect(() => {
        (entry.sections as unknown[]).pop();
      }).toThrow(TypeError);
      for (const section of entry.sections) {
        expect(() => {
          (section as { cap: number }).cap = 99;
        }).toThrow(TypeError);
      }
    }
    expect(BOOTSTRAP.sections[0]!.cap).toBe(10);
  });

  it("every section of a template is a PackSection, once", () => {
    for (const entry of PACK_TEMPLATES) {
      const names = entry.sections.map((section) => section.name);
      for (const name of names) expect(PackSection.safeParse(name).success, name).toBe(true);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("a required section never has a cut", () => {
    for (const entry of PACK_TEMPLATES)
      for (const section of entry.sections)
        if (section.required) expect(section.cutChars, section.name).toBeUndefined();
  });

  it("agent_bootstrap@7 is version 6 with the required guide section of the self view first, cap 1, and nothing else", () => {
    expect(BOOTSTRAP_7.sections).toEqual([
      { name: "guide", view: "self", required: true, cap: 1 },
      ...BOOTSTRAP_6.sections,
    ]);
    for (const entry of PACK_TEMPLATES)
      if (
        ![
          BOOTSTRAP_7,
          BOOTSTRAP_8,
          BOOTSTRAP_9,
          BOOTSTRAP_10,
          BOOTSTRAP_11,
          BOOTSTRAP_12,
          BOOTSTRAP_13,
          BOOTSTRAP_14,
          BOOTSTRAP_15,
          BOOTSTRAP_16,
        ].includes(entry)
      )
        expect(entry.sections.map((section) => section.name)).not.toContain("guide");
  });

  it("agent_bootstrap@8 is version 7 with the optional work section of the work view last, cap 1, and nothing else", () => {
    expect(BOOTSTRAP_8.sections).toEqual([
      ...BOOTSTRAP_7.sections,
      { name: "work", view: "work", required: false, cap: 1 },
    ]);
    for (const entry of PACK_TEMPLATES)
      if (
        ![
          BOOTSTRAP_8,
          BOOTSTRAP_9,
          BOOTSTRAP_10,
          BOOTSTRAP_11,
          BOOTSTRAP_12,
          BOOTSTRAP_13,
          BOOTSTRAP_14,
          BOOTSTRAP_15,
          BOOTSTRAP_16,
        ].includes(entry)
      )
        expect(entry.sections.map((section) => section.name)).not.toContain("work");
  });

  it("agent_bootstrap@9 is version 8 with its notes section leaving out a superseded record, and nothing else", () => {
    expect(BOOTSTRAP_9.sections).toEqual(
      BOOTSTRAP_8.sections.map((section) =>
        section.name === "notes" ? { ...section, superseded: "left_out" } : section,
      ),
    );
    for (const entry of PACK_TEMPLATES)
      if (
        ![
          BOOTSTRAP_9,
          BOOTSTRAP_10,
          BOOTSTRAP_11,
          BOOTSTRAP_12,
          BOOTSTRAP_13,
          BOOTSTRAP_14,
          BOOTSTRAP_15,
          BOOTSTRAP_16,
          PREP_8,
        ].includes(entry)
      )
        for (const section of entry.sections)
          expect(section.superseded, `${entry.purpose}@${entry.version}`).toBeUndefined();
  });

  it("agent_bootstrap@10 is version 9 with the optional unreported section of the work view after the guide, cap 20, and nothing else", () => {
    const [guide, ...rest] = BOOTSTRAP_9.sections;
    expect(BOOTSTRAP_10.sections).toEqual([
      guide,
      { name: "unreported", view: "work", required: false, cap: 20 },
      ...rest,
    ]);
    for (const entry of PACK_TEMPLATES)
      if (
        ![BOOTSTRAP_10, BOOTSTRAP_11, BOOTSTRAP_12, BOOTSTRAP_13, BOOTSTRAP_14, BOOTSTRAP_15, BOOTSTRAP_16].includes(
          entry,
        )
      )
        expect(entry.sections.map((section) => section.name)).not.toContain("unreported");
  });

  it("open-items: agent_bootstrap@11 is version 10 with the optional open items of the self view after the guide, cap 15", () => {
    const [guide, ...rest] = BOOTSTRAP_10.sections;
    expect(BOOTSTRAP_11.sections).toEqual([
      guide,
      { name: "open_items", view: "self", required: false, cap: 15 },
      ...rest,
    ]);
    for (const entry of PACK_TEMPLATES)
      if (![BOOTSTRAP_11, BOOTSTRAP_12, BOOTSTRAP_13, BOOTSTRAP_14, BOOTSTRAP_15, BOOTSTRAP_16].includes(entry))
        expect(entry.sections.map((section) => section.name)).not.toContain("open_items");
  });

  it("projects-and-long-work: agent_bootstrap@12 is version 11 with the optional held work of the work view before the unreported moves, cap 20, and a handoff cap of 10", () => {
    const at = BOOTSTRAP_11.sections.findIndex((section) => section.name === "unreported");
    expect(BOOTSTRAP_12.sections).toEqual([
      ...BOOTSTRAP_11.sections.slice(0, at),
      { name: "my_work", view: "work", required: false, cap: 20 },
      ...BOOTSTRAP_11.sections
        .slice(at)
        .map((section) => (section.name === "handoff" ? { ...section, cap: 10 } : section)),
    ]);
    for (const entry of PACK_TEMPLATES)
      if (
        entry !== BOOTSTRAP_12 &&
        entry !== BOOTSTRAP_13 &&
        entry !== BOOTSTRAP_14 &&
        entry !== BOOTSTRAP_15 &&
        entry !== BOOTSTRAP_16
      )
        expect(entry.sections.map((section) => section.name)).not.toContain("my_work");
  });

  it("agent_bootstrap@13 is version 12 with the caller's optional record of the self view right after the guide, cap 1, and nothing else", () => {
    const [guide, ...rest] = BOOTSTRAP_12.sections;
    expect(BOOTSTRAP_13.sections).toEqual([guide, { name: "record", view: "self", required: false, cap: 1 }, ...rest]);
    for (const entry of PACK_TEMPLATES)
      if (entry !== BOOTSTRAP_13 && entry !== BOOTSTRAP_14 && entry !== BOOTSTRAP_15 && entry !== BOOTSTRAP_16)
        expect(entry.sections.map((section) => section.name)).not.toContain("record");
  });

  it("agent_bootstrap@14 is version 13 with the optional known issues of the work view right after the record, cap 5, and nothing else", () => {
    const [guide, record, ...rest] = BOOTSTRAP_13.sections;
    expect(BOOTSTRAP_14.sections).toEqual([
      guide,
      record,
      { name: "known_issues", view: "work", required: false, cap: 5 },
      ...rest,
    ]);
    for (const entry of PACK_TEMPLATES)
      if (entry !== BOOTSTRAP_14 && entry !== BOOTSTRAP_15 && entry !== BOOTSTRAP_16)
        expect(entry.sections.map((section) => section.name)).not.toContain("known_issues");
  });

  it("agent_bootstrap@15 is version 14 with the optional learnings of the work view right after the known issues, cap 10, and nothing else", () => {
    const [guide, record, known, ...rest] = BOOTSTRAP_14.sections;
    expect(known?.name).toBe("known_issues");
    expect(BOOTSTRAP_15.sections).toEqual([
      guide,
      record,
      known,
      { name: "learnings", view: "work", required: false, cap: LEARNINGS_SHOWN },
      ...rest,
    ]);
    expect(LEARNINGS_SHOWN).toBe(10);
    for (const entry of PACK_TEMPLATES)
      if (entry !== BOOTSTRAP_15 && entry !== BOOTSTRAP_16)
        expect(entry.sections.map((section) => section.name)).not.toContain("learnings");
  });

  it("agent_bootstrap@16 is version 15 with the caller's optional standing of the self view first, cap 1, and nothing else", () => {
    expect(BOOTSTRAP_16.sections).toEqual([
      { name: "standing", view: "self", required: false, cap: 1 },
      ...BOOTSTRAP_15.sections,
    ]);
    for (const entry of PACK_TEMPLATES)
      if (entry !== BOOTSTRAP_16) expect(entry.sections.map((section) => section.name)).not.toContain("standing");
  });

  it("templateFor gives the highest version of a purpose", () => {
    for (const purpose of ["agent_bootstrap", "meeting_prep", "person_brief", "project_brief"] as const) {
      const highest = Math.max(
        ...PACK_TEMPLATES.filter((entry) => entry.purpose === purpose).map((entry) => entry.version),
      );
      expect(templateFor(purpose).purpose).toBe(purpose);
      expect(templateFor(purpose).version).toBe(highest);
    }
    expect(templateFor("agent_bootstrap")).toBe(BOOTSTRAP_16);
    expect(templateFor("meeting_prep")).toBe(PREP_8);
    expect(templateFor("person_brief")).toBe(BRIEF_5);
  });

  it("project_brief@1 is one required project item of the work view, and is in force", () => {
    expect(templateFor("project_brief")).toBe(template("project_brief", 1));
    expect(template("project_brief", 1).sections).toEqual([{ name: "project", view: "work", required: true, cap: 1 }]);
    for (const entry of PACK_TEMPLATES)
      if (entry.purpose !== "project_brief")
        expect(entry.sections.map((section) => section.name)).not.toContain("project");
  });

  it("the caps of agent_bootstrap@1 sum to 51 and those of meeting_prep@1 to 56, and version 2's to 71 and 76", () => {
    const sum = (entry: PackTemplate) => entry.sections.reduce((total, section) => total + section.cap, 0);
    expect(sum(BOOTSTRAP)).toBe(51);
    expect(sum(PREP)).toBe(56);
    expect(sum(BOOTSTRAP_2)).toBe(71);
    expect(sum(PREP_2)).toBe(76);
  });
});

describe("assembly, selection and the hash", () => {
  it("a preference item assembles under agent_bootstrap@5's preferences section, as the contract's shape", () => {
    const preference: PackItem = {
      kind: "preference",
      id: AgentRecordId.parse("rec_01J00000000000000000000000"),
      section: "preferences",
      required: false,
      provenance: "owner",
      asOf: AS_OF,
      what: { untrusted: "made-up preference" },
      polarity: "prefers",
      confirmedAt: AS_OF,
    };
    const pack = assemblePack(BOOTSTRAP_5, { asOf: AS_OF, sections: { preferences: [preference] } });
    expect(ContextPack.parse(pack)).toEqual(pack);
    expect(pack.items).toEqual([preference]);
    expect(() => assemblePack(BOOTSTRAP_4, { asOf: AS_OF, sections: { preferences: [preference] } })).toThrow(
      /has no section preferences/,
    );
  });

  it("assembles a pack of the contract's shape, sections in the template's order", () => {
    const pack = assemblePack(BOOTSTRAP, fullBootstrap());
    expect(ContextPack.parse(pack)).toEqual(pack);
    expect(pack.purpose).toBe("agent_bootstrap");
    expect(pack.template).toBe("agent_bootstrap@1");
    expect(pack.asOf).toBe(AS_OF);
    expect([...new Set(pack.items.map((entry) => entry.section))]).toEqual([
      "owner",
      "handoff",
      "upcoming",
      "contacts",
      "notes",
    ]);
    expect(SELECTOR_IN_ORDER).toBe("in_order");
  });

  it("selectInOrder returns the first room ids", () => {
    const universe = items("contacts", 5);
    expect(selectInOrder("contacts", universe, 3)).toEqual(["contacts:0", "contacts:1", "contacts:2"]);
    expect(selectInOrder("contacts", universe, 9)).toEqual(universe.map((entry) => entry.id));
  });

  it("K2: a selector naming an outside id, a duplicate or too many ids changes nothing", () => {
    const expected = bytes(assemblePack(BOOTSTRAP, fullBootstrap(), selectInOrder));
    const bad: Selector[] = [
      (section, universe) => [universe[0]!.id, `${section}:outside`],
      (_, universe) => [universe[1]!.id, universe[1]!.id],
      (_, universe, room) => universe.slice(0, room + 1).map((entry) => entry.id),
      () => ["owner:0"],
    ];
    for (const select of bad) expect(bytes(assemblePack(BOOTSTRAP, fullBootstrap(), select))).toBe(expected);
  });

  it("an id that is not in the section's universe is refused", () => {
    const pack = assemblePack(BOOTSTRAP, fullBootstrap(), (section, universe) =>
      section === "notes" ? ["notes:outside"] : universe.slice(0, 1).map((entry) => entry.id),
    );
    expect(ids(pack, "notes")).toEqual(items("notes", 10).map((entry) => entry.id));
    expect(ids(pack, "contacts")).toEqual(["contacts:0"]);
    expect(ids(pack)).not.toContain("notes:outside");
  });

  it("no selector drops, adds or reorders a required item", () => {
    const asked: PackSection[] = [];
    const select: Selector = (section, universe) => {
      asked.push(section);
      return [...universe]
        .reverse()
        .slice(0, 1)
        .map((entry) => entry.id);
    };
    const pack = assemblePack(BOOTSTRAP, fullBootstrap(), select);
    expect(asked).toEqual(["contacts", "notes"]);
    expect(ids(pack, "owner")).toEqual(["owner:0", "owner:1", "owner:2"]);
    expect(ids(pack, "handoff")).toEqual(["handoff:0"]);
    expect(ids(pack, "upcoming")).toEqual(["upcoming:0", "upcoming:1", "upcoming:2", "upcoming:3"]);
  });

  it("a selector that changes the items it is shown changes nothing", () => {
    const expected = bytes(assemblePack(BOOTSTRAP, fullBootstrap()));
    const meddler: Selector = (_, universe, room) => {
      try {
        (universe as PackItem[]).reverse();
      } catch {
        // frozen
      }
      try {
        (universe[0] as { id: string }).id = "changed";
      } catch {
        // frozen
      }
      return universe.slice(0, room).map((entry) => entry.id);
    };
    expect(bytes(assemblePack(BOOTSTRAP, fullBootstrap(), meddler))).toBe(expected);
  });

  it("chosen items keep the universe's order whatever order the selector answers in", () => {
    const pack = assemblePack(BOOTSTRAP, fullBootstrap(), (section, universe) =>
      section === "contacts"
        ? ["contacts:7", "contacts:2", "contacts:15"]
        : universe.slice(0, 1).map((entry) => entry.id),
    );
    expect(ids(pack, "contacts")).toEqual(["contacts:2", "contacts:7", "contacts:15"]);
  });

  it("a required section over its cap is cut in its given order, and truncated says so", () => {
    const pack = assemblePack(BOOTSTRAP, { asOf: AS_OF, sections: { owner: items("owner", 12, true) } });
    expect(ids(pack, "owner")).toEqual(items("owner", 10).map((entry) => entry.id));
    expect(pack.truncated).toBe(true);
  });

  it("an optional section over its cap is cut by selection, and truncated stays false", () => {
    const pack = assemblePack(BOOTSTRAP, fullBootstrap());
    expect(ids(pack, "contacts")).toEqual(items("contacts", 10).map((entry) => entry.id));
    expect(ids(pack, "notes")).toHaveLength(10);
    expect(pack.truncated).toBe(false);
  });

  it("a full required section takes no room from the section after it", () => {
    const pack = assemblePack(PREP, {
      asOf: AS_OF,
      sections: {
        event: items("event", 1, true),
        attendees: items("attendees", 25, true),
        recent_messages: items("recent_messages", 40),
      },
    });
    expect(ids(pack, "attendees")).toHaveLength(25);
    expect(ids(pack, "recent_messages")).toHaveLength(30);
    expect(pack.items).toHaveLength(56);
    expect(pack.truncated).toBe(false);
  });

  // The reader computes its read set, fact keys and item ids from the
  // pack's items, after the cut; an item cut from a required section is in none of them.
  it("an item cut from a required section is in no item of the pack", () => {
    const pack = assemblePack(BOOTSTRAP, { asOf: AS_OF, sections: { upcoming: items("upcoming", 21, true) } });
    expect(ids(pack, "upcoming")).toHaveLength(20);
    expect(ids(pack)).not.toContain("upcoming:20");
    expect(pack.truncated).toBe(true);
  });

  it("the reader's cut flag sets truncated", () => {
    expect(assemblePack(BOOTSTRAP, { asOf: AS_OF, sections: {}, cut: true }).truncated).toBe(true);
    expect(assemblePack(BOOTSTRAP, { asOf: AS_OF, sections: {}, cut: false }).truncated).toBe(false);
  });

  it("a pack under every cap is not truncated", () => {
    const pack = assemblePack(PREP, {
      asOf: AS_OF,
      sections: {
        event: items("event", 1, true),
        attendees: items("attendees", 3, true),
        recent_messages: items("recent_messages", 2),
      },
    });
    expect(pack.items).toHaveLength(6);
    expect(pack.truncated).toBe(false);
  });

  it("the same input gives the same bytes", () => {
    const first = assemblePack(BOOTSTRAP, fullBootstrap());
    const second = assemblePack(BOOTSTRAP, fullBootstrap());
    expect(bytes(second)).toBe(bytes(first));
    const { hash, ...rest } = first;
    expect(hash).toBe(packHash(rest));
    expect(packHash(first)).toBe(hash);
    expect(hash).toBe(sha256(canonicalJson(rest)));
  });

  it("the hash is over sorted keys at every depth, arrays in order, with no white space", () => {
    expect(canonicalJson({ b: [2, { d: 1, c: 2 }], a: "x" })).toBe('{"a":"x","b":[2,{"c":2,"d":1}]}');
  });

  it("the hash changes when one item's value changes", () => {
    const input = fullBootstrap();
    const before = assemblePack(BOOTSTRAP, input);
    input.sections.owner[0] = item("owner", "owner:0", true, "another value");
    const after = assemblePack(BOOTSTRAP, input);
    expect(after.hash).not.toBe(before.hash);
  });

  it("a section the input leaves out is as an empty one", () => {
    const left = assemblePack(PREP, { asOf: AS_OF, sections: { event: items("event", 1, true) } });
    const empty = assemblePack(PREP, {
      asOf: AS_OF,
      sections: { event: items("event", 1, true), attendees: [], recent_messages: [] },
    });
    expect(bytes(left)).toBe(bytes(empty));
    expect(left.truncated).toBe(false);
  });

  it("an input section the template lacks throws", () => {
    expect(() => assemblePack(PREP, { asOf: AS_OF, sections: { notes: items("notes", 1) } })).toThrow();
    expect(() => assemblePack(PREP, { asOf: AS_OF, sections: { notes: [] } })).toThrow();
  });

  it("an item whose section is not the one it was given under throws", () => {
    expect(() =>
      assemblePack(BOOTSTRAP, { asOf: AS_OF, sections: { contacts: [item("notes", "notes:0")] } }),
    ).toThrow();
  });

  it("two items of one section with one id throw", () => {
    expect(() =>
      assemblePack(BOOTSTRAP, {
        asOf: AS_OF,
        sections: { contacts: [item("contacts", "same"), item("contacts", "same")] },
      }),
    ).toThrow();
  });

  it("an empty optional section asks the selector nothing", () => {
    const asked: PackSection[] = [];
    assemblePack(
      BOOTSTRAP,
      { asOf: AS_OF, sections: { contacts: items("contacts", 2) } },
      (section, universe, room) => {
        asked.push(section);
        return selectInOrder(section, universe, room);
      },
    );
    expect(asked).toEqual(["contacts"]);
  });
});
