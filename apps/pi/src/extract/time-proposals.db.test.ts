import { randomBytes } from "node:crypto";
import type { ModelRequest } from "@intelligence/contracts";
import {
  type BlockItem,
  type CaptureId,
  type CardId,
  CodedError,
  type EntityId,
  MIRROR_QUOTA,
  type MomentItem,
  QUOTA_DEFAULTS,
  TIME_EFFORT_CARDS_PER_DAY,
  type TimeProposalAnswer,
  type TimeProposalId,
  type WorkTarget,
} from "@intelligence/contracts/personal";
import { sha256 } from "@intelligence/personal-core";
import {
  type Admin,
  createAdmin,
  createPipeline,
  createReader,
  createTimePassStore,
  createWriter,
  ERASURE_HOOKS,
  journalPath,
  type Pipeline,
  type Reader,
  type Writer,
} from "@intelligence/personal-store";
import {
  createTestDatabase,
  fingerprint,
  MAIL,
  queryAs,
  stored,
  type TestDatabase,
} from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pi as inProcess, quiet } from "../test-support/extract-fixtures.ts";
import { scripted } from "../test-support/same-fact-fixtures.ts";
import { runTimeProposals } from "./time-proposals.ts";

// On Postgres: the daily time pass end to end, as `pi extract` runs it as pi_pipeline. Synthetic blocks
// with no anchors; the model is a stub that answers from the words it was shown. Code writes the
// ruling; work time credits it at read; a veto removes it and sticks across the next pass; a choice
// outside the label or naming nothing is refused beside a positive control; a viewer who cannot see a
// ruling is served what the owner would be with none (invariant 6); a named exception is never shown to
// the model; erasing a block removes its ruling (invariant 10). Reserved domains and made-up words
// only.

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const MODEL = "test/luna";
const EDITOR = { bundle: "test.example.editor", name: "Editor" };
const WORK = { bundle: "test.example.work", name: "Work" };
const BROWSER = { bundle: "com.apple.Safari", name: "Safari" };
const CHECK = { bundle: "test.example.check", name: "Check" };

const dayAfterOf = (day: string): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = (): string => Array.from({ length: 26 }, () => CROCKFORD[Math.floor(Math.random() * 32)]).join("");
const req = () => ({ requestId: `req-time-pass-${randomBytes(6).toString("hex")}` });

let db: TestDatabase;
let reader: Reader;
let writer: Writer;
let owner: Admin;
let pipeline: Pipeline;
let token: string;
let ownClient: string;
let wideClient: string;
let harbour: EntityId;
let lantern: EntityId;
let employerProject: EntityId;
let keys = 0;
let batches = 0;

const admin = <R = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<R[]> =>
  queryAs<R>(db.urls.admin, sql, values);

async function client(name: string, compartments: string[]): Promise<string> {
  const secret = `pit_test-${name}-${randomBytes(8).toString("hex")}`;
  await admin(
    `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools)
     values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6)`,
    [`cli_${ulid()}`, name, sha256(secret), compartments, ["self", "people", "work"], ["get_self", "get_timeline"]],
  );
  return secret;
}

// A device as `pi lens add` makes one, with its four source accounts.
async function addDevice(): Promise<string> {
  const capture = `pit_test-capture-${randomBytes(8).toString("hex")}`;
  const insert = `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind, id_mode, max_items_day, max_chars_day, max_rows_day, max_calls_minute)
    values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6, $7, 'stable', $8, $9, $10, $11)`;
  const quota = (q: typeof MIRROR_QUOTA) => [q.maxItemsDay, q.maxCharsDay, q.maxRowsDay, q.maxCallsMinute];
  const [captureId, mirrorId] = [`cli_${ulid()}`, `cli_${ulid()}`];
  await admin(insert, [
    captureId,
    "mac-capture",
    sha256(capture),
    ["own"],
    ["self"],
    ["push_capture"],
    "device",
    ...quota(QUOTA_DEFAULTS.device),
  ]);
  await admin(insert, [
    mirrorId,
    "mac",
    sha256(`pit_test-${ulid()}`),
    ["own"],
    ["self", "people", "work"],
    ["sync_mirror"],
    "agent",
    ...quota(MIRROR_QUOTA),
  ]);
  await admin("insert into policy.lens_devices (name, capture_client_id, mirror_client_id) values ('mac', $1, $2)", [
    captureId,
    mirrorId,
  ]);
  for (const [connector, kind] of [
    ["lens_meetings", "transcript"],
    ["lens_activity", "screen_activity"],
    ["lens_blocks", "time_block"],
    ["lens_tasks", "owner_task"],
  ] as const)
    await admin(
      "insert into vault.source_accounts (id, label, connector, source_kind, compartments) values ($1, 'device:mac', $2, $3, '{own}')",
      [`acc_${ulid()}`, connector, kind],
    );
  return capture;
}

type Block = BlockItem["blocks"][number];
const on = (
  app: { bundle: string; name: string },
  day: string,
  from: string,
  to: string,
  title: string,
  more: Partial<Block> = {},
): Block => ({
  start: `${day}T${from}:00.000Z`,
  end: `${day}T${to}:00.000Z`,
  minutes: (Date.parse(`${day}T${to}:00Z`) - Date.parse(`${day}T${from}:00Z`)) / 60_000,
  app,
  title,
  ...more,
});
// A block day's key, for a revision of a day pushed before.
const dayKey = (): string => `block:01JTP2B${String((keys += 1)).padStart(19, "0")}`;
async function push(day: string, blocks: Block[], key = dayKey(), revision = 0): Promise<void> {
  const item: BlockItem = { kind: "block", key, revision, day, blocks };
  const answer = await reader.pushCapture(token, {
    batch: `time-pass-${String((batches += 1)).padStart(4, "0")}`,
    items: [item],
  });
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  expect(await writer.takeCapture()).toMatchObject({ failed: 0 });
}

type Shown = { projects: { id: string; name: string }[]; groups: { id: string; what: string; host: string | null }[] };
const shownIn = (request: ModelRequest): Shown => JSON.parse(request.data.groups ?? "{}") as Shown;

