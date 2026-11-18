import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRequest, ModelResponse } from "@intelligence/contracts";
import {
  BELIEF_TYPES,
  CANARY_CLEARANCE,
  CANARY_COMPARTMENT,
  CANARY_PROBE,
  type CardId,
  type NewCard,
  type PersonalCompartment,
} from "@intelligence/contracts/personal";
import { world } from "@intelligence/personal-core/testing";
import { serveHttp } from "@intelligence/personal-mcp";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import {
  type Admin,
  createAdmin,
  createPipeline,
  createReader,
  createWork,
  createWriter,
  loadKeys,
  withoutCanary,
} from "@intelligence/personal-store";
import { queryAs, type TestDatabase } from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunDeps } from "../command-types.ts";
import { afterSync } from "../intake/sync-command.ts";
import { MODEL_ID, pi, quiet, type Synced, syncedWorld, withAdmin } from "../test-support/extract-fixtures.ts";
import { canaryApi } from "./api.ts";
import { canaryPlant } from "./plant.ts";

// The standing end-to-end check: one run passes end to end on the real roles, the real `pi` commands
// and the real agent API over HTTP, with a fake model; each hop broken in turn records that hop's
// code; and a real client and the owner's own reads see nothing of it, by name, count, ranking or
// anything else. Made-up values only.

const DAY = 86_400_000;
// What the last check logged: a red row's refusals, by their codes, for a failure's message.
let lastCheck = "";
const today = (back: number): string => new Date(Date.now() - back * DAY).toISOString().slice(0, 10);

let synced: Synced;
let db: TestDatabase;
let server: Server;
let url: string;
let dir: string;
let tokens: string;
let reader: ReturnType<typeof createReader>;

type Broken = { claims?: "none" | "commitment"; againDiffers?: true };
type Plant = ReturnType<typeof canaryPlant>;
const mentionOf = (address: string, at: string) => ({ key: { kind: "address", value: address }, observedAt: at });

// The one claim the fake model finds in an item of the day, in the shape its lane checks: who, and a
// span that cites the line that says so.
function claimFor(request: ModelRequest, plant: Plant, broken: Broken): unknown {
  if (broken.claims === "none") return { claims: [], narrowing: "none" };
  const data = (request as { data?: Record<string, unknown> }).data ?? {};
  const spanOf = (slot: unknown, word: string): string => {
    const shown = JSON.parse(String(slot)) as {
      passages?: { span: string; text: string }[];
      moments?: { passages: { span: string; text: string }[] }[];
    };
    const all = shown.passages ?? shown.moments?.flatMap((one) => one.passages) ?? [];
    return all.find((one) => one.text.includes(word))?.span ?? "chars:0-1";
  };
  const commitment = (subject: unknown, counterparty: unknown, what: string, span: string, basis: string) => ({
    claims: [
      { type: "commitment", subject, fields: { counterparty, what }, statementKind: "stated_fact", basis, span },
    ],
    narrowing: "none",
  });
  if (data.moments !== undefined) {
    const at = plant.moment.observedAt;
    const who = (label: string) => ({ key: { kind: "source_id", value: `speaker:${label}` }, observedAt: at });
    return commitment(who("P1"), who("owner"), plant.moment.text, spanOf(data.moments, plant.word), "third_party");
  }
  if (data.document !== undefined) {
    const at = plant.document.file.modifiedTime;
    const text = (plant.document.body.blocks[0] as { text: string }).text;
    return {
      claims: [
        {
          type: "commitment",
          subject: mentionOf(plant.people.document.address, at),
          fields: {
            counterparty: mentionOf("canary@example.invalid", at),
            what: text,
            due: text.slice(-11, -1),
          },
          statementKind: "stated_fact",
          basis: "third_party",
          span: spanOf(data.document, plant.word),
        },
      ],
      narrowing: "none",
    };
  }
  if (data.meeting !== undefined) {
    const at = plant.meeting.startedAt;
    const who = (label: string) => ({ key: { kind: "source_id", value: `speaker:${label}` }, observedAt: at });
    return commitment(
      who("S2"),
      who("S1"),
      plant.meeting.segments[1]?.text ?? "",
      spanOf(data.meeting, plant.word),
      "explicit_self",
    );
  }
  if (request.promptId === "personal_agent_record") {
    const text = JSON.stringify(data);
    if (!text.includes("prefers")) return { claims: [], narrowing: "none" };
    const at = new Date().toISOString();
    return {
      claims: [
        {
          type: "preference",
          subject: mentionOf(plant.people.mail.address, at),
          fields: {
            domain: "career",
            object: `work updates titled "${plant.word} status report"`,
            polarity: "prefers",
          },
          statementKind: "stated_fact",
          basis: "third_party",
          span: "chars:0-10",
        },
      ],
      narrowing: "none",
    };
  }
  const at = new Date(plant.mail.internalDate).toISOString();
  const subject = mentionOf(plant.people.mail.address, at);
  const span = `chars:0-${(plant.mail.text ?? "").length}`;
  if (broken.claims === "commitment")
    return commitment(subject, mentionOf("canary@example.invalid", at), plant.title, span, "explicit_self");
  const organization = { key: { kind: "source_id", value: "domain:example.invalid" }, observedAt: at };
  return {
    claims: [
      {
        type: "role",
        subject,
        fields: { title: plant.title, organization },
        statementKind: "stated_fact",
        basis: "explicit_self",
        span,
      },
    ],
    narrowing: "none",
  };
}

