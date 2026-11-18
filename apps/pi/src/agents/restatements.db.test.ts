import type { CardId, PersonalTool, PersonalView } from "@intelligence/contracts/personal";
import type { ExtractDeps } from "@intelligence/personal-extract";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import {
  type Admin,
  addCompartmentKey,
  createAdmin,
  createReader,
  createWriter,
  type Keys,
  loadKeys,
  type Reader,
} from "@intelligence/personal-store";
import { queryAs } from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pi, type Result, type Synced, syncedWorld } from "../test-support/extract-fixtures.ts";
import { refused } from "../test-support/run-pi.ts";

type ModelClient = ExtractDeps["model"];

// The owner's list and clear of restatement marks, through the real `pi`, on the synthetic world's
// personal mailbox. A finding is extracted, confirmed, and restated by a second finding whose session read
// it; `pi extract` marks the second an echo, and the owner clears the mark.

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const NORA = "nora.vance@example.org";
const TOOLS: PersonalTool[] = ["get_self", "find_facts", "record"];
const VIEWS: PersonalView[] = ["self", "people", "work"];

let s: Synced;
let keys: Keys;
let admin: Admin;
let reader: Reader;
let alpha: string;
let owner: string;
let written = 0;
const outputs: Record<string, unknown> = {};
const calls: string[] = [];

const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const mention = (address: string, at: string) => ({ key: { kind: "address", value: address }, observedAt: at });
const DUE = inDays(4);

const extract = (model: ModelClient = fakeModelClient({ ...s.outputs, ...outputs }, calls)): Promise<Result> =>
  pi(["extract"], s.pipeline, { deps: { model } });

// A finding by alpha, taken in, with the output the model is recorded to give for it.
async function finding(body: string): Promise<{ record: string; evidence: string }> {
  written += 1;
  const recorded = await reader.record(alpha, {
    kind: "finding",
    body,
    requestId: `restated-${String(written).padStart(8, "0")}`,
  });
  if (!recorded.ok) throw new Error(`record answered ${recorded.code}`);
  const writer = createWriter({ url: s.db.urls.writer, keys, log: { info() {}, warn() {}, error() {} } });
  try {
    await writer.takeRecords();
  } finally {
    await writer.close();
  }
  const [row] = await queryAs<{ evidence_id: string; created_at: Date }>(
    s.db.urls.admin,
    "select evidence_id, created_at from ledger.agent_writes where id = $1",
    [recorded.value.recordId],
  );
  if (row === undefined) throw new Error("not taken in");
  const at = row.created_at.toISOString();
  outputs[row.evidence_id] = {
    claims: [
      {
        type: "commitment",
        subject: mention(NORA, at),
        fields: { counterparty: mention(owner, at), what: body, due: DUE },
        statementKind: "stated_fact",
        basis: "explicit_self",
        span: `chars:0-${body.length}`,
      },
    ],
    narrowing: "none",
  };
  return { record: recorded.value.recordId, evidence: row.evidence_id };
}

// A read log row of the record's session, a minute before it was written, as policy.log_read
// writes one, by the table's owner: the session read these fact keys. One simple-protocol call,
// so the role holds for the insert; the values are an id and fingerprints, checked first.
async function read(record: string, factKeyFps: string[]): Promise<void> {
  if (!/^rec_[0-9A-Z]{26}$/.test(record) || !factKeyFps.every((fp) => /^[0-9a-f]{64}$/.test(fp)))
    throw new Error("not an id or a fingerprint");
  await queryAs(
    s.db.urls.bootstrap,
    `begin; set local role pi_owner;
     insert into ledger.read_log (session_id, client_id, tool, read_at, compartments, bound, shown, fact_key_fps)
     select w.session_id, w.client_id, 'find_facts', w.created_at - interval '1 minute', w.compartments, '{}', '{}', array[${factKeyFps.map((fp) => `'${fp}'`).join(",")}]::text[]
     from ledger.agent_writes w where w.id = '${record}';
     commit;`,
  );
}

const marks = () =>
  queryAs<{ id: number; record_id: string; answer: string; cleared_at: Date | null; cleared_by: string | null }>(
    s.db.urls.admin,
    "select id::int as id, record_id, answer, cleared_at, cleared_by from ledger.restatement_checks order by id",
  );
const cardsOf = (evidence: string) =>
  queryAs<{ id: CardId }>(
    s.db.urls.admin,
    "select c.id from ledger.cards c join knowledge.claims k on k.id = c.target_id where c.kind = 'agent_claim' and k.evidence_id = $1",
    [evidence],
  );

let first: { record: string; evidence: string };
let second: { record: string; evidence: string };