// A model that assigns or proposes by the words of the group: `answers` from `what` to a project
// id, or `new` for a new effort.
const modelFor = (answers: Record<string, string>) =>
  scripted((request): TimeProposalAnswer => {
    const { groups } = shownIn(request);
    const byProject = new Map<string, string[]>();
    const newEfforts: string[] = [];
    for (const group of groups) {
      const choice = Object.entries(answers).find(([words]) => group.what.includes(words))?.[1];
      if (choice === "new") newEfforts.push(group.id);
      else if (choice !== undefined) byProject.set(choice, [...(byProject.get(choice) ?? []), group.id]);
    }
    return {
      assignments: [...byProject].map(([project, ids]) => ({ project: project as EntityId, groups: ids })),
      newEfforts,
    };
  });

async function pass(model: ReturnType<typeof scripted>, now: string, compartments = ["own", "employer:example"]) {
  const store = createTimePassStore({ url: db.urls.pipeline, keys: db.keys, log: quiet });
  try {
    return await runTimeProposals({
      store,
      pipeline,
      client: { model: model.model, modelId: MODEL },
      compartments,
      log: quiet,
      now: () => new Date(now),
    });
  } finally {
    await store.close();
  }
}

const creditedTo = async (day: string, project: EntityId): Promise<number> => {
  const found = await owner.time.day(day);
  return found.halfDays
    .flatMap((half) => half.targets)
    .filter(({ target }: { target: WorkTarget }) => "project" in target && target.project.id === project)
    .reduce((sum, one) => sum + one.minutes, 0);
};
// A word an erasure suppressed, as a row under an erasure this file really made ("erasing a block"
// runs before every caller), so the journal stays level for the erasures that follow.
const suppressWord = async (word: string, compartments = ["own"]): Promise<void> => {
  const made = await admin(
    `insert into knowledge.suppressions (id, erasure_id, kind, value_fp, added_at, compartments)
     select $1, id, 'address', $2, now(), $3 from knowledge.erasures order by id limit 1 returning id`,
    [`sup_${ulid()}`, fingerprint(db.keys, "name", word), compartments],
  );
  expect(made).toHaveLength(1);
};
const proposalsOf = async (day: string): Promise<{ id: TimeProposalId; project: string; what: string }[]> =>
  (await owner.time.day(day)).proposals.map((one) => ({
    id: one.id,
    project: one.project.id,
    what: one.what.untrusted,
  }));

beforeAll(async () => {
  db = await createTestDatabase({ compartments: ["own", "employer:example", "canary"] });
  reader = createReader({ url: db.urls.reader, keys: db.keys, log: quiet });
  writer = createWriter({ url: db.urls.writer, keys: db.keys, log: quiet });
  owner = createAdmin({ url: db.urls.admin, keys: db.keys, log: quiet, journal: journalPath(db.keyFile) });
  pipeline = createPipeline({ url: db.urls.pipeline, keys: db.keys, log: quiet });
  await admin("insert into knowledge.entities (id, kind) values ($1, 'owner')", [`ent_${ulid()}`]);
  token = await addDevice();
  ownClient = await client("desk-own", ["own"]);
  wideClient = await client("desk-wide", ["own", "employer:example"]);
  await owner.lens.addScope({ match: "bundle", value: EDITOR.bundle, compartment: "own", kinds: ["block", "moment"] });
  await owner.lens.addScope({ match: "bundle", value: WORK.bundle, compartment: "employer:example", kinds: ["block"] });
  await owner.lens.addScope({ match: "bundle", value: CHECK.bundle, compartment: "canary", kinds: ["block"] });
  await owner.lens.addScope({
    match: "host",
    value: "video.example.net",
    compartment: "own",
    kinds: ["block", "moment"],
  });
  await owner.lens.addScope({
    match: "host",
    value: "docs.example.org",
    compartment: "own",
    kinds: ["block", "moment"],
  });
  harbour = await owner.projects.add("Harbour survey", req());
  lantern = await owner.projects.add("Lantern plan", req());
  employerProject = await owner.projects.add("Ledger audit", { compartment: "employer:example", ...req() });
});

afterAll(async () => {
  await Promise.all([reader.close(), writer.close(), owner.close(), pipeline.close()]);
  await db.drop();
});

