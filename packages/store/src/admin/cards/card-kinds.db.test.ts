import { randomBytes } from "node:crypto";
import { type CardId, currentDefinition, type NewCard, type OpportunityKind } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { newId } from "../../core/ids.ts";
import { sealUnder } from "../../core/seal.ts";
import { asWords } from "../../test-support/card-lines.ts";
import { session } from "../../test-support/connections.ts";
import { adminRows as rows } from "../../test-support/database.ts";
import { seeder } from "../../test-support/seeder.ts";
import { inStore, type TestStore } from "../../test-support/store.ts";
import { refusedWith, registration } from "../../test-support/values.ts";
import { Admin } from "../admin.ts";
import { CARD_KINDS } from "./card-kinds.ts";

const TIMEOUT = 120_000;
const T0 = new Date("2026-09-20T09:00:00.000Z");
const DAY_MS = 86_400_000;
const HANDED_LINE =
  "no registered agent can carry this out before the send item is built; go means you will do it yourself";

const requestId = (): string => `req-${randomBytes(8).toString("hex")}`;

// A ledger row as pi_owner, as the definer functions write one.
async function asOwner(store: TestStore, table: string, row: Record<string, unknown>): Promise<void> {
  const columns = Object.keys(row);
  await session(store.db.urls.bootstrap, async (query) => {
    await query("set role pi_owner");
    await query(
      `insert into ${table} (${columns.join(", ")}) values (${columns.map((_, n) => `$${n + 1}`).join(", ")})`,
      columns.map((column) => row[column]),
    );
  });
}

const event = (store: TestStore, rowKind: string, id: string, name: string, compartments = ["own"]) =>
  rows(
    store,
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ($1, $2, $3, $4, 'system:test', $5)",
    [rowKind, id, name, T0.toISOString(), compartments],
  );
const latest = async (store: TestStore, rowKind: string, id: string): Promise<string | undefined> =>
  (
    await rows<{ event: string }>(
      store,
      "select event from ledger.record_events where row_kind = $1 and row_id = $2 order by id desc limit 1",
      [rowKind, id],
    )
  )[0]?.event;
const eventsOf = async (store: TestStore, rowKind: string, id: string): Promise<string[]> =>
  (
    await rows<{ event: string }>(
      store,
      "select event from ledger.record_events where row_kind = $1 and row_id = $2 order by id",
      [rowKind, id],
    )
  ).map((one) => one.event);

async function workCase(
  store: TestStore,
  rowKind: string,
  kind: string,
  author: string,
  aboutOwner = false,
): Promise<{ id: string; aboutId: string | null }> {
  const id = newId("cas");
  const aboutId = aboutOwner ? null : newId("gol");
  await asOwner(store, "ledger.cases", {
    id,
    request_id: id,
    created_by: "system:test",
    compartments: ["own"],
    row_kind: rowKind,
    kind,
    about_kind: aboutId === null ? "owner" : "goal",
    about_id: aboutId,
    author,
  });
  return { id, aboutId };
}

// An opportunity in a status, written by a run or by a client, with a summary.
async function opportunity(
  store: TestStore,
  kind: OpportunityKind,
  status: string,
  options: { by?: "run" | "client"; summary?: string; hypothesis?: string; tier?: "task" } = {},
): Promise<string> {
  const author = options.by === "client" ? `client:${newId("cli")}` : `run:${newId("run")}`;
  const { id: caseId, aboutId } = await workCase(
    store,
    "opportunity",
    kind,
    author.startsWith("run:") ? "run" : author,
  );
  const id = newId("opp");
  await asOwner(store, "ledger.opportunities", {
    id,
    request_id: id,
    created_by: author,
    compartments: ["own"],
    case_id: caseId,
    kind,
    about_kind: "goal",
    about_id: aboutId,
    proposed_by_class: options.by ?? "run",
    hypothesis_id: options.hypothesis ?? null,
    ...(options.tier === undefined ? {} : { tier: options.tier }),
    body_enc: sealUnder(
      store.db.keys,
      ["own"],
      { table: "ledger.opportunities", id, column: "body_enc" },
      options.summary ?? "Canary opportunity summary",
    ),
  });
  await event(store, "opportunity", id, "proposed");
  if (status !== "proposed") await event(store, "opportunity", id, status);
  return id;
}