function modelFor(day: string, broken: Broken = {}): NonNullable<RunDeps["model"]> {
  const plant = canaryPlant(day);
  let proposals = 0;
  const fallback = fakeModelClient({});
  return {
    complete: async (request: ModelRequest): Promise<ModelResponse> => {
      const evidence = request.callKey?.evidenceId;
      if (evidence === undefined || request.promptId.includes("relations")) return fallback.complete(request);
      const answer = claimFor(request, plant, broken) as { claims: { fields: { object?: string } }[] };
      const first = answer.claims[0]?.fields;
      if (broken.againDiffers === true && first?.object !== undefined) {
        proposals += 1;
        if (proposals > 1) first.object = "status report";
      }
      return fakeModelClient({ [evidence]: answer }).complete(request);
    },
    embed: (request) => fallback.embed(request),
  };
}

const environment = {
  admin: (): Record<string, string> => ({
    PI_EXTRACT_DOCUMENTS: "1",
    PI_EXTRACT_MEETINGS: "1",
    PI_EXTRACT_MOMENTS: "1",
    PI_DATABASE_URL_ADMIN: db.urls.admin,
    PI_KEY_FILE: db.keyFile,
    PI_CANARY_API_URL: url,
    PI_CANARY_TOKENS: tokens,
    PI_RECORD_ENABLED: "1",
  }),
  writer: (): Record<string, string> => ({
    PI_DATABASE_URL_WRITER: db.urls.writer,
    PI_KEY_FILE: db.keyFile,
    PI_CANARY_API_URL: url,
    PI_CANARY_TOKENS: tokens,
  }),
  pipeline: (): Record<string, string> => ({
    PI_DATABASE_URL_PIPELINE: db.urls.pipeline,
    PI_KEY_FILE: db.keyFile,
    PI_EXTRACT_MODEL: MODEL_ID,
  }),
};

type Run = {
  deps: RunDeps;
  // False: the pipeline does not run at all.
  pipeline?: false;
  beforeLastExtract?: () => Promise<unknown>;
  beforeCheck?: () => Promise<unknown>;
  afterCheck?: () => Promise<unknown>;
  // A tool whose reply the check is given empty.
  thin?: string;
  // The switches the owner has off, as the check's environment holds them.
  lanesOff?: true;
  // What the extractions' environment changes: the day's budget.
  extract?: (env: Record<string, string>) => Record<string, string>;
};

