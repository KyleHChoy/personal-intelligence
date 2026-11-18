import { type EvidenceId, LocalEntityId, type Timestamp } from "@intelligence/contracts";
import {
  ACTIVITY_PIPELINE,
  type ActivityBlock,
  CaptureId,
  CaptureKey,
  claimTierOf,
  EntityId,
  type MeetingItem,
  type MomentItem,
  type OpenedBlockDay,
  PersonalLogEvent,
} from "@intelligence/contracts/personal";
import { PERSONAL_TYPES } from "@intelligence/personal-beliefs";
import { describe, expect, it } from "vitest";
import { ACTIVITY_TYPES, blockDayClaims, processBlockDay } from "./activity.ts";
import { EXTRACT_GENERATION } from "./config.ts";
import { processMeeting } from "./meetings.ts";
import { processMoments } from "./moments.ts";
import { runExtraction } from "./run.ts";
import { OWNER_ENTITY } from "./test-support/memory-store.ts";
import { NOW, type Setup, setup } from "./test-support/support.ts";

// The owner's activity facts by code, on the in-memory store. Every value is made up, on reserved
// domains. No model is called.

const MINUTE = 60_000;
const hex = (n: number) => n.toString(16).padStart(64, "0");
const fp = (n: number) => `f${n.toString(16).padStart(63, "0")}`;
const project = (n: number) => EntityId.parse(`ent_01JACTVTYA${String(n).padStart(16, "0")}`);
const person = (n: number) => LocalEntityId.parse(EntityId.parse(`ent_01JACTVTYP${String(n).padStart(16, "0")}`));
const [ALPHA, BRAVO] = [project(1), project(2)];
const [ROBIN_ID, DEVON_ID] = [person(1), person(2)];
const ROBIN = "robin.vale@example.org";
const DEVON = "devon.marsh@example.org";
const DAY = "2026-09-30";
const at = (minutes: number): Timestamp =>
  new Date(Date.parse(`${DAY}T13:00:00.000Z`) + minutes * MINUTE).toISOString() as Timestamp;

// One block from `from` to `to` minutes after 13:00 UTC, with strong attributes and a host.
const block = (from: number, to: number, over: Partial<ActivityBlock> = {}): ActivityBlock => ({
  start: at(from),
  end: at(to),
  host: null,
  category: "coding",
  strong: [],
  pages: [],
  ...over,
});
const repo = (value: string, ...keyFps: string[]): ActivityBlock["strong"][number] => ({
  kind: "repository",
  value,
  keyFps,
});
const doc = (value: string, ...keyFps: string[]): ActivityBlock["strong"][number] => ({
  kind: "document",
  value,
  keyFps,
});

let days = 0;
const blockDay = (
  blocks: ActivityBlock[] | null,
  over: {
    candidates?: OpenedBlockDay["candidates"];
    compartments?: string[];
    revision?: number;
    key?: string;
    named?: string[];
  } = {},
): OpenedBlockDay => {
  days += 1;
  const revision = over.revision ?? 0;
  const key = over.key ?? `block:01JACTVTYB${String(days).padStart(16, "0")}`;
  return {
    capture: {
      id: CaptureId.parse(`cap_01JACTVTYC${String(days).padStart(16, "0")}`),
      key: CaptureKey.parse(key),
      revision,
      day: DAY,
    },
    context: {
      evidenceId: hex(1000 + days * 10 + revision) as EvidenceId,
      revision,
      compartments: over.compartments ?? ["own"],
      ownerEntity: OWNER_ENTITY,
    },
    blocks,
    candidates: over.candidates ?? [],
    named: over.named ?? [],
  };
};
const typesOf = (claims: { claim: { content: { type: string } } }[]) => claims.map((one) => one.claim.content.type);

