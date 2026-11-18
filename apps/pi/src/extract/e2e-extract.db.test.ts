import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRequest, ModelResponse } from "@intelligence/contracts";
import { BELIEF_TYPES, type FactView, type PersonalPipelineStore } from "@intelligence/contracts/personal";
import { sha256 } from "@intelligence/personal-core";
import { FOLD_SETUP, fakeSources, type World, world, worldModelOutputs } from "@intelligence/personal-core/testing";
import { EXTRACT_PROMPTS, type ExtractDeps, runExtraction } from "@intelligence/personal-extract";
import { createOpenRouterClient } from "@intelligence/personal-models";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { applyMigrations, createPipeline, fingerprint, openRow } from "@intelligence/personal-store";
import {
  createTestDatabase,
  dropDatabase,
  queryAs,
  scanForPlaintext,
  type TestDatabase,
} from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  addClient,
  comparable,
  EMPTY_OUTPUT,
  type Env,
  events,
  evidenceOf,
  expectedFacts,
  fakeOpenRouter,
  findFacts,
  gmailAccounts,
  gmailIds,
  pi as inProcess,
  MODEL_ID,
  quiet,
  type Synced,
  statuses,
  sync,
  syncedWorld,
  withAdmin,
} from "../test-support/extract-fixtures.ts";
import { mcpAtOnce } from "../test-support/mcp-fixtures.ts";

// Stage 2 end to end. One database is made by the real `pi db migrate`, its clients by the real `pi
// clients add`, and `find_facts` is read through a real `pi mcp`; sync and extraction run
// in-process on the fakes, as the core's end-to-end test runs sync. A case that needs a second run
// of the whole world has a database of its own; two runs that must agree row for row start from one
// database copied by Postgres, so every id is the same in both.

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));
const TOOLS = [
  "get_self",
  "search",
  "get_entity",
  "get_timeline",
  "find_messages",
  "read_message",
  "find_facts",
  "get_beliefs",
];

// The real process, with an explicit environment and, where given, its standard input.
function pi(
  argv: string[],
  env: Env,
  stdin?: string,
): Promise<{ exit: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", FOLD_SETUP, MAIN, ...argv], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (exit) => resolve({ exit, stdout, stderr }));
    child.stdin.end(stdin ?? "");
  });
}

// One agent API process for a list of tool calls: each answer's structured content, or its error
// code. The stand-in for pi mcp that waits no reply deadline (mcp-fixtures.ts): these tests compare
// what is answered, not when.
async function mcp(
  env: Env,
  token: string,
  calls: { name: string; args?: Record<string, unknown> }[],
): Promise<unknown[]> {
  const lines = calls
    .map((call, n) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: n + 1,
        method: "tools/call",
        params: { name: call.name, arguments: call.args ?? {} },
      }),
    )
    .join("\n");
  const result = await mcpAtOnce({ ...env, PI_CLIENT_TOKEN: token }, `${lines}\n`);
  expect(result.exit).toBe(0);
  return result.stdout
    .trimEnd()
    .split("\n")
    .map((line) => {
      const reply = JSON.parse(line) as {
        result?: { isError?: boolean; structuredContent?: unknown; content?: { text: string }[] };
        error?: { message: string };
      };
      if (reply.error !== undefined) return { error: reply.error.message };
      return reply.result?.isError === true
        ? { error: reply.result.content?.[0]?.text }
        : reply.result?.structuredContent;
    });
}

// find_facts over MCP answers in the wire form (contracts' compact.ts): the owner is the string
// "owner", a false, a null and a stated_fact are left out, and so is a statedBy that is the
// subject, which the basis then says (explicit_self). Each fact read back in its strict form, so
// `comparable` reads it as it reads the store's.
const who = (one: unknown): unknown => (one === "owner" ? { kind: "owner" } : one);
const strictFact = (wire: Record<string, unknown>): FactView =>
  ({
    statementKind: "stated_fact",
    thirdParty: false,
    message: null,
    ...wire,
    subject: who(wire.subject),
    statedBy:
      wire.statedBy !== undefined ? who(wire.statedBy) : wire.basis === "explicit_self" ? who(wire.subject) : null,
  }) as FactView;
const factsVia = async (env: Env, token: string): Promise<FactView[]> =>
  (
    (await mcp(env, token, [{ name: "find_facts", args: { limit: 50 } }]))[0] as { facts: Record<string, unknown>[] }
  ).facts.map(strictFact);

// A copy of a database, made by Postgres from it as a template, with the database privileges the
// copy does not take with it. Nothing may be connected to the source while it is copied.
async function copyOf(source: TestDatabase): Promise<TestDatabase> {
  const name = `${source.name.slice(0, 40)}_c${Math.random().toString(16).slice(2, 10)}`;
  const server = source.urls.bootstrap.replace(/\/[^/]+$/, "/postgres");
  await queryAs(server, `create database "${name}" template "${source.name}"`);
  const urls = Object.fromEntries(
    Object.entries(source.urls).map(([role, url]) => [role, url.replace(/\/[^/]+$/, `/${name}`)]),
  ) as TestDatabase["urls"];
  await applyMigrations(urls.bootstrap);
  return {
    ...source,
    name,
    urls,
    drop: () => dropDatabase(name),
  };
}

