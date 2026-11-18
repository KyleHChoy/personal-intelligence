import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANCHOR_VECTORS,
  BROWSER_BUNDLES,
  MIRROR_TEMPLATES,
  MirrorPage,
  type MirrorSection,
  MULTI_ACCOUNT_SURFACES,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { fakeLens } from "../test-support/lens.ts";
import { mirrorValue } from "./mirror.ts";

// The other half of contracts' cross-check (lens-samples.test.ts): what core serves Lens, for
// Lens's own tests to parse. One mirror page per section, holding one sample of every fact type and
// belief kind lens_mirror@1 lists (the capture ones among them), each value normalized by
// mirrorValue; the world device's capture items; ANCHOR_VECTORS, MULTI_ACCOUNT_SURFACES and
// BROWSER_BUNDLES. Written as `<Schema>.<name>.json` into the directory LENS_SAMPLES_OUT names;
// with it unset, nothing is written. Made-up values only.

const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const at = "2026-10-01T10:00:00.000Z";
const text = (value: string) => ({ untrusted: value });
const hex = (n: number): string => n.toString(16).padStart(64, "0");
const who = (n: number, kind: "person" | "organization" | "project", name: string) => ({
  id: `ent_01JABCDEFGHJKMNPQRSTVWXY${String(n).padStart(2, "0")}`,
  kind,
  name: text(name),
  address: kind === "person" ? text(`${name.split(" ")[0]?.toLowerCase()}@example.com`) : null,
});
const lee = who(1, "person", "Lee Example");
const alder = who(2, "organization", "Alder Works");
const alpha = who(3, "project", "Alpha");

