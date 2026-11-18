import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ImprovementView } from "@intelligence/contracts/personal";
import { repoRoot } from "@intelligence/personal-core";
import { describe, expect, it } from "vitest";
import { createAdmin } from "../admin/admin.ts";
import { setClientRoles, setDefaultTaskRole } from "../admin/admin-tasks.ts";
import { raiseHealth } from "../core/box-health.ts";
import { request, testId } from "../test-support/clients.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { ownerUpdate, withAdmin } from "../test-support/work-test-tasks.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";

// The improvement store as a queue an agent can work: a defect has a role; an agent takes one by
// naming its fix; a defect the system filed closes only when its measure recovers or the owner
// dismisses it; an open box health card is a cause. Synthetic rows only; names and roles are
// examples.

const TOOLS = ["submit_improvement", "list_improvements", "update_improvement"];
const NIGHTLY = "Nightly tests red";
// The newest migration file's number, which get_health serves as the box's.
const NEWEST = readdirSync(join(repoRoot(), "db/personal/migrations")).sort().at(-1)?.slice(0, 4);

// Every status, as these tests follow a defect through its close: the tool's own default is the
// open ones (its paging test below).
const EVERY = ["open", "triaged", "in_progress", "done", "wont_do", "duplicate"];
const list = async (w: WorkWorld, token: string, args: Record<string, unknown> = {}): Promise<ImprovementView[]> =>
  ok(await w.work.listImprovements(token, { status: EVERY, ...args } as never)).improvements;
// The owner's setting of the role defects go to (`pia improvements default-role`).
const defectRole = async (w: WorkWorld, role: string | null): Promise<void> => {
  await w.admin("update policy.work_settings set defect_role = $1", [role]);
  await w.admin("select ledger.assign_defects($1)", [role]);
};
const causeOf = (w: WorkWorld, improvement: string, cause: string): Promise<void> =>
  ownerUpdate(w, "ledger.improvements", "cause = $2", "id = $1", [improvement, cause]);
const nightly = async (w: WorkWorld, token: string): Promise<ImprovementView | undefined> =>
  (await list(w, token)).find((one) => one.title?.untrusted === NIGHTLY);
const update = (w: WorkWorld, token: string, improvement: string, status: string, args: Record<string, unknown> = {}) =>
  w.work.updateImprovement(token, { improvement, status, requestId: request(), ...args } as never);

