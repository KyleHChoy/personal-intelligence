import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  type EntityId,
  type EventId,
  type GoalId,
  type HarnessModeId,
  type IntentId,
  type MessageId,
  type OpportunityKind,
  PersonalLogEvent,
  type PersonalLogger,
  PersonalReadTool,
  PersonalRunTool,
  PersonalWorkTool,
  type RunId,
  type Stage,
  type TurnReply,
  type TurnRequest,
} from "@intelligence/contracts/personal";
import type { GmailMessage } from "@intelligence/personal-core/items";
import {
  FOLD_SETUP,
  fakeSources,
  fakeTurnModel,
  useDocumentationFold,
  type World,
  world,
} from "@intelligence/personal-core/testing";
import { REGISTRY } from "@intelligence/personal-ladder";
import { fakeKeyEndpoint } from "@intelligence/personal-models/testing";
import { runOnce, type TurnModel } from "@intelligence/personal-reasoner";
import {
  createDispatch,
  createWriter,
  isUnbuiltRead,
  journalPath,
  type Planner,
  type Writer,
} from "@intelligence/personal-store";
import {
  copyTestDatabase,
  createTestDatabase,
  fingerprint,
  queryAs,
  sealRow,
  type TestDatabase,
} from "@intelligence/personal-store/testing";
import { runSync } from "../intake/sync.ts";
import { runTick, type TickCounts } from "../work/tick.ts";
import { asBroad } from "./broad.ts";
import { MCP_AT_ONCE } from "./mcp-fixtures.ts";
import { pi as runPi } from "./run-pi.ts";

// Durable work's end-to-end harness: steps 1 to 4 of the sequence, and the pieces every gate test
// and the prompt check build on. A real Postgres with the production roles, the real `pi` process
// for every owner command, the real `pi mcp` behind a wrapper script for each client, and the
// reasoner's `runOnce` with a recorded model. Only sync runs in-process, because the fakes live in
// this process. Nothing here calls a live model or Google. It is test support: the gate tests,
// check-prompt.ts loads it, and nothing else does.

export const MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// The world is built 27 hours before the harness starts, so that of the world's events the one
// the owner organized and accepted that starts within the calendar's 24 hours is the weekly
// sync's second instance, three hours ahead: every other is in the past, cancelled, not the
// owner's, or more than a day ahead.
const WORLD_LAG = 27 * HOUR;
// The daily sweep is due from this UTC hour on. The harness moves it from 11 to 23, so a tick
// made at most hours of the day queues no sweep run beside the wake under test.
const SWEEP_HOUR = 23;

// sync_memory is the memory adapter's, and an agent harness registration leaves it out; a reasoner
// is never given it. The admin registers no client with a read tool that has nothing behind it yet
// (not_built).
export const READ_TOOLS: readonly string[] = PersonalReadTool.options.filter(
  (tool) => tool !== "sync_memory" && !isUnbuiltRead(tool),
);
export const WORK_TOOLS: readonly string[] = PersonalWorkTool.options;
const RUN_TOOLS: readonly string[] = PersonalRunTool.options;
export const RECORDED_MODEL = "recorded/model";
// The participant of the meeting the sequence uses (the world's weekly sync), and the owner's
// sent reply the run cites beside the event.
const PARTICIPANT = "s.orrin@kestrel.test";
export const TOP_CONTACT = "maren.holt@example.com";

export type Env = Record<string, string>;
export type Result = { exit: number | null; stdout: string; stderr: string };
export type Outcome = { ok: true; value: Record<string, unknown> } | { ok: false; code: string };
type Reply = {
  jsonrpc: "2.0";
  id: number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

// A request id of the RequestId form, made fresh for each write.
export const requestId = (): string => randomBytes(12).toString("base64url");

// One run of the real process, with an explicit environment: PATH and what the step needs, and
// what is given on its standard input.
export function pi(argv: string[], env: Env, stdin?: string): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", FOLD_SETUP, MAIN, ...argv], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.stdin.on("error", () => {});
    child.on("close", (exit) => resolve({ exit, stdout, stderr }));
    child.stdin.end(stdin ?? "");
  });
}

// What a tools/call reply says: the result's data, or the error's code.
function outcomeOf(reply: Reply): Outcome {
  if (reply.error !== undefined) return { ok: false, code: reply.error.message };
  const result = reply.result ?? {};
  if (result.isError === true) return { ok: false, code: (result.content as { text: string }[])[0]?.text ?? "" };
  return { ok: true, value: result.structuredContent as Record<string, unknown> };
}

