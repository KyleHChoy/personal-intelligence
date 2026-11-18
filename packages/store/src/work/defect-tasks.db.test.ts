import { GAP_MISSING, type ImprovementView } from "@intelligence/contracts/personal";
import { DEFECT_UNTRIAGED_HOURS } from "@intelligence/personal-core/planner";
import { describe, expect, it } from "vitest";
import { setClientRoles, setDefaultTaskRole, setGapRoute, setPingSettings, setTaskTier } from "../admin/admin-tasks.ts";
import { ALL_TOOLS, request, testId } from "../test-support/clients.ts";
import { session, sqlState } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { AGENT_WORK_TOOLS } from "../test-support/work-clients.ts";
import { dispatching, gapTick, withAdmin, workAgent } from "../test-support/work-test-tasks.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";
import { createDispatch } from "./dispatch.ts";
import { setWebhook } from "./notices.ts";

// A defect raises a task, through the gap flags as pi_work, the tick's role, which holds no key:
// one task for a defect the system filed at each opening, under the defect's label and for its
// role, closed by code when the defect closes; one triage task for a defect an agent filed that
// stood open and untouched. Synthetic rows only; names and roles are examples.

const TOOLS = [...ALL_TOOLS, ...AGENT_WORK_TOOLS, "submit_improvement", "list_improvements", "update_improvement"];
const HOUR = 3_600_000;
const NIGHTLY = "Nightly tests red";

type Task = {
  id: string;
  trigger: string;
  subject: string;
  compartments: string[];
  role: string | null;
  event: string;
};
const tasksOf = (w: WorkWorld, defect: string): Promise<Task[]> =>
  w.admin<Task>(
    `select o.id, o.gap_trigger as trigger, o.gap_subject as subject, o.compartments, o.role,
       (select r.event from ledger.record_events r where r.row_kind = 'opportunity' and r.row_id = o.id order by r.id desc limit 1) as event
     from ledger.opportunities o where o.gap_source = $1 order by o.created_at, o.id`,
    [defect],
  );
const board = async (w: WorkWorld, token: string) =>
  ok(await w.work.listOpportunities(token, { scope: "board" })).opportunities;
const defectTasks = async (w: WorkWorld, token: string) =>
  (await board(w, token)).filter((one) => one.gap?.trigger === "defect" || one.gap?.trigger === "defect_untriaged");
// The tasks on a client's board that ask about one defect: the ask ends with the defect's id.
const asksAbout = async (w: WorkWorld, token: string, defect: string) =>
  (await defectTasks(w, token)).filter((one) => one.gap?.ask?.endsWith(` The defect: ${defect}.`) === true);
const states = async (w: WorkWorld, defect: string): Promise<[string, string][]> =>
  (await tasksOf(w, defect)).map((one) => [one.subject, one.event]);
// A registered agent that takes research tasks and is told of new ones.
async function agent(w: WorkWorld, name: string, compartments: string[]) {
  const client = await workAgent(w, name, compartments, { tools: TOOLS, kinds: ["research"] });
  await setWebhook(w.admin, name, "https://agent.example.org/hook", new Date());
  return client;
}
// The tick's gap step. Other defects of the filing pass raise tasks of their own here, so a test
// reads the tasks of the defect it follows, not a count of the pass.
const tick = (w: WorkWorld, now: Date): Promise<void> => dispatching(w, (dispatch) => gapTick(dispatch, now));
const EVERY = ["open", "triaged", "in_progress", "done", "wont_do", "duplicate"];
const list = async (w: WorkWorld, token: string): Promise<ImprovementView[]> =>
  ok(await w.work.listImprovements(token, { status: EVERY } as never)).improvements;
// The owner's setting of the role defects go to (`pia improvements default-role`); null unsets it.
const defectRole = async (w: WorkWorld, role: string | null): Promise<void> => {
  await w.admin("update policy.work_settings set defect_role = $1", [role]);
  await w.admin("select ledger.assign_defects($1)", [role]);
};
const DAY = 24 * HOUR;
const nightly = async (w: WorkWorld, token: string): Promise<ImprovementView> => {
  const found = (await list(w, token)).find((one) => one.title?.untrusted === NIGHTLY);
  if (found === undefined) throw new Error("not filed");
  return found;
};

