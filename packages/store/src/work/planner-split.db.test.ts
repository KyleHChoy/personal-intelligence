import { DECISION_POINT_PINS } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sealUnder } from "../core/seal.ts";
import { testId } from "../test-support/clients.ts";
import { one, readAs, session } from "../test-support/connections.ts";
import { createTestDatabase, queryAs, type TestDatabase } from "../test-support/database.ts";
import { seeder } from "../test-support/seeder.ts";
import { insertWorkClient, type WorkClient } from "../test-support/work-clients.ts";
import { proposedOpportunities } from "./dispatch-read.ts";

// What ledger.finish_run takes from each stage. An ideas run
// writes ideas, each a hypothesis of kind idea and a case of its own, never about the owner; a
// lessons run writes lessons about the owner; neither writes anything else, and no other run
// writes either; a translate run's proposals rest on the idea its anchor names, and one whose idea
// is gone writes nothing. Runs are queued as pi_work, as the tick queues one. Made-up values only.

const OWN = ["own"];
const PIN = DECISION_POINT_PINS["run_outcome@4"] ?? "";
const req = (): string => testId("req");

let db: TestDatabase;
let reasoner: WorkClient;
let message = "";
let other = "";
let third = "";
let agent: WorkClient;

const admin = <R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<R[]> =>
  queryAs<R>(db.urls.admin, text, values);
const sealed = (table: string, id: string): unknown =>
  sealUnder(db.keys, OWN, { table, id, column: "body_enc" }, `made-up summary for ${id}`);

// A run of one prompt, queued and taken by the reasoner. A translate run is anchored on its idea.
async function taken(
  prompt: "personal_ideas" | "personal_translate" | "personal_lessons" | "personal_run",
  anchor?: { kind: string; id: string },
): Promise<string> {
  const id = testId("run");
  const request = req();
  await session(db.urls.work, async (query) => {
    await query("begin");
    await query(
      `insert into ledger.runs (id, request_id, created_by, compartments, wake_source, wake_key, decision_point, definition_version, prompt_id, prompt_version)
       values ($1, $2, 'system:work', $3, 'owner_request', $4, 'run_outcome', 4, $5, $6)`,
      [id, request, OWN, `owner:${request}`, prompt, prompt === "personal_run" ? "3" : "1"],
    );
    await query(
      "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('run', $1, 'queued', now(), 'system:work', $2)",
      [id, OWN],
    );
    if (anchor !== undefined) {
      const { ok } = one(
        await query<{ ok: boolean }>(
          "select ledger.add_basis('run', $1, $2::text[], $3::text[], $4::text[], null) as ok",
          [id, OWN, [anchor.kind], [anchor.id]],
        ),
      );
      if (!ok) throw new Error("the anchor did not resolve");
    }
    await query("commit");
  });
  const [run] = await readAs(db, reasoner.token, (query) =>
    query<{ run_id: string }>("select run_id from ledger.next_run($1, $2)", [req(), reasoner.session]),
  );
  if (run?.run_id !== id) throw new Error("next_run took another run");
  return id;
}

// finish_run as the reasoner: its one row, or the code it raised.
async function finish(run: string, actions: unknown[]): Promise<{ recorded: number; outcome: string } | string | null> {
  try {
    const rows = await readAs(db, reasoner.token, (query) =>
      query<{ recorded: number; outcome: string }>(
        "select * from ledger.finish_run($1, $2, $3, 'finished', null, 4, $4, $5::jsonb)",
        [run, req(), reasoner.session, PIN, JSON.stringify(actions)],
      ),
    );
    return rows[0] ?? null;
  } catch (error) {
    return (error as { code?: string }).code ?? "error";
  }
}