describe("the daily time pass", () => {
  // First: the start check refuses a command once the file's bare suppressions have no journal.
  it("pi extract counts the pass's calls in the run's bound", async () => {
    const day = "2027-09-01";
    await push(day, [on(EDITOR, day, "09:00", "09:30", "Bound words")]);
    await owner.secrets.setSecret("openrouter/key", "sk-or-v1-time-pass-test");
    const accounts = await writer.ensureSourceAccount(
      "personal",
      "google_mail",
      "own",
      MAIL.canary.to?.[0]?.address as string,
    );
    await stored(writer, accounts, MAIL.canary);
    const model = scripted(() => ({ assignments: [], newEfforts: [] }));
    const result = await inProcess(
      ["extract"],
      {
        PI_DATABASE_URL_PIPELINE: db.urls.pipeline,
        PI_KEY_FILE: db.keyFile,
        PI_EXTRACT_MODEL: MODEL,
        PI_EXTRACT_TIME: "1",
        PI_EXTRACT_MAX_CALLS: "1",
      },
      { deps: { model: model.model, now: () => new Date("2027-09-02T13:00:00.000Z") } },
    );
    expect(result.stderr).toContain("extract_run");
    // The one call the run was allowed went to its mail, so the pass asked nothing.
    expect(model.sent.map((request) => request.promptId)).not.toContain("personal_time_proposal");
    expect(model.sent).toHaveLength(1);
  });

  it("with no anchors the pass proposes, code writes the ruling, and workTime credits the minutes; a veto removes them and sticks", async () => {
    const day = "2026-05-04";
    await push(day, [
      on(EDITOR, day, "09:00", "10:00", "Harbour survey notes"),
      on(EDITOR, day, "10:00", "10:30", "Other reading"),
    ]);
    expect(await creditedTo(day, harbour)).toBe(0);

    const model = modelFor({ "Harbour survey notes": harbour });
    const counts = await pass(model, "2026-05-05T13:00:00.000Z");
    expect(counts).toMatchObject({ proposed: 1, refused: 0 });
    expect(model.sent).toHaveLength(1);
    const shown = shownIn(model.sent[0] as ModelRequest);
    expect(shown.projects.map((one) => one.id).sort()).toEqual([harbour, lantern].sort());
    expect(shown.projects.map((one) => one.id)).not.toContain(employerProject);

    // The ruling: the system's, its evidence by id, labelled by code with the block's label, no words.
    const [row, ...rest] = await admin<{
      source: string;
      project_id: string;
      evidence_ids: string[];
      compartments: string[];
      ruling_id: string | null;
    }>("select source, project_id, evidence_ids, compartments, ruling_id from knowledge.time_rulings");
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ source: "system", project_id: harbour, compartments: ["own"], ruling_id: null });
    const [block] = await admin<{ evidence_id: string }>(
      "select evidence_id from knowledge.captures where local_day = $1",
      [day],
    );
    expect(row?.evidence_ids).toEqual([block?.evidence_id]);

    expect(await creditedTo(day, harbour)).toBe(60);
    expect((await proposalsOf(day))[0]).toMatchObject({ project: harbour, what: "Harbour survey notes" });

    // At most once a local day: the next run of that day asks nothing.
    const again = modelFor({});
    expect(await pass(again, "2026-05-05T15:00:00.000Z")).toBe("not_due");
    expect(again.sent).toHaveLength(0);

    const [proposal] = await proposalsOf(day);
    await owner.time.veto({ proposal: proposal?.id as TimeProposalId, ...req() });
    expect(await creditedTo(day, harbour)).toBe(0);
    expect(await proposalsOf(day)).toEqual([]);

    // The next pass would propose it again; the stretch is held and the model never sees it.
    const next = modelFor({ "Harbour survey notes": harbour });
    expect(await pass(next, "2026-05-06T13:00:00.000Z")).toMatchObject({ proposed: 0 });
    for (const request of next.sent)
      expect(shownIn(request).groups.map((one) => one.what)).not.toContain("Harbour survey notes");
    expect(await creditedTo(day, harbour)).toBe(0);
  });

  it("a veto with another project makes the same stretches the owner's ruling for it, over what is proposed", async () => {
    const day = "2026-05-07";
    await push(day, [on(EDITOR, day, "09:00", "09:30", "Tide tables")]);
    await pass(modelFor({ "Tide tables": lantern }), "2026-05-08T13:00:00.000Z");
    expect(await creditedTo(day, lantern)).toBe(30);
    const [proposal] = await proposalsOf(day);
    await owner.time.veto({ proposal: proposal?.id as TimeProposalId, to: harbour, ...req() });
    expect(await creditedTo(day, lantern)).toBe(0);
    expect(await creditedTo(day, harbour)).toBe(30);
    const found = await owner.time.day(day);
    expect(found.halfDays.flatMap((half) => half.sessions).map((one) => one.basis)).toContain("ruling");
  });

  it("the owner's ruling credits a stretch, none credits nothing, and unassign restores; bad_range and not_found beside a control", async () => {
    const day = "2026-05-09";
    await push(day, [on(EDITOR, day, "09:00", "09:40", "Plain typing")]);
    await owner.time.assign({ from: `${day}T09:00:00.000Z`, to: `${day}T09:40:00.000Z`, project: harbour, ...req() });
    expect(await creditedTo(day, harbour)).toBe(40);
    const [ruling] = await admin<{ id: string }>(
      "select id from knowledge.time_rulings where source = 'owner' and from_at = $1",
      [`${day}T09:00:00.000Z`],
    );
    await owner.time.unassign(ruling?.id as string, req().requestId);
    expect(await creditedTo(day, harbour)).toBe(0);
    await expect(
      owner.time.assign({ from: `${day}T10:00:00.000Z`, to: `${day}T09:00:00.000Z`, project: harbour, ...req() }),
    ).rejects.toMatchObject({ code: "bad_range" });
    await expect(
      owner.time.assign({ from: `${day}T09:00:00.000Z`, to: "2026-05-11T09:00:00.000Z", project: harbour, ...req() }),
    ).rejects.toMatchObject({ code: "bad_range" });
    await expect(
      owner.time.assign({
        from: `${day}T09:00:00.000Z`,
        to: `${day}T10:00:00.000Z`,
        project: `ent_${ulid()}` as EntityId,
        ...req(),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("a choice naming a project outside the block's label, or none that exists, is refused beside a positive control", async () => {
    const day = "2026-05-12";
    await push(day, [
      on(EDITOR, day, "09:00", "09:30", "Alpha words"),
      on(EDITOR, day, "09:30", "10:00", "Beta words"),
      on(EDITOR, day, "10:00", "10:30", "Gamma words"),
    ]);
    const counts = await pass(
      modelFor({ "Alpha words": employerProject, "Beta words": `ent_${ulid()}`, "Gamma words": harbour }),
      "2026-05-13T13:00:00.000Z",
    );
    expect(counts).toMatchObject({ proposed: 1, refused: 2 });
    expect(await creditedTo(day, employerProject)).toBe(0);
    expect(await creditedTo(day, harbour)).toBe(30);
  });

  it("a viewer who cannot see a ruling is served the same minutes as with none; one who can sees it credit", async () => {
    const day = "2026-05-14";
    await push(day, [on(EDITOR, day, "09:00", "09:30", "Own writing")]);
    await push(day, [on(WORK, day, "11:00", "11:30", "Audit binder")]);
    const views = async (secret: string) => JSON.stringify(await reader.workViews(secret, { view: "day", day }));
    const before = await views(ownClient);

    // The employer's block is proposed to the employer's project, under the employer's label.
    await pass(modelFor({ "Audit binder": employerProject }), "2026-05-15T13:00:00.000Z");
    // And a ruling a caller cannot see, over the very stretch of an own block the owner can.
    await admin(
      `insert into knowledge.time_rulings (id, project_id, from_at, to_at, source, proposal_id, evidence_ids, created_at, compartments)
       values ($1, $2, $3, $4, 'system', $5, '{}', now(), '{employer:example}')`,
      [`tru_${ulid()}`, employerProject, `${day}T09:00:00.000Z`, `${day}T09:30:00.000Z`, `tpr_${ulid()}`],
    );
    expect(await views(ownClient)).toBe(before);

    const wide = JSON.parse(await views(wideClient)) as {
      day: { halfDays: { targets: { target: WorkTarget; minutes: number }[] }[] };
    };
    const credited = wide.day.halfDays
      .flatMap((half) => half.targets)
      .filter(({ target }) => "project" in target && target.project.id === employerProject);
    // Only the employer's own block: a ruling labelled wider than a block never reaches that block.
    expect(credited.reduce((sum, one) => sum + one.minutes, 0)).toBe(30);
  });

  it("a named site or app is never shown to the model; one not named is", async () => {
    const day = "2026-05-16";
    const excepted = await owner.time.addException("host", "example.net");
    await push(day, [
      on(BROWSER, day, "09:00", "09:30", "Clips", { host: "video.example.net" }),
      on(BROWSER, day, "09:30", "10:00", "Shared plan", { host: "docs.example.org" }),
    ]);
    const model = modelFor({ Clips: harbour, "Shared plan": lantern });
    expect(await pass(model, "2026-05-17T13:00:00.000Z")).toMatchObject({ proposed: 1 });
    const hosts = model.sent.flatMap((request) => shownIn(request).groups.map((group) => group.host));
    expect(hosts).toContain("docs.example.org");
    expect(hosts).not.toContain("video.example.net");
    expect(await owner.time.exceptions()).toEqual([{ id: excepted, match: "host", value: "example.net" }]);
    await expect(owner.time.addException("host", "EXAMPLE.net.")).rejects.toMatchObject({ code: "duplicate_name" });
    await owner.time.removeException(excepted);
    expect(await owner.time.exceptions()).toEqual([]);
    await expect(owner.time.removeException(excepted)).rejects.toMatchObject({ code: "not_found" });
  });

  it("a group fitting no project raises a card; its time credits nothing until the owner says yes, and no is remembered", async () => {
    const day = "2026-05-18";
    const names = ["Canal study", "Bridge study", "Weir study", "Lock study"];
    await push(
      day,
      names.map((name, at) => on(EDITOR, day, `1${at}:00`, `1${at}:40`, name)),
    );
    const counts = await pass(
      modelFor(Object.fromEntries(names.map((name) => [name, "new"]))),
      "2026-05-19T13:00:00.000Z",
    );
    expect(counts).toMatchObject({ cards: TIME_EFFORT_CARDS_PER_DAY, proposed: 0 });
    const cards = await admin<{ id: CardId }>(
      "select id from ledger.cards where kind = 'time_effort' order by created_at, id",
    );
    expect(cards).toHaveLength(TIME_EFFORT_CARDS_PER_DAY);
    // Waiting on a reply from the owner, it credits nothing and is no proposal.
    expect(await proposalsOf(day)).toEqual([]);
    const [yes, no] = cards;
    const pendingOf = async (card: CardId) =>
      admin<{ id: string }>("select id from knowledge.time_rulings where pending_card = $1", [card]);
    expect(await pendingOf(yes?.id as CardId)).toHaveLength(1);

    const seen = await owner.cards.card(yes?.id as CardId);
    expect(seen?.lines?.map((line) => line.text).join("\n")).toMatch(/Canal study|Bridge study|Weir study/);

    // Answered the day after, inside the card's 30 days: the owner's own clock would be past them.
    const answering = createAdmin({
      url: db.urls.admin,
      keys: db.keys,
      log: quiet,
      journal: journalPath(db.keyFile),
      now: () => new Date("2026-05-20T09:00:00.000Z"),
    });
    await answering.cards.decide({ cards: [yes?.id as CardId], answer: "confirm", labels: [], ...req() });
    await answering.cards.decide({ cards: [no?.id as CardId], answer: "reject", labels: [], ...req() });
    await answering.close();
    expect(await pendingOf(yes?.id as CardId)).toEqual([]);
    expect(await proposalsOf(day)).toHaveLength(1);
    const [made] = await proposalsOf(day);
    expect(await creditedTo(day, made?.project as EntityId)).toBe(40);

    // The no stays: that stretch is never asked about again.
    const next = modelFor({});
    await pass(next, "2026-05-20T13:00:00.000Z");
    const asked = next.sent.flatMap((request) => shownIn(request).groups.map((one) => one.what));
    const answered = await admin<{ from_at: Date }>(
      "select from_at from knowledge.time_rulings where lift_ruling_id is not null and pending_card is null and from_at >= $1",
      [`${day}T00:00:00.000Z`],
    );
    expect(answered).toHaveLength(1);
    // The three with a card, answered or waiting, are never asked again; the one past the day's cap is.
    expect(asked.filter((what) => names.includes(what))).toHaveLength(1);
  });

  it("erasing a block removes its ruling; a stretch the owner vetoed stays as a bare stretch naming nothing", async () => {
    const day = "2026-05-21";
    await push(day, [
      on(EDITOR, day, "09:00", "09:30", "Gone words"),
      on(EDITOR, day, "09:30", "10:00", "Vetoed words"),
    ]);
    await pass(modelFor({ "Gone words": harbour, "Vetoed words": lantern }), "2026-05-22T13:00:00.000Z");
    const proposals = await proposalsOf(day);
    expect(proposals).toHaveLength(2);
    await owner.time.veto({
      proposal: proposals.find((one) => one.project === lantern)?.id as TimeProposalId,
      ...req(),
    });
    const [row] = await admin<{ id: CaptureId; evidence_id: string }>(
      "select id, evidence_id from knowledge.captures where local_day = $1",
      [day],
    );
    const ref = { kind: "capture" as const, id: row?.id as CaptureId };
    const dry = await owner.erasure.eraseItem(ref, { ...req(), dryRun: true });
    expect(dry.more?.time_rulings).toBe(2);
    const report = await owner.erasure.eraseItem(ref, req());
    expect(report.more?.time_rulings).toBe(2);
    const left = await admin<{ project_id: string | null; evidence_ids: string[]; lifted: boolean }>(
      "select project_id, evidence_ids, lifted_at is not null as lifted from knowledge.time_rulings where from_at >= $1 and from_at < $2",
      [`${day}T00:00:00.000Z`, `${day}T23:59:00.000Z`],
    );
    expect(left).toEqual([{ project_id: null, evidence_ids: [], lifted: true }]);
    expect(await creditedTo(day, harbour)).toBe(0);
  });

  it("a thread names the time in its app past its own seconds, with the owner's lines; a suppressed name is shown nowhere", async () => {
    const day = "2027-01-04";
    const text = "please draft the quillon plan";
    const moment: MomentItem = {
      kind: "moment",
      key: `moment:01JTP2M${String((keys += 1)).padStart(19, "0")}`,
      revision: 0,
      observedAt: `${day}T09:00:00.000Z`,
      endedAt: `${day}T09:00:30.000Z`,
      app: EDITOR,
      entity: "chat",
      thread: "Quillon thread",
      participants: [],
      text,
      read: "ax",
      turns: [{ from: 0, to: text.length, speaker: "owner" }],
    };
    const answer = await reader.pushCapture(token, { batch: `time-pass-${(batches += 1)}`, items: [moment] });
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
    await push(day, [on(EDITOR, day, "09:00", "09:20", "Editor")]);

    const first = modelFor({});
    await pass(first, "2027-01-05T13:00:00.000Z");
    const shown = first.sent
      .flatMap((request) => shownIn(request).groups)
      .filter((one) => one.what === "Quillon thread");
    // Its own thirty seconds, and the twenty minutes the window stayed on it.
    expect(shown).toMatchObject([{ minutes: 20, ownLines: [text] }]);

    await suppressWord("quillon");
    const next = modelFor({});
    await pass(next, "2027-01-06T13:00:00.000Z");
    const groups = next.sent.flatMap((request) => shownIn(request).groups);
    expect(groups.map((one) => one.what)).toContain("Editor");
    expect(JSON.stringify(groups).toLowerCase()).not.toContain("quillon");
  });

  it("an excepted site's pages and moments never reach the model, in a block of a site not excepted", async () => {
    const day = "2027-02-01";
    const excepted = await owner.time.addException("host", "example.net");
    const page = (url: string, title: string) => ({
      url,
      title,
      count: 1,
      firstAt: `${day}T09:05:00.000Z`,
      lastAt: `${day}T09:06:00.000Z`,
    });
    const momentOn = (url: string, thread: string, minute: string): MomentItem => ({
      kind: "moment",
      key: `moment:01JTP2M${String((keys += 1)).padStart(19, "0")}`,
      revision: 0,
      observedAt: `${day}T${minute}:00.000Z`,
      endedAt: `${day}T${minute}:30.000Z`,
      app: BROWSER,
      url,
      entity: "doc",
      thread,
      participants: [],
      text: "some words",
      read: "ax",
    });
    const answer = await reader.pushCapture(token, {
      batch: `time-pass-${(batches += 1)}`,
      items: [
        momentOn("https://video.example.net/watch", "Secret clips thread", "09:00"),
        momentOn("https://docs.example.org/plan", "Shared plan thread", "09:40"),
      ],
    });
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
    await push(day, [
      on(BROWSER, day, "09:00", "09:30", "Plain docs", {
        host: "docs.example.org",
        pages: [
          page("https://video.example.net/one", "Secret clip page"),
          page("https://docs.example.org/two", "Open plan page"),
        ],
      }),
      on(BROWSER, day, "09:40", "10:00", "Other docs", { host: "docs.example.org" }),
    ]);
    const model = modelFor({});
    await pass(model, "2027-02-02T13:00:00.000Z");
    await owner.time.removeException(excepted);
    const sent = JSON.stringify(model.sent.map((request) => shownIn(request).groups));
    expect(sent).not.toContain("video.example.net");
    expect(sent).not.toContain("Secret clip");
    // The positive controls: the same page list and a thread of the site not excepted.
    expect(sent).toContain("Open plan page");
    expect(sent).toContain("Shared plan thread");
  });

  it("a place naming a suppressed person is neither sent nor shown (invariant 10)", async () => {
    const day = "2027-03-01";
    const document = { value: "~/notes/zephyrine/plan.md", method: "ax_document" as const, v: 1 };
    await push(day, [
      { start: `${day}T09:00:00.000Z`, end: `${day}T09:30:00.000Z`, minutes: 30, app: EDITOR, document },
      { start: `${day}T10:00:00.000Z`, end: `${day}T10:30:00.000Z`, minutes: 30, app: EDITOR, document, title: "Plan" },
    ]);
    const first = modelFor({ zephyrine: harbour });
    await pass(first, "2027-03-02T13:00:00.000Z");
    expect(JSON.stringify(first.sent.map((request) => shownIn(request).groups))).toContain("zephyrine");
    expect((await proposalsOf(day))[0]?.what).toContain("zephyrine");
    await suppressWord("zephyrine");
    expect(JSON.stringify(await proposalsOf(day))).not.toContain("zephyrine");
    const next = modelFor({});
    await pass(next, "2027-03-03T13:00:00.000Z");
    expect(next.sent.length).toBeGreaterThan(0);
    expect(JSON.stringify(next.sent.map((request) => shownIn(request).groups))).not.toContain("zephyrine");
  });

  it("a project named from evidence: its name leaves the slot when suppressed, and is replaced and flagged when its evidence goes", async () => {
    const day = "2027-04-01";
    await push(day, [on(EDITOR, day, "09:00", "10:00", "Xanthe harbour study")]);
    await pass(modelFor({ "Xanthe harbour study": "new" }), "2027-04-02T13:00:00.000Z");
    const [card] = await admin<{ id: CardId }>(
      `select c.id from ledger.cards c join knowledge.time_rulings r on r.pending_card = c.id where r.from_at = $1`,
      [`${day}T09:00:00.000Z`],
    );
    await owner.cards.decide({ cards: [card?.id as CardId], answer: "confirm", labels: [], ...req() });
    const [made] = await proposalsOf(day);
    const project = made?.project as EntityId;
    const nameOf = async (): Promise<string> => {
      const list = await owner.projects.list();
      return list.find((one) => one.id === project)?.name as string;
    };
    expect(await nameOf()).toBe("Xanthe harbour study");

    // A later day's question offers it by name, until the name's person is suppressed.
    const later = "2027-04-03";
    await push(later, [on(EDITOR, later, "09:00", "09:30", "Later work")]);
    const offered = modelFor({});
    await pass(offered, "2027-04-04T13:00:00.000Z");
    const namesIn = (model: ReturnType<typeof scripted>) =>
      model.sent.flatMap((request) => shownIn(request).projects.map((one) => one.name));
    expect(namesIn(offered)).toContain("Xanthe harbour study");
    await suppressWord("xanthe");
    const sealed = modelFor({});
    await pass(sealed, "2027-04-05T13:00:00.000Z");
    expect(sealed.sent.length).toBeGreaterThan(0);
    expect(namesIn(sealed)).not.toContain("Xanthe harbour study");
    // A name no erasure touched is still offered.
    expect(namesIn(sealed)).toContain("Harbour survey");

    const notices = async () =>
      admin("select id from ledger.cards where kind = 'notice' and created_by = 'system:time'");
    expect(await notices()).toEqual([]);
    const [row] = await admin<{ id: CaptureId }>("select id from knowledge.captures where local_day = $1", [day]);
    const ref = { kind: "capture" as const, id: row?.id as CaptureId };
    expect((await owner.erasure.eraseItem(ref, { ...req(), dryRun: true })).more?.time_rulings).toBeGreaterThan(0);
    expect(await nameOf()).toBe("Xanthe harbour study");
    await owner.erasure.eraseItem(ref, req());
    expect(await nameOf()).toBe("A project whose first name was erased");
    expect(await notices()).toHaveLength(1);
    // Named by the owner since, or by nobody's evidence, a project is left alone.
    expect((await owner.projects.list()).find((one) => one.id === harbour)?.name).toBe("Harbour survey");
  });

  it("a person's erasure replaces a project name that names them", async () => {
    const day = "2027-05-01";
    await push(day, [on(EDITOR, day, "09:00", "10:00", "Yvaine harbour study")]);
    await pass(modelFor({ "Yvaine harbour study": "new" }), "2027-05-02T13:00:00.000Z");
    const [card] = await admin<{ id: CardId }>(
      `select c.id from ledger.cards c join knowledge.time_rulings r on r.pending_card = c.id where r.from_at = $1`,
      [`${day}T09:00:00.000Z`],
    );
    await owner.cards.decide({ cards: [card?.id as CardId], answer: "confirm", labels: [], ...req() });
    const [made] = await proposalsOf(day);
    const hook = ERASURE_HOOKS.find((one) => one.name === "time_rulings");
    const query = (<R>(sql: string, values?: unknown[]) => queryAs<R>(db.urls.admin, sql, values)) as never;
    const erased = {
      evidenceIds: [],
      refs: [],
      addressFps: [],
      nameFps: [fingerprint(db.keys, "name", "yvaine")],
      sources: [],
      records: [],
      recordEvidenceIds: [],
      erasureId: null,
      factKeyFps: [],
      claimKeys: [],
      claimIds: [],
    };
    expect(await hook?.run(query, erased, { dryRun: true, now: new Date(), keys: db.keys })).toBeGreaterThan(0);
    await hook?.run(query, erased, { dryRun: false, now: new Date(), keys: db.keys });
    const list = await owner.projects.list();
    expect(list.find((one) => one.id === made?.project)?.name).toBe("A project whose first name was erased");
  });

  it("a suppression under a label with a restricted compartment still suppresses for the pipeline", async () => {
    const restricted = fingerprint(db.keys, "name", "restrictedword");
    await suppressWord("restrictedword", ["own", "restricted:health"]);
    expect(
      await queryAs(db.urls.pipeline, "select value_fp from knowledge.suppressions where value_fp = $1", [restricted]),
    ).toEqual([{ value_fp: restricted }]);
  });

  it("one day's failed request costs that day alone; a budget ends the pass and the next run takes it up", async () => {
    const [newer, older] = ["2027-06-02", "2027-06-01"];
    await push(older, [on(EDITOR, older, "09:00", "09:30", "Older marsh work")]);
    await push(newer, [on(EDITOR, newer, "09:00", "09:30", "Newer marsh work")]);
    const failing = (code: string, reason?: string) => {
      const inner = modelFor({ "Older marsh work": harbour, "Newer marsh work": harbour });
      return {
        sent: inner.sent,
        model: {
          ...(inner.model as object),
          complete: (request: ModelRequest) => {
            const words = JSON.stringify(shownIn(request).groups.map((one) => one.what));
            if (words.includes("Newer marsh work")) {
              inner.sent.push(request);
              throw Object.assign(new CodedError(code), reason === undefined ? {} : { reason });
            }
            return (inner.model as { complete(one: ModelRequest): unknown }).complete(request);
          },
        } as never,
      };
    };
    // A budget: nothing further is asked, and the pass is not finished.
    const budget = failing("budget_reached");
    const stopped = await pass(budget, "2027-06-03T13:00:00.000Z");
    expect(stopped).toMatchObject({ proposed: 0 });
    expect(await creditedTo(older, harbour)).toBe(0);
    // A failure of its own: the older day is still asked, and the pass finishes for the day.
    const own = failing("bad_request");
    expect(await pass(own, "2027-06-03T15:00:00.000Z")).toMatchObject({ failed: 1 });
    expect(await creditedTo(older, harbour)).toBe(30);
    expect(await pass(modelFor({}), "2027-06-03T17:00:00.000Z")).toBe("not_due");
  });

  it("the pass does not write a stretch again while a live proposal of its label covers it", async () => {
    const day = "2027-07-01";
    await push(day, [on(EDITOR, day, "09:00", "09:30", "Twice proposed")]);
    // Two that disagree credit none, so the stretch comes back to the pass.
    for (const project of [harbour, lantern])
      await admin(
        `insert into knowledge.time_rulings (id, project_id, from_at, to_at, source, proposal_id, evidence_ids, created_at, compartments)
         values ($1, $2, $3, $4, 'system', $5, '{}', now(), '{own}')`,
        [`tru_${ulid()}`, project, `${day}T09:00:00.000Z`, `${day}T09:30:00.000Z`, `tpr_${ulid()}`],
      );
    const count = async () =>
      (
        await admin<{ n: number }>("select count(*)::int as n from knowledge.time_rulings where from_at = $1", [
          `${day}T09:00:00.000Z`,
        ])
      )[0]?.n;
    await pass(modelFor({ "Twice proposed": harbour }), "2027-07-02T13:00:00.000Z");
    await pass(modelFor({ "Twice proposed": harbour }), "2027-07-03T13:00:00.000Z");
    expect(await count()).toBe(2);
  });

  it("the pass proposes no time an agent already filed, and asks about the rest", async () => {
    const day = "2027-07-05";
    await push(day, [
      on(EDITOR, day, "09:00", "09:30", "Filed by an agent"),
      on(EDITOR, day, "10:00", "10:30", "Left for the pass"),
    ]);
    const agent = `cli_${ulid()}`;
    await admin(
      `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind)
       values ($1, 'sorter', $2, 'active', 'none', 'local', '{own}', '{work}', '{rule_time}', 'agent')`,
      [agent, sha256(`pit_test-sorter-${ulid()}`)],
    );
    await admin(
      `insert into knowledge.agent_time_rulings (id, project_id, from_at, to_at, tool, client_id, request_id, created_at, compartments, reach)
       values ($1, $2, $3, $4, 'rule_time', $5, $6, now(), '{own}', '{own}')`,
      [`atr_${ulid()}`, harbour, `${day}T09:00:00.000Z`, `${day}T09:30:00.000Z`, agent, `req-sorter-${ulid()}`],
    );
    const model = modelFor({ "Filed by an agent": lantern, "Left for the pass": lantern });
    await pass(model, `${dayAfterOf(day)}T13:00:00.000Z`);
    const shown = model.sent.flatMap((request) => shownIn(request).groups.map((group) => group.what));
    expect(shown).toContain("Left for the pass");
    expect(shown).not.toContain("Filed by an agent");
    expect(await creditedTo(day, harbour)).toBe(30);
  });

  // A held card's rows name the revision the pass read, and a new revision replaces its capture and blob.
  const effortCard = async (day: string, name: string, key: string, blocks: Block[]) => {
    await push(day, blocks, key);
    await pass(modelFor({ [name]: "new" }), `${dayAfterOf(day)}T13:00:00.000Z`);
    const [card] = await admin<{ id: CardId }>(
      `select distinct pending_card as id from knowledge.time_rulings where pending_card is not null and from_at >= $1 and from_at < $2`,
      [`${day}T00:00:00.000Z`, `${dayAfterOf(day)}T00:00:00.000Z`],
    );
    return card?.id as CardId;
  };
  const projectsNamed = async (name: string): Promise<EntityId[]> =>
    (await owner.projects.list()).filter((one) => one.name === name).map((one) => one.id as EntityId);

  it("a card raised before a block day's new revision keeps its words, and a yes makes the project", async () => {
    const day = "2027-07-12";
    const key = dayKey();
    const blocks = [on(EDITOR, day, "09:00", "09:40", "Sluice gate study")];
    const card = await effortCard(day, "Sluice gate study", key, blocks);
    await push(day, [...blocks, on(EDITOR, day, "10:00", "10:05", "Later words")], key, 1);
    const seen = await owner.cards.card(card);
    expect(seen?.lines?.map((line) => line.text).join("\n")).toContain("Sluice gate study");
    await owner.cards.decide({ cards: [card], answer: "confirm", labels: [], ...req() });
    const [project] = await projectsNamed("Sluice gate study");
    expect(project).toBeDefined();
    expect(await creditedTo(day, project as EntityId)).toBe(40);
  });

  it("a yes takes its name from a stretch still there when the first has gone from the new revision", async () => {
    const day = "2027-07-14";
    const key = dayKey();
    const kept = on(EDITOR, day, "11:00", "11:40", "Culvert survey");
    const card = await effortCard(day, "Culvert survey", key, [
      on(EDITOR, day, "09:00", "09:40", "Culvert survey"),
      kept,
    ]);
    await push(day, [kept], key, 1);
    await owner.cards.decide({ cards: [card], answer: "confirm", labels: [], ...req() });
    const [project] = await projectsNamed("Culvert survey");
    expect(project).toBeDefined();
    expect(await creditedTo(day, project as EntityId)).toBe(40);
  });

  it("a yes with nothing left to name it is never silently lost: its rows go, the owner is told, and the time is asked again", async () => {
    const day = "2027-07-16";
    const key = dayKey();
    const blocks = [on(EDITOR, day, "09:00", "09:40", "Weir repair plan")];
    const card = await effortCard(day, "Weir repair plan", key, blocks);
    await push(day, [on(EDITOR, day, "15:00", "15:01", "Other words")], key, 1);
    await owner.cards.decide({ cards: [card], answer: "confirm", labels: [], ...req() });
    expect(await admin("select id from knowledge.time_rulings where pending_card = $1", [card])).toEqual([]);
    expect(await projectsNamed("Weir repair plan")).toEqual([]);
    const [told] = await admin<{ id: CardId }>(
      "select id from ledger.cards where kind = 'notice' and created_by = 'system:time' and request_id = $1",
      [`time_yes_lost_${card.slice(4)}`],
    );
    const notice = await owner.cards.card(told?.id as CardId);
    expect(notice?.lines?.map((line) => line.text).join("\n")).toContain("asked again");

    // The time comes back in a later revision: the group is asked again, under a new card.
    await push(day, blocks, key, 2);
    // The same words as the first asking, so its saved answer replays and no request leaves.
    const again = modelFor({});
    expect(await pass(again, `${dayAfterOf(dayAfterOf(day))}T13:00:00.000Z`)).toMatchObject({ cards: 1 });
    const raised = await admin<{ id: CardId }>(
      "select distinct pending_card as id from knowledge.time_rulings where pending_card is not null and from_at >= $1 and from_at < $2",
      [`${day}T00:00:00.000Z`, `${dayAfterOf(day)}T00:00:00.000Z`],
    );
    expect(raised).toHaveLength(1);
    expect(raised[0]?.id).not.toBe(card);
  });

  it("erasing a block day takes a ruling that cites a superseded revision", async () => {
    const day = "2027-07-18";
    const key = dayKey();
    const blocks = [on(EDITOR, day, "09:00", "09:30", "Revised proposal words")];
    await push(day, blocks, key);
    await pass(modelFor({ "Revised proposal words": harbour }), `${dayAfterOf(day)}T13:00:00.000Z`);
    expect(await proposalsOf(day)).toHaveLength(1);
    await push(day, [...blocks, on(EDITOR, day, "10:00", "10:01", "More")], key, 1);
    expect((await proposalsOf(day)).map((one) => one.what)).toEqual(["Revised proposal words"]);
    const [row] = await admin<{ id: CaptureId }>("select id from knowledge.captures where local_day = $1", [day]);
    await owner.erasure.eraseItem({ kind: "capture", id: row?.id as CaptureId }, req());
    expect(
      await admin("select id from knowledge.time_rulings where from_at >= $1 and from_at < $2", [
        `${day}T00:00:00.000Z`,
        `${dayAfterOf(day)}T00:00:00.000Z`,
      ]),
    ).toEqual([]);
  });

  it("with a host named, browser time whose host cannot be told is never shown; with none named it is", async () => {
    const day = "2027-07-20";
    await owner.lens.addScope({ match: "host", value: "10.0.0.5", compartment: "own", kinds: ["block", "moment"] });
    await push(day, [
      on(BROWSER, day, "09:00", "09:30", "Router page", { host: "10.0.0.5" }),
      on(BROWSER, day, "09:30", "10:00", "Shared notes", { host: "docs.example.org" }),
      on(EDITOR, day, "10:00", "10:30", "Editor words"),
    ]);
    const excepted = await owner.time.addException("host", "10.0.0.5");
    const named = modelFor({});
    await pass(named, `${dayAfterOf(day)}T13:00:00.000Z`);
    const shown = named.sent.flatMap((request) => shownIn(request).groups.map((one) => one.what));
    expect(shown).toEqual(expect.arrayContaining(["Shared notes", "Editor words"]));
    expect(shown).not.toContain("Router page");
    await owner.time.removeException(excepted);
    const none = modelFor({});
    await pass(none, `${dayAfterOf(dayAfterOf(day))}T13:00:00.000Z`);
    expect(none.sent.flatMap((request) => shownIn(request).groups.map((one) => one.what))).toContain("Router page");
  });

  it("the standing check's own time is never asked about; the owner's beside it is", async () => {
    const day = "2027-07-25";
    await push(day, [
      on(CHECK, day, "09:00", "10:00", "Check words"),
      on(EDITOR, day, "10:00", "11:00", "Owner words"),
    ]);
    const model = modelFor({});
    await pass(model, "2027-07-26T13:00:00.000Z", ["own", "employer:example", "canary"]);
    const asked = model.sent.flatMap((request) => shownIn(request).groups.map((group) => group.what));
    expect(asked).toContain("Owner words");
    expect(asked).not.toContain("Check words");
  });

  it("a ruling of none refuses a stretch where no block holds its label, and reaches a block that does", async () => {
    const day = "2027-08-01";
    await push(day, [on(WORK, day, "09:00", "09:30", "Audit work")]);
    const stretch = { from: `${day}T09:00:00.000Z`, to: `${day}T09:30:00.000Z`, project: null };
    await expect(owner.time.assign({ ...stretch, ...req() })).rejects.toMatchObject({ code: "no_block" });
    await owner.time.assign({ ...stretch, compartment: "employer:example", ...req() });
    expect(
      await admin("select id from knowledge.time_rulings where source = 'owner' and from_at = $1", [stretch.from]),
    ).toHaveLength(1);
  });

  it("pi outcomes counts the proposals and gives the veto rate", async () => {
    // The world's days lie in May; read the report as of its end.
    const later = createAdmin({
      url: db.urls.admin,
      keys: db.keys,
      log: quiet,
      now: () => new Date("2026-05-31T00:00:00.000Z"),
    });
    const view = await later.box.outcomes(30);
    await later.close();
    expect(view.timeProposals.proposed).toBeGreaterThan(0);
    expect(view.timeProposals.vetoed).toBeGreaterThan(0);
    expect(view.timeProposals.held).toBeGreaterThan(0);
    const rate = view.metrics.find((one) => one.metric === "time_proposal_veto_rate");
    expect(rate?.value).toBeCloseTo(view.timeProposals.vetoed / view.timeProposals.proposed, 2);
    expect(rate?.sample).toBe(view.timeProposals.proposed);
    expect(view.usage.tables.map((one) => one.table)).toContain("knowledge.time_rulings");
  });

  it("the pipeline role can write neither the owner's word nor lift a veto, and reads no sealed exception", async () => {
    const insert = (source: string, ruling: string | null, proposal: string | null) =>
      queryAs(
        db.urls.pipeline,
        `insert into knowledge.time_rulings (id, project_id, from_at, to_at, source, ruling_id, proposal_id, created_at, compartments)
         values ($1, $2, '2026-05-23T09:00:00Z', '2026-05-23T10:00:00Z', $3, $4, $5, now(), '{own}')`,
        [`tru_${ulid()}`, harbour, source, ruling, proposal],
      );
    await expect(insert("owner", `rul_${ulid()}`, null)).rejects.toMatchObject({ code: "42501" });
    await expect(queryAs(db.urls.pipeline, "update knowledge.time_rulings set lifted_at = null")).rejects.toBeDefined();
    await expect(queryAs(db.urls.pipeline, "select value_enc from policy.time_exceptions")).rejects.toBeDefined();
    await expect(queryAs(db.urls.reader, "select evidence_ids from knowledge.time_rulings")).rejects.toBeDefined();
  });

  // Last: a whole run finishes the pass at a time later than every other test's clock.
  it("pi extract --canary runs no pass, and a whole run with the same switch does", async () => {
    const day = "2027-12-01";
    await push(day, [on(EDITOR, day, "09:00", "10:00", "Whole run words")]);
    const run = async (args: string[]): Promise<string[]> => {
      const model = scripted(() => ({ assignments: [], newEfforts: [] }));
      await inProcess(
        args,
        {
          PI_DATABASE_URL_PIPELINE: db.urls.pipeline,
          PI_KEY_FILE: db.keyFile,
          PI_EXTRACT_MODEL: MODEL,
          PI_EXTRACT_TIME: "1",
        },
        { deps: { model: model.model, now: () => new Date("2027-12-02T13:00:00.000Z") } },
      );
      return model.sent.map((request) => request.promptId);
    };
    expect(await run(["extract", "--canary"])).not.toContain("personal_time_proposal");
    expect(await run(["extract"])).toContain("personal_time_proposal");
  });
});
