import type { CaptureWork, GetWorkTimeResult } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { type Admin, createAdmin } from "../admin/admin.ts";
import { titleFpsMemo } from "../core/capture-pages.ts";
import { sealUnder } from "../core/seal.ts";
import { request, testId } from "../test-support/clients.ts";
import { readAs } from "../test-support/connections.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { tampering } from "../test-support/tamper.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";

// : agents read work time by place and sort it into projects. Blocks are stored as the drain leaves
// them, written as pi_admin; every agent call goes through the Work port as pi_reader. The ranks:
// the owner's ruling and anchor outrank an agent's; an agent's outranks a proposal. Invariant 6: a
// row an agent cannot see changes nothing it is told, its refusals included. Synthetic rows,
// reserved domains and test bundles.

const TOOLS = ["get_work_time", "set_anchor", "lift_anchor", "rule_time", "lift_time_ruling", "judge_time_proposal"];
const HIDDEN = "employer:example";
const DAY = "2026-01-05";
const WINDOW = { from: DAY, to: DAY };
const at = (time: string): string => `${DAY}T${time}:00.000Z`;
const REPO = "forge.example.org/kestrel/harbor";
const OTHER_REPO = "forge.example.org/kestrel/quay";

// A block day of one block, stored as the drain stores one: a moment's seeded row made a block, its
// work_enc sealed under its label.
async function block(
  w: WorkWorld,
  label: string[],
  from: string,
  to: string,
  bundle: string,
  repository?: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const { id } = await w.seed.capture(label);
  const minutes = (Date.parse(at(to)) - Date.parse(at(from))) / 60_000;
  const work: CaptureWork = {
    kind: "block",
    blocks: [
      {
        start: at(from),
        end: at(to),
        minutes,
        bundle,
        category: null,
        ...(repository === undefined ? {} : { repository: { value: repository, method: "git_remote" } }),
        ...extra,
      },
    ],
    cut: { blocks: 0, minutes: 0 },
  } as CaptureWork;
  await w.admin(
    `update knowledge.captures set kind = 'block', capture_key = 'block:' || substr(capture_key, 8), minutes = $2,
       started_at = $3, ended_at = $4, local_day = $5, work_enc = $6::jsonb where id = $1`,
    [
      id,
      minutes,
      at(from),
      at(to),
      DAY,
      JSON.stringify(
        sealUnder(
          w.keys,
          [...label].sort(),
          { table: "knowledge.captures", id, column: "work_enc" },
          JSON.stringify(work),
        ),
      ),
    ],
  );
  return id;
}

const project = async (w: WorkWorld, label: string[]): Promise<string> => w.seed.project(label);

const read = async (w: WorkWorld, token: string): Promise<GetWorkTimeResult> =>
  ok(await w.work.getWorkTime(token, WINDOW as never));
const credited = (view: GetWorkTimeResult) => view.credited.map((one) => [one.project.id, one.basis, one.minutes]);
const places = (view: GetWorkTimeResult) =>
  view.uncredited.map((one) => [one.place.kind, one.place.value.untrusted, one.minutes]);
const anchor = (w: WorkWorld, token: string, project: string, value: string, requestId = request()) =>
  w.work.setAnchor(token, { project, kind: "repository", value, requestId } as never);
const rule = (w: WorkWorld, token: string, project: string, from: string, to: string, requestId = request()) =>
  w.work.ruleTime(token, { project, from: at(from), to: at(to), requestId } as never);
const asAdmin = async <T>(w: WorkWorld, fn: (admin: Admin) => Promise<T>): Promise<T> => {
  const admin = createAdmin({ url: w.db.urls.admin, keys: w.db.keys, log: recordingLogger().log });
  try {
    return await fn(admin);
  } finally {
    await admin.close();
  }
};
// A live system proposal of `project` over a stretch, as the daily pass writes one.
const propose = async (w: WorkWorld, project: string, label: string[], from: string, to: string): Promise<string> => {
  const proposal = testId("tpr");
  await w.admin(
    `insert into knowledge.time_rulings (id, project_id, from_at, to_at, source, proposal_id, created_at, compartments)
     values ($1, $2, $3, $4, 'system', $5, now(), $6)`,
    [testId("tru"), project, at(from), at(to), proposal, label],
  );
  return proposal;
};