const idea = (about: { kind: string; id: string | null }, refs: string[], id = testId("hyp")) => ({
  do: "idea",
  id,
  about_kind: about.kind,
  about_id: about.id,
  ref_kinds: refs.map(() => "message"),
  ref_ids: refs,
  body_enc: sealed("ledger.hypotheses", id),
});
const lesson = (refs: { kind: string; id: string }[], id = testId("hyp")) => ({
  do: "lesson",
  id,
  about_kind: "owner",
  about_id: null,
  ref_kinds: refs.map((ref) => ref.kind),
  ref_ids: refs.map((ref) => ref.id),
  body_enc: sealed("ledger.hypotheses", id),
});
const propose = (kind: string, refs: { kind: string; id: string }[], id = testId("opp")) => ({
  do: "propose",
  id,
  kind,
  about_kind: "message",
  about_id: message,
  ref_kinds: refs.map((ref) => ref.kind),
  ref_ids: refs.map((ref) => ref.id),
  body_enc: sealed("ledger.opportunities", id),
});
const onMessage = { kind: "message", id: "" };

beforeAll(async () => {
  db = await createTestDatabase();
  const made = await session(db.urls.admin, async (query) => {
    const seed = seeder(db, query);
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1)
      ids.push(await seed.message(OWN, await seed.evidence(OWN, await seed.sourceAccount(OWN))));
    return ids;
  });
  [message = "", other = "", third = ""] = made;
  onMessage.id = message;
  reasoner = await insertWorkClient(db, "reasoner", OWN, { kind: "reasoner" });
  agent = await insertWorkClient(db, "agent", OWN);
}, 300_000);

afterAll(async () => {
  await db?.drop();
});

describe("what finish_run takes from each stage", () => {
  it("an ideas run writes each idea as a case of its own, never about the owner, and nothing else", async () => {
    const run = await taken("personal_ideas");
    // Not about the owner, no proposal, no lesson: invalid_request, and nothing is written.
    expect(await finish(run, [idea({ kind: "owner", id: null }, [message])])).toBe("22023");
    expect(await finish(run, [propose("investigate", [onMessage])])).toBe("22023");
    expect(await finish(run, [lesson([onMessage])])).toBe("22023");
    // Two ideas about one message are two cases.
    const first = idea(onMessage, [message]);
    const second = idea(onMessage, [message, other]);
    expect(await finish(run, [first, second])).toEqual({ recorded: 2, outcome: "finished" });
    const rows = await admin<{ id: string; kind: string; about_owner: boolean; case_id: string; event: string }>(
      `select h.id, h.kind, h.about_owner, h.case_id, (select r.event from ledger.record_events r where r.row_kind = 'hypothesis' and r.row_id = h.id order by r.id desc limit 1) as event
       from ledger.hypotheses h where h.run_id = $1 order by h.id`,
      [run],
    );
    expect(rows.map(({ kind, about_owner, event }) => ({ kind, about_owner, event }))).toEqual([
      { kind: "idea", about_owner: false, event: "open" },
      { kind: "idea", about_owner: false, event: "open" },
    ]);
    expect(new Set(rows.map((row) => row.case_id)).size).toBe(2);
    expect(await admin("select id from ledger.opportunities where run_id = $1", [run])).toEqual([]);
    expect(
      await admin(
        "select output, effect, effect_class from ledger.decision_point_calls where run_id = $1 order by id",
        [run],
      ),
    ).toEqual([
      { output: "idea", effect: "open_investigation", effect_class: "internal_reversible" },
      { output: "idea", effect: "open_investigation", effect_class: "internal_reversible" },
    ]);
  });

  it("a run of personal_run writes no idea; a lessons run writes lessons about the owner, citing the cases, and an ignore", async () => {
    const plan = await taken("personal_run");
    expect(await finish(plan, [idea(onMessage, [message])])).toBe("22023");
    const [cited] = await admin<{ id: string }>(
      "select id from ledger.hypotheses where kind = 'idea' order by id limit 1",
    );
    const lessons = await taken("personal_lessons");
    expect(await finish(lessons, [idea(onMessage, [message])])).toBe("22023");
    expect(
      await finish(lessons, [
        { ...lesson([{ kind: "hypothesis", id: cited?.id ?? "" }]), about_kind: "message", about_id: message },
      ]),
    ).toBe("22023");
    expect(await finish(lessons, [lesson([{ kind: "hypothesis", id: cited?.id ?? "" }])])).toEqual({
      recorded: 1,
      outcome: "finished",
    });
    expect(
      await admin("select kind, about_kind, about_owner from ledger.hypotheses where run_id = $1", [lessons]),
    ).toEqual([{ kind: "lesson", about_kind: "owner", about_owner: true }]);
    expect(
      await admin("select output, effect, effect_class from ledger.decision_point_calls where run_id = $1", [lessons]),
    ).toEqual([{ output: "lesson", effect: "record_only", effect_class: "narrow" }]);
    const quiet = await taken("personal_lessons");
    expect(await finish(quiet, [{ do: "ignore", reason: "nothing_to_do" }])).toEqual({
      recorded: 1,
      outcome: "finished",
    });
  });

  it("a translate run's work rests on its idea, a question included; one whose anchor is no idea writes nothing", async () => {
    const [anIdea] = await admin<{ id: string }>(
      "select id from ledger.hypotheses where kind = 'idea' order by id limit 1",
    );
    const ideaRef = { kind: "hypothesis", id: anIdea?.id ?? "" };
    const run = await taken("personal_translate", ideaRef);
    expect(await finish(run, [idea(onMessage, [message])])).toBe("22023");
    expect(
      await finish(run, [propose("owner_question", [ideaRef]), propose("follow_up", [ideaRef, onMessage])]),
    ).toEqual({ recorded: 2, outcome: "finished" });
    expect(
      await admin("select kind, hypothesis_id from ledger.opportunities where run_id = $1 order by kind", [run]),
    ).toEqual([
      { kind: "follow_up", hypothesis_id: anIdea?.id },
      { kind: "owner_question", hypothesis_id: anIdea?.id },
    ]);
    // Anchored on a message, not an idea: no row, and the run stays running.
    const orphan = await taken("personal_translate", onMessage);
    expect(await finish(orphan, [propose("goal_step", [onMessage])])).toBeNull();
    expect(await admin("select id from ledger.opportunities where run_id = $1", [orphan])).toEqual([]);
  });
});

