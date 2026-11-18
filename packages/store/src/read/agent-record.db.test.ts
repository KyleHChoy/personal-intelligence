import { AGENT_RECORD_SAY, AgentRecords, ContextPack } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { setTaskTier } from "../admin/admin-tasks.ts";
import { request, testId } from "../test-support/clients.ts";
import { readAs, session } from "../test-support/connections.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { TASK_AGENT_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";

// An agent's own record: ledger.agent_records_within for the owner, ledger.my_agent_record for the
// agent within its clearance, the System room's read and the bootstrap pack's record section.
// Synthetic rows only.

const LABELS = ["own", "agent:scout", "agent:wren", "work"];
const TOOLS = [...TASK_AGENT_TOOLS, "build_context_pack"];
const MINUTE = 60_000;

const agent = async (w: WorkWorld, name: string): Promise<WorkClient> => {
  const client = await w.client(name, ["own", `agent:${name}`], { tools: TOOLS });
  await w.harness(client, "investigate", "investigate");
  return client;
};

// A task about a person, proposed by the client; with `done`, worked and reported done now.
async function task(w: WorkWorld, client: WorkClient, done: boolean): Promise<{ opportunity: string; person: string }> {
  const person = await w.seed.entity("person");
  await w.seed.account(["own"], person);
  const message = await w.message(["own"]);
  await w.seed.pipelineItem(["own"], message.evidence);
  await w.admin(
    "update vault.pipeline_items set waiting = false, withheld = false, screened = true where evidence_id = $1",
    [message.evidence],
  );
  const { opportunity } = ok(
    await w.work.proposeTask(client.token, {
      kind: "investigate",
      about: { kind: "entity", id: person as never },
      summary: "find who runs the clinic",
      basis: [{ kind: "message", id: message.id as never }],
      requestId: request(),
    }),
  );
  if (done) {
    ok(await w.work.claimOpportunity(client.token, { id: opportunity as never, requestId: request() }));
    const { move } = ok(
      await w.work.planMove(client.token, {
        opportunity: opportunity as never,
        stage: "investigate",
        requestId: request(),
      }),
    );
    const record = ok(
      await w.reader.record(client.token, { kind: "finding", body: "two founders run it", requestId: request() }),
    ).recordId;
    ok(
      await w.work.reportMove(client.token, {
        move,
        outcome: "done",
        summary: "two founders",
        report: { deliverable: "two names", next: "nothing", sources: [{ kind: "agent_record", id: record as never }] },
        requestId: request(),
      }),
    );
  }
  return { opportunity, person };
}

// One statement as pi_owner, the table's owner, past its forced row security and its triggers.
const owned = (w: WorkWorld, text: string, values: unknown[]): Promise<unknown> =>
  session(w.db.urls.bootstrap, async (query) => {
    const table = /^\s*(?:insert into|update) (\S+)/.exec(text)?.[1];
    await query("set role pi_owner");
    await query(`alter table ${table} no force row level security`);
    await query(`alter table ${table} disable trigger user`);
    try {
      await query(text, values);
    } finally {
      await query(`alter table ${table} enable trigger user`);
      await query(`alter table ${table} force row level security`);
    }
  });

// A piece of the client's work that is no task: an owner's no_go on it is a decline, not a cancel.
async function proposal(w: WorkWorld, client: WorkClient): Promise<string> {
  const { opportunity } = await task(w, client, false);
  await owned(w, "update ledger.opportunities set tier = 'opportunity', role = null where id = $1", [opportunity]);
  return opportunity;
}

// An owner's event on one of the client's opportunities, `minutes` ago, with a decline code.
const ownerEvent = (w: WorkWorld, opportunity: string, event: string, minutes: number, code: string | null = null) =>
  owned(
    w,
    `insert into ledger.record_events (row_kind, row_id, event, at, by, code, compartments)
     select 'opportunity', o.id, $2, now() - make_interval(mins => $3), 'owner', $4, o.compartments
     from ledger.opportunities o where o.id = $1`,
    [opportunity, event, minutes, code],
  );