describe("get_work_time and an agent's anchors", { timeout: DB_TEST_TIMEOUT }, () => {
  it("serves uncredited time by place; an agent's anchor credits the blocks whose strong keys it meets, at the next read, and lifting it returns them", () =>
    withWorkWorld(async (w) => {
      const sorter = await w.client("sorter", ["own"], { tools: TOOLS });
      const harbor = await project(w, ["own"]);
      await block(w, ["own"], "09:00", "10:00", "test.example.edit", REPO);
      await block(w, ["own"], "10:00", "10:30", "test.example.term");

      const before = await read(w, sorter.token);
      expect(before.from).toBe(`${DAY}T00:00:00.000Z`);
      expect(credited(before)).toEqual([]);
      expect(places(before)).toEqual([
        ["repository", REPO, 60],
        ["app", "test.example.term", 30],
      ]);
      expect(before.uncredited[0]?.stretches).toEqual([{ from: at("09:00"), to: at("10:00") }]);
      expect(before.uncreditedMinutes).toBe(90);

      const set = ok(await anchor(w, sorter.token, harbor, REPO));
      const after = await read(w, sorter.token);
      expect(credited(after)).toEqual([[harbor, "agent_anchor", 60]]);
      expect(places(after)).toEqual([["app", "test.example.term", 30]]);
      expect(after.anchors).toEqual([
        expect.objectContaining({ anchor: set.anchor, project: harbor, kind: "repository" }),
      ]);
      // The anchor holds a fingerprint and its place sealed, never the place in clear, and no claim.
      const [row] = await w.admin<Record<string, unknown>>("select * from knowledge.agent_anchors where id = $1", [
        set.anchor,
      ]);
      expect(JSON.stringify(row)).not.toContain(REPO);
      expect(row?.compartments).toEqual(["own"]);

      ok(await w.work.liftAnchor(sorter.token, { anchor: set.anchor, requestId: request() } as never));
      const lifted = await read(w, sorter.token);
      expect(credited(lifted)).toEqual([]);
      expect(lifted.anchors).toEqual([]);
    }));

  it("a repeat answers the first anchor; a key another agent anchored for another project is anchor_taken; a generic place and an unseen project are not_found", () =>
    withWorkWorld(async (w) => {
      const first = await w.client("first", ["own"], { tools: TOOLS });
      const second = await w.client("second", ["own"], { tools: TOOLS });
      const harbor = await project(w, ["own"]);
      const quay = await project(w, ["own"]);
      const requestId = request();
      const set = ok(await anchor(w, first.token, harbor, REPO, requestId));
      expect(ok(await anchor(w, first.token, harbor, REPO, requestId))).toEqual(set);
      // The same place and project by another agent: its own row beside the first, so it lifts only its own.
      const beside = ok(await anchor(w, second.token, harbor, REPO));
      expect(beside.anchor).not.toBe(set.anchor);
      expect(await anchor(w, second.token, quay, REPO)).toEqual({
        ok: false,
        code: "invalid_request",
        refusal: "anchor_taken",
      });
      // The positive control: another place is free.
      ok(await anchor(w, second.token, quay, OTHER_REPO));
      // A bare host is generic.
      expect(
        await w.work.setAnchor(first.token, {
          project: harbor,
          kind: "host",
          value: "github.com",
          requestId: request(),
        } as never),
      ).toEqual({ ok: false, code: "not_found" });
      // Only its own anchor is lifted by an agent.
      expect(await w.work.liftAnchor(second.token, { anchor: set.anchor, requestId: request() } as never)).toEqual({
        ok: false,
        code: "not_found",
      });
    }));

  it("the owner's device anchor outranks an agent's on the same key", () =>
    withWorkWorld(async (w) => {
      const sorter = await w.client("sorter", ["own"], { tools: TOOLS });
      const harbor = await project(w, ["own"]);
      const quay = await project(w, ["own"]);
      await block(w, ["own"], "09:00", "10:00", "test.example.edit", REPO);
      ok(await anchor(w, sorter.token, harbor, REPO));
      await asAdmin(w, (admin) =>
        admin.projects.anchor(quay as never, { kind: "repository", value: REPO } as never, { requestId: request() }),
      );
      expect(credited(await read(w, sorter.token))).toEqual([[quay, "anchor", 60]]);
    }));
});

