import {
  BeliefList,
  CommitmentList,
  type CompactReadTool,
  CompiledBelief,
  ContextPack,
  compactResult,
  EntityView,
  FactList,
  FactView,
  MessageList,
  MessageView,
  SearchResult,
  SelfView,
  TimelineView,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { selfBriefOf } from "../agent-work/run-self.ts";
import { sectionsOf } from "./read-self.ts";

// The measure: each read tool's result, on a synthetic profile of the size the owner's box served
// the planner (some hundred beliefs of the owner's, each citing three facts, from mail and from agents'
// findings the owner confirmed), in code points as JSON text: before, the strict result as it was sent;
// after, what the agent API sends now (get_self's sections in place of its stated, then the wire
// form). It prints the table and pins get_self under 32 000 code points. Every name, address and
// text is made up.

const ulid = (n: number): string =>
  n
    .toString(32)
    .toUpperCase()
    .replace(/I/g, "J")
    .replace(/L/g, "K")
    .replace(/O/g, "P")
    .replace(/U/g, "V")
    .padStart(26, "0");
const hex = (n: number): string => n.toString(16).padStart(64, "0");
const at = (n: number): string => new Date(Date.UTC(2026, 6, 1) + n * 3_600_000).toISOString();
const size = (value: unknown): number => [...JSON.stringify(value)].length;

const owner = {
  id: `ent_${ulid(1)}`,
  kind: "owner",
  name: { untrusted: "Sam Example" },
  address: { untrusted: "sam@example.com" },
};
const person = (n: number) => ({
  id: `ent_${ulid(500 + n)}`,
  kind: "person",
  name: { untrusted: `Person ${n}` },
  address: { untrusted: `person${n}@example.org` },
});
const words = (n: number): string =>
  `Wants to keep Fridays clear for writing and to spend more time on hardware research, note ${n}; prefers short calls before noon.`;

let serial = 10;
const fact = (type: string, subject: unknown, agent: boolean, fields: Record<string, unknown>) => {
  serial += 1;
  return {
    id: hex(serial),
    subject,
    statedBy: agent ? null : subject,
    basis: "explicit_self",
    statementKind: "stated_fact",
    at: at(serial),
    message: agent ? null : `msg_${ulid(serial)}`,
    ...(agent ? { record: `rec_${ulid(serial)}` } : {}),
    document: null,
    passage: null,
    page: null,
    capture: null,
    segment: null,
    thirdParty: false,
    agentReported: agent,
    provenance: agent ? "agent_reported" : "source",
    status: "active",
    type,
    fields,
  };
};
const fieldsOf = (kind: string, n: number) =>
  kind === "preference" ? { what: { untrusted: words(n) }, polarity: "prefers" } : { what: { untrusted: words(n) } };
const belief = (kind: string, n: number, agent: boolean, status = "active", subject: unknown = owner) =>
  CompiledBelief.parse({
    fact: hex(100_000 + n),
    state: hex(200_000 + n),
    kind,
    type: kind,
    status,
    disputed: false,
    provenance: agent ? "owner" : "source",
    confirmedAt: at(n),
    reviewAfter: null,
    subject,
    values: kind === "preference" ? { polarity: "prefers" } : {},
    cites: [0, 1, 2].map(() => ({ ...fact(kind, subject, agent, fieldsOf(kind, n)), status })),
  });

// The owner's profile: 102 open beliefs over six kinds and 10 closed, half from the owner's mail and half
// agents' findings the owner confirmed, 20 facts about the owner in no belief, 8 meetings and 20 contacts.
const KINDS: [string, number][] = [
  ["goal", 15],
  ["preference", 40],
  ["need", 10],
  ["capability", 12],
  ["constraint", 15],
  ["situation", 10],
];
const beliefs = KINDS.flatMap(([kind, count]) =>
  Array.from({ length: count }, (_, n) => belief(kind, serial + n, n % 2 === 0)),
);
const closed = Array.from({ length: 10 }, (_, n) => belief("preference", 900 + n, false, "closed"));
const claims = Array.from({ length: 20 }, (_, n) =>
  FactView.parse({
    ...fact("goal", owner, false, fieldsOf("goal", n)),
    statedBy: person(n),
    basis: "third_party",
    thirdParty: true,
  }),
);
const meeting = (n: number) => ({
  id: `evt_${ulid(900 + n)}`,
  title: { untrusted: `Planning call ${n}` },
  startsAt: at(n),
  endsAt: at(n + 1),
  allDay: false,
  cancelled: false,
  participants: [owner, person(n), person(n + 1)],
});
const upcoming = Array.from({ length: 8 }, (_, n) => meeting(n));
const contacts = Array.from({ length: 20 }, (_, n) => ({
  ...person(n),
  emails30d: 20 - n,
  emails90d: 40 - n,
  meetings90d: n % 3,
}));
const stated = { beliefs: [...beliefs, ...closed], claims, more: false };
// Before is a plain object: SelfView no longer takes `stated`.
const head = SelfView.parse({
  addresses: [{ untrusted: "sam@example.com" }],
  timeZone: null,
  upcoming,
  contacts,
  changes: [],
});
const self = { ...head, stated };
const selfNow = SelfView.parse({
  ...head,
  sections: sectionsOf({ beliefs, people: new Map(), more: false, now: new Date("2026-10-01T00:00:00.000Z") }).sections,
});

// The other tools, at their usual sizes.
const others = beliefs.slice(0, 40).map((one, n) => ({ ...one, subject: person(n % 5) }));
const entity = EntityView.parse({
  id: person(1).id,
  kind: "person",
  names: [person(1).name],
  addresses: [person(1).address],
  organization: null,
  people: [],
  mail: { inbound: 30, outbound: 12, firstAt: at(1), lastAt: at(90) },
  lastMeeting: meeting(1),
  nextMeeting: null,
  details: [],
  shared: false,
  facts: {
    beliefs: beliefs.slice(0, 20).map((one) => ({
      ...one,
      subject: person(1),
      cites: one.cites.map((cite) => ("held" in cite ? cite : { ...cite, subject: person(1), statedBy: person(1) })),
    })),
    claims: [],
    more: false,
  },
});
const summary = (n: number) => ({
  id: `msg_${ulid(3000 + n)}`,
  at: at(n),
  direction: n % 2 === 0 ? "inbound" : "outbound",
  bulk: false,
  category: "primary",
  subject: { untrusted: `Re: plans ${n}` },
  sender: { address: { untrusted: `person${n}@example.org` }, name: null },
  chars: 900,
  attachments: 0,
});
const commitment = (n: number) => ({
  belief: {
    fact: hex(400 + n),
    state: hex(500 + n),
    kind: "commitment",
    type: "commitment",
    status: "active",
    disputed: false,
    provenance: "source",
    confirmedAt: at(n),
    reviewAfter: null,
  },
  direction: "owed_by_owner",
  counterparty: person(n),
  due: null,
  what: { untrusted: `Send the draft ${n}` },
  message: `msg_${ulid(4000 + n)}`,
  capture: null,
  segment: null,
});
const RESULTS: Record<string, unknown> = {
  get_self: self,
  get_beliefs: BeliefList.parse({ beliefs: others.slice(0, 20), more: true }),
  find_facts: FactList.parse({ facts: others.slice(0, 20).flatMap((one) => one.cites.slice(0, 1)), more: true }),
  get_entity: entity,
  get_timeline: TimelineView.parse({
    entries: [
      ...Array.from({ length: 30 }, (_, n) => ({
        kind: "email",
        id: `msg_${ulid(2000 + n)}`,
        at: at(n),
        direction: "inbound",
        subject: { untrusted: `Re: plans ${n}` },
        thread: { untrusted: "thread" },
      })),
      ...Array.from({ length: 5 }, (_, n) => ({ kind: "meeting", at: at(n), meeting: meeting(n) })),
    ],
  }),
  search: SearchResult.parse({
    results: Array.from({ length: 10 }, (_, n) => ({ ...person(n), lastInteractionAt: n % 2 === 0 ? at(n) : null })),
  }),
  find_messages: MessageList.parse({ messages: Array.from({ length: 20 }, (_, n) => summary(n)), more: true }),
  read_message: MessageView.parse({
    ...summary(1),
    thread: { untrusted: "thread" },
    text: { untrusted: words(1).repeat(4) },
    offset: 0,
    more: false,
    unreadable: false,
    attachmentList: [],
    link: null,
  }),
  get_commitments: CommitmentList.parse({
    commitments: Array.from({ length: 20 }, (_, n) => commitment(n)),
    more: false,
  }),
  build_context_pack: ContextPack.parse({
    purpose: "agent_bootstrap",
    template: "agent_bootstrap@5",
    asOf: at(100),
    items: [
      ...upcoming.map((one) => ({
        id: one.id,
        section: "upcoming",
        required: true,
        provenance: "source",
        asOf: at(100),
        kind: "meeting",
        meeting: one,
        cut: false,
      })),
      ...Array.from({ length: 20 }, (_, n) => ({
        id: hex(400 + n),
        section: "commitments",
        required: true,
        provenance: "source",
        asOf: at(n),
        kind: "commitment",
        commitment: commitment(n),
      })),
      ...beliefs.slice(0, 20).map((one) => ({
        id: one.fact,
        section: "facts",
        required: false,
        provenance: one.provenance,
        asOf: one.confirmedAt,
        kind: "belief",
        belief: one,
      })),
      ...contacts.slice(0, 10).map((one) => ({
        id: one.id,
        section: "contacts",
        required: false,
        provenance: "source",
        asOf: at(100),
        kind: "contact",
        contact: one,
      })),
    ],
    truncated: false,
    hash: hex(77),
  }),
};

describe("the read tools' results, before and after the tool context was tightened", () => {
  it("prints each tool's size, and get_self's is under 32 000 code points", () => {
    const rows = Object.entries(RESULTS).map(([tool, value]) => {
      const after = compactResult(tool as CompactReadTool, tool === "get_self" ? selfNow : value);
      return { tool, before: size(value), after: size(after) };
    });
    const brief = selfBriefOf({ beliefs: [...beliefs, ...closed], upcoming: self.upcoming, contacts: self.contacts });
    rows.push({ tool: "run brief (self block)", before: 0, after: size(brief.self) });
    process.stdout.write(
      `\n${rows.map((row) => `${row.tool.padEnd(24)} ${String(row.before).padStart(8)} ${String(row.after).padStart(8)}`).join("\n")}\n`,
    );
    const get = (tool: string) => rows.find((row) => row.tool === tool) as { before: number; after: number };
    expect(get("get_self").after).toBeLessThan(32_000);
    for (const row of rows.filter((one) => one.before > 0)) expect(row.after, row.tool).toBeLessThan(row.before);
    expect(get("run brief (self block)").after).toBeLessThanOrEqual(24_000);
  });
});