beforeAll(async () => {
  s = await syncedWorld({ labels: ["personal"] });
  await addCompartmentKey(s.admin.PI_KEY_FILE ?? "", "agent:alpha");
  keys = await loadKeys(s.admin.PI_KEY_FILE ?? "");
  admin = createAdmin({ url: s.db.urls.admin, keys, log: { info() {}, warn() {}, error() {} }, recordEnabled: true });
  reader = createReader({ url: s.db.urls.reader, keys, log: { info() {}, warn() {}, error() {} } });
  alpha = (
    await admin.clients.addClient({
      name: "alpha",
      runtime: "local",
      vendorRetention: "none",
      compartments: ["own"],
      views: VIEWS,
      tools: TOOLS,
    })
  ).token;
  owner = s.w.accounts.find((one) => one.label === "personal")?.address ?? "";

  // The first finding, extracted with the world's mail, and its card confirmed.
  const body = `${NORA} will send ${owner} the signed lease by Friday.`;
  first = await finding(body);
  expect((await extract()).exit).toBe(0);
  const [card] = await cardsOf(first.evidence);
  await admin.cards.decide({ cards: [card?.id as CardId], answer: "confirm", requestId: "restated-confirm-0001" });

  // The second restates it, after its session read the first's fact key.
  second = await finding(body);
  const [claim] = await queryAs<{ fact_key_fp: string }>(
    s.db.urls.admin,
    "select fact_key_fp from knowledge.claims where evidence_id = $1",
    [first.evidence],
  );
  await read(second.record, [claim?.fact_key_fp ?? ""]);
  expect((await extract()).exit).toBe(0);
});

afterAll(async () => {
  await reader?.close();
  await admin?.close();
  await s?.drop();
});

describe("pi restatements", () => {
  it("pi extract marks the restating finding an echo and raises no card for it; the first is new", async () => {
    expect((await marks()).map((row) => [row.record_id, row.answer])).toEqual([
      [first.record, "new"],
      [second.record, "echo"],
    ]);
    expect(await cardsOf(second.evidence)).toEqual([]);
  });

  it("list prints ids, names, answers and times only", async () => {
    const listed = await pi(["restatements", "list"], s.admin);
    expect(listed).toMatchObject({ exit: 0, stderr: "" });
    const rows = JSON.parse(listed.stdout) as Record<string, unknown>[];
    expect(rows.map((row) => Object.keys(row).sort())).toEqual(
      Array(2).fill(["answer", "checkedAt", "claimKeyPrefix", "clearedAt", "client", "id", "reached", "recordId"]),
    );
    expect(rows.map((row) => [row.recordId, row.client, row.answer, row.reached])).toEqual([
      [second.record, "alpha", "echo", "read"],
      [first.record, "alpha", "new", null],
    ]);
    for (const text of [NORA, owner, "lease"]) expect(listed.stdout).not.toContain(text);
    expect(
      JSON.parse((await pi(["restatements", "list", "--answer", "new", "--limit", "5"], s.admin)).stdout),
    ).toHaveLength(1);
    expect(JSON.parse((await pi(["restatements", "list", "--client", "nobody"], s.admin)).stdout)).toEqual([]);
  });

  it("no pi_reader statement reads ledger.restatement_checks", async () => {
    await expect(queryAs(s.db.urls.reader, "select count(*) from ledger.restatement_checks")).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("clear writes a decision, and the next pi extract raises the held card with no model request; a second clear exits 1 with already_cleared", async () => {
    const mark = (await marks()).find((row) => row.record_id === second.record);
    const cleared = await pi(["restatements", "clear", String(mark?.id)], s.admin);
    expect(cleared).toMatchObject({ exit: 0, stderr: "" });
    const { decision } = JSON.parse(cleared.stdout) as { cleared: number; decision: string };
    expect(JSON.parse(cleared.stdout)).toEqual({ cleared: mark?.id, decision: expect.stringMatching(/^rul_/) });
    expect(
      await queryAs(
        s.db.urls.admin,
        "select kind, target_kind, target_id from knowledge.owner_decisions where id = $1",
        [decision],
      ),
    ).toEqual([{ kind: "restatement_clear", target_kind: "agent_record", target_id: second.record }]);
    expect((await marks()).find((row) => row.record_id === second.record)?.cleared_by).toBe(decision);

    const asked: string[] = [];
    const refusing: ModelClient = {
      complete: async (request) => {
        asked.push(request.callKey?.evidenceId ?? "");
        throw new Error("no model request was expected");
      },
      embed: async () => {
        throw new Error("no model request was expected");
      },
    };
    expect((await extract(refusing)).exit).toBe(0);
    expect(asked).toEqual([]);
    expect(await cardsOf(second.evidence)).toHaveLength(1);
    // The mark stays, cleared; nothing is marked again.
    expect((await marks()).map((row) => [row.record_id, row.answer, row.cleared_by !== null])).toEqual([
      [first.record, "new", false],
      [second.record, "echo", true],
    ]);

    expect(await pi(["restatements", "clear", String(mark?.id)], s.admin)).toEqual(refused("already_cleared"));
  });

  it("clear of a mark whose agent record has no body, or of no mark, exits 1 with not_found", async () => {
    const mark = (await marks()).find((row) => row.record_id === first.record);
    expect((await pi(["agent-records", "rm", first.record], s.admin)).exit).toBe(0);
    expect(await pi(["restatements", "clear", String(mark?.id)], s.admin)).toEqual(refused("not_found"));
    expect(await pi(["restatements", "clear", "999999"], s.admin)).toEqual(refused("not_found"));
    expect((await marks()).find((row) => row.record_id === first.record)?.cleared_at).toBeNull();
  });
});