describe("an agent's rulings and the proposals", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a ruling credits its stretch, outranks a proposal and is outranked by the owner's ruling; lifting it returns the time", () =>
    withWorkWorld(async (w) => {
      const sorter = await w.client("sorter", ["own"], { tools: TOOLS });
      const harbor = await project(w, ["own"]);
      const quay = await project(w, ["own"]);
      await block(w, ["own"], "09:00", "11:00", "test.example.term");
      const proposal = await propose(w, quay, ["own"], "09:00", "11:00");
      expect(credited(await read(w, sorter.token))).toEqual([[quay, "proposed", 120]]);
      expect((await read(w, sorter.token)).proposals).toEqual([
        expect.objectContaining({
          proposal,
          stretches: [{ from: at("09:00"), to: at("11:00") }],
          place: { kind: "app", value: { untrusted: "test.example.term" } },
        }),
      ]);

      const requestId = request();
      const ruled = ok(await rule(w, sorter.token, harbor, "09:00", "10:00", requestId));
      expect(ok(await rule(w, sorter.token, harbor, "09:00", "10:00", requestId))).toEqual(ruled);
      expect(credited(await read(w, sorter.token))).toEqual([
        [harbor, "agent_ruling", 60],
        [quay, "proposed", 60],
      ]);
      // The owner's ruling outranks it.
      await asAdmin(w, (admin) =>
        admin.time.assign({
          from: at("09:30") as never,
          to: at("10:00") as never,
          project: quay as never,
          requestId: request(),
        }),
      );
      expect(credited(await read(w, sorter.token))).toEqual([
        [quay, "proposed", 60],
        [harbor, "agent_ruling", 30],
        [quay, "ruling", 30],
      ]);
      // A stretch over a day, or backwards, is invalid_request.
      expect(
        (
          await w.work.ruleTime(sorter.token, {
            project: harbor,
            from: at("10:00"),
            to: at("09:00"),
            requestId: request(),
          } as never)
        ).ok,
      ).toBe(false);
      ok(await w.work.liftTimeRuling(sorter.token, { ruling: ruled.ruling, requestId: request() } as never));
      expect(credited(await read(w, sorter.token))).toEqual([
        [quay, "proposed", 90],
        [quay, "ruling", 30],
      ]);
    }));

  it("judge_time_proposal writes the agent's ruling over the proposal's stretches, for its project or another, and leaves the proposal for the owner", () =>
    withWorkWorld(async (w) => {
      const sorter = await w.client("sorter", ["own"], { tools: TOOLS });
      const harbor = await project(w, ["own"]);
      const quay = await project(w, ["own"]);
      await block(w, ["own"], "09:00", "11:00", "test.example.term");
      const proposal = await propose(w, quay, ["own"], "09:00", "10:00");
      const requestId = request();
      const judged = ok(await w.work.judgeTimeProposal(sorter.token, { proposal, requestId } as never));
      expect(judged.rulings).toHaveLength(1);
      expect(ok(await w.work.judgeTimeProposal(sorter.token, { proposal, requestId } as never))).toEqual(judged);
      expect(credited(await read(w, sorter.token))).toEqual([[quay, "agent_ruling", 60]]);
      // Redirected, once the first is lifted: the agent's ruling for the project it names.
      ok(await w.work.liftTimeRuling(sorter.token, { ruling: judged.rulings[0], requestId: request() } as never));
      ok(await w.work.judgeTimeProposal(sorter.token, { proposal, project: harbor, requestId: request() } as never));
      expect(credited(await read(w, sorter.token))).toEqual([[harbor, "agent_ruling", 60]]);
      // The system row is as it was, so the owner's veto still finds it.
      expect(await w.admin("select lifted_at from knowledge.time_rulings where proposal_id = $1", [proposal])).toEqual([
        { lifted_at: null },
      ]);
      expect(await w.admin("select proposal_id from knowledge.agent_time_rulings where lifted_at is null", [])).toEqual(
        [{ proposal_id: proposal }],
      );
    }));
});

