import type { EvidenceId } from "@intelligence/contracts";
import {
  BELIEF_TYPES,
  type CardId,
  type PersonalTool,
  type PersonalView,
  type RulingId,
} from "@intelligence/contracts/personal";
import { gmailItem } from "@intelligence/personal-core/items";
import { type ExtractDeps, KEY_V2_GENERATION, processItem } from "@intelligence/personal-extract";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import {
  type Admin,
  AdminError,
  addCompartmentKey,
  type CleanReport,
  createAdmin,
  createPipeline,
  createReader,
  createWriter,
  fingerprint,
  journalPath,
  type Keys,
  loadKeys,
  type Pipeline,
  type Reader,
} from "@intelligence/personal-store";
import { batchOf, claimRecord, queryAs } from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MODEL_ID, quiet, type Synced, syncedWorld } from "../test-support/extract-fixtures.ts";

// `pia facts clean` over a populated store: a synced world at fact key version 2 where two agents
// proposed facts about the owner. A dated task and an instruction to agents filed as the owner's own, a fact
// about a person the store knows, a duplicate of a fact kept under a standing release, and a dated
// task the owner confirmed, and a confirmed fact another agent proposed again. The dry run changes
// nothing; the apply makes only its plan's rulings, each tagged `cleanup` and each lifted as `pi
// correct lift` lifts it; a stale plan is refused; a confirmed fact is listed and never retired, but
// a duplicate of one is joined; a card on a joined fact is withdrawn; the re-extraction waits while
// the lane is not switched on; erasing a re-extracted item's source removes its claim; and a fact
// from the owner's mail past its end is retired as of then. Made-up values only.

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const GENERATION = KEY_V2_GENERATION;
const READS: PersonalTool[] = ["get_self", "get_beliefs", "find_facts"];
const VIEWS: PersonalView[] = ["self", "people", "work"];
type Proposal = { kind: string; fields: Record<string, unknown>; quote?: string };
const TASK: Proposal = { kind: "situation", fields: { domain: "health", state: "booking a dentist appointment" } };
const AUTOFILL: Proposal = {
  kind: "preference",
  fields: { domain: "admin", object: "autofill for checkout forms", polarity: "prefers" },
};
const MAREN: Proposal = {
  kind: "situation",
  fields: { domain: "relationships", state: "helping Maren Holt move house" },
};
const WINDOW: Proposal = {
  kind: "preference",
  fields: { domain: "travel", object: "window seats", polarity: "prefers" },
  quote: "I always book window seats.",
};
const WINDOW_AGAIN: Proposal = {
  kind: "preference",
  fields: { domain: "travel", object: "window seats", polarity: "prefers" },
};
const INVOICE: Proposal = { kind: "situation", fields: { domain: "money", state: "paying the plumber's invoice" } };
const PASSPORT: Proposal = {
  kind: "situation",
  fields: { domain: "travel", state: "renewing a passport by the deadline" },
};
const LATER: Proposal = { kind: "situation", fields: { domain: "admin", state: "an unpaid parking ticket" } };
const BIKE: Proposal = {
  kind: "preference",
  fields: { domain: "interests", object: "road cycling", polarity: "prefers" },
};
const ELMHAVEN: Proposal = { kind: "situation", fields: { domain: "home", state: "living in Elmhaven" } };
const HIS_WORDS = [WINDOW].map((one) => one.quote).join("\n");

let s: Synced;
let keys: Keys;
let admin: Admin;
let reader: Reader;
let pipeline: Pipeline;
let quill = "";
let pell = "";
let n = 0;
// Two messages the owner sent: the first holds the owner's quoted words; the second only PASSPORT cites.
let sent = { id: "", evidence: "" };
let other = { id: "", evidence: "" };
let third = { id: "", evidence: "" };
const records: Record<string, string> = {};

