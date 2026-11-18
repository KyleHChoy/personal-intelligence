import { ContextPack, type EntityId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { Admin } from "../admin/admin.ts";
import { setTaskTier } from "../admin/admin-tasks.ts";
import { AdminError } from "../core/admin-error.ts";
import { request, testId } from "../test-support/clients.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { AGENT_WORK_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { task, withAdmin, workAgent } from "../test-support/work-test-tasks.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";

// Synthetic rows only; every area and project name is an example.

const OWN = ["own"];
const WORK = ["employer:example"];
const NAMES = ["scout", "peer", "narrow", "both"];
const AGENTS = NAMES.map((name) => `agent:${name}`);
// The compartments the key file holds: an agent seals a project's name under its whole clearance.
const WORLD = ["own", "employer:example", ...AGENTS];
const TOOLS = [
  ...AGENT_WORK_TOOLS,
  "propose_task",
  "record",
  "propose_project",
  "update_project",
  "list_projects",
  "get_project",
  "build_context_pack",
];
const FIELD = "field-work";
const OFFICE = "back-office";
const YARD = "old-yard";

// The agents cleared for own share every agent compartment, as the default clearances give them;
// any other holds its own alone.
const agent = (w: WorkWorld, name: string, compartments = OWN, roles: string[] = []): Promise<WorkClient> =>
  workAgent(
    w,
    name,
    compartments.includes("own") ? [...new Set([...compartments, ...AGENTS])] : [...compartments, `agent:${name}`],
    { tools: TOOLS, kinds: ["investigate", "research"], account: true, roles },
  );

// The owner's commands, as `pia areas` and `pia project area` run them.
const owner = <T>(w: WorkWorld, fn: (areas: Admin["areas"]) => Promise<T>): Promise<T> =>
  withAdmin(w, (admin) => fn(admin.areas));
const refusedWith = async (run: Promise<unknown>): Promise<string> =>
  run.then(
    () => "ok",
    (error: unknown) => (error instanceof AdminError ? error.code : "threw"),
  );

const project = async (w: WorkWorld, client: WorkClient, name: string, area?: string): Promise<EntityId> =>
  ok(await w.work.proposeProject(client.token, { name, ...(area === undefined ? {} : { area }), requestId: request() }))
    .project as EntityId;
const whole = async (w: WorkWorld, client: WorkClient, id: string) =>
  ok(await w.work.getProject(client.token, { project: id as EntityId }));
const listed = async (w: WorkWorld, client: WorkClient, args: Record<string, unknown> = {}) =>
  ok(await w.work.listProjects(client.token, args as never));
const board = async (w: WorkWorld, client: WorkClient, area?: string) =>
  ok(await w.work.listOpportunities(client.token, { scope: "board", ...(area === undefined ? {} : { area }) }));
const setArea = (w: WorkWorld, client: WorkClient, id: string, area: string | null) =>
  w.work.updateProject(client.token, { project: id as EntityId, area, requestId: request() });
const areaEvents = (w: WorkWorld, id: string) =>
  w.admin<{ by: string; compartments: string[] }>(
    "select by, compartments from ledger.record_events where row_kind = 'project' and row_id = $1 and event = 'updated' and code = 'area' order by id",
    [id],
  );
const changedAt = async (w: WorkWorld, id: string): Promise<string> =>
  (await w.admin<{ at: string }>("select updated_at::text as at from knowledge.projects where id = $1", [id]))[0]?.at ??
  "";

describe("areas of the owner's life and work", { timeout: DB_TEST_TIMEOUT }, () => {
  it("AR1, AR2, AR4, AR7: the owner adds areas and a project takes one; list_projects serves the areas, filters by one, and a retired area keeps its project", () =>
    withWorkWorld(async (w) => {
      const scout = await agent(w, "scout");
      const kiln = await project(w, scout, "Kiln rebuild");
      const glaze = await project(w, scout, "Glaze tests");
      // Before any area: none listed, and no project has one.
      expect((await listed(w, scout)).areas).toEqual([]);
      expect((await whole(w, scout, kiln)).area).toBeNull();

      await owner(w, async (areas) => {
        await areas.add(FIELD, "Field work");
        await areas.add(OFFICE, "Back office");
        await areas.add(YARD, "The old yard");
        // A key is given once, and is of the key's form; a name is the owner's words.
        expect(await refusedWith(areas.add(FIELD, "Again"))).toBe("duplicate_name");
        expect(await refusedWith(areas.add("Field Work", "A name"))).toBe("invalid_argument");
        expect(await refusedWith(areas.add("blank-name", "   "))).toBe("invalid_argument");
        expect(await refusedWith(areas.rename("no-such", "A name"))).toBe("not_found");
        await areas.setProjectArea(kiln, FIELD);
      });
      // The name is sealed: the row holds the key in clear and no name.
      const stored = await w.admin<{ key: string; name: string; compartments: string[]; state: string }>(
        'select key, name_enc::text as name, compartments, state from knowledge.areas order by position, key collate "C"',
      );
      expect(stored.map((one) => [one.key, one.compartments, one.state])).toEqual([
        [FIELD, OWN, "active"],
        [OFFICE, OWN, "active"],
        [YARD, OWN, "active"],
      ]);
      for (const one of stored) expect(one.name).not.toMatch(/Field work|Back office|old yard/);

      const field = { key: FIELD, name: { untrusted: "Field work" }, retired: false };
      const page = await listed(w, scout);
      expect(page.areas).toEqual([
        field,
        { key: OFFICE, name: { untrusted: "Back office" }, retired: false },
        { key: YARD, name: { untrusted: "The old yard" }, retired: false },
      ]);
      expect(Object.fromEntries(page.projects.map((one) => [one.id, one.area]))).toEqual({
        [kiln]: field,
        [glaze]: null,
      });
      expect((await whole(w, scout, kiln)).area).toEqual(field);
      // A filter by an area lists its projects alone; by one that holds none, or by no area, nothing.
      expect((await listed(w, scout, { area: FIELD })).projects.map((one) => one.id)).toEqual([kiln]);
      expect((await listed(w, scout, { area: OFFICE })).projects).toEqual([]);
      expect((await listed(w, scout, { area: "no-such" })).projects).toEqual([]);

      // Exactly one: a second area replaces the first.
      await owner(w, (areas) => areas.setProjectArea(kiln, YARD));
      expect((await listed(w, scout, { area: FIELD })).projects).toEqual([]);
      expect((await listed(w, scout, { area: YARD })).projects.map((one) => one.id)).toEqual([kiln]);

      // The owner renames, orders and retires. A retired area keeps its project, marked retired,
      // is listed after the active ones, and its key still filters.
      await owner(w, async (areas) => {
        await areas.rename(YARD, "The yard");
        await areas.order([OFFICE]);
        expect(await refusedWith(areas.order([OFFICE, "no-such"]))).toBe("not_found");
        await areas.retire(YARD);
        expect((await areas.list()).map((one) => [one.key, one.name, one.retired, one.projects])).toEqual([
          [OFFICE, "Back office", false, 0],
          [FIELD, "Field work", false, 0],
          [YARD, "The yard", true, 1],
        ]);
      });
      const yard = { key: YARD, name: { untrusted: "The yard" }, retired: true };
      expect((await listed(w, scout)).areas.map((one) => one.key)).toEqual([OFFICE, FIELD, YARD]);
      expect((await whole(w, scout, kiln)).area).toEqual(yard);
      expect((await listed(w, scout, { area: YARD })).projects.map((one) => one.id)).toEqual([kiln]);
      // And it is given to no project: by the owner or by an agent.
      expect(await refusedWith(owner(w, (areas) => areas.setProjectArea(glaze, YARD)))).toBe("not_found");
      expect(await setArea(w, scout, glaze, YARD)).toMatchObject({ ok: false, refusal: "area_unknown" });
    }, WORLD));

  it("AR3, invariant 6: a client not cleared for the owner's own compartment gets byte-identical replies before and after areas exist", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const narrow = await agent(w, "narrow", WORK, ["research"]);
      const both = await agent(w, "both", [...OWN, ...WORK]);
      const theirs = await project(w, narrow, "Client onboarding");
      const other = await project(w, narrow, "Client renewal");
      const work = await task(w, narrow, { compartments: WORK, project: theirs });
      const reads = async () =>
        JSON.stringify([
          await listed(w, narrow),
          await listed(w, narrow, { area: FIELD }),
          await listed(w, narrow, { area: OFFICE }),
          await listed(w, narrow, { order: "area" }),
          await listed(w, narrow, { order: "area", limit: 1 }),
          await listed(w, narrow, { status: ["active"], area: FIELD }),
          await whole(w, narrow, theirs),
          await whole(w, narrow, other),
          // The pack of its project, without the time and the hash of the call: each item's `asOf`
          // is the call's time too, whatever the store holds.
          ContextPack.parse(
            ok(await w.reader.buildContextPack(narrow.token, { purpose: "project_brief", project: theirs })),
          ).items.map(({ asOf: _at, ...item }) => item),
          await board(w, narrow),
          await board(w, narrow, FIELD),
          await board(w, narrow, OFFICE),
          // Naming an area: refused the same for a key that is not there and one it cannot see.
          await w.work.proposeProject(narrow.token, { name: "A third", area: FIELD, requestId: request() }),
          await setArea(w, narrow, theirs, FIELD),
          await setArea(w, narrow, theirs, "no-such"),
          // Naming none: nothing to change, whatever the project's area is.
          await setArea(w, narrow, theirs, null),
          await setArea(w, narrow, other, null),
          await changedAt(w, theirs),
          await changedAt(w, other),
        ]);
      const before = await reads();
      expect(before).toContain(theirs);
      expect(before).toContain(work);
      expect(before).toContain('"refusal":"area_unknown"');

      // Areas, the narrow client's projects in them by the owner's word and by a wider agent's, a
      // default for the role it holds, an order and a retired area.
      await owner(w, async (areas) => {
        await areas.add(FIELD, "Field work");
        await areas.add(OFFICE, "Back office");
        await areas.setProjectArea(theirs, FIELD);
        await areas.setDefault("research", OFFICE);
        await areas.order([OFFICE, FIELD]);
      });
      expect(ok(await setArea(w, both, other, OFFICE)).refused).toBeUndefined();
      const after = await reads();
      expect(after).toBe(before);
      // A project it makes takes no default: it can see no area.
      const made = await project(w, narrow, "A fourth");
      expect(await w.admin("select area_id from knowledge.projects where id = $1", [made])).toEqual([
        { area_id: null },
      ]);
      await owner(w, (areas) => areas.retire(FIELD));
      // Its own new project aside, the replies are still the first ones.
      const again = JSON.parse(await reads()) as unknown[];
      expect(JSON.stringify(again.slice(6, 9))).toBe(JSON.stringify((JSON.parse(before) as unknown[]).slice(6, 9)));
      expect(JSON.stringify(again.slice(10))).toBe(JSON.stringify((JSON.parse(before) as unknown[]).slice(10)));

      // Control: the client cleared for both is served what the narrow one is not.
      const seen = await listed(w, both, { order: "area" });
      expect(seen.areas.map((one) => [one.key, one.retired])).toEqual([
        [OFFICE, false],
        [FIELD, true],
      ]);
      expect((await whole(w, both, theirs)).area).toMatchObject({ key: FIELD, retired: true });
      expect((await whole(w, both, other)).area).toMatchObject({ key: OFFICE });
      expect((await board(w, both, FIELD)).opportunities.map((one) => one.id)).toEqual([work]);
      // Each area event is under the project's label joined with the area's, which the narrow
      // client is not cleared for.
      for (const id of [theirs, other])
        for (const event of await areaEvents(w, id)) expect(event.compartments).toContain("own");
    }, WORLD));

  it("AR5, invariant 11: an unknown, a retired and an unseen key are refused alike; the owner's area stands against an agent's, and the owner changes an agent's", () =>
    withWorkWorld(async (w) => {
      const scout = await agent(w, "scout");
      const peer = await agent(w, "peer");
      await owner(w, async (areas) => {
        await areas.add(FIELD, "Field work");
        await areas.add(OFFICE, "Back office");
        await areas.add(YARD, "The old yard");
        await areas.retire(YARD);
      });
      const kiln = await project(w, scout, "Kiln rebuild");
      const refusal = { ok: false, code: "invalid_request", refusal: "area_unknown" };
      for (const key of ["no-such", YARD]) {
        expect(await setArea(w, scout, kiln, key)).toEqual(refusal);
        expect(
          await w.work.proposeProject(scout.token, { name: `In ${key}`, area: key, requestId: request() }),
        ).toEqual(refusal);
        // A name a project already holds does not pass a bad key over: it is refused the same,
        // never answered with that project as if the area had been taken.
        expect(
          await w.work.proposeProject(scout.token, { name: "Kiln rebuild", area: key, requestId: request() }),
        ).toEqual(refusal);
      }
      // A good key, or none, on a name already held answers the project that holds it.
      for (const area of [FIELD, undefined]) {
        expect(
          ok(
            await w.work.proposeProject(scout.token, {
              name: "Kiln rebuild",
              ...(area === undefined ? {} : { area }),
              requestId: request(),
            }),
          ).project,
        ).toBe(kiln);
      }
      // Nothing was written by a refused call, or by one answered with the project there.
      expect(await w.admin("select count(*)::int as n from knowledge.projects")).toEqual([{ n: 1 }]);
      // A project the caller cannot see answers not_found whatever area is named.
      expect(await setArea(w, scout, testId("ent"), "no-such")).toMatchObject({ ok: false, code: "not_found" });

      // An agent's area is the agent's word: recorded as its own, and another agent may change it.
      const first = await changedAt(w, kiln);
      expect(ok(await setArea(w, scout, kiln, FIELD)).refused).toBeUndefined();
      expect((await whole(w, peer, kiln)).area).toMatchObject({ key: FIELD });
      expect(await areaEvents(w, kiln)).toEqual([
        { by: `client:${scout.id}`, compartments: [...new Set(["own", ...AGENTS])].sort() },
      ]);
      // The project's label holds `own`, so every reader of it sees areas and its time of change moved.
      expect(await changedAt(w, kiln)).not.toBe(first);
      // The same area again writes nothing.
      expect(ok(await setArea(w, scout, kiln, FIELD)).refused).toBeUndefined();
      expect(await areaEvents(w, kiln)).toHaveLength(1);
      expect(ok(await setArea(w, peer, kiln, OFFICE)).refused).toBeUndefined();

      // The owner changes it, and from then an agent's word leaves it: owner_set.
      await owner(w, (areas) => areas.setProjectArea(kiln, FIELD));
      expect((await areaEvents(w, kiln)).at(-1)?.by).toBe("owner");
      for (const next of [OFFICE, null]) {
        expect(ok(await setArea(w, scout, kiln, next)).refused).toEqual([{ field: "area", code: "owner_set" }]);
        expect((await whole(w, scout, kiln)).area).toMatchObject({ key: FIELD });
      }
      // Its other fields are still the agent's to set.
      expect(
        ok(
          await w.work.updateProject(scout.token, {
            project: kiln,
            area: OFFICE,
            dueAt: "2026-06-01T00:00:00.000Z" as never,
            requestId: request(),
          }),
        ).refused,
      ).toEqual([{ field: "area", code: "owner_set" }]);
      expect((await whole(w, scout, kiln)).dueAt).toBe("2026-06-01T00:00:00.000Z");

      // The owner's word that a project has none stands too, on a project that never had one.
      const glaze = await project(w, scout, "Glaze tests");
      await owner(w, (areas) => areas.setProjectArea(glaze, null));
      expect(ok(await setArea(w, scout, glaze, FIELD)).refused).toEqual([{ field: "area", code: "owner_set" }]);
      expect((await whole(w, scout, glaze)).area).toBeNull();
      // A project the owner closed takes none.
      await w.admin("update knowledge.projects set status = 'closed' where id = $1", [glaze]);
      expect(ok(await setArea(w, scout, glaze, FIELD)).refused).toEqual([{ field: "area", code: "not_active" }]);
    }, WORLD));

  it("AR6: an agent that names no area takes its role's default; one it names wins; a retired default, or none, gives none", () =>
    withWorkWorld(async (w) => {
      const scout = await agent(w, "scout", OWN, ["research", "writing"]);
      const peer = await agent(w, "peer");
      await owner(w, async (areas) => {
        await areas.add(FIELD, "Field work");
        await areas.add(OFFICE, "Back office");
        // A role no active agent holds is refused, and so is a key that is no active area.
        expect(await refusedWith(areas.setDefault("nobody", FIELD))).toBe("unknown_role");
        expect(await refusedWith(areas.setDefault("research", "no-such"))).toBe("not_found");
        await areas.setDefault("writing", FIELD);
        expect((await areas.list()).find((one) => one.key === FIELD)?.defaultFor).toEqual(["writing"]);
      });
      const areaOf = async (id: string) => (await whole(w, scout, id)).area?.key ?? null;
      // The role's default, recorded as the agent's word, so the owner can change it.
      const first = await project(w, scout, "Kiln rebuild");
      expect(await areaOf(first)).toBe(FIELD);
      expect((await areaEvents(w, first)).map((one) => one.by)).toEqual([`client:${scout.id}`]);
      // An area named wins over the default.
      expect(await areaOf(await project(w, scout, "Glaze tests", OFFICE))).toBe(OFFICE);
      // An agent that holds no role with a default takes none.
      expect(await areaOf(await project(w, peer, "Shelf plans"))).toBeNull();
      // The first of its roles by name whose default is an active area: research before writing.
      await owner(w, (areas) => areas.setDefault("research", OFFICE));
      expect(await areaOf(await project(w, scout, "Clay order"))).toBe(OFFICE);
      // A retired default gives none of its own: the next role's stands.
      await owner(w, (areas) => areas.retire(OFFICE));
      expect(await areaOf(await project(w, scout, "Firing log"))).toBe(FIELD);
      // No default: no area.
      await owner(w, async (areas) => {
        await areas.setDefault("writing", null);
        await areas.setDefault("research", null);
      });
      expect(await areaOf(await project(w, scout, "Tool list"))).toBeNull();
    }, WORLD));

  it("AR7, AR8: list_projects in the areas' order pages through them, and the board by an area lists the work of its projects alone", () =>
    withWorkWorld(async (w) => {
      await setTaskTier(w.admin, true, new Date());
      const scout = await agent(w, "scout");
      await owner(w, async (areas) => {
        await areas.add(FIELD, "Field work");
        await areas.add(OFFICE, "Back office");
        await areas.add(YARD, "The old yard");
      });
      // Made in this order, so the latest change is the last one's.
      const none = await project(w, scout, "Shelf plans");
      const yard = await project(w, scout, "Fence repair", YARD);
      const office = await project(w, scout, "Invoices", OFFICE);
      const older = await project(w, scout, "Kiln rebuild", FIELD);
      const newer = await project(w, scout, "Glaze tests", FIELD);
      await owner(w, (areas) => areas.retire(YARD));
      const ids = async (args: Record<string, unknown>) => (await listed(w, scout, args)).projects.map((one) => one.id);
      // Without an order: the most recently changed first, as before.
      expect(await ids({})).toEqual([newer, older, office, yard, none]);
      // By area: the owner's order, the retired area after the active ones, no area last; within
      // one, the most recently changed first.
      expect(await ids({ order: "area" })).toEqual([newer, older, office, yard, none]);
      await owner(w, (areas) => areas.order([OFFICE, FIELD]));
      const ordered = [office, newer, older, yard, none];
      expect(await ids({ order: "area" })).toEqual(ordered);
      // Paged one at a time, the same order, each project once.
      const paged: string[] = [];
      let after: string | undefined;
      for (let page = 0; page < 6; page += 1) {
        const got = await listed(w, scout, { order: "area", limit: 1, ...(after === undefined ? {} : { after }) });
        paged.push(...got.projects.map((one) => one.id));
        after = got.next;
        if (after === undefined) break;
      }
      expect(paged).toEqual(ordered);
      // A cursor of one order is no cursor of the other.
      const cursor = (await listed(w, scout, { order: "area", limit: 1 })).next;
      expect(await w.work.listProjects(scout.token, { after: cursor, limit: 1 } as never)).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
      // The filter and the order together.
      expect(await ids({ order: "area", area: FIELD })).toEqual([newer, older]);

      // AR8: work is in its project's area; work under no project is in none.
      const inField = await task(w, scout, { project: older });
      const inOffice = await task(w, scout, { project: office });
      const loose = await task(w, scout);
      const onBoard = async (area?: string) => (await board(w, scout, area)).opportunities.map((one) => one.id).sort();
      expect(await onBoard()).toEqual([inField, inOffice, loose].sort());
      expect(await onBoard(FIELD)).toEqual([inField]);
      expect(await onBoard(OFFICE)).toEqual([inOffice]);
      expect(await onBoard("no-such")).toEqual([]);
      // No area is stored on work.
      expect(
        await w.admin(
          "select count(*)::int as n from information_schema.columns where table_schema = 'ledger' and table_name = 'opportunities' and column_name like 'area%'",
        ),
      ).toEqual([{ n: 0 }]);
      // The filter is the board's alone.
      expect(await w.work.listOpportunities(scout.token, { scope: "mine", area: FIELD })).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
    }, WORLD));
});