describe("invariant 6: rows an agent cannot see", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a hidden block, project, anchor, ruling and proposal change nothing an `own` agent is told, refusals included; the wide agent's differ", () =>
    withWorkWorld(
      async (w) => {
        const narrow = await w.client("narrow", ["own"], { tools: TOOLS });
        const wide = await w.client("wide", ["own", HIDDEN], { tools: TOOLS });
        const harbor = await project(w, ["own"]);
        await block(w, ["own"], "09:00", "10:00", "test.example.edit", REPO);
        await block(w, ["own"], "10:00", "11:00", "test.example.term");
        const absent = `ent_${testId("x").slice(-26)}`;
        const view = async (client: { token: string }) => {
          const { anchors: _a, rulings: _r, ...rest } = await read(w, client.token);
          return JSON.stringify(rest);
        };
        const narrowBefore = await view(narrow);
        const wideBefore = await view(wide);
        const taken = JSON.stringify(await anchor(w, narrow.token, absent, OTHER_REPO));

        // The hidden twin: a block wider than the narrow agent's clearance over the same hour, a
        // project of that label, the wide agent's anchor of the narrow's place and its ruling, and a
        // proposal of the hidden label.
        const hiddenProject = await project(w, [HIDDEN]);
        await block(w, ["own", HIDDEN], "11:00", "12:00", "test.example.edit", REPO);
        ok(await anchor(w, wide.token, hiddenProject, OTHER_REPO));
        ok(await rule(w, wide.token, hiddenProject, "09:00", "12:00"));
        await propose(w, hiddenProject, [HIDDEN], "09:00", "12:00");

        expect(await view(narrow)).toBe(narrowBefore);
        // A hidden project answers as no project; the hidden anchor of the place takes nothing from it.
        expect(JSON.stringify(await anchor(w, narrow.token, hiddenProject, REPO))).toBe(taken);
        ok(await anchor(w, narrow.token, harbor, OTHER_REPO));
        expect(JSON.stringify(await rule(w, narrow.token, hiddenProject, "09:00", "10:00"))).toBe(
          JSON.stringify(await rule(w, narrow.token, absent, "09:00", "10:00")),
        );
        // The control: the wide agent sees the hidden block and its own ruling credit it.
        const wideAfter = await read(w, wide.token);
        expect(JSON.stringify((({ anchors: _a, rulings: _r, ...rest }) => rest)(wideAfter))).not.toBe(wideBefore);
        expect(credited(wideAfter)).toContainEqual([hiddenProject, "agent_ruling", 60]);
        // The narrow agent's ruling over the wider block credits it for no reader: it reaches only
        // what its agent could see.
        ok(await rule(w, narrow.token, harbor, "11:00", "12:00"));
        expect(credited(await read(w, wide.token))).toContainEqual([hiddenProject, "agent_ruling", 60]);
      },
      ["own", HIDDEN],
    ));
});