describe("activity.worked_on from a block day alone", () => {
  it("a block whose own strong attribute meets one project's anchor names the project, with its span and no minutes", () => {
    const opened = blockDay([block(0, 30, { strong: [repo("github.com/example/alder", fp(1))] })], {
      candidates: [
        { project: ALPHA, anchorFps: [fp(1)] },
        { project: BRAVO, anchorFps: [fp(9)] },
      ],
    });
    const [claim] = blockDayClaims(opened, 4);
    expect(claim?.claim).toMatchObject({
      content: { type: ACTIVITY_TYPES.workedOn, subject: OWNER_ENTITY, fields: { project: ALPHA } },
      basis: "system_observed",
      statementKind: "stated_fact",
      pipelineVersion: ACTIVITY_PIPELINE,
      validFrom: at(0),
      validTo: at(30),
      origin: "source",
      label: { compartments: ["own"] },
    });
    expect(JSON.stringify(claim?.claim.content.fields)).not.toMatch(/minute/);
    expect(claim).toMatchObject({
      subjectKind: "owner",
      entities: [ALPHA],
      disclosure: [],
      fieldKinds: { project: "entity" },
    });
    expect(
      claimTierOf({
        origin: "source",
        pipelineVersion: claim?.claim.pipelineVersion ?? "",
        basis: "system_observed",
        ownerSaid: false,
        confirmed: false,
      }),
    ).toBe("observed");
  });

  it("with no anchor it names the repository, else the document; two projects' anchors name neither project", () => {
    const opened = blockDay(
      [
        block(0, 10, { strong: [repo("github.com/example/alder", fp(1))] }),
        block(40, 50, { strong: [doc("~/notes/plan.md", fp(2))] }),
        block(80, 90, { strong: [repo("github.com/example/birch", fp(3)), doc("~/notes/birch.md", fp(4))] }),
      ],
      {
        candidates: [
          { project: ALPHA, anchorFps: [fp(3)] },
          { project: BRAVO, anchorFps: [fp(4)] },
        ],
      },
    );
    expect(blockDayClaims(opened, 4).map((one) => one.claim.content.fields)).toEqual([
      { repository: "github.com/example/alder" },
      { document: "~/notes/plan.md" },
      { repository: "github.com/example/birch" },
    ]);
  });

  it("a block with no strong attribute makes none, whatever a linked moment or an app anchor credits", () => {
    // The store gives only strong repository: and document: keys: an app key never reaches here.
    const opened = blockDay([block(0, 30)], { candidates: [{ project: ALPHA, anchorFps: [fp(1)] }] });
    expect(blockDayClaims(opened, 4)).toEqual([]);
  });

  it("adjacent blocks of one theme within 10 minutes are one claim; a gap or another theme between ends the run", () => {
    const alder = repo("github.com/example/alder", fp(1));
    const opened = blockDay([
      block(0, 20, { strong: [alder] }),
      block(25, 40, { strong: [alder] }),
      block(41, 45, { strong: [doc("~/notes/plan.md", fp(2))] }),
      block(46, 60, { strong: [alder] }),
      block(90, 100, { strong: [alder] }),
    ]);
    expect(blockDayClaims(opened, 4).map((one) => [one.claim.validFrom, one.claim.validTo])).toEqual([
      [at(0), at(40)],
      [at(41), at(45)],
      [at(46), at(60)],
      [at(90), at(100)],
    ]);
  });

  it("one theme holds one fact key across items and days; committing the same item again keeps the same claims", () => {
    const strong = [repo("github.com/example/alder", fp(1))];
    const one = blockDayClaims(blockDay([block(0, 30, { strong })]), 4);
    const other = blockDayClaims(blockDay([block(200, 230, { strong })]), 4);
    expect(one[0]?.factKey).toBe(other[0]?.factKey);
    expect(one[0]?.claim.id).not.toBe(other[0]?.claim.id);
    const opened = blockDay([block(0, 30, { strong })]);
    expect(blockDayClaims(opened, 4)).toEqual(blockDayClaims(opened, 4));
    expect(blockDayClaims(opened, 5)[0]?.claim.id).not.toBe(blockDayClaims(opened, 4)[0]?.claim.id);
  });
});