describe("the health read", { timeout: DB_TEST_TIMEOUT }, () => {
  const HEALTH = [...TOOLS, "get_health"];
  const health = async (w: WorkWorld, token: string) => ok(await w.work.getHealth(token, {} as never));

  it("serves ids, counts, codes and times within the caller's label, and nothing changes for a client outside it", () =>
    withWorkWorld(
      async (w) => {
        const all = [...w.keys.compartments.keys()];
        const wide = await w.client("wide", all, { tools: HEALTH });
        const narrow = await w.client("narrow", ["own"], { tools: HEALTH });
        const mute = await w.client("mute", all, { tools: TOOLS });
        expect(await w.work.getHealth(mute.token, {} as never)).toMatchObject({ ok: false, code: "not_permitted" });

        // A card in the owner's own compartment is the narrow client's to see.
        const card = await raiseHealth(w.admin, new Date(), recordingLogger().log, "hold", "sync_hold");
        const before = await health(w, narrow.token);
        expect(before).toMatchObject({ measures: [], checks: [], jobs: [], defects: [] });
        expect(before.cards).toMatchObject([{ card, kind: "hold", about: "sync_hold" }]);
        expect(await health(w, wide.token)).toMatchObject({ measures: [], checks: [], jobs: [] });

        // Readings, a defect, job runs and a check result, all under the measures' wider label.
        await withAdmin(w, async (admin) => {
          await admin.box.recordNightly(3);
          await admin.box.fileImprovements();
        });
        await w.admin(
          `insert into ledger.job_runs (job, started_at, ended_at, code, about)
           values ('extract', now() - interval '3 minutes', now() - interval '2 minutes', 'failed', null),
                  ('extract', now() - interval '2 minutes', now() - interval '1 minute', 'failed', null),
                  ('extract', now() - interval '1 minute', now(), 'failed', null),
                  ('canary', now() - interval '1 minute', now(), 'no_claim', 'mail')`,
          [],
        );
        const after = await health(w, narrow.token);
        // The card's own defect is in the narrow client's label; nothing else of the pass is.
        expect({ ...after, defects: [] }).toEqual({ ...before, defects: [] });
        expect(after.defects).toEqual([{ role: null, severity: "high", open: 1 }]);

        const seen = await health(w, wide.token);
        expect(seen.measures.length).toBeGreaterThan(5);
        // A measure's parts are served with it, codes and counts, and the box to a caller served a
        // reading: the database's switches and its newest migration.
        expect(seen.measures.find((one) => one.metric === "backup_age_days")?.parts).toBeUndefined();
        expect(seen.measures.find((one) => one.metric === "code_no_go_per_day")?.parts).toMatchObject({ cases: 0 });
        expect(seen.box).toMatchObject({ holds: [], commit: "unknown", migration: NEWEST });
        expect(seen.box?.switches.map((one) => one.key)).toEqual(["identity_agents", "identity_merges", "planner"]);
        expect(seen.box?.switches).toContainEqual({ key: "identity_agents", value: "off" });
        // A caller served no reading is told nothing of the box.
        expect(after.box).toBeUndefined();
        expect(seen.measures.find((one) => one.metric === "nightly_red")).toMatchObject({
          state: "failing",
          value: 3,
          healthy: null,
          stale: false,
        });
        expect(seen.measures.every((one) => one.metric === "nightly_red" || one.healthy !== null)).toBe(true);
        expect(seen.checks).toMatchObject([{ source: "mail", code: "no_claim" }]);
        expect(seen.jobs.find((one) => one.job === "extract")).toMatchObject({ code: "failed", failing: true });
        expect(seen.defects.reduce((sum, one) => sum + one.open, 0)).toBeGreaterThanOrEqual(2);

        // A later reading under a label the narrow-er client cannot see changes nothing it is served.
        const middle = await w.client("middle", [...all].sort(), { tools: HEALTH });
        const served = await health(w, middle.token);
        await w.admin(
          "insert into ledger.measure_readings (metric, value, sample, state, compartments) values ('a_hidden_measure', 1, 1, 'ok', '{restricted:example}')",
          [],
        );
        expect(await health(w, middle.token)).toEqual(served);

        // Every string served is an id, a code or a time.
        const strings: string[] = [];
        JSON.stringify(seen, (_key, value) => {
          if (typeof value === "string") strings.push(value);
          return value;
        });
        for (const one of strings)
          expect(one, one).toMatch(/^([a-z0-9_:.-]+|crd_[0-9A-Z]{26}|\d{4}-\d{2}-\d{2}T[0-9:.]+Z)$/);

        // A reading 49 hours old is stale.
        await w.admin(
          "insert into ledger.measure_readings (metric, value, sample, state, read_at, compartments) values ('an_old_measure', 1, 1, 'ok', now() - interval '49 hours', $1)",
          [[...all].sort()],
        );
        const aged = (await health(w, wide.token)).measures;
        expect(aged.filter((one) => one.stale).map((one) => one.metric)).toEqual(["an_old_measure"]);
      },
      ["own", "employer:example"],
    ));
});

