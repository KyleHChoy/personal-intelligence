import { randomBytes } from "node:crypto";
import type { Claim, EvidenceId } from "@intelligence/contracts";
import {
  type BlockItem,
  type CaptureItem,
  CaptureScopeRule,
  type ClaimRecord,
  type FactList,
  MIRROR_QUOTA,
  type MomentItem,
  QUOTA_DEFAULTS,
} from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipeline, type Pipeline } from "../pipeline/pipeline.ts";
import { connect } from "../test-support/cast.ts";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { type Client, insertReader } from "../test-support/commitment-fixtures.ts";
import { queryAs } from "../test-support/database.ts";
import { batchOf } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue, refusedWith } from "../test-support/values.ts";

// A scope rule marked agent_app. Its moments are stored as agent output, labelled with the rule's
// compartment and the clearance of the client the owner names for the app; their claims are in no
// belief and are served as an agent's; the moment lane takes them again only with their own switch.
// A block it admits keeps the rule's compartment. Each guard has its control: the same items from a
// rule that is no agent app's. Reserved domains and test bundles only; no model is called.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
const local = (offset: number): string => `${new Date(T + offset - 5 * HOUR).toISOString().slice(0, 19)}-05:00`;
const AGENT_APP = "test.example.agent";
const MAIL_APP = "test.example.mail";
const DESK = ["agent:desk", "employer:example", "own"];
const TOOLS = ["get_self", "search", "get_entity", "find_facts"];
const VIEWS = ["self", "people", "work"];
const LINE = "Ship the rota by Friday, the agent wrote.";

const moment = (n: number, bundle: string): MomentItem => ({
  kind: "moment",
  key: `moment:01JR${String(n).padStart(22, "0")}`,
  revision: 0,
  observedAt: local(-3 * HOUR + n * MINUTE),
  endedAt: local(-3 * HOUR + n * MINUTE + 30_000),
  app: { bundle, name: bundle === AGENT_APP ? "Agent" : "Mail" },
  window: "Planning",
  entity: "chat",
  thread: "Planning",
  participants: [],
  text: `${LINE} We went back and forth about the venue, the timings and who brings the projector, and left the rest for the call next week.`,
  read: "ax",
});
const DAY: BlockItem = {
  kind: "block",
  key: "block:01JR000000000000000000009B",
  revision: 0,
  day: local(-26 * HOUR).slice(0, 10),
  blocks: [
    {
      start: local(-26 * HOUR),
      end: local(-26 * HOUR + 20 * MINUTE),
      minutes: 20,
      app: { bundle: AGENT_APP, name: "Agent" },
      title: "Planning",
    },
    {
      start: local(-25 * HOUR),
      end: local(-25 * HOUR + 10 * MINUTE),
      minutes: 10,
      app: { bundle: MAIL_APP, name: "Mail" },
      title: "Inbox",
    },
  ],
};
const AGENT_MOMENT = moment(1, AGENT_APP);
const MAIL_MOMENT = moment(2, MAIL_APP);

type Row = { id: string; evidence_id: EvidenceId; compartments: string[]; agent_app: boolean; kind: string };
let store: TestStore;
let pipeline: Pipeline;
let desk: Client;
let rows: Map<string, Row>;
let owner: string;

// A device as `pi lens add mac` makes it, by hand; its capture token.
async function addDevice(): Promise<string> {
  const capture = { id: testId("cli"), token: `pit_test-mac-capture-${randomBytes(8).toString("hex")}` };
  const mirror = testId("cli");
  const quota = (q: typeof MIRROR_QUOTA) => [q.maxItemsDay, q.maxCharsDay, q.maxRowsDay, q.maxCallsMinute];
  const insert = `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind, id_mode, max_items_day, max_chars_day, max_rows_day, max_calls_minute)
    values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, $7, 'stable', $8, $9, $10, $11)`;
  await queryAs(store.db.urls.admin, insert, [
    capture.id,
    "mac-capture",
    sha256Hex(capture.token),
    ["own"],
    ["self"],
    ["push_capture"],
    "device",
    ...quota(QUOTA_DEFAULTS.device),
  ]);
  await queryAs(store.db.urls.admin, insert, [
    mirror,
    "mac",
    sha256Hex(`pit_test-mac-${randomBytes(8).toString("hex")}`),
    ["own"],
    VIEWS,
    ["sync_mirror"],
    "agent",
    ...quota(MIRROR_QUOTA),
  ]);
  await queryAs(
    store.db.urls.admin,
    "insert into policy.lens_devices (name, capture_client_id, mirror_client_id) values ('mac', $1, $2)",
    [capture.id, mirror],
  );
  for (const [connector, kind] of [
    ["lens_meetings", "transcript"],
    ["lens_activity", "screen_activity"],
    ["lens_blocks", "time_block"],
  ] as const) {
    await queryAs(
      store.db.urls.admin,
      "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, 'device:mac', $2, $3, '{own}')",
      [testId("acc"), connector, kind],
    );
  }
  return capture.token;
}