async function intention(
  store: TestStore,
  kind: "remind" | "check_back",
  options: { opportunity?: string; summary?: string } = {},
): Promise<string> {
  const id = newId("itn");
  await asOwner(store, "ledger.intentions", {
    id,
    request_id: id,
    created_by: `run:${newId("run")}`,
    compartments: ["own"],
    opportunity_id: options.opportunity ?? null,
    kind,
    due_at: T0.toISOString(),
    body_enc:
      options.summary === undefined
        ? null
        : sealUnder(store.db.keys, ["own"], { table: "ledger.intentions", id, column: "body_enc" }, options.summary),
  });
  await event(store, "intention", id, "set");
  return id;
}

async function hypothesis(store: TestStore, aboutOwner: boolean, summary?: string): Promise<string> {
  // A case of its own each time: an author no other hypothesis has.
  const { id: caseId, aboutId } = await workCase(
    store,
    "hypothesis",
    aboutOwner ? "preference" : "open_loop",
    `client:${newId("cli")}`,
    aboutOwner,
  );
  const id = newId("hyp");
  await asOwner(store, "ledger.hypotheses", {
    id,
    request_id: id,
    created_by: `run:${newId("run")}`,
    compartments: ["own"],
    case_id: caseId,
    kind: aboutOwner ? "preference" : "open_loop",
    about_kind: aboutOwner ? "owner" : "goal",
    about_id: aboutOwner ? null : aboutId,
    about_owner: aboutOwner,
    body_enc:
      summary === undefined
        ? null
        : sealUnder(store.db.keys, ["own"], { table: "ledger.hypotheses", id, column: "body_enc" }, summary),
  });
  await event(store, "hypothesis", id, "open");
  await event(store, "hypothesis", id, "asked");
  return id;
}

// A move of an agent's on the opportunity, done, with a report that carries a summary.
async function reportedMove(store: TestStore, opportunityId: string, summary: string): Promise<string> {
  await store.admin.clients.addClient(
    registration("mover", ["own"], { views: ["self", "work"], tools: ["get_self", "plan_move", "report_move"] }),
  );
  const intent = await store.admin.work.addIntent({ kinds: ["meeting_prep"], clients: ["mover"] });
  const harness = await store.admin.work.grantHarnessMode({
    client: "mover",
    kind: "meeting_prep",
    stage: "prepare",
    mode: "act",
  });
  const [client] = await rows<{ id: string }>(store, "select id from policy.clients where name = 'mover'");
  const [decision] = await rows<{ id: string }>(
    store,
    "insert into ledger.opportunity_decisions (request_id, created_by, compartments, opportunity_id, decision, decided_by, rung, intent_id) values ($1, 'owner', '{own}', $2, 'go', 'owner', 4, $3) returning id::text as id",
    [requestId(), opportunityId, intent],
  );
  const assignment = newId("asg");
  await asOwner(store, "ledger.assignments", {
    id: assignment,
    request_id: assignment,
    created_by: "system:test",
    compartments: ["own"],
    opportunity_id: opportunityId,
    client_id: client?.id,
    intent_id: intent,
  });
  const move = newId("mov");
  await asOwner(store, "ledger.moves", {
    id: move,
    request_id: move,
    created_by: `client:${client?.id}`,
    compartments: ["own"],
    opportunity_id: opportunityId,
    assignment_id: assignment,
    stage: "prepare",
    harness_mode_id: harness,
    decision_id: decision?.id,
    intent_id: intent,
    effect_class: "internal_reversible",
  });
  await event(store, "move", move, "done");
  await rows(
    store,
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments, body_enc) values ('move', $1, 'reported', $2, 'system:test', '{own}', $3)",
    [
      move,
      T0.toISOString(),
      sealUnder(
        store.db.keys,
        ["own"],
        { table: "ledger.record_events", id: `${move}/reported`, column: "body_enc" },
        summary,
      ),
    ],
  );
  return move;
}

const card = (kind: string, target: NewCard["target"], over: Partial<NewCard> = {}): NewCard => ({
  id: newId("crd") as CardId,
  requestId: requestId(),
  kind,
  author: "reasoner",
  options: [...(CARD_KINDS[kind]?.options ?? [])],
  target,
  refs: [],
  compartments: ["own"],
  expiresAt: null,
  expiresAfterDays: 14,
  caseKey: null,
  run: null,
  body: null,
  bodyFrom: null,
  ...over,
});

