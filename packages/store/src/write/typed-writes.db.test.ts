import type { Claim } from "@intelligence/contracts";
import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import type { ClaimRecord } from "@intelligence/contracts/personal";
import {
  AboutView,
  AgentRecordAck,
  type AgentRecordArgs,
  type EntityId,
  SourceAccountId,
  type TypedClaimSubject,
} from "@intelligence/contracts/personal";
import { personalFactKey } from "@intelligence/personal-beliefs";
import { sha256, THE_OWNER } from "@intelligence/personal-core";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Admin } from "../admin/admin.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import type { Keys } from "../core/keys.ts";
import { sealUnder } from "../core/seal.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { Reader } from "../read/read.ts";
import { type Accounts, connect, OWNER, type Who } from "../test-support/cast.ts";
import { one, readAs } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { ingestMail, type MailFixture, mailSourceId } from "../test-support/items.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger, recordingPool } from "../test-support/recording.ts";
import { personOf } from "../test-support/ruling-fixtures.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { daysFrom, evidenceIdOf, iso, outcomeValue, registration } from "../test-support/values.ts";

// A finding's typed claims, written through policy.write_typed_claims in the call that writes the
// finding. The world: Pippa, known from the owner's own mail, Pippa's namesake, and Wren, known only
// from work mail (employer:example), so a client cleared for `own` alone cannot see Wren. Each
// agent's clearance holds its own `agent:` compartment, and the two "team" agents hold each other's,
// so they see each other's claims. Reserved domains.

const NOW = new Date("2030-01-01T12:00:00.000Z");
const at = (days: number) => iso(daysFrom(NOW, days));

const ME: Who = { address: OWNER.personal, name: OWNER.name };
const ME_AT_WORK: Who = { address: OWNER.work, name: OWNER.name };
const PIPPA: Who = { address: "pippa@quayside.test", name: "Pippa Quayside" };
const NAMESAKE: Who = { address: "pippa.q@harbour-example.test", name: "Pippa Quayside" };
const WREN: Who = { address: "wren@partner-example.test", name: "Wren Partnerfield" };

const mails: MailFixture[] = [
  {
    id: "typed-pippa",
    threadId: "thread-typed-pippa",
    at: at(-3),
    from: PIPPA,
    to: [ME],
    subject: "Hello",
    labels: ["INBOX"],
    text: "Hello from Pippa.",
  },
  {
    id: "typed-namesake",
    threadId: "thread-typed-namesake",
    at: at(-2),
    from: NAMESAKE,
    to: [ME],
    subject: "Hi",
    labels: ["INBOX"],
    text: "Hi from the harbour.",
  },
];
const work: MailFixture = {
  id: "typed-wren",
  threadId: "thread-typed-wren",
  at: at(-1),
  from: WREN,
  to: [ME_AT_WORK],
  subject: "Budget",
  labels: ["INBOX"],
  text: "The budget is approved.",
};

const AGENTS = [
  "qa",
  "qb",
  "qc",
  "qd",
  "qe",
  "qf",
  "qg",
  "qh",
  "qi",
  "qj",
  "qk",
  "ql",
  "qm",
  "qn",
  "qo",
  "qp",
  "qq",
  "qr",
  "qs",
  "qt",
  "qu",
  "qv",
  "qw",
  "qx",
  "qy",
  "qz",
  "ra",
  "rb",
  "rc",
  "rd",
  "re",
  "rf",
  "rg",
  "rh",
  "ri",
  "rj",
] as const;
const ROOMY = { maxItemsDay: 100_000, maxCharsDay: 100_000_000, maxRowsDay: 1_000_000, maxCallsMinute: 600 };

let store: TestStore;
let accounts: Accounts;
let pippa: string;
let namesake: string;
let wren: string;
let owner: string;

async function agent(name: (typeof AGENTS)[number], extra: string[] = []): Promise<string> {
  const admin = new Admin({ pool: store.adminPool, keys: store.db.keys, log: store.log, recordEnabled: true });
  const { token } = await admin.clients.addClient(
    registration(name, ["own", `agent:${name}`, ...extra], {
      views: ["self", "people", "work"],
      tools: ["record", "about"],
      quota: ROOMY,
    }),
  );
  return token;
}

let serial = 0;
const ROLE = { title: "head of research", organization_name: "Quayside Labs" };
const claim = (subject: TypedClaimSubject, fields: Record<string, unknown> = ROLE, type = "role") => {
  serial += 1;
  return { subject, type, fields, cites: [], requestId: `typed-claim-${serial}` };
};
async function finding(
  token: string,
  claims: NonNullable<AgentRecordArgs["claims"]>,
  requestId?: string,
): Promise<AgentRecordAck> {
  serial += 1;
  const args = {
    kind: "finding" as const,
    body: "Pippa Quayside is head of research at Quayside Labs.",
    requestId: requestId ?? `typed-record-${serial}`,
    claims,
  };
  return AgentRecordAck.parse(outcomeValue(await store.reader.record(token, args)));
}
const withoutId = (ack: AgentRecordAck) => {
  const { recordId: _, ...rest } = ack;
  return JSON.stringify(rest);
};
const claimsOf = async (recordId: string) =>
  queryAs<{ id: string; fact_key_fp: string; compartments: string[] }>(
    store.db.urls.admin,
    "select c.id, c.fact_key_fp, c.compartments from knowledge.claims c join ledger.agent_writes w on w.evidence_id = c.evidence_id where w.id = $1 order by c.id",
    [recordId],
  );