// The steps as `lib/canary-run` runs them; what `check` printed, one `source code` a line.
async function canaryRun(day: string, run: Run): Promise<Record<string, string>> {
  const deps: RunDeps = {
    ...run.deps,
    canaryFetch: async (input, init) => {
      const body = JSON.parse(String(init?.body)) as { id: number; params: { name: string } };
      if (body.params.name === run.thin)
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { structuredContent: {} } }));
      return fetch(input, init);
    },
  };
  const step = async (argv: string[], env: Record<string, string>) => (await pi(argv, env, { deps })).stdout;
  const extract = run.extract ?? ((env) => env);
  let budget = false;
  await step(["canary", "plant", "--day", day], environment.writer());
  if (run.pipeline !== false && (await step(["extract", "--canary"], extract(environment.pipeline()))) === "budget\n")
    budget = true;
  await step(["canary", "answer", "--day", day], environment.admin());
  await step(["sync", "--records"], environment.writer());
  await run.beforeLastExtract?.();
  if (run.pipeline !== false && (await step(["extract", "--canary"], extract(environment.pipeline()))) === "budget\n")
    budget = true;
  await run.beforeCheck?.();
  const checkEnv = environment.admin();
  if (run.lanesOff === true) {
    delete checkEnv.PI_EXTRACT_DOCUMENTS;
    delete checkEnv.PI_EXTRACT_MEETINGS;
    delete checkEnv.PI_EXTRACT_MOMENTS;
  }
  const { stdout, exit, stderr } = await pi(
    ["canary", "check", "--day", day, ...(budget ? ["--budget"] : [])],
    checkEnv,
    { deps },
  );
  await run.afterCheck?.();
  lastCheck = stderr;
  // A red source's streak raises its card, which logs; nothing else may.
  expect({
    exit,
    other: stderr
      .split("\n")
      .filter((one) => one !== "" && !one.includes("box_health_raised") && !one.includes("canary_read_refused")),
  }).toEqual({
    exit: 0,
    other: [],
  });
  return Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .map((line) => line.split(" ")),
  );
}

const rowsOf = <T>(sql: string, values: unknown[] = []): Promise<T[]> => queryAs<T>(db.urls.admin, sql, values);

const AGENT_CLAIM_OPTIONS = ["confirm", "reject"];
const CLEAN = {
  gmail: "ok",
  calendar: "ok",
  drive: "ok",
  contact: "ok",
  meeting: "ok",
  moment: "ok",
  finding: "ok",
  proposal: "ok",
};

// A real client, cleared for the owner's own compartment as an agent is, and what it reads of
// everything a canary could reach.
const REAL_READS: [string, Record<string, unknown>][] = [
  ["search", { query: "Ines Varga" }],
  ["search", { query: "Example Harbor" }],
  ["list_people", {}],
  ["get_self", {}],
  ["find_facts", {}],
  ["get_beliefs", {}],
  ["find_messages", {}],
  ["list_opportunities", {}],
];
async function realReads(): Promise<unknown[]> {
  const read = canaryApi(url, { writer: "", probe: real, capture: "" });
  const answers = [];
  for (const [tool, args] of REAL_READS) {
    // A reply past its deadline on a loaded machine says nothing of what it would have held.
    let answer = await read("probe", tool, args);
    for (let again = 0; again < 3 && !answer.ok && answer.code === "unavailable"; again += 1)
      answer = await read("probe", tool, args);
    answers.push(answer);
  }
  // When the read itself ran is no part of what it says.
  return JSON.parse(JSON.stringify(answers, (key, value) => (key === "asOf" ? undefined : value)));
}

