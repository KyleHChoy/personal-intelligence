import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PersonalLogEvent, type PersonalLogger } from "@intelligence/contracts/personal";
import { FOLD_SETUP, fakeSources, world } from "@intelligence/personal-core/testing";
import { createWriter, loadKeys } from "@intelligence/personal-store";
import { createTestDatabase, queryAs, type TestDatabase } from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSync } from "../intake/sync.ts";
import { mcpProcess as mcp, value } from "../test-support/spawn-pi.ts";

// The work tools through the real `pi mcp` process, which builds the store's Work from the reader
// it already builds: one pool, and one session for its client. A real Postgres with the production
// roles and the synthetic world, synced in-process; clients, intents, harness modes and the owner's
// go are written in SQL as pi_admin and pi_work.

const MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));
const LONG = 300_000;
const READS = ["get_self", "search", "get_entity", "get_timeline", "find_messages", "read_message"];
const WORK = [
  "list_opportunities",
  "claim_opportunity",
  "release_opportunity",
  "propose_hypothesis",
  "record_test",
  "propose_opportunity",
  "plan_move",
  "report_move",
  "set_intention",
];

const ulid = (): string => {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return [...randomBytes(26)].map((byte) => alphabet.charAt(byte & 31)).join("");
};
const id = (prefix: string): string => `${prefix}_${ulid()}`;
const req = (): string => `req-${randomBytes(8).toString("hex")}`;

