import type { FactId, Tier } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testId } from "../../test-support/clients.ts";
import { ownerStatement, type Query, session } from "../../test-support/connections.ts";
import { queryAs, sealRow } from "../../test-support/database.ts";
import { seeder } from "../../test-support/seeder.ts";
import { openStore, type TestStore } from "../../test-support/store.ts";
import { seedLines } from "../../test-support/warmth-lines.ts";
import type { OutcomesView } from "./admin-outcomes.ts";
import { creditedShare } from "./admin-outcomes.ts";

// `pi outcomes` as pi_admin on a small made-up world: every number worked out by hand, what falls
// outside each window left out, a restricted row in no count, and no opened value in what it prints.
// Rows are seeded as their writers write them, then moved to set times past the append-only triggers,
// which a test's clock has no other way past.

const TIMEOUT = 120_000;
const NOW = new Date("2026-10-20T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const ago = (days: number, hours = 0): string => new Date(NOW.getTime() - (days * 24 + hours) * HOUR_MS).toISOString();
const after = (at: string, hours: number): string => new Date(Date.parse(at) + hours * HOUR_MS).toISOString();
const MARK = "OUTCOMES-MARK-PLAINTEXT";
const RESTRICTED = "restricted:health";

let store: TestStore;
let view: OutcomesView;

const metric = (name: string) => {
  const found = view.metrics.find((one) => one.metric === name);
  if (found === undefined) throw new Error(`no metric ${name}`);
  return found;
};

const moved = (text: string, values: unknown[]): Promise<unknown> =>
  ownerStatement(store.db.urls.bootstrap, text, values);

type Seed = ReturnType<typeof seeder>;

// One message, ingested at `ingested`, with a claim written `claimAfter` hours later if given. A
// `rederivedAfter` writes the claim again that many hours after ingest, as a re-derive does: a new row
// that keeps the first-known time it carries.
async function mailAt(
  seed: Seed,
  ingested: string,
  claimAfter: number | null,
  over: { held?: boolean; system?: boolean; bulk?: boolean; label?: string; rederivedAfter?: number } = {},
): Promise<void> {
  const label = [over.label ?? "own"];
  const evidence = await seed.evidence(label);
  const id = await seed.message(label, evidence, { held: over.held ?? false, text: `${MARK} body` });
  await moved("update knowledge.messages set bulk = $2 where id = $1", [id, over.bulk ?? false]);
  await moved("update vault.evidence_items set ingested_at = $2, system_originated = $3 where id = $1", [
    evidence,
    ingested,
    over.system ?? false,
  ]);
  if (claimAfter === null) return;
  const claim = await seed.claim(label, evidence, "commitment");
  await moved("update knowledge.claims set created_at = $2, first_known_at = $3 where id = $1", [
    claim,
    after(ingested, over.rederivedAfter ?? claimAfter),
    after(ingested, claimAfter),
  ]);
}

async function captureAt(seed: Seed, kind: "meeting" | "moment", ingested: string, claimAfter: number | null) {
  const { id, evidenceId, key } = await seed.capture(["own"]);
  await moved("update knowledge.captures set kind = $2, capture_key = $3 where id = $1", [
    id,
    kind,
    key.replace("moment:", `${kind}:`),
  ]);
  await moved("update vault.evidence_items set ingested_at = $2 where id = $1", [evidenceId, ingested]);
  // A moment counts once a model was asked about it, which a done status says.
  if (kind === "moment") await seed.pipelineItem(["own"], evidenceId);
  if (claimAfter === null) return;
  const claim = await seed.claim(["own"], evidenceId, "commitment");
  await moved("update knowledge.claims set created_at = $2, first_known_at = $2 where id = $1", [
    claim,
    after(ingested, claimAfter),
  ]);
}

// A block day the week's read cuts into 90 unattributed minutes.
async function blockOn(seed: Seed): Promise<void> {
  const { id, key } = await seed.capture(["own"]);
  const start = ago(1, 3);
  const end = after(start, 1.5);
  const work = {
    kind: "block",
    blocks: [{ start, end, minutes: 90, bundle: "test.seed.notes", category: null }],
    cut: { blocks: 0, minutes: 0 },
  };
  await moved(
    `update knowledge.captures set kind = 'block', capture_key = $2, minutes = 90, started_at = $3, ended_at = $4, local_day = $5, work_enc = $6
     where id = $1`,
    [
      id,
      key.replace("moment:", "block:"),
      start,
      end,
      start.slice(0, 10),
      sealRow(store.db.keys, "own", { table: "knowledge.captures", id, column: "work_enc" }, JSON.stringify(work)),
    ],
  );
}

async function findingAt(
  seed: Seed,
  query: Query,
  createdAt: string,
  over: { refused?: string; readBy?: "other" | "writer"; packBy?: "other"; clearance?: string[] } = {},
): Promise<string> {
  const { id, clientId } = (await seed.into("ledger.agent_writes")(["own"])) as { id: string; clientId: string };
  await moved("update ledger.agent_writes set kind = 'finding', created_at = $2, refused_code = $3 where id = $1", [
    id,
    createdAt,
    over.refused ?? null,
  ]);
  const other = (await seed.into("ledger.sessions")(["own"])) as { id: string; clientId: string };
  const [own] = await query<{ session_id: string }>("select session_id from ledger.agent_writes where id = $1", [id]);
  const later = after(createdAt, 24);
  if (over.readBy !== undefined)
    await moved(
      `insert into ledger.read_log (session_id, client_id, tool, read_at, compartments, bound, shown, fact_key_fps)
       values ($1, $2, 'search', $3, $5, '{}', $4, '{}')`,
      [
        over.readBy === "other" ? other.id : own?.session_id,
        over.readBy === "other" ? other.clientId : clientId,
        later,
        [id],
        over.clearance ?? ["own"],
      ],
    );
  if (over.packBy !== undefined)
    await moved(
      `insert into ledger.context_packs (client_id, session_id, purpose, template, selector, pack_fp, item_ids, compartments, created_at)
       values ($1, $2, 'agent_bootstrap', 'agent_bootstrap@1', 'in_order', repeat('a', 64), $3, '{own}', $4)`,
      [other.clientId, other.id, [id], later],
    );
  return clientId;
}

const event = (rowKind: string, rowId: string, name: string, at: string, tainted: string | null = null) =>
  moved(
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments, tainted_at) values ($1, $2, $3, $4, 'system:test', '{own}', $5)",
    [rowKind, rowId, name, at, tainted],
  );