// What the owner's own reads hold: the owner's key set, as `pi`'s owner commands are given it.
async function ownerReads(): Promise<unknown> {
  const admin = createAdmin({ url: db.urls.admin, keys: withoutCanary(await loadKeys(db.keyFile)), log: quiet });
  try {
    const outcomes = await admin.box.outcomes(14);
    const status = await admin.accounts.status();
    // The tables with a label; a real client's own reads are logged in the read logs, under its label.
    const labelledTables = new Set(
      (
        await rowsOf<{ name: string }>(
          `select table_schema || '.' || table_name as name from information_schema.columns
           where column_name = 'compartments' and table_name not in ('read_log', 'context_packs', 'sessions', 'capture_inbox', 'extraction_runs')`,
        )
      ).map((row) => row.name),
    );
    return {
      pending: (await admin.cards.listPending()).map((card) => card.id),
      self: (await admin.self.review()).map((row) => row.fact),
      metrics: outcomes.metrics,
      // get_entity is the probe's alone here; the real client's own reads count, and are not this.
      probed: outcomes.usage.tools.filter((one) => one.tool === "get_entity").map((one) => one.calls),
      coverage: (await admin.box.coverage(14, { generation: 1 })).map((row) => `${row.kind}/${row.id}`).sort(),
      // The owner's warmth labels: a canary label's days are its own, which no owner read reaches.
      warmthLabels: await queryAs<{ compartments: string[] }>(
        db.urls.admin,
        "select distinct compartments from projections.warmth_day_builds where not compartments && $1::text[] order by compartments",
        [[...CANARY_CLEARANCE]],
      ),
      missing: status.missingKeys,
      labelled: Object.fromEntries(Object.entries(status.tables).filter(([table]) => labelledTables.has(table))),
      documents: status.drive.documents,
      digest: await admin.cards.digest(),
      agents: (await admin.releases.confirmRates()).agents.map((one) => one.client),
      decisions: JSON.parse((await pi(["work", "report", "--days", "7"], environment.admin(), { tty: true })).stdout)
        .decisions,
    };
  } finally {
    await admin.close();
  }
}

let real = "";
let before: { real: unknown[]; owner: unknown };

beforeAll(async () => {
  synced = await syncedWorld();
  db = synced.db;
  dir = await mkdtemp(join(tmpdir(), "canary-"));
  tokens = join(dir, "tokens.json");
  url = "";
  const setup = await pi(["canary", "setup"], environment.admin());
  expect(setup.stderr).toBe("");
  real = await withAdmin(
    db,
    async (admin) =>
      (
        await admin.clients.addClient({
          name: "moth",
          runtime: "local",
          vendorRetention: "none",
          compartments: ["own"],
          views: ["self", "people", "work"],
          tools: [
            "search",
            "list_people",
            "get_self",
            "find_facts",
            "get_beliefs",
            "find_messages",
            "list_opportunities",
          ],
        })
      ).token,
  );
  // The world's own extraction, so a real client's reads and rankings hold something to change.
  await pi(["extract"], synced.pipeline, { deps: { model: fakeModelClient(synced.outputs) } });
  await pi(["erase", "replay"], environment.admin());
  // What a full sync does after its labels has run once on the world, so the first canary's run of
  // the same steps raises no card of the world's own.
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log: quiet });
  await afterSync(writer, db.keys, {}, quiet, "ok");
  await writer.close();
  // The agent API, as `pi http` opens it.
  reader = createReader({ url: db.urls.reader, keys: await loadKeys(db.keyFile), log: quiet });
  server = serveHttp({ provider: reader, work: createWork({ reader, log: quiet }) }, quiet);
  await new Promise<void>((done) => server.listen({ port: 0, host: "127.0.0.1" }, () => done()));
  const address = server.address();
  url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  const realBefore = await realReads();
  before = { real: realBefore, owner: await ownerReads() };
}, 600_000);

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise((done) => (server === undefined ? done(undefined) : server.close(done)));
  await reader?.close();
  await rm(dir, { recursive: true, force: true });
  await synced?.drop();
}, 60_000);

