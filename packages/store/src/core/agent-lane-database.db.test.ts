import { describe, expect, it } from "vitest";
import { ALL_VIEWS, insertClient, sha256Hex, type TestClient, testId } from "../test-support/clients.ts";
import {
  ownerCommitted as asOwner,
  committedAs,
  one,
  type Query,
  readAs,
  session,
  sqlState,
} from "../test-support/connections.ts";
import { fingerprint, queryAs, type TestDatabase } from "../test-support/database.ts";
import { seeder } from "../test-support/seeder.ts";
import { withDatabase } from "../test-support/store.ts";

// What pi_pipeline may do in `ledger`, the three definer functions, the reader's one more column
// and a belief's provenance. Every refusal has its positive control in the same test.

const TIMEOUT = 180_000;
const AT = "2026-09-01T00:00:00Z";
const LABEL = ["agent:alpha", "own"];

const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);
const asPipeline = <Row = Record<string, unknown>>(
  db: TestDatabase,
  text: string,
  values?: unknown[],
): Promise<Row[]> => queryAs<Row>(db.urls.pipeline, text, values);
const pipelineState = (db: TestDatabase, text: string, values?: unknown[]): Promise<string | null> =>
  sqlState(() => asPipeline(db, text, values));

// One pi_pipeline transaction, rolled back or committed as the test says.
const pipelineTx = <T>(db: TestDatabase, fn: (query: Query) => Promise<T>): Promise<T> =>
  committedAs(db.urls.pipeline, fn);

// One agent record under `label`, as policy.append_record writes it, with its writer's views.
async function agentWrite(
  db: TestDatabase,
  writer: TestClient,
  label: string[] = LABEL,
  evidenceId: string | null = null,
): Promise<string> {
  const id = testId("rec");
  const sessionId = testId("ses");
  await asOwner(db, async (query) => {
    await query("insert into ledger.sessions (id, client_id, compartments) values ($1, $2, $3)", [
      sessionId,
      writer.id,
      writer.compartments,
    ]);
    await query(
      `insert into ledger.agent_writes (id, client_id, client_name, session_id, request_id, tool, kind, compartments, writer_views, content_fp, cites_fp, cites, body_enc, evidence_id)
       values ($1, $2, $3, $4, $5, 'record', 'finding', $6, $7, $8, $9, '{}', $10, $11)`,
      [
        id,
        writer.id,
        writer.name,
        sessionId,
        `request-${id.slice(-12)}`,
        label,
        ALL_VIEWS,
        fingerprint(db.keys, "content_hash", sha256Hex(id)),
        fingerprint(db.keys, "cites", ""),
        { v: 1, nonce: "AAAAAAAAAAAAAAAA", ciphertext: "", tag: "AAAAAAAAAAAAAAAAAAAAAA==" },
        evidenceId,
      ],
    );
  });
  return id;
}

// A card as pi_admin would raise one, with its first event.
async function card(
  db: TestDatabase,
  options: {
    kind?: string;
    author?: string;
    requestId?: string;
    compartments?: string[];
    event?: string;
    at?: string;
    expiresAfterDays?: number | null;
  } = {},
): Promise<string> {
  const id = testId("crd");
  const author = options.author ?? "system:extract";
  await admin(
    db,
    `insert into ledger.cards (id, request_id, created_at, created_by, kind, target_kind, target_id, options, expires_after_days, compartments)
     values ($1, $2, $3, $4, $5, 'claim', $6, '{confirm,reject}', $7, $8)`,
    [
      id,
      options.requestId ?? testId("req").slice(4),
      options.at ?? AT,
      author,
      options.kind ?? "agent_claim",
      "c".repeat(64),
      options.expiresAfterDays === undefined ? 30 : options.expiresAfterDays,
      options.compartments ?? LABEL,
    ],
  );
  await admin(
    db,
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, $2, $3, $4, $5)",
    [id, options.event ?? "pending", options.at ?? AT, author, options.compartments ?? LABEL],
  );
  return id;
}

