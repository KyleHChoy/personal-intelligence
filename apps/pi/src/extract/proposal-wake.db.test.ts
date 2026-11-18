import type { PersonalLogEvent, PersonalTool, PersonalView } from "@intelligence/contracts/personal";
import { fakeKeyEndpoint, fakeModelClient } from "@intelligence/personal-models/testing";
import {
  type Admin,
  addCompartmentKey,
  createAdmin,
  createPipeline,
  createReader,
  createWriter,
  type Keys,
  listenAgentWrites,
  loadKeys,
  type Reader,
} from "@intelligence/personal-store";
import { queryAs } from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { events, pi, quiet, type Synced, syncedWorld } from "../test-support/extract-fixtures.ts";
import { wakeLoop } from "./wake.ts";

// On a synced world: an agent's proposal notifies the pipeline's listener when its write commits,
// and a wake (the writer's `pi sync --records`, then `pi extract --agent-records`, as
// lib/wake-run starts them) turns it into a claim and an about_you card, with no timer run. A
// note notifies nothing. The notify trigger's function is executed by no role, and the reader
// gains nothing.

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const TOOLS: PersonalTool[] = ["get_self", "record", "propose_about_you"];
const VIEWS: PersonalView[] = ["self", "people", "work"];
const RUNTIME_ROLES = ["pi_admin", "pi_writer", "pi_reader", "pi_pipeline", "pi_work", "pi_proxy", "pi_restricted"];

let s: Synced;
let keys: Keys;
let admin: Admin;
let reader: Reader;
let token = "";
let requests = 0;

const rows = <Row>(text: string, values: unknown[] = []): Promise<Row[]> => queryAs<Row>(s.db.urls.admin, text, values);
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (test: () => boolean, ms = 30_000): Promise<void> => {
  for (const end = Date.now() + ms; !test(); await pause(20)) if (Date.now() > end) throw new Error("timed out");
};
const requestId = (): string => `proposal-wake-${String((requests += 1)).padStart(6, "0")}`;
const propose = async (objective: string): Promise<void> => {
  const made = await reader.proposeAboutYou(token, {
    kind: "goal",
    fields: { domain: "health", objective },
    scope: "all",
    requestId: requestId(),
  } as never);
  if (!made.ok) throw new Error(`propose_about_you answered ${made.code}`);
};

beforeAll(async () => {
  s = await syncedWorld({ labels: ["personal"] });
  await addCompartmentKey(s.admin.PI_KEY_FILE ?? "", "agent:hawk");
  keys = await loadKeys(s.admin.PI_KEY_FILE ?? "");
  admin = createAdmin({ url: s.db.urls.admin, keys, log: quiet, recordEnabled: true });
  reader = createReader({ url: s.db.urls.reader, keys, log: quiet });
  token = (
    await admin.clients.addClient({
      name: "hawk",
      runtime: "local",
      vendorRetention: "none",
      compartments: ["own"],
      views: VIEWS,
      tools: TOOLS,
    })
  ).token;
});

afterAll(async () => {
  await reader?.close();
  await admin?.close();
  await s?.drop();
});