// An opportunity's case includes the hypothesis it rests on, so the
// owner's no on work resting on one idea never declines work resting on another, and work resting
// on one idea still merges into one case. Rung 0 reads the case's closing as caseClosed.
describe("an opportunity's case includes its hypothesis", () => {
  const about = { kind: "message", id: "" };
  const work = (kind: string, idea: string, id = testId("opp")) => ({
    ...propose(kind, [{ kind: "hypothesis", id: idea }, about]),
    id,
    about_id: about.id,
  });

  // Two fresh ideas about the third message, so no earlier test's case is met.
  async function twoIdeas(): Promise<[string, string]> {
    const run = await taken("personal_ideas");
    const first = idea({ kind: "message", id: third }, [third]);
    const second = idea({ kind: "message", id: third }, [third]);
    expect(await finish(run, [first, second])).toEqual({ recorded: 2, outcome: "finished" });
    return [first.id, second.id];
  }

  // The owner's no on an opportunity, as their card writes it.
  async function decline(opportunity: string): Promise<void> {
    await admin(
      "insert into ledger.opportunity_decisions (request_id, created_by, compartments, opportunity_id, decision, decided_by, rung) values ($1, 'owner', $2, $3, 'no_go', 'owner', 4)",
      [req(), OWN, opportunity],
    );
    await queryAs(
      db.urls.work,
      "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('opportunity', $1, 'no_go', now(), 'owner', $2)",
      [opportunity, OWN],
    );
  }

  const caseOf = async (opportunity: string): Promise<string | undefined> =>
    (await admin<{ case_id: string }>("select case_id from ledger.opportunities where id = $1", [opportunity]))[0]
      ?.case_id;
  const closedOf = async (opportunity: string) => {
    const [item] = await session(db.urls.work, (query) => proposedOpportunities(query, new Date(), opportunity));
    return item?.facts.caseClosed;
  };

  beforeAll(() => {
    about.id = third;
  });

  it("a declined investigate opportunity does not decline a later one about the same thing that rests on another idea", async () => {
    const [ideaA, ideaB] = await twoIdeas();
    const first = work("investigate", ideaA);
    expect(await finish(await taken("personal_translate", { kind: "hypothesis", id: ideaA }), [first])).toEqual({
      recorded: 1,
      outcome: "finished",
    });
    await decline(first.id);
    expect(await admin("select hypothesis_id from ledger.cases where id = $1", [await caseOf(first.id)])).toEqual([
      { hypothesis_id: ideaA },
    ]);

    const later = work("investigate", ideaB);
    expect(await finish(await taken("personal_translate", { kind: "hypothesis", id: ideaB }), [later])).toEqual({
      recorded: 1,
      outcome: "finished",
    });
    expect(await caseOf(later.id)).not.toBe(await caseOf(first.id));
    expect(await closedOf(later.id)).toBeNull();

    // Work resting on the declined idea's own hypothesis keeps the owner's no.
    const again = work("investigate", ideaA);
    expect(await finish(await taken("personal_translate", { kind: "hypothesis", id: ideaA }), [again])).toEqual({
      recorded: 1,
      outcome: "finished",
    });
    expect(await caseOf(again.id)).toBe(await caseOf(first.id));
    expect((await closedOf(again.id))?.by).toBe("owner");
  });

  it("two proposals resting on one idea, of one kind and about one thing, share a case and merge", async () => {
    const [ideaA] = await twoIdeas();
    const run = await taken("personal_translate", { kind: "hypothesis", id: ideaA });
    const first = work("goal_step", ideaA);
    expect(await finish(run, [first, work("goal_step", ideaA)])).toEqual({ recorded: 2, outcome: "finished" });
    expect(await admin("select id from ledger.opportunities where run_id = $1", [run])).toEqual([{ id: first.id }]);
    const next = work("goal_step", ideaA);
    expect(await finish(await taken("personal_translate", { kind: "hypothesis", id: ideaA }), [next])).toEqual({
      recorded: 1,
      outcome: "finished",
    });
    expect(await admin("select id from ledger.opportunities where id = $1", [next.id])).toEqual([]);
  });

  it("an agent's propose_opportunity follows the same rule", async () => {
    const [ideaA, ideaB] = await twoIdeas();
    const proposeAs = async (hypothesis: string | null): Promise<string | null> => {
      const id = testId("opp");
      const [row] = await readAs(db, agent.token, (query) =>
        query<{ answer: string | null }>(
          "select ledger.propose_opportunity($1::text, $2::text, $3::text, 'investigate', 'message', $4::text, $5::text, null, $6::jsonb, $7::text[], $8::text[]) as answer",
          [id, req(), agent.session, third, hypothesis, sealed("ledger.opportunities", id), ["message"], [third]],
        ),
      );
      return row?.answer ?? null;
    };
    const first = (await proposeAs(ideaA)) ?? "";
    await decline(first);
    const later = (await proposeAs(ideaB)) ?? "";
    expect(await caseOf(later)).not.toBe(await caseOf(first));
    expect(await closedOf(later)).toBeNull();
    // On the same idea: the declined case, and a new row in it.
    const again = (await proposeAs(ideaA)) ?? "";
    expect(again).not.toBe(first);
    expect(await caseOf(again)).toBe(await caseOf(first));
    // On none: the old key, a case of its own with no hypothesis, and a second proposal merges.
    const bare = (await proposeAs(null)) ?? "";
    expect(await admin("select hypothesis_id from ledger.cases where id = $1", [await caseOf(bare)])).toEqual([
      { hypothesis_id: null },
    ]);
    expect(await proposeAs(null)).toBe(bare);
  });
});