const store = (): ExtractDeps["store"] => ({
  ...pipeline,
  async open(evidenceId: EvidenceId) {
    const opened = await pipeline.open(evidenceId);
    if (opened === null || evidenceId !== sent.evidence) return opened;
    const from = opened.context.ownerAddresses[0] ?? "owner@facts-clean.test";
    const message = {
      id: "facts-clean-sent",
      threadId: "facts-clean",
      internalDate: Date.now(),
      labelIds: ["SENT"],
      headers: [
        { name: "From", value: from },
        { name: "To", value: "friend@facts-clean.test" },
        { name: "Subject", value: "Notes" },
      ],
      text: HIS_WORDS,
    };
    return {
      ...opened,
      raw: gmailItem(message, { sourceAccount: opened.raw.sourceAccount, changeKind: opened.raw.changeKind }),
    };
  },
});
const deps = (): ExtractDeps => ({
  store: store(),
  model: fakeModelClient({}, []),
  modelId: MODEL_ID,
  log: quiet,
  now: () => new Date(),
  generation: GENERATION,
});
const rows = <Row = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<Row[]> =>
  queryAs<Row>(s.db.urls.admin, text, values);
const requestId = (): string => {
  n += 1;
  return `facts-clean-${String(n).padStart(4, "0")}`;
};

async function propose(proposal: Proposal, token: string = quill, cites: string[] = [sent.id]): Promise<string> {
  const id = requestId();
  const made = await reader.proposeAboutYou(token, { ...proposal, scope: "all", requestId: id, cites } as never);
  if (!made.ok) throw new Error(`propose_about_you answered ${made.code}`);
  const writer = createWriter({ url: s.db.urls.writer, keys, log: quiet });
  try {
    await writer.takeRecords();
  } finally {
    await writer.close();
  }
  const [row] = await rows<{ evidence_id: string }>(
    "select evidence_id from ledger.agent_writes where request_id = $1",
    [id],
  );
  if (row?.evidence_id == null) throw new Error("not taken in");
  return row.evidence_id;
}

async function extract(): Promise<void> {
  for (let pass = 0; pass < 2; pass += 1) {
    for (const one of (await pipeline.due(1000, GENERATION)).filter((due) => due.source === "agent_record"))
      await processItem(one, deps());
  }
}

// The beliefs computed for every audience, each active client's and the owner's, as of the
// database's clock.
const computedBeliefs = async () => pipeline.sweepBeliefs(BELIEF_TYPES);
// The computed beliefs that rest on a stored claim.
const restingOn = async (claim: string) =>
  (await computedBeliefs()).flatMap(({ records }) =>
    records.filter((record) => record.belief.support.some((id) => fingerprint(keys, "claim", id) === claim)),
  );

const claimOf = async (evidenceId: string, released = false): Promise<string> =>
  (
    await rows<{ id: string }>("select id from knowledge.claims where evidence_id = $1 and released = $2", [
      evidenceId,
      released,
    ])
  )[0]?.id ?? "";
const cardOf = async (evidenceId: string): Promise<{ id: CardId; state: string; by: string } | undefined> =>
  (
    await rows<{ id: CardId; state: string; by: string }>(
      `select c.id, e.event as state, e.by from ledger.cards c join knowledge.claims k on k.id = c.target_id
       cross join lateral (select r.event, r.by from ledger.record_events r where r.row_kind = 'card' and r.row_id = c.id order by r.id desc limit 1) e
       where c.kind = 'about_you' and k.evidence_id = $1`,
      [evidenceId],
    )
  )[0];
const factsOf = (report: CleanReport, action: keyof CleanReport["samples"]): (string | null)[] =>
  report.samples[action].map((one) => one.fact);
const clean = (options: { plan?: string; lanes?: ("agent" | "correspondence")[] } = {}): Promise<CleanReport> =>
  admin.facts.cleanFacts({
    dryRun: options.plan === undefined,
    ...(options.plan === undefined ? {} : { plan: options.plan }),
    lanes: options.lanes ?? [],
    requestId: requestId(),
  });
