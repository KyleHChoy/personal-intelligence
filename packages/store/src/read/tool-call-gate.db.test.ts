import type { ReadOutcome } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { createWork } from "../agent-work/work.ts";
import { queryAs } from "../test-support/database.ts";
import { recordingPool } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { registration, UNKNOWN_TOKEN } from "../test-support/values.ts";
import { Reader } from "./read.ts";

// Every kind of tool call goes through one gate: the token, the tool and its view, the arguments.
// What each kind sends and logs at that gate, side by side, whichever tool it is: its transaction,
// its taint hold, and the call row of a refusal, with or without a reason.

const BOTH = ["own", "employer:example"];
const BAD = { notAnArgument: 1 } as never;
const TOOLS = [
  "search",
  "record",
  "propose_about_you",
  "import_memory",
  "answer_owner_question",
  "propose_person",
  "close_commitment",
  "reopen_commitment",
  "request_research",
  "push_capture",
  "sync_mirror",
  "list_opportunities",
] as const;

type Row = { tool: string; outcome: string; reason: string | null };

// A client that holds every tool above. Three of them no registration may name (request_research,
// push_capture, sync_mirror), so they are set on its row.
async function holdingEvery(store: TestStore): Promise<string> {
  const { token } = await store.admin.clients.addClient(registration("holds-all", BOTH));
  await queryAs(store.db.urls.admin, "update policy.clients set tools = $1, views = $2 where name = 'holds-all'", [
    [...TOOLS],
    ["self", "people", "work"],
  ]);
  return token;
}

