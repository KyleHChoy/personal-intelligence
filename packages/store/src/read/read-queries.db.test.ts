import { type EntityId, EventId, type ReadOutcome, SearchResult } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { queryAs } from "../test-support/database.ts";
import { NAMES_KNOWLEDGE, orderFault } from "../test-support/order.ts";
import { insideHold, recordingPool } from "../test-support/recording.ts";
import { callLog, openStore, type TestStore } from "../test-support/store.ts";
import {
  daysFrom,
  iso,
  MALFORMED_TOKENS,
  MISSING_ENTITY,
  outcomeValue,
  registration,
  UNKNOWN_TOKEN,
} from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { BELIEF_KEYS } from "./computed-beliefs.ts";
import { Reader } from "./read.ts";
import { EVIDENCE_SPAN } from "./read-evidence.ts";
import { DECLASSIFIED_FACTS } from "./read-fact-rows.ts";
import { NEXT_MEETINGS, OWED_REPLIES, SETTLED_REPLIES } from "./read-next.ts";
import { PLANS } from "./read-open-items.ts";
import { HANDOFF, NOTES_LEFT_OUT } from "./read-pack-items.ts";
import { READ_ALLOWANCE } from "./read-quota.ts";
import { THREAD_NAMED, THREAD_PAGE } from "./read-thread.ts";

// Each refusal has its positive control in the same test.

const UNAUTHORIZED = { ok: false, code: "unauthorized" };
const NOT_PERMITTED = { ok: false, code: "not_permitted" };
const INVALID = { ok: false, code: "invalid_request" };

type Tool = "get_self" | "search" | "get_entity" | "get_timeline";

// The four tools with arguments that are valid and find something.
const callsFor = (reader: Reader, id: EntityId): Record<Tool, (token: string) => Promise<ReadOutcome<unknown>>> => ({
  get_self: (token) => reader.getSelf(token),
  search: (token) => reader.search(token, { query: "blake" }),
  get_entity: (token) => reader.getEntity(token, { id }),
  get_timeline: (token) => reader.getTimeline(token, { id }),
});

// A reader on a recording pool over the store's own reader pool.
function recordingReader(store: TestStore) {
  const recorded = recordingPool(store.readerPool);
  const reader = new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log, now: () => store.now });
  // The statements one call sent.
  const during = async <T>(run: () => Promise<T>): Promise<{ answer: T; statements: string[] }> => {
    recorded.statements.length = 0;
    const answer = await run();
    return { answer, statements: insideHold([...recorded.statements]) };
  };
  return { reader, during };
}