describe("a measure with no data left", { timeout: DB_TEST_TIMEOUT }, () => {
  it("closes its defect as no data after two such readings, and a dump closes the backup's card", () =>
    withWorkWorld(
      async (w) => {
        const all = [...w.keys.compartments.keys()];
        const reader = await w.client("reader", all, { tools: TOOLS });
        const HOUR = 3_600_000;
        const start = new Date();
        let clock = start;
        const admin = createAdmin({
          url: w.db.urls.admin,
          keys: w.db.keys as never,
          log: recordingLogger().log,
          now: () => clock,
        });
        try {
          // A measure failing on two passes files its defect: the last dump is 20 days old.
          await w.admin(
            "insert into ledger.job_runs (job, started_at, ended_at, code) values ('backup', now() - interval '20 days', now() - interval '20 days', 'ok')",
            [],
          );
          await admin.box.fileImprovements();
          clock = new Date(start.getTime() + 13 * HOUR);
          await admin.box.fileImprovements();
          const cause = "measure_floor:backup_age_days";
          const filed = (await list(w, reader.token)).find((one) => one.cause === cause);
          expect(filed).toMatchObject({ status: "open" });
          expect(filed?.title?.untrusted).toBe("Measure above its healthy line");
          expect(filed?.causeState).toMatch(/^value=20(\.\d+)? sample=1 line=at_most_8 side=above$/);
          expect(filed?.detail?.untrusted).toContain("get_health");

          // The measure loses its data (no dump on record): one such pass closes nothing.
          // No role may delete a run, so the table's owner does, its row security lifted for the statement.
          await w.claims("alter table ledger.job_runs no force row level security", []);
          await w.claims("delete from ledger.job_runs where job = 'backup'", []);
          await w.claims("alter table ledger.job_runs force row level security", []);
          clock = new Date(start.getTime() + 26 * HOUR);
          expect((await admin.box.fileImprovements()).emptied).toBe(0);
          expect((await list(w, reader.token)).find((one) => one.cause === cause)?.status).toBe("open");
          // The second closes it as no data, which its state and its note say: not as recovered.
          clock = new Date(start.getTime() + 39 * HOUR);
          expect((await admin.box.fileImprovements()).emptied).toBe(1);
          const [closed] = await list(w, reader.token, { improvement: filed?.id });
          expect(closed).toMatchObject({ status: "done", causeState: "closed=no_data" });
          expect(closed?.events?.at(-1)?.note?.untrusted).toContain("no data");
        } finally {
          await admin.close();
        }
      },
      ["own", "employer:example"],
    ));
});