// Every row of the tables extraction writes, with each sealed column opened, the columns the
// database fills from its clock left out, and the ids made at random (a saved call's, a usage
// row's) left out. `vault.extraction_runs` is left out: a stopped run adds a row. No belief is
// stored: each is computed at read (computedBeliefs below).
const TABLES: [string, string][] = [
  ["vault.pipeline_items", "evidence_id"],
  ["vault.model_calls", "id"],
  ["vault.model_usage", "id"],
  ["vault.unmapped_claims", "id"],
  ["vault.extraction_reviews", "id"],
  ["knowledge.claims", "id"],
  ["knowledge.claim_entities", "claim_id"],
];
// The beliefs computed for each audience, each active client's and the owner's, as of the
// database's clock, each with its support by stored claim id.
async function computedBeliefs(base: TestDatabase) {
  const pipeline = createPipeline({ url: base.urls.pipeline, keys: base.keys, log: quiet });
  try {
    return (await pipeline.sweepBeliefs(BELIEF_TYPES)).flatMap(({ audience, records }) =>
      records.map((record) => ({
        audience,
        support: record.belief.support.map((id) => fingerprint(base.keys, "claim", id)).sort(),
        record,
      })),
    );
  } finally {
    await pipeline.close();
  }
}
const restingOn = async (base: TestDatabase, claimIds: readonly string[]) =>
  (await computedBeliefs(base)).filter((one) => one.support.some((id) => claimIds.includes(id)));

// A claim's first_known_at defaults to now(), as its created_at does.
const CLOCK = new Set(["created_at", "updated_at", "reviewed_at", "first_known_at"]);
const RANDOM_ID = new Set(["vault.model_calls", "vault.model_usage"]);

type Row = Record<string, unknown>;
async function snapshot(db: TestDatabase): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const [table, key] of TABLES) {
    const rows = await queryAs<Row>(db.urls.admin, `select * from ${table}`);
    out[table] = rows
      .map((row) => {
        const kept: Row = {};
        for (const [column, value] of Object.entries(row)) {
          if (CLOCK.has(column) || (column === "id" && RANDOM_ID.has(table))) continue;
          kept[column] = column.endsWith("_enc")
            ? openRow(
                db.keys,
                (row.compartments as string[])[0] ?? "",
                { table, id: String(row[key]), column },
                value as never,
              )
            : value;
        }
        return JSON.stringify(kept, Object.keys(kept).sort());
      })
      .sort();
  }
  return out;
}

// The pieces of a run made in-process with runExtraction, as `pi extract` makes them.
const deps = (
  _db: TestDatabase,
  store: PersonalPipelineStore,
  model: ExtractDeps["model"],
  generation?: number,
): ExtractDeps => ({
  store,
  model,
  modelId: MODEL_ID,
  log: quiet,
  now: () => new Date(),
  compartments: ["own", "employer:example"],
  ...(generation === undefined ? {} : { generation }),
});
async function runWith(
  db: TestDatabase,
  model: ExtractDeps["model"],
  wrap: (store: PersonalPipelineStore) => PersonalPipelineStore = (store) => store,
  generation?: number,
) {
  const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: quiet });
  try {
    return await runExtraction(deps(db, wrap(pipeline), model, generation));
  } finally {
    await pipeline.close();
  }
}

// A fake that records each call it answered, and the evidence ids it was asked for.
function recording(outputs: Record<string, unknown>) {
  const asked: string[] = [];
  const answered: string[] = [];
  const fake = fakeModelClient(outputs);
  const client = {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const id = request.callKey?.evidenceId ?? "";
      asked.push(id);
      try {
        return await fake.complete(request);
      } finally {
        answered.push(id);
      }
    },
    embed: fake.embed,
  };
  return { client, asked, answered };
}

