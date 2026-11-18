import { randomBytes } from "node:crypto";
import { DECISION_POINT_PINS, type IntentId, type RulingId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { newId } from "../../core/ids.ts";
import { writeDecision } from "../../core/queue.ts";
import { sealUnder } from "../../core/seal.ts";
import { testId } from "../../test-support/clients.ts";
import { one, readAs, session } from "../../test-support/connections.ts";
import { adminRows as rows } from "../../test-support/database.ts";
import { seeder } from "../../test-support/seeder.ts";
import { inStore, type TestStore } from "../../test-support/store.ts";
import { refusedWith, registration } from "../../test-support/values.ts";
import { openWorkSession } from "../../test-support/work-clients.ts";

// The four grants that wrote no decision now write one, and the reasoner's clearance is a combining
// grant the owner sets. Made-up values only.

const TIMEOUT = 120_000;
const T0 = new Date("2026-10-05T09:00:00.000Z");
const BOTH = ["employer:example", "own"];

const request = (): string => randomBytes(12).toString("base64url");

type DecisionRow = {
  kind: string;
  target_kind: string | null;
  target_id: string | null;
  answer: string | null;
  card_id: string | null;
  batch: boolean;
  labels: string[];
  details: Record<string, unknown>;
  decided_at: Date;
  compartments: string[];
};
const decisions = (store: TestStore, kinds: string[]): Promise<DecisionRow[]> =>
  rows<DecisionRow>(
    store,
    `select kind, target_kind, target_id, answer, card_id, batch, labels, details, decided_at, compartments from knowledge.owner_decisions
     where kind = any ($1) order by decided_at, id collate "C"`,
    [kinds],
  );

const withStore = (fn: (store: TestStore) => Promise<void>): Promise<void> => inStore({ now: T0, writer: false }, fn);

const agent = (store: TestStore, name: string) =>
  store.admin.clients.addClient(
    registration(name, ["own"], {
      views: ["self", "people", "work"],
      tools: ["get_self", "list_opportunities", "claim_opportunity"],
    }),
  );
const reasonerRegistration = (name: string, compartments: string[]) =>
  registration(name, compartments, {
    kind: "reasoner",
    views: ["self", "people", "work"],
    tools: ["get_self", "next_run", "append_step", "finish_run"],
  });

const GRANT = {
  kind: "",
  target_kind: "",
  answer: null,
  card_id: null,
  batch: false,
  labels: [],
  compartments: ["own"],
};

describe("the four grants each write one owner decision", { timeout: TIMEOUT }, () => {
  it("intent add, intent revoke, harness grant and harness revoke each write one owner decision of their kind, in the same transaction as the policy row", () =>
    withStore(async (store) => {
      await agent(store, "mover");
      const intent = await store.admin.work.addIntent({ kinds: ["investigate"], clients: ["mover"] });
      const harness = await store.admin.work.grantHarnessMode({
        client: "mover",
        kind: "investigate",
        stage: "investigate",
        mode: "act",
      });
      expect(await store.admin.work.revokeIntent(intent)).toBe(true);
      expect(await store.admin.work.revokeHarnessMode(harness)).toBe(true);

      const written = await decisions(store, ["intent_confirm", "intent_revoke", "harness_grant", "harness_revoke"]);
      expect(written.map(({ decided_at: _, ...row }) => row)).toEqual([
        { ...GRANT, kind: "intent_confirm", target_kind: "intent", target_id: intent, details: {} },
        { ...GRANT, kind: "harness_grant", target_kind: "harness_mode", target_id: harness, details: {} },
        { ...GRANT, kind: "intent_revoke", target_kind: "intent", target_id: intent, details: {} },
        { ...GRANT, kind: "harness_revoke", target_kind: "harness_mode", target_id: harness, details: {} },
      ]);
      // Each decision is the policy row's own moment: written in its transaction, at its clock.
      const [policy] = await rows<{ confirmed_at: Date; revoked_at: Date }>(
        store,
        "select confirmed_at, revoked_at from policy.intents where id = $1",
        [intent],
      );
      const [mode] = await rows<{ granted_at: Date; revoked_at: Date }>(
        store,
        "select granted_at, revoked_at from policy.harness_modes where id = $1",
        [harness],
      );
      expect(written.map((row) => row.decided_at.toISOString())).toEqual(
        [policy?.confirmed_at, mode?.granted_at, policy?.revoked_at, mode?.revoked_at].map((at) => at?.toISOString()),
      );
    }));

  it("a failed grant writes no decision", () =>
    withStore(async (store) => {
      await agent(store, "mover");
      // An unknown client, an unknown goal, and an id that is no intent or harness mode.
      expect(
        await refusedWith(() => store.admin.work.addIntent({ kinds: ["investigate"], clients: ["nobody"] })),
      ).toEqual({ name: "AdminError", code: "not_found" });
      expect(
        await refusedWith(() =>
          store.admin.work.addIntent({ kinds: ["investigate"], clients: ["mover"], goal: newId("gol") as never }),
        ),
      ).toEqual({ name: "AdminError", code: "not_found" });
      expect(
        await refusedWith(() =>
          store.admin.work.grantHarnessMode({
            client: "nobody",
            kind: "investigate",
            stage: "investigate",
            mode: "act",
          }),
        ),
      ).toEqual({
        name: "AdminError",
        code: "not_found",
      });
      expect(await store.admin.work.revokeIntent(newId("int") as IntentId)).toBe(false);
      expect(await store.admin.work.revokeHarnessMode(newId("hrn") as never)).toBe(false);
      expect(await decisions(store, ["intent_confirm", "intent_revoke", "harness_grant", "harness_revoke"])).toEqual(
        [],
      );
      expect(await rows(store, "select id from policy.intents union all select id from policy.harness_modes")).toEqual(
        [],
      );

      // A revoke that repeats another revoke's request id is refused and revokes nothing.
      const other = await store.admin.work.addIntent({ kinds: ["reply"], clients: ["mover"] });
      const reused = request();
      const first = await store.admin.work.addIntent({ kinds: ["investigate"], clients: ["mover"] });
      expect(await store.admin.work.revokeIntent(first, { requestId: reused })).toBe(true);
      expect(await refusedWith(() => store.admin.work.revokeIntent(other, { requestId: reused }))).toEqual({
        name: "AdminError",
        code: "invalid_argument",
      });
      expect(
        (
          await rows<{ revoked: boolean }>(
            store,
            "select revoked_at is not null as revoked from policy.intents where id = $1",
            [other],
          )
        )[0]?.revoked,
      ).toBe(false);
      expect((await decisions(store, ["intent_revoke"])).map((row) => row.target_id)).toEqual([first]);

      // A revoke of a row already revoked writes no second decision.
      const intent = await store.admin.work.addIntent({ kinds: ["investigate"], clients: ["mover"] });
      expect(await store.admin.work.revokeIntent(intent)).toBe(true);
      expect(await store.admin.work.revokeIntent(intent)).toBe(false);
      expect((await decisions(store, ["intent_revoke"])).length).toBe(2);
    }));

  it("intent_confirm details are empty for pi intent add and { proposal } when a proposal id is given, and refuse any other key", () =>
    withStore(async (store) => {
      await agent(store, "mover");
      const proposal = testId("prp");
      const plain = await store.admin.work.addIntent({ kinds: ["investigate"], clients: ["mover"] });
      const accepted = await store.admin.work.addIntent({ kinds: ["reply"], clients: ["mover"], proposal });
      expect((await decisions(store, ["intent_confirm"])).map((row) => [row.target_id, row.details])).toEqual([
        [plain, {}],
        [accepted, { proposal }],
      ]);
      // A proposal id of another form is refused before anything is written.
      expect(
        await refusedWith(() =>
          store.admin.work.addIntent({ kinds: ["reply"], clients: ["mover"], proposal: "prp_short" }),
        ),
      ).toEqual({ name: "AdminError", code: "invalid_argument" });
      expect((await rows(store, "select id from policy.intents")).length).toBe(2);
      // Any other key is refused by the details schema.
      const refused = await session(store.db.urls.admin, (query) =>
        refusedWith(() =>
          writeDecision(
            query,
            {
              id: newId("rul") as RulingId,
              requestId: request(),
              kind: "intent_confirm",
              target: { kind: "intent", id: plain },
              answer: null,
              card: null,
              supersedes: null,
              batch: false,
              labels: [],
              details: { proposal, other: 1 } as never,
              compartments: ["own"],
            },
            { now: T0 },
          ),
        ),
      );
      expect(refused.code).toBe("invalid_argument");
      expect((await decisions(store, ["intent_confirm"])).length).toBe(2);
    }));

  it("a repeated request id returns the first intent and writes no second row or decision", () =>
    withStore(async (store) => {
      await agent(store, "mover");
      const requestId = request();
      const first = await store.admin.work.addIntent({ kinds: ["investigate"], clients: ["mover"] }, { requestId });
      expect(await store.admin.work.addIntent({ kinds: ["investigate"], clients: ["mover"] }, { requestId })).toBe(
        first,
      );
      expect((await rows(store, "select id from policy.intents")).length).toBe(1);
      expect((await decisions(store, ["intent_confirm"])).length).toBe(1);
    }));
});

describe("the combining grant", { timeout: TIMEOUT }, () => {
  it("registering the reasoner, and changing its compartments, each write one combining_grant decision with the compartments in its details, in the same transaction", () =>
    withStore(async (store) => {
      await store.admin.clients.addClient(reasonerRegistration("thinker", ["own", "employer:example"]));
      const [client] = await rows<{ id: string; created_at: Date }>(
        store,
        "select id, created_at from policy.clients where name = 'thinker'",
      );
      const written = await decisions(store, ["combining_grant"]);
      expect(written.map(({ decided_at: _, ...row }) => row)).toEqual([
        {
          ...GRANT,
          kind: "combining_grant",
          target_kind: "client",
          target_id: client?.id,
          details: { compartments: BOTH },
        },
      ]);
      expect(written[0]?.decided_at.toISOString()).toBe(client?.created_at.toISOString());

      // No command changes a reasoner's compartments but its registration: a change of its tools
      // keeps them, and writes no grant.
      await store.admin.clients.setTools("thinker", ["get_self", "search", "next_run", "append_step", "finish_run"]);
      expect(
        (
          await rows<{ compartments: string[] }>(
            store,
            "select compartments from policy.clients where name = 'thinker'",
          )
        )[0]?.compartments,
      ).toEqual(["own", "employer:example"]);
      expect((await decisions(store, ["combining_grant"])).length).toBe(1);

      // An agent's registration is no combining grant; a refused registration writes none.
      await agent(store, "mover");
      expect(await refusedWith(() => store.admin.clients.addClient(reasonerRegistration("second", ["own"])))).toEqual({
        name: "AdminError",
        code: "invalid_registration",
      });
      expect((await decisions(store, ["combining_grant"])).length).toBe(1);
    }));

  it("a reasoner with restricted:health is refused, with restricted-compartments built or not", () =>
    withStore(async (store) => {
      expect(
        await refusedWith(() =>
          store.admin.clients.addClient(reasonerRegistration("thinker", ["own", "restricted:health"])),
        ),
      ).toEqual({ name: "AdminError", code: "invalid_registration" });
      expect(await rows(store, "select id from policy.clients")).toEqual([]);
      expect(await decisions(store, ["combining_grant"])).toEqual([]);
      // The control: the same registration without it.
      await store.admin.clients.addClient(reasonerRegistration("thinker", ["own"]));
      expect((await decisions(store, ["combining_grant"])).map((row) => row.details)).toEqual([
        { compartments: ["own"] },
      ]);
    }));

  it("a run that read own and employer:example writes an opportunity labelled with both, which a client cleared for own alone does not see, in the same bytes as before it existed", () =>
    withStore(async (store) => {
      const { db } = store;
      // The reasoner holds the combining grant for both; the agent is cleared for own alone.
      const { token } = await store.admin.clients.addClient(reasonerRegistration("thinker", BOTH));
      const reasoner = { token, session: await openWorkSession(db, token) };
      const narrow = await store.admin.clients.addClient(
        registration("narrow", ["own"], {
          views: ["self", "people", "work"],
          tools: ["get_self", "list_opportunities"],
        }),
      );
      const listed = (tokenOf: string) =>
        readAs(db, tokenOf, (query) => query("select id, kind, compartments from ledger.opportunities order by id"));
      const before = JSON.stringify(await listed(narrow.token));

      // Two anchors, one of each label.
      const [own, employer] = await session(db.urls.admin, async (query) => {
        const seed = seeder(db, query);
        const made: string[] = [];
        for (const label of [["own"], ["employer:example"]])
          made.push(await seed.message(label, await seed.evidence(label, await seed.sourceAccount(label))));
        return made;
      });
      const run = testId("run");
      await session(db.urls.work, async (query) => {
        await query("begin");
        await query("select ledger.lock_rows($1::text[])", [[run]]);
        await query(
          `insert into ledger.runs (id, request_id, created_by, compartments, wake_source, wake_key, decision_point, definition_version, prompt_id, prompt_version)
           values ($1, $1, 'system:work', $2, 'owner_request', 'owner:' || $1, 'run_outcome', 1, 'personal_run', '1')`,
          [run, BOTH],
        );
        await query(
          "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('run', $1, 'queued', now(), 'system:work', $2)",
          [run, BOTH],
        );
        expect(
          one(
            await query<{ ok: boolean }>(
              "select ledger.add_basis('run', $1, $2::text[], $3::text[], $4::text[], null) as ok",
              [run, BOTH, ["message", "message"], [own, employer]],
            ),
          ).ok,
        ).toBe(true);
        await query("commit");
      });
      const reader = (text: string, values: unknown[]) => readAs(db, reasoner.token, (query) => query(text, values));
      expect(
        one(await reader("select run_id from ledger.next_run($1, $2)", [request(), reasoner.session])),
      ).toMatchObject({ run_id: run });
      const opportunity = testId("opp");
      const action = {
        do: "propose",
        id: opportunity,
        kind: "follow_up",
        about_kind: "message",
        about_id: employer,
        ref_kinds: ["message", "message"],
        ref_ids: [own, employer],
        due_at: new Date(T0.getTime() + 2 * 86_400_000).toISOString(),
        probability: 0.4,
        probability_if_waiting: 0.2,
        body_enc: sealUnder(
          db.keys,
          BOTH,
          { table: "ledger.opportunities", id: opportunity, column: "body_enc" },
          "made-up summary",
        ),
      };
      await reader("select * from ledger.finish_run($1, $2, $3, 'finished', null, 1, $4, $5::jsonb)", [
        run,
        request(),
        reasoner.session,
        DECISION_POINT_PINS["run_outcome@1"],
        JSON.stringify([action]),
      ]);

      expect(await rows(store, "select compartments from ledger.opportunities where id = $1", [opportunity])).toEqual([
        { compartments: BOTH },
      ]);
      expect((await listed(token)).map((row) => (row as { id: string }).id)).toContain(opportunity);
      expect(JSON.stringify(await listed(narrow.token))).toBe(before);
    }));
});
