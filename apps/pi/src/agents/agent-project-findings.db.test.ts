import type { CardId, FactView, PersonalTool, PersonalView } from "@intelligence/contracts/personal";
import { type ExtractDeps, runExtraction, runTrial } from "@intelligence/personal-extract";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import {
  type Admin,
  addCompartmentKey,
  createAdmin,
  createPipeline,
  createReader,
  createWriter,
  type Keys,
  loadKeys,
  type Pipeline,
  type Reader,
} from "@intelligence/personal-store";
import { queryAs } from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MODEL_ID, quiet, type Synced, syncedWorld } from "../test-support/extract-fixtures.ts";

// What an agent finds about a project lasts: on the synthetic world, a finding names a project and
// states a decision, a detail and a next step for the owner; after the real extraction with recorded
// outputs the project's page and timeline show all three, citing the record, no card is raised, and
// another agent finds the record. A client that cannot see the project is refused and learns nothing,
// beside a positive control that can.

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const OWNER_NAME = "Avery Quinn";
const WRITER_TOOLS: PersonalTool[] = [
  "record",
  "get_entity",
  "get_timeline",
  "find_facts",
  "read_record",
  "find_records",
  "record_reads",
  "about",
];
const ALL_VIEWS: PersonalView[] = ["self", "people", "work"];
const DECISION = "The kiln build will use the gas burner.";
const DETAIL = "two firebricks of grade 23";
const NEXT = "order the firebricks by Friday";
const BODY = `${DECISION} The order is for ${DETAIL}. ${OWNER_NAME} will ${NEXT}.`;
const SPAN = `chars:0-${BODY.length}`;
const NO_RECORD = "rec_00000000000000000000000000";
const NO_ENTITY = "ent_00000000000000000000000000";

let s: Synced;
let keys: Keys;
let admin: Admin;
let reader: Reader;
let pipeline: Pipeline;
let requests = 0;
let alpha: string;
let beta: string;
let ownOnly: string;
let noWork: string;
let project: string;
let hidden: string;
let record: string;
let evidence: string;
const outputs: Record<string, unknown> = {};

const ok = <T>(outcome: { ok: true; value: T } | { ok: false; code: string }): T => {
  if (!outcome.ok) throw new Error(`answered ${outcome.code}`);
  return outcome.value;
};
const requestId = (): string => {
  requests += 1;
  return `projects-${String(requests).padStart(8, "0")}`;
};
const deps = (): ExtractDeps => ({
  store: pipeline,
  model: fakeModelClient({ ...s.outputs, ...outputs }),
  modelId: MODEL_ID,
  log: quiet,
  now: () => new Date(),
  compartments: [...keys.compartments.keys()],
  factKinds: ["agent"],
});
const projectThis = (at: string) => ({ key: { kind: "source_id", value: "project:this" }, observedAt: at });
const ownerThis = (at: string) => ({ key: { kind: "source_id", value: "owner:this" }, observedAt: at });
const client = async (
  name: string,
  compartments: string[],
  views: PersonalView[],
  tools: PersonalTool[],
): Promise<string> =>
  (await admin.clients.addClient({ name, runtime: "local", vendorRetention: "none", compartments, views, tools }))
    .token;

// A finding written through the reader, taken in by the writer, its recorded output set.
async function finding(
  body: string,
  output: (at: string) => unknown,
  named?: string,
): Promise<{ record: string; evidence: string }> {
  const id = ok(
    await reader.record(alpha, {
      kind: "finding",
      body,
      requestId: requestId(),
      ...(named === undefined ? {} : { project: named as never }),
    }),
  ).recordId;
  const writer = createWriter({ url: s.db.urls.writer, keys, log: quiet });
  try {
    await writer.takeRecords();
  } finally {
    await writer.close();
  }
  const [row] = await queryAs<{ evidence_id: string; created_at: Date }>(
    s.db.urls.admin,
    "select evidence_id, created_at from ledger.agent_writes where id = $1",
    [id],
  );
  if (row === undefined) throw new Error("no record");
  outputs[row.evidence_id] = output(row.created_at.toISOString());
  return { record: id, evidence: row.evidence_id };
}
const claimsOf = (evidenceId: string) =>
  queryAs<{ id: string; type: string }>(
    s.db.urls.admin,
    "select id, type from knowledge.claims where evidence_id = $1 order by type, id",
    [evidenceId],
  );