// What the cleanup reads, each table as one hash of its rows.
const TABLES = [
  "knowledge.owner_decisions",
  "knowledge.belief_rulings",
  "knowledge.fact_rulings",
  "knowledge.claims",
  "ledger.cards",
  "ledger.record_events",
  "ledger.opportunities",
  "vault.pipeline_items",
  "vault.model_calls",
];
const snapshot = async (): Promise<Record<string, string | null>> => {
  const out: Record<string, string | null> = {};
  for (const table of TABLES) {
    const [row] = await rows<{ h: string | null }>(
      `select md5(string_agg(t::text, ',' order by t::text)) as h from ${table} t`,
    );
    out[table] = row?.h ?? null;
  }
  // And every belief computed from them.
  out.beliefs = JSON.stringify(await computedBeliefs());
  return out;
};
// The cleanup's rulings in force or lifted, by their decisions' `via`.
const cleanupRulings = () =>
  rows<{ id: RulingId; kind: string }>(
    "select id, kind from knowledge.owner_decisions where details ->> 'via' = 'cleanup' order by decided_at, id",
  );

beforeAll(async () => {
  s = await syncedWorld({ labels: ["personal"] });
  const file = s.admin.PI_KEY_FILE ?? "";
  await addCompartmentKey(file, "agent:quill");
  await addCompartmentKey(file, "agent:pell");
  keys = await loadKeys(file);
  admin = createAdmin({ url: s.db.urls.admin, keys, log: quiet, recordEnabled: true, journal: journalPath(file) });
  reader = createReader({ url: s.db.urls.reader, keys, log: quiet });
  pipeline = createPipeline({ url: s.db.urls.pipeline, keys, log: quiet });
  const client = async (name: string): Promise<string> =>
    (
      await admin.clients.addClient({
        name,
        runtime: "local",
        vendorRetention: "none",
        compartments: ["own"],
        views: VIEWS,
        tools: [...READS, "record", "propose_about_you"],
      })
    ).token;
  quill = await client("quill");
  pell = await client("pell");
  const mine = await rows<{ id: string; evidence_id: string }>(
    "select m.id, m.evidence_id from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where e.sender_member = 'm-owner' and e.compartments = '{own}' order by m.id limit 3",
  );
  if (mine.length < 3) throw new Error("the synced world holds fewer than two messages the owner sent");
  sent = { id: mine[0]?.id ?? "", evidence: mine[0]?.evidence_id ?? "" };
  other = { id: mine[1]?.id ?? "", evidence: mine[1]?.evidence_id ?? "" };
  third = { id: mine[2]?.id ?? "", evidence: mine[2]?.evidence_id ?? "" };
  await admin.releases.grantRelease("quill", "preference", { requestId: requestId() });
  records.task = await propose(TASK);
  records.autofill = await propose(AUTOFILL);
  records.maren = await propose(MAREN);
  records.window = await propose(WINDOW);
  records.invoice = await propose(INVOICE);
  records.passport = await propose(PASSPORT, quill, [other.id]);
  await extract();
  // The duplicate, from another agent, after the first is kept.
  records.again = await propose(WINDOW_AGAIN, pell);
  await extract();
  // The owner confirms the invoice, a dated task filed as a situation: a confirm is no endorsement of
  // its kind, so the cleanup lists it and changes nothing.
  const invoice = await cardOf(records.invoice);
  if (invoice === undefined) throw new Error("no card on the invoice");
  await admin.cards.decide({ cards: [invoice.id], answer: "confirm", requestId: requestId() });
  // A fact the owner confirmed, which another agent proposes again: one fact twice.
  records.bike = await propose(BIKE);
  await extract();
  const bike = await cardOf(records.bike);
  if (bike === undefined) throw new Error("no card on the bike");
  await admin.cards.decide({ cards: [bike.id], answer: "confirm", requestId: requestId() });
  await extract();
  records.bikeAgain = await propose(BIKE, pell);
  // A person the owner named with one word, which is a place too: no fact naming the place is about them.
  const [tobias] = await rows<{ entity_id: string }>(
    "select entity_id from knowledge.accounts where value_fp = $1 limit 1",
    [fingerprint(keys, "address", "tobias.reed@example.org")],
  );
  if (tobias === undefined) throw new Error("the synced world holds no Tobias Reed");
  await admin.identity.namePerson(tobias.entity_id as never, "Elmhaven", { requestId: requestId() });
  records.elmhaven = await propose(ELMHAVEN);
  await extract();
});