describe("a defect the system filed raises a task", { timeout: DB_TEST_TIMEOUT }, () => {
  it("one task for its role under its label at each opening, none while one is open, and closed when it recovers", () =>
    withWorkWorld(
      async (w) => {
        const all = [...w.keys.compartments.keys()];
        await setTaskTier(w.admin, true, new Date());
        const wide = await agent(w, "wide", all);
        const narrow = await agent(w, "narrow", ["own"]);
        await setClientRoles(w.admin, "wide", ["builder"], new Date());
        await setDefaultTaskRole(w.admin, "builder", new Date());
        await defectRole(w, "builder");
        const now = new Date();
        const narrowBefore = JSON.stringify(await board(w, narrow.token));
        expect(await defectTasks(w, wide.token)).toEqual([]);

        await withAdmin(w, async (admin) => {
          await admin.box.recordNightly(3);
          await admin.box.fileImprovements();
          const filed = await nightly(w, wide.token);
          expect(filed.assigneeRole).toBe("builder");
          const [label] = await w.admin<{ compartments: string[] }>(
            "select compartments from ledger.improvements where id = $1",
            [filed.id],
          );

          // Filed: exactly one task, the defect's label and role, a go the notices follow.
          await tick(w, now);
          const first = await tasksOf(w, filed.id);
          expect(first).toEqual([
            {
              id: first[0]?.id,
              trigger: "defect",
              subject: `${filed.id}_0`,
              compartments: [...(label?.compartments ?? [])].sort(),
              role: "builder",
              event: "go",
            },
          ]);
          const onBoard = await asksAbout(w, wide.token, filed.id);
          expect(onBoard).toHaveLength(1);
          const [seen] = onBoard;
          expect(seen).toMatchObject({
            kind: "research",
            tier: "task",
            role: "builder",
            about: { kind: "owner" },
            basis: [],
            gap: { trigger: "defect", missing: GAP_MISSING.defect },
          });
          // Fixed words and the defect's id: nothing of its title or detail.
          expect(seen?.gap?.ask).not.toContain(NIGHTLY);
          // The task's go wrote the role's holder a notice of the kind every new task writes.
          const notices = await w.admin<{ client_id: string }>(
            "select client_id from ledger.work_notices where opportunity_id = $1 and event = 'task_go' order by client_id",
            [first[0]?.id],
          );
          expect(notices.map((one) => one.client_id)).toEqual([wide.id]);

          // A client not cleared for the defect's label sees no task, and its board is the same bytes.
          expect(await defectTasks(w, narrow.token)).toEqual([]);
          expect(JSON.stringify(await board(w, narrow.token))).toBe(narrowBefore);

          // A second pass, and a second filing pass with the measure still red, raise none.
          await admin.box.recordNightly(4);
          await admin.box.fileImprovements();
          await tick(w, now);
          expect(await states(w, filed.id)).toEqual([[`${filed.id}_0`, "go"]]);
          // An agent's triage or take leaves the defect open, and the task with it.
          ok(
            await w.work.updateImprovement(wide.token, {
              improvement: filed.id,
              status: "in_progress",
              fixRef: "pr:1",
              requestId: request(),
            } as never),
          );
          await tick(w, now);
          expect(await states(w, filed.id)).toEqual([[`${filed.id}_0`, "go"]]);

          // The measure recovers: the defect closes and code closes its task.
          await admin.box.recordNightly(0);
          await admin.box.fileImprovements();
          expect((await nightly(w, wide.token)).status).toBe("done");
          await tick(w, now);
          expect(await states(w, filed.id)).toEqual([[`${filed.id}_0`, "withdrawn"]]);
          expect(await asksAbout(w, wide.token, filed.id)).toEqual([]);
          await tick(w, now);
          expect(await states(w, filed.id)).toEqual([[`${filed.id}_0`, "withdrawn"]]);

          // It reopens: a new task, a gap of its own, whatever rest the first one's close left.
          await admin.box.recordNightly(2);
          await admin.box.fileImprovements();
          expect((await nightly(w, wide.token)).status).toBe("open");
          await tick(w, now);
          const second = await tasksOf(w, filed.id);
          expect(second.map((one) => [one.subject, one.event])).toEqual([
            [`${filed.id}_0`, "withdrawn"],
            [`${filed.id}_1`, "go"],
          ]);
          expect(await asksAbout(w, wide.token, filed.id)).toHaveLength(1);

          // A task that ended while its defect stands open is raised again, after a wait.
          const dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
          try {
            expect(await dispatch.closeGapFlag(second[1]?.id as string, now)).toBe(true);
          } finally {
            await dispatch.close();
          }
          const ended = [
            [`${filed.id}_0`, "withdrawn"],
            [`${filed.id}_1`, "withdrawn"],
          ];
          await tick(w, now);
          expect(await states(w, filed.id)).toEqual(ended);
          // Not within seven days of the first that ended; then one more, a gap of its own.
          await tick(w, new Date(now.getTime() + 6 * DAY));
          expect(await states(w, filed.id)).toEqual(ended);
          await tick(w, new Date(now.getTime() + 8 * DAY));
          expect(await states(w, filed.id)).toEqual([...ended, [`${filed.id}_2000001`, "go"]]);
          expect(await asksAbout(w, wide.token, filed.id)).toHaveLength(1);
          // That one ends too, reported done with the measure still failing: the next waits 14 days.
          const again = (await tasksOf(w, filed.id)).at(-1)?.id as string;
          const closer = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
          const secondEnd = new Date(now.getTime() + 9 * DAY);
          try {
            expect(await closer.closeGapFlag(again, secondEnd)).toBe(true);
          } finally {
            await closer.close();
          }
          await tick(w, new Date(secondEnd.getTime() + 13 * DAY));
          expect((await states(w, filed.id)).at(-1)).toEqual([`${filed.id}_2000001`, "withdrawn"]);
          await tick(w, new Date(secondEnd.getTime() + 15 * DAY));
          expect((await states(w, filed.id)).at(-1)).toEqual([`${filed.id}_2000002`, "go"]);

          // An agent says the change is the owner's to make: the defect raises no more tasks, and
          // the one open for it is withdrawn.
          ok(
            await w.work.updateImprovement(wide.token, {
              improvement: filed.id,
              status: "triaged",
              fixRef: "none:owners_to_change",
              requestId: request(),
            } as never),
          );
          await tick(w, new Date(secondEnd.getTime() + 15 * DAY));
          expect((await states(w, filed.id)).at(-1)).toEqual([`${filed.id}_2000002`, "withdrawn"]);
          await tick(w, new Date(secondEnd.getTime() + 60 * DAY));
          expect(await states(w, filed.id)).toHaveLength(4);

          // The owner's dismissal closes the defect, and a task open for it.
          await admin.box.recordNightly(0);
          await admin.box.fileImprovements();
          await admin.box.recordNightly(5);
          await admin.box.fileImprovements();
          await tick(w, now);
          expect((await states(w, filed.id)).at(-1)).toEqual([`${filed.id}_2`, "go"]);
          await admin.box.closeImprovement(filed.id, "wont_do", null);
          await tick(w, now);
          expect((await states(w, filed.id)).map((one) => one[1])).toEqual([
            "withdrawn",
            "withdrawn",
            "withdrawn",
            "withdrawn",
            "withdrawn",
          ]);
          // Hidden rows throughout: the narrow client's board never changed.
          expect(JSON.stringify(await board(w, narrow.token))).toBe(narrowBefore);
        });
      },
      ["own", "employer:example"],
    ));

  it("raises nothing while the owner has set no defect role or the task tier is off; unsetting withdraws; pi_work alone may scan", () =>
    withWorkWorld(
      async (w) => {
        const all = [...w.keys.compartments.keys()];
        const wide = await agent(w, "wide", all);
        await setClientRoles(w.admin, "wide", ["builder"], new Date());
        // The default task role is not the defect role: setting it assigns no defect.
        await setDefaultTaskRole(w.admin, "builder", new Date());
        const now = new Date();
        await withAdmin(w, async (admin) => {
          await admin.box.recordNightly(3);
          await admin.box.fileImprovements();
        });
        const filed = await nightly(w, wide.token);
        // A failing measure files its defect with no role, and it is nobody's.
        expect(filed).toMatchObject({ status: "open", assigneeRole: null });
        expect(ok(await w.work.listImprovements(wide.token, { mine: true } as never)).improvements).toEqual([]);
        await setTaskTier(w.admin, true, new Date());
        await tick(w, now);
        expect(await tasksOf(w, filed.id)).toEqual([]);
        // The owner sets the role: the defect takes it, and its task is raised.
        await defectRole(w, "builder");
        expect((await nightly(w, wide.token)).assigneeRole).toBe("builder");
        await tick(w, now);
        expect((await tasksOf(w, filed.id)).map((one) => [one.trigger, one.role, one.event])).toEqual([
          ["defect", "builder", "go"],
        ]);
        // Unset: the task is withdrawn by code, with no decision written, and the defect is nobody's.
        await defectRole(w, null);
        await tick(w, now);
        const [task] = await tasksOf(w, filed.id);
        expect(task?.event).toBe("withdrawn");
        expect(
          await w.admin("select 1 from ledger.opportunity_decisions where opportunity_id = $1 and decision = 'no_go'", [
            task?.id,
          ]),
        ).toEqual([]);
        expect((await nightly(w, wide.token)).assigneeRole).toBeNull();
        // The task tier off, a set role raises nothing either.
        await setTaskTier(w.admin, false, new Date());
        await defectRole(w, "builder");
        await tick(w, new Date(now.getTime() + 8 * DAY));
        expect(await tasksOf(w, filed.id)).toHaveLength(1);
        const scan = "select * from ledger.defect_gaps(now(), 48)";
        expect(await sqlState(() => queryAs(w.db.urls.work, scan))).toBeNull();
        for (const url of [w.db.urls.admin, w.db.urls.reader])
          expect(await sqlState(() => queryAs(url, scan))).toBe("42501");
      },
      ["own", "employer:example"],
    ));
});