describe("the proposal wake", () => {
  it("a proposal notifies the channel once, on commit; a note notifies nothing", async () => {
    let notices = 0;
    const listener = await listenAgentWrites(s.db.urls.pipeline, quiet, {
      onNotice: () => void (notices += 1),
      onLost: () => {},
    });
    try {
      expect((await reader.record(token, { kind: "note", body: "a note to self", requestId: requestId() })).ok).toBe(
        true,
      );
      await pause(300);
      expect(notices).toBe(0);
      await propose("swim in the lake");
      await until(() => notices > 0);
      await pause(300);
      expect(notices).toBe(1);
    } finally {
      await listener.close();
    }
  });

  it("a wake turns a proposal into a claim and its about_you card, with no timer run; the listener's line carries counts and a code", async () => {
    const lines: PersonalLogEvent[] = [];
    const runs: { intakeMs: number; extractMs: number; extract: Record<string, unknown> | undefined }[] = [];
    const writer = { PI_DATABASE_URL_WRITER: s.db.urls.writer, PI_KEY_FILE: s.db.keyFile };
    const controller = new AbortController();
    const ended = wakeLoop({
      listen: (handlers) => listenAgentWrites(s.db.urls.pipeline, quiet, handlers),
      // What lib/wake-run starts, in process: the intake, then the run of agent records alone.
      run: async () => {
        const started = Date.now();
        const taken = await pi(["sync", "--records"], writer);
        const between = Date.now();
        const ran = await pi(["extract", "--agent-records"], s.pipeline, { deps: { model: fakeModelClient({}, []) } });
        runs.push({
          intakeMs: between - started,
          extractMs: Date.now() - between,
          extract: events(ran.stderr).find((one) => one.event === "extract_run"),
        });
        if (ran.stdout === "busy\n" || taken.stdout === "busy\n") return 75;
        return ran.exit !== 0 ? ran.exit : taken.exit !== 0 ? 4 : 0;
      },
      log: { info: (line) => void lines.push(line), warn: () => {}, error: () => {} },
      now: Date.now,
      debounceMs: 100,
      retryMs: 1_000,
      renewMs: 600_000,
      signal: controller.signal,
    });
    const messageRows = async (): Promise<number> =>
      (
        await rows<{ n: number }>(
          "select count(*)::int as n from vault.pipeline_items p join knowledge.messages m on m.evidence_id = p.evidence_id",
        )
      )[0]?.n ?? -1;
    const messagesBefore = await messageRows();
    // The start's wake takes the first test's proposal.
    await until(() => lines.length === 1);
    const before = await rows<{ n: number }>("select count(*)::int as n from ledger.cards where kind = 'about_you'");

    const written = Date.now();
    await propose("cycle to work");
    await until(() => lines.length === 2);
    const latencyMs = Date.now() - written;
    controller.abort();
    expect(await ended).toBe("stopped");

    // The record is taken in and built, and its card raised.
    const [record] = await rows<{ evidence_id: string | null }>(
      "select evidence_id from ledger.agent_writes where request_id = $1",
      [`proposal-wake-${String(requests).padStart(6, "0")}`],
    );
    expect(record?.evidence_id).not.toBeNull();
    const claims = await rows<{ id: string; type: string }>(
      "select id, type from knowledge.claims where evidence_id = $1",
      [record?.evidence_id],
    );
    expect(claims.map((one) => one.type)).toEqual(["goal"]);
    const cards = await rows<{ target_id: string }>(
      "select target_id from ledger.cards where kind = 'about_you' and target_kind = 'claim' and target_id = $1",
      [claims[0]?.id],
    );
    expect(cards).toHaveLength(1);
    expect(
      (await rows<{ n: number }>("select count(*)::int as n from ledger.cards where kind = 'about_you'"))[0]?.n,
    ).toBe((before[0]?.n ?? 0) + 1);
    // No mail was taken: no message has a status row it did not have.
    expect(await messageRows()).toBe(messagesBefore);

    // One line for each wake, with its code, its notices and its time, and nothing else.
    expect(lines.map((line) => [line.event, line.code, line.counts?.notices])).toEqual([
      ["extract_wake", "ok", 0],
      ["extract_wake", "ok", 1],
    ]);
    expect(
      lines.every((line) => Object.keys(line).every((key) => ["event", "code", "counts", "durationMs"].includes(key))),
    ).toBe(true);
    // The run's own line: one item done, and the rebuild's counts.
    expect(runs[1]?.extract).toMatchObject({ code: "ok", counts: { done: 1 } });
    // The write-to-card latency, measured (the test's wait for a burst is 100 ms; the box's 2 s).
    process.stderr.write(
      `proposal wake: write to card ${latencyMs} ms; intake ${runs[1]?.intakeMs} ms, run ${runs[1]?.extractMs} ms (rebuild ${String((runs[1]?.extract?.counts as Record<string, number> | undefined)?.rebuild_ms)} ms)\n`,
    );
  });

  it("with the sync lock held the intake takes nothing and says busy; with the extract lock held the run says busy before it reads the spend cap", async () => {
    await propose("row every morning");
    const writerEnv = { PI_DATABASE_URL_WRITER: s.db.urls.writer, PI_KEY_FILE: s.db.keyFile };
    const untaken = async (): Promise<number> =>
      (
        await rows<{ n: number }>(
          "select count(*)::int as n from ledger.agent_writes where evidence_id is null and body_enc is not null and refused_code is null",
        )
      )[0]?.n ?? -1;
    expect(await untaken()).toBe(1);
    const writer = createWriter({ url: s.db.urls.writer, keys, log: quiet });
    try {
      const held = await writer.withSyncLock(() => pi(["sync", "--records"], writerEnv));
      if (held === "already_running") throw new Error("the sync lock was held");
      expect({ exit: held.exit, stdout: held.stdout }).toEqual({ exit: 0, stdout: "busy\n" });
    } finally {
      await writer.close();
    }
    expect(await untaken()).toBe(1);
    const taken = await pi(["sync", "--records"], writerEnv);
    expect({ exit: taken.exit, stdout: taken.stdout }).toEqual({ exit: 0, stdout: "" });
    expect(await untaken()).toBe(0);

    const pipeline = createPipeline({ url: s.db.urls.pipeline, keys, log: quiet });
    let keyReads = 0;
    const endpoint = fakeKeyEndpoint().fetch;
    const keyFetch: typeof fetch = (input, init) => {
      keyReads += 1;
      return endpoint(input, init);
    };
    try {
      const held = await pipeline.withExtractLock(() =>
        pi(["extract", "--agent-records"], s.pipeline, { deps: { model: fakeModelClient({}, []), keyFetch } }),
      );
      if (held === "already_running") throw new Error("the extract lock was held");
      expect({ exit: held.exit, stdout: held.stdout, keyReads }).toEqual({ exit: 0, stdout: "busy\n", keyReads: 0 });
    } finally {
      await pipeline.close();
    }
  });

  it("the notify function is executed by no role, the trigger fires for proposals, answers, closes, fills and handoffs alone, and the reader holds no grant beyond its own", async () => {
    const [fn] = await rows<{ definer: boolean; owner: string; config: string[] }>(
      "select p.prosecdef as definer, pg_get_userbyid(p.proowner)::text as owner, p.proconfig::text[] as config from pg_proc p where p.oid = 'ledger.notify_agent_write()'::regprocedure",
    );
    expect(fn).toEqual({ definer: false, owner: "pi_owner", config: ["search_path=pg_catalog, pg_temp"] });
    for (const role of RUNTIME_ROLES) {
      const [can] = await rows<{ can: boolean }>(
        "select has_function_privilege($1, 'ledger.notify_agent_write()', 'EXECUTE') as can",
        [role],
      );
      expect([role, can?.can]).toEqual([role, false]);
    }
    // The wake's own trigger: the table's others (the owner request, the labels in use) are each
    // pinned by their own tests. It wakes for a research fill too, as for a proposal, an answer and
    // a close, and for a handoff record, so hand_off's record is taken in within seconds.
    const triggers = await rows<{ name: string; definition: string }>(
      "select tgname::text as name, pg_get_triggerdef(oid) as definition from pg_trigger where tgrelid = 'ledger.agent_writes'::regclass and not tgisinternal and tgname = 'agent_writes_notify' order by 1",
    );
    expect(triggers).toEqual([
      {
        name: "agent_writes_notify",
        definition:
          "CREATE TRIGGER agent_writes_notify AFTER INSERT ON ledger.agent_writes FOR EACH ROW WHEN ((new.kind = ANY (ARRAY['proposal'::text, 'answer'::text, 'close'::text, 'fill'::text, 'handoff'::text]))) EXECUTE FUNCTION ledger.notify_agent_write()",
      },
    ]);
    const columns = await rows<{ privilege: string; column: string }>(
      "select privilege_type as privilege, column_name as column from information_schema.column_privileges where grantee = 'pi_reader' and table_schema = 'ledger' and table_name = 'agent_writes' order by 1, 2",
    );
    expect(columns.every((one) => one.privilege === "SELECT")).toBe(true);
    const [table] = await rows<{ insert: boolean; update: boolean; delete: boolean }>(
      "select has_table_privilege('pi_reader', 'ledger.agent_writes', 'INSERT') as insert, has_table_privilege('pi_reader', 'ledger.agent_writes', 'UPDATE') as update, has_table_privilege('pi_reader', 'ledger.agent_writes', 'DELETE') as delete",
    );
    expect(table).toEqual({ insert: false, update: false, delete: false });
  });
});