// One opportunity with one move, made at `created`, its move at `movedAt`.
async function opportunityAt(seed: Seed, query: Query, created: string, movedAt: string) {
  const known = await query<{ id: string }>("select id from ledger.moves");
  await seed.into("ledger.moves")(["own"]);
  const [made] = await query<{ id: string; opportunity_id: string }>(
    "select id, opportunity_id from ledger.moves where not (id = any ($1::text[]))",
    [known.map((one) => one.id)],
  );
  if (made === undefined) throw new Error("no move seeded");
  await moved("update ledger.opportunities set created_at = $2 where id = $1", [made.opportunity_id, created]);
  await moved("update ledger.moves set created_at = $2 where id = $1", [made.id, movedAt]);
  return { move: made.id, opportunity: made.opportunity_id };
}

async function cardWith(
  seed: Seed,
  over: { created?: string; caseKey?: string; matchFp?: string; kind?: string; decided?: string; label?: string },
): Promise<void> {
  const id = (await seed.into("ledger.cards")([over.label ?? "own"])) as string;
  await moved("update ledger.cards set created_at = $2, case_key = $3, match_fp = $4, kind = $5 where id = $1", [
    id,
    over.created ?? ago(40),
    over.caseKey ?? null,
    over.matchFp ?? null,
    over.kind ?? "notice",
  ]);
  if (over.decided !== undefined) await event("card", id, "decided", over.decided);
}

// A card that asks the owner something, raised three days back: of a kind, and answered by the owner
// at `decided` if given.
async function questionCard(seed: Seed, over: { kind: string; options: string[]; decided?: string }): Promise<void> {
  const id = (await seed.into("ledger.cards")(["own"])) as string;
  await moved("update ledger.cards set created_at = $2, kind = $3, options = $4 where id = $1", [
    id,
    ago(3),
    over.kind,
    over.options,
  ]);
  if (over.decided !== undefined) await event("card", id, "decided", over.decided);
}