describe("a defect an agent filed that nobody touched raises a triage task", { timeout: DB_TEST_TIMEOUT }, () => {
  it("once, after the hours, by what a viewer of the defect's label sees; closed when a status is set", () =>
    withWorkWorld(
      async (w) => {
        const all = [...w.keys.compartments.keys()];
        await setTaskTier(w.admin, true, new Date());
        await agent(w, "wide", all);
        await setClientRoles(w.admin, "wide", ["builder"], new Date());
        await defectRole(w, "builder");
        const narrow = await agent(w, "narrow", ["own"]);
        const elsewhere = await agent(w, "elsewhere", ["employer:example"]);
        const filed = ok(
          await w.work.submitImprovement(narrow.token, {
            kind: "bug",
            area: "mcp",
            severity: "low",
            title: "a slow tool",
            detail: "it is slow",
            requestId: request(),
          } as never),
        ).improvement;
        const elsewhereBefore = JSON.stringify(await board(w, elsewhere.token));
        const now = new Date();
        const later = new Date(now.getTime() + (DEFECT_UNTRIAGED_HOURS + 1) * HOUR);

        // Young: nothing.
        await tick(w, now);
        expect(await tasksOf(w, filed)).toEqual([]);
        await tick(w, later);
        const [label] = await w.admin<{ compartments: string[] }>(
          "select compartments from ledger.improvements where id = $1",
          [filed],
        );
        expect(await tasksOf(w, filed)).toMatchObject([
          {
            trigger: "defect_untriaged",
            subject: filed,
            compartments: [...(label?.compartments ?? [])].sort(),
            event: "go",
          },
        ]);
        const onBoard = await asksAbout(w, narrow.token, filed);
        expect(onBoard).toHaveLength(1);
        expect(onBoard[0]).toMatchObject({
          about: { kind: "owner" },
          basis: [],
          gap: { trigger: "defect_untriaged", missing: GAP_MISSING.defect_untriaged },
        });
        expect(onBoard[0]?.gap?.ask).not.toContain("slow");
        // A client not cleared for the defect's label: no task, and the same bytes.
        expect(JSON.stringify(await board(w, elsewhere.token))).toBe(elsewhereBefore);

        // One, and no second while it is open.
        await tick(w, later);
        expect(await states(w, filed)).toEqual([[filed, "go"]]);

        // A status within the label: the defect is no longer untouched, and code closes the task.
        ok(
          await w.work.updateImprovement(narrow.token, {
            improvement: filed,
            status: "triaged",
            requestId: request(),
          } as never),
        );
        await tick(w, later);
        expect(await states(w, filed)).toEqual([[filed, "withdrawn"]]);

        // Once: set open again and left for as long again, it raises no second task.
        ok(
          await w.work.updateImprovement(narrow.token, {
            improvement: filed,
            status: "open",
            requestId: request(),
          } as never),
        );
        const muchLater = new Date(later.getTime() + 30 * 24 * HOUR);
        await tick(w, muchLater);
        expect(await states(w, filed)).toEqual([[filed, "withdrawn"]]);

        // A defect an agent filed is never a `defect` task.
        const [none] = await w.admin<{ n: number }>(
          "select count(*)::int as n from ledger.opportunities where gap_trigger = 'defect' and gap_source = $1",
          [filed],
        );
        expect(none?.n).toBe(0);
      },
      ["own", "employer:example"],
    ));

  it("a status set by an agent cleared for more is written under the defect's label, so no triage task is raised", () =>
    withWorkWorld(
      async (w) => {
        const all = [...w.keys.compartments.keys()];
        await setTaskTier(w.admin, true, new Date());
        const wide = await agent(w, "wide", all);
        const narrow = await agent(w, "narrow", ["own"]);
        await setClientRoles(w.admin, "wide", ["builder"], new Date());
        await defectRole(w, "builder");
        const submit = async (title: string) =>
          ok(
            await w.work.submitImprovement(narrow.token, {
              kind: "bug",
              area: "mcp",
              severity: "low",
              title,
              detail: "it is slow",
              requestId: request(),
            } as never),
          ).improvement;
        const [triaged, untouched] = [await submit("a slow tool"), await submit("a slower tool")];
        const later = new Date(Date.now() + (DEFECT_UNTRIAGED_HOURS + 1) * HOUR);

        // Triaged by the wider client, with a note of its own.
        ok(
          await w.work.updateImprovement(wide.token, {
            improvement: triaged,
            status: "triaged",
            note: "looked at under a wider clearance",
            requestId: request(),
          } as never),
        );
        const events = await w.admin<{ compartments: string[]; note_enc: unknown; client_id: string }>(
          "select compartments, note_enc, client_id from ledger.improvement_events where improvement_id = $1 and event = 'status'",
          [triaged],
        );
        // The defect's label, which its writer is cleared for; the note is sealed under that label too.
        expect(events).toEqual([{ compartments: ["own"], note_enc: expect.anything(), client_id: wide.id }]);
        // Every reader of the defect is served the status, and its history opens for each.
        for (const client of [narrow, wide]) {
          const served = ok(await w.work.listImprovements(client.token, { improvement: triaged } as never));
          expect(served.improvements[0]).toMatchObject({ id: triaged, status: "triaged" });
          expect(served.improvements[0]?.events?.at(-1)).toMatchObject({
            event: "status",
            status: "triaged",
            by: "wide",
            note: { untrusted: "looked at under a wider clearance" },
          });
        }
        // A duplicate must lie within the event's label: a defect only the wider client sees is
        // answered as one that is not there, and nothing is written, so no reader of the defect
        // is served an id it cannot see.
        const hidden = ok(
          await w.work.submitImprovement(wide.token, {
            kind: "bug",
            area: "mcp",
            severity: "low",
            title: "a tool only the wide client sees",
            detail: "under every compartment",
            requestId: request(),
          } as never),
        ).improvement;
        expect(
          await w.work.updateImprovement(wide.token, {
            improvement: triaged,
            status: "duplicate",
            duplicateOf: hidden,
            requestId: request(),
          } as never),
        ).toMatchObject({ ok: false, code: "not_found" });
        expect(
          await w.admin(
            "select 1 from ledger.improvement_events where improvement_id = $1 and duplicate_of is not null",
            [triaged],
          ),
        ).toEqual([]);
        // Control: a duplicate within the label is written, and the narrow reader is served it.
        const [copy, first] = [await submit("a copy"), await submit("the first report")];
        ok(
          await w.work.updateImprovement(wide.token, {
            improvement: copy,
            status: "duplicate",
            duplicateOf: first,
            requestId: request(),
          } as never),
        );
        expect(
          ok(await w.work.listImprovements(narrow.token, { improvement: copy } as never)).improvements[0],
        ).toMatchObject({ status: "duplicate", duplicateOf: first });
        // One more report under a wider clearance leaves the severity; one under the defect's label raises it.
        const report = (token: string, severity: string) =>
          w.work.submitImprovement(token, {
            kind: "bug",
            area: "mcp",
            severity,
            title: "a slower tool",
            detail: "again",
            requestId: request(),
          } as never);
        const severity = async () =>
          (
            await w.admin<{ severity: string }>("select severity from ledger.improvements where id = $1", [untouched])
          )[0]?.severity;
        expect(ok(await report(wide.token, "critical"))).toMatchObject({ improvement: untouched, merged: true });
        expect(await severity()).toBe("low");
        // A note under the defect's own label is kept, as before.
        ok(
          await w.work.updateImprovement(narrow.token, {
            improvement: triaged,
            status: "in_progress",
            note: "taking it",
            requestId: request(),
          } as never),
        );
        const mine = ok(await w.work.listImprovements(narrow.token, { improvement: triaged } as never));
        expect(mine.improvements[0]?.events?.at(-1)?.note).toEqual({ untrusted: "taking it" });

        // After the hours: a task for the defect nobody touched, none for the one triaged.
        await tick(w, later);
        expect(await states(w, untouched)).toEqual([[untouched, "go"]]);
        expect(await tasksOf(w, triaged)).toEqual([]);
      },
      ["own", "employer:example"],
    ));
});