// The owner's reply to a card, as decide writes it.
async function answer(
  db: TestDatabase,
  cardId: string,
  value: "confirm" | "reject",
  options: { tainted?: boolean; supersedes?: string } = {},
): Promise<string> {
  const id = testId("rul");
  await admin(
    db,
    `insert into knowledge.owner_decisions (id, request_id, kind, target_kind, target_id, answer, card_id, supersedes, queue_depth, labels, details, decided_at, compartments)
     values ($1, $2, 'answer', 'claim', $3, $4, $5, $6, 0, '{}', '{}', $7, $8)`,
    [id, testId("req").slice(4), "c".repeat(64), value, cardId, options.supersedes ?? null, AT, LABEL],
  );
  if (options.tainted === true)
    await asOwner(db, (query) => query("update knowledge.owner_decisions set tainted_at = now() where id = $1", [id]));
  return id;
}

const stateOf = async (db: TestDatabase, cardId: string): Promise<string | undefined> =>
  (
    await admin<{ event: string }>(
      db,
      "select event from ledger.record_events where row_kind = 'card' and row_id = $1 order by id desc limit 1",
      [cardId],
    )
  )[0]?.event;

const writer = (db: TestDatabase): Promise<TestClient> => insertClient(db, "alpha", LABEL);

describe("0010: pi_pipeline on ledger.agent_writes", { timeout: TIMEOUT }, () => {
  it("pi_pipeline reads only id, evidence_id and flagged_at of ledger.agent_writes, and can set flagged_at and no other column", () =>
    withDatabase(async (db) => {
      const id = await agentWrite(db, await writer(db));
      expect(
        await asPipeline(db, "select id, evidence_id, flagged_at from ledger.agent_writes where id = $1", [id]),
      ).toEqual([{ id, evidence_id: null, flagged_at: null }]);
      for (const column of ["body_enc", "client_name", "compartments", "cites", "content_fp", "session_id"]) {
        expect(await pipelineState(db, `select ${column} from ledger.agent_writes`), column).toBe("42501");
      }
      expect(
        await pipelineState(db, "update ledger.agent_writes set flagged_at = now() where id = $1", [id]),
      ).toBeNull();
      expect(
        one(
          await admin<{ flagged: boolean }>(
            db,
            "select flagged_at is not null as flagged from ledger.agent_writes where id = $1",
            [id],
          ),
        ).flagged,
      ).toBe(true);
      for (const set of ["body_enc = null", "tainted_at = now()", "evidence_id = null", "refused_code = 'x'"]) {
        expect(await pipelineState(db, `update ledger.agent_writes set ${set} where id = $1`, [id]), set).toBe("42501");
      }
    }));

  it("pi_pipeline can lock an agent_writes row, and pi_reader cannot", () =>
    withDatabase(async (db) => {
      const alpha = await writer(db);
      const id = await agentWrite(db, alpha);
      expect(
        await pipelineTx(db, (query) => query("select id from ledger.agent_writes where id = $1 for update", [id])),
      ).toEqual([{ id }]);
      expect(
        await sqlState(() =>
          readAs(db, alpha.token, (query) =>
            query("select id from ledger.agent_writes where id = $1 for update", [id]),
          ),
        ),
      ).toBe("42501");
      // The control for the reader's connection: a plain select of its row is served.
      expect(
        await readAs(db, alpha.token, (query) => query("select id from ledger.agent_writes where id = $1", [id])),
      ).toEqual([{ id }]);
    }));

  it("pi_pipeline cannot clear flagged_at", () =>
    withDatabase(async (db) => {
      const id = await agentWrite(db, await writer(db));
      expect(
        await pipelineState(db, "update ledger.agent_writes set flagged_at = now() where id = $1", [id]),
      ).toBeNull();
      expect(await pipelineState(db, "update ledger.agent_writes set flagged_at = null where id = $1", [id])).toBe(
        "42501",
      );
      expect(
        one(
          await admin<{ flagged: boolean }>(
            db,
            "select flagged_at is not null as flagged from ledger.agent_writes where id = $1",
            [id],
          ),
        ).flagged,
      ).toBe(true);
    }));

  it("pi_reader reads evidence_id of an agent_writes row its policy returns, and sees none whose flagged_at is set, set as pi_pipeline", () =>
    withDatabase(async (db) => {
      const alpha = await writer(db);
      const evidence = "e".repeat(64);
      const kept = await agentWrite(db, alpha, LABEL, evidence);
      const flagged = await agentWrite(db, alpha, LABEL, "d".repeat(64));
      const read = (): Promise<{ id: string; evidence_id: string }[]> =>
        readAs(db, alpha.token, (query) =>
          query<{ id: string; evidence_id: string }>("select id, evidence_id from ledger.agent_writes order by id"),
        );
      expect((await read()).length).toBe(2);
      expect(
        await pipelineState(db, "update ledger.agent_writes set flagged_at = now() where id = $1", [flagged]),
      ).toBeNull();
      expect(await read()).toEqual([{ id: kept, evidence_id: evidence }]);
    }));

  it("pi_pipeline reads no read log and no body, and writes nothing in ledger but flagged_at, its own cards and its own card events", () =>
    withDatabase(async (db) => {
      const id = await agentWrite(db, await writer(db));
      for (const sql of [
        // It reads the read log's fact keys, times and labels for the shadow sampler, and no other
        // column.
        "select session_id, client_id, shown from ledger.read_log",
        "select count(*) from ledger.sessions",
        "select count(*) from ledger.basis",
        "select count(*) from ledger.context_packs",
        "select body_enc from ledger.record_events",
        `insert into ledger.basis (row_kind, row_id, ref_kind, ref_id, source_class, compartments) values ('card', 'crd_x', 'entity', 'ent_x', 'derived', '{own}')`,
        `delete from ledger.agent_writes where id = '${id}'`,
        `delete from ledger.cards`,
        `delete from ledger.record_events`,
        `update ledger.cards set tainted_at = now()`,
        `update ledger.record_events set tainted_at = now()`,
      ]) {
        expect(await pipelineState(db, sql), sql).toBe("42501");
      }
      // The control: what it may do in ledger runs.
      expect(await pipelineState(db, "select count(*) from ledger.cards")).toBeNull();
    }));
});

