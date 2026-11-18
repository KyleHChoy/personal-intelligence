import type { OpportunityKind, ProposableKind } from "@intelligence/contracts/personal";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { request } from "../test-support/clients.ts";
import { one } from "../test-support/connections.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import type { WorkClient } from "../test-support/work-clients.ts";
import { type Message, ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { open, type Sealed } from "./seal.ts";

// Reads go through the reader under the client's token, in the session the work tools use.
// Synthetic rows only.

const BOTH = ["employer:example", "own"];
const DRAFT = "Thanks for the call; here is the deck we discussed.";
const REPORT = {
  deliverable: "three people, each with the thread that shows the tie",
  next: "ask the owner which one to approach",
};

async function agent(
  w: WorkWorld,
  name: string,
  grants: [kind: OpportunityKind, stage: string][],
): Promise<{ client: WorkClient; intent: string }> {
  const client = await w.client(name, BOTH);
  const intent = await w.intent([...new Set(grants.map(([kind]) => kind))], [client]);
  for (const [kind, stage] of grants) await w.harness(client, kind, stage);
  return { client, intent };
}

// A message whose sender the owner wrote to: a recipient row with the sender's fingerprint.
async function known(w: WorkWorld, compartments: string[]): Promise<Message> {
  const message = await w.message(compartments);
  const { sender_fp } = one(
    await w.admin<{ sender_fp: string }>("select sender_fp from knowledge.messages where id = $1", [message.id]),
  );
  const { source_account_id } = one(
    await w.admin<{ source_account_id: string }>("select source_account_id from vault.evidence_items where id = $1", [
      message.evidence,
    ]),
  );
  await w.admin(
    "insert into vault.sent_recipients (evidence_id, address_fp, account_id, compartments) values ($1, $2, $3, $4)",
    [message.evidence, sender_fp, source_account_id, compartments],
  );
  return message;
}

// An opportunity about a message whose sender the owner wrote to, decided go, claimed and planned.
async function planned(w: WorkWorld, client: WorkClient, intent: string, kind: ProposableKind): Promise<string> {
  const about = { kind: "message" as const, id: (await known(w, ["own"])).id as never };
  const { opportunity } = ok(
    await w.work.proposeOpportunity(client.token, {
      kind,
      about,
      summary: `a ${kind} on the cited message`,
      basis: [about],
      requestId: request(),
    }),
  );
  await w.decideGo(opportunity, intent);
  ok(await w.work.claimOpportunity(client.token, { id: opportunity, requestId: request() }));
  return ok(await w.work.planMove(client.token, { opportunity, stage: "investigate" as never, requestId: request() }))
    .move;
}

const read = async (w: WorkWorld, client: WorkClient, message: Message): Promise<void> => {
  ok(await w.reader.readMessage(client.token, { id: message.id as never }));
};

const openedMarks = async (w: WorkWorld, move: string): Promise<unknown> => {
  const event = one(
    await w.admin<{ compartments: string[]; body_enc: Sealed }>(
      "select compartments, body_enc from ledger.record_events where row_kind = 'move' and row_id = $1 and event = 'reported'",
      [move],
    ),
  );
  return (
    JSON.parse(open(w.db.keys, { ...event, id: `${move}/reported` }, "ledger.record_events.body_enc", "throw")) as {
      marks: unknown;
    }
  ).marks;
};

describe("report_move's mixed_session mark", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a done report with a draft whose session read a stranger's message and an employer-labelled item is marked mixed_session; without a draft, or with one read, it is not", () =>
    withWorkWorld(async (w) => {
      const stranger = await w.message(["own"]);
      const employer = await known(w, ["employer:example"]);

      // Both reads, in either order, then a draft: marked.
      for (const [name, reads] of [
        ["both-a", [stranger, employer]],
        ["both-b", [employer, stranger]],
      ] as const) {
        const { client, intent } = await agent(w, name, [["follow_up", "investigate"]]);
        const move = await planned(w, client, intent, "follow_up");
        for (const message of reads) await read(w, client, message);
        expect(
          ok(
            await w.work.reportMove(client.token, {
              move: move as never,
              outcome: "done",
              report: { draft: DRAFT },
              requestId: request(),
            }),
          ),
          name,
        ).toEqual({
          move,
          opportunity: "handed_to_owner",
          marks: ["mixed_session"],
        });
        expect(await openedMarks(w, move), name).toEqual(["mixed_session"]);
      }
      expect(w.log.events.filter((event) => event.event === "report_marked")).toEqual([
        { event: "report_marked", code: "mixed_session" },
        { event: "report_marked", code: "mixed_session" },
      ]);

      // Both reads and no draft: not marked.
      const plain = await agent(w, "no-draft", [["investigate", "investigate"]]);
      const work = await planned(w, plain.client, plain.intent, "investigate");
      await read(w, plain.client, stranger);
      await read(w, plain.client, employer);
      expect(
        ok(
          await w.work.reportMove(plain.client.token, {
            move: work as never,
            outcome: "done",
            report: REPORT,
            requestId: request(),
          }),
        ),
      ).toEqual({ move: work, opportunity: "done" });
      expect(await openedMarks(w, work)).toEqual([]);

      // A draft after one of the two reads: not marked.
      for (const [name, only] of [
        ["stranger-only", stranger],
        ["employer-only", employer],
      ] as const) {
        const { client, intent } = await agent(w, name, [["follow_up", "investigate"]]);
        const move = await planned(w, client, intent, "follow_up");
        await read(w, client, only);
        expect(
          ok(
            await w.work.reportMove(client.token, {
              move: move as never,
              outcome: "done",
              report: { draft: DRAFT },
              requestId: request(),
            }),
          ),
          name,
        ).toEqual({ move, opportunity: "handed_to_owner" });
        expect(await openedMarks(w, move), name).toEqual([]);
      }
      expect(w.log.events.filter((event) => event.event === "report_marked")).toHaveLength(2);
    }));

  it("a blank draft is no draft, and pia work report counts the marks by client", () =>
    withWorkWorld(async (w) => {
      const stranger = await w.message(["own"]);
      const employer = await known(w, ["employer:example"]);
      const marked = await agent(w, "marked", [["follow_up", "investigate"]]);
      for (let n = 0; n < 2; n += 1) {
        const move = await planned(w, marked.client, marked.intent, "follow_up");
        await read(w, marked.client, stranger);
        await read(w, marked.client, employer);
        expect(
          ok(
            await w.work.reportMove(marked.client.token, {
              move: move as never,
              outcome: "done",
              report: { draft: DRAFT },
              requestId: request(),
            }),
          ),
        ).toEqual({
          move,
          opportunity: "handed_to_owner",
          marks: ["mixed_session"],
        });
      }
      // The same reads and a blank draft: refused as having no draft, and no mark is written.
      const blank = await agent(w, "blank", [["follow_up", "investigate"]]);
      const blankMove = await planned(w, blank.client, blank.intent, "follow_up");
      await read(w, blank.client, stranger);
      await read(w, blank.client, employer);
      expect(
        ok(
          await w.work.reportMove(blank.client.token, {
            move: blankMove as never,
            outcome: "done",
            report: { draft: "  " },
            requestId: request(),
          }),
        ),
      ).toEqual({ move: blankMove, refused: ["needs_draft"] });
      // An unmarked report of another client counts nothing.
      const quiet = await agent(w, "quiet", [["follow_up", "investigate"]]);
      const quietMove = await planned(w, quiet.client, quiet.intent, "follow_up");
      await read(w, quiet.client, stranger);
      ok(
        await w.work.reportMove(quiet.client.token, {
          move: quietMove as never,
          outcome: "done",
          report: { draft: DRAFT },
          requestId: request(),
        }),
      );

      const pool = new pg.Pool({ connectionString: w.db.urls.admin, max: 2 });
      try {
        const report = await new Admin({ pool, keys: w.db.keys, log: w.log }).work.report(7);
        expect(report.marks).toEqual([{ client: marked.client.id, mark: "mixed_session", n: 2 }]);
      } finally {
        await pool.end();
      }
    }));
});