const cardsOn = (evidenceId: string) =>
  queryAs<{ id: CardId }>(
    s.db.urls.admin,
    "select c.id from ledger.cards c join knowledge.claims k on k.id = c.target_id where k.evidence_id = $1",
    [evidenceId],
  );
const preferenceOf = (said: string) => (at: string) => ({
  claims: [
    {
      type: "preference",
      subject: ownerThis(at),
      fields: { object: "small kilns", polarity: "prefers", domain: "home" },
      statementKind: "stated_fact",
      basis: "third_party",
      span: `chars:0-${said.length}`,
    },
  ],
  narrowing: "none",
});

beforeAll(async () => {
  s = await syncedWorld();
  for (const name of ["alpha", "beta", "own-only", "no-work", "self-only"])
    await addCompartmentKey(s.admin.PI_KEY_FILE ?? "", `agent:${name}`);
  keys = await loadKeys(s.admin.PI_KEY_FILE ?? "");
  admin = createAdmin({ url: s.db.urls.admin, keys, log: quiet, recordEnabled: true });
  reader = createReader({ url: s.db.urls.reader, keys, log: quiet });
  pipeline = createPipeline({ url: s.db.urls.pipeline, keys, log: quiet });
  alpha = await client("alpha", ["own"], ALL_VIEWS, WRITER_TOOLS);
  // Another agent cleared for the finding's label, the positive control.
  beta = await client("beta", ["agent:alpha", "own"], ALL_VIEWS, WRITER_TOOLS);
  // Cleared for own alone: the project is visible, the finding's label is not.
  ownOnly = await client("own-only", ["own"], ALL_VIEWS, WRITER_TOOLS);
  // Cleared for the finding's label, without the work view: no project is visible to it.
  noWork = await client("no-work", ["agent:alpha", "own"], ["self", "people"], WRITER_TOOLS);
  project = await admin.projects.add("Canary project: the kiln build", { requestId: requestId() });
  hidden = await admin.projects.add("Canary project: the employer's kiln", {
    compartment: "employer:example",
    requestId: requestId(),
  });
  await runExtraction(deps());
  ({ record, evidence } = await finding(
    BODY,
    (at) => ({
      claims: [
        {
          type: "project.decision",
          subject: projectThis(at),
          fields: { what: DECISION },
          statementKind: "stated_fact",
          basis: "third_party",
          span: SPAN,
        },
        {
          type: "project.fact",
          subject: projectThis(at),
          fields: { what: DETAIL },
          statementKind: "stated_fact",
          basis: "third_party",
          span: SPAN,
        },
        {
          type: "project.next_step",
          subject: projectThis(at),
          fields: { what: NEXT, who: ownerThis(at) },
          statementKind: "stated_fact",
          basis: "third_party",
          span: SPAN,
        },
      ],
      narrowing: "none",
    }),
    project,
  ));
  await runExtraction(deps());
});

afterAll(async () => {
  await admin?.close();
  await reader?.close();
  await pipeline?.close();
});