describe("stage 2, end to end", () => {
  const now = new Date();
  const w: World = world({ now });
  const sources = fakeSources(w);
  let folder = "";
  let db: TestDatabase;
  let pristine: TestDatabase;
  let adminEnv: Env;
  let pipelineEnv: Env;
  let readerEnv: Env;
  let s: Pick<Synced, "db" | "w" | "accounts">;
  let outputs: Record<string, unknown> = {};
  const tokens: Record<"own" | "both", string> = { own: "", both: "" };
  const calls: string[] = [];

  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), "pi-e2e-extract-"));
    const keyFile = join(folder, "keys.json");
    expect((await pi(["keys", "init", "--compartments", "own,employer:example"], { PI_KEY_FILE: keyFile })).exit).toBe(
      0,
    );
    db = await createTestDatabase({ migrations: false, keyFile });
    const urls = {
      PI_DATABASE_URL_ADMIN: db.urls.admin,
      PI_DATABASE_URL_WRITER: db.urls.writer,
      PI_DATABASE_URL_READER: db.urls.reader,
      PI_DATABASE_URL_PIPELINE: db.urls.pipeline,
      PI_DATABASE_URL_WORK: db.urls.work,
      PI_DATABASE_URL_RESTRICTED: db.urls.restricted,
    };
    expect((await pi(["db", "migrate"], { PI_DATABASE_URL_BOOTSTRAP: db.urls.bootstrap, ...urls })).exit).toBe(0);
    adminEnv = { PI_DATABASE_URL_ADMIN: db.urls.admin, PI_KEY_FILE: keyFile };
    pipelineEnv = { PI_DATABASE_URL_PIPELINE: db.urls.pipeline, PI_KEY_FILE: keyFile, PI_EXTRACT_MODEL: MODEL_ID };
    readerEnv = { PI_DATABASE_URL_READER: db.urls.reader, PI_KEY_FILE: keyFile };
    for (const [name, compartments] of [
      ["own", "own"],
      ["both", "own,employer:example"],
    ] as const) {
      const added = await pi(
        [
          "clients",
          "add",
          name,
          "--views",
          "self,people,work",
          "--tools",
          TOOLS.join(","),
          "--compartments",
          compartments,
        ],
        adminEnv,
      );
      expect(added.exit).toBe(0);
      tokens[name] = added.stdout.trim();
    }
    // The model key, as the box imports it at its start.
    expect((await pi(["models", "import-key"], { ...adminEnv, PI_OPENROUTER_KEY: "sk-test-e2e-key" })).exit).toBe(0);
    await sync(db, w, now, sources);
    s = { db, w, accounts: await gmailAccounts(db) };
    outputs = worldModelOutputs(w, s.accounts);
    // The synced world before any extraction, kept for E7's run without the instruction.
    pristine = await copyOf(db);
    const result = await inProcess(["extract"], pipelineEnv, { deps: { model: fakeModelClient(outputs, calls) } });
    expect(result.exit).toBe(0);
  });

  afterAll(async () => {
    await pristine?.drop();
    await db?.drop();
    await rm(folder, { recursive: true, force: true });
  });

  it("E10: find_facts returns exactly the world's expected facts, and nothing from a skipped, withheld or held message", async () => {
    const messages = await gmailIds(s);
    expect(comparable(await factsVia(readerEnv, tokens.own), messages)).toEqual(expectedFacts(w, "own"));
    expect(comparable(await factsVia(readerEnv, tokens.both), messages)).toEqual(expectedFacts(w, "both"));
    const rows = await statuses(db);
    for (const [gmailId, expected] of Object.entries(w.expected.items)) {
      const got = rows.get(evidenceOf(s, gmailId));
      expect([gmailId, got?.status, got?.code]).toEqual([gmailId, expected.status, expected.code]);
    }
    // The held message made no call, has no status row and yields no fact.
    const held = evidenceOf(s, w.handles.heldMessageId);
    expect(calls).not.toContain(held);
    expect(rows.has(held)).toBe(false);
    // Released, it is due at the next run, and has a status row after it.
    const [message] = await queryAs<{ id: string }>(
      db.urls.admin,
      "select id from knowledge.messages where evidence_id = $1",
      [held],
    );
    expect((await pi(["messages", "release", message?.id ?? ""], adminEnv)).exit).toBe(0);
    const again = await inProcess(["extract"], pipelineEnv, {
      deps: { model: fakeModelClient({ ...outputs, [held]: EMPTY_OUTPUT }, calls) },
    });
    expect(again.exit).toBe(0);
    expect(calls.filter((one) => one === held)).toEqual([held]);
    expect((await statuses(db)).get(held)?.status).toBe("done");
  });

  // get_entity cites each belief's latest claim alone; get_beliefs serves the rest.
  it("B1: every expected belief comes back from get_beliefs, with its status, its disputed mark and its citing claim", async () => {
    const messages = await gmailIds(s);
    const facts = await factsVia(readerEnv, tokens.own);
    const planted = w.expected.facts.own.filter(
      (fact) =>
        fact.status !== undefined &&
        ["role", "affiliation", "relationship", "need", "capability", "contact_rule"].includes(fact.type),
    );
    expect(planted.length).toBeGreaterThanOrEqual(8);
    for (const fact of planted) {
      const served = facts.find((one) => messages.get(one.message ?? "") === fact.gmailId && one.type === fact.type);
      expect(served, fact.gmailId).toBeDefined();
      const [view] = (await mcp(readerEnv, tokens.own, [
        { name: "get_beliefs", args: { entity: served?.subject.id, state: "any", limit: 50 } },
      ])) as { beliefs: { kind: string; status: string; disputed?: true; cites: { id: string }[] }[] }[];
      const belief = view?.beliefs.find(
        (one) =>
          one.cites.some((cite) => cite.id === served?.id) ||
          (fact.sharesBeliefWith !== undefined && one.kind === fact.type),
      );
      // The wire form leaves out a disputed mark that is false.
      expect([fact.gmailId, belief?.kind, belief?.status, belief?.disputed ?? false]).toEqual([
        fact.gmailId,
        fact.type,
        fact.status,
        fact.disputed === true,
      ]);
    }
  });

  it("B3: a third party's relationship builds no belief; the owner's goal and preference, in their own words, build one each", async () => {
    const messages = await gmailIds(s);
    const facts = await factsVia(readerEnv, tokens.own);
    const servedOf = (id: string): FactView[] => facts.filter((one) => messages.get(one.message ?? "") === id);
    const reported = servedOf(w.handles.reportedRelationshipMessageId);
    expect(reported.length).toBeGreaterThan(0);
    for (const one of reported) expect(one.status).toBeUndefined();
    // Goal and preference are belief kinds, and the owner's build from their own words.
    expect(
      servedOf(w.handles.ownerGoalMessageId)
        .map((one) => [one.type, one.status])
        .sort(),
    ).toEqual([
      ["goal", "active"],
      ["preference", "active"],
    ]);
    // And the domain the passage does not name left its candidate unmapped.
    expect(facts.some((one) => messages.get(one.message ?? "") === w.handles.unnamedDomainMessageId)).toBe(false);
  });

  it("B5: a second run over the same claims buys no call", async () => {
    const before = calls.length;
    const again = await inProcess(["extract"], pipelineEnv, { deps: { model: fakeModelClient(outputs, calls) } });
    expect(again.exit).toBe(0);
    expect(calls.length).toBe(before);
  });

  it("E7: a body that holds instructions changes nothing but its own item, and a forged sender builds nothing", async () => {
    const messages = await gmailIds(s);
    const both = comparable(await factsVia(readerEnv, tokens.both), messages);
    // Its one claim is its sender's own, and its text comes back only under `untrusted`.
    const instruction = w.handles.bodyInstructionMessageId;
    const own = both.filter((fact) => fact.gmailId === instruction);
    expect(own).toHaveLength(1);
    expect(own[0]?.subject).toBe(own[0]?.statedBy);
    const raw = (await factsVia(readerEnv, tokens.both)).filter(
      (fact) => messages.get(fact.message ?? "") === instruction,
    );
    expect(raw[0]?.fields).toMatchObject({ what: { untrusted: expect.any(String) } });

    // A run without it: on the copy of the synced world, the instruction is not answered.
    const evidence = evidenceOf(s, instruction);
    const without = { ...outputs };
    delete without[evidence];
    expect(await runWith(pristine, fakeModelClient(without))).toMatchObject({ code: "ok" });
    // The held message was released in the database after the copy: compare with it released too.
    const held = evidenceOf(s, w.handles.heldMessageId);
    const ours = await snapshot(db);
    const theirs = await snapshot(pristine);
    const claimsOf = async (base: TestDatabase) =>
      (
        await queryAs<{ id: string }>(base.urls.admin, "select id from knowledge.claims where evidence_id = any ($1)", [
          [evidence, held],
        ])
      ).map((row) => row.id);
    const excluded = new Set([evidence, held, ...(await claimsOf(db)), ...(await claimsOf(pristine))]);
    const other = (rows: string[]) =>
      rows.filter((row) => {
        const parsed = JSON.parse(row) as Row;
        const ids = [
          parsed.evidence_id,
          parsed.id,
          parsed.claim_id,
          ...((parsed.support as string[] | undefined) ?? []),
        ];
        return !ids.some((one) => excluded.has(String(one)));
      });
    for (const [table] of TABLES) expect(other(ours[table] ?? []), table).toEqual(other(theirs[table] ?? []));

    // The forged message, inbound with the owner's address in From: its claims are unmapped as
    // bad_speaker, no fact comes from it, and no belief rests on it.
    const forged = evidenceOf(s, w.handles.forgedOwnerMessageId);
    const unmapped = await queryAs<{ id: string; compartments: string[]; facts_enc: never }>(
      db.urls.admin,
      "select id, compartments, facts_enc from vault.unmapped_claims where evidence_id = $1",
      [forged],
    );
    expect(unmapped.length).toBeGreaterThan(0);
    for (const row of unmapped) {
      const facts = JSON.parse(
        openRow(
          db.keys,
          row.compartments[0] ?? "",
          { table: "vault.unmapped_claims", id: row.id, column: "facts_enc" },
          row.facts_enc,
        ),
      ) as { reason: string };
      expect(facts.reason).toBe("bad_speaker");
    }
    expect(both.filter((fact) => fact.gmailId === w.handles.forgedOwnerMessageId)).toEqual([]);
    expect(await queryAs(db.urls.admin, "select id from knowledge.claims where evidence_id = $1", [forged])).toEqual(
      [],
    );
    // The third party's reversal closes nothing: its fact carries no status.
    expect(
      both
        .filter((fact) => fact.gmailId === w.handles.thirdPartyReversalMessageId)
        .every((fact) => fact.status === undefined),
    ).toBe(true);
  });

  it("E6: no canary is in plaintext, nor any canary's plain SHA-256, in any column", async () => {
    // Each new table holds a row first: a usage row and a review are written for the scan.
    const pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: quiet });
    try {
      await pipeline.recordUsage({
        promptId: "personal_transaction",
        promptVersion: "1",
        modelId: MODEL_ID,
        inputTokens: 1,
        outputTokens: 1,
        costMicroUsd: 1,
        outcome: "check",
      });
    } finally {
      await pipeline.close();
    }
    const canary = evidenceOf(s, w.handles.receiptCanaryMessageId);
    await withAdmin(db, (admin) =>
      admin.extraction.recordReview([{ evidenceId: canary, type: "transaction.receipt", verdict: "missed" }]),
    );
    for (const [table] of [...TABLES, ["vault.extraction_runs", ""]]) {
      expect(
        (await queryAs<{ n: number }>(db.urls.admin, `select count(*)::int as n from ${table}`))[0]?.n,
        table,
      ).toBeGreaterThan(0);
    }
    const values = [w.canaries.merchant, w.canaries.orderRef, w.canaries.amount, w.canaries.commitmentText];
    // The canary claim's id, its rendered input's hash (the call key's) and its raw output.
    const claims = await queryAs<{ id: string; compartments: string[]; content_enc: never }>(
      db.urls.admin,
      "select id, compartments, content_enc from knowledge.claims where evidence_id = $1",
      [canary],
    );
    const claimIds = claims.map(
      (row) =>
        (
          JSON.parse(
            openRow(
              db.keys,
              row.compartments[0] ?? "",
              { table: "knowledge.claims", id: row.id, column: "content_enc" },
              row.content_enc,
            ),
          ) as { claim: { id: string } }
        ).claim.id,
    );
    expect(claimIds.length).toBeGreaterThan(0);
    const inputs: string[] = [];
    const watcher = {
      async complete(request: ModelRequest): Promise<ModelResponse> {
        if (request.callKey?.evidenceId === canary) inputs.push(request.callKey.inputHash);
        return fakeModelClient(outputs).complete(request);
      },
      embed: fakeModelClient({}).embed,
    };
    // The input hash, read on a copy so this database is not changed; its saved calls are
    // deleted first, so the canary is asked again.
    const copy = await copyOf(pristine);
    try {
      await withAdmin(copy, (admin) => admin.extraction.retry({ all: true }, { confirmed: true }));
      await runWith(copy, watcher);
    } finally {
      await copy.drop();
    }
    expect(inputs).toHaveLength(1);
    const hashes = [...values.map(sha256), ...claimIds.map(sha256), ...inputs, sha256(JSON.stringify(outputs[canary]))];
    expect(await scanForPlaintext(db.urls.admin, [...values, ...hashes])).toEqual([]);

    // The positive control: a planted value is found.
    const [call] = await queryAs<{ id: string; model_id: string }>(
      db.urls.admin,
      "select id, model_id from vault.model_calls limit 1",
    );
    await queryAs(db.urls.admin, "update vault.model_calls set model_id = $1 where id = $2", [hashes[0], call?.id]);
    try {
      expect(await scanForPlaintext(db.urls.admin, [hashes[0] ?? ""])).toEqual([
        { table: "vault.model_calls", column: "model_id" },
      ]);
    } finally {
      await queryAs(db.urls.admin, "update vault.model_calls set model_id = $1 where id = $2", [
        call?.model_id,
        call?.id,
      ]);
    }
  });

  it("E1: the database refuses a claim labelled other than its evidence, for every role that can insert one", async () => {
    const insert = (url: string, compartments: string[]) =>
      queryAs(
        url,
        `insert into knowledge.claims (id, evidence_id, type, valid_from, fact_key_fp, extractor_generation, readers, content_enc, compartments)
         select md5(random()::text) || md5(random()::text), evidence_id, type, valid_from, fact_key_fp, extractor_generation, readers, content_enc, $2
         from knowledge.claims where evidence_id = $1 limit 1 returning id`,
        [evidenceOf(s, w.handles.receiptCanaryMessageId), compartments],
      );
    const code = (run: Promise<unknown>) =>
      run.then(
        () => null,
        (error: { code?: string }) => error.code ?? "none",
      );
    for (const url of [db.urls.pipeline, db.urls.admin]) {
      expect(await code(insert(url, ["employer:example"]))).toBe("23514");
      expect(await code(insert(url, ["own", "employer:example"]))).toBe("23514");
      // The positive control: the evidence's own compartment is taken, then removed again.
      const [row] = (await insert(url, ["own"])) as { id: string }[];
      expect(row).toBeDefined();
      await queryAs(db.urls.pipeline, "delete from knowledge.claims where id = $1", [row?.id]);
    }
    // The writer and the reader cannot insert one at all.
    for (const url of [db.urls.writer, db.urls.reader]) expect(await code(insert(url, ["own"]))).toBe("42501");
  });

  it("E9: pi extract refuses every other role's URL, and pi mcp and pi sync refuse the pipeline URL", async () => {
    const failed = (code: string) => `${JSON.stringify({ event: "command_failed", code })}\n`;
    for (const other of [
      "PI_DATABASE_URL_ADMIN",
      "PI_DATABASE_URL_WRITER",
      "PI_DATABASE_URL_READER",
      "PI_DATABASE_URL_BOOTSTRAP",
    ]) {
      const url = other === "PI_DATABASE_URL_BOOTSTRAP" ? db.urls.bootstrap : (adminEnv.PI_DATABASE_URL_ADMIN ?? "");
      expect(await pi(["extract"], { ...pipelineEnv, [other]: url })).toEqual({
        exit: 1,
        stdout: "",
        stderr: failed("wrong_role_url"),
      });
      expect(await pi(["extract", "check"], { ...pipelineEnv, [other]: url })).toEqual({
        exit: 1,
        stdout: "",
        stderr: failed("wrong_role_url"),
      });
    }
    expect(await pi(["mcp"], { ...readerEnv, PI_DATABASE_URL_PIPELINE: db.urls.pipeline })).toEqual({
      exit: 1,
      stdout: "",
      stderr: failed("wrong_role_url"),
    });
    expect(
      await pi(["sync"], {
        PI_DATABASE_URL_WRITER: db.urls.writer,
        PI_KEY_FILE: adminEnv.PI_KEY_FILE ?? "",
        PI_DATABASE_URL_PIPELINE: db.urls.pipeline,
      }),
    ).toEqual({ exit: 1, stdout: "", stderr: failed("wrong_role_url") });
    // Its grants, as the table has them: database.db.test.ts pins every privilege; here the
    // ones a leak would use.
    const can = async (privilege: string, table: string) =>
      (
        await queryAs<{ ok: boolean }>(db.urls.admin, "select has_table_privilege('pi_pipeline', $1, $2) as ok", [
          table,
          privilege,
        ])
      )[0]?.ok;
    for (const table of ["policy.clients", "policy.calls", "policy.tool_names"])
      expect(await can("select", table), table).toBe(false);
    for (const table of ["knowledge.entities", "knowledge.accounts", "knowledge.messages"])
      expect(await can("insert", table), table).toBe(false);
    expect(await can("update", "knowledge.claims")).toBe(false);
    expect(await can("insert", "knowledge.claims")).toBe(true);
  });

  it("E5: a message deleted at the source, or revised, leaves nothing that cites the removed revision", async () => {
    const deleted = w.handles.commitmentOutboundMessageId;
    const revised = w.handles.receiptCanaryMessageId;
    const removed = [evidenceOf(s, deleted), evidenceOf(s, revised)];
    // A review of each, so the reviews are covered too.
    await withAdmin(db, (admin) =>
      admin.extraction.recordReview(
        removed.map((evidenceId) => ({ evidenceId, type: "any", verdict: "missed" as const })),
      ),
    );
    expect(
      await queryAs(db.urls.admin, "select 1 from vault.extraction_reviews where evidence_id = any ($1)", [removed]),
    ).not.toEqual([]);
    const pipelineClaims = await queryAs<{ id: string }>(
      db.urls.admin,
      "select id from knowledge.claims where evidence_id = any ($1)",
      [removed],
    );
    expect(pipelineClaims.length).toBeGreaterThan(0);
    // The positive control: a computed belief rests on one of them before the source removes it.
    expect(
      await restingOn(
        db,
        pipelineClaims.map((row) => row.id),
      ),
    ).not.toEqual([]);
    const personal = sources.find((one) => one.label === "personal");
    personal?.gmail.deletePermanently(deleted);
    const labels = w.accounts.flatMap((one) => one.messages).find((one) => one.id === revised)?.labelIds ?? [];
    personal?.gmail.relabel(revised, [...labels, "SENT"]);
    await sync(db, w, now, sources);
    const claimIds = pipelineClaims.map((row) => row.id);
    for (const [table, column] of [
      ["knowledge.claims", "evidence_id"],
      ["vault.model_calls", "evidence_id"],
      ["vault.pipeline_items", "evidence_id"],
      ["vault.extraction_reviews", "evidence_id"],
      ["vault.unmapped_claims", "evidence_id"],
    ] as const) {
      expect(
        await queryAs(db.urls.admin, `select 1 from ${table} where ${column} = any ($1)`, [removed]),
        table,
      ).toEqual([]);
    }
    expect(
      await queryAs(db.urls.admin, "select 1 from knowledge.claim_entities where claim_id = any ($1)", [claimIds]),
    ).toEqual([]);
    // No belief computed for any audience rests on a removed claim.
    expect(await restingOn(db, claimIds)).toEqual([]);
    // The positive control: the revised message's new revision is stored, and due.
    expect(
      await queryAs(db.urls.admin, "select 1 from vault.evidence_items where id = $1", [evidenceOf(s, revised, 1)]),
    ).toHaveLength(1);
  });
});