// A commitment the owner states, on a moment's evidence, as a lane would commit one: a type that
// builds a belief, about the owner, their own word. `nobody`: the same claim credited
// to nobody, as the moment lane credits an agent's line.
function stated(evidence: string, n: number, nobody = false): ClaimRecord {
  const claim = {
    id: `${evidence.slice(0, 60)}000${n}`,
    content: { type: "commitment", subject: owner, fields: { what: LINE } },
    statementKind: "stated_fact",
    basis: "explicit_self",
    ...(nobody ? {} : { assertedBy: owner }),
    validFrom: new Date(T - 3 * HOUR).toISOString(),
    evidence: [{ evidenceId: evidence, span: "seg:0-40" }],
    primaryEvidenceId: evidence,
    label: { compartments: rows.get(evidence)?.compartments ?? [], readers: ["m-owner"] },
    destination: "personal",
    pipelineVersion: "1",
    extractorGeneration: 1,
    changeKind: "live",
    systemOriginated: false,
    origin: "source",
    identityEpoch: 0,
  } as unknown as Claim;
  return {
    claim,
    subjectKind: "owner",
    disclosure: [],
    factKey: `0123 commitment ${evidence} ${n}`,
    lane: "moment",
    fieldKinds: { what: "text" },
    entities: [],
    origin: "source",
    answersSystem: false,
  } as unknown as ClaimRecord;
}

beforeAll(async () => {
  store = await openStore({ compartments: ["own", "employer:example", "agent:desk"] });
  // The owner's accounts, so the owner entity exists.
  await connect(store.writer);
  desk = await insertReader(store, "desk", DESK, { tools: TOOLS, views: VIEWS });
  const token = await addDevice();
  await store.admin.lens.addScope({
    match: "bundle",
    value: AGENT_APP,
    compartment: "own",
    kinds: ["moment", "block"],
    agentApp: true,
    client: "desk",
  });
  await store.admin.lens.addScope({ match: "bundle", value: MAIL_APP, compartment: "own", kinds: ["moment", "block"] });
  const answer = await store.reader.pushCapture(token, {
    batch: "lens-trust-0001",
    items: [AGENT_MOMENT, MAIL_MOMENT, DAY] as CaptureItem[],
  });
  expect(answer.ok).toBe(true);
  expect(await store.writer.takeCapture()).toMatchObject({ failed: 0, waiting: 0 });
  const found = await queryAs<Row & { capture_key: string }>(
    store.db.urls.admin,
    "select id, evidence_id, compartments, agent_app, kind, capture_key from knowledge.captures order by capture_key, id",
  );
  rows = new Map(found.map((row) => [row.kind === "block" ? row.capture_key : row.capture_key, row]));
  for (const row of found) rows.set(row.evidence_id, row);
  owner =
    (await queryAs<{ id: string }>(store.db.urls.admin, "select id from knowledge.entities where kind = 'owner'"))[0]
      ?.id ?? "";
  expect(owner).toMatch(/^ent_/);
  pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await pipeline?.close();
  await store?.close();
}, SLOW_DB_TEST_TIMEOUT);

const rowOf = (key: string): Row => {
  const row = rows.get(key);
  if (row === undefined) throw new Error(`no capture row for ${key}`);
  return row;
};

