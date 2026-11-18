import { ContextPack, LEARNING_SAY, LEARNINGS_PER_DAY } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { setClientRoles } from "../admin/admin-tasks.ts";
import { request } from "../test-support/clients.ts";
import { session } from "../test-support/connections.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { TASK_AGENT_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { withWorkAdmin as withAdmin } from "../test-support/work-seeds.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";

// Agent learnings: an agent files what it learned about working here, every agent of the same scope
// is served it at the start of its next run as untrusted words, an agent not cleared for its label
// is served exactly what it would be without it, and the owner's veto takes it out. Synthetic rows
// only.
//
// Do not weaken, skip or delete this test to make a change pass.

const LABELS = ["own", "agent:scout"];
const TOOLS = [...TASK_AGENT_TOOLS, "build_context_pack", "file_learning"];

type Learning = {
  id: string;
  asOf: string;
  section: string;
  scope: string;
  statement: { untrusted: string } | null;
  rule: { untrusted: string } | null;
};

async function bootstrap(w: WorkWorld, client: WorkClient): Promise<ContextPack> {
  return ContextPack.parse(ok(await w.reader.buildContextPack(client.token, { purpose: "agent_bootstrap" })));
}

async function learningsOf(w: WorkWorld, client: WorkClient): Promise<Learning[]> {
  return (await bootstrap(w, client)).items.flatMap((item) =>
    item.kind === "learning" ? [item as unknown as Learning] : [],
  );
}

const ids = async (w: WorkWorld, client: WorkClient): Promise<string[]> =>
  (await learningsOf(w, client)).map((item) => item.id);

type Filed = { learning: string; merged?: true; vetoed?: true };

const fileRaw = (
  w: WorkWorld,
  by: WorkClient,
  statement: string,
  options: { scope?: string; supersedes?: string; requestId?: string } = {},
) =>
  w.work.fileLearning(by.token, {
    statement,
    rule: `So: ${statement.toLowerCase()}.`,
    evidence: `Called a tool with example.org arguments; it answered as stated: ${statement}`,
    scope: options.scope ?? "general",
    requestId: options.requestId ?? request(),
    ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
  } as never);

const file = async (...args: Parameters<typeof fileRaw>): Promise<Filed> =>
  ok(await fileRaw(...args)) as unknown as Filed;

// Every item but its times, at whatever depth: the pack's time moves between two builds.
const timeless = (pack: ContextPack): unknown =>
  JSON.parse(JSON.stringify(pack.items, (key, value) => (key === "asOf" ? undefined : value)));

