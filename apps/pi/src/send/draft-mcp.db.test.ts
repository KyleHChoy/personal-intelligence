import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PersonalLogEvent, type PersonalLogger } from "@intelligence/contracts/personal";
import { FOLD_SETUP, fakeSources, world } from "@intelligence/personal-core/testing";
import { createWriter, loadKeys, openRow } from "@intelligence/personal-store";
import { createTestDatabase, queryAs, type TestDatabase } from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSync } from "../intake/sync.ts";
import { mcpProcess as mcp, value } from "../test-support/spawn-pi.ts";

// draft_message through the real `pi mcp` process, which serves the store's Work as it already does
// for the work tools. A real Postgres with the production roles and the synthetic world, synced
// in-process; clients are written in SQL as pi_admin.

const MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));
const LONG = 300_000;
const READS = ["get_self", "search", "get_entity", "get_timeline", "find_messages", "read_message"];
const TOOLS = [...READS, "draft_message"];

const ulid = (): string => {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return [...randomBytes(26)].map((byte) => alphabet.charAt(byte & 31)).join("");
};
const id = (prefix: string): string => `${prefix}_${ulid()}`;
const req = (): string => `req-${randomBytes(8).toString("hex")}`;

describe("pi mcp, draft_message", () => {
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
  const as = (token: string, more: Record<string, string> = {}) => {
    const one = mcp({ ...env, PI_CLIENT_TOKEN: token, ...more });
    running.push(one);
    return one;
  };
  const client = async (name: string): Promise<{ id: string; token: string }> => {
    const made = { id: id("cli"), token: `pit_${randomBytes(32).toString("base64url").slice(0, 43)}` };
    await admin(
      `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind)
       values ($1, $2, $3, 'active', 'none', 'local', '{own}', '{self,people,work}', $4, 'agent')`,
      [made.id, name, createHash("sha256").update(made.token, "utf8").digest("hex"), TOOLS],
    );
    return made;
  };

  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), "pi-draft-mcp-"));
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
    const keys = await loadKeys(keyFile);
    const writer = createWriter({ url: db.urls.writer, keys, log });
    try {
      expect(
        (await runSync({ writer, sources: fakeSources(world({ now })), log, now })).outcomes.every(
          (one) => one.outcome === "ok",
        ),
      ).toBe(true);
    } finally {
      await writer.close();
    }
    // An own inbound message with a Message-ID and a thread: one a reply can answer.
    const rows = await admin<{ id: string; facts_enc: unknown; thread_id_enc: unknown }>(
      "select id, facts_enc, thread_id_enc from knowledge.messages where compartments = '{own}' and not held and direction = 'inbound' and not bulk order by id",
    );
    const answerable = rows.find((row) => {
      const facts = JSON.parse(
        openRow(keys, "own", { table: "knowledge.messages", id: row.id, column: "facts_enc" }, row.facts_enc as never),
      ) as { messageId?: string };
      return typeof facts.messageId === "string" && row.thread_id_enc !== null;
    });
    if (answerable === undefined) throw new Error("the world has no own message a reply can answer");
    message = answerable.id;
  }, LONG);

  afterAll(async () => {
    for (const one of running) one.kill();
    await db?.drop();
    await rm(folder, { recursive: true, force: true });
  });

  it(
    "a client drafts a reply over stdio and gets an id",
    async () => {
      const drafter = await client("drafter");
      const session = as(drafter.token);
      expect(await session.listed()).toEqual([...TOOLS].sort());
      const { draft } = value(
        await session.tool("draft_message", { replyTo: message, body: "Thank you, Tuesday works.", requestId: req() }),
      ) as { draft: string };
      expect(draft).toMatch(/^drf_/);
      expect(await session.end()).toBe(0);
      const [row] = await admin<{ created_by: string; reply_to_evidence_id: string | null }>(
        "select created_by, reply_to_evidence_id from ledger.drafts where id = $1",
        [draft],
      );
      expect(row?.created_by).toBe(`client:${drafter.id}`);
      expect(row?.reply_to_evidence_id).not.toBeNull();
      expect(await admin("select tool, outcome from policy.calls where client_id = $1", [drafter.id])).toEqual([
        { tool: "draft_message", outcome: "ok" },
      ]);
      expect(
        (
          await admin<{ n: number }>("select count(*)::int as n from ledger.gate_checks where draft_id = $1", [draft])
        )[0]?.n,
      ).toBe(9);
    },
    LONG,
  );

  it(
    "a revoked client's draft is unauthorized",
    async () => {
      const leaving = await client("leaving");
      const session = as(leaving.token);
      expect(
        (
          await session.tool("draft_message", {
            to: ["someone@example.com"],
            subject: "Hello",
            body: "A first note.",
            requestId: req(),
          })
        ).ok,
      ).toBe(true);
      await admin("update policy.clients set status = 'revoked', revoked_at = now() where id = $1", [leaving.id]);
      expect(
        await session.tool("draft_message", {
          to: ["someone@example.com"],
          subject: "Hello",
          body: "A second note.",
          requestId: req(),
        }),
      ).toEqual({ ok: false, code: "unauthorized" });
      expect(await session.end()).toBe(0);
      expect(
        (
          await admin<{ n: number }>("select count(*)::int as n from ledger.drafts where created_by = $1", [
            `client:${leaving.id}`,
          ])
        )[0]?.n,
      ).toBe(1);
    },
    LONG,
  );

  it(
    "pi mcp refuses to start with the proxy URL or the send client's secret",
    async () => {
      const drafter = await client("refused");
      for (const more of [
        { PI_DATABASE_URL_PROXY: db.urls.proxy },
        { PI_SEND_GOOGLE_CLIENT_SECRET: "sentinel-send-client-secret" },
      ]) {
        const session = as(drafter.token, more);
        expect(await session.end(), Object.keys(more)[0]).toBe(1);
      }
      expect(await admin("select 1 from policy.calls where client_id = $1", [drafter.id])).toEqual([]);
    },
    LONG,
  );
});