describe("activity.researched from a browser block", () => {
  it("names the project its own strong attributes name, else its category, with its host, and no one", () => {
    const opened = blockDay(
      [
        block(0, 10, { host: "docs.example.org", category: "research" }),
        block(20, 30, { host: "wiki.example.org", category: null }),
        block(40, 50, { host: "plans.example.org", category: "research", strong: [doc("~/notes/plan.md", fp(1))] }),
      ],
      { candidates: [{ project: ALPHA, anchorFps: [fp(1)] }] },
    );
    const researched = blockDayClaims(opened, 4).filter((one) => one.claim.content.type === ACTIVITY_TYPES.researched);
    expect(researched.map((one) => one.claim.content.fields)).toEqual([
      { category: "research", host: "docs.example.org" },
      { category: "other", host: "wiki.example.org" },
      { project: ALPHA, host: "plans.example.org" },
    ]);
    for (const one of researched) {
      expect(one.claim.content.subject).toBe(OWNER_ENTITY);
      expect(one.disclosure).toEqual([]);
    }
    expect(researched[0]?.entities).toEqual([]);
  });

  it("a block without a host makes none, and two hosts of one topic are two runs", () => {
    const opened = blockDay([
      block(0, 10, { host: "docs.example.org", category: "research" }),
      block(11, 20, { host: "news.example.org", category: "research" }),
      block(21, 30, { category: "research" }),
    ]);
    const researched = blockDayClaims(opened, 4).filter((one) => one.claim.content.type === ACTIVITY_TYPES.researched);
    expect(researched).toHaveLength(2);
    expect(researched[0]?.factKey).toBe(researched[1]?.factKey);
  });
});

describe("the block lane", () => {
  it("commits a block day skipped not_extracted with its claims under its own label, with no model call", async () => {
    const s = await setup({ meetings: true, moments: true });
    const id = s.store.putBlockDay(
      blockDay([block(0, 30, { strong: [repo("github.com/example/alder", fp(1))], host: "docs.example.org" })], {
        compartments: ["employer:example", "own"],
      }),
    );
    const [due] = await s.store.dueCaptures("block", 10, 4, { switchedOn: false });
    expect(due?.evidenceId).toBe(id);
    const outcome = await processBlockDay(due as NonNullable<typeof due>, s.deps);
    expect(outcome).toMatchObject({ status: "skipped", code: "not_extracted", claims: 2 });
    const claims = s.store.claims().filter((one) => one.evidenceId === id);
    expect(typesOf(claims).sort()).toEqual([ACTIVITY_TYPES.workedOn, ACTIVITY_TYPES.researched].sort());
    for (const one of claims) expect(one.claim.label.compartments).toEqual(["employer:example", "own"]);
    expect(s.calls).toEqual([]);
    expect(s.store.blockDay(id)?.status).toMatchObject({ status: "skipped", code: "not_extracted", screened: false });
    // Not due again until it is set waiting or a new generation runs.
    expect(await s.store.dueCaptures("block", 10, EXTRACT_GENERATION, { switchedOn: false })).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ evidenceId: id })]),
    );
    const logged = s.log.lines.find((line) => line.event.event === "activity_derived");
    expect(logged?.event).toEqual({
      event: "activity_derived",
      counts: { worked_on: 1, researched: 1, messaged: 0, met: 0 },
      ids: { evidence: id },
    });
    expect(PersonalLogEvent.safeParse(logged?.event).success).toBe(true);
  });

  it("a block day whose work_enc is unfilled is not due, and nothing is written for it", async () => {
    const s = await setup();
    const unfilled = blockDay(null);
    const id = s.store.putBlockDay(unfilled);
    expect(await s.store.dueCaptures("block", 10, EXTRACT_GENERATION, { switchedOn: false })).toEqual([]);
    // Emptied between the list and the open: passed over, nothing written.
    const due = { evidenceId: id, compartments: ["own"], observedAt: at(0), attempts: 0, override: false } as never;
    expect(await processBlockDay(due, s.deps)).toMatchObject({ status: "gone", claims: 0 });
    expect(s.store.blockDay(id)?.status).toBeUndefined();
  });

  it("a block day that cannot be opened waits check_failed with an attempt, and the run goes on to the other lanes", async () => {
    const s = await setup();
    const bad = s.store.putBlockDay(blockDay([block(0, 30, { strong: [repo("github.com/example/alder", fp(1))] })]));
    const good = s.store.putBlockDay(blockDay([block(0, 30, { strong: [repo("github.com/example/birch", fp(2))] })]));
    const store = s.deps.store;
    s.deps.store = {
      ...store,
      openBlockDay: (evidenceId) =>
        evidenceId === bad ? Promise.reject(new Error("work_enc does not parse")) : store.openBlockDay(evidenceId),
    };
    const summary = await runExtraction(s.deps);
    expect(summary).not.toBe("already_running");
    expect(s.store.blockDay(bad)?.status).toMatchObject({ status: "waiting", code: "check_failed" });
    expect(s.store.claims().filter((one) => one.evidenceId === good)).toHaveLength(1);
    // Mail ran after the blocks.
    expect(s.calls.length).toBeGreaterThan(0);
  });

  it("a new revision removes the earlier revision's claims", async () => {
    const s = await setup();
    const first = blockDay([block(0, 30, { strong: [repo("github.com/example/alder", fp(1))] })]);
    s.store.putBlockDay(first);
    await runExtraction(s.deps);
    expect(s.store.claims().filter((one) => one.evidenceId === first.context.evidenceId)).toHaveLength(1);
    const next = blockDay([block(0, 30)], { key: first.capture.key, revision: 1 });
    s.store.putBlockDay(next);
    await runExtraction(s.deps);
    expect(s.store.claims().filter((one) => one.evidenceId === first.context.evidenceId)).toEqual([]);
    expect(s.store.blockDay(next.context.evidenceId)?.status).toMatchObject({ status: "skipped" });
  });

  it("a run takes block days first, whatever any lane's switch, and a model that fails changes nothing of them", async () => {
    const s = await setup({ meetings: true, moments: true });
    s.deps.model = {
      complete: () => Promise.reject(new Error("no model here")),
      embed: () => Promise.reject(new Error("no model here")),
    };
    const id = s.store.putBlockDay(blockDay([block(0, 30, { strong: [repo("github.com/example/alder", fp(1))] })]));
    await runExtraction(s.deps);
    expect(s.store.claims().filter((one) => one.evidenceId === id)).toHaveLength(1);
  });
});