// A top person, with a belief per entry resting on a claim that names one of their entities in turn:
// a person folded from two entities holds beliefs under both. Each belief is computed from its claim
// when asked; a closed one is the owner's retire of its fact.
async function personWith(seed: Seed, tier: string, beliefs: { firstKnown: string; status: string }[], folded = false) {
  const person = (await seed.entity("person")) as string;
  const members = folded ? [person, (await seed.entity("person")) as string] : [person];
  await seedLines(store.db, ["own"], [{ entity: person, tier: tier as Tier, warmth: 1 }], { today: NOW, append: true });
  // A folded person: the owner's ruling that the two addresses are one person.
  if (folded) {
    const fps: string[] = [];
    for (const member of members) {
      const account = await seed.account(["own"], member);
      const [row] = await queryAs<{ value_fp: string }>(
        store.db.urls.admin,
        "select value_fp from knowledge.accounts where id = $1",
        [account],
      );
      fps.push(row?.value_fp ?? "");
    }
    const [a, b] = fps.sort();
    const ruling = testId("rul");
    await queryAs(
      store.db.urls.admin,
      `insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments)
       values ($1, $2, 'identity_policy', 0, '{}', '{}', $3, '{own}')`,
      [ruling, testId("req"), ago(1)],
    );
    await queryAs(
      store.db.urls.admin,
      "insert into knowledge.identity_rulings (ruling_id, verdict, a_fp, b_fp, created_at) values ($1, 'same', $2, $3, $4)",
      [ruling, a, b, ago(1)],
    );
  }
  for (const [index, { firstKnown, status }] of beliefs.entries()) {
    const claim = await seed.claim(["own"], undefined, "commitment");
    await seed.claimEntity(["own"], claim, members[index % members.length]);
    await moved("update knowledge.claims set first_known_at = $2 where id = $1", [claim, firstKnown]);
    if (status === "closed") await store.admin.facts.retireFact(claim as FactId, { requestId: testId("req") });
  }
}

const fresh = (n: number, status = "active") => Array.from({ length: n }, () => ({ firstKnown: ago(2), status }));
const old = (n: number) => Array.from({ length: n }, () => ({ firstKnown: ago(100), status: "active" }));