afterAll(async () => {
  await pipeline?.close();
  await reader?.close();
  await admin?.close();
  await s?.drop();
});

describe("pia facts clean", () => {
  let first: CleanReport;

  it("prints its dry run and changes nothing", async () => {
    const before = await snapshot();
    first = await clean();
    expect(await snapshot()).toEqual(before);
    expect(first.dryRun).toBe(true);
    expect(first.plan).toMatch(/^[0-9a-f]{64}$/);
    expect(factsOf(first, "third_person")).toContain(await claimOf(records.maren as string));
    // A one-word name is never matched: the fact about living in Elmhaven is no one else's.
    const elmhaven = await claimOf(records.elmhaven as string);
    for (const action of ["third_person", "undecided", "confirmed"] as const)
      expect(factsOf(first, action), action).not.toContain(elmhaven);
    expect(factsOf(first, "duplicate")).toContain(await claimOf(records.again as string));
    // The misfiled facts wait for their lane's switch.
    const waiting = factsOf(first, "waits_for_extraction_switch");
    for (const record of [records.task, records.autofill, records.passport])
      expect(waiting).toContain(await claimOf(record as string));
    expect(first.counts.misfiled).toBe(0);
    // The fact the owner confirmed is listed with what a rule would do, never planned.
    const invoice = await claimOf(records.invoice as string, true);
    expect(first.samples.confirmed.find((one) => one.fact === invoice)?.would).toBe("misfiled");
    expect(first.samples.confirmed.find((one) => one.fact === invoice)?.applies).toBeUndefined();
    // A duplicate of a confirmed fact is listed for the owner's eyes and joined all the same.
    expect(first.samples.confirmed.filter((one) => one.would === "duplicate" && one.applies === true)).toHaveLength(1);
    // The same store answers the same plan.
    expect((await clean()).plan).toBe(first.plan);
  });

  it("applies only its plan while the lane is off: the re-extraction is skipped", async () => {
    const report = await clean({ plan: first.plan });
    // The cards on Maren Holt's fact and on each joined duplicate.
    expect(report.applied).toEqual({ rulings: 3, withdrawn: 3, requeued: 0, tasks: 0 });
    // A veto of the fact about Maren Holt and a join of each duplicate, each tagged cleanup.
    expect((await cleanupRulings()).map((one) => one.kind).sort()).toEqual(["fact_join", "fact_join", "fact_veto"]);
    // The confirmed fact is joined with its duplicate, never retired.
    const bike = await claimOf(records.bike as string, true);
    const [bikeKey] = await rows<{ fact_key_fp: string }>("select fact_key_fp from knowledge.claims where id = $1", [
      bike,
    ]);
    expect(
      await rows("select 1 from knowledge.fact_rulings where verdict = 'join' and $1 in (a_fp, b_fp)", [
        bikeKey?.fact_key_fp,
      ]),
    ).toHaveLength(1);
    expect(await rows("select 1 from knowledge.belief_rulings where fact_key_fp = $1", [bikeKey?.fact_key_fp])).toEqual(
      [],
    );
    expect(await rows("select kind from knowledge.owner_decisions where kind = 'facts_clean'")).toHaveLength(1);
    // Nothing was retired, and the misfiled facts' items are not waiting.
    expect(await rows("select 1 from knowledge.belief_rulings where verdict = 'retire'")).toEqual([]);
    for (const record of [records.task, records.autofill, records.passport]) {
      expect((await cardOf(record as string))?.state).toBe("pending");
      expect(await rows("select 1 from vault.pipeline_items where evidence_id = $1 and waiting", [record])).toEqual([]);
    }
  });

  it("withdraws the cards on a vetoed fact and on a joined one, as the cleanup, never as an answer of theirs", async () => {
    for (const record of [records.maren, records.again, records.bikeAgain])
      expect(await cardOf(record as string)).toMatchObject({ state: "withdrawn", by: "system:cleanup" });
  });

  it("refuses a stale plan", async () => {
    const second = await clean({ lanes: ["agent"] });
    expect(second.counts.misfiled).toBe(3);
    records.later = await propose(LATER);
    await extract();
    const before = await snapshot();
    await expect(clean({ plan: second.plan, lanes: ["agent"] })).rejects.toMatchObject({
      name: AdminError.name,
      code: "plan_changed",
    });
    expect(await snapshot()).toEqual(before);
  });

  it("retires each misfiled fact under its switch and sets its item to be read again; the confirmed fact stands", async () => {
    const third = await clean({ lanes: ["agent"] });
    expect(third.counts.misfiled).toBe(4);
    const report = await clean({ plan: third.plan, lanes: ["agent"] });
    expect(report.applied).toEqual({ rulings: 4, withdrawn: 4, requeued: 4, tasks: 0 });
    for (const record of [records.task, records.autofill, records.passport, records.later]) {
      expect(
        await rows("select 1 from vault.pipeline_items where evidence_id = $1 and waiting", [record]),
      ).toHaveLength(1);
      expect(await cardOf(record as string)).toMatchObject({ state: "withdrawn", by: "system:cleanup" });
    }
    const kinds = (await cleanupRulings()).map((one) => one.kind);
    expect(kinds.filter((one) => one === "fact_retire")).toHaveLength(4);
    // Every ruling of a fact made since the first apply is the cleanup's: nothing else was written.
    expect(
      await rows(
        "select kind from knowledge.owner_decisions where kind like 'fact\\_%' and (details ->> 'via') is distinct from 'cleanup'",
      ),
    ).toEqual([]);
    // The confirmed fact has no ruling and still holds a belief.
    const invoice = await claimOf(records.invoice as string, true);
    const [key] = await rows<{ fact_key_fp: string }>("select fact_key_fp from knowledge.claims where id = $1", [
      invoice,
    ]);
    expect(await rows("select 1 from knowledge.belief_rulings where fact_key_fp = $1", [key?.fact_key_fp])).toEqual([]);
    expect(await restingOn(invoice)).not.toEqual([]);
  });

  it("removes a re-extracted claim when its source is erased", async () => {
    await extract();
    const passport = records.passport as string;
    expect(await claimOf(passport)).not.toBe("");
    await admin.erasure.eraseItem({ kind: "message", id: other.id as never }, { requestId: requestId() });
    expect(await rows("select 1 from knowledge.claims where evidence_id = $1", [passport])).toEqual([]);
  });

  it("retires a fact past its end as of its end, or as of a claim said later, and lists what the owner stated", async () => {
    const owner = (await rows<{ id: string }>("select id from knowledge.entities where kind = 'owner'"))[0]?.id ?? "";
    const seed = (n: number, state: string, from: string, to?: string) => {
      const base = claimRecord(third.evidence, "own", owner, { n, type: "situation", validFrom: from });
      return {
        ...base,
        factKey: `lapse ${third.evidence} ${n}`,
        fieldKinds: { domain: "enum", state: "text" },
        claim: {
          ...base.claim,
          assertedBy: owner,
          extractorGeneration: GENERATION,
          ...(to === undefined ? {} : { validTo: to }),
          content: { ...base.claim.content, fields: { domain: "home", state } },
        },
      };
    };
    const ended = "2026-07-01T00:00:00.000Z";
    const saidLater = "2026-08-01T09:00:00.000Z";
    const records = [
      seed(1, "renting a summer flat by the lake", "2026-06-01T09:00:00.000Z", ended),
      // "until June", said in August.
      seed(2, "sharing a garden allotment", saidLater, "2026-06-30T00:00:00.000Z"),
      seed(3, "a boiler", "2026-09-01T09:00:00.000Z"),
    ];
    expect(await pipeline.commit(batchOf(third.evidence, records as never, { generation: GENERATION }))).toBe(
      "committed",
    );
    const claims = await rows<{ id: string; fact_key_fp: string }>(
      "select id, fact_key_fp from knowledge.claims where evidence_id = $1 order by valid_from",
      [third.evidence],
    );
    const [lease, garden, wrong] = claims;
    // The owner's own statement, by their correction's value: a dated task by the rules, listed for
    // them, never retired.
    await admin.notes.correctValue(
      wrong?.id as never,
      { state: "booking a boiler service appointment" },
      {
        requestId: requestId(),
      },
    );
    const [boiler] = await rows<{ id: string; fact_key_fp: string }>(
      `select c.id, c.fact_key_fp from knowledge.claims c join vault.evidence_items e on e.id = c.evidence_id
       where e.source_kind = 'owner_command' order by c.valid_from desc limit 1`,
    );
    for (const one of [lease, garden, boiler]) expect(await restingOn(one?.id ?? "")).not.toEqual([]);
    const dry = await clean();
    const lapsed = (id?: string) => dry.samples.lapsed.find((one) => one.fact === id)?.at;
    expect(lapsed(lease?.id), JSON.stringify(dry.counts)).toBe(ended);
    expect(lapsed(garden?.id)).toBe(saidLater);
    // Its value holds no domain, so code cannot place it, and it is listed for the owner all the same.
    expect(dry.samples.confirmed.find((one) => one.fact === boiler?.id)).toMatchObject({
      would: "undecided",
      code: "bad_fields",
    });
    const report = await clean({ plan: dry.plan });
    expect(report.applied?.rulings).toBe(2);
    for (const [one, at] of [
      [lease, ended],
      [garden, saidLater],
    ] as const) {
      const [retire] = await rows<{ ruling_id: RulingId; created_at: Date }>(
        "select ruling_id, created_at from knowledge.belief_rulings where verdict = 'retire' and fact_key_fp = $1",
        [one?.fact_key_fp],
      );
      expect(retire?.created_at.toISOString()).toBe(at);
      expect(
        await rows("select 1 from knowledge.owner_decisions where id = $1 and details ->> 'via' = 'cleanup'", [
          retire?.ruling_id,
        ]),
      ).toHaveLength(1);
    }
    expect(await rows("select 1 from knowledge.belief_rulings where fact_key_fp = $1", [boiler?.fact_key_fp])).toEqual(
      [],
    );
    // Each retire stands: the next dry run plans nothing for either.
    const again = await clean();
    expect(again.counts.lapsed).toBe(0);
    expect(again.samples.confirmed.find((one) => one.fact === boiler?.id)?.would).toBe("undecided");
  });

  it("lifts each of its rulings as pi correct lift does", async () => {
    const made = await cleanupRulings();
    expect(made.length).toBeGreaterThan(0);
    for (const { id } of made) {
      const lifted =
        (await admin.facts.liftRuling(id, { requestId: requestId() })) ||
        (await admin.facts.liftFactRuling(id, { requestId: requestId() }));
      expect(lifted, id).toBe(true);
    }
    const cleanup = "(select id from knowledge.owner_decisions where details ->> 'via' = 'cleanup')";
    expect(
      await rows(`select 1 from knowledge.belief_rulings where lifted_at is null and ruling_id in ${cleanup}`),
    ).toEqual([]);
    expect(
      await rows(`select 1 from knowledge.fact_rulings where lifted_at is null and ruling_id in ${cleanup}`),
    ).toEqual([]);
  });
});