// A chat moment with turns: the owner's line first, Robin's after.
let momentKeys = 0;
const LINE_OWNER = "Sending the venue list over tonight.";
const LINE_ROBIN = "Great, thanks.";
const chat = (minutesBefore: number, over: Partial<MomentItem> = {}): MomentItem => {
  momentKeys += 1;
  const observed = new Date(NOW.getTime() - minutesBefore * MINUTE).toISOString();
  const text = `${LINE_OWNER}\n${LINE_ROBIN}`;
  return {
    kind: "moment",
    key: `moment:01JACTVTYM${String(momentKeys).padStart(16, "0")}`,
    revision: 0,
    observedAt: observed,
    endedAt: new Date(Date.parse(observed) + MINUTE).toISOString(),
    app: { bundle: "test.example.chat", name: "Chat" },
    entity: "chat",
    thread: "Offsite",
    participants: [
      { name: "Robin Vale", address: ROBIN },
      { name: "Devon Marsh", address: DEVON },
      { name: "Sam Reed" },
    ],
    text,
    read: "ax",
    turns: [
      { from: 0, to: LINE_OWNER.length, speaker: "owner" },
      { from: LINE_OWNER.length + 1, to: text.length, speaker: "participant", participant: 0 },
    ],
    ...over,
  };
};
const PEOPLE = { [ROBIN]: ROBIN_ID, [DEVON]: DEVON_ID };

