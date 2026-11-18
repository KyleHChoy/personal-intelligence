import { ContextPack, type EntityId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { setTaskTier } from "../admin/admin-tasks.ts";
import { sealUnder } from "../core/seal.ts";
import { request, testId } from "../test-support/clients.ts";
import { seedFacts } from "../test-support/fact-fixtures.ts";
import { asOwner } from "../test-support/pipeline-fixtures.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { AGENT_WORK_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { personUnder as person } from "../test-support/work-seeds.ts";
import { proposed, screened, type TaskOptions, workAgent } from "../test-support/work-test-tasks.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";

// Synthetic rows only; names are examples.

const OWN = ["own"];
const WORK = ["employer:example"];
const NAMES = ["scout", "peer", "narrow"];
const AGENTS = NAMES.map((name) => `agent:${name}`);
const WORLD = ["own", "employer:example", ...AGENTS];
const TOOLS = [
  ...AGENT_WORK_TOOLS,
  "propose_task",
  "hand_off",
  "record",
  "search",
  "get_entity",
  "find_records",
  "propose_project",
  "update_project",
  "list_projects",
  "get_project",
  "build_context_pack",
];

// The agents cleared for own share every agent compartment, as the default clearances give them,
// so each reads what the others write; any other holds its own alone, as every client that holds
// `record` does. Each with its agent source account: a status or a note is its finding, whose typed
// claims are written under that account.
const agent = (w: WorkWorld, name: string, compartments = OWN, roles: string[] = []): Promise<WorkClient> =>
  workAgent(w, name, compartments.includes("own") ? [...compartments, ...AGENTS] : [...compartments, `agent:${name}`], {
    tools: TOOLS,
    kinds: ["investigate", "research"],
    account: true,
    roles,
  });
const task = (w: WorkWorld, client: WorkClient, subject: string, options: TaskOptions = {}) =>
  proposed(w, client, { subject, ...options });

// The work world reads on the real clock, so its seeded facts need no redating: seedFacts' "known
// by" is a time after every row it writes.
const onRealClock = (w: WorkWorld) => ({ db: w.db, now: new Date(Date.now() + 86_400_000) }) as never;
const count = async (w: WorkWorld, sql: string, values: unknown[] = []): Promise<number> =>
  (await w.admin<{ n: number }>(sql, values))[0]?.n ?? -1;
const project = async (w: WorkWorld, client: WorkClient, name: string): Promise<EntityId> =>
  ok(await w.work.proposeProject(client.token, { name, requestId: request() })).project as EntityId;
const whole = async (w: WorkWorld, client: WorkClient, id: string) =>
  ok(await w.work.getProject(client.token, { project: id as EntityId }));
const listed = async (w: WorkWorld, client: WorkClient, args: Record<string, unknown> = {}) =>
  ok(await w.work.listProjects(client.token, args as never));
const brief = (w: WorkWorld, client: WorkClient, id: string) =>
  w.reader.buildContextPack(client.token, { purpose: "project_brief", project: id as EntityId });
const boardOf = async (w: WorkWorld, client: WorkClient, id?: string) =>
  ok(
    await w.work.listOpportunities(client.token, {
      scope: "board",
      ...(id === undefined ? {} : { project: id as EntityId }),
    }),
  );

// The owner's close, as `pi project close` writes it: the status, its time and the project's event.
async function ownerCloses(w: WorkWorld, id: string, at: Date): Promise<void> {
  await w.admin("update knowledge.projects set status = 'closed', updated_at = $2 where id = $1", [id, at]);
  await w.admin(
    "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) select 'project', p.id, 'closed', $2, 'owner', p.compartments from knowledge.projects p where p.id = $1",
    [id, at],
  );
}

// A progress report on a move, as report_move writes one ("Shapes the two parts share"): a
// `reported` event of code `progress`, its lines sealed under the work's label and bound to
// `<move id>/reported`.
async function progress(
  w: WorkWorld,
  client: WorkClient,
  move: string,
  report: { done: string[]; next?: string; waitingOn?: string; resumeAt?: string },
): Promise<void> {
  const label = await w.label("ledger.moves", move);
  const body = sealUnder(
    w.keys,
    label,
    { table: "ledger.record_events", id: `${move}/reported`, column: "body_enc" },
    JSON.stringify({ v: 1, report, marks: [] }),
  );
  await asOwner(
    w.db,
    "insert into ledger.record_events (row_kind, row_id, event, code, at, by, compartments, body_enc) values ('move', $1, 'reported', 'progress', now(), $2, $3, $4)",
    [move, `client:${client.id}`, label, JSON.stringify(body)],
  );
}

describe("projects agents write and read", { timeout: DB_TEST_TIMEOUT }, () => {
  it("B1: an agent creates a project at once, active, under its clearance, with no card; a repeat and a held name answer the first", () =>
    withWorkWorld(async (w) => {
      const scout = await agent(w, "scout");
      const peer = await agent(w, "peer");
      const args = { name: "Kiln rebuild", requestId: request() };
      const { project: id } = ok(await w.work.proposeProject(scout.token, args));
      expect(id).toMatch(/^ent_/);
      const [row] = await w.admin<{ status: string; created_by: string; compartments: string[]; readers: string[] }>(
        "select status, created_by, compartments, readers from knowledge.projects where id = $1",
        [id],
      );
      // The label is the caller's clearance, sorted, each once: no argument names one.
      expect(row).toEqual({
        status: "active",
        created_by: `client:${scout.id}`,
        compartments: [...new Set(["own", ...AGENTS])].sort(),
        readers: ["m-owner"],
      });
      expect(await w.admin("select kind from knowledge.entities where id = $1", [id])).toEqual([{ kind: "project" }]);
      expect(await count(w, "select count(*)::int as n from ledger.cards")).toBe(0);
      expect(
        await w.admin("select event, by from ledger.record_events where row_kind = 'project' and row_id = $1", [id]),
      ).toEqual([{ event: "created", by: `client:${scout.id}` }]);
      // A repeat of the request, and another agent's project of the same name, answer the first.
      expect(ok(await w.work.proposeProject(scout.token, args))).toEqual({ project: id });
      expect(ok(await w.work.proposeProject(peer.token, { name: "  kiln rebuild ", requestId: request() }))).toEqual({
        project: id,
      });
      expect(await count(w, "select count(*)::int as n from knowledge.projects")).toBe(1);

      // It stands active since it was made, by the agent that made it; another agent reads the same.
      const view = await whole(w, peer, id);
      expect(view).toMatchObject({
        id,
        name: { untrusted: "Kiln rebuild" },
        status: { value: "active", by: { kind: "agent", client: "scout" } },
        ownerRole: null,
        goal: null,
        dueAt: null,
        createdBy: "scout",
        work: [],
        nextSteps: [],
        decisions: [],
        more: false,
      });
      expect(view.status.asOf).toBe(view.createdAt);
      expect(view.changes).toEqual([{ kind: "field", at: view.createdAt, field: "created", by: "agent" }]);
      // B8: found by search, as any project.
      const found = ok(await w.reader.search(peer.token, { query: "Kiln rebuild" }));
      expect(found.results.map((one) => one.id)).toContain(id);

      // A role no agent holds, and a goal the caller cannot see, are refused and write nothing.
      expect(
        await w.work.proposeProject(scout.token, {
          name: "Glaze tests",
          ownerRole: "nobody-holds",
          requestId: request(),
        }),
      ).toEqual({ ok: false, code: "unknown_role" });
      expect(
        await w.work.proposeProject(scout.token, {
          name: "Glaze tests",
          goal: testId("gol") as never,
          requestId: request(),
        }),
      ).toEqual({ ok: false, code: "not_found" });
      expect(await count(w, "select count(*)::int as n from knowledge.projects")).toBe(1);
    }, WORLD));

  it("B2, B3: an agent's status is its typed claim, read below a source's; both show with their times; the owner's close outranks it", () =>
    withWorkWorld(async (w) => {
      const scout = await agent(w, "scout");
      const id = await project(w, scout, "Kiln rebuild");
      const set = ok(
        await w.work.updateProject(scout.token, {
          project: id,
          status: "blocked",
          note: "The firebrick has not shipped.",
          requestId: request(),
        }),
      );
      expect(set).toMatchObject({ project: id, status: { value: "blocked", by: { kind: "agent", client: "scout" } } });
      expect(set.refused).toBeUndefined();
      // Its record is a finding of the caller's own, filed under the project, with one status claim
      // and no card.
      expect(
        await w.admin("select kind, project_id, client_name from ledger.agent_writes where id = $1", [set.record]),
      ).toEqual([{ kind: "finding", project_id: id, client_name: "scout" }]);
      expect(
        await w.admin(
          "select c.type from knowledge.claims c join ledger.agent_writes w on w.evidence_id = c.evidence_id where w.id = $1",
          [set.record],
        ),
      ).toEqual([{ type: "project.status" }]);
      expect(await count(w, "select count(*)::int as n from ledger.cards")).toBe(0);

      // A status is said at a time: blocked, then active, then blocked again reads blocked.
      ok(await w.work.updateProject(scout.token, { project: id, status: "active", requestId: request() }));
      const again = ok(
        await w.work.updateProject(scout.token, { project: id, status: "blocked", requestId: request() }),
      );
      expect(again.status).toMatchObject({ value: "blocked", by: { kind: "agent", client: "scout" } });
      expect(again.status.disputedBy).toBeUndefined();
      const blockedAt = again.status.asOf;

      // Later mail says active: a source outranks an agent, and the reply shows both with their times.
      const sender = await person(w);
      const mail = await screened(w);
      const sentAt = new Date(Date.now() + 60_000).toISOString();
      await seedFacts(
        onRealClock(w),
        "",
        [
          {
            key: `status-${id}`,
            type: "project.status",
            kind: "project_status",
            subject: id,
            subjectKind: "project",
            by: sender,
            message: { id: mail.id, evidenceId: mail.evidence, sentAt, compartment: "own" },
            fields: { status: "active" },
            fieldKinds: { status: "enum" },
            values: { status: "active" },
            entities: [id, sender],
          },
        ],
        [],
      );
      const both = (await whole(w, scout, id)).status;
      expect(both).toMatchObject({
        value: "active",
        asOf: sentAt,
        by: { kind: "source" },
        disputedBy: [{ value: "blocked", asOf: blockedAt, by: { kind: "agent", client: "scout" } }],
      });
      // get_entity serves the same beside the project's own row state.
      const entity = ok(await w.reader.getEntity(scout.token, { id }));
      expect(entity.status).toBe("active");
      expect(entity.projectStatus).toMatchObject({ value: "active", by: { kind: "source" } });
      // An agent's later word still does not outrank the source's.
      const later = ok(
        await w.work.updateProject(scout.token, { project: id, status: "waiting", requestId: request() }),
      );
      expect(later.status).toMatchObject({ value: "active", by: { kind: "source" } });
      expect(later.status.disputedBy).toMatchObject([{ value: "waiting", by: { kind: "agent", client: "scout" } }]);

      // The owner's close stands against any agent's word: nothing an agent sends changes it, and
      // nothing is written for the try.
      const closedAt = new Date(Date.now() + 120_000);
      await ownerCloses(w, id, closedAt);
      const records = await count(w, "select count(*)::int as n from ledger.agent_writes");
      const refused = ok(
        await w.work.updateProject(scout.token, {
          project: id,
          status: "active",
          name: "Kiln rebuild, again",
          note: "Still going.",
          requestId: request(),
        }),
      );
      expect(refused.status).toEqual({ value: "closed", asOf: closedAt.toISOString(), by: { kind: "owner" } });
      expect(refused.record).toBeUndefined();
      expect(refused.refused).toEqual(
        expect.arrayContaining([
          { field: "status", code: "not_active" },
          { field: "note", code: "not_active" },
          { field: "name", code: "not_active" },
        ]),
      );
      expect(await count(w, "select count(*)::int as n from ledger.agent_writes")).toBe(records);
      expect((await listed(w, scout, { status: ["closed"] })).projects.map((one) => one.id)).toEqual([id]);
      expect((await listed(w, scout, { status: ["active"] })).projects).toEqual([]);
    }, WORLD));

  it("B3, invariant 11: more agent statuses than one read holds never push out the owner's word or a source's", () =>
    withWorkWorld(async (w) => {
      const scout = await agent(w, "scout");
      const id = await project(w, scout, "Kiln rebuild");
      // The owner, and a person who writes to them.
      const me = testId("ent");
      await w.admin("insert into knowledge.entities (id, kind) values ($1, 'owner')", [me]);
      await w.seed.account(OWN, me);
      const sender = await person(w);
      const said = async (key: string, by: string, status: string, secondsAgo: number): Promise<string> => {
        const mail = await screened(w);
        const sentAt = new Date(Date.now() - secondsAgo * 1000).toISOString();
        await seedFacts(
          onRealClock(w),
          me,
          [
            {
              key: `${key}-${id}`,
              type: "project.status",
              kind: "project_status",
              subject: id,
              subjectKind: "project",
              by,
              message: { id: mail.id, evidenceId: mail.evidence, sentAt, compartment: "own" },
              fields: { status },
              fieldKinds: { status: "enum" },
              values: { status },
              entities: [id, by],
            },
          ],
          [],
        );
        return sentAt;
      };
      // The owner said waiting; later mail says active; then the agent says blocked 51 times,
      // one more than a read of the project's status holds.
      const ownerAt = await said("owner", me, "waiting", 120);
      const sourceAt = await said("source", sender, "active", 60);
      for (let n = 0; n < 51; n += 1)
        ok(await w.work.updateProject(scout.token, { project: id, status: "blocked", requestId: request() }));
      const standing = (await whole(w, scout, id)).status;
      expect(standing).toMatchObject({ value: "waiting", asOf: ownerAt, by: { kind: "owner" } });
      expect(standing.disputedBy).toMatchObject([
        { value: "active", asOf: sourceAt, by: { kind: "source" } },
        { value: "blocked", by: { kind: "agent", client: "scout" } },
      ]);
      // The list and get_entity read it the same.
      expect((await listed(w, scout)).projects.map((one) => [one.id, one.status.value])).toEqual([[id, "waiting"]]);
      expect(ok(await w.reader.getEntity(scout.token, { id })).projectStatus).toMatchObject({
        value: "waiting",
        by: { kind: "owner" },
      });
    }, WORLD));

  it("B2: a rename by an agent cleared for more is sealed under the project's own label, so each of its readers still opens it", () =>
    withWorkWorld(async (w) => {
      const narrow = await agent(w, "narrow", WORK);
      const wide = await agent(w, "peer", ["own", ...WORK]);
      const id = await project(w, narrow, "Client onboarding");
      const label = await w.label("knowledge.projects", id);
      expect(label).toEqual(["agent:narrow", ...WORK]);
      const renamed = ok(
        await w.work.updateProject(wide.token, {
          project: id,
          name: "Client onboarding, phase two",
          requestId: request(),
        }),
      );
      expect(renamed.refused).toBeUndefined();
      // The row keeps its label, and the client cleared for that label alone opens the new name.
      expect(await w.label("knowledge.projects", id)).toEqual(label);
      for (const reader of [narrow, wide])
        expect((await whole(w, reader, id)).name).toEqual({ untrusted: "Client onboarding, phase two" });
      expect((await listed(w, narrow)).projects.map((one) => one.name)).toEqual([
        { untrusted: "Client onboarding, phase two" },
      ]);
    }, WORLD));

  it("invariant 6: a status or a task under a wider label leaves a narrower viewer's list_projects and get_project byte-identical", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const narrow = await agent(w, "narrow", WORK);
      const wide = await agent(w, "peer", ["own", ...WORK]);
      const older = await project(w, narrow, "Client onboarding");
      const newer = await project(w, narrow, "Client renewal");
      const reads = async () => JSON.stringify([await listed(w, narrow), await whole(w, narrow, older)]);
      const before = await reads();
      expect((await listed(w, narrow)).projects.map((one) => one.id)).toEqual([newer, older]);

      // The wider client says where the older project stands and files a task under it: both are
      // under its own label, which the narrow client is not cleared for.
      const set = ok(
        await w.work.updateProject(wide.token, {
          project: older,
          status: "blocked",
          note: "Waiting on the contract.",
          requestId: request(),
        }),
      );
      expect(set.status).toMatchObject({ value: "blocked", by: { kind: "agent", client: "peer" } });
      const filed = ok(await task(w, wide, await person(w), { project: older }));
      expect(await w.label("ledger.opportunities", filed.opportunity)).toContain("own");
      // The wider client reads its own word and work; the narrow client's replies are the same
      // bytes, the project's time and its place in the list included.
      const seen = await whole(w, wide, older);
      expect(seen.status).toMatchObject({ value: "blocked" });
      expect(seen.work.map((one) => one.id)).toEqual([filed.opportunity]);
      expect(await reads()).toBe(before);

      // The control: a word under the project's own label moves it to the front.
      ok(await w.work.updateProject(narrow.token, { project: older, status: "waiting", requestId: request() }));
      expect((await listed(w, narrow)).projects.map((one) => one.id)).toEqual([older, newer]);
    }, WORLD));

  it("B6: a blocker a deletion tainted blocks nothing", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      const peer = await agent(w, "peer");
      const kiln = await project(w, scout, "Kiln rebuild");
      const blocker = ok(await task(w, scout, await person(w), { project: kiln }));
      const waits = ok(await task(w, scout, await person(w), { project: kiln, blockedBy: [blocker.opportunity] }));
      const row = async () => (await boardOf(w, scout, kiln)).opportunities.find((one) => one.id === waits.opportunity);
      expect((await row())?.blockedBy).toEqual([blocker.opportunity]);
      expect(await w.work.claimOpportunity(peer.token, { id: waits.opportunity, requestId: request() })).toEqual({
        ok: false,
        code: "not_found",
        refusal: "work_blocked",
      });
      // Its source deleted, the blocker is tainted: nobody can finish it, so it is closed.
      await asOwner(w.db, "update ledger.opportunities set tainted_at = now() where id = $1", [blocker.opportunity]);
      expect((await row())?.blockedBy).toBeUndefined();
      ok(await w.work.claimOpportunity(peer.token, { id: waits.opportunity, requestId: request() }));
    }, WORLD));

  it("B2, invariant 11: an agent sets a project's fields, never the name the owner gave nor a field the owner set last", () =>
    withWorkWorld(async (w) => {
      const scout = await agent(w, "scout", OWN, ["research"]);
      const mine = await project(w, scout, "Kiln rebuild");
      const due = "2026-06-01T00:00:00.000Z";
      const set = ok(
        await w.work.updateProject(scout.token, {
          project: mine,
          name: "Kiln rebuild and glaze tests",
          ownerRole: "research",
          dueAt: due,
          requestId: request(),
        }),
      );
      expect(set.refused).toBeUndefined();
      expect(await whole(w, scout, mine)).toMatchObject({
        name: { untrusted: "Kiln rebuild and glaze tests" },
        ownerRole: "research",
        dueAt: due,
      });
      // The same again changes nothing and writes no second event.
      const events = () =>
        count(w, "select count(*)::int as n from ledger.record_events where row_kind = 'project' and row_id = $1", [
          mine,
        ]);
      const before = await events();
      ok(
        await w.work.updateProject(scout.token, {
          project: mine,
          name: "Kiln rebuild and glaze tests",
          ownerRole: "research",
          dueAt: due,
          requestId: request(),
        }),
      );
      expect(await events()).toBe(before);
      expect(
        await w.work.updateProject(scout.token, { project: mine, ownerRole: "nobody-holds", requestId: request() }),
      ).toEqual({ ok: false, code: "unknown_role" });

      // A project the owner made keeps the name the owner gave it; its other fields an agent may set.
      const theirs = await w.seed.project(OWN);
      const tried = ok(
        await w.work.updateProject(scout.token, {
          project: theirs as EntityId,
          name: "Renamed by an agent",
          ownerRole: "research",
          requestId: request(),
        }),
      );
      expect(tried.refused).toEqual([{ field: "name", code: "owner_set" }]);
      expect(await whole(w, scout, theirs)).toMatchObject({
        name: { untrusted: "Seed project" },
        ownerRole: "research",
        createdBy: "owner",
      });
      // Once the owner sets a field, an agent's word on it is refused.
      await w.admin("update knowledge.projects set owner_role = null where id = $1", [theirs]);
      await w.admin(
        "insert into ledger.record_events (row_kind, row_id, event, code, at, by, compartments) values ('project', $1, 'updated', 'owner_role', now(), 'owner', $2)",
        [theirs, OWN],
      );
      const held = ok(
        await w.work.updateProject(scout.token, {
          project: theirs as EntityId,
          ownerRole: "research",
          requestId: request(),
        }),
      );
      expect(held.refused).toEqual([{ field: "ownerRole", code: "owner_set" }]);
      expect((await whole(w, scout, theirs)).ownerRole).toBeNull();
    }, WORLD));

  it("B5, B6, B7: the board by project lists its tasks with holders; a child is never merged and is claimable only once its blocker closes; get_project answers it all in one call", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      const peer = await agent(w, "peer");
      const kiln = await project(w, scout, "Kiln rebuild");
      const other = await project(w, scout, "Glaze tests");
      const subject = await person(w);

      const first = ok(await task(w, scout, subject, { project: kiln }));
      expect(first.status).toBe("go");
      // A second task about the same subject merges into the open one; a step of it never does.
      expect(ok(await task(w, scout, subject, { project: kiln }))).toMatchObject({
        opportunity: first.opportunity,
        merged: true,
      });
      const step = ok(await task(w, scout, subject, { project: kiln, parent: first.opportunity }));
      expect(step.merged).toBeUndefined();
      expect(step.opportunity).not.toBe(first.opportunity);
      const waits = ok(
        await task(w, scout, await person(w), {
          project: kiln,
          parent: first.opportunity,
          blockedBy: [step.opportunity],
        }),
      );
      const elsewhere = ok(await task(w, scout, await person(w), { project: other }));
      expect(
        await w.admin("select opportunity_id, blocked_by from ledger.work_dependencies order by opportunity_id"),
      ).toEqual([{ opportunity_id: waits.opportunity, blocked_by: step.opportunity }]);

      // A project, a parent or a blocker the caller cannot see is an absent one, and writes nothing.
      const tasks = await count(w, "select count(*)::int as n from ledger.opportunities");
      for (const options of [{ project: testId("ent") }, { parent: testId("opp") }, { blockedBy: [testId("opp")] }])
        expect(await task(w, scout, await person(w), options)).toEqual({ ok: false, code: "not_found" });
      expect(await count(w, "select count(*)::int as n from ledger.opportunities")).toBe(tasks);

      // The board, by project: its three tasks, none of the other project's, with holders.
      ok(await w.work.claimOpportunity(peer.token, { id: first.opportunity, requestId: request() }));
      const board = (await boardOf(w, scout, kiln)).opportunities;
      expect(board.map((one) => one.id).sort()).toEqual(
        [first.opportunity, step.opportunity, waits.opportunity].sort(),
      );
      expect(board.every((one) => one.project === kiln)).toBe(true);
      const byId = new Map(board.map((one) => [one.id as string, one]));
      expect(byId.get(first.opportunity)).toMatchObject({ holder: "peer", status: "claimed" });
      expect(byId.get(step.opportunity)).toMatchObject({ parent: first.opportunity });
      expect(byId.get(step.opportunity)?.blockedBy).toBeUndefined();
      expect(byId.get(waits.opportunity)).toMatchObject({ parent: first.opportunity, blockedBy: [step.opportunity] });
      expect((await boardOf(w, scout, other)).opportunities.map((one) => one.id)).toEqual([elsewhere.opportunity]);
      // A project that does not exist files nothing.
      expect((await boardOf(w, scout, testId("ent"))).opportunities).toEqual([]);

      // Blocked: on the board, not open to take, and not claimable.
      const open = async () => ok(await w.work.listOpportunities(peer.token, {})).opportunities.map((one) => one.id);
      expect(await open()).not.toContain(waits.opportunity);
      expect(await open()).toContain(step.opportunity);
      expect(await w.work.claimOpportunity(peer.token, { id: waits.opportunity, requestId: request() })).toEqual({
        ok: false,
        code: "not_found",
        refusal: "work_blocked",
      });
      // Its blocker done, it is open and claimable.
      await w.status("opportunity", step.opportunity, "done");
      expect(await open()).toContain(waits.opportunity);
      expect(
        (await boardOf(w, scout, kiln)).opportunities.find((one) => one.id === waits.opportunity)?.blockedBy,
      ).toBeUndefined();
      ok(await w.work.claimOpportunity(scout.token, { id: waits.opportunity, requestId: request() }));

      // Progress on the held task shows on its board row and in get_project.
      const { move } = ok(
        await w.work.planMove(peer.token, {
          opportunity: first.opportunity,
          stage: "investigate",
          requestId: request(),
        }),
      );
      await progress(w, peer, move, {
        done: ["Read the supplier's thread."],
        next: "Ask for a quote.",
        waitingOn: "The supplier's reply.",
      });
      const row = (await boardOf(w, scout, kiln)).opportunities.find((one) => one.id === first.opportunity);
      expect(row?.progress).toMatchObject({
        done: [{ untrusted: "Read the supplier's thread." }],
        next: { untrusted: "Ask for a quote." },
        waitingOn: { untrusted: "The supplier's reply." },
        resumeAt: null,
        by: "peer",
      });

      ok(await w.work.updateProject(scout.token, { project: kiln, status: "waiting", requestId: request() }));
      const view = await whole(w, peer, kiln);
      expect(view.status).toMatchObject({ value: "waiting", by: { kind: "agent", client: "scout" } });
      // Its open work by holder, each with its latest progress: the done step is no longer open.
      expect(view.work.map((one) => one.id).sort()).toEqual([first.opportunity, waits.opportunity].sort());
      expect(view.work.find((one) => one.id === first.opportunity)).toMatchObject({
        holder: "peer",
        progress: { next: { untrusted: "Ask for a quote." }, by: "peer" },
      });
      expect(view.work.find((one) => one.id === waits.opportunity)).toMatchObject({ holder: "scout" });
      // The week's changes: the project made, its status said, and each step of its work.
      expect(view.changes.map((one) => one.kind)).toEqual(expect.arrayContaining(["field", "status", "work"]));
      expect(view.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "status", value: "waiting" }),
          expect.objectContaining({ kind: "work", opportunity: step.opportunity, event: "done" }),
          expect.objectContaining({ kind: "work", opportunity: first.opportunity, event: "claimed" }),
        ]),
      );
      expect([...view.changes].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).map((one) => one.at)).toEqual(
        view.changes.map((one) => one.at),
      );

      // The pack project_brief serves the same, by the same read, in one required item.
      const pack = ContextPack.parse(ok(await brief(w, peer, kiln)));
      expect(pack).toMatchObject({ purpose: "project_brief", template: "project_brief@1", truncated: false });
      expect(pack.items).toHaveLength(1);
      expect(pack.items[0]).toMatchObject({ kind: "project", id: kiln, section: "project", required: true });
      expect(pack.items[0]?.kind === "project" ? pack.items[0].project : null).toEqual(await whole(w, peer, kiln));
      // Its read log row holds what get_project's does, and it marks nothing read or changed.
      const logged = (tool: string) =>
        w.admin<{ shown: string[]; goals: string[] }>(
          "select r.shown, r.goals from ledger.read_log r where r.client_id = $1 and r.tool = $2 order by r.read_at desc limit 1",
          [peer.id, tool],
        );
      const [asPack] = await logged("build_context_pack");
      const [asTool] = await logged("get_project");
      expect([...(asPack?.shown ?? [])].sort()).toEqual([...(asTool?.shown ?? ["none"])].sort());
      expect(await whole(w, peer, kiln)).toEqual(view);
      // A project that is not there answers as get_project does.
      expect(await brief(w, peer, testId("ent"))).toEqual({ ok: false, code: "not_found" });
      // A client without get_project is refused before any row is read: the same for a project
      // it could see and for none.
      const reads = await w.client("reads", [...OWN, ...AGENTS], {
        tools: TOOLS.filter((tool) => tool !== "get_project"),
      });
      expect(await brief(w, reads, kiln)).toEqual({ ok: false, code: "not_permitted" });
      expect(await brief(w, reads, testId("ent"))).toEqual({ ok: false, code: "not_permitted" });
    }, WORLD));

  it("B7: list_projects pages, the most recently changed first", () =>
    withWorkWorld(async (w) => {
      const scout = await agent(w, "scout");
      const ids: string[] = [];
      for (const name of ["Kiln rebuild", "Glaze tests", "Studio move"]) ids.push(await project(w, scout, name));
      const [kiln, glaze, studio] = ids as [string, string, string];
      // Made in this order, so the newest is first.
      expect((await listed(w, scout)).projects.map((one) => one.id)).toEqual([studio, glaze, kiln]);
      // A change brings a project to the front: a status said, or work filed under it.
      ok(
        await w.work.updateProject(scout.token, { project: kiln as EntityId, status: "planned", requestId: request() }),
      );
      expect((await listed(w, scout)).projects.map((one) => one.id)).toEqual([kiln, studio, glaze]);
      await setTaskTier(w.admin, true, new Date());
      ok(await task(w, scout, await person(w), { project: glaze }));
      expect((await listed(w, scout)).projects.map((one) => one.id)).toEqual([glaze, kiln, studio]);

      // Pages of one: each `next` continues after the last, and the last page has none.
      const first = await listed(w, scout, { limit: 1 });
      expect(first.projects.map((one) => one.id)).toEqual([glaze]);
      const second = await listed(w, scout, { limit: 1, after: first.next });
      expect(second.projects.map((one) => one.id)).toEqual([kiln]);
      const third = await listed(w, scout, { limit: 1, after: second.next });
      expect(third.projects.map((one) => one.id)).toEqual([studio]);
      expect(third.next).toBeUndefined();
      // A filter by where each stands.
      expect((await listed(w, scout, { status: ["planned"] })).projects.map((one) => one.id)).toEqual([kiln]);
      expect((await listed(w, scout, { status: ["active"] })).projects.map((one) => one.id)).toEqual([glaze, studio]);
      // An `after` no page answered is refused.
      expect(await w.work.listProjects(scout.token, { after: "bm90LWEtY3Vyc29y" })).toEqual({
        ok: false,
        code: "invalid_request",
      });
    }, WORLD));

  it("B4: a finding filed under a project carries the project's own typed kinds, about that project alone", () =>
    withWorkWorld(async (w) => {
      const scout = await agent(w, "scout");
      const peer = await agent(w, "peer");
      const kiln = await project(w, scout, "Kiln rebuild");
      const other = await project(w, scout, "Glaze tests");
      const doer = await person(w);
      const claim = (type: string, fields: Record<string, unknown>, subject: string = kiln) => ({
        subject: { id: subject as EntityId },
        type,
        fields,
        cites: [],
        requestId: request(),
      });
      const ack = ok(
        await w.reader.record(scout.token, {
          kind: "finding",
          body: "The supplier ships in March. Decision: fire in April. Next: order the firebrick.",
          project: kiln,
          claims: [
            claim("project.status", { status: "waiting", what: "On the supplier." }),
            claim("project.decision", { what: "Fire in April." }),
            claim("project.next_step", { what: "Order the firebrick.", who: doer, due: "2026-03-01" }),
            // About another project, and with a word no agent sets a status with.
            claim("project.status", { status: "blocked" }, other),
            claim("project.status", { status: "cancelled" }),
          ],
          requestId: request(),
        }),
      );
      expect(ack.refused).toEqual([
        { index: 3, code: "fields_invalid" },
        { index: 4, code: "fields_invalid" },
      ]);
      const view = await whole(w, peer, kiln);
      expect(view.status).toMatchObject({ value: "waiting", by: { kind: "agent", client: "scout" } });
      expect(view.decisions).toMatchObject([
        { what: { untrusted: "Fire in April." }, by: { kind: "agent", client: "scout" } },
      ]);
      expect(view.nextSteps).toMatchObject([
        { what: { untrusted: "Order the firebrick." }, who: { id: doer }, due: "2026-03-01", record: ack.recordId },
      ]);
      // The other project heard nothing.
      expect((await whole(w, peer, other)).status).toMatchObject({ value: "active" });
      // A project's kind on a finding filed under no project is refused, claim by claim.
      const loose = ok(
        await w.reader.record(scout.token, {
          kind: "finding",
          body: "The kiln work is blocked.",
          claims: [claim("project.status", { status: "blocked" })],
          requestId: request(),
        }),
      );
      expect(loose.refused).toEqual([{ index: 0, code: "fields_invalid" }]);
    }, WORLD));

  it("invariant 6: a client outside a project's or a task's label gets byte-identical replies before and after it exists", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const narrow = await agent(w, "narrow", WORK);
      const scout = await agent(w, "scout");
      const peer = await agent(w, "peer");
      // What the narrow client has of its own, so its replies are not empty.
      const theirs = await project(w, narrow, "Client onboarding");
      ok(await task(w, narrow, await person(w, WORK), { project: theirs, compartments: WORK }));
      const absent = testId("ent");
      const reads = async (hidden: string) =>
        JSON.stringify([
          await listed(w, narrow),
          await listed(w, narrow, { status: ["blocked", "waiting", "closed"] }),
          await whole(w, narrow, theirs),
          await w.work.getProject(narrow.token, { project: hidden as EntityId }),
          await brief(w, narrow, hidden),
          // The pack of its own project, without the time and the hash of the call: each item's
          // `asOf` is the call's time too (read-pack-project.ts), whatever the store holds.
          ContextPack.parse(ok(await brief(w, narrow, theirs))).items.map(({ asOf: _at, ...item }) => item),
          await boardOf(w, narrow),
          await boardOf(w, narrow, theirs),
          await boardOf(w, narrow, hidden),
          ok(await w.work.listOpportunities(narrow.token, {})),
          await w.reader.getEntity(narrow.token, { id: hidden as EntityId }),
        ]);
      const before = await reads(absent);

      // Under own: a project, its status, its fields, tasks with a parent and a blocker, a claim,
      // progress, and the owner's close.
      const kiln = await project(w, scout, "Kiln rebuild");
      ok(
        await w.work.updateProject(scout.token, {
          project: kiln,
          status: "blocked",
          note: "No brick.",
          requestId: request(),
        }),
      );
      const first = ok(await task(w, scout, await person(w), { project: kiln }));
      const step = ok(await task(w, scout, await person(w), { project: kiln, parent: first.opportunity }));
      ok(await task(w, scout, await person(w), { project: kiln, blockedBy: [step.opportunity] }));
      ok(await w.work.claimOpportunity(peer.token, { id: first.opportunity, requestId: request() }));
      const { move } = ok(
        await w.work.planMove(peer.token, {
          opportunity: first.opportunity,
          stage: "investigate",
          requestId: request(),
        }),
      );
      await progress(w, peer, move, { done: ["Read the thread."], next: "Ask for a quote." });
      // The hidden project reads as the absent one did, and every other reply is unchanged.
      expect((await reads(kiln)).replaceAll(kiln, absent)).toBe(before);
      await ownerCloses(w, kiln, new Date());
      expect((await reads(kiln)).replaceAll(kiln, absent)).toBe(before);

      // And the narrow client can write nothing to what it cannot see: each answers as for no row.
      const rows = () =>
        count(
          w,
          "select (select count(*) from ledger.opportunities)::int + (select count(*) from ledger.agent_writes)::int + (select count(*) from ledger.record_events where row_kind = 'project')::int as n",
        );
      const held = await rows();
      expect(
        await w.work.updateProject(narrow.token, {
          project: kiln,
          status: "active",
          name: "Theirs now",
          requestId: request(),
        }),
      ).toEqual({ ok: false, code: "not_found" });
      for (const options of [{ project: kiln }, { parent: first.opportunity }, { blockedBy: [step.opportunity] }])
        expect(await task(w, narrow, await person(w, WORK), { ...options, compartments: WORK })).toEqual({
          ok: false,
          code: "not_found",
        });
      expect(await rows()).toBe(held);
      expect(await w.work.claimOpportunity(narrow.token, { id: step.opportunity, requestId: request() })).toEqual({
        ok: false,
        code: "not_found",
      });
    }, WORLD));
});
