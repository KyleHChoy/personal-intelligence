import type { PersonalTool, ProposeAboutYouArgs } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { Reader } from "../read/read.ts";
import { one, session } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { recordingPool } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue, registration } from "../test-support/values.ts";

// Reader.proposeAboutYou, through the reader as an agent calls it, against the real migrations and
// roles.

const CLIENTS = ["alpha", "beta", "gamma", "delta", "reader"];
const COMPARTMENTS = ["own", "employer:example", ...CLIENTS.map((name) => `agent:${name}`)];
const TAINT = "hashtext('intelligence personal ledger taint')";

let store: TestStore;
const tokens: Record<string, string> = {};

beforeAll(async () => {
  store = await openStore({ compartments: COMPARTMENTS });
  const admin = new Admin({ pool: store.adminPool, keys: store.db.keys, log: store.log, recordEnabled: true });
  const tools = ["get_self", "record", "propose_about_you"] as PersonalTool[];
  for (const name of ["alpha", "beta", "gamma", "delta"])
    tokens[name] = (await admin.clients.addClient(registration(name, ["own"], { tools }))).token;
  tokens.reader = (
    await admin.clients.addClient(registration("reader", ["own"], { tools: ["get_self", "record"] }))
  ).token;
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await store.close();
});

const newSession = (): Reader => new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log });
let requests = 0;
const proposal = (over: Partial<ProposeAboutYouArgs> = {}): ProposeAboutYouArgs => {
  requests += 1;
  return {
    kind: "preference",
    fields: { domain: "career", object: "morning meetings", polarity: "avoids" },
    scope: "all",
    requestId: `propose-request-${String(requests).padStart(6, "0")}`,
    ...over,
  } as ProposeAboutYouArgs;
};
const writes = (name: string) =>
  queryAs<{ id: string; tool: string; kind: string; proposal_scope: string | null; compartments: string[] }>(
    store.db.urls.admin,
    "select id, tool, kind, proposal_scope, compartments from ledger.agent_writes where client_name = $1 order by created_at, id",
    [name],
  );
const calls = async (name: string): Promise<string[]> =>
  (
    await queryAs<{ outcome: string }>(
      store.db.urls.admin,
      "select outcome from policy.calls where tool = 'propose_about_you' and client_id = (select id from policy.clients where name = $1) order by id",
      [name],
    )
  ).map((row) => row.outcome);