async function commitMoment(s: Setup, item: MomentItem, options: Parameters<Setup["store"]["putMoment"]>[1] = {}) {
  const id = s.store.putMoment(item, { people: PEOPLE, ...options });
  const due = (
    await s.store.dueCaptures("moment", 50, 4, { switchedOn: false, settledBefore: NOW.toISOString() as Timestamp })
  ).find((one) => (one.moments ?? [one]).some((member) => member.evidenceId === id));
  if (due === undefined) throw new Error("not due");
  await processMoments(due, s.deps);
  return s.store.claims().filter((one) => one.evidenceId === id);
}

describe("activity.messaged from a chat with the owner's line", () => {
  it("one claim per participant R28 resolves, pushed within the window, with the moment's span and the third-party class", async () => {
    const s = await setup();
    const claims = (await commitMoment(s, chat(120))).filter(
      (one) => one.claim.content.type === ACTIVITY_TYPES.messaged,
    );
    expect(claims.map((one) => one.claim.content.fields)).toEqual([
      { counterparty: ROBIN_ID },
      { counterparty: DEVON_ID },
    ]);
    for (const one of claims) {
      expect(one).toMatchObject({ subjectKind: "owner", disclosure: ["third_party"], lane: "moment" });
      expect(one.claim.basis).toBe("system_observed");
      expect(one.entities).toEqual([one.claim.content.fields.counterparty]);
    }
  });

  it("none when pushed outside R83b's window, with no owner turn, without turns, or in an agent app", async () => {
    const late = await setup();
    const old = chat(600);
    expect(typesOf(await commitMoment(late, old, { pushedAt: NOW.toISOString() as Timestamp }))).not.toContain(
      ACTIVITY_TYPES.messaged,
    );
    const read = await setup();
    const text = `${LINE_OWNER}\n${LINE_ROBIN}`;
    expect(
      typesOf(
        await commitMoment(
          read,
          chat(120, { turns: [{ from: 0, to: text.length, speaker: "participant", participant: 0 }] }),
        ),
      ),
    ).not.toContain(ACTIVITY_TYPES.messaged);
    const bare = await setup();
    const { turns: _turns, ...noTurns } = chat(120);
    expect(typesOf(await commitMoment(bare, noTurns))).not.toContain(ACTIVITY_TYPES.messaged);
    const agent = await setup();
    expect(typesOf(await commitMoment(agent, chat(120), { agentApp: true }))).not.toContain(ACTIVITY_TYPES.messaged);
  });

  it("an erased participant, gone from the sealed facts, makes none", async () => {
    const s = await setup();
    const claims = await commitMoment(s, chat(120), { sealedParticipants: [{ name: "Devon Marsh", address: DEVON }] });
    expect(
      claims.filter((one) => one.claim.content.type === ACTIVITY_TYPES.messaged).map((one) => one.claim.content.fields),
    ).toEqual([{ counterparty: DEVON_ID }]);
  });
});

let meetingKeys = 0;
const meeting = (over: Partial<MeetingItem> = {}): MeetingItem => {
  meetingKeys += 1;
  return {
    kind: "meeting",
    key: `meeting:01JACTVTYG${String(meetingKeys).padStart(16, "0")}`,
    revision: 0,
    startedAt: "2026-09-30T14:00:00.000Z",
    endedAt: "2026-09-30T14:30:00.000Z",
    app: { bundle: "test.example.meet", name: "Meet" },
    consent: true,
    mode: "call",
    calendar: {
      start: "2026-09-30T14:00:00.000Z",
      end: "2026-09-30T14:30:00.000Z",
      organizer: { address: DEVON },
      attendees: [{ address: DEVON }],
    },
    speakers: [
      { label: "S1", owner: true },
      { label: "S2", owner: false, mention: { name: "Robin Vale", address: ROBIN } },
    ],
    segments: [{ speaker: "S2", fromMs: 0, toMs: 1000, channel: "output", text: "Hello there." }],
    ...over,
  };
};

async function commitMeeting(s: Setup, item: MeetingItem, bound: Record<string, LocalEntityId> = {}) {
  const id = s.store.putMeeting(item, { people: PEOPLE, bound });
  const due = (await s.store.dueCaptures("meeting", 50, 4, { switchedOn: false })).find((one) => one.evidenceId === id);
  if (due === undefined) throw new Error("not due");
  await processMeeting(due, s.deps);
  return s.store.claims().filter((one) => one.evidenceId === id);
}