describe("0010: pi_pipeline's cards and card events", { timeout: TIMEOUT }, () => {
  it("pi_pipeline reads only its own cards and card events, and no body", () =>
    withDatabase(async (db) => {
      const own = await card(db);
      const other = await card(db, { author: "system:queue", kind: "notice" });
      expect(
        (await asPipeline<{ id: string }>(db, "select id from ledger.cards order by id")).map((row) => row.id),
      ).toEqual([own]);
      expect(
        (await asPipeline<{ row_id: string }>(db, "select row_id from ledger.record_events")).map((row) => row.row_id),
      ).toEqual([own]);
      expect(await pipelineState(db, "select body_enc from ledger.record_events")).toBe("42501");
      // The control: the admin sees both.
      expect((await admin(db, "select id from ledger.cards where id = any($1)", [[own, other]])).length).toBe(2);
    }));

  it("pi_pipeline cannot insert a card of another kind or author, or an event of another row kind or author", () =>
    withDatabase(async (db) => {
      const insertCard = (kind: string, author: string): Promise<string | null> =>
        pipelineState(
          db,
          `insert into ledger.cards (id, request_id, created_at, created_by, kind, options, compartments) values ($1, $2, now(), $3, $4, '{confirm,reject}', '{own}')`,
          [testId("crd"), testId("req").slice(4), author, kind],
        );
      expect(await insertCard("agent_claim", "system:extract")).toBeNull();
      expect(await insertCard("notice", "system:extract")).toBe("42501");
      expect(await insertCard("agent_claim", "system:queue")).toBe("42501");
      expect(await insertCard("agent_claim", "owner")).toBe("42501");

      const own = await card(db);
      const event = (rowKind: string, event: string, by: string, rowId = own): Promise<string | null> =>
        pipelineState(
          db,
          "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ($1, $2, $3, now(), $4, $5)",
          [rowKind, rowId, event, by, LABEL],
        );
      expect(await event("card", "deferred", "system:extract")).toBeNull();
      expect(await event("draft", "pending", "system:extract")).toBe("42501");
      expect(await event("card", "pending", "owner")).toBe("42501");
    }));

  it("pi_pipeline cannot append an event to a card of another author, nor an event other than pending or deferred to its own, and reads every event of its own cards", () =>
    withDatabase(async (db) => {
      const own = await card(db);
      const other = await card(db, { author: "system:queue", kind: "notice" });
      const event = (rowId: string, name: string): Promise<string | null> =>
        pipelineState(
          db,
          "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, $2, now(), 'system:extract', $3)",
          [rowId, name, LABEL],
        );
      expect(await event(own, "pending")).toBeNull();
      expect(await event(other, "pending")).toBe("42501");
      for (const name of ["decided", "expired", "withdrawn"]) expect(await event(own, name), name).toBe("42501");
      // Events of its own card that other authors wrote, which raiseCard's count needs.
      await admin(
        db,
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'decided', now(), 'owner', $2)",
        [own, LABEL],
      );
      expect(
        (
          await asPipeline<{ event: string; by: string }>(
            db,
            "select event, by from ledger.record_events where row_id = $1 order by id",
            [own],
          )
        ).map((row) => `${row.event} ${row.by}`),
      ).toEqual(["pending system:extract", "pending system:extract", "decided owner"]);
    }));

  it("pi_pipeline has no EXECUTE on ledger.add_basis or ledger.admit_deferred, and no privilege on knowledge.owner_decisions", () =>
    withDatabase(async (db) => {
      expect(
        await pipelineState(
          db,
          "select ledger.add_basis('card', 'crd_00000000000000000000000000', array['own'], array[]::text[], array[]::text[], null)",
        ),
      ).toBe("42501");
      expect(await pipelineState(db, "select ledger.admit_deferred('system:extract')")).toBe("42501");
      expect(await pipelineState(db, "select count(*) from knowledge.owner_decisions")).toBe("42501");
      // The controls: pi_admin may run each, and pi_pipeline may run its own two.
      expect(await sqlState(() => admin(db, "select ledger.admit_deferred('system:extract')"))).toBeNull();
      expect(await sqlState(() => admin(db, "select count(*) from knowledge.owner_decisions"))).toBeNull();
      expect(await pipelineState(db, "select ledger.expire_agent_claims()")).toBeNull();
      expect(await pipelineState(db, "select ledger.lock_rows(array['author:system:extract'])")).toBeNull();
    }));
});