// A client of the agent API: its wrapper started as a child, one message in on its stdin and one
// reply out on its stdout, as the core's end-to-end test drives its clients.
export type Session = {
  child: ChildProcessWithoutNullStreams;
  call(method: string, params?: unknown): Promise<Reply>;
  tool(name: string, args?: Record<string, unknown>): Promise<Outcome>;
  end(): Promise<{ exit: number | null; stderr: string }>;
};

export function startSession(wrapper: string): Session {
  const child = spawn(wrapper, [], { env: { PATH: "" }, stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  let buffer = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const next = waiting.shift();
      if (next === undefined) lines.push(line);
      else next(line);
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  child.stdin.on("error", () => {});
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  // A process that ends with a call unanswered fails that call rather than hanging it.
  void closed.then(() =>
    waiting.splice(0).forEach((next) => {
      next('{"error":{"code":0,"message":"the process ended"}}');
    }),
  );
  let id = 0;
  const call = async (method: string, params?: unknown): Promise<Reply> => {
    id += 1;
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`,
    );
    const line = lines.shift() ?? (await new Promise<string>((resolve) => waiting.push(resolve)));
    return JSON.parse(line) as Reply;
  };
  return {
    child,
    call,
    tool: async (name, args = {}) => outcomeOf(await call("tools/call", { name, arguments: args })),
    async end() {
      child.stdin.end();
      return { exit: await closed, stderr };
    },
  };
}

// The value of a successful tool call.
export function value(outcome: Outcome): Record<string, unknown> {
  if (!outcome.ok) throw new Error(`the call answered ${outcome.code}`);
  return outcome.value;
}

// A shell word: the text in single quotes, with each quote in it closed, escaped and reopened.
export const quoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

// A client's wrapper, as the box's pi-mcp is: the reader's URL, the key file and the token, and
// pi mcp, with nothing else in its environment, folding as the test does (FOLD_SETUP). Mode 700.
// With `atOnce`, the stand-in of mcp-fixtures.ts in place of pi mcp: the same agent API, with no
// reply deadline waits.
export async function writeWrapper(
  path: string,
  readerUrl: string,
  keyFile: string,
  token: string,
  atOnce = false,
): Promise<void> {
  const vars = [
    `PATH=${quoted(process.env.PATH ?? "")}`,
    `PI_DATABASE_URL_READER=${quoted(readerUrl)}`,
    `PI_KEY_FILE=${quoted(keyFile)}`,
    `PI_CLIENT_TOKEN=${quoted(token)}`,
  ];
  const command = atOnce ? quoted(MCP_AT_ONCE) : `${quoted(MAIN)} mcp`;
  await writeFile(
    path,
    `#!/bin/sh\nexec /usr/bin/env -i ${vars.join(" ")} ${quoted(process.execPath)} --import ${quoted(FOLD_SETUP)} ${command}\n`,
    { mode: 0o700 },
  );
  await chmod(path, 0o700);
}

// A recorded model: the answers written by hand, given in order. It is the core's fakeTurnModel,
// with a hook that runs before the answer of a given turn (the owner acting while a run is in
// flight). Past its last answer it throws, which the loop records as `model_unavailable`;
// `overasked` says so, and every test that uses one asserts it is false.
export type Recorded = TurnModel & { requests: TurnRequest[]; overasked(): boolean };
export function recorded(replies: readonly TurnReply[], hooks: Record<number, () => Promise<void>> = {}): Recorded {
  const inner = fakeTurnModel(replies);
  let turns = 0;
  return {
    requests: inner.requests,
    overasked: () => turns > replies.length,
    async turn(request) {
      const at = turns;
      turns += 1;
      await hooks[at]?.();
      return inner.turn(request);
    },
  };
}

// A reply that asks for tool calls, and one that answers with output. Each reports a cost.
export const COST = 50;
export const calls = (...toolCalls: { name: string; arguments?: unknown }[]): TurnReply => ({
  text: null,
  toolCalls: toolCalls.map((one, index) => ({ id: `call_${index}`, name: one.name, arguments: one.arguments ?? {} })),
  inputTokens: 100,
  outputTokens: 20,
  costMicroUsd: COST,
  modelId: RECORDED_MODEL,
});
export const answer = (output: unknown): TurnReply => ({
  text: typeof output === "string" ? output : JSON.stringify(output),
  toolCalls: [],
  inputTokens: 100,
  outputTokens: 20,
  costMicroUsd: COST,
  modelId: RECORDED_MODEL,
});
export const IGNORE = { actions: [{ do: "ignore", reason: "nothing_to_do" }] };

export type HarnessOptions = {
  // The worker client, its intent and its harness modes. The prompt check has none.
  worker?: boolean;
  // The intent's mode and kinds, and the worker's harness modes.
  mode?: "policy" | "owner";
  kinds?: OpportunityKind[];
  stages?: [OpportunityKind, Stage][];
  // How the run is queued: by the tick (the sequence's step 4), or by `pi work run`.
  queue?: "tick" | "request";
  // The planner a wake queues: `one_pass` unless asked, since the gates are about the work that
  // follows a run's proposals, which personal_run version 3 makes in one run.
  planner?: Planner;
  // The goal's statement, read by `pi goal add` from its standard input.
  statement?: string;
  // Called with the world's fakes before the first sync, to add what a test needs.
  prepare?: (world: World, sources: ReturnType<typeof fakeSources>) => void;
  // The clients' wrappers start mcp-fixtures.ts's stand-in for pi mcp, which waits no reply
  // deadline, for the tests that are not about the deadlines or the process. Unset, pi mcp.
  atOnce?: boolean;
};

export type Harness = {
  now: Date;
  worldNow: Date;
  w: World;
  sources: ReturnType<typeof fakeSources>;
  db: TestDatabase;
  folder: string;
  keyFile: string;
  journal: string;
  log: PersonalLogger;
  events: PersonalLogEvent[];
  env: { admin: Env; work: Env };
  tokens: Record<string, string>;
  wrappers: Record<string, string>;
  statement: string;
  atOnce: boolean;
  ids: {
    event: EventId;
    participant: EntityId;
    cited: MessageId;
    citedGmail: string;
    goal: GoalId;
    intent: IntentId | null;
    harnessModes: HarnessModeId[];
    // The run step 4 queued for the meeting, or the one `pi work run` queued.
    run: RunId;
  };
  // `pi` as the owner (pi_admin), with what it is given on stdin.
  owner(argv: string[], stdin?: string): Promise<Result>;
  // `pi` in this process, as the core tests call `inspect`: for the commands whose result goes
  // to a terminal only.
  terminal(argv: string[], stdin?: string): Promise<Result>;
  // `pi work tick`, the real process, with the work role's two variables.
  tickProcess(): Promise<Result>;
  // One tick in this process, at a time of the test's choosing.
  tick(at: Date): Promise<TickCounts | "already_running">;
  // A time `ms` after the harness started, an hour later still when that is in the sweep's hour.
  at(ms: number): Date;
  sync(): Promise<void>;
  rows<Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<Row[]>;
  // As pi_work, the tick's role.
  asWork<Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<Row[]>;
  messageOf(gmailId: string): Promise<MessageId>;
  entityOf(address: string, compartment?: string): Promise<EntityId>;
  // The world's personal messages, found by what a test knows of them.
  gmail(match: (message: GmailMessage) => boolean): GmailMessage;
  // One status row for a message's item, as extraction leaves it: screened and clean unless asked.
  screen(message: MessageId, status?: { withheld?: boolean; screened?: boolean }): Promise<void>;
  // Registers a client with `pi clients add` (asBroad) and writes its wrapper. Returns the token.
  register(name: string, args: string[]): Promise<string>;
  client(name: string): Promise<Session>;
  // One reasoner run: `runOnce` with the client's wrapper as the agent API and an environment of
  // these three variables and no other, the key a synthetic one; its spend-cap check reads a fake
  // key endpoint under the ceiling. The run it took, if it took one.
  reason(
    model: TurnModel,
    client?: string,
  ): Promise<{ exit: 0 | 1; run: RunId | null; env: Env; logged: PersonalLogEvent[] }>;
  // Every queued run, oldest first, taken with a recorded model that answers ignore.
  drain(): Promise<RunId[]>;
  // Ends its sessions and closes its writer, as a template for copyHarness must.
  release(): Promise<void>;
  cleanup(): Promise<void>;
};

// What a step answered, or a failure that says which step and what it printed. Plain errors:
// this file is loaded by the prompt check too, which is no test.
function expectExit(result: Result, exit: number, what: string): Result {
  if (result.exit !== exit) throw new Error(`${what}: exit ${result.exit}, stderr ${result.stderr}`);
  return result;
}

function memoryLogger(into: PersonalLogEvent[]): PersonalLogger {
  // An event that is not a PersonalLogEvent is kept as the logger would write it: replaced whole.
  const record = (one: PersonalLogEvent): void =>
    void into.push(PersonalLogEvent.safeParse(one).success ? one : { event: "log_field_refused" });
  return { info: record, warn: record, error: record };
}

const sink = (): Writable =>
  new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });

// What a harness stands on: its database, its folder (the key file, the erasure journal beside it
// and the clients' wrappers), the world's time, the clients' tokens and the sequence's ids. A copy
// of one (copyHarness) stands on a copy of each.
type State = {
  db: TestDatabase;
  folder: string;
  keyFile: string;
  worldNow: Date;
  atOnce: boolean;
  statement: string;
  tokens: Record<string, string>;
  wrappers: Record<string, string>;
  ids: Harness["ids"];
};

export async function workHarness(options: HarnessOptions = {}): Promise<Harness> {
  // The synthetic world names organizations under documentation domains: fold them apart here, as
  // in the processes it spawns, also when check-prompt.ts runs it outside a test.
  useDocumentationFold();
  const worker = options.worker ?? true;
  const kinds = options.kinds ?? ["meeting_prep"];
  const stages = options.stages ?? [["meeting_prep", "prepare"]];
  const statement = options.statement ?? "Keep the weekly sync with Sam prepared CANARY-GOAL-W9K2Q7";
  const now = new Date();
  const worldNow = new Date(now.getTime() - WORLD_LAG);
  const w = world({ now: worldNow });
  const sources = fakeSources(w);
  options.prepare?.(w, sources);

  const folder = await mkdtemp(join(tmpdir(), "pi-work-e2e-"));
  const keyFile = join(folder, "keys.json");
  let h: Harness | undefined;
  try {
    // 1. The key file, a migrated database, one sync of the world.
    expectExit(
      await pi(["keys", "init", "--compartments", "own,employer:example"], { PI_KEY_FILE: keyFile }),
      0,
      "keys init",
    );
    const made = await createTestDatabase({ keyFile });
    // The ids are filled in as the sequence makes them.
    const state: State = {
      db: made,
      folder,
      keyFile,
      worldNow,
      atOnce: options.atOnce ?? false,
      statement,
      tokens: {},
      wrappers: {},
      ids: {} as Harness["ids"],
    };
    h = harnessOf(state, now, w, sources);
    const urls = {
      PI_DATABASE_URL_BOOTSTRAP: made.urls.bootstrap,
      PI_DATABASE_URL_ADMIN: made.urls.admin,
      PI_DATABASE_URL_WRITER: made.urls.writer,
      PI_DATABASE_URL_READER: made.urls.reader,
      PI_DATABASE_URL_PIPELINE: made.urls.pipeline,
      PI_DATABASE_URL_WORK: made.urls.work,
      PI_DATABASE_URL_RESTRICTED: made.urls.restricted,
    };
    expectExit(await pi(["db", "migrate"], urls), 0, "db migrate");
    await h.sync();

    // The tick refuses while there is no erasure journal (journal_refused), and `erase replay`
    // makes the empty one.
    const refused = expectExit(await h.tickProcess(), 1, "work tick before erase replay");
    if (!refused.stderr.includes('"code":"journal_refused"'))
      throw new Error(`work tick before erase replay: ${refused.stderr}`);
    expectExit(await h.owner(["erase", "replay"]), 0, "erase replay");
    // No pi command sets the sweep's hour: the owner's settings row, as pi_admin.
    await h.rows("update policy.work_settings set sweep_hour_utc = $1, planner = $2", [
      SWEEP_HOUR,
      options.planner ?? "one_pass",
    ]);

    // 2. The reasoner, with the read tools and the three run tools; the worker, with the read
    // tools and the nine work tools.
    await h.register("reasoner", [
      "--kind",
      "reasoner",
      "--views",
      "self,people,work",
      "--tools",
      [...READ_TOOLS, ...RUN_TOOLS].join(","),
    ]);
    if (worker)
      await h.register("worker", ["--views", "self,people,work", "--tools", [...READ_TOOLS, ...WORK_TOOLS].join(",")]);

    // 3. A goal, from stdin; the intent; the harness modes.
    state.ids.goal = expectExit(
      await h.owner(["goal", "add", "--domain", "interests"], `${statement}\n`),
      0,
      "goal add",
    ).stdout.trim() as GoalId;
    state.ids.intent = null;
    state.ids.harnessModes = [];
    if (worker) {
      const added = expectExit(
        await h.owner([
          "intent",
          "add",
          "--kinds",
          kinds.join(","),
          "--clients",
          "worker",
          "--mode",
          options.mode ?? "policy",
        ]),
        0,
        "intent add",
      );
      state.ids.intent = (JSON.parse(added.stdout) as { intent: IntentId }).intent;
      for (const [kind, stage] of stages) {
        const granted = expectExit(
          await h.owner(["harness", "grant", "worker", "--kind", kind, "--stage", stage]),
          0,
          "harness grant",
        );
        state.ids.harnessModes.push((JSON.parse(granted.stdout) as { harness: HarnessModeId }).harness);
      }
    }

    // The world's ids the sequence uses: the meeting, its participant and the owner's reply.
    const header = (message: GmailMessage, name: string): string =>
      message.headers.find((one) => one.name === name)?.value ?? "";
    state.ids.citedGmail = h.gmail(
      (one) =>
        one.labelIds.includes("SENT") &&
        header(one, "Subject") === "Re: Trip dates" &&
        header(one, "To") === TOP_CONTACT,
    ).id;
    state.ids.cited = await h.messageOf(state.ids.citedGmail);
    // The status row for the message the run cites: extraction does not run here, and an unscreened
    // message is flagged.
    await h.screen(state.ids.cited);
    state.ids.participant = await h.entityOf(PARTICIPANT);
    const [meeting, ...others] = await h.rows<{ id: EventId }>(
      `select e.id from knowledge.events e join knowledge.event_details d on d.event_id = e.id
       where d.starts_at >= now() and d.starts_at < now() + interval '24 hours' and not d.cancelled and ledger.owner_backed('event', e.id)
       order by d.starts_at`,
    );
    if (meeting === undefined || others.length > 0)
      throw new Error("the world has not exactly one accepted meeting within a day");
    state.ids.event = meeting.id;

    // 4. One run, queued by the tick for the meeting, or by the owner's request.
    if ((options.queue ?? "tick") === "tick") {
      expectExit(await h.tickProcess(), 0, "work tick");
      const runs = await h.rows<{ id: RunId }>(
        "select r.id from ledger.runs r join ledger.basis b on b.row_kind = 'run' and b.row_id = r.id where r.wake_source = 'calendar' and b.ref_kind = 'event' and b.ref_id = $1",
        [meeting.id],
      );
      const [first] = runs;
      if (first === undefined || runs.length !== 1) throw new Error("the tick queued no run for the meeting");
      state.ids.run = first.id;
    } else {
      state.ids.run = (
        JSON.parse(expectExit(await h.owner(["work", "run"]), 0, "work run").stdout) as { run: RunId }
      ).run;
    }
    return h;
  } catch (error) {
    if (h !== undefined) await h.cleanup();
    else await rm(folder, { recursive: true, force: true });
    throw error;
  }
}