beforeAll(async () => {
  store = await openStore({
    now: NOW,
    compartments: ["own", "employer:example", ...AGENTS.map((name) => `agent:${name}`)],
  });
  accounts = await connect(store.writer);
  for (const fixture of mails)
    expect(await ingestMail(store.writer, accounts.personalMail, fixture), fixture.id).toBe("stored");
  expect(await ingestMail(store.writer, accounts.workMail, work), work.id).toBe("stored");
  pippa = await personOf(store, PIPPA.address, "own");
  namesake = await personOf(store, NAMESAKE.address, "own");
  wren = await personOf(store, WREN.address, "employer:example");
  owner = one(
    await queryAs<{ id: string }>(store.db.urls.admin, "select id from knowledge.entities where kind = 'owner'"),
  ).id;
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await store.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("typed agent writes", { timeout: DB_TEST_TIMEOUT }, () => {
  it("writes a typed claim at once with a content key under the record's label, takes the record in typed, and no model is called", async () => {
    // A client stub that fails on any call: no model is reached on a typed write.
    vi.stubGlobal("fetch", () => {
      throw new Error("no model may be called on a typed write");
    });
    const token = await agent("qa");
    const ack = await finding(token, [claim({ address: "Pippa@Quayside.test" })]);
    expect(ack).toMatchObject({ duplicates: [], refused: [] });
    expect(ack.known).toEqual([{ subject: pippa, factKeys: [] }]);
    const [written] = await claimsOf(ack.recordId);
    expect(written?.compartments).toEqual(["agent:qa", "own"]);
    const [evidence] = await queryAs<{ typed: boolean; source_kind: string }>(
      store.db.urls.admin,
      "select e.typed, e.source_kind from vault.evidence_items e join ledger.agent_writes w on w.evidence_id = e.id where w.id = $1",
      [ack.recordId],
    );
    expect(evidence).toEqual({ typed: true, source_kind: "agent_record" });
    expect(
      (
        await queryAs(store.db.urls.admin, "select 1 from ledger.trigger_rechecks where $1 = any (added_claims)", [
          written?.id,
        ])
      ).length,
    ).toBe(1);
    const reads = await queryAs<{ tool: string; fact_key_fps: string[] }>(
      store.db.urls.admin,
      "select r.tool, r.fact_key_fps from ledger.read_log r join ledger.agent_writes w on w.session_id = r.session_id where w.id = $1 and r.tool = 'record'",
      [ack.recordId],
    );
    expect(reads.length).toBe(1);
  });

  // A fact about the owner has one path, propose_about_you; a typed claim naming the owner is refused
  // subject_is_owner, by their id or by their own address, and the others land.
  it("writes a view and a visit about a person, each its own claim, and refuses a status about the owner subject_is_owner", async () => {
    const token = await agent("ri");
    const ack = await finding(token, [
      claim(
        { address: PIPPA.address },
        { domain: "career", topic: "remote work", view: "remote teams ship faster" },
        "view",
      ),
      claim({ address: PIPPA.address }, { domain: "travel", place: "Lisbon", when: "2029-11-02" }, "visited"),
      claim(
        { id: owner as EntityId },
        { domain: "travel", organization_name: "Consulate", process: "visa application", state: "in review" },
        "status",
      ),
    ]);
    expect(ack.refused?.map((one) => [one.index, one.code])).toEqual([[2, "subject_is_owner"]]);
    expect(await claimsOf(ack.recordId)).toHaveLength(2);
  });

  it("refuses each claim alone, by its index: fields_invalid, subject_unknown, subject_ambiguous with candidates, a key field's own code, and a relationship with the owner", async () => {
    const token = await agent("qb");
    const ack = await finding(token, [
      claim({ address: PIPPA.address }, { colour: "blue" }, "favourite_colour"),
      claim({ address: "nobody@nowhere.test" }),
      claim({ name: "Pippa Quayside" }),
      claim({ address: PIPPA.address }, { title: "", organization_name: "Quayside Labs" }),
      // A relationship with the owner goes through propose_person alone, so it is refused here.
      claim({ id: pippa as EntityId }, { counterparty: owner, relation: "colleague" }, "relationship"),
      claim({ id: pippa as EntityId }, { counterparty: namesake, relation: "colleague" }, "relationship"),
    ]);
    expect(ack.refused?.map((one) => [one.index, one.code])).toEqual([
      [0, "fields_invalid"],
      [1, "subject_unknown"],
      [2, "subject_ambiguous"],
      [3, "fields_invalid"],
      [4, "subject_is_owner"],
    ]);
    expect([...(ack.refused?.[2]?.candidates ?? [])].sort()).toEqual([pippa, namesake].sort());
    expect((await claimsOf(ack.recordId)).length).toBe(1);
  });

  it("two agents stating one fact make one claim; the second is a duplicate naming the matched claim key, with a duplicate restatement row", async () => {
    const a = await agent("qc", ["agent:qd"]);
    const b = await agent("qd", ["agent:qc"]);
    const first = await finding(a, [claim({ address: PIPPA.address })]);
    const second = await finding(b, [claim({ address: PIPPA.address })]);
    const [written] = await claimsOf(first.recordId);
    expect(written).toBeDefined();
    expect(await claimsOf(second.recordId)).toEqual([]);
    expect(second.duplicates).toHaveLength(1);
    expect(second.duplicates?.[0]?.factKey).toBe(written?.fact_key_fp);
    const [matched] = await queryAs<{ claim_key: string }>(
      store.db.urls.admin,
      "select claim_key from knowledge.claim_values where claim_id = $1",
      [written?.id],
    );
    expect(second.duplicates?.[0]?.claimKey).toBe(matched?.claim_key);
    const rows = await queryAs<{ answer: string; matched_fact_key_fp: string }>(
      store.db.urls.admin,
      "select answer, matched_fact_key_fp from ledger.restatement_checks where record_id = $1",
      [second.recordId],
    );
    expect(rows).toEqual([{ answer: "duplicate", matched_fact_key_fp: written?.fact_key_fp }]);
    expect(second.known?.[0]?.factKeys).toContain(written?.fact_key_fp);
  });

  it("two concurrent writes of one fact by agents that see each other land one claim", async () => {
    const a = await agent("qe", ["agent:qf"]);
    const b = await agent("qf", ["agent:qe"]);
    const fields = { title: "chief of staff", organization_name: "Quayside Labs" };
    const [one, two] = await Promise.all([
      finding(a, [claim({ address: PIPPA.address }, fields)]),
      finding(b, [claim({ address: PIPPA.address }, fields)]),
    ]);
    const written = [...(await claimsOf(one.recordId)), ...(await claimsOf(two.recordId))];
    expect(written).toHaveLength(1);
    expect([...(one.duplicates ?? []), ...(two.duplicates ?? [])]).toHaveLength(1);
  });

  it("an agent that cannot see a matching claim writes its own, reads it back, and its reply is byte-identical with and without the hidden match (invariant 6)", async () => {
    const fields = { title: "lead designer", organization_name: "Quayside Labs" };
    // No hidden match yet.
    const before = await finding(await agent("qg"), [claim({ address: PIPPA.address }, fields)]);
    // Another agent's claim of the same fact, hidden from the next.
    await finding(await agent("qh"), [claim({ address: PIPPA.address }, fields)]);
    const token = await agent("qi");
    const after = await finding(token, [claim({ address: PIPPA.address }, fields)]);
    expect(withoutId(after)).toBe(withoutId(before));
    expect(after.duplicates).toEqual([]);
    const [mine] = await claimsOf(after.recordId);
    expect(mine).toBeDefined();
    // Its later read shows it, served and in no belief (agent_inferred).
    const view = AboutView.parse(outcomeValue(await store.reader.about(token, { subject: { id: pippa as EntityId } })));
    expect(view.claims.map((one) => one.fact)).toContain(mine?.id);
    expect(view.beliefs.flatMap((belief) => belief.support.map((one) => one.fact))).not.toContain(mine?.id);
  });

  it("a retry with the same requestId writes nothing twice and returns the same reply", async () => {
    const token = await agent("qj");
    const fields = { title: "architect", organization_name: "Quayside Labs" };
    const claims = [claim({ address: PIPPA.address }, fields), claim({ address: "nobody@nowhere.test" }, fields)];
    const first = await finding(token, claims, "typed-retry-1");
    const again = await finding(token, claims, "typed-retry-1");
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
    expect((await claimsOf(first.recordId)).length).toBe(1);
    expect(
      (
        await queryAs(
          store.db.urls.admin,
          "select 1 from ledger.read_log r join ledger.agent_writes w on w.session_id = r.session_id where w.id = $1 and r.tool = 'record'",
          [first.recordId],
        )
      ).length,
    ).toBe(1);
  });
});

// Plan-shape tests cannot see inside a definer, so each of its lookups is called under a narrowed
// clearance with a matching row outside it: none returns, counts or refuses because of that row.
// Wren is known only from work mail; the narrowed client holds `own` and its own compartment.
describe("each lookup under a narrowed clearance", { timeout: DB_TEST_TIMEOUT }, () => {
  it("subject by name, by address and by id: a person known only outside the clearance is refused as one that is absent", async () => {
    const token = await agent("qk");
    const ack = await finding(token, [
      claim({ name: WREN.name ?? "" }),
      claim({ name: "Nobody Atall" }),
      claim({ address: WREN.address }),
      claim({ address: "nobody@nowhere.test" }),
      claim({ id: wren as EntityId }),
    ]);
    expect(ack.refused).toEqual([0, 1, 2, 3, 4].map((index) => ({ index, code: "subject_unknown" })));
    expect(ack.known).toEqual([]);
  });

  it("known list: a claim about the subject outside the clearance is not listed", async () => {
    const wide = await agent("ql", ["employer:example"]);
    const hidden = await finding(wide, [
      claim({ address: PIPPA.address }, { title: "board advisor", organization_name: "Quayside Labs" }),
    ]);
    const [outside] = await claimsOf(hidden.recordId);
    expect(outside?.compartments).toEqual(["agent:ql", "employer:example", "own"]);
    const narrow = await finding(await agent("qm"), [
      claim({ address: PIPPA.address }, { title: "treasurer", organization_name: "Quayside Labs" }),
    ]);
    expect(narrow.known?.[0]?.factKeys).not.toContain(outside?.fact_key_fp);
  });

  it("the definer itself: a subject id the token does not show, sent by a raw caller, is refused subject_unknown and writes no claim", async () => {
    const raw = await rawWrite(await agent("qn"), [
      { subject: wren, factKeyFp: sha256("hidden subject key"), valueFp: sha256("hidden subject value") },
    ]);
    expect(raw.reply).toEqual({ duplicates: [], known: [], refused: [{ index: 0, code: "subject_unknown" }] });
    expect(await claimsOf(raw.recordId)).toEqual([]);
  });
});

// A typed claim keys under its writer's whole label, and its duplicate is matched over the content
// keys the same claim takes under each label in use within the writer's clearance. A typed claim
// raises its agent_claim card through the pipeline's agent lane code, one card per fact. Each cite
// is an item the writer can see.
describe("typed-claim rulings: the writer's label, one card per fact, visible cites", {
  timeout: DB_TEST_TIMEOUT,
}, () => {
  const pippaMail = () => evidenceIdOf(accounts.personalMail, mailSourceId(mails[0] as MailFixture));
  // A claim of the owner's own mail about Pippa, keyed as the extraction keys it under `own`.
  async function mailClaim(n: number, type: string, fields: Record<string, unknown>): Promise<string> {
    const evidenceId = pippaMail();
    const content = { type, subject: pippa, fields };
    const base = claimRecord(evidenceId, "own", pippa, {
      n,
      type,
      entities: [pippa],
      factKey: personalFactKey(content as never, evidenceId, ["own"], undefined, 2),
    });
    const record = {
      ...base,
      claim: {
        ...base.claim,
        evidence: [{ evidenceId, span: "chars:0-5" }],
        extractorGeneration: 5,
        content,
      } as unknown as Claim,
      subjectKind: "person",
      fieldKinds: Object.fromEntries(
        Object.keys(fields).map((name) => [name, name === "domain" ? "enum" : name === "by" ? "date" : "text"]),
      ),
    } as ClaimRecord;
    const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
    try {
      expect(await pipeline.commit(batchOf(evidenceId, [record]))).toBe("committed");
    } finally {
      await pipeline.close();
    }
    // The pipeline stores a claim under its keyed id.
    return fingerprint(store.db.keys, "claim", record.claim.id);
  }

  it("an agent restating a fact its clearance holds from the owner's mail is a duplicate of the mail claim", async () => {
    const fields = { title: "harbour master", organization_name: "Quayside Labs" };
    const mail = await mailClaim(1, "role", fields);
    const ack = await finding(await agent("qo"), [claim({ address: PIPPA.address }, fields)]);
    expect(await claimsOf(ack.recordId)).toEqual([]);
    const [matched] = await queryAs<{ claim_key: string; fact_key_fp: string }>(
      store.db.urls.admin,
      "select v.claim_key, c.fact_key_fp from knowledge.claim_values v join knowledge.claims c on c.id = v.claim_id where c.id = $1",
      [mail],
    );
    expect(ack.duplicates).toEqual([{ claimKey: matched?.claim_key, factKey: matched?.fact_key_fp }]);
  });

  it("a new typed fact on a key with only mail claims keys under its own label, so the agent's belief from mail stays", async () => {
    const goal = { domain: "career", objective: "open a gallery" };
    const mail = await mailClaim(2, "goal", goal);
    const token = await agent("qp");
    const supported = async () => {
      const view = AboutView.parse(
        outcomeValue(await store.reader.about(token, { subject: { id: pippa as EntityId } })),
      );
      return view.beliefs.flatMap((belief) => belief.support.map((one) => one.fact));
    };
    expect(await supported()).toContain(mail);
    // The same goal by a date: the same content key under `own`, another value.
    const ack = await finding(token, [claim({ address: PIPPA.address }, { ...goal, by: "2030-06-01" }, "goal")]);
    expect(ack.duplicates).toEqual([]);
    const [typed] = await claimsOf(ack.recordId);
    const [stored] = await queryAs<{ fact_key_fp: string }>(
      store.db.urls.admin,
      "select fact_key_fp from knowledge.claims where id = $1",
      [mail],
    );
    expect(typed).toBeDefined();
    expect(typed?.fact_key_fp).not.toBe(stored?.fact_key_fp);
    expect(await supported()).toContain(mail);
  });

  it("two agents stating one fact make one claim and one agent_claim card, raised by the pipeline's agent lane once", async () => {
    const a = await agent("qq", ["agent:qr"]);
    const b = await agent("qr", ["agent:qq"]);
    const fields = { title: "chief engineer", organization_name: "Quayside Labs" };
    const first = await finding(a, [claim({ address: PIPPA.address }, fields)]);
    const second = await finding(b, [claim({ address: PIPPA.address }, fields)]);
    expect(second.duplicates).toHaveLength(1);
    expect(await claimsOf(second.recordId)).toEqual([]);
    const [written] = await claimsOf(first.recordId);
    const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
    try {
      await pipeline.raiseSettledClaims();
      await pipeline.raiseSettledClaims();
    } finally {
      await pipeline.close();
    }
    const cards = await queryAs<{ kind: string }>(
      store.db.urls.admin,
      "select kind from ledger.cards where target_kind = 'claim' and target_id = $1",
      [written?.id],
    );
    expect(cards).toEqual([{ kind: "agent_claim" }]);
  });

  it("a cite of an item the writer cannot see, or of no item, refuses that claim alike; a visible cite passes", async () => {
    const token = await agent("qs");
    const hidden = evidenceIdOf(accounts.workMail, mailSourceId(work));
    const cited = (fields: Record<string, unknown>, evidenceId: string) => ({
      ...claim({ address: PIPPA.address }, fields),
      cites: [{ evidenceId: evidenceId as never, span: { start: 0, end: 5 } }],
    });
    const ack = await finding(token, [
      cited({ title: "night editor", organization_name: "Quayside Labs" }, hidden),
      cited({ title: "night editor", organization_name: "Quayside Labs" }, "9".repeat(64)),
      cited({ title: "day editor", organization_name: "Quayside Labs" }, pippaMail()),
    ]);
    expect(ack.refused).toEqual([
      { index: 0, code: "fields_invalid" },
      { index: 1, code: "fields_invalid" },
    ]);
    expect((await claimsOf(ack.recordId)).length).toBe(1);
  });
});

// Typed claims under contention: one card per key, cites, racing writers, the definer, retries.
describe("typed claims: one card per key, cites, racing writers, the definer, retries", {
  timeout: DB_TEST_TIMEOUT,
}, () => {
  const pass = async (keys = store.db.keys) => {
    const pipeline = createPipeline({ url: store.db.urls.pipeline, keys, log: recordingLogger().log });
    try {
      return await pipeline.raiseSettledClaims();
    } finally {
      await pipeline.close();
    }
  };
  const cardsOf = async (claimIds: string[]) =>
    queryAs<{ id: string }>(
      store.db.urls.admin,
      "select id from ledger.cards where target_kind = 'claim' and target_id = any ($1)",
      [claimIds],
    );
  const exists = async (claimId: string) =>
    (await queryAs(store.db.urls.admin, "select 1 from knowledge.claims where id = $1", [claimId])).length > 0;

  it("a finding with two claims on one claim key gets one card and is not picked again", async () => {
    const token = await agent("qt");
    const goal = { domain: "health", objective: "run a marathon" };
    const ack = await finding(token, [
      claim({ address: PIPPA.address }, goal, "goal"),
      claim({ address: PIPPA.address }, { ...goal, by: "2030-05-01" }, "goal"),
    ]);
    const written = await claimsOf(ack.recordId);
    expect(written).toHaveLength(2);
    expect(new Set(written.map((one) => one.fact_key_fp)).size).toBe(1);
    await pass();
    expect(await cardsOf(written.map((one) => one.id))).toHaveLength(1);
    expect(await pass()).toEqual({ raised: 0 });
    expect(await cardsOf(written.map((one) => one.id))).toHaveLength(1);
  });

  it("a record under a compartment the pipeline holds no key for is skipped and does not stop the pass", async () => {
    const blind = await finding(await agent("qu"), [
      claim({ address: PIPPA.address }, { title: "ferry pilot", organization_name: "Quayside Labs" }),
    ]);
    const seen = await finding(await agent("qv"), [
      claim({ address: PIPPA.address }, { title: "ferry captain", organization_name: "Quayside Labs" }),
    ]);
    const keys: Keys = {
      ...store.db.keys,
      compartments: new Map([...store.db.keys.compartments].filter(([compartment]) => compartment !== "agent:qu")),
    };
    await pass(keys);
    const [hidden] = await claimsOf(blind.recordId);
    const [shown] = await claimsOf(seen.recordId);
    expect(await cardsOf([hidden?.id ?? ""])).toEqual([]);
    expect(await cardsOf([shown?.id ?? ""])).toHaveLength(1);
  });

  it("deleting an item a typed claim cites removes the claim (invariant 10)", async () => {
    const cited: MailFixture = {
      id: "typed-cited",
      threadId: "thread-typed-cited",
      at: at(-1),
      from: PIPPA,
      to: [ME],
      subject: "Role",
      labels: ["INBOX"],
      text: "I am the harbour pilot now.",
    };
    expect(await ingestMail(store.writer, accounts.personalMail, cited)).toBe("stored");
    const evidenceId = evidenceIdOf(accounts.personalMail, mailSourceId(cited));
    const ack = await finding(await agent("qw"), [
      {
        ...claim({ address: PIPPA.address }, { title: "harbour pilot", organization_name: "Quayside Labs" }),
        cites: [{ evidenceId: evidenceId as never, span: { start: 0, end: 5 } }],
      },
    ]);
    const [written] = await claimsOf(ack.recordId);
    expect(written).toBeDefined();
    const removed = await store.writer.applyDeletion(accounts.personalMail, {
      sourceAccount: accounts.personalMail.id,
      sourceItemId: mailSourceId(cited),
    } as never);
    expect(removed.recordsRemoved).toBeGreaterThanOrEqual(1);
    expect(await exists(written?.id ?? "")).toBe(false);
  });

  it("a cite of an item whose payload expired is refused", async () => {
    const gone: MailFixture = {
      id: "typed-expired",
      threadId: "thread-typed-expired",
      at: at(-1),
      from: PIPPA,
      to: [ME],
      subject: "Old",
      labels: ["INBOX"],
      text: "An old note.",
    };
    expect(await ingestMail(store.writer, accounts.personalMail, gone)).toBe("stored");
    const evidenceId = evidenceIdOf(accounts.personalMail, mailSourceId(gone));
    const owner = new pg.Client({ connectionString: store.db.urls.bootstrap });
    await owner.connect();
    try {
      await owner.query("set role pi_owner");
      await owner.query(
        "update vault.evidence_items set payload_state = 'expired', blob_ref = null, expired_at = now() where id = $1",
        [evidenceId],
      );
    } finally {
      await owner.end();
    }
    const ack = await finding(await agent("qx"), [
      {
        ...claim({ address: PIPPA.address }, { title: "archivist", organization_name: "Quayside Labs" }),
        cites: [{ evidenceId: evidenceId as never, span: { start: 0, end: 5 } }],
      },
    ]);
    expect(ack.refused).toEqual([{ index: 0, code: "fields_invalid" }]);
  });

  // A first writer held after its definer, before its commit, while a second writes.
  // Each writer's label is put in use first, by a note, so neither waits on the other's new label
  // row and the only wait left is the definer's key lock.
  async function overlapped(
    first: string,
    second: string,
    fields: Record<string, unknown>,
    waits: boolean,
  ): Promise<[AgentRecordAck, AgentRecordAck]> {
    for (const token of [first, second]) {
      serial += 1;
      expect(
        (
          await store.reader.record(token, {
            kind: "note",
            body: "A note that puts this label in use.",
            requestId: `typed-warm-${serial}`,
          })
        ).ok,
      ).toBe(true);
    }
    const held = recordingPool(store.readerPool, { holdWhen: (text) => /^commit/i.test(text.trim()) });
    const reader = new Reader({ pool: held.pool, keys: store.db.keys, log: store.log });
    serial += 1;
    const one = reader.record(first, {
      kind: "finding",
      body: "Pippa Quayside's role.",
      requestId: `typed-overlap-${serial}`,
      claims: [claim({ address: PIPPA.address }, fields)],
    });
    await held.held.reached;
    const two = finding(second, [claim({ address: PIPPA.address }, fields)]);
    try {
      if (waits) {
        for (let tries = 0; ; tries += 1) {
          const [waiting] = await queryAs<{ n: number }>(
            store.db.urls.admin,
            "select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted",
          );
          if ((waiting?.n ?? 0) > 0) break;
          if (tries > 200) throw new Error("the second writer never waited");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } else {
        await two;
      }
    } finally {
      held.held.release();
    }
    return [AgentRecordAck.parse(outcomeValue(await one)), await two];
  }

  it("two writers of one label, overlapped by a barrier, land one claim", async () => {
    const a = await agent("qy", ["agent:qz"]);
    const b = await agent("qz", ["agent:qy"]);
    const [first, second] = await overlapped(a, b, { title: "tide warden", organization_name: "Quayside Labs" }, true);
    expect(await claimsOf(first.recordId)).toHaveLength(1);
    expect(await claimsOf(second.recordId)).toEqual([]);
    expect(second.duplicates).toHaveLength(1);
  });

  it("two writers of different labels, overlapped, may both land one fact (the known limit)", async () => {
    const a = await agent("ra");
    const b = await agent("rb", ["agent:ra"]);
    const [first, second] = await overlapped(a, b, { title: "lock keeper", organization_name: "Quayside Labs" }, false);
    expect(await claimsOf(first.recordId)).toHaveLength(1);
    expect(await claimsOf(second.recordId)).toHaveLength(1);
  });

  it("a raw caller sending a hidden claim's fact key among its duplicate keys gets no duplicate, byte-identical to one sending none", async () => {
    const [hidden] = await queryAs<{ fact_key_fp: string; value_fp: string }>(
      store.db.urls.admin,
      "select c.fact_key_fp, v.value_fp from knowledge.claims c join knowledge.claim_values v on v.claim_id = c.id where c.compartments = array['agent:qh', 'own']::text[] limit 1",
    );
    expect(hidden).toBeDefined();
    const own = sha256("t7 own key");
    const withHidden = await rawWrite(await agent("rc"), [
      {
        subject: namesake,
        factKeyFp: own,
        matchFps: [own, hidden?.fact_key_fp ?? ""],
        valueFp: hidden?.value_fp ?? "",
      },
    ]);
    const without = await rawWrite(await agent("rd"), [
      { subject: namesake, factKeyFp: own, matchFps: [own, sha256("t7 absent key")], valueFp: hidden?.value_fp ?? "" },
    ]);
    expect((withHidden.reply as TypedReplyShape).duplicates).toEqual([]);
    expect(JSON.stringify(withHidden.reply)).toBe(JSON.stringify(without.reply));
  });

  it("a claim of an agent record counts as the agent's whatever its sealed origin says: a raw caller cannot mint a source or owner tier", async () => {
    const token = await agent("re");
    const raw = await rawWrite(token, [
      {
        subject: namesake,
        factKeyFp: sha256("t4a key"),
        valueFp: sha256("t4a value"),
        origin: "source",
        assertedBy: owner,
      },
    ]);
    const [claimId] = raw.claimIds;
    expect(await exists(claimId ?? "")).toBe(true);
    const view = AboutView.parse(
      outcomeValue(await store.reader.about(token, { subject: { id: namesake as EntityId } })),
    );
    expect(view.beliefs.flatMap((belief) => belief.support.map((one) => one.fact))).not.toContain(claimId);
    // Served, as any finding's claim, at the agent's tier: never the owner's or a source's.
    expect(view.claims.find((one) => one.fact === claimId)?.tier).toBe("agent_inferred");
  });

  it("the computed read marks an agent record's typed claim as the agent's, whatever its sealed origin says", async () => {
    const token = await agent("rj");
    const factKeyFp = sha256("t4j key");
    const raw = await rawWrite(token, [
      { subject: namesake, factKeyFp, valueFp: sha256("t4j value"), origin: "source", assertedBy: owner },
    ]);
    const [claimId] = raw.claimIds;
    const [row] = await queryAs<{ compartments: string[] }>(
      store.db.urls.admin,
      "select compartments from knowledge.claims where id = $1",
      [claimId],
    );
    const inputs = await queryAs<{ id: string; flags: string[] }>(
      store.db.urls.pipeline,
      "select id, flags from policy.belief_inputs_under($1::text[], $2::text[], now()) where part = 'claim'",
      [row?.compartments ?? [], [factKeyFp]],
    );
    expect(inputs.find((one) => one.id === claimId)?.flags).toEqual(expect.arrayContaining(["agent_item", "typed"]));
  });

  it("the definer refuses a type outside the typed kinds", async () => {
    const raw = await rawWrite(await agent("rf"), [
      { type: "transaction.receipt", subject: namesake, factKeyFp: sha256("t4b key"), valueFp: sha256("t4b value") },
    ]);
    expect((raw.reply as TypedReplyShape).refused).toEqual([{ index: 0, code: "fields_invalid" }]);
    expect(await exists(raw.claimIds[0] ?? "")).toBe(false);
  });

  it("the definer takes typed claims only for a finding appended in its own transaction", async () => {
    const token = await agent("rg");
    const untyped = outcomeValue(
      await store.reader.record(token, {
        kind: "finding",
        body: "An earlier untyped finding.",
        requestId: "typed-earlier-1",
      }),
    );
    const [row] = await queryAs<{ session_id: string }>(
      store.db.urls.admin,
      "select session_id from ledger.agent_writes where id = $1",
      [untyped.recordId],
    );
    await expect(
      rawWrite(token, [{ subject: namesake, factKeyFp: sha256("t4c key"), valueFp: sha256("t4c value") }], {
        earlier: { recordId: untyped.recordId, session: row?.session_id ?? "" },
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("a retry from a new session returns the stored reply; a retry with other claims is refused as a reused request", async () => {
    const token = await agent("rh");
    const claims = [claim({ address: PIPPA.address }, { title: "net mender", organization_name: "Quayside Labs" })];
    const first = await finding(token, claims, "typed-retry-session-1");
    const elsewhere = new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log });
    const again = AgentRecordAck.parse(
      outcomeValue(
        await elsewhere.record(token, {
          kind: "finding",
          body: "Pippa Quayside is head of research at Quayside Labs.",
          requestId: "typed-retry-session-1",
          claims,
        }),
      ),
    );
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
    const changed = await store.reader.record(token, {
      kind: "finding",
      body: "Pippa Quayside is head of research at Quayside Labs.",
      requestId: "typed-retry-session-1",
      claims: [claim({ address: PIPPA.address }, { title: "sail maker", organization_name: "Quayside Labs" })],
    });
    expect(changed).toEqual({ ok: false, code: "invalid_request" });
    expect((await claimsOf(first.recordId)).length).toBe(1);
  });
});

type TypedReplyShape = { duplicates: unknown[]; known: unknown[]; refused: unknown[] };

// A raw caller of policy.write_typed_claims, as pi_reader under the client's token, in one read
// committed transaction: its own session and finding (or, with `earlier`, a finding of an earlier
// call), then the two calls the store makes, with claims it builds itself, each sealed as a valid
// claim record of origin `origin` (agent_record unless given).
type Raw = {
  type?: string;
  subject: string;
  factKeyFp: string;
  valueFp: string;
  matchFps?: string[];
  origin?: "source" | "agent_record";
  assertedBy?: string;
};
let rawSerial = 0;
async function rawWrite(
  token: string,
  claims: Raw[],
  options: { earlier?: { recordId: string; session: string } } = {},
): Promise<{ reply: unknown; recordId: string; claimIds: string[] }> {
  rawSerial += 1;
  const serialNow = rawSerial;
  return readAs(store.db, token, async (query) => {
    let session: string;
    let recordId: string;
    if (options.earlier !== undefined) {
      ({ session, recordId } = options.earlier);
    } else {
      session = newId("ses");
      await query("select policy.open_session($1)", [session]);
      const [labelled] = await query<{ label: string[] }>("select policy.record_label() as label");
      const label = labelled?.label ?? [];
      recordId = newId("rec");
      const [appended] = await query<{ outcome: string }>(
        "select outcome from policy.append_record($1, $2, $3, 'finding', $4, $5, '{}', $6, $7, '{}', null)",
        [
          session,
          recordId,
          `typed-raw-${serialNow}`,
          sha256(`content ${serialNow}`),
          sha256(`cites ${serialNow}`),
          label,
          sealUnder(
            store.db.keys,
            label,
            { table: "ledger.agent_writes", id: recordId, column: "body_enc" },
            "A raw finding.",
          ),
        ],
      );
      expect(appended?.outcome).toBe("ok");
    }
    const [first] = await query<{ reply: { account: string; client: string; recordedAt: string; label: string[] } }>(
      "select policy.write_typed_claims($1, $2, null, null) as reply",
      [session, recordId],
    );
    const prepared = first?.reply;
    if (prepared === undefined) throw new Error("no account");
    const label = prepared.label;
    const source = {
      vault: "personal" as const,
      sourceAccount: SourceAccountId.parse(prepared.account),
      sourceItemId: `record:${recordId}`,
    };
    const evidenceId = evidenceIdFor({ ...source, revision: 0 });
    const blobRef = newId("blb");
    const item = {
      recordId,
      client: prepared.client,
      session,
      kind: "finding",
      recordedAt: new Date(prepared.recordedAt).toISOString(),
      cites: [],
    };
    const evidence = {
      id: evidenceId,
      blobRef,
      blob: sealUnder(
        store.db.keys,
        label,
        { table: "vault.evidence_blobs", id: blobRef, column: "envelope" },
        Buffer.from("A raw finding.", "utf8").toString("base64"),
      ),
      item: sealUnder(
        store.db.keys,
        label,
        { table: "vault.evidence_items", id: evidenceId, column: "item_enc" },
        JSON.stringify(item),
      ),
      sourceItemFp: sha256(`source ${serialNow}`),
      revisionTagFp: sha256(`tag ${serialNow}`),
      nextRevisionId: evidenceIdFor({ ...source, revision: 1 }),
      readers: [THE_OWNER],
    };
    const built = claims.map((one, index) => {
      const id = sha256(`raw claim ${serialNow} ${index}`);
      const type = one.type ?? "role";
      const fields = { title: "raw title", organization_name: "Raw Labs" };
      const record = {
        claim: {
          id,
          content: { type, subject: one.subject, fields },
          statementKind: "stated_fact",
          basis: "third_party",
          ...(one.assertedBy === undefined ? {} : { assertedBy: one.assertedBy }),
          validFrom: NOW.toISOString(),
          evidence: [{ evidenceId, span: "chars:0-3" }],
          primaryEvidenceId: evidenceId,
          label: { compartments: label, readers: [THE_OWNER] },
          destination: "personal",
          pipelineVersion: "personal-typed-claim-1",
          extractorGeneration: 5,
          changeKind: "live",
          systemOriginated: false,
          origin: "source",
          identityEpoch: 0,
        },
        subjectKind: "person",
        disclosure: [],
        factKey: `raw ${serialNow} ${index}`,
        lane: "agent",
        fieldKinds: { title: "text", organization_name: "text" },
        entities: [one.subject],
        origin: one.origin ?? "agent_record",
        answersSystem: false,
      };
      return {
        index,
        id,
        type,
        subject: one.subject,
        entities: [],
        validFrom: NOW.toISOString(),
        validTo: null,
        dueAt: null,
        reviewAt: null,
        factKeyFp: one.factKeyFp,
        matchFps: one.matchFps ?? [one.factKeyFp],
        valueFp: one.valueFp,
        claimKeys: [sha256(`raw key ${serialNow} ${index}`)],
        cites: [],
        generation: 5,
        content: sealUnder(
          store.db.keys,
          label,
          { table: "knowledge.claims", id, column: "content_enc" },
          JSON.stringify(record),
        ),
      };
    });
    const [second] = await query<{ reply: unknown }>("select policy.write_typed_claims($1, $2, $3, $4) as reply", [
      session,
      recordId,
      evidence,
      { claims: built, refused: [] },
    ]);
    return { reply: second?.reply, recordId, claimIds: built.map((one) => one.id) };
  });
}