describe("the standing end-to-end check", { timeout: 300_000 }, () => {
  it("one run passes end to end, one job_runs row a source", async () => {
    const day = today(0);
    const results = await canaryRun(day, { deps: { model: modelFor(day) } });
    expect(results, `${JSON.stringify(results)} ${lastCheck}`).toEqual(CLEAN);
    const rows = await rowsOf<{ about: string; code: string }>(
      "select about, code from ledger.job_runs where job = 'canary' order by about",
    );
    expect(rows.map((row) => row.about)).toEqual(Object.keys(CLEAN).sort());
    expect(rows.every((row) => row.code === "ok")).toBe(true);
  });

  it("a real client and the owner's own reads see nothing of it: no name, count or ranking", async () => {
    expect(await ownerReads()).toEqual(before.owner);
    expect(await realReads()).toEqual(before.real);
    expect(JSON.stringify(await realReads())).not.toMatch(/quillwork|example\.invalid/);
  });

  it("no canary enters warmth, tiers, opportunities, gap flags or the planner", async () => {
    const tick = await pi(["work", "tick"], {
      PI_DATABASE_URL_WORK: db.urls.work,
      PI_ERASURE_JOURNAL: `${db.keyFile}.erasures`,
    });
    expect(tick.exit).toBe(0);
    const held = [...CANARY_CLEARANCE];
    const count = async (sql: string): Promise<number> => (await rowsOf<{ n: number }>(sql, [held]))[0]?.n ?? -1;
    // The owner's warmth, and so the tiers ranked from it, under no canary compartment: no day's label
    // mixes one with the owner's.
    expect(
      await count(
        "select count(*)::int as n from projections.warmth_days where compartments && $1::text[] and not compartments <@ $1::text[]",
      ),
    ).toBe(0);
    // No belief computed for any audience, a client's or the owner's, mixes one with the owner's.
    const mixed = (label: readonly string[]): boolean =>
      label.some((one) => held.includes(one)) && !label.every((one) => held.includes(one));
    const pipeline = createPipeline({ url: db.urls.pipeline, keys: await loadKeys(db.keyFile), log: quiet });
    try {
      const computed = await pipeline.sweepBeliefs(BELIEF_TYPES);
      expect(computed.length).toBeGreaterThan(0);
      expect(
        computed.filter((one) => mixed(one.audience) || one.records.some((record) => mixed(record.compartments))),
      ).toEqual([]);
    } finally {
      await pipeline.close();
    }
    // A tier the proposer raised, an opportunity, a gap flag and what the planner is given.
    expect(await count("select count(*)::int as n from ledger.opportunities where compartments && $1::text[]")).toBe(0);
    expect(
      await rowsOf(
        "select kind, case_key, compartments from ledger.cards where compartments && $1::text[] and kind not in ('about_you', 'agent_claim')",
        [held],
      ),
    ).toEqual([]);
    expect(await realReads()).toEqual(before.real);
  });

  it("an owner's erasure of a real person passes over a canary's rows", async () => {
    const [person] = await rowsOf<{ id: string }>(
      `select e.id from knowledge.entities e join knowledge.accounts a on a.entity_id = e.id
       where e.kind = 'person' and a.compartments = '{own}' order by e.id limit 1`,
    );
    const erased = await pi(["erase", "person", person?.id ?? "", "--dry-run"], environment.admin());
    expect(erased.exit, erased.stderr).toBe(0);
  });

  it("the outcome report carries one line of the check", async () => {
    const admin = createAdmin({ url: db.urls.admin, keys: withoutCanary(await loadKeys(db.keyFile)), log: quiet });
    try {
      const { canary } = await admin.box.outcomes(14);
      expect(canary.map((one) => [one.source, one.code]).sort()).toEqual(Object.entries(CLEAN).sort());
    } finally {
      await admin.close();
    }
  });

  it("leaves no card waiting of its own: the finding's is withdrawn, and none holds a real card back", async () => {
    const waiting = await rowsOf(
      `select c.kind from ledger.cards c where c.compartments && $1::text[]
         and (select r.event from ledger.record_events r where r.row_kind = 'card' and r.row_id = c.id order by r.id desc limit 1) in ('pending', 'deferred')`,
      [[...CANARY_CLEARANCE]],
    );
    expect(waiting).toEqual([]);
    const raise = (n: number, compartments: string[]) =>
      withAdmin(db, (admin) =>
        admin.cards.raiseCard({
          id: `crd_01JCANARYCARD${String(n).padStart(13, "0")}` as CardId,
          requestId: `canary-cap-${String(n).padStart(8, "0")}`,
          kind: "agent_claim",
          author: "system:extract",
          options: AGENT_CLAIM_OPTIONS,
          target: null,
          refs: [],
          compartments: compartments as PersonalCompartment[],
          expiresAt: null,
          expiresAfterDays: 30,
          caseKey: null,
          run: null,
          body: null,
          bodyFrom: null,
        } as NewCard),
      );
    for (let n = 1; n <= 10; n += 1) await raise(n, [...CANARY_CLEARANCE]);
    await raise(11, ["own"]);
    const [state] = await rowsOf<{ event: string }>(
      "select event from ledger.record_events where row_kind = 'card' and row_id = $1 order by id desc limit 1",
      [`crd_01JCANARYCARD${String(11).padStart(13, "0")}`],
    );
    expect(state?.event).toBe("pending");
    const [admitted] = await rowsOf<{ pending: number }>(
      "select count(*)::int as pending from ledger.cards c where c.compartments = '{own}' and c.id like 'crd_01JCANARYCARD%'",
    );
    expect(admitted?.pending).toBe(1);
  });

  it("a second card for the same proposal is red, not green", async () => {
    const day = today(6);
    expect(await canaryRun(day, { deps: { model: modelFor(day, { againDiffers: true }) } })).toMatchObject({
      proposal: "no_belief",
    });
  });

  it("a real lane off is reported as such, and raises no card of its own", async () => {
    const day = today(7);
    const results = await canaryRun(day, {
      deps: { model: modelFor(day) },
      lanesOff: true,
    });
    expect(results, JSON.stringify(results)).toMatchObject({
      gmail: "ok",
      drive: "lane_off",
      meeting: "lane_off",
      moment: "lane_off",
    });
  });

  it("on a capped day it spends nothing and says `budget`, never red", async () => {
    const day = today(8);
    const asked: string[] = [];
    const counted = modelFor(day);
    const results = await canaryRun(day, {
      deps: {
        model: {
          complete: (request) => {
            asked.push(request.promptId);
            return counted.complete(request);
          },
          embed: (request) => counted.embed(request),
        },
      },
      extract: (env) => ({ ...env, PI_EXTRACT_DAY_USD: "0.1" }),
    });
    expect(asked).toEqual([]);
    expect(results).toMatchObject({ gmail: "budget", drive: "budget", contact: "budget" });
  });

  it("reserves its names: no other client or device may take one", async () => {
    const add = (run: (admin: Admin) => Promise<unknown>) =>
      withAdmin(db, run).then(
        () => "made",
        (error: { code?: string }) => error.code,
      );
    expect(
      await add((admin) =>
        admin.clients.addClient({
          name: "canary-mine",
          runtime: "local",
          vendorRetention: "none",
          compartments: ["own"],
          views: ["self"],
          tools: ["get_self"],
        }),
      ),
    ).toBe("invalid_registration");
    expect(await add((admin) => admin.lens.addDevice("canary-mine", { compartments: ["own"], views: ["self"] }))).toBe(
      "invalid_registration",
    );
  });

  it("a stopped pipeline, a refused claim, a missing belief, a filtered read and a thin surface each name their hop", async () => {
    const stopped = today(1);
    expect(await canaryRun(stopped, { deps: { model: modelFor(stopped) }, pipeline: false })).toMatchObject({
      gmail: "stuck_pipeline",
      drive: "stuck_pipeline",
      meeting: "stuck_pipeline",
      moment: "stuck_pipeline",
    });

    const refused = today(2);
    expect(await canaryRun(refused, { deps: { model: modelFor(refused, { claims: "none" }) } })).toMatchObject({
      gmail: "no_claim",
      drive: "no_claim",
    });

    // The owner rejected the mail's claim: a claim and no belief computed under the probe's clearance.
    const unbelieved = today(3);
    const narrow = "update policy.clients set compartments = $1 where name = any ($2)";
    expect(
      await canaryRun(unbelieved, {
        deps: { model: modelFor(unbelieved) },
        beforeCheck: async () => {
          const [claim] = await rowsOf<{ id: string }>(
            `select c.id from knowledge.claims c join knowledge.messages m on m.evidence_id = c.evidence_id
             where c.type = 'role' and c.compartments = $1 order by c.created_at desc, c.id limit 1`,
            [[CANARY_COMPARTMENT]],
          );
          expect(claim).toBeDefined();
          const rejected = await pi(["correct", "reject", claim?.id ?? ""], environment.admin());
          expect({ exit: rejected.exit, stderr: rejected.stderr }).toEqual({ exit: 0, stderr: "" });
        },
      }),
    ).toMatchObject({ gmail: "no_belief" });

    // The probe's clearance narrowed for the read alone: the claim and belief stand, the read is empty.
    const filtered = today(4);
    expect(
      await canaryRun(filtered, {
        deps: { model: modelFor(filtered) },
        beforeCheck: () => rowsOf(narrow, [["public"], [CANARY_PROBE]]),
        afterCheck: () => rowsOf(narrow, [[...CANARY_CLEARANCE], [CANARY_PROBE]]),
      }),
    ).toMatchObject({ gmail: "not_read" });

    // A surface that dropped what a read found.
    const thin = today(5);
    expect(await canaryRun(thin, { deps: { model: modelFor(thin) }, thin: "get_entity" })).toMatchObject({
      gmail: "not_on_surface",
    });
  });

  it("one outage raises one card, whatever number of sources it reddens", async () => {
    const cards = await rowsOf<{ case_key: string }>(
      "select case_key from ledger.cards where kind = 'box_health' and case_key like 'box:failure_streak:canary%'",
    );
    expect(cards.map((one) => one.case_key)).toEqual(["box:failure_streak:canary"]);
  });

  it("the owner's retry preview reads past its item, which its other commands cannot open", async () => {
    const shown = await pi(
      [
        "extract",
        "retry",
        "--in-lane",
        "correspondence",
        "--status",
        "done",
        "--keep-answers",
        "--fact-kinds",
        "correspondence",
      ],
      environment.admin(),
    );
    expect(`${shown.stdout}${shown.stderr}`).not.toContain("open_failed");
    expect(shown.stdout).toContain('"selected"');
  });

  it("the owner's extraction reads leave out its item, which they cannot open", async () => {
    for (const argv of [
      ["extract", "status"],
      ["identity", "mentions"],
    ]) {
      const shown = await pi(argv, environment.admin());
      expect({ exit: shown.exit, stderr: shown.stderr }, argv.join(" ")).toEqual({ exit: 0, stderr: "" });
    }
  });

  it("the owner's add-address re-derives past its item, which its other commands cannot open", async () => {
    const added = await pi(
      ["owner", "add-address", world({ now: new Date() }).handles.oneMessageSenderAddress],
      environment.admin(),
    );
    expect({ exit: added.exit, stderr: added.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(JSON.parse(added.stdout)).toMatchObject({ rederived: true });
  });
});