describe("stage 2, a world of its own for each case", () => {
  const made: Synced[] = [];
  afterAll(async () => {
    for (const one of made.splice(0)) await one.drop();
  });
  const fresh = async (options?: Parameters<typeof syncedWorld>[0]) => {
    const one = await syncedWorld(options);
    made.push(one);
    return one;
  };

  it("E2: a client cleared for own reads the same with and without the employer account", async () => {
    const one = await fresh({ labels: ["personal"] });
    const own = await addClient(one.db, "own", ["own"]);
    await addClient(one.db, "both", ["own", "employer:example"]);
    // What the own client's audience is given: every belief computed for it, whole.
    const ownBeliefs = async () => (await computedBeliefs(one.db)).filter((belief) => belief.audience.join() === "own");
    expect((await inProcess(["extract"], one.pipeline, { deps: { model: fakeModelClient(one.outputs) } })).exit).toBe(
      0,
    );
    const before = { facts: await findFacts(one.db, own), beliefs: await ownBeliefs() };
    expect(before.beliefs.length).toBeGreaterThan(0);

    // The work account's mail and its claims arrive.
    await sync(one.db, one.w, one.now, one.sources);
    const accounts = await gmailAccounts(one.db);
    expect(Object.keys(accounts).sort()).toEqual(["personal", "work"]);
    expect(
      (
        await inProcess(["extract"], one.pipeline, {
          deps: { model: fakeModelClient(worldModelOutputs(one.w, accounts)) },
        })
      ).exit,
    ).toBe(0);
    expect(
      await queryAs<{ n: number }>(
        one.db.urls.admin,
        "select count(*)::int as n from knowledge.claims where compartments = '{employer:example}'",
      ),
    ).not.toEqual([{ n: 0 }]);
    expect({ facts: await findFacts(one.db, own), beliefs: await ownBeliefs() }).toEqual(before);
    expect(comparable(before.facts.facts, await gmailIds({ ...one, accounts }))).toEqual(expectedFacts(one.w, "own"));
    // An address known only under employer:example resolves to nobody for an own item.
    expect(
      await queryAs(one.db.urls.admin, "select id from knowledge.claims where evidence_id = $1", [
        evidenceOf({ ...one, accounts }, one.w.handles.namesWorkOnlyMessageId),
      ]),
    ).toEqual([]);
  });

  it("E3: a reserved key, an unknown key, a tool call and a cut-off answer fail their item, commit nothing, and replay as rejections", async () => {
    const one = await fresh();
    const toolItem = evidenceOf(one, one.w.handles.planMessageId);
    const openrouter = fakeOpenRouter(() => ({
      body: {
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify(one.outputs[toolItem]),
              tool_calls: [{ id: "c1", type: "function", function: { name: "send", arguments: "{}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.0001 },
      },
    }));
    const real = createOpenRouterClient({
      apiKey: "sk-test",
      model: MODEL_ID,
      registry: EXTRACT_PROMPTS,
      onUsage: async () => {},
      deps: { fetch: openrouter.fetch },
    });
    const fake = recording(one.outputs);
    const composite = {
      complete: (request: ModelRequest) =>
        request.callKey?.evidenceId === toolItem ? real.complete(request) : fake.client.complete(request),
      embed: fake.client.embed,
    };
    expect((await inProcess(["extract"], one.pipeline, { deps: { model: composite } })).exit).toBe(0);
    const four = [
      one.w.handles.reservedKeyMessageId,
      one.w.handles.unknownKeyMessageId,
      one.w.handles.cutOffMessageId,
    ].map((id) => evidenceOf(one, id));
    const rows = await statuses(one.db);
    expect(four.map((id) => [rows.get(id)?.status, rows.get(id)?.code])).toEqual([
      ["failed", "interpret_failed"],
      ["failed", "interpret_failed"],
      ["failed", "cut_off"],
    ]);
    expect([rows.get(toolItem)?.status, rows.get(toolItem)?.code]).toEqual(["failed", "interpret_failed"]);
    expect(
      await queryAs(one.db.urls.admin, "select 1 from knowledge.claims where evidence_id = any ($1)", [
        [...four, toolItem],
      ]),
    ).toEqual([]);
    expect(openrouter.bodies).toHaveLength(1);

    // A new generation replays every saved call: none of the four is asked again.
    fake.asked.splice(0);
    expect(await runWith(one.db, composite, undefined, 2)).toMatchObject({ code: "ok" });
    expect(fake.asked.filter((id) => four.includes(id))).toEqual([]);
    expect(openrouter.bodies).toHaveLength(1);
    const again = await statuses(one.db);
    expect([again.get(toolItem)?.status, again.get(toolItem)?.code]).toEqual(["failed", "interpret_failed"]);
  });

  it("E4: a run stopped at each kill point and run again ends with the rows of one uninterrupted run, and buys no saved answer again", async () => {
    const one = await fresh();
    const copy = await copyOf(one.db);
    try {
      // The reference: one uninterrupted run on the copy.
      expect(await runWith(copy, fakeModelClient(one.outputs))).toMatchObject({ code: "ok" });

      // On the original, pass k stops the run at its kth model call, before the answer, or just
      // after its kth commit, whichever comes first; from then nothing the process does is written.
      const fake = recording(one.outputs);
      const saved = new Set<string>();
      for (let k = 1; k < 200; k += 1) {
        let dead = false;
        let calls = 0;
        let commits = 0;
        const kill = (): never => {
          dead = true;
          throw new Error("killed");
        };
        const model = {
          async complete(request: ModelRequest): Promise<ModelResponse> {
            if (dead) kill();
            calls += 1;
            if (calls === k) kill();
            const id = request.callKey?.evidenceId ?? "";
            // No answer that was saved is bought again.
            expect(saved.has(id), id).toBe(false);
            const response = await fake.client.complete(request);
            saved.add(id);
            return response;
          },
          embed: fake.client.embed,
        };
        const wrap = (store: PersonalPipelineStore): PersonalPipelineStore =>
          new Proxy(store, {
            get(target, name, receiver) {
              const value = Reflect.get(target, name, receiver) as unknown;
              if (typeof value !== "function") return value;
              return (...args: unknown[]) => {
                if (dead && name !== "withExtractLock") kill();
                const result = (value as (...a: unknown[]) => unknown).apply(target, args);
                if (name === "calls") {
                  const calls = result as ReturnType<PersonalPipelineStore["calls"]>;
                  return {
                    find: (...a: Parameters<typeof calls.find>) => (dead ? kill() : calls.find(...a)),
                    save: (...a: Parameters<typeof calls.save>) => (dead ? kill() : calls.save(...a)),
                  };
                }
                if (name === "commit") {
                  return (result as Promise<unknown>).then((done) => {
                    commits += 1;
                    if (commits === k) kill();
                    return done;
                  });
                }
                return result;
              };
            },
          });
        const summary = await runWith(one.db, model, wrap).catch(() => "killed" as const);
        if (!dead && summary !== "killed") break;
      }
      // One more run, uninterrupted, changes nothing.
      expect(await runWith(one.db, fakeModelClient(one.outputs))).toMatchObject({ code: "ok" });
      expect(await snapshot(one.db)).toEqual(await snapshot(copy));
      // first_known_at is left out as a clock column: with no re-derive to carry an earlier one,
      // each claim's is its own created_at, on both sides.
      for (const db of [one.db, copy])
        expect(
          await queryAs(db.urls.admin, "select id from knowledge.claims where first_known_at <> created_at"),
        ).toEqual([]);
    } finally {
      await copy.drop();
    }
  });

  it("E8: with the model down or the budget at zero, sync and every read tool are unchanged, the items wait and no attempt is spent", async () => {
    const one = await fresh();
    const added = await inProcess(
      [
        "clients",
        "add",
        "stage1",
        "--views",
        "self,people,work",
        "--tools",
        TOOLS.join(","),
        "--compartments",
        "own,employer:example",
      ],
      one.admin,
    );
    expect(added.exit).toBe(0);
    const token = added.stdout.trim();
    const env = { PI_DATABASE_URL_READER: one.db.urls.reader, PI_KEY_FILE: one.admin.PI_KEY_FILE ?? "" };
    // get_self's work carries the read's own time, which no sync changes.
    const unclocked = (one: unknown): unknown => {
      const work = (one as { work?: { asOf?: string } } | null)?.work;
      return work?.asOf === undefined ? one : { ...(one as object), work: { ...work, asOf: "<read time>" } };
    };
    const reads = async () => {
      const self = (await mcp(env, token, [{ name: "get_self" }]))[0] as { contacts?: { id: string }[] };
      const person = self.contacts?.[0]?.id;
      const listed = (await mcp(env, token, [{ name: "find_messages", args: { limit: 5 } }]))[0] as {
        messages: { id: string }[];
      };
      return (
        await mcp(env, token, [
          { name: "get_self" },
          { name: "search", args: { query: "a" } },
          { name: "get_entity", args: { id: person } },
          { name: "get_timeline", args: { id: person } },
          { name: "find_messages", args: { limit: 5 } },
          { name: "read_message", args: { id: listed.messages[0]?.id } },
        ])
      ).map(unclocked);
    };
    // Every extract run builds the warmth tier, which needs no model, so even a run with the model
    // down builds it. One such run first, so the baseline holds the warmth the runs below keep
    // (nothing new arrives, so they rebuild nothing).
    expect((await inProcess(["extract"], one.pipeline, { deps: { model: fakeModelClient({}) } })).exit).toBe(0);
    const before = await reads();
    for (const one of before) expect(one).not.toHaveProperty("error");
    const dueBefore = (JSON.parse((await inProcess(["extract", "status"], one.admin)).stdout) as { due: number }).due;

    for (const [env2, model, code] of [
      [{}, fakeModelClient({}), "model_unavailable"],
      [{ PI_EXTRACT_DAY_USD: "0" }, fakeModelClient(one.outputs), "budget"],
    ] as const) {
      const result = await inProcess(["extract"], { ...one.pipeline, ...env2 }, { deps: { model } });
      expect(result.exit).toBe(0);
      expect(events(result.stderr).find((event) => event.event === "extract_run")?.code).toBe(code);
      await sync(one.db, one.w, one.now, one.sources);
      expect(await reads()).toEqual(before);
      const view = JSON.parse((await inProcess(["extract", "status"], one.admin)).stdout) as {
        due: number;
        runs: { code: string }[];
      };
      expect(view.runs[0]?.code).toBe(code);
      const skipped = [...(await statuses(one.db)).values()].filter((row) => row.status === "skipped").length;
      expect(view.due).toBe(dueBefore - skipped);
      expect([...(await statuses(one.db)).values()].every((row) => row.attempts === 0)).toBe(true);
    }
  });

  it("a re-derive and a replay end with the same facts and no request", async () => {
    const one = await fresh();
    const own = await addClient(one.db, "own", ["own"]);
    const both = await addClient(one.db, "both", ["own", "employer:example"]);
    // The copy will know the owner's other address before its first extraction.
    const first = await copyOf(one.db);
    const alias = one.w.handles.ownerAliasAddress;
    const skipped = one.w.handles.commitmentInboundMessageId;
    const env = (base: TestDatabase) => ({
      PI_DATABASE_URL_ADMIN: base.urls.admin,
      PI_KEY_FILE: one.admin.PI_KEY_FILE ?? "",
    });
    const pipelineOf = (base: TestDatabase) => ({ ...one.pipeline, PI_DATABASE_URL_PIPELINE: base.urls.pipeline });
    const messageId = async (base: TestDatabase) =>
      (
        await queryAs<{ id: string }>(base.urls.admin, "select id from knowledge.messages where evidence_id = $1", [
          evidenceOf(one, skipped),
        ])
      )[0]?.id ?? "";
    try {
      // Learned late: extract, send one item to skip, then the address, a sync and a replay.
      const late = recording(one.outputs);
      expect((await inProcess(["extract"], one.pipeline, { deps: { model: late.client } })).exit).toBe(0);
      expect(
        (await inProcess(["extract", "retry", "--message", await messageId(one.db), "--lane", "skip"], one.admin)).exit,
      ).toBe(0);
      expect((await inProcess(["extract"], one.pipeline, { deps: { model: late.client } })).exit).toBe(0);
      expect((await inProcess(["owner", "add-address", alias], one.admin)).exit).toBe(0);
      await sync(one.db, one.w, one.now, one.sources);
      late.asked.splice(0);
      expect((await inProcess(["extract"], one.pipeline, { deps: { model: late.client } })).exit).toBe(0);
      expect(late.asked).toEqual([]);
      expect((await statuses(one.db)).get(evidenceOf(one, skipped))?.status).toBe("skipped");

      // Known first.
      expect((await inProcess(["owner", "add-address", alias], env(first))).exit).toBe(0);
      await sync(first, one.w, one.now, fakeSources(one.w));
      const early = recording(one.outputs);
      expect((await inProcess(["extract"], pipelineOf(first), { deps: { model: early.client } })).exit).toBe(0);
      expect(
        (await inProcess(["extract", "retry", "--message", await messageId(first), "--lane", "skip"], env(first))).exit,
      ).toBe(0);
      expect((await inProcess(["extract"], pipelineOf(first), { deps: { model: early.client } })).exit).toBe(0);

      const read = async (base: TestDatabase, token: string) =>
        comparable((await findFacts(base, token)).facts, await gmailIds({ ...one, db: base }));
      expect(await read(one.db, own)).toEqual(await read(first, own));
      expect(await read(one.db, both)).toEqual(await read(first, both));
      const ids = async (base: TestDatabase) =>
        (await queryAs<{ id: string }>(base.urls.admin, "select id from knowledge.claims order by id")).map(
          (row) => row.id,
        );
      expect(await ids(one.db)).toEqual(await ids(first));
      // Every audience's computed beliefs, whole, the same in both.
      const beliefs = await computedBeliefs(one.db);
      expect(beliefs.length).toBeGreaterThan(0);
      expect(beliefs).toEqual(await computedBeliefs(first));
    } finally {
      await first.drop();
    }
  });
});
