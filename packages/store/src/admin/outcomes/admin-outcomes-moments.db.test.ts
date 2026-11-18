import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerStatement, session } from "../../test-support/connections.ts";
import { sealRow } from "../../test-support/database.ts";
import { seeder } from "../../test-support/seeder.ts";
import { openStore, type TestStore } from "../../test-support/store.ts";
import type { OutcomesView } from "./admin-outcomes.ts";

// `pi outcomes` on the moment lane: the share is of the moments a model read, a fact is a model's,
// and what became of every moment received is told by code. Numbers by hand.

const TIMEOUT = 120_000;
const NOW = new Date("2026-10-20T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const ago = (days: number): string => new Date(NOW.getTime() - days * 24 * HOUR_MS).toISOString();
const after = (at: string, hours: number): string => new Date(Date.parse(at) + hours * HOUR_MS).toISOString();
const RESTRICTED = "restricted:health";

let store: TestStore;
let view: OutcomesView;

const metric = (name: string) => {
  const found = view.metrics.find((one) => one.metric === name);
  if (found === undefined) throw new Error(`no metric ${name}`);
  return found;
};

// One statement as pi_owner, past forced row security and the append-only triggers, to set times.
const moved = (text: string, values: unknown[]): Promise<unknown> =>
  ownerStatement(store.db.urls.bootstrap, text, values);

type Seed = ReturnType<typeof seeder>;
type Seeded = {
  ingested: string;
  // `done`, or the code of a moment committed with no model call; absent, no run has taken it.
  status?: "done" | "reading" | "agent_app" | "no_turns" | "failed";
  claim?: { type?: string; afterHours: number };
  compartment?: string;
  kind?: "moment" | "meeting";
};

async function captureOf(seed: Seed, over: Seeded): Promise<{ evidenceId: string; claim: string | null }> {
  const compartment = over.compartment ?? "own";
  const { id, evidenceId, key } = await seed.capture([compartment]);
  const kind = over.kind ?? "moment";
  await moved("update knowledge.captures set kind = $2, capture_key = $3 where id = $1", [
    id,
    kind,
    key.replace("moment:", `${kind}:`),
  ]);
  await moved("update vault.evidence_items set ingested_at = $2 where id = $1", [evidenceId, over.ingested]);
  if (over.status !== undefined) {
    await seed.pipelineItem([compartment], evidenceId);
    if (over.status !== "done") {
      const facts = {
        lane: over.status === "failed" ? "moment" : "skip",
        override: false,
        status: over.status === "failed" ? "failed" : "skipped",
        code: over.status === "failed" ? "model_unavailable" : over.status,
        attempts: 0,
        claims: 0,
        unmapped: 0,
        unresolved: 0,
      };
      await moved("update vault.pipeline_items set facts_enc = $2 where evidence_id = $1", [
        evidenceId,
        sealRow(
          store.db.keys,
          compartment,
          { table: "vault.pipeline_items", id: evidenceId, column: "facts_enc" },
          JSON.stringify(facts),
        ),
      ]);
    }
  }
  if (over.claim === undefined) return { evidenceId, claim: null };
  const claim = await seed.claim([compartment], evidenceId);
  await moved("update knowledge.claims set type = $2, created_at = $3, first_known_at = $3 where id = $1", [
    claim,
    over.claim.type ?? "plan",
    after(over.ingested, over.claim.afterHours),
  ]);
  return { evidenceId, claim };
}

beforeAll(async () => {
  store = await openStore({ now: NOW, restricted: ["health"], writer: false });
  await session(store.db.urls.admin, async (query) => {
    const seed = seeder(store.db, query);
    const at = ago(2);
    // Asked: one with a model's fact in a day, one whose fact came late, one with only code's claim,
    // one with nothing.
    await captureOf(seed, { ingested: at, status: "done", claim: { afterHours: 12 } });
    await captureOf(seed, { ingested: at, status: "done", claim: { afterHours: 30 } });
    await captureOf(seed, { ingested: at, status: "done", claim: { type: "activity.messaged", afterHours: 1 } });
    await captureOf(seed, { ingested: at, status: "done" });
    // Asked, and the call failed: it counts, so a lane whose calls fail reads low.
    await captureOf(seed, { ingested: at, status: "failed" });
    // A model read it, and a run set it due again: it stays what its last commit said.
    const again = await captureOf(seed, { ingested: at, status: "done" });
    await moved("update vault.pipeline_items set waiting = true where evidence_id = $1", [again.evidenceId]);
    // Never for a model, whatever code's claim they hold; and one no run has taken.
    await captureOf(seed, { ingested: at, status: "reading", claim: { type: "capture.anchor", afterHours: 1 } });
    await captureOf(seed, { ingested: at, status: "reading" });
    await captureOf(seed, { ingested: at, status: "agent_app" });
    await captureOf(seed, { ingested: at, status: "no_turns" });
    await captureOf(seed, { ingested: at });
    // Outside the window, and a restricted one: in no count.
    await captureOf(seed, { ingested: ago(20), status: "done", claim: { afterHours: 1 } });
    await captureOf(seed, { ingested: at, status: "done", compartment: RESTRICTED, claim: { afterHours: 1 } });
    // A meeting with only its participants' claim has no fact in it.
    await captureOf(seed, { ingested: at, kind: "meeting", claim: { type: "capture.person", afterHours: 1 } });
    await captureOf(seed, { ingested: at, kind: "meeting", claim: { afterHours: 1 } });

    // Read back, 7 to 14 days ago: of four moments with a model's fact, one's fact was read within
    // the week, one's too late, one only by the mirror's sync, and one never. One with only code's
    // claim is no sample, though read.
    const old = ago(10);
    const session_ = (await seed.into("ledger.sessions")(["own"])) as { id: string; clientId: string };
    const read = async (seeded: { evidenceId: string; claim: string | null }, readAt: string, tool = "find_facts") => {
      const [row] = await query<{ fact_key_fp: string }>("select fact_key_fp from knowledge.claims where id = $1", [
        seeded.claim,
      ]);
      await moved(
        `insert into ledger.read_log (session_id, client_id, tool, read_at, compartments, bound, shown, fact_key_fps)
         values ($1, $2, $3, $4, '{own}', $5, '{}', $6)`,
        [session_.id, session_.clientId, tool, readAt, [seeded.evidenceId], [row?.fact_key_fp]],
      );
    };
    const served = await captureOf(seed, { ingested: old, status: "done", claim: { afterHours: 1 } });
    await read(served, after(old, 48));
    const late = await captureOf(seed, { ingested: ago(13), status: "done", claim: { afterHours: 1 } });
    await read(late, after(ago(13), 24 * 9));
    const synced = await captureOf(seed, { ingested: old, status: "done", claim: { afterHours: 1 } });
    await read(synced, after(old, 48), "sync_mirror");
    await captureOf(seed, { ingested: old, status: "done", claim: { afterHours: 1 } });
    const codeOnly = await captureOf(seed, {
      ingested: old,
      status: "done",
      claim: { type: "activity.messaged", afterHours: 1 },
    });
    await read(codeOnly, after(old, 48));
  });
  view = await store.admin.box.outcomes(14);
}, TIMEOUT);

afterAll(() => store?.close());

describe("pi outcomes: the moment lane", { timeout: TIMEOUT }, () => {
  it("takes the share over the moments a model read, counting a model's fact within a day", () => {
    expect(metric("capture_to_claim_24h_moments")).toMatchObject({
      value: 0.167,
      sample: 6,
      healthy: { test: "at_least", value: 0.1 },
      window: { fromDaysAgo: 7, toDaysAgo: 1 },
    });
  });

  it("tells what became of every moment received, by its code", () => {
    expect(metric("capture_to_claim_24h_moments").parts).toEqual({
      asked: 5,
      model_unavailable: 1,
      reading: 2,
      agent_app: 1,
      no_turns: 1,
      waiting: 1,
    });
  });

  it("counts a meeting's fact, never its participants' claim alone", () => {
    expect(metric("capture_to_claim_24h_meetings")).toMatchObject({ value: 0.5, sample: 2 });
  });

  it("reads back the moments with a fact that an agent was then served within a week", () => {
    expect(metric("moment_fact_read_back_7d")).toMatchObject({
      value: 0.25,
      sample: 4,
      window: { fromDaysAgo: 14, toDaysAgo: 7 },
      state: "no_data",
    });
  });
});

describe("pi outcomes: nothing received", { timeout: TIMEOUT }, () => {
  it("says so by code when no meeting and no moment arrived", async () => {
    const quiet = await openStore({ now: NOW, restricted: ["health"], writer: false });
    try {
      const { metrics } = await quiet.admin.box.outcomes(14);
      const of = (name: string) => metrics.find((one) => one.metric === name);
      expect(of("capture_to_claim_24h_meetings")).toMatchObject({ sample: 0, state: "no_data", code: "none_received" });
      expect(of("capture_to_claim_24h_moments")).toMatchObject({ sample: 0, state: "no_data", code: "none_asked" });
    } finally {
      await quiet.close();
    }
  });
});