describe("many defects for one role", { timeout: DB_TEST_TIMEOUT }, () => {
  it("at most five tasks stand open for a role under one label, the most severe and the oldest first", () =>
    withWorkWorld(
      async (w) => {
        const all = [...w.keys.compartments.keys()].sort();
        await setTaskTier(w.admin, true, new Date());
        await agent(w, "wide", all);
        await setClientRoles(w.admin, "wide", ["builder"], new Date());
        // Eight defects of the system's under one label: three high, five medium, in that order of filing.
        const ids: string[] = [];
        for (let n = 0; n < 8; n += 1) {
          const id = testId("imp");
          ids.push(id);
          await w.admin(
            "select ledger.file_improvement($1, $2, $3, $4, 'value=1', 'bug', 'other', $5, $6, $7, '{}', '{}', '{}', now())",
            [
              id,
              testId("ime"),
              testId("req"),
              `measure_floor:m${n}`,
              n % 3 === 0 ? "high" : "medium",
              all,
              String(n).repeat(64),
            ],
          );
        }
        const now = new Date();
        const open = async (): Promise<string[]> =>
          (
            await w.admin<{ source: string }>(
              `select o.gap_source as source from ledger.opportunities o
               where o.gap_trigger = 'defect'
                 and (select r.event from ledger.record_events r where r.row_kind = 'opportunity' and r.row_id = o.id order by r.id desc limit 1) = 'go'
               order by o.gap_source`,
              [],
            )
          ).map((row) => row.source);
        await defectRole(w, "builder");
        await tick(w, now);
        // The three high ones, then the two oldest medium ones.
        const first = [ids[0], ids[3], ids[6], ids[1], ids[2]].sort() as string[];
        expect(await open()).toEqual(first);
        // A second tick raises no sixth.
        await tick(w, now);
        expect(await open()).toEqual(first);
        // One closes: its task is withdrawn and the next in line takes its place.
        await w.admin("select ledger.close_improvement_cause('measure_floor:m0', $1, $2, '{}')", [
          testId("ime"),
          testId("req"),
        ]);
        await tick(w, now);
        await tick(w, now);
        expect(await open()).toEqual([ids[3], ids[6], ids[1], ids[2], ids[4]].sort());
      },
      ["own", "employer:example"],
    ));
});