describe("activity.met from a meeting's typed attendees", () => {
  it("one claim per typed attendee resolved by email, with the meeting's span", async () => {
    const s = await setup();
    const claims = await commitMeeting(
      s,
      meeting({ attendees: [{ name: "Robin Vale", email: ROBIN }, { name: "Sam Reed" }] }),
    );
    const met = claims.filter((one) => one.claim.content.type === ACTIVITY_TYPES.met);
    expect(met.map((one) => one.claim.content.fields)).toEqual([{ counterparty: ROBIN_ID }]);
    expect(met[0]?.claim).toMatchObject({
      validFrom: "2026-09-30T14:00:00.000Z",
      validTo: "2026-09-30T14:30:00.000Z",
      basis: "system_observed",
    });
    expect(met[0]).toMatchObject({ disclosure: ["third_party"], subjectKind: "owner", lane: "meeting" });
  });

  it("a name-only attendee bound to an existing person makes met for that person", async () => {
    const s = await setup();
    const claims = await commitMeeting(s, meeting({ attendees: [{ name: "Devon Marsh" }] }), {
      "Devon Marsh": DEVON_ID,
    });
    expect(
      claims.filter((one) => one.claim.content.type === ACTIVITY_TYPES.met).map((one) => one.claim.content.fields),
    ).toEqual([{ counterparty: DEVON_ID }]);
  });

  it("a name-only attendee nobody knew makes met for the person the binding created", async () => {
    const s = await setup();
    const created = person(7);
    const claims = await commitMeeting(s, meeting({ attendees: [{ name: "Sam Reed" }] }), { "Sam Reed": created });
    const met = claims.filter((one) => one.claim.content.type === ACTIVITY_TYPES.met);
    expect(met.map((one) => one.claim.content.fields)).toEqual([{ counterparty: created }]);
    expect(met[0]?.entities).toEqual([created]);
  });

  it("a name nothing binds yet makes none: never a claim on a raw name", async () => {
    const s = await setup();
    const claims = await commitMeeting(s, meeting({ attendees: [{ name: "Sam Reed" }] }));
    expect(typesOf(claims)).not.toContain(ACTIVITY_TYPES.met);
  });

  it("after the owner's split the meeting's next commit follows it: met names the person the name is bound to now", async () => {
    const s = await setup();
    const before = person(8);
    const after = person(9);
    const id = s.store.putMeeting(meeting({ attendees: [{ name: "Sam Reed" }] }), {
      people: PEOPLE,
      bound: { "Sam Reed": before },
    });
    const process = async () => {
      const due = (await s.store.dueCaptures("meeting", 50, EXTRACT_GENERATION, { switchedOn: false })).find(
        (one) => one.evidenceId === id,
      );
      if (due === undefined) throw new Error("not due");
      await processMeeting(due, s.deps);
      return s.store
        .claims()
        .filter((one) => one.evidenceId === id && one.claim.content.type === ACTIVITY_TYPES.met)
        .map((one) => one.claim.content.fields.counterparty);
    };
    expect(await process()).toEqual([before]);
    // The owner's unbind splits the person; the binding now names the one made after the split,
    // and the meeting is due again.
    const stored = s.store.meeting(id);
    if (stored === undefined) throw new Error("no meeting");
    stored.options.bound = { "Sam Reed": after };
    s.store.retry(id);
    expect(await process()).toEqual([after]);
  });

  it("a calendar invitee or organizer neither typed nor heard, and a speaker, make none", async () => {
    const s = await setup();
    const claims = await commitMeeting(s, meeting());
    expect(typesOf(claims)).not.toContain(ACTIVITY_TYPES.met);
    expect(typesOf(claims)).toContain("capture.person");
  });

  it("none for the owner typing their own name", async () => {
    const s = await setup();
    const owner = s.w.accounts.find((one) => one.compartment === "own")?.address ?? "";
    expect(typesOf(await commitMeeting(s, meeting({ attendees: [{ name: "Me", email: owner }] })))).not.toContain(
      ACTIVITY_TYPES.met,
    );
  });

  // The owner typed by their name alone is the owner before any binding is read,
  // even with the name bound to a namesake (Devon here, as the sync once bound it): no met, no
  // capture.person about anyone for the owner, and no filed mention.
  it("none for the owner typing their own name, known by the speaker marked the owner or a mention of their address, a namesake bound or not", async () => {
    const owner = (await setup()).w.accounts.find((one) => one.compartment === "own")?.address ?? "";
    const marked = {
      speakers: [
        { label: "S1", owner: true, mention: { name: "Ada Quill", address: owner } },
        { label: "S2", owner: false, mention: { name: "Robin Vale", address: ROBIN } },
      ],
    };
    const organizer = {
      calendar: {
        start: "2026-09-30T14:00:00.000Z",
        end: "2026-09-30T14:30:00.000Z",
        organizer: { name: "ada quill", address: owner },
        attendees: [{ address: ROBIN }],
      },
    };
    for (const over of [marked, organizer]) {
      const s = await setup();
      const id = s.store.putMeeting(meeting({ ...over, attendees: [{ name: " Ada  Quill " }] }), {
        people: PEOPLE,
        bound: { "Ada Quill": DEVON_ID, " Ada  Quill ": DEVON_ID },
      });
      const due = (await s.store.dueCaptures("meeting", 50, 4, { switchedOn: false })).find(
        (one) => one.evidenceId === id,
      );
      if (due === undefined) throw new Error("not due");
      await processMeeting(due, s.deps);
      const claims = s.store.claims().filter((one) => one.evidenceId === id);
      expect(typesOf(claims)).not.toContain(ACTIVITY_TYPES.met);
      expect(
        claims
          .filter((one) => one.claim.content.type === "capture.person" && one.claim.content.fields.role === "attendee")
          .map((one) => one.claim.content.subject),
      ).not.toContain(DEVON_ID);
      expect(s.store.mentions().filter((one) => one.evidenceId === id)).toEqual([]);
    }
  });
});