describe("0010: ledger.expire_agent_claims", { timeout: TIMEOUT }, () => {
  it("pi_pipeline can execute ledger.expire_agent_claims, which expires and admits only system:extract's agent_claim cards", () =>
    withDatabase(async (db) => {
      const old = "2026-01-01T00:00:00Z";
      const due = await card(db, { at: old });
      const fresh = await card(db, { at: new Date().toISOString() });
      const decided = await card(db, { at: old });
      await admin(
        db,
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'decided', now(), 'owner', $2)",
        [decided, LABEL],
      );
      const otherKind = await card(db, { at: old, kind: "notice", author: "system:extract" });
      const otherAuthor = await card(db, { at: old, author: "system:queue" });
      const deferred = await card(db, { at: old, event: "deferred" });

      expect(one(await asPipeline<{ n: number }>(db, "select ledger.expire_agent_claims() as n")).n).toBe(1);
      expect(await stateOf(db, due)).toBe("expired");
      expect(
        one(
          await admin<{ by: string }>(
            db,
            "select by from ledger.record_events where row_id = $1 order by id desc limit 1",
            [due],
          ),
        ).by,
      ).toBe("system:extract");
      for (const id of [fresh, otherKind, otherAuthor]) expect(await stateOf(db, id), id).toBe("pending");
      expect(await stateOf(db, decided)).toBe("decided");
      // The author has fewer than ten pending: its deferred card is admitted.
      expect(await stateOf(db, deferred)).toBe("pending");
      // Once: a second call expires nothing more.
      expect(one(await asPipeline<{ n: number }>(db, "select ledger.expire_agent_claims() as n")).n).toBe(0);
    }));

  it("its EXECUTE is pi_pipeline's and pi_restricted's alone, and confirmed_claims' pi_admin's too, and PUBLIC holds none", () =>
    withDatabase(async (db) => {
      for (const signature of [
        "ledger.expire_agent_claims()",
        "ledger.add_agent_claim_basis(text,text[])",
        "policy.confirmed_claims(text[])",
      ]) {
        const grantees = await admin<{ grantee: string }>(
          db,
          `select coalesce(g.rolname::text, 'PUBLIC') as grantee from pg_proc p cross join lateral aclexplode(p.proacl) a left join pg_roles g on g.oid = a.grantee
           where p.oid = $1::regprocedure and a.grantee <> p.proowner and a.privilege_type = 'EXECUTE'`,
          [signature],
        );
        expect(grantees.map((row) => row.grantee).sort(), signature).toEqual(
          signature === "policy.confirmed_claims(text[])"
            ? ["pi_admin", "pi_pipeline", "pi_reader", "pi_restricted"]
            : ["pi_pipeline", "pi_restricted"],
        );
        const fn = one(
          await admin<{ definer: boolean; owner: string; config: string[] }>(
            db,
            "select p.prosecdef as definer, pg_get_userbyid(p.proowner)::text as owner, p.proconfig::text[] as config from pg_proc p where p.oid = $1::regprocedure",
            [signature],
          ),
        );
        expect(
          { definer: fn.definer, owner: fn.owner, config: fn.config.map((one) => one.replaceAll(/[\s"]/g, "")) },
          signature,
        ).toEqual({
          definer: true,
          owner: "pi_owner",
          config: ["search_path=pg_catalog,policy,pg_temp"],
        });
      }
      const client = await insertClient(db, "reader-calls", ["own"]);
      for (const sql of [
        "select ledger.expire_agent_claims()",
        "select ledger.add_agent_claim_basis('crd_00000000000000000000000000', '{}')",
        "select policy.confirmed_claims('{}')",
      ]) {
        if (!sql.includes("confirmed_claims")) expect(await sqlState(() => admin(db, sql)), sql).toBe("42501");
        expect(await sqlState(() => queryAs(db.urls.writer, sql)), sql).toBe("42501");
        // The reader executes confirmed_claims, for find_facts' tier.
        if (!sql.includes("confirmed_claims"))
          expect(await sqlState(() => readAs(db, client.token, (query) => query(sql))), sql).toBe("42501");
      }
      expect(
        await sqlState(() => readAs(db, client.token, (query) => query("select policy.confirmed_claims('{}')"))),
      ).toBeNull();
    }));
});

describe("0010: ledger.add_agent_claim_basis", { timeout: TIMEOUT }, () => {
  // A message and an event under `own`, as the writer stores them.
  async function sources(
    db: TestDatabase,
  ): Promise<{ message: string; messageEvidence: string; event: string; eventEvidence: string }> {
    return session(db.urls.admin, async (query) => {
      const seed = seeder(db, query);
      const messageEvidence = await seed.evidence(["own"]);
      const message = await seed.message(["own"], messageEvidence);
      const event = (await seed.into("knowledge.events")(["own"])) as string;
      const [row] = await query<{ evidence_id: string }>("select evidence_id from knowledge.events where id = $1", [
        event,
      ]);
      return { message, messageEvidence, event, eventEvidence: row?.evidence_id ?? "" };
    });
  }
  const basisOf = (db: TestDatabase, cardId: string) =>
    admin<{ ref_kind: string; ref_id: string; compartments: string[] }>(
      db,
      "select ref_kind, ref_id, compartments from ledger.basis where row_kind = 'card' and row_id = $1 order by ref_kind",
      [cardId],
    );
  const call = (db: TestDatabase, cardId: string, cites: string[]) =>
    pipelineTx(db, (query) =>
      query<{ ok: boolean }>("select ledger.add_agent_claim_basis($1, $2) as ok", [cardId, cites]),
    );

  it("add_agent_claim_basis refuses a card that is not agent_claim, one not created by system:extract, and an id that is no card", () =>
    withDatabase(async (db) => {
      const { messageEvidence } = await sources(db);
      const notice = await card(db, { kind: "notice" });
      const queue = await card(db, { author: "system:queue" });
      for (const id of [notice, queue, testId("crd")])
        expect(await sqlState(() => call(db, id, [messageEvidence])), id).toBe("42501");
      // The positive control: system:extract's agent_claim card.
      const own = await card(db);
      expect(one(await call(db, own, [messageEvidence])).ok).toBe(true);
    }));

  it("it resolves a message cite and an event cite to their rows and writes their basis rows with the card's compartments", () =>
    withDatabase(async (db) => {
      const { message, messageEvidence, event, eventEvidence } = await sources(db);
      const own = await card(db);
      expect(one(await call(db, own, [messageEvidence, eventEvidence])).ok).toBe(true);
      expect(await basisOf(db, own)).toEqual([
        { ref_kind: "event", ref_id: event, compartments: LABEL },
        { ref_kind: "message", ref_id: message, compartments: LABEL },
      ]);
    }));

  it("it answers false and writes no row for a cite with no row", () =>
    withDatabase(async (db) => {
      const { message, messageEvidence } = await sources(db);
      const own = await card(db);
      expect(one(await call(db, own, ["f".repeat(64)])).ok).toBe(false);
      expect(await basisOf(db, own)).toEqual([]);
      // With one cite that resolves beside it, that one is written, and the answer is still false.
      const second = await card(db);
      expect(one(await call(db, second, [messageEvidence, "f".repeat(64)])).ok).toBe(false);
      expect(await basisOf(db, second)).toEqual([{ ref_kind: "message", ref_id: message, compartments: LABEL }]);
    }));
});

describe("0010: policy.confirmed_claims", { timeout: TIMEOUT }, () => {
  const key = (n: number): string => sha256Hex(`claim key ${n}`);
  const confirmed = async (db: TestDatabase, keys: string[]): Promise<string[]> =>
    (await asPipeline<{ key: string }>(db, "select k as key from policy.confirmed_claims($1) as k", [keys])).map(
      (row) => row.key,
    );

  it("policy.confirmed_claims answers only keys it was asked, only confirmed ones, and not one whose card is not agent_claim, not by system:extract, whose decision is tainted or superseded, or whose answer is reject", () =>
    withDatabase(async (db) => {
      await answer(db, await card(db, { requestId: key(1) }), "confirm");
      await answer(db, await card(db, { requestId: key(2) }), "reject");
      await answer(db, await card(db, { requestId: key(3), kind: "notice" }), "confirm");
      await answer(db, await card(db, { requestId: key(4), author: "system:queue" }), "confirm");
      await answer(db, await card(db, { requestId: key(5) }), "confirm", { tainted: true });
      const superseded = await answer(db, await card(db, { requestId: key(6) }), "confirm");
      await answer(db, await card(db, { requestId: key(16) }), "reject", { supersedes: superseded });
      await card(db, { requestId: key(7) });
      await answer(db, await card(db, { requestId: key(8) }), "confirm");

      expect(await confirmed(db, [1, 2, 3, 4, 5, 6, 7, 9].map(key))).toEqual([key(1)]);
      // Only the keys asked: key 8 is confirmed and was not asked.
      expect(await confirmed(db, [key(8)])).toEqual([key(8)]);
      expect(await confirmed(db, [])).toEqual([]);
    }));

  it("it refuses 1 001 keys", () =>
    withDatabase(async (db) => {
      const keys = Array.from({ length: 1001 }, (_, n) => key(n));
      expect(await sqlState(() => confirmed(db, keys))).toBe("22023");
      // The control: 1 000 are taken.
      expect(await confirmed(db, keys.slice(0, 1000))).toEqual([]);
    }));
});