describe("the owner's view and undo", { timeout: DB_TEST_TIMEOUT }, () => {
  it("pia time agents lists each agent's rows; lift --client lifts every one of that agent's; a mark is kept", () =>
    withWorkWorld(async (w) => {
      const sorter = await w.client("sorter", ["own"], { tools: TOOLS });
      const other = await w.client("other", ["own"], { tools: TOOLS });
      const harbor = await project(w, ["own"]);
      await block(w, ["own"], "09:00", "10:00", "test.example.edit", REPO);
      const set = ok(await anchor(w, sorter.token, harbor, REPO));
      const ruled = ok(await rule(w, sorter.token, harbor, "10:00", "11:00"));
      const kept = ok(await rule(w, other.token, harbor, "12:00", "13:00"));
      const listed = await asAdmin(w, (admin) => admin.time.agents());
      expect(listed.rows.map((one) => [one.id, one.kind, one.client, one.projectName]).sort()).toEqual(
        [
          [set.anchor, "repository", "sorter", "Seed project"],
          [ruled.ruling, "ruling", "sorter", "Seed project"],
          [kept.ruling, "ruling", "other", "Seed project"],
        ].sort(),
      );
      // The anchor's row names its place, so the owner can judge it.
      expect(listed.rows.find((one) => one.id === set.anchor)?.place).toBe(REPO);
      expect(listed.rows.find((one) => one.id === ruled.ruling)?.place).toBeNull();
      expect(await asAdmin(w, (admin) => admin.time.liftAgent("sorter"))).toEqual({ anchors: 1, rulings: 1 });
      expect((await asAdmin(w, (admin) => admin.time.agents())).rows.map((one) => one.id)).toEqual([kept.ruling]);
      expect(credited(await read(w, sorter.token))).toEqual([]);
      await expect(asAdmin(w, (admin) => admin.time.liftAgent("nobody"))).rejects.toThrow();
      await asAdmin(w, (admin) => admin.time.markAgent(kept.ruling, "wrong"));
      const marked = await asAdmin(w, (admin) => admin.time.agents());
      expect(marked.marked).toEqual({ right: 0, wrong: 1 });
      expect(marked.rows[0]?.mark).toBe("wrong");
    }));
});