// A card raised by `by` (or about `target`) an hour ago, ending as `ending` says: answered by the
// owner, decided with no answer of the owner's, settled by another agent, or still waiting. The
// owner's decision's id when answered.
async function card(
  w: WorkWorld,
  by: string,
  ending: { answer: string } | "decided" | "by_agent" | "waiting",
  options: { target?: string; compartments?: string[]; tainted?: boolean; reopened?: boolean } = {},
): Promise<string | null> {
  const id = testId("crd");
  const label = options.compartments ?? ["own"];
  await session(w.db.urls.work, (query) =>
    query(
      `insert into ledger.cards (id, request_id, created_at, created_by, kind, target_kind, target_id, options, tainted_at, compartments)
       values ($1, $1, now() - interval '1 hour', $2, 'opportunity_decision', $3, $4, '{go,no_go,later}', $5, $6)`,
      [
        id,
        by,
        options.target === undefined ? null : "opportunity",
        options.target ?? null,
        options.tainted === true ? new Date() : null,
        label,
      ],
    ),
  );
  if (ending === "waiting") return null;
  const event =
    ending === "by_agent"
      ? ["withdrawn", "system:agent_attempt", "agent_go"]
      : typeof ending === "object" && ending.answer === "later"
        ? ["deferred", "owner", null]
        : ["decided", "owner", null];
  await owned(
    w,
    "insert into ledger.record_events (row_kind, row_id, event, at, by, code, compartments) values ('card', $1, $2, now() - interval '30 minutes', $3, $4, $5)",
    [id, ...event, label],
  );
  if (typeof ending !== "object") return null;
  const decision = testId("rul");
  await w.admin(
    `insert into knowledge.owner_decisions (id, request_id, kind, answer, card_id, queue_depth, labels, details, decided_at, compartments)
     values ($1, $2, 'answer', $3, $4, 0, '{}', '{}', now() - interval '30 minutes', $5)`,
    [decision, testId("req"), ending.answer, id, label],
  );
  // The owner reopened it since (`pi cards reopen`): back in the queue.
  if (options.reopened === true)
    await owned(
      w,
      "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'pending', now() - interval '10 minutes', 'owner', $2)",
      [id, label],
    );
  return decision;
}

const call = (w: WorkWorld, client: WorkClient, outcome: string, ago = "1 hour") =>
  owned(
    w,
    "insert into policy.calls (client_id, tool, at, rows, outcome) values ($1, 'search', now() - $2::interval, 0, $3)",
    [client.id, ago, outcome],
  );

const ROW = `r.done, r.used, r.raised, r.yes, r.no, r.deferred, r.by_agent, r.waiting, r.other, r.no_codes,
  r.overturned, r.refused`;