const base = {
  id: hex(1),
  subject: lee,
  statedBy: lee,
  basis: "third_party",
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
const fromMeeting = { ...base, message: null, capture: `cap_${ULID}`, segment: { from: 0, to: 12 } };
const link = { ...fromMeeting, subject: alpha, statedBy: null, segment: null, thirdParty: false };

// One fact of each type lens_mirror@1 lists.
const FACTS: Record<string, object> = {
  "transaction.receipt": {
    ...base,
    type: "transaction.receipt",
    fields: { merchant: text("Alder Works"), amount: 12.5, currency: "USD", date: "2026-09-30" },
  },
  commitment: {
    ...fromMeeting,
    type: "commitment",
    fields: { counterparty: lee, what: text("Send the deck."), due: "2026-10-03" },
  },
  plan: { ...base, type: "plan", fields: { counterparty: lee, what: text("Lunch."), when: "2026-10-05" } },
  role: { ...base, type: "role", fields: { title: text("Head of Finance"), organization: alder } },
  affiliation: { ...base, type: "affiliation", fields: { relation: "employee", organization: alder } },
  relationship: { ...base, type: "relationship", fields: { counterparty: lee, relation: "colleague" } },
  need: { ...base, type: "need", fields: { what: text("A designer."), by: "2026-11-01" } },
  capability: { ...base, type: "capability", fields: { what: text("Designs kitchens.") } },
  goal: { ...base, type: "goal", fields: { what: text("Run a marathon.") } },
  preference: { ...base, type: "preference", fields: { what: text("Mornings."), polarity: "prefers" } },
  constraint: {
    ...base,
    type: "constraint",
    validTo: "2026-11-01T23:59:59.999Z",
    fields: { what: text("Cannot travel."), until: "2026-11-01" },
  },
  situation: { ...base, type: "situation", fields: { what: text("On leave.") } },
  consent: {
    ...base,
    type: "consent",
    fields: { about: "introduce", to: alder, what: text("Happy to be introduced.") },
  },
  contact_rule: {
    ...base,
    type: "contact_rule",
    fields: { rule: "do_not_contact", channel: "phone", what: text("No calls at work.") },
  },
  "project.status": { ...base, subject: alpha, type: "project.status", fields: { status: "active" } },
  "project.decision": {
    ...base,
    subject: alpha,
    type: "project.decision",
    fields: { what: text("We chose the oak.") },
  },
  "capture.anchor": { ...link, type: "capture.anchor", fields: { anchor: `pan_${ULID}` } },
  "capture.project": { ...link, type: "capture.project", fields: {} },
  "capture.person": { ...link, subject: lee, thirdParty: true, type: "capture.person", fields: { role: "speaker" } },
};

// One belief of each kind lens_mirror@1 lists: its fact type and its values.
const BELIEF_OF: Record<string, [string, object]> = {
  commitment: ["commitment", { counterparty: lee, due: "2026-10-03" }],
  role: ["role", { organization: alder }],
  affiliation: ["affiliation", { relation: "employee", organization: alder }],
  relationship: ["relationship", { counterparty: lee, relation: "colleague" }],
  need: ["need", { by: "2026-11-01" }],
  capability: ["capability", {}],
  goal: ["goal", {}],
  preference: ["preference", { polarity: "prefers" }],
  constraint: ["constraint", { until: "2026-11-01" }],
  situation: ["situation", {}],
  consent: ["consent", { about: "introduce", to: alder }],
  contact_rule: ["contact_rule", { rule: "do_not_contact", channel: "phone" }],
  project_status: ["project.status", { status: "active" }],
  decision: ["project.decision", {}],
  capture_project: ["capture.project", {}],
};
const belief = (kind: string, [type, values]: [string, object]) => {
  const cite = FACTS[type] as { subject: object };
  return {
    fact: hex(2),
    state: hex(3),
    kind,
    type,
    status: "active",
    disputed: false,
    provenance: "source",
    confirmedAt: at,
    reviewAfter: null,
    subject: cite.subject,
    values,
    cites: [cite],
  };
};

const meeting = {
  id: `evt_${ULID}`,
  title: text("Alpha review"),
  startsAt: at,
  endsAt: at,
  allDay: false,
  cancelled: false,
  participants: [lee],
};
const entity = (one: typeof lee) => ({
  id: one.id,
  kind: one.kind,
  names: [one.name],
  addresses: one.address === null ? [] : [one.address],
  organization: one.kind === "person" ? alder : null,
  people: [],
  mail: { inbound: 3, outbound: 1, firstAt: at, lastAt: at },
  lastMeeting: meeting,
  nextMeeting: null,
  details: [],
  shared: false,
  ...(one.kind === "project"
    ? { status: "active", anchors: [{ id: `pan_${ULID}`, kind: "host", value: text("plans.example.com") }] }
    : {}),
});

// Each section's values, as its read tool builds them, before mirrorValue.
const VALUES: Record<MirrorSection, { key: string; values: object[] }> = {
  entities: { key: "entity", values: [lee, alder, alpha].map(entity) },
  beliefs: { key: "belief", values: Object.entries(BELIEF_OF).map(([kind, of]) => belief(kind, of)) },
  facts: { key: "fact", values: Object.values(FACTS) },
  events: { key: "event", values: [meeting] },
  captures: {
    key: "capture",
    values: [
      {
        capture: `cap_${ULID}`,
        key: `meeting:${ULID}`,
        revision: 1,
        kind: "meeting",
        startedAt: at,
        endedAt: at,
        event: `evt_${ULID}`,
      },
    ],
  },
};

function pages(): Record<MirrorSection, unknown> {
  const template = MIRROR_TEMPLATES[0]?.name ?? "";
  const built = Object.entries(VALUES).map(([section, { key, values }], s) => {
    const withFact = section === "beliefs" || section === "facts";
    const entries = values.map((value, i) => ({
      section,
      stamp: {
        projection: `mir_${hex(s * 100 + i).slice(-40)}`,
        fact: withFact ? hex(500 + i) : null,
        state: hex(900 + i),
      },
      [key]: mirrorValue(value),
    }));
    return [
      section,
      {
        template,
        pass: 1,
        removals: [],
        captureErased: [],
        entries,
        cursor: `mcr_${ULID}`,
        more: false,
        passComplete: true,
        truncated: false,
        hash: hex(7),
      },
    ];
  });
  return Object.fromEntries(built) as Record<MirrorSection, unknown>;
}

// Every file Lens's tests read, by its name.
function samples(): Record<string, unknown> {
  const files: Record<string, unknown> = {};
  for (const [section, page] of Object.entries(pages())) files[`MirrorPage.${section}.json`] = page;
  const mac = fakeLens({ now: new Date("2026-10-01T15:00:00Z") });
  const names = new Map(Object.entries(mac.handles).map(([name, key]) => [key, name]));
  const schema = { meeting: "MeetingItem", moment: "MomentItem", block: "BlockItem", forget: "ForgetItem" } as const;
  for (const item of [...mac.meetings, ...mac.moments, ...mac.blocks, ...mac.forgets])
    files[`${schema[item.kind]}.${names.get(item.key) ?? item.key.replace(":", "-")}.json`] = item;
  files["ANCHOR_VECTORS.json"] = ANCHOR_VECTORS;
  files["MULTI_ACCOUNT_SURFACES.json"] = MULTI_ACCOUNT_SURFACES;
  files["BROWSER_BUNDLES.json"] = BROWSER_BUNDLES;
  return files;
}

const out = process.env.LENS_SAMPLES_OUT;

describe("core's samples for Lens", () => {
  it("one mirror page per section parses, and the pages hold every fact type and belief kind lens_mirror@1 lists, the capture ones among them", () => {
    for (const [section, page] of Object.entries(pages())) {
      const parsed = MirrorPage.safeParse(page);
      expect(
        parsed.success,
        `${section}: ${parsed.error?.issues[0]?.path.join(".")} ${parsed.error?.issues[0]?.message}`,
      ).toBe(true);
    }
    const members = MIRROR_TEMPLATES[0]?.members;
    expect(Object.keys(FACTS)).toEqual(members?.factTypes);
    expect(Object.keys(BELIEF_OF)).toEqual(members?.beliefKinds);
  });

  it.skipIf(out === undefined || out === "")("writes every sample into LENS_SAMPLES_OUT", () => {
    const directory = out ?? "";
    mkdirSync(directory, { recursive: true });
    const files = samples();
    for (const [name, value] of Object.entries(files))
      writeFileSync(join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
    expect(Object.keys(files).length).toBeGreaterThan(20);
  });
});