describe("invariant 5: no model writes an activity fact", () => {
  it("every activity claim is code's: of ACTIVITY_PIPELINE, with no assertedBy, and no prompt offers the types", async () => {
    const s = await setup();
    const claims = [
      ...(await commitMoment(s, chat(120))),
      ...(await commitMeeting(s, meeting({ attendees: [{ name: "Robin Vale", email: ROBIN }] }))),
    ].filter((one) => one.claim.content.type.startsWith("activity."));
    expect(claims.length).toBeGreaterThan(0);
    for (const one of claims) {
      expect(one.claim.pipelineVersion).toBe(ACTIVITY_PIPELINE);
      expect(one.claim.assertedBy).toBeUndefined();
    }
    expect(s.calls).toEqual([]);
    expect(PERSONAL_TYPES.filter((type) => type.id.startsWith("activity."))).toEqual([]);
  });
});

describe("researched topics from a block's pages (L51)", () => {
  const page = (
    title: string | null,
    over: Partial<ActivityBlock["pages"][number]> = {},
  ): ActivityBlock["pages"][number] => ({
    host: "docs.example.com",
    title,
    query: null,
    visits: 1,
    firstAt: at(1),
    ...over,
  });
  const web = (pages: ActivityBlock["pages"], over: Partial<ActivityBlock> = {}) =>
    block(0, 20, { host: "docs.example.com", category: "research", pages, ...over });
  const researched = (opened: OpenedBlockDay) =>
    blockDayClaims(opened, 4).filter((one) => one.claim.content.type === ACTIVITY_TYPES.researched);

  it("a phrase two titles share is the topic, with the hosts and queries of its pages", () => {
    const opened = blockDay([
      web([
        page("Rust async runtime guide"),
        page("Choosing a rust async runtime", { host: "forum.example.net", visits: 3 }),
        page("rust async runtime", { host: "search.example.com", query: "rust async runtime", visits: 2 }),
      ]),
    ]);
    const [claim] = researched(opened);
    expect(claim?.claim.content.fields).toEqual({
      topic: "rust async runtime",
      host: "docs.example.com",
      hosts: "forum.example.net\nsearch.example.com",
      queries: "rust async runtime",
    });
    expect(claim?.fieldKinds).toEqual({ topic: "text", host: "text", hosts: "text", queries: "text" });
  });

  it("a site suffix two titles share is never the topic", () => {
    const opened = blockDay([web([page("Alpha budget | Example Wiki"), page("Bravo roadmap | Example Wiki")])]);
    expect(researched(opened)[0]?.claim.content.fields).toMatchObject({ category: "research" });
  });

  it("with no shared phrase the query is the topic, else the category", () => {
    const withQuery = blockDay([
      web([page("Lake trails"), page("results", { query: "kayak rental prices", host: "search.example.com" })]),
    ]);
    expect(researched(withQuery)[0]?.claim.content.fields).toMatchObject({ topic: "kayak rental prices" });
    const none = blockDay([web([page("Lake trails")])]);
    expect(researched(none)[0]?.claim.content.fields).toEqual({ category: "research", host: "docs.example.com" });
  });

  it("a phrase or query holding a word of a visible person's name is passed over", () => {
    const pages = [
      page("Robin Vale budget review"),
      page("Notes on Robin Vale budget review"),
      page("x", { query: "robin vale contact", host: "search.example.com" }),
    ];
    const named = blockDay([web(pages)], { named: ["robin vale", "robin"] });
    const fields = researched(named)[0]?.claim.content.fields ?? {};
    expect(fields).toMatchObject({ topic: "budget review" });
    expect(JSON.stringify(fields).toLowerCase()).not.toContain("robin");
    // A person the label cannot see is not in `named`, so the wording is the code's alone.
    expect(researched(blockDay([web(pages)]))[0]?.claim.content.fields).toMatchObject({ topic: "robin vale" });
  });

  it("one topic across two days shares a fact key, and an older block day with no pages keeps the category", () => {
    const one = researched(blockDay([web([page("Alpha budget plan"), page("The alpha budget plan")])]))[0];
    const two = researched(blockDay([web([page("alpha budget plan draft"), page("Alpha budget plan v2")])]))[0];
    expect(one?.factKey).toBe(two?.factKey);
    expect(one?.claim.content.fields).toMatchObject({ topic: "alpha budget plan" });
  });

  it("a project its own strong attribute names wins over any phrase", () => {
    const opened = blockDay(
      [
        web([page("Alpha budget plan"), page("Alpha budget plan")], {
          strong: [repo("github.com/example/alder", fp(1))],
        }),
      ],
      { candidates: [{ project: ALPHA, anchorFps: [fp(1)] }] },
    );
    expect(researched(opened)[0]?.claim.content.fields).toMatchObject({ project: ALPHA });
  });

  it("a host whose words hold a word of a visible name is left out of hosts", () => {
    const opened = blockDay(
      [
        web([
          page("Lake trails", { host: "robin-vale.example.com" }),
          page("Lake trails map", { host: "maps.example.net" }),
        ]),
      ],
      { named: ["robin vale"] },
    );
    expect(researched(opened)[0]?.claim.content.fields.hosts).toBe("maps.example.net");
  });

  it("hosts and queries are most visits first, at most five each", () => {
    const pages = Array.from({ length: 7 }, (_, n) =>
      page(`p ${n}`, { host: `h${n}.example.com`, query: `q${n} term`, visits: n + 1 }),
    );
    const fields = researched(blockDay([web(pages)]))[0]?.claim.content.fields ?? {};
    expect(String(fields.hosts).split("\n")).toEqual([
      "h6.example.com",
      "h5.example.com",
      "h4.example.com",
      "h3.example.com",
      "h2.example.com",
    ]);
    expect(String(fields.queries).split("\n")).toEqual(["q6 term", "q5 term", "q4 term", "q3 term", "q2 term"]);
  });
});
