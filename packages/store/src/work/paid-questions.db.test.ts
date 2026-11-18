import { describe, expect, it } from "vitest";
import { opportunityDetailLines } from "../admin/cards/card-kinds-goals.ts";
import { ownerQuestions } from "../admin/outcomes/admin-outcomes-questions.ts";
import { ALL_TOOLS, request } from "../test-support/clients.ts";
import { readAs, session } from "../test-support/connections.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { AGENT_WORK_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { workAgent } from "../test-support/work-test-tasks.ts";
import { type Message, ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { createWriter } from "../write/writer.ts";

// Its `tried` is checked against the caller's own call and read logs of the last 24 hours by
// ledger.pay_question, written on the work, shown on the owner's card and counted by
// questions_paid_share. Reads go through the reader under each client's token, as `pi mcp` makes
// them. Synthetic rows only; every refusal has its control in the same test.

const OWN = ["own"];
const BOTH = ["own", "employer:example"];
const TOOLS = [...ALL_TOOLS, "find_messages", "read_message", ...AGENT_WORK_TOOLS, "hand_off", "record"];
const UNPAID = { ok: false, code: "invalid_request", refusal: "question_unpaid" };

const agent = (w: WorkWorld, name: string, compartments = OWN) => w.client(name, compartments, { tools: TOOLS });
const search = async (w: WorkWorld, client: WorkClient) => ok(await w.reader.findMessages(client.token, {}));
const read = async (w: WorkWorld, client: WorkClient, message: Message) =>
  ok(await w.reader.readMessage(client.token, { id: message.id as never }));
const tried = (sources: Message[], tool: "find_messages" | "search" = "find_messages") => ({
  searches: [{ tool, query: "the delivery date" }],
  sources: sources.map((one) => one.id as never),
  why: "No message names a delivery date.",
});

// An owner_question about a new message under OWN, resting on a hypothesis about it.
async function ask(w: WorkWorld, client: WorkClient, given?: ReturnType<typeof tried>) {
  const about = { kind: "message" as const, id: (await w.message(OWN)).id as never };
  const { hypothesis } = ok(
    await w.work.proposeHypothesis(client.token, {
      kind: "open_loop",
      about,
      summary: "an open loop in the cited message",
      basis: [about],
      requestId: request(),
    }),
  );
  return w.work.proposeOpportunity(client.token, {
    kind: "owner_question",
    about,
    summary: "when is the delivery due?",
    basis: [about],
    hypothesis,
    ...(given === undefined ? {} : { tried: given }),
    requestId: request(),
  });
}

const paidRow = async (w: WorkWorld, id: string) =>
  (
    await w.admin<{ question_tools: string[] | null; question_sources: string[] | null; paid: boolean }>(
      "select question_tools, question_sources, question_paid_at is not null as paid from ledger.opportunities where id = $1",
      [id],
    )
  )[0];
const opportunities = async (w: WorkWorld) =>
  (await w.admin<{ n: number }>("select count(*)::int as n from ledger.opportunities"))[0]?.n;

describe("a question to the owner pays up front", { timeout: DB_TEST_TIMEOUT }, () => {
  it("is refused question_unpaid without tried, with no search, with a source unread or read by another client, or read over a day ago, or read but never shown by the named search; with both it is written on the work, never on open work a proposal merges into", () =>
    withWorkWorld(async (w) => {
      const scout = await agent(w, "scout");
      const other = await agent(w, "other");
      const first = await w.message(OWN);

      // No tried: refused, and no work is written. The details' decisionNeeded asks too.
      const before = await opportunities(w);
      expect(await ask(w, scout)).toEqual(UNPAID);
      const about = { kind: "message" as const, id: first.id as never };
      expect(
        await w.work.proposeOpportunity(scout.token, {
          kind: "investigate",
          about,
          summary: "look into the delivery date",
          details: { decisionNeeded: "which date to hold" },
          basis: [about],
          requestId: request(),
        }),
      ).toEqual(UNPAID);
      expect(await opportunities(w)).toBe(before);

      // Read but no search: refused. A read is no search.
      await read(w, scout, first);
      expect(await ask(w, scout, tried([first]))).toEqual(UNPAID);
      // Searched with find_messages, but tried names search, which it never called: refused.
      await search(w, scout);
      expect(await ask(w, scout, tried([first], "search"))).toEqual(UNPAID);
      // Control: searched and read, by this client within the day. Written on the work.
      const paid = ok(await ask(w, scout, tried([first]))).opportunity;
      expect(await paidRow(w, paid)).toEqual({
        question_tools: ["find_messages"],
        question_sources: [first.evidence],
        paid: true,
      });

      // A source it never read: refused, though it searched and read another.
      const unread = await w.message(OWN);
      expect(await ask(w, scout, tried([first, unread]))).toEqual(UNPAID);
      // Another client's read of it does not count for this one.
      await read(w, other, unread);
      expect(await ask(w, scout, tried([first, unread]))).toEqual(UNPAID);
      // Nor does another client's search: a third client that read the item but never searched.
      const third = await agent(w, "third");
      await read(w, third, first);
      expect(await ask(w, third, tried([first]))).toEqual(UNPAID);

      // A read over 24 hours old no longer counts; a fresh one does.
      // As the table's owner in this test's own database, whose row policies hold no update: lifted
      // for the one statement inside its transaction.
      const aged = await session(w.db.urls.bootstrap, async (query) => {
        await query("begin");
        await query("set local role pi_owner");
        await query("alter table ledger.read_log no force row level security");
        const rows = await query(
          "update ledger.read_log set read_at = now() - interval '25 hours' where client_id = $1 returning id",
          [scout.id],
        );
        await query("alter table ledger.read_log force row level security");
        await query("commit");
        return rows;
      });
      expect(aged.length).toBeGreaterThan(0);
      expect(await ask(w, scout, tried([first]))).toEqual(UNPAID);
      // A fresh read alone is not enough: the search that showed it is a day old too.
      await read(w, scout, first);
      expect(await ask(w, scout, tried([first]))).toEqual(UNPAID);
      await search(w, scout);
      ok(await ask(w, scout, tried([first])));

      // A source read whole but never shown by the named search: refused; once a search shows it, paid.
      const opened = await w.message(OWN);
      await read(w, scout, opened);
      expect(await ask(w, scout, tried([opened]))).toEqual(UNPAID);
      await search(w, scout);
      ok(await ask(w, scout, tried([opened])));

      // A proposal that merges into the caller's own open work is checked and marks nothing.
      const subject = { kind: "message" as const, id: opened.id as never };
      const plain = {
        kind: "investigate" as const,
        about: subject,
        summary: "look into the opened message",
        basis: [subject],
      };
      const standing = ok(await w.work.proposeOpportunity(scout.token, { ...plain, requestId: request() })).opportunity;
      const merged = ok(
        await w.work.proposeOpportunity(scout.token, {
          ...plain,
          details: { decisionNeeded: "which date to hold" },
          tried: tried([opened]),
          requestId: request(),
        }),
      ).opportunity;
      expect(merged).toBe(standing);
      expect(await paidRow(w, standing)).toEqual({ question_tools: null, question_sources: null, paid: false });
      expect(
        await w.work.proposeOpportunity(scout.token, {
          ...plain,
          details: { decisionNeeded: "which date to hold" },
          tried: tried([unread]),
          requestId: request(),
        }),
      ).toEqual(UNPAID);
    }));

  it("an item the caller cannot see answers as one it never read, and a source outside the work's label does not pay for it", () =>
    withWorkWorld(async (w) => {
      const own = await agent(w, "own-only");
      const wide = await agent(w, "wide", BOTH);
      const employer = await w.message(["employer:example"]);
      const plain = await w.message(OWN);

      // The wide client reads the employer item; the own-only client cannot see it. Its refusal is the
      // one an unread own item gets (invariant 6).
      await search(w, own);
      await search(w, wide);
      await read(w, wide, employer);
      const unseen = await ask(w, own, tried([employer]));
      const unreadOwn = await ask(w, own, tried([plain]));
      expect(unseen).toEqual(UNPAID);
      expect(unreadOwn).toEqual(unseen);
      // Control: the wide client's question rests under its own clearance, so the item pays for it.
      ok(await ask(w, wide, tried([employer])));

      // Work labelled own alone, which the wide client can see: the employer item does not pay for a
      // question on it, and an own item it read does.
      await read(w, own, plain);
      const work = ok(await ask(w, own, tried([plain]))).opportunity;
      expect(await w.label("ledger.opportunities", work)).toEqual(OWN);
      await read(w, wide, plain);
      const pay = (sources: Message[]) =>
        readAs(w.db, wide.token, (query) =>
          query<{ paid: string }>("select ledger.pay_question($1, $2, $3, $4, false) as paid", [
            wide.session,
            work,
            ["find_messages"],
            sources.map((one) => one.evidence),
          ]),
        );
      expect(await pay([employer])).toEqual([{ paid: "unpaid" }]);
      expect(await pay([plain])).toEqual([{ paid: "paid" }]);
      // Work the caller cannot see is unseen, whatever was read.
      const hidden = ok(await ask(w, wide, tried([employer]))).opportunity;
      const seenBy = (client: WorkClient) =>
        readAs(w.db, client.token, (query) =>
          query<{ paid: string }>("select ledger.pay_question($1, $2, $3, $4, false) as paid", [
            client.session,
            hidden,
            ["find_messages"],
            [plain.evidence],
          ]),
        );
      expect(await seenBy(own)).toEqual([{ paid: "unseen" }]);
    }));

  it("a hand-off to the owner needs tried, checked before it is handed; the card shows what was checked and the measure counts it", () =>
    withWorkWorld(
      async (w) => {
        // With its agent compartment and source account, so its handoff note is taken in.
        const scout = await workAgent(w, "scout", [...OWN, "agent:scout"], { tools: TOOLS, account: true });
        const intent = await w.intent(["investigate"], [scout]);
        const message = await w.message(OWN);
        const about = { kind: "message" as const, id: message.id as never };
        const work = ok(
          await w.work.proposeOpportunity(scout.token, {
            kind: "investigate",
            about,
            summary: "look into the delivery date",
            basis: [about],
            requestId: request(),
          }),
        ).opportunity;
        await w.decideGo(work, intent);
        ok(await w.work.claimOpportunity(scout.token, { id: work, requestId: request() }));
        const note = ok(
          await w.reader.record(scout.token, {
            kind: "handoff",
            body: "The supplier needs a signature.",
            requestId: request(),
          }),
        ).recordId;
        const writer = createWriter({ url: w.db.urls.writer, keys: w.db.keys, log: w.log });
        try {
          await writer.takeRecords();
        } finally {
          await writer.close();
        }
        const toOwner = (given?: ReturnType<typeof tried>) =>
          w.work.handOff(scout.token, {
            id: work,
            role: "owner",
            reason: "blocked",
            record: note as never,
            ...(given === undefined ? {} : { tried: given }),
            requestId: request(),
          });
        const latest = () => w.latest("opportunity", work);

        // No tried, and a tried with no search behind it: refused, and the work stays claimed.
        expect(await toOwner()).toEqual(UNPAID);
        await read(w, scout, message);
        expect(await toOwner(tried([message]))).toEqual(UNPAID);
        expect(await latest()).toBe("claimed");
        // Control: searched too.
        await search(w, scout);
        expect(ok(await toOwner(tried([message])))).toEqual({ handedOff: true });
        expect(await latest()).toBe("handed_to_owner");
        expect(await paidRow(w, work)).toEqual({
          question_tools: ["find_messages"],
          question_sources: [message.evidence],
          paid: true,
        });

        // The owner's card on it: a code line of counts, the tool and the item's id; no agent's words.
        const lines = await opportunityDetailLines(w.admin, w.keys, work);
        const checked = lines.filter((line) => line.key === "checked");
        expect(checked).toEqual([
          {
            text: `checked first: 1 searches, 1 sources (find_messages, ${message.evidence})`,
            from: "code",
            key: "checked",
            value: [
              { kind: "count", n: 1 },
              { kind: "count", n: 1 },
              { kind: "code", code: "find_messages" },
              { kind: "id", of: "item", id: message.evidence },
            ],
          },
        ]);
        expect(JSON.stringify(lines)).not.toContain("delivery date");

        // The measure: one question, paid; nothing under a label the reading does not hold.
        const since = new Date(Date.now() - 86_400_000).toISOString();
        const until = new Date(Date.now() + 60_000).toISOString();
        const share = (within: string[]) =>
          ownerQuestions(w.admin, since, until, within).then((all) =>
            all.find((one) => one.metric === "questions_paid_share"),
          );
        const label = await w.label("ledger.opportunities", work);
        expect(await share(label)).toMatchObject({ value: 1, sample: 1, parts: { asked: 1, paid: 1 } });
        expect(await share(OWN)).toMatchObject({ value: null, sample: 0, parts: { asked: 0, paid: 0 } });
      },
      [...OWN, "agent:scout"],
    ));
});