describe("an agent-app scope rule", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("is listed with its flag and client; it admits no meeting, names a client only with the flag, and only an active agent's", async () => {
    const listed = (await store.admin.lens.scope()).map((rule) => CaptureScopeRule.parse(rule));
    expect(listed.find((rule) => rule.agentApp)).toMatchObject({
      match: "bundle",
      compartment: "own",
      kinds: ["moment", "block"],
      client: desk.id,
    });
    expect(listed.find((rule) => !rule.agentApp)).toMatchObject({ client: null });
    const refused = (rule: Parameters<TestStore["admin"]["lens"]["addScope"]>[0]) =>
      refusedWith(() => store.admin.lens.addScope(rule));
    const base = {
      match: "host" as const,
      value: "chat.example.net",
      compartment: "own" as const,
      kinds: ["moment" as const],
    };
    expect(await refused({ ...base, kinds: ["moment", "meeting"], agentApp: true })).toEqual({
      name: "AdminError",
      code: "agent_app_meeting",
    });
    expect(await refused({ ...base, client: "desk" })).toEqual({ name: "AdminError", code: "invalid_argument" });
    expect(await refused({ ...base, agentApp: true, client: "absent" })).toEqual({
      name: "AdminError",
      code: "not_found",
    });
    // A device's client is no agent's.
    expect(await refused({ ...base, agentApp: true, client: "mac-capture" })).toEqual({
      name: "AdminError",
      code: "not_found",
    });
    // The database refuses a meeting kind on an agent-app rule, and a client on a plain one, whoever writes it.
    for (const sql of [
      "update policy.capture_scope set kinds = '{moment,meeting}' where agent_app",
      "update policy.capture_scope set client_id = (select id from policy.clients where name = 'desk') where not agent_app",
    ]) {
      await expect(queryAs(store.db.urls.admin, sql)).rejects.toMatchObject({ code: "23514" });
    }
    // The control: the same host as an agent app with no client, and with the flag alone.
    expect(await store.admin.lens.addScope({ ...base, agentApp: true })).toMatch(/^csr_/);
  });
});