describe("pi mcp, the work tools", () => {
  const log: PersonalLogger = {
    info: (one) => void PersonalLogEvent.parse(one),
    warn: (one) => void PersonalLogEvent.parse(one),
    error: (one) => void PersonalLogEvent.parse(one),
  };
  const running: ReturnType<typeof mcp>[] = [];
  let folder = "";
  let db: TestDatabase;
  let env: Record<string, string> = {};
  let message = "";

  const admin = <Row = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<Row[]> =>
    queryAs<Row>(db.urls.admin, text, values);
  const as = (token: string) => {
    const one = mcp({ ...env, PI_CLIENT_TOKEN: token });
    running.push(one);
    return one;
  };
  // A client inserted as pi_admin, with every read tool and every work tool unless told otherwise.
  const client = async (
    name: string,
    options: { views?: string[]; tools?: string[] } = {},
  ): Promise<{ id: string; token: string }> => {
    const made = { id: id("cli"), token: `pit_${randomBytes(32).toString("base64url").slice(0, 43)}` };
    await admin(
      `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind)
       values ($1, $2, $3, 'active', 'none', 'local', '{own}', $4, $5, 'agent')`,
      [
        made.id,
        name,
        createHash("sha256").update(made.token, "utf8").digest("hex"),
        options.views ?? ["self", "people", "work"],
        options.tools ?? [...READS, ...WORK],
      ],
    );
    return made;
  };
  const sessionsOf = async (clientId: string): Promise<string[]> =>
    (await admin<{ id: string }>("select id from ledger.sessions where client_id = $1 order by id", [clientId])).map(
      (row) => row.id,
    );

  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), "pi-work-mcp-"));
    const keyFile = join(folder, "keys.json");
    const init = spawn(
      process.execPath,
      ["--import", FOLD_SETUP, MAIN, "keys", "init", "--compartments", "own,employer:example"],
      { env: { PATH: process.env.PATH ?? "", PI_KEY_FILE: keyFile }, stdio: "ignore" },
    );
    expect(await new Promise((resolve) => init.on("close", resolve))).toBe(0);
    db = await createTestDatabase({ keyFile });
    env = { PI_DATABASE_URL_READER: db.urls.reader, PI_KEY_FILE: keyFile };
    const now = new Date();
    const writer = createWriter({ url: db.urls.writer, keys: await loadKeys(keyFile), log });
    try {
      expect(
        (await runSync({ writer, sources: fakeSources(world({ now })), log, now })).outcomes.every(
          (one) => one.outcome === "ok",
        ),
      ).toBe(true);
    } finally {
      await writer.close();
    }
    const [row] = await admin<{ id: string }>(
      "select id from knowledge.messages where compartments = '{own}' and not held order by id limit 1",
    );
    if (row === undefined) throw new Error("the world has no own message");
    message = row.id;
  }, LONG);

  afterAll(async () => {
    for (const one of running) one.kill();
    await db?.drop();
    await rm(folder, { recursive: true, force: true });
  });

  it(
    "a client lists, claims, plans, reports and releases over stdio",
    async () => {
      const worker = await client("worker");
      const intent = id("int");
      await admin(
        `insert into policy.intents (id, opportunity_kinds, client_ids, mode, confirmed_at) values ($1, '{goal_step}', $2, 'owner_decides', now())`,
        [intent, [worker.id]],
      );
      for (const stage of ["investigate", "prepare"]) {
        await admin(
          "insert into policy.harness_modes (id, client_id, opportunity_kind, stage, mode, granted_at) values ($1, $2, 'goal_step', $3, 'act', now())",
          [id("hrn"), worker.id, stage],
        );
      }
      const session = as(worker.token);
      expect(await session.listed()).toEqual([...READS, ...WORK].sort());
      const ref = { kind: "message", id: message };
      const { opportunity } = value(
        await session.tool("propose_opportunity", {
          kind: "goal_step",
          about: ref,
          summary: "a first step",
          basis: [ref],
          requestId: req(),
        }),
      ) as { opportunity: string };
      expect(opportunity).toMatch(/^opp_/);

      // The owner's go, as the card's effect writes it.
      await queryAs(
        db.urls.work,
        `insert into ledger.opportunity_decisions (request_id, created_by, compartments, opportunity_id, decision, decided_by, rung, reason, intent_id)
         values ($1, 'owner', '{own}', $2, 'go', 'owner', 4, 'owner_answer', $3)`,
        [req(), opportunity, intent],
      );
      await queryAs(
        db.urls.work,
        "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('opportunity', $1, 'go', now(), 'owner', '{own}')",
        [opportunity],
      );

      const listed = value(await session.tool("list_opportunities")) as {
        opportunities: { id: string; stage: string; summary: unknown }[];
      };
      expect(listed.opportunities.map((one) => [one.id, one.stage, one.summary])).toEqual([
        [opportunity, "investigate", { untrusted: "a first step" }],
      ]);
      const claimed = value(await session.tool("claim_opportunity", { id: opportunity, requestId: req() }));
      expect(claimed.leaseUntil).toEqual(expect.any(String));
      const { move } = value(
        await session.tool("plan_move", { opportunity, stage: "investigate", requestId: req() }),
      ) as { move: string };
      expect(
        value(
          await session.tool("report_move", {
            move,
            outcome: "done",
            summary: "found the date",
            report: { deliverable: "found the date", next: "prepare the step" },
            requestId: req(),
          }),
        ),
      ).toEqual({ move, opportunity: "claimed" });
      expect(value(await session.tool("release_opportunity", { id: opportunity, requestId: req() }))).toEqual({
        released: true,
      });
      expect(
        (value(await session.tool("list_opportunities")) as { opportunities: { stage: string }[] }).opportunities.map(
          (one) => one.stage,
        ),
      ).toEqual(["prepare"]);
      expect(await session.end()).toBe(0);
      expect(
        (
          await admin<{ tool: string; outcome: string }>(
            "select tool, outcome from policy.calls where client_id = $1 order by id",
            [worker.id],
          )
        ).map((row) => `${row.tool} ${row.outcome}`),
      ).toEqual([
        "propose_opportunity ok",
        "list_opportunities ok",
        "claim_opportunity ok",
        "plan_move ok",
        "report_move ok",
        "release_opportunity ok",
        "list_opportunities ok",
      ]);
    },
    LONG,
  );

  it(
    "a revoked client's next work call is unauthorized",
    async () => {
      const leaving = await client("leaving");
      const session = as(leaving.token);
      expect(await session.tool("list_opportunities")).toEqual({ ok: true, value: { opportunities: [] } });
      await admin("update policy.clients set status = 'revoked', revoked_at = now() where id = $1", [leaving.id]);
      expect(await session.tool("list_opportunities")).toEqual({ ok: false, code: "unauthorized" });
      expect(await session.end()).toBe(0);
    },
    LONG,
  );

  it(
    "a client with no work view lists no work tool",
    async () => {
      const viewless = await client("viewless", { views: ["self", "people"] });
      const session = as(viewless.token);
      expect(await session.listed()).toEqual([...READS].sort());
      expect(await session.tool("list_opportunities")).toEqual({ ok: false, code: "not_permitted" });
      expect(await session.end()).toBe(0);
      expect(await admin("select tool, outcome from policy.calls where client_id = $1", [viewless.id])).toEqual([
        { tool: "list_opportunities", outcome: "not_permitted" },
      ]);
    },
    LONG,
  );

  it(
    "one pi mcp process opens one session for its client, whether its first call is a read or a work call",
    async () => {
      for (const [name, first, second] of [
        ["read-first", "get_self", "list_opportunities"],
        ["work-first", "list_opportunities", "get_self"],
      ] as const) {
        const one = await client(name);
        const session = as(one.token);
        expect((await session.tool(first)).ok, name).toBe(true);
        expect((await session.tool(second)).ok, name).toBe(true);
        expect(await session.end()).toBe(0);
        const sessions = await sessionsOf(one.id);
        expect(sessions, name).toHaveLength(1);
        expect(
          await admin("select tool, session_id from ledger.read_log where client_id = $1 order by id", [one.id]),
        ).toEqual([
          { tool: first, session_id: sessions[0] },
          { tool: second, session_id: sessions[0] },
        ]);
      }
    },
    LONG,
  );
});