// A harness on a copy of another's database, key file and journal (copyTestDatabase), with
// wrappers of its own, from where its sequence ended: what a gate test changes in one, the other
// never sees. The template must hold no connection (its writer and sessions closed: `release`).
// Its `now` is the copy's own start, as a harness's is; the world's rows keep the template's time.
export async function copyHarness(template: Harness): Promise<Harness> {
  const db = await copyTestDatabase(template.db);
  try {
    const folder = dirname(db.keyFile);
    const wrappers: Record<string, string> = {};
    const atOnce = template.atOnce;
    for (const [name, token] of Object.entries(template.tokens)) {
      wrappers[name] = join(folder, `${name}-mcp`);
      await writeWrapper(wrappers[name], db.urls.reader, db.keyFile, token, atOnce);
    }
    const w = world({ now: template.worldNow });
    const state: State = {
      db,
      folder,
      keyFile: db.keyFile,
      worldNow: template.worldNow,
      atOnce,
      statement: template.statement,
      tokens: { ...template.tokens },
      wrappers,
      ids: structuredClone(template.ids),
    };
    return harnessOf(state, new Date(), w, fakeSources(w));
  } catch (error) {
    await db.drop();
    throw error;
  }
}

function harnessOf(state: State, now: Date, w: World, sources: ReturnType<typeof fakeSources>): Harness {
  const { db: made, folder, keyFile, worldNow, tokens, wrappers } = state;
  const journal = journalPath(keyFile);
  const events: PersonalLogEvent[] = [];
  const log = memoryLogger(events);
  const admin: Env = { PI_DATABASE_URL_ADMIN: made.urls.admin, PI_KEY_FILE: keyFile };
  const workEnv: Env = { PI_DATABASE_URL_WORK: made.urls.work, PI_ERASURE_JOURNAL: journal };
  let writer: Writer | undefined;
  const sessions: Session[] = [];
  const release = async (): Promise<void> => {
    for (const one of sessions.splice(0)) one.child.kill();
    await writer?.close();
    writer = undefined;
  };

  const sync = async (): Promise<void> => {
    writer ??= createWriter({ url: made.urls.writer, keys: made.keys, log });
    const synced = await runSync({ writer, sources, log, now: worldNow });
    if (!synced.outcomes.every((one) => one.outcome === "ok"))
      throw new Error(`sync: ${JSON.stringify(synced.outcomes)}`);
  };
  const rows = <Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<Row[]> =>
    queryAs<Row>(made.urls.admin, text, values);
  const asWork = <Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<Row[]> =>
    queryAs<Row>(made.urls.work, text, values);

  const register = async (name: string, args: string[]): Promise<string> => {
    const added = expectExit(await pi(["clients", "add", name, ...asBroad(args)], admin), 0, `clients add ${name}`);
    const token = added.stdout.trim();
    if (!/^pit_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error(`clients add ${name}: no token`);
    tokens[name] = token;
    // Its wrapper, in the harness's own directory.
    const wrapper = join(folder, `${name}-mcp`);
    await writeWrapper(wrapper, made.urls.reader, keyFile, token, state.atOnce);
    wrappers[name] = wrapper;
    return token;
  };

  const fp = (kind: "source_id" | "address", one: string): string => fingerprint(made.keys, kind, one);
  const messageOf = async (gmailId: string): Promise<MessageId> => {
    const [found] = await rows<{ id: MessageId }>(
      "select m.id from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where e.source_item_fp = $1",
      [fp("source_id", `gmail-id:${gmailId}`)],
    );
    if (found === undefined) throw new Error(`no message for ${gmailId}`);
    return found.id;
  };
  const entityOf = async (address: string, compartment = "own"): Promise<EntityId> => {
    const [found] = await rows<{ entity_id: EntityId }>(
      "select entity_id from knowledge.accounts where value_fp = $1 and compartments = $2::text[]",
      [fp("address", address), [compartment]],
    );
    if (found === undefined) throw new Error("no entity for the address");
    return found.entity_id;
  };
  const [personal] = w.accounts;
  if (personal === undefined) throw new Error("the world has no account");
  const gmail = (match: (message: GmailMessage) => boolean): GmailMessage => {
    const found = personal.messages.find(match);
    if (found === undefined) throw new Error("no such message in the world");
    return found;
  };
  const screen = async (message: MessageId, status: { withheld?: boolean; screened?: boolean } = {}): Promise<void> => {
    const [item] = await rows<{ evidence: string; compartments: string[] }>(
      "select m.evidence_id as evidence, e.compartments from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where m.id = $1",
      [message],
    );
    if (item === undefined) throw new Error("no such message");
    const facts = {
      lane: "correspondence",
      override: false,
      status: "done",
      attempts: 0,
      claims: 0,
      unmapped: 0,
      unresolved: 0,
    };
    const sealed = sealRow(
      made.keys,
      item.compartments[0] ?? "own",
      { table: "vault.pipeline_items", id: item.evidence, column: "facts_enc" },
      JSON.stringify(facts),
    );
    await rows(
      `insert into vault.pipeline_items (evidence_id, waiting, withheld, screened, extractor_generation, compartments, facts_enc)
       values ($1, false, $2, $3, 1, $4, $5)
       on conflict (evidence_id) do update set waiting = false, withheld = excluded.withheld, screened = excluded.screened`,
      [item.evidence, status.withheld ?? false, status.screened ?? true, item.compartments, JSON.stringify(sealed)],
    );
  };

  const at = (ms: number): Date => {
    const moved = new Date(now.getTime() + ms);
    return moved.getUTCHours() >= SWEEP_HOUR ? new Date(moved.getTime() + HOUR) : moved;
  };

  const terminal = (argv: string[], stdin?: string): Promise<Result> =>
    runPi(argv, admin, { tty: true, stdin: stdin === undefined ? [] : [Buffer.from(stdin, "utf8")] });

  const reason = async (
    model: TurnModel,
    client = "reasoner",
  ): Promise<{ exit: 0 | 1; run: RunId | null; env: Env; logged: PersonalLogEvent[] }> => {
    const wrapper = wrappers[client];
    if (wrapper === undefined) throw new Error(`no client ${client}`);
    const env: Env = {
      PI_AGENT_API_COMMAND: wrapper,
      PI_REASONER_MODEL: RECORDED_MODEL,
      PI_REASONER_MODEL_KEY: "sk-synthetic-reasoner-key",
    };
    const before = await rows<{ taken: string }>("select count(*)::text as taken from ledger.run_attempts");
    const logged: PersonalLogEvent[] = [];
    const exit = await runOnce(env, {
      model,
      log: memoryLogger(logged),
      stderr: sink(),
      keyFetch: fakeKeyEndpoint().fetch,
    });
    const taken = await rows<{ run_id: RunId }>(
      "select run_id from ledger.run_attempts order by taken_at desc, run_id desc limit 1",
    );
    const after = await rows<{ taken: string }>("select count(*)::text as taken from ledger.run_attempts");
    return { exit, run: after[0]?.taken === before[0]?.taken ? null : (taken[0]?.run_id ?? null), env, logged };
  };

  return {
    now,
    worldNow,
    w,
    sources,
    db: made,
    folder,
    keyFile,
    journal,
    log,
    events,
    env: { admin, work: workEnv },
    tokens,
    wrappers,
    statement: state.statement,
    atOnce: state.atOnce,
    ids: state.ids,
    owner: (argv, stdin) => pi(argv, admin, stdin),
    terminal,
    tickProcess: () => pi(["work", "tick"], workEnv),
    async tick(when) {
      const dispatch = createDispatch({ url: made.urls.work, log, journal });
      try {
        return await runTick({ dispatch, registry: REGISTRY, log, now: () => when });
      } finally {
        await dispatch.close();
      }
    },
    at,
    sync,
    rows,
    asWork,
    messageOf,
    entityOf,
    gmail,
    screen,
    register,
    async client(name) {
      const wrapper = wrappers[name];
      if (wrapper === undefined) throw new Error(`no client ${name}`);
      const one = startSession(wrapper);
      sessions.push(one);
      const started = await one.call("initialize", { protocolVersion: "2025-06-18" });
      if (started.result === undefined) throw new Error(`initialize: ${JSON.stringify(started.error)}`);
      return one;
    },
    reason,
    async drain() {
      const taken: RunId[] = [];
      for (;;) {
        const [next] = await rows(
          "select 1 from ledger.runs r where (select e.event from ledger.record_events e where e.row_kind = 'run' and e.row_id = r.id order by e.id desc limit 1) = 'queued'",
        );
        if (next === undefined) return taken;
        const result = await reason(recorded([answer(IGNORE)]));
        if (result.exit !== 0 || result.run === null) throw new Error(`a drained run ended ${result.exit}`);
        taken.push(result.run);
      }
    },
    release,
    async cleanup() {
      await release();
      await made.drop();
      await rm(folder, { recursive: true, force: true });
    },
  };
}

// The answers of step 5: get_self, then get_timeline for the meeting's participant, then one
// proposal about the meeting citing the event and the owner's sent reply.
export function sequenceReplies(
  h: Harness,
  options: { kind?: OpportunityKind; summary?: string; more?: unknown[] } = {},
): TurnReply[] {
  const proposal = {
    do: "propose",
    kind: options.kind ?? "meeting_prep",
    about: { kind: "event", id: h.ids.event },
    summary: options.summary ?? "Prepare notes for the weekly sync CANARY-SUMMARY-R5T8N2",
    basis: [
      { kind: "event", id: h.ids.event },
      { kind: "message", id: h.ids.cited },
    ],
  };
  return [
    calls({ name: "get_self" }),
    calls({ name: "get_timeline", arguments: { id: h.ids.participant } }),
    answer({ actions: [proposal, ...(options.more ?? [])] }),
  ];
}

// Step 5 on its own: any older queued run (today's sweep, when the clock is in its hour) taken
// first with an ignore, then the meeting's run with these answers, then every other queued run
// (the goal's own wake) with an ignore. Returns the meeting's run and the opportunity it proposed.
export async function runMeeting(
  h: Harness,
  model: Recorded,
): Promise<{ exit: 0 | 1; run: RunId; logged: PersonalLogEvent[]; env: Env }> {
  await takeOlder(h);
  const result = await h.reason(model);
  if (result.run !== h.ids.run) throw new Error(`the run taken was ${result.run}, not the meeting's`);
  await h.drain();
  return { exit: result.exit, run: h.ids.run, logged: result.logged, env: result.env };
}

// Every run queued before the meeting's (today's sweep, when the clock is in its hour), taken
// with an ignore, so the next run taken is the meeting's. "Before" is ledger.next_run's order:
// the runs one tick queues share its time, so their ids order them.
export async function takeOlder(h: Harness): Promise<void> {
  const older = await h.rows(
    'select r.id from ledger.runs r, ledger.runs m where m.id = $1 and (r.created_at < m.created_at or (r.created_at = m.created_at and r.id collate "C" < m.id collate "C"))',
    [h.ids.run],
  );
  for (let n = 0; n < older.length; n += 1) {
    const result = await h.reason(recorded([answer(IGNORE)]));
    if (result.run === h.ids.run) throw new Error("the meeting's run was taken before the older ones");
  }
}

// One run the owner asks for with `pi work run`, taken at once with the recorded model. Every
// run queued before it must have been taken already.
export async function requested(
  h: Harness,
  model: TurnModel,
  client = "reasoner",
): Promise<{ exit: 0 | 1; run: RunId; logged: PersonalLogEvent[] }> {
  const asked = expectExit(await h.owner(["work", "run"]), 0, "work run");
  const queued = (JSON.parse(asked.stdout) as { run: RunId }).run;
  const result = await h.reason(model, client);
  if (result.run !== queued) throw new Error(`the run taken was ${result.run}, not the one asked for`);
  return { exit: result.exit, run: queued, logged: result.logged };
}

// The opportunities a run proposed, in the order they were made.
export async function proposedBy(h: Harness, run: RunId): Promise<string[]> {
  return (
    await h.rows<{ id: string }>("select id from ledger.opportunities where run_id = $1 order by created_at, id", [run])
  ).map((row) => row.id);
}

// The opportunity a run proposed about one ref, of one kind when the run proposed two about it:
// the rows of one finish_run share their time, so their order is not the actions' order.
export async function proposedAbout(h: Harness, run: RunId, about: string, kind?: string): Promise<string> {
  const found = await h.rows<{ id: string }>(
    "select id from ledger.opportunities where run_id = $1 and about_id = $2 and ($3::text is null or kind = $3)",
    [run, about, kind ?? null],
  );
  const [one] = found;
  if (one === undefined || found.length !== 1)
    throw new Error("the run proposed not exactly one opportunity about the ref");
  return one.id;
}

// An opportunity's latest status event (a move report's own event is no status).
export async function latest(
  h: Harness,
  rowKind: string,
  id: string,
): Promise<{ event: string; code: string | null; by: string } | null> {
  const [row] = await h.rows<{ event: string; code: string | null; by: string }>(
    "select event, code, by from ledger.record_events where row_kind = $1 and row_id = $2 and event <> 'reported' order by id desc limit 1",
    [rowKind, id],
  );
  return row ?? null;
}

// Steps 5 and 6: the run proposes, and the tick decides it go at rung 0. Returns the opportunity
// and the run that proposed it; untilClaim adds step 7's list and claim, and the worker's session.
export async function untilGo(
  h: Harness,
  options: { kind?: OpportunityKind } = {},
): Promise<{ opportunity: string; run: RunId }> {
  const model = recorded(sequenceReplies(h, options));
  const ran = await runMeeting(h, model);
  if (ran.exit !== 0 || model.overasked()) throw new Error("step 5 did not finish");
  const [opportunity] = await proposedBy(h, ran.run);
  if (opportunity === undefined) throw new Error("step 5 proposed nothing");
  expectExit(await h.tickProcess(), 0, "work tick");
  if ((await latest(h, "opportunity", opportunity))?.event !== "go") throw new Error("step 6 decided no go");
  return { opportunity, run: ran.run };
}

export async function untilClaim(
  h: Harness,
  options: { kind?: OpportunityKind } = {},
): Promise<{ opportunity: string; run: RunId; worker: Session }> {
  const { opportunity, run } = await untilGo(h, options);
  const worker = await h.client("worker");
  const listed = value(await worker.tool("list_opportunities")) as { opportunities: { id: string }[] };
  if (!listed.opportunities.some((one) => one.id === opportunity)) throw new Error("the worker lists no opportunity");
  value(await worker.tool("claim_opportunity", { id: opportunity, requestId: requestId() }));
  return { opportunity, run, worker };
}

export const MINUTE = 60_000;
export { DAY, HOUR };