const names = (statements: string[], pattern: RegExp): number => statements.filter((text) => pattern.test(text)).length;
const TIMEOUT = 180_000;
const KNOWLEDGE = NAMES_KNOWLEDGE;
const LOG_CALL = /log_call\s*\(/i;
const MISSING_EVENT = EventId.parse(`evt_${"0".repeat(26)}`);

describe("the reader's statements", { timeout: TIMEOUT }, () => {
  it("refusals take one path", async () => {
    const store = await openStore({ now: WORLD_NOW });
    try {
      const world = await seedWorld(store.writer, store.admin);
      const { token: valid } = await store.admin.clients.addClient(
        registration("wide-client", ["own", "employer:example"]),
      );
      const { token: revoked } = await store.admin.clients.addClient(
        registration("revoked-client", ["own", "employer:example"]),
      );
      expect(await store.admin.clients.revokeClient("revoked-client")).toBe(true);
      const { reader, during } = recordingReader(store);

      for (const [tool, call] of Object.entries(callsFor(reader, world.entityOf(WORLD.both.address)))) {
        const sequences: string[][] = [];
        // No token is the empty string; and a token of no token's shape takes the same path.
        for (const bad of ["", UNKNOWN_TOKEN, revoked, ...MALFORMED_TOKENS]) {
          const { answer, statements } = await during(() => call(bad));
          expect(answer, tool).toEqual(UNAUTHORIZED);
          // Exactly these, in order: a BEGIN that names REPEATABLE READ, so each call reads one
          // snapshot, the set_config, the current_client() select, and COMMIT. Keywords in any case.
          expect(statements, tool).toHaveLength(4);
          expect(statements[0], tool).toMatch(/^\s*begin\b.*\brepeatable\s+read\b/is);
          expect(statements[1], tool).toMatch(/set_config\s*\(/i);
          expect(statements[2], tool).toMatch(/current_client\s*\(\s*\)/i);
          expect(statements[3], tool).toMatch(/^\s*commit\b/i);
          expect(names(statements, KNOWLEDGE) + names(statements, LOG_CALL), tool).toBe(0);
          // The token is a value, never part of a statement.
          if (bad !== "") for (const text of statements) expect(text, tool).not.toContain(bad);
          sequences.push(statements);
        }
        // One path: every refusal sends the same text.
        for (const sequence of sequences) expect(sequence, tool).toEqual(sequences[0]);

        // The positive control: a valid token starts the same way, then reads and logs.
        const { answer, statements } = await during(() => call(valid));
        expect(answer.ok, tool).toBe(true);
        expect(statements.slice(0, 3), tool).toEqual(sequences[0]?.slice(0, 3));
        expect(statements.length, tool).toBeGreaterThan(4);
        expect(names(statements, KNOWLEDGE), tool).toBeGreaterThan(0);
        expect(names(statements, LOG_CALL), tool).toBe(1);
        for (const text of statements) expect(text, tool).not.toContain(valid);
      }

      // Only the four valid calls reached the call log.
      expect((await callLog(store.db.urls.admin)).map((row) => [row.client, row.outcome])).toEqual(
        Array.from({ length: 4 }, () => ["wide-client", "ok"]),
      );
    } finally {
      await store.close();
    }
  });

  it("a tool outside the registration returns not_permitted and reads nothing", async () => {
    const store = await openStore({ now: WORLD_NOW });
    try {
      const world = await seedWorld(store.writer, store.admin);
      const both = ["own", "employer:example"];
      const { token: full } = await store.admin.clients.addClient(registration("full-client", both));
      // A missing tool: the view is there, the tool is not.
      const { token: selfTool } = await store.admin.clients.addClient(
        registration("self-tool-only", both, { tools: ["get_self"] }),
      );
      // A registered tool whose view is missing.
      const { token: selfView } = await store.admin.clients.addClient(
        registration("self-view-only", both, { views: ["self"] }),
      );
      const { token: peopleView } = await store.admin.clients.addClient(
        registration("people-view-only", both, { views: ["people", "work"] }),
      );
      const { reader, during } = recordingReader(store);
      const calls = callsFor(reader, world.entityOf(WORLD.both.address));

      const cases: [client: string, token: string, refused: Tool[], allowed: Tool[]][] = [
        ["self-tool-only", selfTool, ["search", "get_entity", "get_timeline"], ["get_self"]],
        ["self-view-only", selfView, ["search", "get_entity", "get_timeline"], ["get_self"]],
        ["people-view-only", peopleView, ["get_self"], ["search", "get_entity", "get_timeline"]],
      ];
      for (const [client, token, refused, allowed] of cases) {
        for (const tool of refused) {
          const before = await callLog(store.db.urls.admin);
          const { answer, statements } = await during(() => calls[tool](token));
          expect(answer, `${client} ${tool}`).toEqual(NOT_PERMITTED);
          expect(names(statements, KNOWLEDGE), `${client} ${tool}`).toBe(0);
          expect(names(statements, LOG_CALL), `${client} ${tool}`).toBe(1);
          expect(await callLog(store.db.urls.admin), `${client} ${tool}`).toEqual([
            ...before,
            { client, tool, rows: 0, outcome: "not_permitted" },
          ]);

          // The positive control: the same call by a client registered for it reads knowledge.
          const control = await during(() => calls[tool](full));
          expect(control.answer.ok, `full-client ${tool}`).toBe(true);
          expect(names(control.statements, KNOWLEDGE), `full-client ${tool}`).toBeGreaterThan(0);
        }
        // Not permitted comes first: the arguments of a tool the client may not call are not
        // read, so bad ones are not_permitted too, and never invalid_request.
        const bad: Record<Tool, () => Promise<ReadOutcome<unknown>>> = {
          get_self: () => reader.getSelf(token),
          search: () => reader.search(token, { query: "", limit: 26 }),
          get_entity: () => reader.getEntity(token, { id: "not an id" as never }),
          get_timeline: () => reader.getTimeline(token, { id: "not an id" as never, limit: 101 }),
        };
        for (const tool of refused) {
          const { answer, statements } = await during(bad[tool]);
          expect(answer, `${client} ${tool}, bad arguments`).toEqual(NOT_PERMITTED);
          expect(names(statements, KNOWLEDGE), `${client} ${tool}, bad arguments`).toBe(0);
          expect((await callLog(store.db.urls.admin)).at(-1), `${client} ${tool}, bad arguments`).toEqual({
            client,
            tool,
            rows: 0,
            outcome: "not_permitted",
          });
        }
        // And the narrow client is served what it is registered for.
        for (const tool of allowed) expect((await calls[tool](token)).ok, `${client} ${tool}`).toBe(true);
      }
    } finally {
      await store.close();
    }
  });

  it("an extra field answers invalid_request, logged, with no statement naming knowledge.", async () => {
    const store = await openStore({ now: WORLD_NOW });
    try {
      const world = await seedWorld(store.writer, store.admin);
      const { token } = await store.admin.clients.addClient(registration("wide-client", ["own", "employer:example"]));
      const { reader, during } = recordingReader(store);
      const id = world.entityOf(WORLD.both.address);

      // get_self takes no arguments, so it has no case here.
      const cases: [Tool, bad: () => Promise<ReadOutcome<unknown>>, good: () => Promise<ReadOutcome<unknown>>][] = [
        [
          "search",
          () => reader.search(token, { query: "blake", extra: 1 } as never),
          () => reader.search(token, { query: "blake" }),
        ],
        [
          "get_entity",
          () => reader.getEntity(token, { id, extra: true } as never),
          () => reader.getEntity(token, { id }),
        ],
        [
          "get_timeline",
          () => reader.getTimeline(token, { id, compartment: "employer:example" } as never),
          () => reader.getTimeline(token, { id }),
        ],
      ];
      for (const [tool, bad, good] of cases) {
        const before = await callLog(store.db.urls.admin);
        const { answer, statements } = await during(bad);
        expect(answer, tool).toEqual(INVALID);
        expect(names(statements, KNOWLEDGE), tool).toBe(0);
        expect(names(statements, LOG_CALL), tool).toBe(1);
        expect(await callLog(store.db.urls.admin), tool).toEqual([
          ...before,
          { client: "wide-client", tool, rows: 0, outcome: "invalid_request" },
        ]);

        // The positive control: without the extra field the call answers and reads knowledge.
        const control = await during(good);
        expect(control.answer.ok, tool).toBe(true);
        expect(names(control.statements, KNOWLEDGE), tool).toBeGreaterThan(0);
      }
    } finally {
      await store.close();
    }
  });

  it("a limit of 26 answers invalid_request", async () => {
    const store = await openStore({ now: WORLD_NOW });
    try {
      const world = await seedWorld(store.writer, store.admin);
      const { token } = await store.admin.clients.addClient(registration("wide-client", ["own", "employer:example"]));
      const { reader } = store;
      const id = world.entityOf(WORLD.both.address);

      expect(await reader.search(token, { query: "blake", limit: 26 })).toEqual(INVALID);
      // The positive control: 25 is the most a search may ask for.
      expect((await reader.search(token, { query: "blake", limit: 25 })).ok).toBe(true);

      // The other bounds of the contract's argument schemas, each beside a value that passes.
      expect(await reader.search(token, { query: "blake", limit: 0 })).toEqual(INVALID);
      expect(await reader.search(token, { query: "" })).toEqual(INVALID);
      expect(await reader.search(token, { query: "b".repeat(201) })).toEqual(INVALID);
      expect((await reader.search(token, { query: "b".repeat(200) })).ok).toBe(true);
      expect(await reader.getTimeline(token, { id, limit: 101 })).toEqual(INVALID);
      expect((await reader.getTimeline(token, { id, limit: 100 })).ok).toBe(true);
      // A date alone is accepted and is the whole UTC day: as a `from` its first instant, as a
      // `to` its last. The day asked for holds Blake's own message at 12:00 (-2d) and the work
      // meeting at 10:00 (-50h), and nothing of the days beside it.
      const day = outcomeValue(await reader.getTimeline(token, { id, from: "2026-03-08", to: "2026-03-08" }));
      expect(day).toEqual(
        outcomeValue(
          await reader.getTimeline(token, { id, from: "2026-03-08T00:00:00.000Z", to: "2026-03-08T23:59:59.999Z" }),
        ),
      );
      expect(day.entries.map((one) => one.at)).toEqual(["2026-03-08T12:00:00.000Z", "2026-03-08T10:00:00.000Z"]);
      expect(await reader.getTimeline(token, { id, from: "2026-03-32" as never })).toEqual(INVALID);
      expect((await reader.getTimeline(token, { id, from: iso(daysFrom(WORLD_NOW, -9)) })).ok).toBe(true);
      // An id that is not an entity id is a bad request, not an entity that is not found.
      expect(await reader.getEntity(token, { id: id.toLowerCase() as never })).toEqual(INVALID);
      expect(await reader.getEntity(token, { id: WORLD.both.address as never })).toEqual(INVALID);
      expect((await reader.getEntity(token, { id })).ok).toBe(true);
    } finally {
      await store.close();
    }
  });

  it("every reader query has an order by", async () => {
    // The rule the text of a statement is held to, first on statements that keep it.
    const kept = [
      "BEGIN ISOLATION LEVEL REPEATABLE READ",
      "COMMIT",
      "select set_config('pi.client_token', $1, true)",
      // A statement that does not name knowledge is not judged.
      "select id, name, compartments, views, tools from policy.current_client()",
      "select * from policy.current_client() limit 1",
      "select * from policy.log_call($1, $2, $3)",
      "select policy.log_call($1, $2, $3)",
      // The read quota check and the call log with code points.
      READ_ALLOWANCE,
      "select policy.log_call($1, $2, $3, $4)",
      // One row by its key, with whatever follows the key.
      "select e.id, e.kind from knowledge.entities e where e.id = $1",
      "select e.id, e.kind from knowledge.entities e where e.id = $1 and e.kind <> 'owner'",
      "select e.id from knowledge.entities e where e.id = $1 limit 1",
      "select id, kind from knowledge.entities where id = $1::text",
      "select d.title_enc from knowledge.event_details d where d.event_id = $1",
      "select p.participant_role from knowledge.event_participants p where p.event_id = $1 and p.entity_id = $2",
      // One row, as aggregates alone.
      "select count(distinct i.evidence_id) from knowledge.interaction_log i where i.entity_id = $1",
      "select exists (select 1 from knowledge.entities e where e.kind = 'owner')",
      "select array_agg(a.id order by a.id) from knowledge.accounts a",
      // A distinct aggregate ordered by its one argument: its values are unique.
      "select array_agg(distinct a.entity_id order by a.entity_id) from knowledge.accounts a",
      // A `with` query keeps its table's key, or is keyed by what it is grouped by.
      "with r as (select r.a_fp, r.b_fp from knowledge.identity_rulings r) select r.a_fp from r order by r.a_fp, r.b_fp",
      "with g as (select a.entity_id, count(*) as n from knowledge.accounts a group by a.entity_id) select g.entity_id, g.n from g order by g.entity_id",
      // Several rows, ordered by each table's own key.
      "select id, kind from knowledge.entities order by id",
      'select e.id from knowledge.entities e order by e.id collate "C"',
      'select e."id" from "knowledge"."entities" e order by e."id"',
      "select event_id, starts_at from knowledge.event_details order by starts_at asc nulls last, event_id",
      "select p.event_id, p.entity_id from knowledge.event_participants p where p.event_id = any($1) order by p.event_id, p.entity_id",
      "SELECT m.id\n FROM knowledge.messages m\n WHERE m.sent_at <= $1\n ORDER BY m.sent_at DESC, m.id\n LIMIT $2",
      "-- the people a client sees\nselect e.id from knowledge.entities e order by e.id -- by key",
      // A join to at most one row adds no key; a column set equal to a key stands for it.
      "select a.id from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where e.kind = 'person' order by a.id",
      "select e.id, d.starts_at from knowledge.events e join knowledge.event_details d on d.event_id = e.id order by d.starts_at, e.id",
      // Groups, ordered by what they are grouped by.
      "select i.entity_id, count(distinct i.evidence_id) as n from knowledge.interaction_log i group by i.entity_id order by i.entity_id",
      "select a.entity_id, array_agg(a.value_fp order by a.id) from knowledge.accounts a group by a.entity_id order by a.entity_id",
      // One row of each group, picked and ordered by the table's own key.
      "select distinct on (s.entity_id, s.value_fp) s.entity_id, s.id from knowledge.aliases s order by s.entity_id, s.value_fp, s.id",
      // A subquery whose order nobody sees needs none.
      "select m.id from knowledge.messages m where exists (select 1 from knowledge.interaction_log i where i.evidence_id = m.evidence_id and i.entity_id = $1) order by m.sent_at desc, m.id limit $2",
      "with mine as (select i.evidence_id from knowledge.interaction_log i where i.entity_id = $1) select m.id from knowledge.messages m where m.evidence_id in (select evidence_id from mine) order by m.id",
      // A set operation, ordered at its end by an id.
      "(select m.id, m.sent_at as at from knowledge.messages m) union all (select e.id, e.occurred_at as at from knowledge.events e) order by at desc, id",
      "select m.id, m.sent_at as at from knowledge.messages m union all select e.id, e.occurred_at as at from knowledge.events e order by at desc, id limit $1",
      // The ledger and the projections are judged too.
      "select r.id, r.bound from ledger.read_log r where r.session_id = $1 order by r.read_at, r.id",
      "select w.id, w.kind from ledger.agent_writes w where w.id = $1",
      "select d.id from projections.declassified_facts d order by d.id",
      // The pack's two queries over the agent records.
      HANDOFF,
      NOTES_LEFT_OUT,
      // The fact keys of the beliefs computed at read.
      BELIEF_KEYS,
      // The fact with its message, and the named message and its thread.
      EVIDENCE_SPAN,
      THREAD_NAMED,
      THREAD_PAGE,
      // find_facts' declassified copies.
      DECLASSIFIED_FACTS,
      // next's replies, what a task looked at, and its meetings.
      OWED_REPLIES,
      SETTLED_REPLIES,
      NEXT_MEETINGS,
      // open items' plans, with what their mail's authentication says.
      PLANS,
    ];
    // And on statements that break it.
    const broken = [
      // No order, or none that the statement itself ends in.
      "select id from knowledge.entities",
      'select id from "knowledge" . "entities"',
      "/* the people a client sees */ select e.id from knowledge.entities e",
      "  -- unordered\n  select e.id from knowledge.entities e",
      "select e.id from knowledge.entities e limit 10",
      "select e.id from knowledge.entities e where e.kind = $1 limit 1",
      "select e.id from knowledge.entities e where e.id = $1 or e.kind = 'owner'",
      "select m.id from knowledge.messages m where exists (select 1 from knowledge.interaction_log i where i.evidence_id = m.evidence_id order by i.id)",
      "with latest as (select id from knowledge.events order by id) select id from latest",
      // An order by something that is no key of the rows returned.
      "select e.id from knowledge.entities e order by e.kind",
      "select e.id from knowledge.entities e order by 1",
      "select i.entity_id from knowledge.interaction_log i order by i.entity_id",
      "select i.evidence_id from knowledge.interaction_log i where i.entity_id = $1 order by i.evidence_id",
      "select p.entity_id from knowledge.event_participants p order by p.event_id",
      "select p.entity_id from knowledge.event_participants p where p.event_id = $1",
      // A join that fans out, ordered by one side's id.
      "select e.id from knowledge.entities e join knowledge.accounts a on a.entity_id = e.id order by e.id",
      // Groups in no order, and aggregates that keep the order their input came in.
      "select i.entity_id, count(*) from knowledge.interaction_log i group by i.entity_id",
      "select array_agg(e.id) from knowledge.entities e",
      "select array_agg(distinct a.entity_id order by a.value_fp) from knowledge.accounts a",
      "select array_agg(a.entity_id order by a.entity_id) from knowledge.accounts a",
      "with g as (select a.entity_id, count(*) as n from knowledge.accounts a group by a.entity_id) select g.entity_id, g.n from g order by g.n",
      "with j as (select a.value_fp from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id) select j.value_fp from j order by j.value_fp",
      "select a.entity_id, array_agg(a.value_fp) from knowledge.accounts a group by a.entity_id order by a.entity_id",
      "select array(select id from knowledge.accounts)",
      // One row of each group, with nothing to say which.
      "select distinct on (s.entity_id, s.value_fp) s.entity_id, s.id from knowledge.aliases s order by s.entity_id, s.value_fp",
      "select distinct on (s.entity_id, s.value_fp) s.entity_id, s.id from knowledge.aliases s",
      // A cut with no order, under an ordered select or beside one row.
      "select m.id from (select id from knowledge.messages limit 5) m order by m.id",
      "select (select a.value_enc from knowledge.accounts a where a.entity_id = e.id limit 1) from knowledge.entities e where e.id = $1",
      // A set operation with no order at its end, or one that names no id.
      "(select m.id from knowledge.messages m) union all (select e.id from knowledge.events e)",
      "select m.id, m.sent_at as at from knowledge.messages m union all select e.id, e.occurred_at as at from knowledge.events e order by at desc",
      // The reader only reads.
      "delete from knowledge.entities",
      // The ledger and the projections are judged as knowledge is.
      "select r.id from ledger.read_log r order by r.read_at",
      "select w.id from ledger.agent_writes w limit 10",
      "select d.id from projections.declassified_facts d",
      "insert into ledger.sessions (id) values ($1)",
      // The pack's two queries with their order removed.
      ...[HANDOFF, DECLASSIFIED_FACTS].map((text) => text.replace(/order by[^\n]*\n/, "")),
      // The notes with their order removed.
      NOTES_LEFT_OUT.replace(/\n\s*order by w\.created_at[^\n]*/, ""),
      // The fact keys ordered by their newest claim alone.
      BELIEF_KEYS.replace("max(c.valid_from) desc, c.fact_key_fp", "max(c.valid_from) desc"),
      // The thread's page ordered by its time alone.
      THREAD_PAGE.replace("order by m.sent_at, m.id", "order by m.sent_at"),
    ];
    for (const text of kept) expect(orderFault(text), text).toBeNull();
    for (const text of broken) expect(orderFault(text), text).not.toBeNull();

    const store = await openStore({ now: WORLD_NOW });
    try {
      const world = await seedWorld(store.writer, store.admin);
      const { token } = await store.admin.clients.addClient(registration("wide-client", ["own", "employer:example"]));
      // A client that builds packs, its tool added as pi_admin in SQL.
      const packs = `pit_test-packs-${testId("x")}`;
      await store.admin.clients.addClient(registration("pack-client", ["own", "employer:example"]));
      await queryAs(
        store.db.urls.admin,
        "update policy.clients set token_hash = $1, tools = tools || '{build_context_pack}' where name = 'pack-client'",
        [sha256Hex(packs)],
      );
      // And one that holds get_commitments and the work view, and so a version 2 pack's
      // commitments too.
      const commitments = `pit_test-commitments-${testId("x")}`;
      await store.admin.clients.addClient(
        registration("commitments-client", ["own", "employer:example"], { views: ["self", "people", "work"] }),
      );
      await queryAs(
        store.db.urls.admin,
        "update policy.clients set token_hash = $1, tools = tools || '{build_context_pack,get_commitments,get_beliefs}' where name = 'commitments-client'",
        [sha256Hex(commitments)],
      );
      // And one that holds the two evidence reads.
      const { token: evidence } = await store.admin.clients.addClient(
        registration("evidence-client", ["own", "employer:example"], {
          tools: ["get_self", "get_evidence_span", "read_item"],
        }),
      );
      const message = (
        await queryAs<{ id: string }>(
          store.db.urls.admin,
          "select id from knowledge.messages order by sent_at, id limit 1",
        )
      )[0]?.id;
      if (message === undefined) throw new Error("the world holds no message");
      const { reader, during } = recordingReader(store);
      const blake = world.entityOf(WORLD.both.address);
      const ahead = { from: iso(daysFrom(WORLD_NOW, -60)), to: iso(daysFrom(WORLD_NOW, 30)) };
      const organization = SearchResult.parse(
        outcomeValue(await reader.search(token, { query: "example.com" })),
      ).results.find((one) => one.kind === "organization")?.id;
      if (organization === undefined) throw new Error("no organization for example.com");

      // The four tools, on answers that hold several rows of each kind, and on their refusals.
      const calls: [string, () => Promise<ReadOutcome<unknown>>, ok: boolean][] = [
        ["get_self", () => reader.getSelf(token), true],
        ["search by name", () => reader.search(token, { query: "canary" }), true],
        ["search by domain", () => reader.search(token, { query: "example.org", limit: 2 }), true],
        ["get_entity of a person", () => reader.getEntity(token, { id: blake }), true],
        ["get_entity of an organization", () => reader.getEntity(token, { id: organization }), true],
        ["get_entity of nobody", () => reader.getEntity(token, { id: MISSING_ENTITY }), false],
        ["get_timeline", () => reader.getTimeline(token, { id: blake }), true],
        ["get_timeline with a window", () => reader.getTimeline(token, { id: blake, ...ahead, limit: 3 }), true],
        ["get_timeline of an organization", () => reader.getTimeline(token, { id: organization }), true],
        ["get_timeline of nobody", () => reader.getTimeline(token, { id: MISSING_ENTITY }), false],
        // Both purposes of the pack.
        ["agent_bootstrap", () => reader.buildContextPack(packs, { purpose: "agent_bootstrap" }), true],
        [
          "meeting_prep",
          async () =>
            reader.buildContextPack(packs, {
              purpose: "meeting_prep",
              event: outcomeValue(await reader.getSelf(token)).upcoming[0]?.id ?? MISSING_EVENT,
            }),
          true,
        ],
        [
          "meeting_prep of nothing",
          () => reader.buildContextPack(packs, { purpose: "meeting_prep", event: MISSING_EVENT }),
          false,
        ],
        // get_commitments, and both packs with their commitments.
        ["get_commitments", () => reader.getCommitments(commitments, { state: "any" }), true],
        ["get_commitments with someone", () => reader.getCommitments(commitments, { with: blake }), true],
        ["get_commitments with nobody", () => reader.getCommitments(commitments, { with: MISSING_ENTITY }), false],
        [
          "agent_bootstrap with commitments",
          () => reader.buildContextPack(commitments, { purpose: "agent_bootstrap" }),
          true,
        ],
        [
          "meeting_prep with commitments",
          async () =>
            reader.buildContextPack(commitments, {
              purpose: "meeting_prep",
              event: outcomeValue(await reader.getSelf(token)).upcoming[0]?.id ?? MISSING_EVENT,
            }),
          true,
        ],
        // A thread, a page of one, and a fact that is not there.
        ["read_item", () => reader.readItem(evidence, { message: message as never }), true],
        ["read_item, a page of one", () => reader.readItem(evidence, { message: message as never, limit: 1 }), true],
        ["get_evidence_span of nothing", () => reader.getEvidenceSpan(evidence, { fact: "f".repeat(64) }), false],
        // get_beliefs.
        ["get_beliefs", () => reader.getBeliefs(commitments, { state: "any" }), true],
        ["get_beliefs of someone", () => reader.getBeliefs(commitments, { entity: blake }), true],
        ["get_beliefs of nobody", () => reader.getBeliefs(commitments, { entity: MISSING_ENTITY }), false],
      ];
      for (const [name, call, ok] of calls) {
        const { answer, statements } = await during(call);
        expect(answer.ok, name).toBe(ok);
        // Not vacuous: the call read knowledge.
        expect(names(statements, KNOWLEDGE), name).toBeGreaterThan(0);
        for (const text of statements) expect(orderFault(text), `${name}: ${text}`).toBeNull();
      }
      // The rule is held by behaviour too, with no SQL read: gate test P2 asks the same
      // questions of a store whose rows were written against their id order.
    } finally {
      await store.close();
    }
  });
});