describe("the tool call gate", { timeout: 180_000 }, () => {
  it("each kind of tool call answers and logs its refusals as it always has", async () => {
    const store = await openStore({ writer: false });
    try {
      const { token: none } = await store.admin.clients.addClient(
        registration("holds-nothing", BOTH, { tools: ["get_self"], views: ["self"] }),
      );
      const all = await holdingEvery(store);
      const recorded = recordingPool(store.readerPool);
      const reader = new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log, now: () => store.now });
      const work = createWork({ reader, log: store.log, now: () => store.now });
      const rows = () =>
        queryAs<Row>(store.db.urls.admin, "select tool, outcome, reason from policy.calls order by id");

      const calls: [string, (token: string) => Promise<ReadOutcome<unknown>>][] = [
        ["search", (token) => reader.search(token, BAD)],
        ["record", (token) => reader.record(token, BAD)],
        ["propose_about_you", (token) => reader.proposeAboutYou(token, BAD)],
        ["import_memory", (token) => reader.importMemory(token, BAD)],
        ["answer_owner_question", (token) => reader.answerOwnerQuestion(token, BAD)],
        ["propose_person", (token) => reader.proposePerson(token, BAD)],
        ["close_commitment", (token) => reader.closeCommitment(token, BAD)],
        ["reopen_commitment", (token) => reader.reopenCommitment(token, BAD)],
        ["request_research", (token) => reader.fileResearch(token, BAD)],
        ["push_capture", (token) => reader.pushCapture(token, BAD)],
        ["sync_mirror", (token) => reader.syncMirror(token, BAD)],
        ["list_opportunities", (token) => work.listOpportunities(token, BAD)],
      ];

      const seen: Record<string, unknown> = {};
      for (const [name, call] of calls) {
        for (const [who, token] of [
          ["nobody", UNKNOWN_TOKEN],
          ["without", none],
          ["with", all],
        ] as const) {
          recorded.statements.length = 0;
          const before = (await rows()).length;
          const answer = await call(token);
          const logged = (await rows()).slice(before);
          const begin = recorded.statements.find((text) => /^\s*begin\b/i.test(text)) ?? "";
          seen[`${name} ${who}`] = {
            answer,
            isolation: /repeatable read/i.test(begin) ? "repeatable read" : "read committed",
            // A session hold around a snapshot's transaction; a transaction's own lock for a write.
            taint: recorded.statements.some((text) => /pg_advisory_lock_shared/.test(text))
              ? "held"
              : recorded.statements.some((text) => /pg_advisory_xact_lock_shared/.test(text))
                ? "locked"
                : "none",
            log: recorded.statements.filter((text) => /policy\.log_call/.test(text)),
            logged,
          };
        }
      }

      const LOG = "select policy.log_call($1, $2, $3)";
      const WHY = "select policy.log_call($1, $2, $3, $4::text, $5::text)";
      const expected = (tool: string, isolation: string, reason: string | null): Record<string, unknown> => ({
        [`${tool} nobody`]: {
          answer: { ok: false, code: "unauthorized" },
          isolation,
          taint: isolation === "repeatable read" ? "held" : "locked",
          log: [],
          logged: [],
        },
        [`${tool} without`]: {
          answer: { ok: false, code: "not_permitted" },
          isolation,
          taint: isolation === "repeatable read" ? "held" : "locked",
          log: [LOG],
          logged: [{ tool, outcome: "not_permitted", reason: null }],
        },
        [`${tool} with`]: {
          answer: { ok: false, code: "invalid_request" },
          isolation,
          taint: isolation === "repeatable read" ? "held" : "locked",
          log: [reason === null ? LOG : WHY],
          logged: [{ tool, outcome: "invalid_request", reason }],
        },
      });
      expect(seen).toEqual({
        ...expected("search", "repeatable read", "store"),
        ...expected("record", "read committed", "store"),
        ...expected("propose_about_you", "read committed", "store"),
        ...expected("import_memory", "read committed", "store"),
        ...expected("answer_owner_question", "read committed", "store"),
        ...expected("propose_person", "read committed", "store"),
        ...expected("close_commitment", "read committed", "store"),
        ...expected("reopen_commitment", "read committed", "store"),
        ...expected("request_research", "read committed", null),
        ...expected("push_capture", "read committed", null),
        ...expected("sync_mirror", "read committed", null),
        ...expected("list_opportunities", "repeatable read", "store"),
      });
    } finally {
      await store.close();
    }
  });

  it("a refusal by the agent API logs as the tool's own arguments would, with what the API said", async () => {
    const store = await openStore({ writer: false });
    try {
      const { token: none } = await store.admin.clients.addClient(
        registration("holds-nothing", BOTH, { tools: ["get_self"], views: ["self"] }),
      );
      const all = await holdingEvery(store);
      const reader = new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log, now: () => store.now });
      const work = createWork({ reader, log: store.log, now: () => store.now });
      const rows = () =>
        queryAs<Row & { field: string | null }>(
          store.db.urls.admin,
          "select tool, outcome, reason, field from policy.calls order by id",
        );
      const why = { reason: "shape", field: "query" } as never;

      expect(await reader.refused(none, "search")).toEqual({ ok: false, code: "not_permitted" });
      expect(await reader.refused(all, "search", { why })).toEqual({ ok: false, code: "invalid_request" });
      expect(await reader.refused(all, "search")).toEqual({ ok: false, code: "invalid_request" });
      expect(await reader.refused(all, "record", { why })).toEqual({ ok: false, code: "invalid_request" });
      expect(await work.refusedWork(none, "list_opportunities")).toEqual({ ok: false, code: "not_permitted" });
      expect(await work.refusedWork(all, "list_opportunities", { why })).toEqual({
        ok: false,
        code: "invalid_request",
      });
      // Work alone logs a refusal the API gave no reason for with none.
      expect(await work.refusedWork(all, "list_opportunities")).toEqual({ ok: false, code: "invalid_request" });
      expect(await rows()).toEqual([
        { tool: "search", outcome: "not_permitted", reason: null, field: null },
        { tool: "search", outcome: "invalid_request", reason: "shape", field: "query" },
        { tool: "search", outcome: "invalid_request", reason: "store", field: null },
        { tool: "record", outcome: "invalid_request", reason: "shape", field: "query" },
        { tool: "list_opportunities", outcome: "not_permitted", reason: null, field: null },
        { tool: "list_opportunities", outcome: "invalid_request", reason: "shape", field: "query" },
        { tool: "list_opportunities", outcome: "invalid_request", reason: null, field: null },
      ]);
    } finally {
      await store.close();
    }
  });
});