beforeAll(async () => {
  store = await openStore({ now: NOW, restricted: ["health"], writer: false });
  await session(store.db.urls.admin, async (query) => {
    const seed = seeder(store.db, query);
    // Three active projects: one with a status from mail in the window, one whose only such claim is
    // too old, one with none, and a closed one with one in the window, left out.
    const projectWith = async (name: string, at: string | null) => {
      const project = await store.admin.projects.add(name, { requestId: `outcomes-${name}` });
      if (at !== null) {
        const evidence = await seed.evidence(["own"]);
        await seed.message(["own"], evidence, { text: `${MARK} body` });
        const claim = await seed.claim(["own"], evidence);
        await moved("update knowledge.claims set type = 'project.status', valid_from = $2 where id = $1", [claim, at]);
        await moved("insert into knowledge.claim_entities (claim_id, entity_id, compartments) values ($1, $2, $3)", [
          claim,
          project,
          ["own"],
        ]);
      }
      return project;
    };
    await projectWith("Mailed", ago(2));
    await projectWith("Stale", ago(40));
    await projectWith("Silent", null);
    await store.admin.projects.close(await projectWith("Ended", ago(2)), { requestId: "outcomes-ended" });

    // Mail: of four in the window, two have a claim within the day, one of them written again by a
    // re-derive two days later, which keeps when it was first known. The rest fall out by a rule.
    await mailAt(seed, ago(2), 2);
    await mailAt(seed, ago(3), 3, { rederivedAfter: 50 });
    await mailAt(seed, ago(2), 30);
    await mailAt(seed, ago(3), null);
    await mailAt(seed, ago(2), 1, { system: true });
    await mailAt(seed, ago(2), 1, { held: true });
    await mailAt(seed, ago(2), 1, { bulk: true });
    await mailAt(seed, ago(2), 1, { label: RESTRICTED });
    await mailAt(seed, ago(10), 1);
    await mailAt(seed, ago(0, 2), 1);

    // Captures: three meetings of four, one moment of two; one meeting received too long ago.
    await captureAt(seed, "meeting", ago(2), 1);
    await captureAt(seed, "meeting", ago(3), 20);
    await captureAt(seed, "meeting", ago(4), 23);
    await captureAt(seed, "meeting", ago(5), 40);
    await captureAt(seed, "meeting", ago(9), 1);
    await captureAt(seed, "moment", ago(2), 1);
    await captureAt(seed, "moment", ago(3), null);
    await blockOn(seed);

    // Findings: two of three read back by another client; the writer's own read does not count.
    const writer = await findingAt(seed, query, ago(10), { readBy: "other", clearance: ["own", RESTRICTED] });
    await findingAt(seed, query, ago(9), { packBy: "other" });
    await findingAt(seed, query, ago(8), { readBy: "writer" });
    await findingAt(seed, query, ago(10), { refused: "not_permitted", readBy: "other" });
    await findingAt(seed, query, ago(3), { readBy: "other" });

    // Done work: three done with a report, 8, 3 and 8 days after they were made.
    const reportedDone = async (created: number, done: number, movedAt = 5) => {
      const made = await opportunityAt(seed, query, ago(created), ago(movedAt));
      await event("move", made.move, "done", ago(done));
      await event("move", made.move, "reported", ago(done));
      await event("opportunity", made.opportunity, "done", ago(done));
      return made;
    };
    await reportedDone(10, 2);
    await reportedDone(4, 1);
    await reportedDone(9, 1);
    const unreported = await opportunityAt(seed, query, ago(6), ago(5));
    await event("opportunity", unreported.opportunity, "done", ago(1));
    // The task funnel's week: three tasks raised a fortnight's window back, one claimed, done and
    // kept, one only claimed, one never touched; one outside the window; one of the old tier.
    const tasks = [];
    // Their moves are outside the window, so the done work metric above is unchanged by them.
    for (const at of [ago(3), ago(3), ago(3), ago(40)]) tasks.push(await opportunityAt(seed, query, at, ago(50)));
    for (const one of tasks)
      await moved("update ledger.opportunities set tier = 'task', kind = 'investigate' where id = $1", [
        one.opportunity,
      ]);
    const [kept, touched] = tasks;
    if (kept === undefined || touched === undefined) throw new Error("no tasks");
    await event("opportunity", kept.opportunity, "claimed", ago(2));
    await event("opportunity", kept.opportunity, "done", ago(2));
    await event("opportunity", touched.opportunity, "claimed", ago(2));
    // A task code closed itself: raised in the window, on no board, so `codeClosed` and in no other count.
    const closedAtOnce = await opportunityAt(seed, query, ago(3), ago(50));
    await moved("update ledger.opportunities set tier = 'task', kind = 'investigate' where id = $1", [
      closedAtOnce.opportunity,
    ]);
    await moved(
      `insert into ledger.opportunity_decisions (request_id, created_at, created_by, compartments, opportunity_id, decision, decided_by, rung, reason)
       values ($1, $2, 'system:work', '{own}', $3, 'no_go', 'policy', 0, 'owner_declined')`,
      [testId("req"), ago(3), closedAtOnce.opportunity],
    );
    await moved(
      `insert into knowledge.owner_decisions (id, request_id, kind, target_kind, target_id, answer, queue_depth, labels, details, decided_at, compartments)
       values ('rul_01JABCDEFGHJKMNPQRSTVWXYZ9', 'funnel-keep-0001', 'result_eval', 'move', $1, 'keep', 0, '{}', '{}', $2, '{own}')`,
      [kept.move, ago(1)],
    );
    const taken = await reportedDone(8, 3);
    await event("opportunity", taken.opportunity, "go", ago(2));
    await reportedDone(40, 20, 25);
    // Reported blocked, then marked done by hand: the report says the work did not finish.
    const blocked = await opportunityAt(seed, query, ago(6), ago(25));
    await event("move", blocked.move, "blocked", ago(3));
    await event("move", blocked.move, "reported", ago(3));
    await event("opportunity", blocked.opportunity, "done", ago(1));
    // Its only report is on a restricted move.
    const hidden = await opportunityAt(seed, query, ago(6), ago(25));
    await moved("update ledger.moves set compartments = $2 where id = $1", [hidden.move, [RESTRICTED]]);
    await event("move", hidden.move, "done", ago(1));
    await event("move", hidden.move, "reported", ago(1));
    await event("opportunity", hidden.opportunity, "done", ago(1));
    // A tainted move in the window is no work done.
    const erased = await opportunityAt(seed, query, ago(6), ago(5));
    await moved("update ledger.moves set tainted_at = $2 where id = $1", [erased.move, ago(4)]);

    // Cards: one case raised again, one match raised again, one not; the rest are not in the sample.
    await cardWith(seed, { caseKey: "case-1", decided: ago(5) });
    await cardWith(seed, { caseKey: "case-1", created: ago(3) });
    await cardWith(seed, { matchFp: "a".repeat(64), decided: ago(5) });
    await cardWith(seed, { matchFp: "a".repeat(64), created: ago(2) });
    await cardWith(seed, { caseKey: "case-3", decided: ago(5) });
    await cardWith(seed, { caseKey: "case-old", decided: ago(20) });
    await cardWith(seed, { caseKey: "case-old", created: ago(10) });
    await cardWith(seed, { caseKey: "box:health", kind: "box_health", decided: ago(5) });
    await cardWith(seed, { caseKey: "box:health", kind: "box_health", created: ago(2) });
    await cardWith(seed, { decided: ago(5) });
    await cardWith(seed, { caseKey: "case-waiting" });
    // The owner's questions: one rung 0 could not decide, and three nothing tried, one of them
    // answered.
    await questionCard(seed, { kind: "opportunity_decision", options: ["go", "no_go"] });
    await questionCard(seed, { kind: "about_you", options: ["confirm", "reject"] });
    await questionCard(seed, { kind: "agent_claim", options: ["confirm", "reject"], decided: ago(2) });
    await questionCard(seed, { kind: "goal_proposal", options: ["accept", "reject"] });

    // People: two of the five at the top two tiers are filled, one of them across two entities.
    await personWith(seed, "close", [...fresh(1), ...old(2)], true);
    await personWith(seed, "inner", [...fresh(1), ...old(2)]);
    await personWith(seed, "close", old(3));
    await personWith(seed, "inner", fresh(2));
    await personWith(seed, "close", [...fresh(2), ...fresh(1, "closed")]);
    await personWith(seed, "regular", fresh(3));

    await moved("insert into ledger.job_runs (job, started_at, ended_at, code) values ('backup', $1, $1, 'ok')", [
      ago(10),
    ]);
    await moved("insert into ledger.job_runs (job, started_at, ended_at, code) values ('backup', $1, $1, 'ok')", [
      ago(30),
    ]);
    // A restore drill's rows are a job of their own, and none is a dump.
    for (const [days, code] of [
      [12, "ok"],
      [20, "failed"],
      [40, "ok"],
    ] as const)
      await moved(
        "insert into ledger.job_runs (job, started_at, ended_at, code) values ('restore_drill', $1, $1, $2)",
        [ago(days), code],
      );

    // A tool's calls in the window, and one before it.
    const call = (at: string, outcome: string) =>
      moved("insert into policy.calls (client_id, tool, at, rows, outcome) values ($1, 'search', $2, 0, $3)", [
        writer,
        at,
        outcome,
      ]);
    await call(ago(1), "ok");
    await call(ago(2), "ok");
    await call(ago(3), "not_permitted");
    await call(ago(20), "ok");

    // Two tables' rows: one in the window, one written long before it; a restricted one in neither.
    const inWindow = (await seed.into("ledger.drafts")(["own"])) as string;
    await moved("update ledger.drafts set created_at = $2 where id = $1", [inWindow, ago(4)]);
    const longAgo = (await seed.into("ledger.drafts")(["own"])) as string;
    await moved("update ledger.drafts set created_at = $2 where id = $1", [longAgo, ago(60)]);

    // The bar's refusals, by their code; another type's refusal and a restricted one are in no count.
    // Ingested after every other row of this world, which the seeder stamps with the real clock, so
    // the share counts from them alone, and after any window the other metrics read.
    const barStart = new Date(Date.now() + 24 * HOUR_MS).toISOString();
    const refusal = async (compartment: string, reason: string, proposedType: string) => {
      const evidence = await seed.evidence([compartment]);
      await moved("update vault.evidence_items set ingested_at = $2 where id = $1", [evidence, barStart]);
      const id = `unm_${reason}_${proposedType}_${compartment}`.replace(/\W/g, "_");
      await moved(
        "insert into vault.unmapped_claims (id, evidence_id, extractor_generation, facts_enc, compartments) values ($1, $2, 1, $3, $4)",
        [
          id,
          evidence,
          sealRow(
            store.db.keys,
            compartment,
            { table: "vault.unmapped_claims", id, column: "facts_enc" },
            JSON.stringify({ id, reason, proposedType }),
          ),
          [compartment],
        ],
      );
    };
    await refusal("own", "not_a_promise", "commitment");
    await refusal("own", "wrong_direction", "commitment");
    await refusal("own", "bad_span", "commitment");
    await refusal("own", "not_a_promise", "plan");
    await refusal(RESTRICTED, "not_a_promise", "commitment");
    // Kept, from the refusals' own time on: mail and a chat line, the lanes the bar judges. A
    // meeting's never faced it.
    await mailAt(seed, barStart, 1);
    await captureAt(seed, "moment", barStart, 1);
    await captureAt(seed, "meeting", barStart, 1);
  });
  await session(store.db.urls.admin, async (query) => {
    const seed = seeder(store.db, query);
    // Two tasks raised in the window for an active goal, one for a paused goal, one too old, one for
    // no goal and one of another trigger: 2 in 14 days is 1 a week, over the two active goals.
    const peopleTask = async (goal: string | null, trigger: string, raisedAt: string): Promise<void> => {
      const task = await seed.opportunity(["own"]);
      await moved(
        `update ledger.opportunities set kind = 'research', goal_id = $2, gap_trigger = $3, gap_subject = 'ent', gap_source = 'src', proposed_by_class = 'system', created_at = $4 where id = $1`,
        [task, goal, trigger, raisedAt],
      );
    };
    const [active, other, paused] = [
      await seed.goalState(["own"]),
      await seed.goalState(["own"]),
      await seed.goalState(["own"]),
    ];
    await moved("update projections.goal_state set status = 'paused' where goal_id = $1", [paused]);
    await moved(
      "update projections.goal_state set target_entity_id = 'ent_00000000000000000000000001' where goal_id = $1",
      [active],
    );
    await peopleTask(active, "intro_path", ago(2));
    await peopleTask(other, "intro_path", ago(3));
    await peopleTask(paused, "intro_path", ago(3));
    await peopleTask(active, "intro_path", ago(20));
    await peopleTask(null, "intro_path", ago(3));
    await peopleTask(active, "no_warm_path", ago(3));
    // Rung 0 said no to a gap flag twenty-eight times in the window and go once; the owner's no is not
    // code's, nor is one too old to count, nor one on work an agent proposed.
    const decided = async (decision: string, by: string, reason: string, at: string, gap = true): Promise<void> => {
      const opportunity = await seed.opportunity(["own"]);
      if (gap)
        await moved(
          "update ledger.opportunities set kind = 'research', gap_trigger = 'close_no_tie', gap_subject = 'ent', gap_source = 'src', proposed_by_class = 'system' where id = $1",
          [opportunity],
        );
      await query(
        `insert into ledger.opportunity_decisions (request_id, created_at, created_by, compartments, opportunity_id, decision, decided_by, rung, reason)
         values ($1, $2, 'system:work', '{own}', $3, $4, $5, $6, $7)`,
        [testId("req"), at, opportunity, decision, by, by === "owner" ? 4 : 0, reason],
      );
    };
    for (let i = 0; i < 28; i += 1) await decided("no_go", "policy", "expired_no_news", ago(1));
    await decided("go", "policy", "intent", ago(1));
    await decided("no_go", "owner", "cancelled", ago(1));
    await decided("no_go", "policy", "expired_no_news", ago(20));
    await decided("no_go", "policy", "owner_declined", ago(1), false);
    await decided("no_go", "policy", "owner_declined", ago(1));
    // Rung 0 acting on a veto is the owner's no, not code's: decided, but no no_go of code's.
    await decided("no_go", "policy", "vetoed", ago(1));
  });
  view = await store.admin.box.outcomes(14);
}, TIMEOUT);