describe("the owner's word stands over an agent's (invariant 11)", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a veto lifts the agent rulings judged from the proposal and those of its project over its stretches, and an agent may not rule them again", () =>
    withWorkWorld(async (w) => {
      const sorter = await w.client("sorter", ["own"], { tools: TOOLS });
      const harbor = await project(w, ["own"]);
      const quay = await project(w, ["own"]);
      await block(w, ["own"], "09:00", "12:00", "test.example.term");
      const proposal = await propose(w, quay, ["own"], "09:00", "10:00");
      const judged = ok(await w.work.judgeTimeProposal(sorter.token, { proposal, requestId: request() } as never));
      const over = ok(await rule(w, sorter.token, quay, "09:30", "10:30"));
      // Another project's ruling over the same stretch, and the proposal's project elsewhere: kept.
      const other = ok(await rule(w, sorter.token, harbor, "10:30", "11:00"));
      const later = ok(await rule(w, sorter.token, quay, "11:00", "12:00"));
      expect(credited(await read(w, sorter.token))).toContainEqual([quay, "agent_ruling", 150]);

      await asAdmin(w, (admin) => admin.time.veto({ proposal: proposal as never, requestId: request() }));
      const lifted = await w.admin<{ id: string; lifted_by: string | null }>(
        "select id, lifted_by from knowledge.agent_time_rulings order by id",
      );
      expect(Object.fromEntries(lifted.map((one) => [one.id, one.lifted_by]))).toEqual({
        [judged.rulings[0] as string]: "owner",
        [over.ruling]: "owner",
        [other.ruling]: null,
        [later.ruling]: null,
      });
      expect(credited(await read(w, sorter.token))).toEqual([
        [quay, "agent_ruling", 60],
        [harbor, "agent_ruling", 30],
      ]);
      // The vetoed stretch and project: refused, as no project is; another project there: taken.
      expect(await rule(w, sorter.token, quay, "09:45", "10:15")).toEqual({ ok: false, code: "not_found" });
      ok(await rule(w, sorter.token, harbor, "09:45", "10:15"));
      expect(await w.work.judgeTimeProposal(sorter.token, { proposal, requestId: request() } as never)).toEqual({
        ok: false,
        code: "not_found",
      });
    }));

  it("judge_time_proposal redirecting to a project the owner vetoed over the stretch is refused and writes nothing", () =>
    withWorkWorld(async (w) => {
      const sorter = await w.client("sorter", ["own"], { tools: TOOLS });
      const harbor = await project(w, ["own"]);
      const quay = await project(w, ["own"]);
      await block(w, ["own"], "09:00", "11:00", "test.example.term");
      const vetoed = await propose(w, harbor, ["own"], "09:00", "10:00");
      await asAdmin(w, (admin) => admin.time.veto({ proposal: vetoed as never, requestId: request() }));
      const proposal = await propose(w, quay, ["own"], "09:00", "10:00");
      expect(
        await w.work.judgeTimeProposal(sorter.token, { proposal, project: harbor, requestId: request() } as never),
      ).toEqual({ ok: false, code: "not_found" });
      expect(await w.admin("select id from knowledge.agent_time_rulings")).toEqual([]);
      // The control: accepted for its own project.
      ok(await w.work.judgeTimeProposal(sorter.token, { proposal, requestId: request() } as never));
    }));

  it("the owner's unanchor lifts agents' anchors of the place to that project, and an agent may not anchor it again", () =>
    withWorkWorld(async (w) => {
      const sorter = await w.client("sorter", ["own"], { tools: TOOLS });
      const harbor = await project(w, ["own"]);
      const quay = await project(w, ["own"]);
      await block(w, ["own"], "09:00", "10:00", "test.example.edit", REPO);
      const owners = await asAdmin(w, (admin) =>
        admin.projects.anchor(harbor as never, { kind: "repository", value: REPO } as never, { requestId: request() }),
      );
      const agents = ok(await anchor(w, sorter.token, harbor, REPO));
      const elsewhere = ok(await anchor(w, sorter.token, quay, OTHER_REPO));
      await asAdmin(w, (admin) => admin.projects.unanchor(owners, { requestId: request() }));
      expect(
        await w
          .admin("select id, lifted_by from knowledge.agent_anchors order by id", [])
          .then((rows) =>
            Object.fromEntries(
              (rows as { id: string; lifted_by: string | null }[]).map((one) => [one.id, one.lifted_by]),
            ),
          ),
      ).toEqual({ [agents.anchor]: "owner", [elsewhere.anchor]: null });
      expect(credited(await read(w, sorter.token))).toEqual([]);
      expect(await anchor(w, sorter.token, harbor, REPO)).toEqual({ ok: false, code: "not_found" });
      // The place to another project is the agent's to anchor.
      ok(await anchor(w, sorter.token, quay, REPO));
    }));

  it("a request id is a repeat within one tool alone", () =>
    withWorkWorld(async (w) => {
      const sorter = await w.client("sorter", ["own"], { tools: TOOLS });
      const harbor = await project(w, ["own"]);
      await block(w, ["own"], "09:00", "10:00", "test.example.term");
      const proposal = await propose(w, harbor, ["own"], "09:00", "10:00");
      const requestId = request();
      const ruled = ok(await rule(w, sorter.token, harbor, "09:00", "10:00", requestId));
      const judged = ok(await w.work.judgeTimeProposal(sorter.token, { proposal, requestId } as never));
      expect(judged.rulings).not.toContain(ruled.ruling);
      expect(ok(await rule(w, sorter.token, harbor, "09:00", "10:00", requestId))).toEqual(ruled);
    }));
});