describe("agent learnings", { timeout: DB_TEST_TIMEOUT }, () => {
  it("an agent files a learning and the next agent of its scope is served it at run start, untrusted; another role is not, and a general one reaches every agent", () =>
    withWorkWorld(async (w) => {
      const filer = await w.client("filer", ["own"], { tools: TOOLS });
      const peer = await w.client("peer", ["own"], { tools: TOOLS });
      const other = await w.client("other", ["own"], { tools: TOOLS });
      await setClientRoles(w.admin, "filer", ["scout"], new Date());
      await setClientRoles(w.admin, "peer", ["scout"], new Date());
      await setClientRoles(w.admin, "other", ["planner"], new Date());
      expect(await ids(w, peer)).toEqual([]);

      const first = await file(w, filer, "Find messages needs the whole name of Jo Example", { scope: "scout" });
      expect(first.learning).toMatch(/^lrn_/);
      expect(first.merged).toBeUndefined();

      const pack = await bootstrap(w, peer);
      expect(pack.template).toBe("agent_bootstrap@16");
      const served = await learningsOf(w, peer);
      expect(served.map((item) => item.id)).toEqual([first.learning]);
      expect(served[0]).toMatchObject({
        section: "learnings",
        required: false,
        provenance: "agent_reported",
        kind: "learning",
        scope: "scout",
        statement: { untrusted: "Find messages needs the whole name of Jo Example" },
        rule: { untrusted: "So: find messages needs the whole name of jo example." },
        say: LEARNING_SAY,
      });
      // Never the evidence, never the filer.
      expect(JSON.stringify(served)).not.toContain("example.org");
      expect(JSON.stringify(served)).not.toContain("filer");
      // After the guide, as the template has it.
      const sections = pack.items.map((item) => item.section);
      expect(sections.indexOf("learnings")).toBeGreaterThan(sections.indexOf("guide"));

      // Another role is not served a scout's learning; a general one reaches every agent.
      expect(await ids(w, other)).toEqual([]);
      const general = await file(w, other, "The timeline answers at most fifty rows");
      expect(await ids(w, other)).toEqual([general.learning]);
      expect((await ids(w, peer)).sort()).toEqual([first.learning, general.learning].sort());

      // A client without the tool is not asked, and its pack is served.
      const reader = await w.client("reader", ["own"], { tools: [...TASK_AGENT_TOOLS, "build_context_pack"] });
      expect(await ids(w, reader)).toEqual([]);
      // A client without the work view is left the section.
      const selfOnly = await w.client("self-only", ["own"], { tools: TOOLS, views: ["self", "people"] });
      const narrow = await bootstrap(w, selfOnly);
      expect(narrow.items.filter((item) => item.kind === "learning")).toEqual([]);
      expect(narrow.withheld).toContain("learnings");
    }, LABELS));

  it("a scope the caller does not hold is refused, a repeat answers the first, the same words merge, a supersedes it cannot use is not_found, and the eleventh in a day is rate_limited", () =>
    withWorkWorld(async (w) => {
      const filer = await w.client("filer", ["own"], { tools: TOOLS });
      await setClientRoles(w.admin, "filer", ["scout"], new Date());
      const count = async () =>
        Number((await w.admin<{ n: string }>("select count(*) as n from ledger.agent_learnings"))[0]?.n);

      expect(await fileRaw(w, filer, "Search wants quotes", { scope: "planner" })).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
      expect(await count()).toBe(0);

      const requestId = request();
      const first = await file(w, filer, "Search wants quotes", { scope: "scout", requestId });
      expect(await file(w, filer, "Search wants quotes", { scope: "scout", requestId })).toEqual(first);
      expect(await file(w, filer, "Search wants quotes", { scope: "scout" })).toEqual({
        learning: first.learning,
        merged: true,
      });
      expect(await count()).toBe(1);

      // A supersedes of another scope, or naming nothing, is not_found alike.
      const general = await file(w, filer, "Reads are slow at noon");
      expect(
        await fileRaw(w, filer, "Reads are slow at one", { scope: "scout", supersedes: general.learning }),
      ).toMatchObject({ ok: false, code: "not_found" });
      expect(
        await fileRaw(w, filer, "Reads are slow at one", { supersedes: "lrn_01J00000000000000000000000" }),
      ).toMatchObject({ ok: false, code: "not_found" });
      expect(await count()).toBe(2);

      // The bound: LEARNINGS_PER_DAY written in 24 hours, a merge and a repeat counting nothing.
      for (let n = 3; n <= LEARNINGS_PER_DAY; n++) await file(w, filer, `Tool ${n} pages by cursor`);
      expect(await count()).toBe(LEARNINGS_PER_DAY);
      expect(await file(w, filer, "Search wants quotes", { scope: "scout" })).toMatchObject({ merged: true });
      expect(await fileRaw(w, filer, "One too many")).toMatchObject({ ok: false, code: "rate_limited" });
      expect(await count()).toBe(LEARNINGS_PER_DAY);
      // A day later the bound is free again.
      await session(w.db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        await query("update ledger.agent_learnings set created_at = created_at - interval '25 hours'");
      });
      await file(w, filer, "One too many");
      expect(await count()).toBe(LEARNINGS_PER_DAY + 1);
    }, LABELS));

  it("an agent supersedes only a learning it filed; another agent's answers not_found, as a missing id does, and stays served to every agent", () =>
    withWorkWorld(async (w) => {
      const author = await w.client("author", ["own"], { tools: TOOLS });
      const rival = await w.client("rival", ["own"], { tools: TOOLS });
      const third = await w.client("third", ["own"], { tools: TOOLS });
      const original = await file(w, author, "Find facts wants the entity id");
      const count = async () =>
        Number((await w.admin<{ n: string }>("select count(*) as n from ledger.agent_learnings"))[0]?.n);

      // The rival sees the author's learning in its pack, and still cannot supersede it: the answer
      // is the one a missing id gets, word for word.
      expect(await ids(w, rival)).toEqual([original.learning]);
      const refused = await fileRaw(w, rival, "Find facts takes a name too", { supersedes: original.learning });
      const missing = await fileRaw(w, rival, "Find facts takes a name too", {
        supersedes: "lrn_01J00000000000000000000000",
      });
      expect(refused).toMatchObject({ ok: false, code: "not_found" });
      expect(refused).toEqual(missing);
      expect(await count()).toBe(1);
      for (const reader of [author, rival, third]) expect(await ids(w, reader)).toEqual([original.learning]);

      // The author supersedes its own, and every agent is served the newer in its place.
      const newer = await file(w, author, "Find facts takes the entity id or a name", {
        supersedes: original.learning,
      });
      for (const reader of [author, rival, third]) expect(await ids(w, reader)).toEqual([newer.learning]);
    }, LABELS));

  it("a learning that supersedes another takes its place; the owner sees every one, and the owner's veto takes one out of the next pack, stands against the same words, and --lift puts it back", () =>
    withWorkWorld(async (w) => {
      const filer = await w.client("filer", ["own"], { tools: TOOLS });
      const peer = await w.client("peer", ["own"], { tools: TOOLS });
      const older = await file(w, filer, "Get document needs the evidence id");
      const newer = await file(w, filer, "Get document takes the document id too", { supersedes: older.learning });
      expect(await ids(w, filer)).toEqual([newer.learning]);
      expect(await ids(w, peer)).toEqual([newer.learning]);

      // The owner's view: every learning, its state and its words.
      await withAdmin(w, async (admin) => {
        expect(await admin.work.learnings()).toEqual([
          expect.objectContaining({
            id: newer.learning,
            state: "active",
            by: "filer",
            supersedes: older.learning,
            statement: "Get document takes the document id too",
          }),
        ]);
        expect((await admin.work.learnings({ all: true })).map((row) => [row.id, row.state])).toEqual([
          [newer.learning, "active"],
          [older.learning, "superseded"],
        ]);
        // The veto of the newer: the older is active again.
        await admin.work.retireLearning(newer.learning as never);
        await expect(admin.work.retireLearning(newer.learning as never)).rejects.toThrow("unchanged");
      });
      expect(await ids(w, filer)).toEqual([older.learning]);
      // The veto stands against the same words filed again, and the agent cannot supersede it.
      expect(await file(w, filer, "Get document takes the document id too")).toEqual({
        learning: newer.learning,
        vetoed: true,
      });
      expect(await fileRaw(w, filer, "Get document is fine", { supersedes: newer.learning })).toMatchObject({
        ok: false,
        code: "not_found",
      });
      // The veto of both: nothing served. The lift puts it back.
      await withAdmin(w, (admin) => admin.work.retireLearning(older.learning as never));
      expect(await ids(w, filer)).toEqual([]);
      expect(await ids(w, peer)).toEqual([]);
      await withAdmin(w, (admin) => admin.work.retireLearning(newer.learning as never, { lift: true }));
      expect(await ids(w, peer)).toEqual([newer.learning]);
      await withAdmin(w, async (admin) => {
        await expect(admin.work.retireLearning("lrn_01J00000000000000000000000" as never)).rejects.toThrow("not_found");
      });
    }, LABELS));

  it("invariant 6: a learning under a label the agent is not cleared for moves nothing it is served, and a hidden superseder leaves the older one active for it", () =>
    withWorkWorld(async (w) => {
      const scout = await w.client("scout", ["agent:scout", "own"], { tools: TOOLS });
      const viewer = await w.client("viewer", ["own"], { tools: TOOLS });
      const seen = await file(w, viewer, "The calendar read is a day off");
      // An agent supersedes only its own, so a superseder the viewer cannot see is the scout's over
      // one the scout filed when its clearance was the viewer's: the learning is moved to the scout
      // and its session, its words and label kept.
      await session(w.db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        await query(
          "update ledger.agent_learnings set created_by = $2, client_id = $3, session_id = $4 where id = $1",
          [seen.learning, `client:${scout.id}`, scout.id, scout.session],
        );
      });

      const before = await bootstrap(w, viewer);
      const hidden = await file(w, scout, "A hidden source drops its first page");
      const superseder = await file(w, scout, "The calendar read is right after noon", {
        supersedes: seen.learning,
      });
      expect(await w.label("ledger.agent_learnings", hidden.learning)).toEqual(["agent:scout", "own"]);
      // The same pack, item for item, but the pack's time.
      const after = await bootstrap(w, viewer);
      expect(timeless(after)).toEqual(timeless(before));
      expect(await ids(w, viewer)).toEqual([seen.learning]);
      // The same words as the hidden one are filed anew, not merged with what it cannot see; and it
      // cannot supersede it.
      const own = await file(w, viewer, "A hidden source drops its first page");
      expect(own.learning).not.toBe(hidden.learning);
      expect(own.merged).toBeUndefined();
      expect(await fileRaw(w, viewer, "It does not", { supersedes: hidden.learning })).toMatchObject({
        ok: false,
        code: "not_found",
      });
      // The cleared agent sees the superseder in the older one's place, its other one and the viewer's.
      expect((await ids(w, scout)).sort()).toEqual([hidden.learning, superseder.learning, own.learning].sort());
    }, LABELS));

  it("the owner's status holds the active learnings of the last week, their words opened, and none retired, tainted, replaced or old", () =>
    withWorkWorld(async (w) => {
      const filer = await w.client("filer", ["own"], { tools: TOOLS });
      await setClientRoles(w.admin, "filer", ["scout"], new Date());
      const message = await w.message(["own"]);
      const kept = await file(w, filer, "Search wants the whole name", { scope: "scout" });
      const retired = await file(w, filer, "The calendar read is a day off");
      const old = await file(w, filer, "Timeline pages by cursor");
      const replaced = await file(w, filer, "Get document needs the evidence id");
      const newer = await file(w, filer, "Get document takes the document id too", { supersedes: replaced.learning });
      await session(w.db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        await query("update ledger.agent_learnings set created_at = now() - interval '8 days' where id = $1", [
          old.learning,
        ]);
      });
      await withAdmin(w, (admin) => admin.work.retireLearning(retired.learning as never));
      // A learning tainted by an erasure: its session was given the erased item before it was filed,
      // after the others were.
      const [row] = await w.admin<{ session_id: string; client_id: string }>(
        "select session_id, client_id from ledger.agent_learnings where id = $1",
        [kept.learning],
      );
      await session(w.db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        await query(
          "insert into ledger.read_log (session_id, client_id, tool, read_at, compartments, bound, shown, fact_key_fps) values ($1, $2, 'read_message', now(), '{own}', $3, '{}', '{}')",
          [row?.session_id, row?.client_id, [message.evidence]],
        );
      });
      await file(w, filer, "Read message wants the thread first");
      await session(w.db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        await query("select ledger.taint_citing($1, '{}', '{}')", [[message.evidence]]);
      });
      const states = await withAdmin(w, (admin) => admin.work.learnings({ all: true }));
      expect(states.map((one) => one.state).sort()).toEqual([
        "active",
        "active",
        "active",
        "retired",
        "superseded",
        "tainted",
      ]);
      const status = await withAdmin(w, (admin) => admin.accounts.status({ tables: "estimate" }));
      expect(status.learnings).toEqual([
        {
          learning: newer.learning,
          scope: "general",
          client: "filer",
          at: expect.any(String),
          statement: { untrusted: "Get document takes the document id too" },
          rule: { untrusted: "So: get document takes the document id too." },
        },
        {
          learning: kept.learning,
          scope: "scout",
          client: "filer",
          at: expect.any(String),
          statement: { untrusted: "Search wants the whole name" },
          rule: { untrusted: "So: search wants the whole name." },
        },
      ]);
      // Never the evidence.
      expect(JSON.stringify(status.learnings)).not.toContain("example.org");
      // Lifted, the veto's learning is back on the owner's page.
      await withAdmin(w, (admin) => admin.work.retireLearning(retired.learning as never, { lift: true }));
      expect(
        (await withAdmin(w, (admin) => admin.accounts.status({ tables: "estimate" }))).learnings.map(
          (one) => one.learning,
        ),
      ).toEqual([newer.learning, retired.learning, kept.learning]);
    }, LABELS));

  it("R2, invariant 6: an agent whose clearance no longer covers its own learning cannot supersede it, answered as a missing id, and the learning stays served to an agent still cleared", () =>
    withWorkWorld(async (w) => {
      const narrowed = await w.client("narrowed", ["agent:scout", "own"], { tools: TOOLS });
      const cleared = await w.client("cleared", ["agent:scout", "own"], { tools: TOOLS });
      const own = await file(w, narrowed, "The hidden source pages by cursor");
      expect(await w.label("ledger.agent_learnings", own.learning)).toEqual(["agent:scout", "own"]);
      expect(await ids(w, cleared)).toEqual([own.learning]);
      await w.admin("update policy.clients set compartments = '{own}' where id = $1", [narrowed.id]);
      const refused = await fileRaw(w, narrowed, "The hidden source pages by page", { supersedes: own.learning });
      const missing = await fileRaw(w, narrowed, "The hidden source pages by page", {
        supersedes: "lrn_01J00000000000000000000000",
      });
      expect(refused).toMatchObject({ ok: false, code: "not_found" });
      expect(refused).toEqual(missing);
      expect(await ids(w, cleared)).toEqual([own.learning]);
    }, LABELS));

  it("R11, invariant 10: a learning written by a session after it was given an erased item is tainted and served to no one", () =>
    withWorkWorld(async (w) => {
      const filer = await w.client("filer", ["own"], { tools: TOOLS });
      const peer = await w.client("peer", ["own"], { tools: TOOLS });
      const message = await w.message(["own"]);
      const filed = await file(w, filer, "Read message wants the thread first");
      expect(await ids(w, peer)).toEqual([filed.learning]);
      const [row] = await w.admin<{ session_id: string; client_id: string }>(
        "select session_id, client_id from ledger.agent_learnings where id = $1",
        [filed.learning],
      );
      await session(w.db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        await query(
          "insert into ledger.read_log (session_id, client_id, tool, read_at, compartments, bound, shown, fact_key_fps) values ($1, $2, 'read_message', now() - interval '1 hour', '{own}', $3, '{}', '{}')",
          [row?.session_id, row?.client_id, [message.evidence]],
        );
        await query("select ledger.taint_citing($1, '{}', '{}')", [[message.evidence]]);
      });
      expect(await ids(w, peer)).toEqual([]);
      const [tainted] = await w.admin<{
        tainted: boolean;
        statement_enc: unknown;
        rule_enc: unknown;
        evidence_enc: unknown;
      }>(
        "select tainted_at is not null as tainted, statement_enc, rule_enc, evidence_enc from ledger.agent_learnings where id = $1",
        [filed.learning],
      );
      expect(tainted).toEqual({ tainted: true, statement_enc: null, rule_enc: null, evidence_enc: null });
      await withAdmin(w, async (admin) => {
        expect(
          (await admin.work.learnings({ all: true })).map((item) => [item.id, item.state, item.statement]),
        ).toEqual([[filed.learning, "tainted", null]]);
      });
    }, LABELS));
});