afterAll(() => store?.close());

describe("pi outcomes", { timeout: TIMEOUT }, () => {
  it("counts mail from a person with a claim first known within a day, in the window, by the rules", () => {
    expect(metric("mail_to_claim_24h")).toMatchObject({
      value: 0.5,
      sample: 4,
      healthy: { test: "at_least", value: 0.4 },
      window: { fromDaysAgo: 7, toDaysAgo: 1 },
      state: "no_data",
      code: "small_sample",
    });
  });

  it("counts meetings and moments apart, each judged on its own sample", () => {
    expect(metric("capture_to_claim_24h_meetings")).toMatchObject({ value: 0.75, sample: 4, state: "failing" });
    expect(metric("capture_to_claim_24h_moments")).toMatchObject({ value: 0.5, sample: 2, state: "no_data" });
  });

  it("has no data on the own-lines lane while it asks nothing, never a low value", () => {
    expect(metric("own_lines_claims_per_moment")).toMatchObject({ value: null, sample: 0, state: "no_data" });
  });

  it("reads a week of work time for the credited share", () => {
    expect(metric("credited_share")).toMatchObject({ value: 0, sample: 90, state: "failing" });
    expect(creditedShare({ byProject: [{ minutes: 75 } as never], unattributed: 25 })).toMatchObject({
      value: 0.75,
      sample: 100,
      state: "ok",
    });
  });

  it("counts a finding read back only when another client was served it", () => {
    expect(metric("finding_read_back_7d")).toMatchObject({ value: 0.667, sample: 3, state: "no_data" });
  });

  it("counts the active projects whose record gained a fact from mail in the window", () => {
    expect(metric("projects_with_mail_facts")).toMatchObject({ value: 0.333, sample: 3, state: "failing" });
  });

  it("counts a project's facts from chat apart: mail is none of them", () => {
    expect(metric("projects_with_chat_facts")).toMatchObject({ value: 0, sample: 3, state: "failing" });
  });

  it("counts done work only where the latest event is done and a report exists", () => {
    expect(metric("done_work_per_week")).toMatchObject({ value: 1.5, sample: 5, state: "failing" });
    expect(metric("median_days_to_done")).toMatchObject({ value: 8, sample: 3, state: "failing" });
  });

  it("the funnel: of the tasks raised in the window, per week, those claimed, done and kept", () => {
    const { weeks, ...total } = view.funnel;
    expect(total).toEqual({ raised: 3, codeClosed: 1, claimed: 2, done: 1, kept: 1, claimedShare: 2 / 3 });
    expect(weeks.reduce((sum, week) => sum + week.raised, 0)).toBe(3);
    for (const week of weeks) expect(week.week).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("counts a card raised again after its answer, by case or by match, health cards aside", () => {
    expect(metric("reasked_after_answer")).toMatchObject({ value: 0.667, sample: 3, state: "no_data" });
  });

  it("counts a question as tried first when rung 0 had a go before the owner", () => {
    const attempted = metric("owner_questions_attempted");
    expect(attempted).toMatchObject({ value: 0.25, sample: 4 });
    expect(attempted.parts).toEqual({ agents: 0, code: 1, attempted: 0, untried: 3 });
  });

  it("counts the bar's refusals by their code, and how commitments ended", () => {
    const refused = metric("commitments_refused_share");
    expect(refused.parts).toEqual({ not_a_promise: 1, wrong_direction: 1 });
    expect(refused.healthy).toEqual({ test: "under", value: 0.5 });
    // The two refused, the mail and the chat line kept. Not the meeting, nor older commitments.
    expect(refused.sample).toBe(4);
    expect(refused.value).toBe(0.5);
    expect(metric("commitments_done_share")).toMatchObject({
      sample: 0,
      value: null,
      state: "no_data",
      healthy: { test: "at_least", value: 0.7 },
      window: { fromDaysAgo: 14, toDaysAgo: 0 },
    });
  });

  it("counts a top person filled at three current beliefs, one of them fresh, across their entities", () => {
    expect(metric("top_people_filled")).toMatchObject({ value: 0.4, sample: 5, state: "failing" });
    // Too few rows in this world to judge the room by, which says so.
    expect(metric("self_rows_leading")?.state).toBe("no_data");
  });

  it("counts the people warmth scores and those it reads as dormant, in the owner's audience", () => {
    expect(metric("people_with_warmth").sample).toBeGreaterThan(0);
    expect(metric("people_with_warmth").value).toBeGreaterThan(0);
    expect(metric("people_with_warmth").state).toBe("failing");
    expect(metric("dormant_people").value).toBeGreaterThanOrEqual(0);
  });

  it("counts people work raised for a goal still active, in the window", () => {
    expect(metric("goal_people_tasks_per_week")).toMatchObject({ value: 0.5, sample: 1, state: "failing" });
  });

  it("counts rung 0's no_go per day, by reason, and not the owner's", () => {
    expect(metric("code_no_go_per_day")).toMatchObject({
      value: 2.071,
      sample: 31,
      state: "failing",
      parts: { expired_no_news: 28, held_by_expired_card: 0, cases: 29, case_closed_by_owner: 1 },
    });
    expect(metric("code_no_go_per_day").parts?.days_since_last).toBeCloseTo(1, 1);
  });

  it("gives the restore test's age from the latest one that passed, while no later one failed", () => {
    expect(metric("restore_test_age_days")).toMatchObject({ value: 12, sample: 1, state: "ok" });
  });

  it("counts the box health cards that told anyone", () => {
    expect(metric("box_health_told")).toMatchObject({ value: 0, state: "failing" });
  });

  it("gives the backup's age from the latest one recorded", () => {
    expect(metric("backup_age_days")).toMatchObject({ value: 10, sample: 1, state: "failing" });
  });

  it("lists every MCP tool's use, a refusal by its code, and an unused one as unused", () => {
    const search = view.usage.tools.find((one) => one.tool === "search");
    expect(search).toEqual({
      tool: "search",
      calls: 3,
      successes: 2,
      refusals: { not_permitted: 1 },
      refusalRate: 0.333,
      lastUsedAt: ago(1),
      state: "used",
    });
    expect(view.usage.tools.find((one) => one.tool === "get_self")).toEqual({
      tool: "get_self",
      calls: 0,
      successes: 0,
      refusals: {},
      refusalRate: null,
      lastUsedAt: null,
      state: "unused",
    });
  });

  it("counts each table's rows in the window beside its last write, a zero as unused", async () => {
    expect(view.usage.tables.find((one) => one.table === "ledger.drafts")).toEqual({
      table: "ledger.drafts",
      rows: 1,
      lastWrittenAt: ago(4),
      state: "used",
    });
    expect(view.usage.tables.find((one) => one.table === "ledger.improvements")).toEqual({
      table: "ledger.improvements",
      rows: 0,
      lastWrittenAt: null,
      state: "unused",
    });
    expect(view.usage.tables.map((one) => one.table)).toEqual(
      expect.arrayContaining([
        "ledger.memory_projections",
        "ledger.memory_exposures",
        "ledger.memory_imports",
        "knowledge.owner_lists",
      ]),
    );
    const narrow = await store.admin.box.outcomes(1);
    expect(narrow.usage.tables.find((one) => one.table === "ledger.drafts")).toMatchObject({
      rows: 0,
      lastWrittenAt: ago(4),
      state: "unused",
    });
  });

  it("prints no opened value, and writes nothing", async () => {
    const printed = JSON.stringify(view);
    expect(printed).not.toContain(MARK);
    expect(printed).not.toContain("test.seed.notes");
    const before = await queryAs(store.db.urls.admin, "select count(*)::int as n from ledger.record_events");
    await store.admin.box.outcomes(14);
    expect(await queryAs(store.db.urls.admin, "select count(*)::int as n from ledger.record_events")).toEqual(before);
  });

  it("refuses a window off 1 to 90 days", async () => {
    for (const days of [0, 91, 1.5]) await expect(store.admin.box.outcomes(days)).rejects.toThrow();
  });

  it("is no_data on an empty store, with the reason where it has one", async () => {
    const empty = await openStore({ now: NOW, writer: false });
    try {
      const { metrics, usage } = await empty.admin.box.outcomes(14);
      for (const one of metrics) expect(one.state, one.metric).toBe("no_data");
      expect(metrics.find((one) => one.metric === "backup_age_days")?.code).toBe("no_backup_recorded");
      expect(metrics.find((one) => one.metric === "top_people_filled")?.code).toBe("no_owner_audience");
      expect(metrics.find((one) => one.metric === "roles_unattended")?.code).toBe("nothing_waiting");
      for (const one of [...usage.tools, ...usage.tables]) expect(one.state).toBe("unused");
    } finally {
      await empty.close();
    }
  });
});