describe("the drain labels an agent app's moment with its client's clearance", {
  timeout: SLOW_DB_TEST_TIMEOUT,
}, () => {
  it("the agent app's moment is flagged and labelled own joined with desk's clearance; the mail app's is own and unflagged", () => {
    expect(rowOf(AGENT_MOMENT.key)).toMatchObject({ agent_app: true, compartments: DESK });
    expect(rowOf(MAIL_MOMENT.key)).toMatchObject({ agent_app: false, compartments: ["own"] });
  });

  it("a block the agent-app rule admits keeps the rule's compartment and no flag", async () => {
    const blocks = await queryAs<{ compartments: string[]; agent_app: boolean }>(
      store.db.urls.admin,
      "select compartments, agent_app from knowledge.captures where kind = 'block'",
    );
    expect(blocks).toEqual([{ compartments: ["own"], agent_app: false }]);
  });

  it("the evidence row carries the same label, and the database refuses the flag on any row that is no moment", async () => {
    const [evidence] = await queryAs<{ compartments: string[] }>(
      store.db.urls.admin,
      "select compartments from vault.evidence_items where id = $1",
      [rowOf(AGENT_MOMENT.key).evidence_id],
    );
    expect(evidence?.compartments).toEqual(DESK);
    await expect(
      queryAs(store.db.urls.admin, "update knowledge.captures set agent_app = true where kind = 'block'"),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("an agent app's claims are agent output", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  // The agent app's moment holds two claims: one credited to nobody (an agent's line)
  // and one credited to the owner (their own prompt line); the mail app's, the owner's.
  const AGENT_LINE = 1;
  const OWNER_LINE = 3;
  beforeAll(async () => {
    const agent = rowOf(AGENT_MOMENT.key).evidence_id;
    const mail = rowOf(MAIL_MOMENT.key).evidence_id;
    expect(
      await pipeline.commit(
        batchOf(agent, [stated(agent, AGENT_LINE, true), stated(agent, OWNER_LINE)], { lane: "moment" } as never),
      ),
    ).toBe("committed");
    expect(await pipeline.commit(batchOf(mail, [stated(mail, 2)], { lane: "moment" } as never))).toBe("committed");
  }, SLOW_DB_TEST_TIMEOUT);

  it("an agent app's moment's claim credited to nobody is in no belief's input, whatever its basis; the owner's own line from it is; the mail app's claim is", async () => {
    const given = (await pipeline.beliefClaims()).flatMap((group) => group.claims.map((one) => one.claim.id as string));
    const agent = rowOf(AGENT_MOMENT.key).evidence_id;
    expect(given).toContain(stated(rowOf(MAIL_MOMENT.key).evidence_id, 2).claim.id);
    expect(given).not.toContain(stated(agent, AGENT_LINE, true).claim.id);
    expect(given).toContain(stated(agent, OWNER_LINE).claim.id);
  });

  it("find_facts serves the agent's as an agent's, agent_inferred and agent-reported; the owner's own line and the mail app's as a source's", async () => {
    const answer: FactList = outcomeValue(await store.reader.findFacts(desk.token, { type: "commitment" }));
    const agent = rowOf(AGENT_MOMENT.key);
    const agents = answer.facts.filter((one) => one.capture === agent.id);
    const mail = answer.facts.find((one) => one.capture === rowOf(MAIL_MOMENT.key).id);
    expect(agents).toHaveLength(2);
    const nobody = agents.find((one) => one.statedBy === null);
    const his = agents.find((one) => one.statedBy !== null);
    expect(nobody).toMatchObject({ tier: "agent_inferred", agentReported: true, provenance: "agent_reported" });
    expect(his).toMatchObject({ agentReported: false, provenance: "source" });
    expect(his?.tier).not.toBe("agent_inferred");
    expect(mail).toMatchObject({ agentReported: false, provenance: "source" });
    expect(mail?.tier).not.toBe("agent_inferred");
  });

  it("pi status counts the device's moment claims of the owner's own word, and not one credited to nobody", async () => {
    const [view] = (await store.admin.lens.devices()).filter((one) => one.name === "mac");
    // The owner's prompt line and the mail app's claim, both explicit_self and credited to the owner;
    // the agent's line, explicit_self too but credited to nobody, is left out.
    const his = [
      stated(rowOf(AGENT_MOMENT.key).evidence_id, OWNER_LINE),
      stated(rowOf(MAIL_MOMENT.key).evidence_id, 2),
    ];
    expect(view?.ownWords.reduce((sum, one) => sum + one.count, 0)).toBe(his.length);
  });

  it("a client not cleared for desk's clearance never sees the agent app's moment", async () => {
    const narrow = await insertReader(store, "narrow", ["own"], { tools: TOOLS, views: VIEWS });
    const answer: FactList = outcomeValue(await store.reader.findFacts(narrow.token, { type: "commitment" }));
    expect(answer.facts.map((one) => one.capture)).not.toContain(rowOf(AGENT_MOMENT.key).id);
    expect(answer.facts.map((one) => one.capture)).toContain(rowOf(MAIL_MOMENT.key).id);
  });
});

describe("a moment committed not_extracted is due again once the lane is on, an agent app's too", {
  timeout: SLOW_DB_TEST_TIMEOUT,
}, () => {
  it("committed not_extracted, the agent app's moment and the mail app's are both due with the lane on, and neither with it off", async () => {
    for (const key of [AGENT_MOMENT.key, MAIL_MOMENT.key]) {
      expect(
        await pipeline.commit(
          batchOf(rowOf(key).evidence_id, [], {
            lane: "moment",
            status: "skipped",
            code: "not_extracted",
            generation: 1,
          } as never),
        ),
      ).toBe("committed");
    }
    const due = async (switchedOn: boolean): Promise<string[]> =>
      (
        await pipeline.dueCaptures("moment", 100, 1, {
          switchedOn,
          settledBefore: new Date(T + HOUR).toISOString() as never,
        })
      ).flatMap((group) => (group.moments ?? []).map((one) => one.evidenceId as string));
    expect(await due(true)).toEqual(
      expect.arrayContaining([rowOf(MAIL_MOMENT.key).evidence_id, rowOf(AGENT_MOMENT.key).evidence_id]),
    );
    const off = await due(false);
    expect(off).not.toContain(rowOf(MAIL_MOMENT.key).evidence_id);
    expect(off).not.toContain(rowOf(AGENT_MOMENT.key).evidence_id);
  });
});