describe("Reader.proposeAboutYou", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a propose_about_you call is read committed and its first statement takes the shared taint lock", async () => {
    const recorded = recordingPool(store.readerPool);
    const reader = new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log });
    expect((await reader.proposeAboutYou(tokens.alpha ?? "", proposal())).ok).toBe(true);
    expect(recorded.statements.slice(0, 2)).toEqual([
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      `select pg_advisory_xact_lock_shared(${TAINT})`,
    ]);
    // Its refusal path takes it too.
    recorded.statements.length = 0;
    expect(await reader.refused(tokens.alpha ?? "", "propose_about_you")).toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect(recorded.statements.slice(0, 2)).toEqual([
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      `select pg_advisory_xact_lock_shared(${TAINT})`,
    ]);
  });

  it("an off-shape call writes only its calls row", async () => {
    const before = (await writes("gamma")).length;
    expect(await newSession().refused(tokens.gamma ?? "", "propose_about_you")).toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect((await writes("gamma")).length).toBe(before);
    expect((await calls("gamma")).at(-1)).toBe("invalid_request");
  });

  it("the label is record_label() in a session that read nothing, and the row is a proposal of its scope", async () => {
    const id = outcomeValue(
      await newSession().proposeAboutYou(tokens.gamma ?? "", proposal({ scope: "this_client" })),
    ).recordId;
    const row = (await writes("gamma")).find((one) => one.id === id);
    expect(row).toEqual({
      id,
      tool: "propose_about_you",
      kind: "proposal",
      proposal_scope: "this_client",
      compartments: ["agent:gamma", "own"],
    });
  });

  // A phrase uses the quote's words in the quote's order, plurals folded; a word the quote lacks
  // is refused with its fixed code, and nothing is written.
  it("a phrase with a word the quote lacks is invalid_request not_in_quote", async () => {
    const before = (await writes("gamma")).length;
    expect(
      await newSession().proposeAboutYou(tokens.gamma ?? "", proposal({ quote: "I like evening calls." })),
    ).toEqual({ ok: false, code: "invalid_request", refusal: "not_in_quote" });
    expect((await writes("gamma")).length).toBe(before);
    expect((await calls("gamma")).at(-1)).toBe("invalid_request");
    // The control: the quote's words, in any case and spacing, in its order; reordered, refused.
    expect(
      (
        await newSession().proposeAboutYou(
          tokens.gamma ?? "",
          proposal({ quote: "I hate  Morning Meetings, honestly." }),
        )
      ).ok,
    ).toBe(true);
    expect(
      await newSession().proposeAboutYou(
        tokens.gamma ?? "",
        proposal({ quote: "Meetings in the morning, never again." }),
      ),
    ).toEqual({ ok: false, code: "invalid_request", refusal: "not_in_quote" });
  });

  it("a phrase that does not stand alone is invalid_request not_standalone, and writes only its calls row", async () => {
    const before = (await writes("gamma")).length;
    const pointer = proposal({
      kind: "goal",
      fields: { domain: "career", objective: "reach out to them instead of apply" },
      quote: "I'd reach out to them instead of apply.",
    });
    expect(await newSession().proposeAboutYou(tokens.gamma ?? "", pointer)).toEqual({
      ok: false,
      code: "invalid_request",
      refusal: "not_standalone",
    });
    expect((await writes("gamma")).length).toBe(before);
    expect((await calls("gamma")).at(-1)).toBe("invalid_request");
  });

  it("this_client with need is invalid_request", async () => {
    const before = (await writes("gamma")).length;
    expect(
      await newSession().proposeAboutYou(
        tokens.gamma ?? "",
        proposal({ kind: "need", fields: { domain: "career", object: "a new laptop" }, scope: "this_client" }),
      ),
    ).toEqual({ ok: false, code: "invalid_request" });
    expect((await writes("gamma")).length).toBe(before);
    expect(
      (
        await newSession().proposeAboutYou(
          tokens.gamma ?? "",
          proposal({ kind: "need", fields: { domain: "career", object: "a new laptop" }, scope: "all" }),
        )
      ).ok,
    ).toBe(true);
  });

  it("the 201st proposal of a day is rate_limited", async () => {
    for (let n = 0; n < 200; n += 1)
      expect((await newSession().proposeAboutYou(tokens.beta ?? "", proposal())).ok, String(n)).toBe(true);
    expect(await newSession().proposeAboutYou(tokens.beta ?? "", proposal())).toEqual({
      ok: false,
      code: "rate_limited",
    });
  });

  it("a proposal after its session's read item was deleted answers not_found", async () => {
    const reader = newSession();
    expect((await reader.proposeAboutYou(tokens.delta ?? "", proposal())).ok).toBe(true);
    // The session read an item that has since gone: a bound entry that names no evidence row.
    await session(store.db.urls.bootstrap, async (query) => {
      await query("set role pi_owner");
      await query("alter table ledger.read_log no force row level security");
      try {
        await query(
          `insert into ledger.read_log (session_id, client_id, tool, compartments, bound, shown, fact_key_fps)
           select s.id, s.client_id, 'get_self', '{own}', array[repeat('f', 64)], '{}', '{}' from ledger.sessions s join policy.clients c on c.id = s.client_id where c.name = 'delta'`,
        );
      } finally {
        await query("alter table ledger.read_log force row level security");
      }
    });
    const before = (await writes("delta")).length;
    expect(await reader.proposeAboutYou(tokens.delta ?? "", proposal())).toEqual({ ok: false, code: "not_found" });
    expect((await writes("delta")).length).toBe(before);
    expect((await calls("delta")).at(-1)).toBe("not_found");
  });

  it("the answer is the same recordId shape for every scope, and a retry answers the first id", async () => {
    const all = outcomeValue(await newSession().proposeAboutYou(tokens.gamma ?? "", proposal({ scope: "all" })));
    const retried = proposal({ scope: "this_client" });
    const mine = outcomeValue(await newSession().proposeAboutYou(tokens.gamma ?? "", retried));
    expect(Object.keys(all)).toEqual(["recordId"]);
    expect(Object.keys(mine)).toEqual(["recordId"]);
    expect(all.recordId).toMatch(/^rec_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(outcomeValue(await newSession().proposeAboutYou(tokens.gamma ?? "", retried))).toEqual(mine);
  });

  it("a client without the tool is not_permitted and writes nothing", async () => {
    expect(await newSession().proposeAboutYou(tokens.reader ?? "", proposal())).toEqual({
      ok: false,
      code: "not_permitted",
    });
    expect(await writes("reader")).toEqual([]);
    expect(
      one(
        await queryAs<{ n: number }>(
          store.db.urls.admin,
          "select count(*)::int as n from policy.calls where tool = 'propose_about_you' and client_id = (select id from policy.clients where name = 'reader')",
        ),
      ).n,
    ).toBe(1);
  });
});