describe("an agent's own record", { timeout: DB_TEST_TIMEOUT }, () => {
  it("counts each agent's work and use, each question its work put to the owner once by how it ended, the reasons for the noes still in force, taken-back relays and refused calls; an agent reads its own alone, within its clearance; the pack and the System room serve it", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      const wren = await agent(w, "wren");
      const quiet = await agent(w, "quiet");
      const { person } = await task(w, scout, true);
      // The owner writes to the task's person a minute on: the task is used from then.
      await w.admin(
        `insert into knowledge.interaction_log (id, evidence_id, member_id, entity_id, direction, channel, occurred_at, entity_role, compartments, readers)
         values ($1, (select id from vault.evidence_items limit 1), 'owner', $2, 'outbound', 'email', $3, 'recipient', '{own}', '{}')`,
        [testId("itr"), person, new Date(Date.now() + MINUTE)],
      );
      // Scout's proposal the owner said no to on the card that asked: one no, its reason a reason only.
      const declined = await proposal(w, scout);
      await card(w, "system:work", { answer: "no_go" }, { target: declined });
      await ownerEvent(w, declined, "no_go", 30, "wrong_timing");
      // A no_go the owner has since reopened, and a cancelled task, each a no on its card: no reason of
      // either is told.
      const reopened = await proposal(w, scout);
      await card(w, "system:work", { answer: "no_go" }, { target: reopened });
      await ownerEvent(w, reopened, "no_go", 50, "not_worth_it");
      await ownerEvent(w, reopened, "go", 40);
      const { opportunity: cancelled } = await task(w, scout, false);
      await card(w, "system:work", { answer: "no_go" }, { target: cancelled });
      await ownerEvent(w, cancelled, "no_go", 30, "already_handled");
      // Cards scout raised: a yes; a no under a label scout cannot see; a not_now, a decline and a wrong, each a no; a
      // later, which is deferred; one another agent settled; one waiting; one reopened after a no; one decided with no answer
      // of the owner's; one tainted. And wren's card on scout's work, which is wren's alone, its no's reason with it.
      const yes = await card(w, `client:${scout.id}`, { answer: "go" });
      await card(w, `client:${scout.id}`, { answer: "no_go" }, { compartments: ["own", "work"] });
      await card(w, `client:${scout.id}`, { answer: "not_now" });
      await card(w, `client:${scout.id}`, { answer: "decline" });
      await card(w, `client:${scout.id}`, { answer: "wrong" });
      await card(w, `client:${scout.id}`, { answer: "later" });
      await card(w, `client:${scout.id}`, "by_agent");
      await card(w, `client:${scout.id}`, "waiting");
      // A no the owner reopened since: waiting again, not a no.
      await card(w, `client:${scout.id}`, { answer: "no_go" }, { reopened: true });
      await card(w, `client:${scout.id}`, "decided");
      await card(w, `client:${scout.id}`, { answer: "no_go" }, { tainted: true });
      await card(w, `client:${wren.id}`, { answer: "no_go" }, { target: declined });
      // A relayed answer of scout's the owner took back.
      await owned(
        w,
        `insert into ledger.card_relays (id, request_id, card_id, opportunity_id, client_id, client_name, option, ruling_id, applied_at, reopened_at, created_at, compartments)
         values ($1, $2, (select card_id from knowledge.owner_decisions where id = $3), $4, $5, 'scout', 'go', $3, now() - interval '2 hours', now() - interval '1 hour', now() - interval '3 hours', '{own}')`,
        [testId("crl"), testId("req"), yes, declined, scout.id],
      );
      // Refused calls: two of the call's fault count; one not found, one ok and one 40 days ago do not.
      await call(w, scout, "invalid_request");
      await call(w, scout, "not_permitted");
      await call(w, scout, "not_found");
      await call(w, scout, "ok");
      await call(w, scout, "invalid_request", "40 days");

      const later = new Date(Date.now() + 2 * MINUTE).toISOString();
      const owners = await w.admin<Record<string, unknown>>(
        `select r.client_id, ${ROW} from ledger.agent_records_within($1, $2, null) r`,
        [later, LABELS],
      );
      expect(owners.find((row) => row.client_id === scout.id)).toEqual({
        client_id: scout.id,
        done: 1,
        used: 1,
        raised: 13,
        yes: 1,
        no: 7,
        deferred: 1,
        by_agent: 1,
        waiting: 2,
        other: 1,
        no_codes: ["wrong_timing"],
        overturned: 1,
        refused: 2,
      });
      expect(owners.find((row) => row.client_id === wren.id)).toMatchObject({
        raised: 1,
        no: 1,
        no_codes: ["wrong_timing"],
      });
      expect(owners.find((row) => row.client_id === quiet.id)).toMatchObject({ done: 0, raised: 0, refused: 0 });
      // An answer after the time asked about is not yet one: the owner's no on the first card is
      // after a time 45 minutes back, so it is not counted as given.
      const earlier = new Date(Date.now() - 45 * MINUTE).toISOString();
      const before = await w.admin<Record<string, unknown>>(
        `select r.no, r.waiting from ledger.agent_records_within($1, $2, $3) r`,
        [earlier, LABELS, scout.id],
      );
      expect(before).toEqual([{ no: 0, waiting: 13 }]);

      // The agent's own: the card under `work` is outside scout's clearance, so it moves nothing.
      const mine = await readAs(w.db, scout.token, (query) =>
        query(`select ${ROW} from ledger.my_agent_record($1) r`, [later]),
      );
      expect(mine).toEqual([
        {
          done: 1,
          used: 1,
          raised: 12,
          yes: 1,
          no: 6,
          deferred: 1,
          by_agent: 1,
          waiting: 2,
          other: 1,
          no_codes: ["wrong_timing"],
          overturned: 1,
          refused: 2,
        },
      ]);
      // No client reads another's: a reader holds no right on the owner's read.
      await expect(
        readAs(w.db, scout.token, (query) => query("select * from ledger.agent_records_within(now(), '{own}', null)")),
      ).rejects.toThrow(/permission denied/);

      // The bootstrap pack: the record right after the standing and the guide (ledger.task_value counts a use within
      // the week after the work, whenever it is read); none for a client with nothing on record.
      const pack = ContextPack.parse(ok(await w.reader.buildContextPack(scout.token, { purpose: "agent_bootstrap" })));
      expect(pack.template).toBe("agent_bootstrap@16");
      expect(pack.items.map((item) => item.section).slice(0, 3)).toEqual(["standing", "guide", "record"]);
      expect(pack.items[2]).toMatchObject({
        id: "record",
        kind: "own_record",
        say: AGENT_RECORD_SAY,
        record: {
          days: 28,
          work: { done: 1, used: 1 },
          questions: { raised: 12, yes: 1, no: 6, deferred: 1, byAgent: 1, waiting: 2, other: 1 },
          noReasons: [{ reason: "wrong_timing", count: 1 }],
          overturned: 1,
          refused: 2,
        },
      });
      const silent = ContextPack.parse(
        ok(await w.reader.buildContextPack(quiet.token, { purpose: "agent_bootstrap" })),
      );
      expect(silent.items.filter((item) => item.section === "record")).toEqual([]);

      // The System room: every agent by name, each with its record.
      const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
      try {
        const room = AgentRecords.parse(await admin.agents.records());
        expect(room.agents.map((one) => one.client)).toEqual(["quiet", "scout", "wren"]);
        expect(room.agents.find((one) => one.client === "scout")?.record).toMatchObject({
          questions: { raised: 13, no: 7, waiting: 2 },
          overturned: 1,
        });
      } finally {
        await admin.close();
      }
    }, LABELS));
});
