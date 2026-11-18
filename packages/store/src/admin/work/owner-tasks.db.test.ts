import type { OpportunityId, OwnerTaskBody } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { request, testId } from "../../test-support/clients.ts";
import { queryAs } from "../../test-support/database.ts";
import { recordingLogger } from "../../test-support/recording.ts";
import { DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";
import { AGENT_WORK_TOOLS } from "../../test-support/work-clients.ts";
import { ok, type WorkWorld, withWorkWorld } from "../../test-support/work-test-world.ts";
import { createAdmin } from "../admin.ts";
import { setClientRoles, setTaskTier } from "../admin-tasks.ts";
import { ownerTaskBrief } from "./owner-tasks.ts";

// Synthetic rows only; role names are examples.

const OWN = ["own"];
const WORK = ["employer:example"];
const NOTE = "Who runs the clinic now, and what do they work on?";

async function agent(w: WorkWorld, name: string, compartments: string[], roles: string[]) {
  const client = await w.client(name, compartments, {
    tools: [...AGENT_WORK_TOOLS, "propose_task", "hand_off", "record"],
  });
  for (const kind of ["research", "investigate"]) await w.harness(client, kind, "investigate");
  await setClientRoles(w.admin, name, roles, new Date());
  return client;
}

const count = async (w: WorkWorld, sql: string, values: unknown[] = []): Promise<number> =>
  (await w.admin<{ n: number }>(sql, values))[0]?.n ?? -1;

describe("the owner's tasks for their agents", { timeout: DB_TEST_TIMEOUT }, () => {
  it("opens a read-only task by the owner's decision, briefed by code, labelled by what it names, and withdrawn only while unclaimed", () =>
    withWorkWorld(
      async (w) => {
        const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: recordingLogger().log });
        try {
          const scout = await agent(w, "scout", OWN, ["research"]);
          const other = await agent(w, "other", OWN, ["network"]);
          const insider = await agent(w, "insider", WORK, ["research"]);
          const person = await w.seed.entity("person");
          await w.seed.account(OWN, person);
          const message = await w.message(OWN);
          const fact = await w.seed.claim(OWN, message.evidence);
          const body = (over: Partial<OwnerTaskBody> = {}): OwnerTaskBody => ({
            role: "research" as never,
            kind: "research",
            about: [
              { kind: "entity", id: person as never },
              { kind: "fact", id: fact as never },
            ],
            note: NOTE,
            requestId: request(),
            ...over,
          });

          // The task tier off: refused, nothing written.
          await expect(admin.work.addTask(body())).rejects.toMatchObject({ code: "not_permitted" });
          expect(await count(w, "select count(*)::int as n from ledger.opportunities")).toBe(0);
          expect(
            await count(w, "select count(*)::int as n from knowledge.owner_decisions where kind = 'task_add'"),
          ).toBe(0);
          const intent = await setTaskTier(w.admin, true, new Date());

          // The owner's task: their row, by class and author, go by their decision under the task intent.
          const given = body();
          const made = await admin.work.addTask(given);
          expect(made).toEqual({ task: made.task, status: "go" });
          const id = made.task;
          expect(
            await w.admin(
              "select created_by, proposed_by_class, tier, role, kind, about_kind, about_id, compartments from ledger.opportunities where id = $1",
              [id],
            ),
          ).toEqual([
            {
              created_by: "owner",
              proposed_by_class: "owner",
              tier: "task",
              role: "research",
              kind: "research",
              about_kind: "entity",
              about_id: person,
              compartments: OWN,
            },
          ]);
          const [ruling] = await w.admin<{ id: string }>(
            "select id from knowledge.owner_decisions where kind = 'task_add' and target_id = $1",
            [id],
          );
          expect(
            await w.admin(
              "select decision, decided_by, rung, reason, intent_id, ruling_id from ledger.opportunity_decisions where opportunity_id = $1",
              [id],
            ),
          ).toEqual([
            {
              decision: "go",
              decided_by: "owner",
              rung: 4,
              reason: "owner_task",
              intent_id: intent,
              ruling_id: ruling?.id,
            },
          ]);
          // A fact stands in the basis for the message its claim was read from.
          expect(
            await w.admin(
              "select ref_kind, ref_id, evidence_id from ledger.basis where row_kind = 'opportunity' and row_id = $1 order by id",
              [id],
            ),
          ).toEqual([
            { ref_kind: "entity", ref_id: person, evidence_id: null },
            { ref_kind: "message", ref_id: message.id, evidence_id: message.evidence },
          ]);
          expect(await count(w, "select count(*)::int as n from ledger.cards")).toBe(0);
          // A repeat writes nothing and answers the first task.
          expect(await admin.work.addTask(given)).toEqual(made);
          expect(await count(w, "select count(*)::int as n from ledger.opportunities")).toBe(1);

          // Routed by role: the holder lists and claims it, and its brief is the template, the ids the
          // owner picked and their note, marked as theirs. Another role, or a clearance outside its label, does not.
          const open = async (client: typeof scout) =>
            ok(await w.work.listOpportunities(client.token, {})).opportunities.map((one) => one.id);
          expect(await open(other)).not.toContain(id);
          expect(await open(insider)).not.toContain(id);
          expect(await open(scout)).toContain(id);
          const claimed = ok(await w.work.claimOpportunity(scout.token, { id, requestId: request() }));
          expect(claimed.opportunity.summary).toEqual({ untrusted: ownerTaskBrief(given) });
          expect(ownerTaskBrief(given)).toBe(
            [
              "A task the owner opened themselves: research, for the research role. Read-only: contact no one.",
              `About: entity ${person}, fact ${fact}.`,
              "The owner's note, in their own words:",
              NOTE,
            ].join("\n"),
          );

          // Withdrawn only before any claim: after one, `work cancel` is the only stop.
          await expect(admin.work.withdrawTask({ task: id, requestId: request() })).rejects.toMatchObject({
            code: "already_claimed",
          });

          // No refs: about the owner, under `own`. Withdrawn: the owner's decision and the task's
          // `withdrawn`; a repeat writes nothing; again under a new request, not found.
          const bare = await admin.work.addTask(body({ about: [], kind: "investigate" }));
          expect(
            await w.admin("select about_kind, about_id, compartments from ledger.opportunities where id = $1", [
              bare.task,
            ]),
          ).toEqual([{ about_kind: "owner", about_id: null, compartments: OWN }]);
          const withdraw = { task: bare.task, requestId: request() };
          await admin.work.withdrawTask(withdraw);
          await admin.work.withdrawTask(withdraw);
          expect(
            await w.admin(
              "select event, by, code from ledger.record_events where row_kind = 'opportunity' and row_id = $1 order by id",
              [bare.task],
            ),
          ).toEqual([
            { event: "proposed", by: "owner", code: null },
            { event: "go", by: "owner", code: null },
            { event: "withdrawn", by: "owner", code: "owner_withdrew" },
          ]);
          expect(
            await count(
              w,
              "select count(*)::int as n from knowledge.owner_decisions where kind = 'task_withdraw' and target_id = $1",
              [bare.task],
            ),
          ).toBe(1);
          expect(await open(scout)).not.toContain(bare.task);
          await expect(admin.work.withdrawTask({ task: bare.task, requestId: request() })).rejects.toMatchObject({
            code: "not_found",
          });
          // Never an agent's task, whoever asks.
          const theirs = testId("opp") as OpportunityId;
          await expect(admin.work.withdrawTask({ task: theirs, requestId: request() })).rejects.toMatchObject({
            code: "not_found",
          });

          // Refusals, each writing nothing: a role no agent holds, a held message, a body that does not
          // parse; and the label is the union of what it names.
          const rows = await count(w, "select count(*)::int as n from ledger.opportunities");
          await expect(admin.work.addTask(body({ role: "nobody-holds" as never }))).rejects.toMatchObject({
            code: "unknown_role",
          });
          const held = await w.message(OWN, { held: true });
          await expect(
            admin.work.addTask(body({ about: [{ kind: "message", id: held.id as never }] })),
          ).rejects.toMatchObject({ code: "not_found" });
          await expect(admin.work.addTask(body({ kind: "follow_up" as never }))).rejects.toMatchObject({
            code: "invalid_argument",
          });
          // A request id another decision already spent; the kill switch on.
          await expect(admin.work.addTask(body({ requestId: withdraw.requestId }))).rejects.toMatchObject({
            code: "invalid_argument",
          });
          await expect(admin.work.withdrawTask({ task: id, requestId: given.requestId })).rejects.toMatchObject({
            code: "invalid_argument",
          });
          await w.killSwitch("on");
          await expect(admin.work.addTask(body())).rejects.toMatchObject({ code: "not_permitted" });
          await w.killSwitch("off");
          expect(await count(w, "select count(*)::int as n from ledger.opportunities")).toBe(rows);
          // The owner's note is their own words: `own` is in every label, so an agent outside it never
          // reads the note, even on a task naming only the employer's message.
          const wide = await w.message(WORK);
          const work = await admin.work.addTask(body({ about: [{ kind: "message", id: wide.id as never }] }));
          expect(await w.label("ledger.opportunities", work.task)).toEqual(["employer:example", "own"]);
          expect(await open(insider)).not.toContain(work.task);
          // A task naming only a fact is about the item its claim was read from.
          const onFact = await admin.work.addTask(body({ about: [{ kind: "fact", id: fact as never }] }));
          expect(
            await w.admin("select about_kind, about_id from ledger.opportunities where id = $1", [onFact.task]),
          ).toEqual([{ about_kind: "message", about_id: message.id }]);

          // Only pi_admin writes one: an agent's role cannot call the function.
          await expect(
            queryAs(
              w.db.urls.reader,
              "select ledger.owner_task($1, $2, 'research', 'research', 'owner', null, '{}'::jsonb, '{}', '{}', '{own}', $3)",
              [testId("opp"), request(), ruling?.id],
            ),
          ).rejects.toMatchObject({ code: "42501" });
        } finally {
          await admin.close();
        }
      },
      ["own", "employer:example", "agent:scout", "agent:other", "agent:insider"],
    ));
});
