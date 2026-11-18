import { randomBytes } from "node:crypto";
import { DECISION_POINT_PINS, type DecisionPointCall, type GoalId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { newId } from "../../core/ids.ts";
import { adminRows as rows } from "../../test-support/database.ts";
import { inStore, type TestStore } from "../../test-support/store.ts";
import { refusedWith, registration } from "../../test-support/values.ts";

const TIMEOUT = 120_000;
const T0 = new Date("2026-09-20T09:00:00.000Z");
const STATEMENT = "Canary goal: the heron survey";

const requestId = (): string => `req-${randomBytes(8).toString("hex")}`;
const notFound = { name: "AdminError", code: "not_found" };

const withWork = (fn: (store: TestStore) => Promise<void>): Promise<void> => inStore({ now: T0, writer: false }, fn);

const agent = (store: TestStore, name: string) =>
  store.admin.clients.addClient(
    registration(name, ["own"], {
      views: ["self", "people", "work"],
      tools: ["get_self", "list_opportunities", "claim_opportunity"],
    }),
  );
const reasoner = (store: TestStore, name = "thinker") =>
  store.admin.clients.addClient(
    registration(name, ["own"], {
      kind: "reasoner",
      views: ["self", "people", "work"],
      tools: ["get_self", "next_run", "append_step", "finish_run"],
    }),
  );

const runCall = (output: "run" | "skip"): DecisionPointCall => ({
  point: "wake_worth_run",
  version: 1,
  definitionHash: DECISION_POINT_PINS["wake_worth_run@1"] as string,
  rung: 0,
  inputHash: "a".repeat(64),
  output,
  effect: output === "run" ? "start_run" : "record_silence",
  effectClass: output === "run" ? "internal_reversible" : "narrow",
  escalated: false,
});

// A run with its events, as the reasoner's functions leave one: written here as pi_admin.
async function endedRun(store: TestStore, events: { event: string; code: string | null }[]): Promise<string> {
  const id = newId("run");
  await rows(
    store,
    `insert into ledger.runs (id, request_id, created_by, compartments, wake_source, wake_key, decision_point, definition_version, prompt_id, prompt_version)
     values ($1, $1, 'owner', '{own}', 'owner_request', 'test:' || $1, 'run_outcome', 1, 'personal_run', '1')`,
    [id],
  );
  for (const one of events) {
    await rows(
      store,
      "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments, code) values ('run', $1, $2, now(), 'system:test', '{own}', $3)",
      [id, one.event, one.code],
    );
  }
  return id;
}

describe("intents, harness modes, the switch and the budget", { timeout: TIMEOUT }, () => {
  it("a budget stores the input limit and the token price, and leaves what it was not given", () =>
    withWork(async (store) => {
      const settings = () =>
        rows(
          store,
          "select max_runs_per_day, max_microusd_per_day::text as usd, max_pending_cards, max_input_code_points, ceiling_microusd_per_token from policy.work_settings",
        );
      expect(await settings()).toEqual([
        {
          max_runs_per_day: 12,
          usd: "5000000",
          max_pending_cards: 30,
          max_input_code_points: 200_000,
          ceiling_microusd_per_token: 20,
        },
      ]);
      await store.admin.work.setWorkBudget({ inputChars: 150_000, tokenPrice: 35 });
      expect(await settings()).toEqual([
        {
          max_runs_per_day: 12,
          usd: "5000000",
          max_pending_cards: 30,
          max_input_code_points: 150_000,
          ceiling_microusd_per_token: 35,
        },
      ]);
      await store.admin.work.setWorkBudget({ runs: 4, usd: 2.5, cards: 10 });
      expect(await settings()).toEqual([
        {
          max_runs_per_day: 4,
          usd: "2500000",
          max_pending_cards: 10,
          max_input_code_points: 150_000,
          ceiling_microusd_per_token: 35,
        },
      ]);
      expect(await refusedWith(() => store.admin.work.setWorkBudget({ runs: -1 }))).toEqual({
        name: "AdminError",
        code: "invalid_argument",
      });
      // The sweep's hour, 0 to 23.
      for (const sweepHour of [24, -1, 6.5])
        expect(await refusedWith(() => store.admin.work.setWorkBudget({ sweepHour }))).toEqual({
          name: "AdminError",
          code: "invalid_argument",
        });
    }));

  it("work status shows the last runs' codes", () =>
    withWork(async (store) => {
      const runs: string[] = [];
      for (const code of ["turn_limit", "budget", "timeout", "model_unavailable", "kill_switch", "erasure"])
        runs.push(
          await endedRun(store, [
            { event: "queued", code: null },
            { event: "failed", code },
          ]),
        );
      runs.push(
        await endedRun(store, [
          { event: "queued", code: null },
          { event: "finished", code: null },
        ]),
      );
      const status = await store.admin.work.status();
      expect(status.lastRuns).toHaveLength(5);
      expect(new Set(status.lastRuns.map((run) => `${run.outcome}:${run.code}`))).toEqual(
        new Set([
          "failed:timeout",
          "failed:model_unavailable",
          "failed:kill_switch",
          "failed:erasure",
          "finished:null",
        ]),
      );
      expect(status.runs).toEqual({ failed: 6, finished: 1 });
      expect(status.killSwitch).toBe("off");
      expect(status.today).toEqual({
        runs: 0,
        maxRuns: 12,
        spentMicroUsd: 0,
        maxMicroUsd: 5_000_000,
      });
    }));

  it("an intent is confirmed by being made, and revoked by revoke", () =>
    withWork(async (store) => {
      await agent(store, "worker");
      const intent = await store.admin.work.addIntent({ kinds: ["meeting_prep", "investigate"], clients: ["worker"] });
      expect(await store.admin.work.listIntents()).toEqual([
        {
          id: intent,
          goal: null,
          kinds: ["meeting_prep", "investigate"],
          clients: ["worker"],
          mode: "owner_decides",
          maxOpen: 5,
          confirmedAt: T0.toISOString(),
          revokedAt: null,
          role: null,
        },
      ]);
      expect(await store.admin.work.revokeIntent(intent)).toBe(true);
      expect(await store.admin.work.revokeIntent(intent)).toBe(false);
      expect((await store.admin.work.listIntents())[0]?.revokedAt).toBe(T0.toISOString());
    }));

  it("an intent for a client that does not exist, or for the reasoner, is not_found", () =>
    withWork(async (store) => {
      await agent(store, "worker");
      await reasoner(store);
      expect(
        await refusedWith(() => store.admin.work.addIntent({ kinds: ["investigate"], clients: ["nobody"] })),
      ).toEqual(notFound);
      expect(
        await refusedWith(() => store.admin.work.addIntent({ kinds: ["investigate"], clients: ["worker", "thinker"] })),
      ).toEqual(notFound);
      expect(await store.admin.work.listIntents()).toEqual([]);
      // The positive control.
      await store.admin.work.addIntent({ kinds: ["investigate"], clients: ["worker"] });
      expect(await store.admin.work.listIntents()).toHaveLength(1);
    }));

  it("an intent's mode is owner_decides unless policy is asked for", () =>
    withWork(async (store) => {
      await agent(store, "worker");
      await store.admin.work.addIntent({ kinds: ["investigate"], clients: ["worker"] });
      await store.admin.work.addIntent({
        kinds: ["life_admin"],
        clients: ["worker"],
        mode: "policy_decides",
        maxOpen: 2,
      });
      expect((await store.admin.work.listIntents()).map((one) => [one.kinds[0], one.mode, one.maxOpen])).toEqual([
        ["investigate", "owner_decides", 5],
        ["life_admin", "policy_decides", 2],
      ]);
    }));

  it("a harness mode for draft, send or pay is not_built", () =>
    withWork(async (store) => {
      await agent(store, "worker");
      for (const stage of ["draft", "send"] as const) {
        expect(
          await refusedWith(() =>
            store.admin.work.grantHarnessMode({ client: "worker", kind: "reply", stage, mode: "act" }),
          ),
        ).toEqual({ name: "AdminError", code: "not_built" });
      }
      expect(
        await refusedWith(() =>
          store.admin.work.grantHarnessMode({ client: "worker", kind: "life_admin", stage: "pay", mode: "propose" }),
        ),
      ).toEqual({ name: "AdminError", code: "not_built" });
      expect(
        await refusedWith(() =>
          store.admin.work.grantHarnessMode({
            client: "worker",
            kind: "investigate",
            stage: "investigate",
            mode: "propose",
          }),
        ),
      ).toEqual({ name: "AdminError", code: "not_built" });
      expect(await store.admin.work.listHarnessModes()).toEqual([]);
      // The positive control, then its revocation.
      const id = await store.admin.work.grantHarnessMode({
        client: "worker",
        kind: "investigate",
        stage: "investigate",
        mode: "act",
      });
      expect(await store.admin.work.listHarnessModes()).toEqual([
        {
          id,
          client: "worker",
          kind: "investigate",
          stage: "investigate",
          mode: "act",
          grantedAt: T0.toISOString(),
          revokedAt: null,
        },
      ]);
      expect(await store.admin.work.revokeHarnessMode(id)).toBe(true);
      expect(await store.admin.work.revokeHarnessMode(id)).toBe(false);
      expect(
        await refusedWith(() =>
          store.admin.work.grantHarnessMode({
            client: "nobody",
            kind: "investigate",
            stage: "investigate",
            mode: "act",
          }),
        ),
      ).toEqual(notFound);
    }));

  it("the kill switch is its latest row", () =>
    withWork(async (store) => {
      expect((await store.admin.work.status()).killSwitch).toBe("off");
      await store.admin.work.setKillSwitch("on", { requestId: requestId() });
      expect((await store.admin.work.status()).killSwitch).toBe("on");
      expect((await store.admin.work.wakeFacts()).killSwitch).toBe(true);
      await store.admin.work.setKillSwitch("off", { requestId: requestId() });
      await store.admin.work.setKillSwitch("on", { requestId: requestId() });
      await store.admin.work.setKillSwitch("off", { requestId: requestId() });
      expect((await store.admin.work.status()).killSwitch).toBe("off");
      expect(await rows(store, "select state, created_by, compartments from ledger.kill_switch order by id")).toEqual(
        ["on", "off", "on", "off"].map((state) => ({ state, created_by: "owner", compartments: ["own"] })),
      );
    }));

  it("a requested run is queued with its anchor in the basis", () =>
    withWork(async (store) => {
      const goal = (await store.admin.work.addGoal(STATEMENT, "employer:example", {
        requestId: requestId(),
      })) as GoalId;
      const request = requestId();
      const run = await store.admin.work.queueRequestedRun({ goal }, runCall("run"), { requestId: request });
      expect(await store.admin.work.queueRequestedRun({ goal }, runCall("run"), { requestId: request })).toBe(run);
      expect(
        await rows(
          store,
          "select id, created_by, compartments, wake_source, wake_key, decision_point, prompt_id from ledger.runs",
        ),
      ).toEqual([
        {
          id: run,
          created_by: "owner",
          compartments: ["employer:example"],
          wake_source: "owner_request",
          wake_key: `owner:${request}`,
          decision_point: "run_outcome",
          prompt_id: "personal_ideas",
        },
      ]);
      expect(
        await rows(store, "select event, by from ledger.record_events where row_kind = 'run' and row_id = $1", [run]),
      ).toEqual([{ event: "queued", by: "owner" }]);
      expect(
        await rows(store, "select row_kind, ref_kind, ref_id, source_class from ledger.basis where row_id = $1", [run]),
      ).toEqual([{ row_kind: "run", ref_kind: "goal", ref_id: goal, source_class: "owner" }]);
      expect(
        await rows(
          store,
          "select point, output, effect, subject_kind, subject_id, compartments from ledger.decision_point_calls",
        ),
      ).toEqual([
        {
          point: "wake_worth_run",
          output: "run",
          effect: "start_run",
          subject_kind: "run",
          subject_id: run,
          compartments: ["employer:example"],
        },
      ]);
      // A silence writes its row and its call, and no run.
      await store.admin.work.silenceRequestedRun({}, "budget", runCall("skip"), {
        requestId: request.replace("req-", "sil-"),
      });
      expect(
        await rows(store, "select reason, wake_source, compartments, day::text as day from ledger.silences"),
      ).toEqual([{ reason: "budget", wake_source: "owner_request", compartments: ["own"], day: "2026-09-20" }]);
      expect(await rows(store, "select count(*)::int as n from ledger.runs")).toEqual([{ n: 1 }]);
      expect(await rows(store, "select count(*)::int as n from ledger.decision_point_calls")).toEqual([{ n: 2 }]);
      // An anchor that does not exist queues nothing.
      expect(
        await refusedWith(() =>
          store.admin.work.queueRequestedRun({ goal: `gol_${"0".repeat(26)}` as GoalId }, runCall("run"), {
            requestId: requestId(),
          }),
        ),
      ).toEqual(notFound);
    }));

  it("a requested run whose anchor lies outside the reasoner's compartments queues nothing and writes nothing", () =>
    withWork(async (store) => {
      await reasoner(store);
      const goal = (await store.admin.work.addGoal(STATEMENT, "employer:example", {
        requestId: requestId(),
      })) as GoalId;
      const counts = () =>
        rows(
          store,
          "select (select count(*)::int from ledger.runs) as runs, (select count(*)::int from ledger.silences) as silences, (select count(*)::int from ledger.decision_point_calls) as calls",
        );
      const before = await counts();
      expect(
        await refusedWith(() =>
          store.admin.work.queueRequestedRun({ goal }, runCall("run"), { requestId: requestId() }),
        ),
      ).toEqual(notFound);
      expect(
        await refusedWith(() =>
          store.admin.work.silenceRequestedRun({ goal }, "budget", runCall("skip"), { requestId: requestId() }),
        ),
      ).toEqual(notFound);
      expect(await counts()).toEqual(before);
      // The positive control: a goal within its compartments is queued.
      const own = (await store.admin.work.addGoal(STATEMENT, "own", { requestId: requestId() })) as GoalId;
      await store.admin.work.queueRequestedRun({ goal: own }, runCall("run"), { requestId: requestId() });
      expect(await rows(store, "select count(*)::int as n from ledger.runs")).toEqual([{ n: 1 }]);
    }));

  it("setTools checks a reasoner as a reasoner", () =>
    withWork(async (store) => {
      await reasoner(store);
      await store.admin.clients.setTools("thinker", ["get_self", "search", "next_run"]);
      expect((await store.admin.clients.listClients()).map((one) => [one.name, one.kind, one.tools])).toEqual([
        ["thinker", "reasoner", ["get_self", "search", "next_run"]],
      ]);
      for (const tools of [
        ["get_self", "record"],
        ["get_self", "claim_opportunity"],
      ]) {
        expect(
          await refusedWith(() => store.admin.clients.setTools("thinker", tools as never)),
          tools.join(","),
        ).toEqual({
          name: "AdminError",
          code: "invalid_registration",
        });
      }
      expect((await store.admin.clients.listClients())[0]?.compartments).toEqual(["own"]);
    }));

  it("work status holds no statement, summary or name", () =>
    withWork(async (store) => {
      await agent(store, "heron-worker");
      await reasoner(store, "heron-thinker");
      await store.admin.work.addGoal(STATEMENT, "own", { requestId: requestId() });
      await store.admin.work.addIntent({ kinds: ["investigate"], clients: ["heron-worker"] });
      await endedRun(store, [{ event: "failed", code: "timeout" }]);
      const text = JSON.stringify(await store.admin.work.status());
      for (const needle of ["canary", "heron", "Canary"]) expect(text).not.toContain(needle);
      expect(JSON.parse(text)).toMatchObject({
        goals: { active: 1 },
        runs: { failed: 1 },
        cards: { pending: 0, deferred: 0, maxPending: 30 },
      });
    }));

  it("work status counts the cards waiting as the queue lists them: one past its expiry waits no more", () =>
    withWork(async (store) => {
      const card = async (expiresAt: string | null): Promise<void> => {
        const id = newId("crd");
        await rows(
          store,
          "insert into ledger.cards (id, request_id, created_at, created_by, kind, options, expires_at, expires_after_days, compartments) values ($1, $1, $2, 'system:test', 'notice', '{acknowledge}', $3, null, '{own}')",
          [id, T0, expiresAt],
        );
        await rows(
          store,
          "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'pending', $2, 'system:test', '{own}')",
          [id, T0],
        );
      };
      await card(null);
      await card("2026-09-19T00:00:00.000Z");
      expect((await store.admin.work.status()).cards.pending).toBe((await store.admin.cards.listPending({})).length);
      expect((await store.admin.work.status()).cards.pending).toBe(1);
    }));
});
