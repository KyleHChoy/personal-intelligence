import { CANARY_CLIENT_PREFIX, ListIdeasResult, OwnerIdeas } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { DEFAULT_AGENT_TOOLS } from "../admin/clients/admin-clients.ts";
import type { Query } from "../core/db.ts";
import { ALL_TOOLS, request, testId } from "../test-support/clients.ts";
import { session } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { AGENT_WORK_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { type Message, ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { plannerHypothesesWithoutCard } from "./dispatch-read.ts";

// The idea ledger: an agent files an idea with its evidence, and adds later evidence to an idea it
// names; no idea an agent filed is due a card, while the planner's still are; list_ideas answers
// what the caller can see, newest evidence first, its counts over those rows alone; the owner's
// read answers every idea with its text, filer and evidence. Calls go through the Work under each
// client's token, as `pi mcp` makes them. Synthetic rows only.

const OWN = ["own"];
const WIDE = ["own", "employer:example"];
const CANARY_AGENT = `agent:${CANARY_CLIENT_PREFIX}probe`;
const TOOLS = [...ALL_TOOLS, ...AGENT_WORK_TOOLS, "list_ideas"];

const agent = (w: WorkWorld, name: string, compartments = OWN) => w.client(name, compartments, { tools: TOOLS });
const ref = (message: Message) => ({ kind: "message" as const, id: message.id as never });
const file = (w: WorkWorld, client: WorkClient, about: Message, basis: Message[], idea?: string) =>
  w.work.proposeHypothesis(client.token, {
    kind: "idea",
    about: ref(about),
    summary: "a shared calendar for the reading club",
    basis: basis.map(ref),
    ...(idea === undefined ? {} : { idea: idea as never }),
    requestId: request(),
  });
const list = async (w: WorkWorld, client: WorkClient) =>
  ListIdeasResult.parse(ok(await w.work.listIdeas(client.token, {}))).ideas;
const basisLabels = async (w: WorkWorld, id: string) =>
  (
    await w.admin<{ compartments: string[] }>(
      "select compartments from ledger.basis where row_kind = 'hypothesis' and row_id = $1 order by id",
      [id],
    )
  ).map((row) => row.compartments);

// A planner's idea, as a run's finish writes one, as pi_owner in this test's own database.
async function plannerIdea(w: WorkWorld, about: Message): Promise<string> {
  const id = testId("hyp");
  const caseId = `cas_${id.slice(4)}`;
  const run = `run:${testId("run")}`;
  await session(w.db.urls.bootstrap, async (query) => {
    await query("begin");
    await query("set local role pi_owner");
    await query(
      `insert into ledger.cases (id, request_id, created_by, compartments, row_kind, kind, about_kind, about_id, author)
       values ($1, $1, $2, $3, 'hypothesis', 'idea', 'message', $4, 'run')`,
      [caseId, run, OWN, about.id],
    );
    await query(
      `insert into ledger.hypotheses (id, request_id, created_by, compartments, case_id, kind, about_kind, about_id, about_owner)
       values ($1, $1, $2, $3, $4, 'idea', 'message', $5, false)`,
      [id, run, OWN, caseId, about.id],
    );
    await query("select ledger.add_basis('hypothesis', $1, $2, array['message'], array[$3], null)", [
      id,
      OWN,
      about.id,
    ]);
    await query(
      "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('hypothesis', $1, 'open', now(), $2, $3)",
      [id, run, OWN],
    );
    await query("commit");
  });
  return id;
}

describe("the idea ledger", { timeout: DB_TEST_TIMEOUT }, () => {
  it("an agent files an idea, adds later evidence to the one it names, and none of it is due a card; a planner's idea still is", () =>
    withWorkWorld(async (w) => {
      const scout = await agent(w, "scout");
      const wren = await agent(w, "wren");
      const [first, second, third] = [await w.message(OWN), await w.message(OWN), await w.message(OWN)];

      const { hypothesis: idea } = ok(await file(w, scout, first, [first]));
      // An idea is never about the owner.
      expect(
        await w.work.proposeHypothesis(scout.token, {
          kind: "idea",
          about: { kind: "owner" },
          summary: "a shared calendar for the reading club",
          basis: [ref(first)],
          requestId: request(),
        }),
      ).toMatchObject({ ok: false, code: "invalid_request" });
      // Without an idea named, a second idea about the same message is a second idea: sameness is
      // never guessed.
      const { hypothesis: other } = ok(await file(w, scout, first, [first]));
      expect(other).not.toBe(idea);

      // Another agent names the idea: its refs join it, each once, and no row is made.
      const before = (await w.admin<{ n: number }>("select count(*)::int as n from ledger.hypotheses"))[0]?.n;
      expect(ok(await file(w, wren, second, [second, first], idea)).hypothesis).toBe(idea);
      expect(ok(await file(w, wren, third, [third, second], idea)).hypothesis).toBe(idea);
      expect((await w.admin<{ n: number }>("select count(*)::int as n from ledger.hypotheses"))[0]?.n).toBe(before);
      const cited = await w.admin<{ ref_id: string; added: boolean }>(
        "select ref_id, added_at is not null as added from ledger.basis where row_kind = 'hypothesis' and row_id = $1 order by id",
        [idea],
      );
      expect(cited).toEqual([
        { ref_id: first.id, added: true },
        { ref_id: second.id, added: true },
        { ref_id: third.id, added: true },
      ]);
      // An idea named with another kind, and an id that is no idea, are refused.
      expect(
        await w.work.proposeHypothesis(wren.token, {
          kind: "open_loop",
          about: ref(first),
          summary: "an open loop in the cited message",
          basis: [ref(first)],
          idea: idea as never,
          requestId: request(),
        }),
      ).toMatchObject({ ok: false, code: "invalid_request" });
      const { hypothesis: loop } = ok(
        await w.work.proposeHypothesis(wren.token, {
          kind: "open_loop",
          about: ref(first),
          summary: "an open loop in the cited message",
          basis: [ref(first)],
          requestId: request(),
        }),
      );
      expect(await file(w, wren, first, [first], loop)).toMatchObject({ ok: false, code: "not_found" });

      // No idea an agent filed is due a card; the planner's idea is.
      const planned = await plannerIdea(w, first);
      const asWork: Query = (text, values) => queryAs(w.db.urls.work, text, values);
      const due = (await plannerHypothesesWithoutCard(asWork)).map((one) => one.id);
      expect(due).toContain(planned);
      expect(due).not.toContain(idea);
      expect(due).not.toContain(other);
      expect((await w.admin<{ n: number }>("select count(*)::int as n from ledger.cards"))[0]?.n).toBe(0);
    }, WIDE));

  it("list_ideas answers what the caller can see, newest evidence first, and the owner reads every idea", () =>
    withWorkWorld(
      async (w) => {
        const scout = await agent(w, "scout");
        const wide = await agent(w, "wide", WIDE);
        const plain = await w.message(OWN);
        const secret = await w.message(WIDE);

        const { hypothesis: older } = ok(await file(w, scout, plain, [plain]));
        const { hypothesis: hidden } = ok(await file(w, wide, secret, [secret]));
        const { hypothesis: newer } = ok(await file(w, scout, plain, [plain]));
        // The wide agent adds evidence it read under its own label to the older idea: the basis row
        // takes the caller's label, and the idea becomes the newest.
        ok(await file(w, wide, secret, [secret], older));
        expect(await basisLabels(w, older)).toEqual([OWN, [...WIDE].sort()]);

        // The narrow agent: neither the wide idea nor the wide evidence, in rows, counts or order.
        const seen = await list(w, scout);
        expect(seen.map((one) => one.id)).toEqual([newer, older]);
        expect(seen.find((one) => one.id === older)).toMatchObject({ filedBy: "you", cited: 1, status: "open" });
        expect(seen[0]?.idea).toEqual({ untrusted: "a shared calendar for the reading club" });
        expect(JSON.stringify(seen)).not.toContain(plain.id);
        // It cannot add to an idea it cannot see: answered as one that does not exist.
        expect(await file(w, scout, plain, [plain], hidden)).toMatchObject({ ok: false, code: "not_found" });

        // The wide agent sees all three, the older first now, with both items it rests on.
        const all = await list(w, wide);
        expect(all.map((one) => one.id)).toEqual([older, newer, hidden]);
        expect(all[0]).toMatchObject({ filedBy: "agent", cited: 2 });
        expect(all[0]?.evidence.map((one) => one.kind)).toEqual(["message", "message"]);
        expect(all[2]).toMatchObject({ filedBy: "you" });

        // A client without the tool is refused, and no agent is given it by default: it is the owner's to grant.
        expect(DEFAULT_AGENT_TOOLS).not.toContain("list_ideas");
        const bare = await w.client("bare", OWN, { tools: [...ALL_TOOLS, ...AGENT_WORK_TOOLS] });
        expect(await w.work.listIdeas(bare.token, {})).toMatchObject({ ok: false, code: "not_permitted" });
        // It still files ideas through propose_hypothesis.
        const { hypothesis: bareIdea } = ok(await file(w, bare, plain, [plain]));
        // A canary client's idea, which the owner's read leaves out.
        const canary = await agent(w, `${CANARY_CLIENT_PREFIX}probe`, [...OWN, CANARY_AGENT]);
        const { hypothesis: probed } = ok(await file(w, canary, plain, [plain]));

        // One item cited twice under two labels is one item: the wide agent adds a message to the newer
        // idea, then the narrow one, which cannot see that row, adds the same message.
        const again = await w.message(OWN);
        ok(await file(w, wide, again, [again], newer));
        ok(await file(w, scout, again, [again], newer));
        expect(await basisLabels(w, newer)).toEqual([OWN, [...WIDE].sort(), OWN]);
        for (const viewer of [scout, wide])
          expect((await list(w, viewer)).find((one) => one.id === newer)?.cited, viewer.name).toBe(2);
        // The canary adds evidence to the older idea under its own compartment: the newest of all, and
        // no part of the owner's read.
        const probe = await w.message(OWN);
        ok(await file(w, canary, probe, [probe], older));

        // The owner: every idea, newest evidence first, its text, who filed it and when, no id in text.
        const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: w.log });
        try {
          const ledger = OwnerIdeas.parse(await admin.agents.ideas());
          expect(ledger.ideas.map((one) => one.id)).toEqual([newer, bareIdea, older, hidden]);
          expect(ledger.ideas.map((one) => one.id)).not.toContain(probed);
          expect(ledger.ideas[0]?.cited).toBe(2);
          expect(ledger.ideas[2]).toMatchObject({
            by: "scout",
            summary: "a shared calendar for the reading club",
            cited: 2,
            status: "open",
          });
          expect(ledger.ideas[3]?.by).toBe("wide");
          // New ideas filed since Monday, the canary's left out.
          expect(ledger.filedThisWeek).toBe(4);
          expect(JSON.stringify(ledger)).not.toContain(secret.id);
        } finally {
          await admin.close();
        }
      },
      [...WIDE, CANARY_AGENT],
    ));
});