describe("the improvement store as a queue", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a defect the system filed is taken with a fix and closes by its measure or the owner alone", () =>
    withWorkWorld(
      async (w) => {
        const all = [...w.keys.compartments.keys()];
        const fixer = await w.client("fixer", all, { tools: TOOLS });
        const other = await w.client("other", all, { tools: TOOLS });
        await withAdmin(w, async (admin) => {
          await admin.box.recordNightly(3);
          await admin.box.fileImprovements();
          const filed = await nightly(w, fixer.token);
          if (filed === undefined) throw new Error("not filed");
          expect(filed).toMatchObject({ cause: "nightly_red", causeState: "red=3", heldBy: null, fixRef: null });

          // Taken only with the fix named.
          expect(await update(w, fixer.token, filed.id, "in_progress")).toEqual({
            ok: false,
            code: "not_found",
            refusal: "needs_fix_ref",
          });
          expect(await update(w, fixer.token, filed.id, "in_progress", { fixRef: "not a ref" })).toMatchObject({
            ok: false,
            code: "invalid_request",
          });
          ok(await update(w, fixer.token, filed.id, "triaged"));
          ok(await update(w, fixer.token, filed.id, "in_progress", { fixRef: "pr:926" }));
          expect(await nightly(w, other.token)).toMatchObject({
            status: "in_progress",
            heldBy: "fixer",
            fixRef: "pr:926",
          });
          // A statement, not a lock: a second agent may take it too, and the latest is shown.
          ok(await update(w, other.token, filed.id, "in_progress", { fixRef: "commit:0123abc" }));
          expect(await nightly(w, fixer.token)).toMatchObject({ heldBy: "other", fixRef: "commit:0123abc" });

          // No agent closes or dismisses it.
          for (const status of ["done", "wont_do"])
            expect(await update(w, fixer.token, filed.id, status)).toEqual({
              ok: false,
              code: "not_found",
              refusal: "closes_by_measure",
            });
          expect((await nightly(w, fixer.token))?.status).toBe("in_progress");

          // Its measure closes it, and a later red night reopens it with nobody holding it.
          await admin.box.recordNightly(0);
          await admin.box.fileImprovements();
          expect((await nightly(w, fixer.token))?.status).toBe("done");
          await admin.box.recordNightly(2);
          await admin.box.fileImprovements();
          expect(await nightly(w, fixer.token)).toMatchObject({ status: "open", heldBy: null });

          // A defect an agent closed before this rule reopens at the next pass that finds it failing.
          await w.claims(
            `insert into ledger.improvement_events (id, improvement_id, request_id, created_by, client_id, session_id, compartments, event, status)
             select $1, e.improvement_id, $2, e.created_by, e.client_id, e.session_id, e.compartments, 'status', 'wont_do'
             from ledger.improvement_events e where e.improvement_id = $3 and e.client_id is not null limit 1`,
            [testId("ime"), request(), filed.id],
          );
          expect((await nightly(w, fixer.token))?.status).toBe("wont_do");
          await admin.box.recordNightly(4);
          expect((await admin.box.fileImprovements()).reopened).toBeGreaterThanOrEqual(1);
          expect((await nightly(w, fixer.token))?.status).toBe("open");

          // The owner's dismissal stands, and stops the cause being filed again.
          await admin.box.closeImprovement(filed.id, "wont_do", null);
          expect((await nightly(w, fixer.token))?.status).toBe("wont_do");
          const [whole] = await list(w, fixer.token, { improvement: filed.id });
          expect(whole?.events?.at(-1)).toMatchObject({ by: "owner", status: "wont_do" });
          await admin.box.recordNightly(5);
          expect((await admin.box.fileImprovements()).vetoed).toBeGreaterThanOrEqual(1);
          expect((await nightly(w, fixer.token))?.status).toBe("wont_do");
        });
      },
      ["own", "employer:example"],
    ));

  it("a defect an agent filed is closed by an agent, as before", () =>
    withWorkWorld(async (w) => {
      const scout = await w.client("scout", ["own"], { tools: TOOLS });
      const filed = ok(
        await w.work.submitImprovement(scout.token, {
          kind: "bug",
          area: "mcp",
          severity: "low",
          title: "a slow tool",
          detail: "it is slow",
          requestId: request(),
        } as never),
      );
      ok(await update(w, scout.token, filed.improvement, "in_progress"));
      ok(await update(w, scout.token, filed.improvement, "done"));
      const [seen] = await list(w, scout.token);
      expect(seen).toMatchObject({ status: "done", cause: null, causeState: null, heldBy: null });
    }));

  it("a defect is taken with what the caller can show: a lever it moved, a claim, or a look with no fix", () =>
    withWorkWorld(
      async (w) => {
        const all = [...w.keys.compartments.keys()];
        const fixer = await w.client("fixer", all, { tools: [...TOOLS, "set_lever"] });
        const other = await w.client("other", all, { tools: TOOLS });
        await withAdmin(w, async (admin) => {
          await admin.box.recordNightly(3);
          await admin.box.fileImprovements();
        });
        const filed = await nightly(w, fixer.token);
        if (filed === undefined) throw new Error("not filed");
        const refusedRef = { ok: false, code: "not_found", refusal: "fix_ref_refused" };

        // A lever nobody moved, and one another agent moved, are not the caller's change.
        expect(
          await update(w, fixer.token, filed.id, "in_progress", { fixRef: "lever:lessons.digest_weekly" }),
        ).toEqual(refusedRef);
        ok(
          await w.work.setLever(fixer.token, {
            key: "lessons.digest_weekly",
            value: 3,
            reason: "tune",
            requestId: request(),
          } as never),
        );
        expect(
          await update(w, other.token, filed.id, "in_progress", { fixRef: "lever:lessons.digest_weekly" }),
        ).toEqual(refusedRef);
        // Nor is the caller's own change to a lever that judges another measure: this defect is the
        // nightly run's, and the lever is judged by the owner's questions a week.
        expect(
          await update(w, fixer.token, filed.id, "in_progress", { fixRef: "lever:lessons.digest_weekly" }),
        ).toEqual(refusedRef);
        await causeOf(w, filed.id, "measure_floor:owner_questions_per_week");
        // Nor a change made before the defect opened.
        await ownerUpdate(w, "policy.setting_changes", "at = at - interval '2 days'", "key = $1", [
          "lessons.digest_weekly",
        ]);
        expect(
          await update(w, fixer.token, filed.id, "in_progress", { fixRef: "lever:lessons.digest_weekly" }),
        ).toEqual(refusedRef);
        await ownerUpdate(w, "policy.setting_changes", "at = now()", "key = $1", ["lessons.digest_weekly"]);
        // Even the agent that moved it, since the defect opened, is not credited: no rule reads this
        // lever since the owner's ruling removed the weekly lesson limit, so moving it fixes nothing.
        expect(
          await update(w, fixer.token, filed.id, "in_progress", { fixRef: "lever:lessons.digest_weekly" }),
        ).toEqual(refusedRef);

        // No operation code is open; a `none:` claims no fix, so it never takes a defect.
        expect(await update(w, fixer.token, filed.id, "in_progress", { fixRef: "ops:retry_extract" })).toEqual(
          refusedRef,
        );
        expect(await update(w, fixer.token, filed.id, "in_progress", { fixRef: "none:owners_to_change" })).toEqual(
          refusedRef,
        );
        expect(await update(w, fixer.token, filed.id, "triaged", { fixRef: "none:made_up" })).toMatchObject({
          ok: false,
          code: "invalid_request",
        });
        // Looked at, and the change is the owner's: listed for the owner in one place.
        ok(await update(w, other.token, filed.id, "triaged", { fixRef: "none:owners_to_change" }));
        expect(await nightly(w, fixer.token)).toMatchObject({ status: "triaged", fixRef: "none:owners_to_change" });
        await withAdmin(w, async (admin) => {
          const view = await admin.box.improvements();
          expect(view.ownersToChange).toBe(1);
          expect(view.defects.filter((one) => one.ownersToChange).map((one) => one.improvement)).toEqual([filed.id]);
        });
      },
      ["own", "employer:example"],
    ));

  it("the list serves what stands open unless told otherwise, and pages", () =>
    withWorkWorld(async (w) => {
      const scout = await w.client("scout", ["own"], { tools: TOOLS });
      const ids: string[] = [];
      for (const [title, severity] of [
        ["one", "low"],
        ["two", "high"],
        ["three", "medium"],
        ["four", "medium"],
        ["five", "critical"],
      ] as const)
        ids.push(
          ok(
            await w.work.submitImprovement(scout.token, {
              kind: "bug",
              area: "mcp",
              severity,
              title,
              detail: "detail",
              requestId: request(),
            } as never),
          ).improvement,
        );
      ok(await update(w, scout.token, ids[0] as string, "done"));
      const page = async (args: Record<string, unknown>) =>
        ok(await w.work.listImprovements(scout.token, args as never));
      // Left out, the status is the three open ones: the closed defect is not served.
      const open = await page({});
      expect(open.improvements.map((one) => one.id).sort()).toEqual(ids.slice(1).sort());
      expect(open.more).toBe(false);
      expect(open.next).toBeUndefined();
      // One by its id is served whatever its status.
      expect((await page({ improvement: ids[0] })).improvements.map((one) => one.status)).toEqual(["done"]);

      // Pages of two, in the list's order: critical, high, then the mediums, the latest first.
      const first = await page({ limit: 2 });
      expect(first.improvements.map((one) => one.id)).toEqual([ids[4], ids[1]]);
      expect(first.more).toBe(true);
      const second = await page({ limit: 2, after: first.next });
      expect(second.improvements.map((one) => one.id)).toEqual([ids[3], ids[2]]);
      expect(second.more).toBe(false);
      // Every status, across pages: each defect once.
      const seen: string[] = [];
      let after: string | undefined;
      for (let turn = 0; turn < 5; turn += 1) {
        const got = await page({ status: EVERY, limit: 2, ...(after === undefined ? {} : { after }) });
        seen.push(...got.improvements.map((one) => one.id));
        after = got.next;
        if (!got.more) break;
      }
      expect([...seen].sort()).toEqual([...ids].sort());
      // A word that is no place is refused.
      expect(await w.work.listImprovements(scout.token, { after: "bm90LWEtcGxhY2U" } as never)).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
    }));

  it("a defect takes the role the owner set for defects when a holder is cleared for it, and none while none is set", () =>
    withWorkWorld(
      async (w) => {
        const all = [...w.keys.compartments.keys()];
        const wide = await w.client("wide", all, { tools: TOOLS });
        const narrow = await w.client("narrow", ["own"], { tools: TOOLS });
        const submit = (token: string, title: string) =>
          w.work.submitImprovement(token, {
            kind: "bug",
            area: "mcp",
            severity: "low",
            title,
            detail: "detail",
            requestId: request(),
          } as never);

        // No defect role, whatever the default task role: no defect has a role, and none is anyone's.
        await setClientRoles(w.admin, "narrow", ["builder"], new Date());
        await setDefaultTaskRole(w.admin, "builder", new Date());
        const early = ok(await submit(narrow.token, "before a role"));
        expect((await list(w, narrow.token))[0]?.assigneeRole).toBeNull();
        expect(await list(w, narrow.token, { mine: true })).toEqual([]);
        // A role no active agent holds is refused, and nothing changes.
        await withAdmin(w, async (admin) => {
          await expect(admin.box.setDefectRole("nobody")).rejects.toMatchObject({ code: "unknown_role" });
          await admin.box.setDefectRole("builder");
        });
        // Set: the defect filed before takes it, as a new one does.
        expect((await list(w, narrow.token)).find((one) => one.id === early.improvement)?.assigneeRole).toBe("builder");
        const own = ok(await submit(narrow.token, "under own"));
        // The only holder is not cleared for the wider label, so that defect has no role.
        const wider = ok(await submit(wide.token, "under every compartment"));
        const seen = await list(w, wide.token);
        expect(seen.find((one) => one.id === own.improvement)?.assigneeRole).toBe("builder");
        expect(seen.find((one) => one.id === wider.improvement)?.assigneeRole).toBeNull();

        const both = [own.improvement, early.improvement].sort();
        expect((await list(w, narrow.token, { mine: true })).map((one) => one.id).sort()).toEqual(both);
        expect(await list(w, wide.token, { mine: true })).toEqual([]);

        // The owner changes a defect's role; no tool argument does.
        await withAdmin(w, async (admin) => {
          await admin.box.setImprovementRole(own.improvement, null);
          expect((await list(w, narrow.token, { mine: true })).map((one) => one.id)).toEqual([early.improvement]);
          await admin.box.setImprovementRole(own.improvement, "builder");
        });
        expect((await list(w, narrow.token, { mine: true })).map((one) => one.id).sort()).toEqual(both);
        // Unset: no defect is anyone's, but the one the owner gave a role by hand.
        await defectRole(w, null);
        expect((await list(w, narrow.token, { mine: true })).map((one) => one.id)).toEqual([own.improvement]);
        expect((await list(w, narrow.token)).find((one) => one.id === early.improvement)?.assigneeRole).toBeNull();
        expect(
          await w.work.updateImprovement(narrow.token, {
            improvement: own.improvement,
            status: "triaged",
            requestId: request(),
            assigneeRole: "other",
          } as never),
        ).toMatchObject({ ok: false });
      },
      ["own", "employer:example"],
    ));

  it("an open box health card files one cause under the card's label, and it recovers when the card closes", () =>
    withWorkWorld(
      async (w) => {
        const own = await w.client("own-only", ["own"], { tools: TOOLS });
        const elsewhere = await w.client("elsewhere", ["employer:example"], { tools: TOOLS });
        const card = await raiseHealth(w.admin, new Date(), recordingLogger().log, "hold", "sync_hold");
        if (card === null) throw new Error("no card");
        await withAdmin(w, async (admin) => {
          await admin.box.fileImprovements();
          await admin.box.fileImprovements();
          // The condition is the cause, not the card: its kind and what it is about.
          const cause = "box_health:hold:sync_hold";
          const filed = (await list(w, own.token)).filter((one) => one.cause === cause);
          expect(filed).toHaveLength(1);
          expect(filed[0]).toMatchObject({ status: "open", causeState: "kind=hold", by: "system" });
          expect(await list(w, elsewhere.token)).toEqual([]);

          await w.admin(
            "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'withdrawn', now(), 'system:health', '{own}')",
            [card],
          );
          expect((await admin.box.fileImprovements()).closed).toBeGreaterThanOrEqual(1);
          expect((await list(w, own.token)).find((one) => one.cause === cause)?.status).toBe("done");
          // Its history opens: the close's note is sealed under the defect's own label.
          const [whole] = await list(w, own.token, { improvement: filed[0]?.id });
          expect(whole?.events?.map((event) => [event.by, event.status])).toEqual([["system", "done"]]);
          expect(whole?.events?.[0]?.note?.untrusted).toContain("recovered");

          // The condition comes back under a new card: the same defect reopens, and no second is filed.
          const again = await raiseHealth(w.admin, new Date(), recordingLogger().log, "hold", "sync_hold");
          expect(again).not.toBe(card);
          expect((await admin.box.fileImprovements()).reopened).toBeGreaterThanOrEqual(1);
          const now = (await list(w, own.token)).filter((one) => one.cause === cause);
          expect(now.map((one) => [one.id, one.status])).toEqual([[filed[0]?.id, "open"]]);
        });
      },
      ["own", "employer:example"],
    ));
});