describe("get_work_time's titles for the title role", { timeout: DB_TEST_TIMEOUT }, () => {
  const LEAD = "time-lead";
  const BROWSER = "test.example.browser";
  // A block day with a window title in its blob and a kept page in its work_enc.
  async function titled(w: WorkWorld, label: string[], from: string, to: string, title: string, page: string) {
    const id = await block(w, label, from, to, BROWSER, undefined, {
      host: "docs.example.org",
      pages: [{ url: "https://docs.example.org/guide", title: page, firstAt: at(from), lastAt: at(from), count: 1 }],
    });
    const [row] = await w.admin<{ blob_ref: string }>(
      "select e.blob_ref from knowledge.captures k join vault.evidence_items e on e.id = k.evidence_id where k.id = $1",
      [id],
    );
    const item = {
      kind: "block",
      key: `block:${testId("k").slice(2)}`,
      revision: 0,
      day: DAY,
      blocks: [
        {
          start: at(from),
          end: at(to),
          minutes: 60,
          app: { bundle: BROWSER, name: "Browser" },
          title,
          host: "docs.example.org",
        },
      ],
    };
    const blobRef = row?.blob_ref as string;
    // The seeded blob made this block day's, which the database allows only while tampering.
    await tampering(w.db, () =>
      w.admin("update vault.evidence_blobs set envelope = $2::jsonb where blob_ref = $1", [
        blobRef,
        JSON.stringify(
          sealUnder(
            w.keys,
            [...label].sort(),
            { table: "vault.evidence_blobs", id: blobRef, column: "envelope" },
            Buffer.from(JSON.stringify(item)).toString("base64"),
          ),
        ),
      ]),
    );
    return id;
  }
  // An unlinked meeting, its name in its sealed facts.
  async function meeting(w: WorkWorld, label: string[], from: string, to: string, title: string) {
    const { id } = await w.seed.capture(label);
    await w.admin(
      `update knowledge.captures set kind = 'meeting', capture_key = 'meeting:' || substr(capture_key, 8), minutes = null,
         started_at = $2, ended_at = $3, local_day = $4, work_enc = null, facts_enc = $5::jsonb where id = $1`,
      [
        id,
        at(from),
        at(to),
        DAY,
        JSON.stringify(
          sealUnder(
            w.keys,
            [...label].sort(),
            { table: "knowledge.captures", id, column: "facts_enc" },
            JSON.stringify({ kind: "meeting", title, calendar: null }),
          ),
        ),
      ],
    );
    return id;
  }
  const served = (view: GetWorkTimeResult) => ({
    groups: view.uncredited.map((one) => [
      one.title?.untrusted ?? null,
      one.pages?.map((page) => page.untrusted) ?? null,
    ]),
    meetings: view.meetings?.map((one) => [one.name.untrusted, one.minutes]) ?? null,
  });
  const withRole = async (w: WorkWorld, client: { id: string }) => {
    await w.admin("update policy.clients set roles = $2 where id = $1", [client.id, [LEAD]]);
  };

  it("serves no title to any agent until the owner names the role, then only to an agent holding it, each untrusted", () =>
    withWorkWorld(async (w) => {
      const lead = await w.client("lead", ["own"], { tools: TOOLS });
      const other = await w.client("other", ["own"], { tools: TOOLS });
      await withRole(w, lead);
      await titled(w, ["own"], "09:00", "10:00", "Harbor release plan", "Harbor guide");
      await meeting(w, ["own"], "11:00", "11:30", "Weekly harbor sync");
      const none = { groups: [[null, null]], meetings: null };

      // Off as shipped: nobody, the role's holder included.
      expect(served(await read(w, lead.token))).toEqual(none);
      await asAdmin(w, (admin) => admin.work.setTitleRole(LEAD));
      expect(served(await read(w, lead.token))).toEqual({
        groups: [["Harbor release plan", ["Harbor guide"]]],
        meetings: [["Weekly harbor sync", 30]],
      });
      // An agent without the role is answered as before, and cannot call the definer for titles.
      expect(served(await read(w, other.token))).toEqual(none);
      await expect(
        readAs(w.db, other.token, (query) =>
          query("select * from ledger.work_time_titles($1, '{}'::text[], '{}'::text[])", [other.session]),
        ),
      ).rejects.toThrow(/not permitted/);
      // --none turns it off again.
      await asAdmin(w, (admin) => admin.work.setTitleRole(null));
      expect(served(await read(w, lead.token))).toEqual(none);
    }));

  it("a block day outside the caller's clearance gives no title, asked for by id", () =>
    withWorkWorld(async (w) => {
      const lead = await w.client("lead", ["own"], { tools: TOOLS });
      await withRole(w, lead);
      await asAdmin(w, (admin) => admin.work.setTitleRole(LEAD));
      const hidden = await titled(w, [HIDDEN, "own"], "09:00", "10:00", "Hidden roadmap", "Hidden guide");
      const seen = await titled(w, ["own"], "10:00", "11:00", "Harbor release plan", "Harbor guide");
      const evidence = async (id: string) =>
        (await w.admin<{ evidence_id: string }>("select evidence_id from knowledge.captures where id = $1", [id]))[0]
          ?.evidence_id;
      const rows = await readAs(w.db, lead.token, async (query) =>
        query<{ id: string }>("select id from ledger.work_time_titles($1, $2::text[], '{}'::text[])", [
          lead.session,
          [await evidence(hidden), await evidence(seen)],
        ]),
      );
      expect(rows.map((one) => one.id)).toEqual([await evidence(seen)]);
      expect(JSON.stringify(await read(w, lead.token))).not.toContain("Hidden");
    }));

  it("a title or meeting name that names a person an erasure suppressed is not served", () =>
    withWorkWorld(async (w) => {
      const lead = await w.client("lead", ["own"], { tools: TOOLS });
      await withRole(w, lead);
      await asAdmin(w, (admin) => admin.work.setTitleRole(LEAD));
      await titled(w, ["own"], "09:00", "10:00", "Call with Ada Quill", "Harbor guide");
      await meeting(w, ["own"], "11:00", "11:30", "Ada Quill sync");
      const before = served(await read(w, lead.token));
      expect(before.groups[0]?.[0]).toBe("Call with Ada Quill");
      expect(before.meetings).toEqual([["Ada Quill sync", 30]]);
      // A suppression of one of the name's fingerprints, as a person's erasure writes it.
      const fp = titleFpsMemo(w.keys)("Ada Quill")[0] as string;
      const ruling = testId("rul");
      const erasure = testId("ers");
      await w.admin(
        `insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments)
         values ($1, $2, 'erase', 0, '{}', '{}', now(), '{own}')`,
        [ruling, testId("req")],
      );
      await w.admin(
        `insert into knowledge.erasures (id, ruling_id, kind, journal_seq, erased_at, items, suppressed, tainted_rows, compartments)
         values ($1, $2, 'person', 1, now(), 0, 1, 0, '{own}')`,
        [erasure, ruling],
      );
      await w.admin(
        `insert into knowledge.suppressions (id, erasure_id, kind, value_fp, added_at, compartments)
         values ($1, $2, 'address', $3, now(), '{own}')`,
        [testId("sup"), erasure, fp],
      );
      expect(served(await read(w, lead.token))).toEqual({ groups: [[null, ["Harbor guide"]]], meetings: [] });
    }));

  it("`pia time titles` refuses a role no active agent holds", () =>
    withWorkWorld(async (w) => {
      await expect(asAdmin(w, (admin) => admin.work.setTitleRole("nobody-holds"))).rejects.toThrow(/unknown_role/);
    }));
});