async function raised(store: TestStore, kind: string, target: NewCard["target"]): Promise<CardId> {
  const made = card(kind, target);
  await store.admin.cards.raiseCard(made);
  return made.id;
}

const answer = (store: TestStore, id: CardId, given: string) =>
  store.admin.cards.decide({ cards: [id], answer: given, requestId: requestId() });

const withCards = (fn: (store: TestStore) => Promise<void>): Promise<void> => inStore({ now: T0, writer: false }, fn);

const worker = (store: TestStore, name = "worker") =>
  store.admin.clients.addClient(
    registration(name, ["own"], {
      views: ["self", "work"],
      tools: ["get_self", "list_opportunities", "claim_opportunity"],
    }),
  );

type DecisionRow = {
  decision: string;
  decided_by: string;
  rung: number;
  intent_id: string | null;
  ruling_id: string | null;
  check_back_at: Date | null;
  compartments: string[];
};
const decisionsOf = (store: TestStore, id: string) =>
  rows<DecisionRow>(
    store,
    "select decision, decided_by, rung, intent_id, ruling_id, check_back_at, compartments from ledger.opportunity_decisions where opportunity_id = $1 order by id",
    [id],
  );

describe("the four card kinds", { timeout: TIMEOUT }, () => {
  it("the owner's go on an opportunity with a matching intent makes it claimable", () =>
    withCards(async (store) => {
      await worker(store);
      const intent = await store.admin.work.addIntent({ kinds: ["investigate"], clients: ["worker"] });
      const id = await opportunity(store, "investigate", "proposed");
      const [ruled] = await answer(
        store,
        await raised(store, "opportunity_decision", { kind: "opportunity", id }),
        "go",
      );
      expect(await latest(store, "opportunity", id)).toBe("go");
      expect(await decisionsOf(store, id)).toEqual([
        {
          decision: "go",
          decided_by: "owner",
          rung: 4,
          intent_id: intent,
          ruling_id: ruled?.ruling,
          check_back_at: null,
          compartments: ["own"],
        },
      ]);
    }));

  it("the owner's go with no intent hands it to the owner", () =>
    withCards(async (store) => {
      const id = await opportunity(store, "investigate", "proposed");
      await answer(store, await raised(store, "opportunity_decision", { kind: "opportunity", id }), "go");
      expect(await latest(store, "opportunity", id)).toBe("handed_to_owner");
      expect(await decisionsOf(store, id)).toMatchObject([{ decision: "go", decided_by: "owner", intent_id: null }]);
      // Handed to the owner, it carries its outcome card (Done or Drop) at once, in
      // the same decision, not at the tick's next pass.
      expect(
        await rows(
          store,
          "select kind from ledger.cards where target_kind = 'opportunity' and target_id = $1 and kind = 'outcome'",
          [id],
        ),
      ).toEqual([{ kind: "outcome" }]);
      // With an intent that lists only a revoked client, and for a kind whose next stage leaves
      // the system, it is handed too.
      await worker(store, "gone");
      await store.admin.work.addIntent({ kinds: ["meeting_prep", "reply"], clients: ["gone"] });
      await store.admin.clients.revokeClient("gone");
      const prep = await opportunity(store, "meeting_prep", "proposed");
      await answer(store, await raised(store, "opportunity_decision", { kind: "opportunity", id: prep }), "go");
      expect(await latest(store, "opportunity", prep)).toBe("handed_to_owner");
      await worker(store);
      await store.admin.work.addIntent({ kinds: ["reply"], clients: ["worker"] });
      const reply = await opportunity(store, "reply", "proposed");
      await answer(store, await raised(store, "opportunity_decision", { kind: "opportunity", id: reply }), "go");
      expect(await latest(store, "opportunity", reply)).toBe("handed_to_owner");
    }));

  // A carded task the owner says go to is under the owner's task intent, which
  // lists no client, so it is claimable and never handed to the owner.
  it("the owner's go on a carded task attaches the task intent and makes it claimable", () =>
    withCards(async (store) => {
      await worker(store);
      await store.admin.work.addIntent({ kinds: ["investigate"], clients: ["worker"] });
      const tasks = await store.admin.work.setTaskTier(true);
      const id = await opportunity(store, "investigate", "proposed", { by: "client", tier: "task" });
      await answer(store, await raised(store, "opportunity_decision", { kind: "opportunity", id }), "go");
      expect(await latest(store, "opportunity", id)).toBe("go");
      expect(await decisionsOf(store, id)).toMatchObject([{ decision: "go", decided_by: "owner", intent_id: tasks }]);
    }));

  it("with two intents for the kind, the owner's go attaches the earlier confirmed one", () =>
    withCards(async (store) => {
      await worker(store);
      const later = new Admin({
        pool: store.adminPool,
        keys: store.db.keys,
        log: store.log,
        now: () => new Date(T0.getTime() + 60_000),
      });
      const second = await later.work.addIntent({ kinds: ["goal_step"], clients: ["worker"] });
      const first = await store.admin.work.addIntent({ kinds: ["goal_step", "life_admin"], clients: ["worker"] });
      expect(second).not.toBe(first);
      const id = await opportunity(store, "goal_step", "proposed");
      await answer(store, await raised(store, "opportunity_decision", { kind: "opportunity", id }), "go");
      expect(await decisionsOf(store, id)).toMatchObject([{ intent_id: first }]);
    }));

  it("the decision card of a reply and of a follow_up carries the line that go means the owner will do it, and a meeting_prep's does not", () =>
    withCards(async (store) => {
      for (const [kind, carries] of [
        ["reply", true],
        ["follow_up", true],
        ["meeting_prep", false],
      ] as const) {
        const id = await opportunity(store, kind, "proposed");
        const shown = await store.admin.cards.card(
          await raised(store, "opportunity_decision", { kind: "opportunity", id }),
        );
        const lines = asWords(shown?.lines ?? []);
        expect(
          lines.filter((line) => line.text === HANDED_LINE),
          kind,
        ).toEqual(carries ? [{ text: HANDED_LINE, from: "code" }] : []);
        expect(lines).toContainEqual({ text: `opportunity: ${kind}`, from: "code" });
        expect(shown?.lines).toContainEqual(
          expect.objectContaining({
            key: "work",
            value: [
              { kind: "code", code: "opportunity" },
              { kind: "code", code: kind },
            ],
          }),
        );
      }
    }));

  it("the decision card of a run's proposal shows the words of what it cites, and the hypothesis it follows from with the words of what that cites, each marked with who wrote it", () =>
    withCards(async (store) => {
      const cited = await session(store.db.urls.admin, async (query) => {
        const seed = seeder(store.db, query);
        const message = await seed.message(["own"], await seed.evidence(["own"], await seed.sourceAccount(["own"])));
        const other = await seed.message(["own"], await seed.evidence(["own"], await seed.sourceAccount(["own"])));
        const meeting = await seed.eventDetails(["own"]);
        const [alias] = await query<{ entity_id: string }>("select entity_id from knowledge.aliases where id = $1", [
          await seed.alias(["own"]),
        ]);
        return { message, other, meeting, person: alias?.entity_id ?? "" };
      });
      const basis = async (rowKind: string, rowId: string, refs: [string, string][]): Promise<void> => {
        for (const [refKind, refId] of refs) {
          await asOwner(store, "ledger.basis", {
            row_kind: rowKind,
            row_id: rowId,
            ref_kind: refKind,
            ref_id: refId,
            source_class: refKind === "entity" ? "derived" : "source",
            compartments: ["own"],
          });
        }
      };
      const hyp = await hypothesis(store, false, "Canary hypothesis: you appear to be hiring");
      await basis("hypothesis", hyp, [
        ["message", cited.message],
        ["entity", cited.person],
      ]);
      const id = await opportunity(store, "goal_step", "proposed", {
        summary: "Canary proposal: prepare a draft listing",
        hypothesis: hyp,
      });
      await basis("opportunity", id, [
        ["message", cited.message],
        ["event", cited.meeting],
        ["message", cited.other],
      ]);
      const shown = await store.admin.cards.card(
        await raised(store, "opportunity_decision", { kind: "opportunity", id }),
      );
      const lines = asWords(shown?.lines ?? []);
      const at = (text: string): number => lines.findIndex((line) => line.text === text);
      // The proposal's summary is the model's; its refs are code's; their words are the sources'.
      expect(lines).toContainEqual({ text: "Canary proposal: prepare a draft listing", from: "model" });
      // A cited person or message is a ref of its line; a meeting names nothing a task takes.
      expect(lines.filter((line) => line.text.startsWith("cited: "))).toEqual(
        [
          ["message", cited.message],
          ["event", cited.meeting],
          ["message", cited.other],
          ["entity", cited.person],
        ].map(([kind, id]) => ({
          text: `cited: ${kind} ${id}`,
          from: "code",
          ...(kind === "event" ? {} : { refs: [{ kind, id }] }),
        })),
      );
      const sourced = lines.filter((line) => line.from === "source").map((line) => line.text);
      expect(sourced).toHaveLength(6);
      for (const text of sourced) expect(text).toMatch(/^Seed (subject|Sender|title|Name) \d+$/);
      // Each source line follows its ref: a message's subject and sender, an event's title.
      expect(lines[at(`cited: message ${cited.message}`) + 1]?.text).toMatch(/^Seed subject/);
      expect(lines[at(`cited: message ${cited.message}`) + 2]?.text).toMatch(/^Seed Sender/);
      expect(lines[at(`cited: event ${cited.meeting}`) + 1]?.text).toMatch(/^Seed title/);
      expect(lines[at(`cited: entity ${cited.person}`) + 1]?.text).toMatch(/^Seed Name/);
      // The hypothesis follows the proposal, its summary the model's, and its message, cited by
      // the proposal too, is shown once.
      expect(at(`follows from: hypothesis ${hyp}`)).toBeGreaterThan(at(`cited: message ${cited.other}`));
      expect(lines).toContainEqual({ text: "hypothesis: open_loop", from: "code" });
      expect(lines).toContainEqual({ text: "Canary hypothesis: you appear to be hiring", from: "model" });
      expect(lines.filter((line) => line.text === `cited: message ${cited.message}`)).toHaveLength(1);
      // A question for the owner shows what it was drawn from, as an idea's
      // and a lesson's cards do.
      const asked = await store.admin.cards.card(
        await raised(store, "owner_question", { kind: "hypothesis", id: hyp }),
      );
      expect(asWords(asked?.lines ?? [])).toContainEqual({
        text: `cited: message ${cited.message}`,
        from: "code",
        refs: [{ kind: "message", id: cited.message }],
      });
      expect((asked?.lines ?? []).filter((line) => line.from === "source").length).toBeGreaterThan(0);
    }));

  it("acknowledging the outcome card of a handed opportunity ends it done, and dismissing it ends it no_go by the owner, after which the same case proposed again is closed by code", () =>
    withCards(async (store) => {
      const done = await opportunity(store, "reply", "handed_to_owner");
      const check = await intention(store, "check_back", { opportunity: done });
      await answer(store, await raised(store, "outcome", { kind: "opportunity", id: done }), "acknowledge");
      expect(await eventsOf(store, "opportunity", done)).toEqual(["proposed", "handed_to_owner", "done"]);
      expect(await latest(store, "intention", check)).toBe("cancelled");
      expect(await decisionsOf(store, done)).toEqual([]);

      const dismissed = await opportunity(store, "follow_up", "handed_to_owner");
      const [ruled] = await answer(
        store,
        await raised(store, "outcome", { kind: "opportunity", id: dismissed }),
        "dismiss",
      );
      expect(await latest(store, "opportunity", dismissed)).toBe("no_go");
      expect(await decisionsOf(store, dismissed)).toMatchObject([
        { decision: "no_go", decided_by: "owner", rung: 4, ruling_id: ruled?.ruling },
      ]);
      const [closed] = await rows<{ decision: string; decided_by: string }>(
        store,
        `select d.decision, d.decided_by from ledger.opportunity_decisions d join ledger.opportunities o on o.id = d.opportunity_id
         where o.case_id = (select case_id from ledger.opportunities where id = $1) and d.decided_by = 'owner' order by d.id desc limit 1`,
        [dismissed],
      );
      expect(closed).toEqual({ decision: "no_go", decided_by: "owner" });
    }));

  it("acknowledging an outcome card whose opportunity a veto has closed changes no status", () =>
    withCards(async (store) => {
      const id = await opportunity(store, "reply", "handed_to_owner");
      const raisedCard = await raised(store, "outcome", { kind: "opportunity", id });
      // The tick's veto closes it before the owner answers.
      await event(store, "opportunity", id, "no_go");
      const before = await eventsOf(store, "opportunity", id);
      await answer(store, raisedCard, "acknowledge");
      expect(await eventsOf(store, "opportunity", id)).toEqual(before);
      // The answer itself is recorded.
      expect(
        await rows(store, "select kind, answer, target_id from knowledge.owner_decisions where card_id = $1", [
          raisedCard,
        ]),
      ).toEqual([{ kind: "answer", answer: "acknowledge", target_id: id }]);
    }));

  it("the owner's no_go cancels the opportunity's check-back", () =>
    withCards(async (store) => {
      const id = await opportunity(store, "investigate", "later");
      const check = await intention(store, "check_back", { opportunity: id });
      await answer(store, await raised(store, "opportunity_decision", { kind: "opportunity", id }), "no_go");
      expect(await latest(store, "opportunity", id)).toBe("no_go");
      expect(await latest(store, "intention", check)).toBe("cancelled");
      // later sets a check-back seven days ahead.
      const deferred = await opportunity(store, "investigate", "proposed");
      await answer(store, await raised(store, "opportunity_decision", { kind: "opportunity", id: deferred }), "later");
      expect(await decisionsOf(store, deferred)).toMatchObject([
        { decision: "later", check_back_at: new Date(T0.getTime() + 7 * DAY_MS) },
      ]);
      expect(await latest(store, "opportunity", deferred)).toBe("later");
    }));

  it("confirming a question about the owner makes no opportunity and no move", () =>
    withCards(async (store) => {
      const id = await hypothesis(store, true);
      const counts = () =>
        rows(
          store,
          "select (select count(*)::int from ledger.opportunities) as opportunities, (select count(*)::int from ledger.moves) as moves",
        );
      const before = await counts();
      await answer(store, await raised(store, "owner_question", { kind: "hypothesis", id }), "confirm");
      expect(await latest(store, "hypothesis", id)).toBe("confirmed");
      expect(await counts()).toEqual(before);
      const rejected = await hypothesis(store, true);
      await answer(store, await raised(store, "owner_question", { kind: "hypothesis", id: rejected }), "reject");
      expect(await latest(store, "hypothesis", rejected)).toBe("rejected");
      const skipped = await hypothesis(store, true);
      await answer(store, await raised(store, "owner_question", { kind: "hypothesis", id: skipped }), "skip");
      expect(await latest(store, "hypothesis", skipped)).toBe("open");
    }));

  it("snooze sets one new reminder", () =>
    withCards(async (store) => {
      const id = await intention(store, "remind", { summary: "Canary reminder text" });
      await answer(store, await raised(store, "reminder", { kind: "intention", id }), "snooze");
      expect(await latest(store, "intention", id)).toBe("cancelled");
      const fresh = await rows<{ id: string; kind: string; due_at: Date; chain_depth: number }>(
        store,
        "select id, kind, due_at, chain_depth from ledger.intentions where id <> $1",
        [id],
      );
      expect(fresh).toEqual([
        { id: expect.any(String), kind: "remind", due_at: new Date(T0.getTime() + DAY_MS), chain_depth: 1 },
      ]);
      expect(await latest(store, "intention", fresh[0]?.id ?? "")).toBe("set");
      // The new reminder keeps the summary, sealed under its own id.
      const shown = await store.admin.cards.card(
        await raised(store, "reminder", { kind: "intention", id: fresh[0]?.id ?? "" }),
      );
      expect(shown?.lines).toContainEqual({ text: "Canary reminder text", from: "model" });
      // done and dismiss close a reminder and set none.
      const doneId = await intention(store, "remind");
      await answer(store, await raised(store, "reminder", { kind: "intention", id: doneId }), "done");
      expect(await latest(store, "intention", doneId)).toBe("fired");
      const dismissedId = await intention(store, "remind");
      await answer(store, await raised(store, "reminder", { kind: "intention", id: dismissedId }), "dismiss");
      expect(await latest(store, "intention", dismissedId)).toBe("cancelled");
      expect(await rows(store, "select count(*)::int as n from ledger.intentions")).toEqual([{ n: 4 }]);
    }));

  it("snooze on a reminder whose opportunity is closed records the answer and sets no new reminder", () =>
    withCards(async (store) => {
      for (const closed of ["no_go", "done", "expired", "withdrawn"]) {
        const work = await opportunity(store, "meeting_prep", closed);
        const id = await intention(store, "remind", { opportunity: work, summary: "Canary reminder text" });
        await event(store, "intention", id, "fired");
        await answer(store, await raised(store, "reminder", { kind: "intention", id }), "snooze");
        expect(await latest(store, "intention", id), closed).toBe("fired");
        expect(
          await rows(store, "select id from ledger.intentions where opportunity_id = $1 and id <> $2", [work, id]),
          closed,
        ).toEqual([]);
      }
      // The positive control: the same on open work sets one.
      const open = await opportunity(store, "meeting_prep", "go");
      const id = await intention(store, "remind", { opportunity: open });
      await event(store, "intention", id, "fired");
      await answer(store, await raised(store, "reminder", { kind: "intention", id }), "snooze");
      expect(
        await rows(store, "select kind from ledger.intentions where opportunity_id = $1 and id <> $2", [open, id]),
      ).toEqual([{ kind: "remind" }]);
    }));

  it("a snoozed reminder rests on what the first rested on: its session and its basis, so a deletion taints it too", () =>
    withCards(async (store) => {
      await store.admin.clients.addClient(
        registration("thinker", ["own"], {
          kind: "reasoner",
          views: ["self", "work"],
          tools: ["get_self", "next_run"],
        }),
      );
      const [client] = await rows<{ id: string }>(store, "select id from policy.clients where name = 'thinker'");
      const session = newId("ses");
      await asOwner(store, "ledger.sessions", { id: session, client_id: client?.id, compartments: ["own"] });
      const goal = await store.admin.work.addGoal("Canary goal", "own", { requestId: requestId() });
      const id = newId("itn");
      await asOwner(store, "ledger.intentions", {
        id,
        request_id: id,
        created_by: `run:${newId("run")}`,
        session_id: session,
        compartments: ["own"],
        kind: "remind",
        due_at: T0.toISOString(),
        body_enc: sealUnder(
          store.db.keys,
          ["own"],
          { table: "ledger.intentions", id, column: "body_enc" },
          "Canary snoozed text",
        ),
      });
      await rows(store, "select ledger.add_basis('intention', $1, '{own}', '{goal}', $2, null)", [id, [goal]]);
      await event(store, "intention", id, "set");
      await answer(store, await raised(store, "reminder", { kind: "intention", id }), "snooze");
      const [fresh] = await rows<{ id: string; session_id: string | null }>(
        store,
        "select id, session_id from ledger.intentions where id <> $1",
        [id],
      );
      expect(fresh?.session_id).toBe(session);
      expect(
        await rows(store, "select ref_kind, ref_id from ledger.basis where row_kind = 'intention' and row_id = $1", [
          fresh?.id,
        ]),
      ).toEqual([{ ref_kind: "goal", ref_id: goal }]);
    }));

  it("a decision card's lockIds name its opportunity's intentions and its outcome card's author and case, and a move's outcome names the move's opportunity", () =>
    withCards(async (store) => {
      const id = await opportunity(store, "investigate", "later");
      const check = await intention(store, "check_back", { opportunity: id });
      const made = card("opportunity_decision", { kind: "opportunity", id });
      const stored = {
        ...made,
        author: made.author,
        createdAt: T0.toISOString(),
        caseKey: null,
        run: null,
        bodyFrom: null,
      };
      await session(store.db.urls.admin, async (query) => {
        expect(new Set(await CARD_KINDS.opportunity_decision?.lockIds?.(query, stored as never))).toEqual(
          new Set([id, check, "author:reasoner", `case:outcome:${id}`]),
        );
        const handed = await opportunity(store, "meeting_prep", "handed_to_owner");
        const move = await reportedMove(store, handed, "Canary report");
        expect(
          await CARD_KINDS.outcome?.lockIds?.(query, { ...stored, target: { kind: "move", id: move } } as never),
        ).toEqual([handed]);
      });
    }));

  it("each kind refuses an answer that is not its own", () =>
    withCards(async (store) => {
      const kinds = {
        opportunity_decision: "acknowledge",
        owner_question: "go",
        outcome: "snooze",
        reminder: "confirm",
      } as const;
      const targets = {
        opportunity_decision: { kind: "opportunity", id: await opportunity(store, "investigate", "proposed") },
        owner_question: { kind: "hypothesis", id: await hypothesis(store, true) },
        outcome: { kind: "opportunity", id: await opportunity(store, "reply", "handed_to_owner") },
        reminder: { kind: "intention", id: await intention(store, "remind") },
      } as const;
      for (const [kind, wrong] of Object.entries(kinds) as [keyof typeof kinds, string][]) {
        const id = await raised(store, kind, targets[kind]);
        expect(await refusedWith(() => answer(store, id, wrong)), kind).toEqual({
          name: "AdminError",
          code: "invalid_answer",
        });
      }
    }));

  it("opportunity_decision's and owner_question's options are their decision points' outputs", () => {
    const outputs = (point: "opportunity_go" | "owner_question") => Object.keys(currentDefinition(point).outputs);
    expect(CARD_KINDS.opportunity_decision?.options).toEqual(outputs("opportunity_go"));
    expect(CARD_KINDS.owner_question?.options).toEqual(outputs("owner_question"));
    expect(CARD_KINDS.outcome?.options).toEqual(["acknowledge", "dismiss"]);
    expect(CARD_KINDS.reminder?.options).toEqual(["done", "snooze", "dismiss"]);
  });

  it("a summary is shown as a model's or an agent's line, never as code", () =>
    withCards(async (store) => {
      const byRun = await opportunity(store, "investigate", "proposed", { summary: "Canary run summary" });
      const byClient = await opportunity(store, "investigate", "proposed", {
        by: "client",
        summary: "Canary client summary",
      });
      const ofRun = await store.admin.cards.card(
        await raised(store, "opportunity_decision", { kind: "opportunity", id: byRun }),
      );
      const ofClient = await store.admin.cards.card(
        await raised(store, "opportunity_decision", { kind: "opportunity", id: byClient }),
      );
      expect(ofRun?.lines.filter((line) => line.text.includes("Canary"))).toEqual([
        { text: "Canary run summary", from: "model" },
      ]);
      expect(ofClient?.lines.filter((line) => line.text.includes("Canary"))).toEqual([
        { text: "Canary client summary", from: "agent" },
      ]);
      // An outcome card shows the latest move report's summary as an agent's line.
      const handed = await opportunity(store, "meeting_prep", "handed_to_owner", { summary: "Canary handed summary" });
      await reportedMove(store, handed, "Canary report summary");
      const outcome = await store.admin.cards.card(await raised(store, "outcome", { kind: "opportunity", id: handed }));
      expect(outcome?.lines.filter((line) => line.text.includes("Canary"))).toEqual([
        { text: "Canary handed summary", from: "model" },
        { text: "Canary report summary", from: "agent" },
      ]);
      expect(outcome?.lines.some((line) => line.text === HANDED_LINE)).toBe(false);
    }));

  it("a notice about a failed run shows its code and nothing else of it", () =>
    withCards(async (store) => {
      const run = newId("run");
      await rows(
        store,
        `insert into ledger.runs (id, request_id, created_by, compartments, wake_source, wake_key, decision_point, definition_version, prompt_id, prompt_version)
         values ($1, $1, 'owner', '{own}', 'owner_request', 'owner:canary-wake-key', 'run_outcome', 1, 'personal_run', '1')`,
        [run],
      );
      await event(store, "run", run, "queued");
      await rows(
        store,
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments, code) values ('run', $1, 'failed', $2, 'system:test', '{own}', 'model_unavailable')",
        [run, T0.toISOString()],
      );
      const shown = await store.admin.cards.card(await raised(store, "notice", { kind: "run", id: run }));
      expect(shown?.lines.filter((line) => line.text.startsWith("run failed"))).toEqual([
        {
          text: "run failed: model_unavailable",
          from: "code",
          key: "run_failed",
          value: [{ kind: "code", code: "model_unavailable" }],
        },
      ]);
      expect(JSON.stringify(shown?.lines)).not.toContain("canary");
      expect(shown?.lines.every((line) => line.from === "code")).toBe(true);
    }));
});