// A system defect's task asks for a fix (in_progress takes pr:, commit: or lever:) from the role the
// owner gave defects to, so it is only ever work for the defect's role: never the default task role,
// a gap route, or any agent a ping falls back to.
describe("a system defect's task is work only for the defect's role", { timeout: DB_TEST_TIMEOUT }, () => {
  // One defect of the system's under a label, as the filing pass writes it.
  const fileDefect = async (w: WorkWorld, label: string[]): Promise<string> => {
    const id = testId("imp");
    await w.admin(
      "select ledger.file_improvement($1, $2, $3, 'measure_floor:m_example', 'value=1', 'bug', 'other', 'medium', $4, $5, '{}', '{}', '{}', now())",
      [id, testId("ime"), testId("req"), label, "a".repeat(64)],
    );
    return id;
  };
  const claimable = async (w: WorkWorld, token: string, id: string): Promise<boolean> =>
    (await w.work.claimOpportunity(token, { id: id as never, requestId: request() })).ok;

  it("a task its role has not taken never falls back to the ping order's other agents", () =>
    withWorkWorld(
      async (w) => {
        const all = [...w.keys.compartments.keys()].sort();
        await setTaskTier(w.admin, true, new Date());
        const builder = await agent(w, "builder", all);
        const chief = await agent(w, "chief", all);
        await setClientRoles(w.admin, "builder", ["builder"], new Date());
        await setClientRoles(w.admin, "chief", ["chief"], new Date());
        await defectRole(w, "builder");
        await setPingSettings(w.admin, { order: ["role:chief"] }, new Date());
        const defect = await fileDefect(w, all);
        await tick(w, new Date());
        const [task] = await tasksOf(w, defect);
        expect(task).toMatchObject({ role: "builder", event: "go" });
        const id = task?.id as string;

        // A day and more unclaimed: the walk ends where it is, and the route stays the defect's.
        await session(w.db.urls.bootstrap, async (query) => {
          await query("set role pi_owner");
          await query("update ledger.ping_walks set told_at = now() - interval '30 hours' where opportunity_id = $1", [
            id,
          ]);
        });
        const fell = await queryAs<{ n: number }>(w.db.urls.work, "select ledger.fall_back_pings(now()) as n");
        expect(fell[0]?.n).toBe(0);
        expect(await w.admin("select 1 from ledger.ping_walks where opportunity_id = $1", [id])).toEqual([]);
        expect(
          await w.admin(
            "select 1 from ledger.record_events where row_kind = 'opportunity' and row_id = $1 and event = 'routed'",
            [id],
          ),
        ).toEqual([]);
        expect(await claimable(w, chief.token, id)).toBe(false);
        expect(await claimable(w, builder.token, id)).toBe(true);
      },
      ["own", "employer:example"],
    ));

  it("no task while no holder of the defect role is cleared for the defect, whatever the default task role", () =>
    withWorkWorld(
      async (w) => {
        const all = [...w.keys.compartments.keys()].sort();
        await setTaskTier(w.admin, true, new Date());
        await agent(w, "builder", ["own"]);
        await agent(w, "chief", all);
        await setClientRoles(w.admin, "builder", ["builder"], new Date());
        await setClientRoles(w.admin, "chief", ["chief"], new Date());
        await setDefaultTaskRole(w.admin, "chief", new Date());
        await defectRole(w, "builder");
        const defect = await fileDefect(w, all);
        const [row] = await w.admin<{ role: string | null }>(
          "select assignee_role as role from ledger.improvements where id = $1",
          [defect],
        );
        expect(row?.role).toBeNull();
        await tick(w, new Date());
        expect(await tasksOf(w, defect)).toEqual([]);
      },
      ["own", "employer:example"],
    ));

  it("takes the defect's role over a gap route, and no route can be set for a system defect", () =>
    withWorkWorld(
      async (w) => {
        const all = [...w.keys.compartments.keys()].sort();
        await setTaskTier(w.admin, true, new Date());
        await agent(w, "builder", all);
        await agent(w, "chief", all);
        await setClientRoles(w.admin, "builder", ["builder"], new Date());
        await setClientRoles(w.admin, "chief", ["chief"], new Date());
        await defectRole(w, "builder");
        await expect(setGapRoute(w.admin, "defect", "chief", new Date())).rejects.toThrow("invalid_argument");
        // A route stored before routes for system defects were refused.
        await setGapRoute(w.admin, "card_question", "chief", new Date());
        await w.admin("update policy.gap_routes set trigger = 'defect' where trigger = 'card_question'");
        const defect = await fileDefect(w, all);
        await tick(w, new Date());
        expect((await tasksOf(w, defect)).map((one) => [one.role, one.event])).toEqual([["builder", "go"]]);
        // The stored route may still be removed.
        await setGapRoute(w.admin, "defect", null, new Date());
        expect(await w.admin("select 1 from policy.gap_routes where trigger = 'defect'")).toEqual([]);
      },
      ["own", "employer:example"],
    ));
});