describe("a finding that names a project", () => {
  it("makes a decision, a detail and a next step, about the project", async () => {
    expect((await claimsOf(evidence)).map((one) => one.type)).toEqual([
      "project.decision",
      "project.fact",
      "project.next_step",
    ]);
  });

  it("the project's get_entity shows all three, citing the record, agent-reported and unconfirmed", async () => {
    const entity = ok(await reader.getEntity(alpha, { id: project as never }));
    const mine = (entity.facts?.claims ?? []).filter((one: FactView) => one.record === record);
    expect(mine.map((one: FactView) => one.type).sort()).toEqual([
      "project.decision",
      "project.fact",
      "project.next_step",
    ]);
    for (const one of mine) {
      expect(one.agentReported).toBe(true);
      expect(one.tier).toBe("agent_inferred");
      expect(one.subject.id).toBe(project);
    }
    const next = mine.find((one: FactView) => one.type === "project.next_step") as unknown as {
      fields: { who: { kind: string }; what: { untrusted: string } };
    };
    expect(next.fields.who.kind).toBe("owner");
    expect(next.fields.what.untrusted).toBe(NEXT);
    expect(JSON.stringify(entity)).toContain(DETAIL);
  });

  it("get_timeline and find_facts with type project show them too", async () => {
    const timeline = ok(await reader.getTimeline(alpha, { id: project as never }));
    const facts = timeline.entries.flatMap((one) => (one.kind === "fact" ? [one.fact] : []));
    expect(
      facts
        .filter((one) => one.record === record)
        .map((one) => one.type)
        .sort(),
    ).toEqual(["project.decision", "project.fact", "project.next_step"]);
    const found = ok(await reader.findFacts(alpha, { type: "project", limit: 50 })).facts;
    expect(found.filter((one) => one.record === record)).toHaveLength(3);
  });

  it("raises no card, and a fact about the owner in a finding keeps its confirm step", async () => {
    expect(await cardsOn(evidence)).toEqual([]);
    const said = `${OWNER_NAME} prefers small kilns.`;
    const about = await finding(said, preferenceOf(said));
    await runExtraction(deps());
    expect((await claimsOf(about.evidence)).map((one) => one.type)).toEqual(["preference"]);
    expect(await cardsOn(about.evidence)).toHaveLength(1);
  });

  it("a finding that does not name the owner grounds no owner mention", async () => {
    const said = "Someone prefers small kilns.";
    const none = await finding(said, preferenceOf(said));
    await runExtraction(deps());
    expect(await claimsOf(none.evidence)).toEqual([]);
  });

  it("another agent finds it with find_records by project, client and text, and reads it", async () => {
    const byProject = ok(await reader.findRecords(beta, { project: project as never }));
    expect(byProject.records.map((one) => one.id)).toEqual([record]);
    const [listed] = byProject.records;
    expect(listed?.client).toBe("alpha");
    expect(listed?.project).toBe(project);
    expect(listed?.body?.untrusted).toBe(BODY);
    expect(ok(await reader.findRecords(beta, { text: "FIREBRICKS" })).records.map((one) => one.id)).toEqual([record]);
    expect(ok(await reader.findRecords(beta, { text: "no such words" })).records).toEqual([]);
    expect(ok(await reader.findRecords(beta, { client: "alpha" as never })).records.map((one) => one.id)).toContain(
      record,
    );
    expect(ok(await reader.readRecord(beta, { record: record as never })).body?.untrusted).toBe(BODY);
    // Both are read log rows, so the writer's read receipt names the reader.
    const receipts = ok(await reader.recordReads(alpha, { record: record as never })).records;
    expect(receipts[0]?.readers.map((one) => one.client)).toContain("beta");
  });

  it("find_records leaves out what a later record replaced, and read_record still reads it by its id", async () => {
    const first = ok(
      await reader.record(alpha, { kind: "note", body: "The kiln is 90 cm wide.", requestId: requestId() }),
    ).recordId;
    const second = ok(
      await reader.record(alpha, {
        kind: "note",
        body: "The kiln is 120 cm wide.",
        requestId: requestId(),
        supersedes: first as never,
      }),
    ).recordId;
    const found = ok(await reader.findRecords(beta, { text: "cm wide" })).records.map((one) => one.id);
    expect(found).toEqual([second]);
    expect(ok(await reader.readRecord(beta, { record: first as never })).body?.untrusted).toContain("90 cm");
  });

  it("a finding's evidence is shown by its record, never bound, on the project's page", async () => {
    const rows = await queryAs<{ bound: string[]; shown: string[] }>(
      s.db.urls.admin,
      "select r.bound, r.shown from ledger.read_log r where r.tool = 'get_entity' and $1 = any (r.shown)",
      [record],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.bound).not.toContain(evidence);
  });

  it("the project's page leaves out a finding a later one replaced; its timeline keeps it", async () => {
    const replaced = "The kiln build will use a wood burner.";
    const output = (said: string) => (at: string) => ({
      claims: [
        {
          type: "project.decision",
          subject: projectThis(at),
          fields: { what: said },
          statementKind: "stated_fact",
          basis: "third_party",
          span: `chars:0-${said.length}`,
        },
      ],
      narrowing: "none",
    });
    const old = await finding(replaced, output(replaced), project);
    const newer = "The kiln build will use an electric burner.";
    const id = ok(
      await reader.record(alpha, {
        kind: "finding",
        body: newer,
        requestId: requestId(),
        project: project as never,
        supersedes: old.record as never,
      }),
    ).recordId;
    const writer = createWriter({ url: s.db.urls.writer, keys, log: quiet });
    try {
      await writer.takeRecords();
    } finally {
      await writer.close();
    }
    const [row] = await queryAs<{ evidence_id: string; created_at: Date }>(
      s.db.urls.admin,
      "select evidence_id, created_at from ledger.agent_writes where id = $1",
      [id],
    );
    if (row === undefined) throw new Error("no record");
    outputs[row.evidence_id] = output(newer)(row.created_at.toISOString());
    await runExtraction(deps());
    const page = JSON.stringify(ok(await reader.getEntity(alpha, { id: project as never })));
    expect(page).toContain("electric burner");
    expect(page).not.toContain("wood burner");
    expect(JSON.stringify(ok(await reader.getTimeline(alpha, { id: project as never })))).toContain("wood burner");
  });

  it("find_records' subject needs its view, as an unknown id answers", async () => {
    const selfOnly = await client("self-only", ["agent:alpha", "own"], ["self"], WRITER_TOOLS);
    const [person] = await queryAs<{ id: string }>(
      s.db.urls.admin,
      // One alpha can see: an entity's id is random, and a person of the work mail alone is not.
      "select e.id from knowledge.entities e join knowledge.accounts a on a.entity_id = e.id where e.kind = 'person' and a.compartments = '{own}' order by e.id limit 1",
    );
    const asked = await reader.findRecords(selfOnly, { subject: person?.id as never });
    expect(asked).toEqual({ ok: false, code: "not_found" });
    expect(await reader.findRecords(selfOnly, { subject: NO_ENTITY as never })).toEqual(asked);
    expect(ok(await reader.findRecords(alpha, { subject: person?.id as never })).records).toEqual([]);
  });

  it("a client that cannot read the finding's label learns nothing of it, beside the control", async () => {
    // The control read it above. Own alone sees the project, and neither the record nor its facts.
    const page = ok(await reader.getEntity(ownOnly, { id: project as never }));
    expect(JSON.stringify(page)).not.toContain(DETAIL);
    expect(ok(await reader.findRecords(ownOnly, { project: project as never }))).toEqual({
      records: [],
      more: false,
    });
    const unseen = await reader.readRecord(ownOnly, { record: record as never });
    const unknown = await reader.readRecord(ownOnly, { record: NO_RECORD as never });
    expect(unseen).toEqual({ ok: false, code: "not_found" });
    expect(unknown).toEqual(unseen);
  });

  it("a client without the project's view is refused as for an unknown id, and its reads name no project", async () => {
    const asked = await reader.findRecords(noWork, { project: project as never });
    const unknown = await reader.findRecords(noWork, { project: NO_ENTITY as never });
    expect(asked).toEqual({ ok: false, code: "not_found" });
    expect(unknown).toEqual(asked);
    expect(await reader.getEntity(noWork, { id: project as never })).toEqual({ ok: false, code: "not_found" });
    // Its writer held the work view, so the row policy returns the record to no client without it:
    // no read names a project to such a client.
    expect(await reader.readRecord(noWork, { record: record as never })).toEqual({ ok: false, code: "not_found" });
    expect(JSON.stringify(ok(await reader.findRecords(noWork, {})))).not.toContain(project);
  });

  it("recording against a project the caller cannot see answers as for an unknown id and writes nothing", async () => {
    const count = () => queryAs<{ n: number }>(s.db.urls.admin, "select count(*)::int as n from ledger.agent_writes");
    const before = await count();
    const attempt = (token: string, named: string) =>
      reader.record(token, {
        kind: "finding",
        body: "A finding.",
        requestId: requestId(),
        project: named as never,
      });
    const refused = await attempt(alpha, hidden);
    expect(refused).toEqual({ ok: false, code: "not_found" });
    expect(await attempt(alpha, NO_ENTITY)).toEqual(refused);
    // And without the work view, even of a project under its clearance.
    expect(await attempt(noWork, project)).toEqual(refused);
    expect(await count()).toEqual(before);
  });

  it("a record with no project resolves project:this to nobody", async () => {
    const said = "The kiln build will use the gas burner.";
    const none = await finding(said, (at) => ({
      claims: [
        {
          type: "project.decision",
          subject: projectThis(at),
          fields: { what: said },
          statementKind: "stated_fact",
          basis: "third_party",
          span: `chars:0-${said.length}`,
        },
      ],
      narrowing: "none",
    }));
    await runExtraction(deps());
    expect(await claimsOf(none.evidence)).toEqual([]);
  });

  it("the agent lane's trial asks the newest findings once, writes no claim, and a replay asks nothing", async () => {
    const before = await queryAs(s.db.urls.admin, "select count(*)::int as n from knowledge.claims");
    const trial = (replay: boolean) =>
      runTrial(deps(), 20, { lane: "agent", factKinds: true, replay, show: ["project.fact"] });
    // Every finding of this world was asked version 9 when it was taken in, so only a replay finds it.
    const asked = await trial(false);
    if (asked === "already_running") throw new Error("locked");
    expect(asked).toMatchObject({ lane: "agent", version: "9", items: 0 });
    const replayed = await trial(true);
    if (replayed === "already_running") throw new Error("locked");
    expect(replayed).toMatchObject({ lane: "agent", version: "9", live: 0, failed: 0 });
    expect(replayed.items).toBeGreaterThan(0);
    expect(replayed.claims["project.fact"]).toBeDefined();
    expect(await queryAs(s.db.urls.admin, "select count(*)::int as n from knowledge.claims")).toEqual(before);
  });

  it("a credential a finding copies into a fact is masked wherever the fact is served, and the control's plain words are not", async () => {
    const key = `sk-${"proj-4fT9xQ2wE7rY1uI5oP3aS8dF6gH0jK"}`;
    const nora = "nora.vance@example.org";
    const owner = s.w.accounts[0]?.address ?? "";
    const promised = `${nora} will send ${owner} the key ${key} by Friday.`;
    const body = `The kiln controller key is ${key} today. ${promised}`;
    const filed = await finding(
      body,
      (at) => ({
        claims: [
          {
            type: "project.fact",
            subject: projectThis(at),
            fields: { what: `kiln controller key is ${key}` },
            statementKind: "stated_fact",
            basis: "third_party",
            span: `chars:0-${body.length}`,
          },
          {
            type: "commitment",
            subject: { key: { kind: "address", value: nora }, observedAt: at },
            fields: { counterparty: { key: { kind: "address", value: owner }, observedAt: at }, what: promised },
            statementKind: "stated_fact",
            basis: "third_party",
            span: `chars:0-${body.length}`,
          },
        ],
        narrowing: "none",
      }),
      project,
    );
    await runExtraction(deps());
    expect((await claimsOf(filed.evidence)).map((one) => one.type).sort()).toEqual(["commitment", "project.fact"]);
    const served = [
      ok(await reader.getEntity(alpha, { id: project as never })),
      ok(await reader.getTimeline(alpha, { id: project as never })),
      ok(await reader.findFacts(alpha, { type: "project", limit: 50 })),
      ok(await reader.findFacts(alpha, { limit: 50 })),
      ok(await reader.about(alpha, { subject: { address: nora } })),
    ].map((one) => JSON.stringify(one));
    for (const text of served) {
      expect(text).not.toContain(key);
      expect(text).toContain("sk-*");
    }
    // The control: the rest of the fact is served as it stood.
    expect(served[0]).toContain("kiln controller key is sk-");
  });

  it("a next step's who is the owner only by a full name or an address, never a first name", async () => {
    const said = "Avery will order the kiln shelves by Friday.";
    const first = await finding(
      said,
      (at) => ({
        claims: [
          {
            type: "project.next_step",
            subject: projectThis(at),
            fields: { what: "order the kiln shelves by Friday", who: ownerThis(at) },
            statementKind: "stated_fact",
            basis: "third_party",
            span: `chars:0-${said.length}`,
          },
        ],
        narrowing: "none",
      }),
      project,
    );
    await runExtraction(deps());
    expect(await claimsOf(first.evidence)).toEqual([]);
  });

  it("removing the record removes its facts, its sealed item with the project in it, and read_record names no project", async () => {
    expect(ok(await reader.readRecord(beta, { record: record as never })).project).toBe(project);
    await admin.agents.removeRecord(record as never);
    const page = ok(await reader.getEntity(beta, { id: project as never }));
    expect(JSON.stringify(page)).not.toContain(DETAIL);
    expect(await claimsOf(evidence)).toEqual([]);
    const read = ok(await reader.readRecord(beta, { record: record as never }));
    expect(read).toMatchObject({ id: record, removed: true, body: null });
    expect(read.project).toBeUndefined();
    expect(JSON.stringify(read)).not.toContain(project);
    // Its project was sealed only in the evidence row's item, and that row is gone.
    expect(await queryAs(s.db.urls.admin, "select id from vault.evidence_items where id = $1", [evidence])).toEqual([]);
    expect(
      ok(await reader.findRecords(beta, { project: project as never })).records.map((one) => one.id),
    ).not.toContain(record);
  });
});
