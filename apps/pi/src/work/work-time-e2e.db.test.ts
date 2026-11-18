import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { BlockItem, CaptureItem, MomentItem, TaskItem } from "@intelligence/contracts/personal";
import { FOLD_SETUP } from "@intelligence/personal-core/testing";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { queryAs } from "@intelligence/personal-store/testing";
import { afterAll, describe, expect, it, vi } from "vitest";
import { pi as inProcess, type Synced, syncedWorld } from "../test-support/extract-fixtures.ts";
import { freePort, spawnPi as spawned } from "../test-support/spawn-pi.ts";

// Lens is played by HTTP requests: a block day pushed at noon with the morning's blocks and again
// whole after midnight, a chat moment and two tasks; then one full `pi sync`, one `pi extract` with
// no capture lane on (for capture items the link step alone; the world's mail is answered from its
// recorded outputs), and every view read with `pi time day` and `pi time project`, which print to a
// terminal only and so run in-process with a terminal. The owner's zone is unset, so every day
// boundary is UTC's and the hand counts below are in UTC. No model is called. Reserved domains and
// test bundles only.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));
const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000);
// The day read: the UTC day before NOW's, so every time below is past.
const DAY = new Date(Date.parse(`${NOW.toISOString().slice(0, 10)}T00:00:00.000Z`) - 86_400_000)
  .toISOString()
  .slice(0, 10);
const at = (time: string): string => `${DAY}T${time}+00:00`;
const EDIT = { bundle: "test.example.edit", name: "Edit" };
const CHAT = { bundle: "test.example.chat", name: "Chat" };
const REPO = "forge.example.com/owner/alpha";

type Env = Record<string, string>;

// `pi http` as the box runs it, ready once it logs http_listening.
async function startHttp(env: Env): Promise<{ base: string; child: ChildProcess; stop(): Promise<void> }> {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", FOLD_SETUP, MAIN, "http"], {
    env: { PATH: process.env.PATH ?? "", ...env, PI_HTTP_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.includes('"http_listening"')) resolve();
    });
    void closed.then(() => reject(new Error(`pi http ended: ${stderr}`)));
  });
  return {
    base: `http://127.0.0.1:${port}`,
    child,
    async stop() {
      child.kill("SIGTERM");
      await closed;
    },
  };
}

const KEY = (n: number, kind: CaptureItem["kind"]): string =>
  `${kind}:01JWE2E000000000000000${String(n).padStart(4, "0")}`;
const block = (
  start: string,
  end: string,
  minutes: number,
  app: typeof EDIT,
  repository = false,
): BlockItem["blocks"][number] => ({
  start: at(start),
  end: at(end),
  minutes,
  app,
  title: app === EDIT ? "main.ts — alpha" : "Team",
  ...(repository ? { repository: { value: REPO, method: "git_remote" as const, v: 1 } } : {}),
});
const MORNING = [block("09:00:00", "10:00:00", 60, EDIT, true), block("10:00:00", "10:20:00", 20, CHAT)];
const NOON: BlockItem = { kind: "block", key: KEY(1, "block"), revision: 0, day: DAY, blocks: MORNING };
const MIDNIGHT: BlockItem = {
  ...NOON,
  revision: 1,
  blocks: [...MORNING, block("13:00:00", "13:45:00", 45, EDIT, true)],
};
const MOMENT: MomentItem = {
  kind: "moment",
  key: KEY(2, "moment"),
  revision: 0,
  observedAt: at("10:05:00"),
  endedAt: at("10:06:00"),
  app: CHAT,
  window: "Team",
  entity: "chat",
  thread: "Team",
  participants: [],
  text: "lunch at one?\nsure",
  read: "ax",
};
const DONE: TaskItem = {
  kind: "task",
  key: KEY(3, "task"),
  revision: 0,
  byOwner: true,
  title: "Ship the parser",
  project: "Alpha",
  events: [
    { kind: "created", at: at("08:30:00") },
    { kind: "completed", at: at("13:40:00") },
  ],
};
const OPEN: TaskItem = {
  kind: "task",
  key: KEY(4, "task"),
  revision: 0,
  byOwner: true,
  title: "Read the plan",
  events: [{ kind: "created", at: at("12:00:00") }],
};

describe("work time end to end, through pi and pi http", () => {
  let s: Synced;
  let http: Awaited<ReturnType<typeof startHttp>> | undefined;
  let token = "";
  let project = "";
  const calls: string[] = [];
  const adminEnv = (): Env => s.admin;
  const writerEnv = (): Env => ({ PI_DATABASE_URL_WRITER: s.db.urls.writer, PI_KEY_FILE: s.db.keyFile });
  const readerEnv = (): Env => ({ PI_DATABASE_URL_READER: s.db.urls.reader, PI_KEY_FILE: s.db.keyFile });
  const ok = async (argv: string[], env: Env, options: { tty?: boolean; stdin?: string[] } = {}): Promise<string> => {
    const result = await inProcess(argv, env, options);
    expect(result.exit, `pi ${argv.join(" ")}: ${result.stderr}`).toBe(0);
    return result.stdout;
  };
  const push = async (items: CaptureItem[], batch: string): Promise<unknown> => {
    if (http === undefined) throw new Error("pi http is not running");
    const answer = await fetch(`${http.base}/v1/tools/push_capture`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ batch, items }),
    });
    expect(answer.status).toBe(200);
    return answer.json();
  };
  const sync = async (): Promise<void> => {
    const synced = await spawned(["sync"], writerEnv());
    expect(synced.exit, synced.stderr).toBe(0);
  };

  afterAll(async () => {
    await http?.stop();
    await s?.drop();
  });

  it("setup: the world synced, a device with its task switch on, its scope, a project anchored to the repository, and pi http serving", async () => {
    s = await syncedWorld({ now: NOW });
    const added = await ok(["lens", "add", "mac"], adminEnv(), { tty: true });
    token = (JSON.parse(added) as { capture: string }).capture;
    expect(token).toMatch(/^pit_/);
    await queryAs(
      s.db.urls.admin,
      "delete from vault.source_accounts where label = 'device:mac' and connector = 'lens_tasks'",
    );
    await ok(["lens", "tasks", "mac", "on"], adminEnv());
    await ok(["lens", "tasks", "mac", "on"], adminEnv());
    expect(
      await queryAs(
        s.db.urls.admin,
        "select source_kind, compartments from vault.source_accounts where label = 'device:mac' and connector = 'lens_tasks'",
      ),
    ).toEqual([{ source_kind: "owner_task", compartments: ["own"] }]);
    for (const bundle of [EDIT.bundle, CHAT.bundle])
      expect(
        (
          await ok(
            ["lens", "scope", "add", "--bundle", bundle, "--compartment", "own", "--kinds", "block,moment"],
            adminEnv(),
          )
        ).trim(),
      ).toMatch(/^csr_/);
    project = (await ok(["project", "add"], adminEnv(), { stdin: ["Alpha"] })).trim();
    expect(project).toMatch(/^ent_/);
    expect((await ok(["project", "anchor", project, "--repo", REPO], adminEnv())).trim()).toMatch(/^pan_/);
    http = await startHttp(readerEnv());
  });

  it("WT23: a day pushed at noon and again whole after midnight, a moment and tasks, synced and linked with every lane off", async () => {
    expect(await push([NOON, MOMENT, DONE, OPEN], "work-time-e2e-0001")).toMatchObject({
      items: [NOON, MOMENT, DONE, OPEN].map((item) => ({ key: item.key, outcome: "accepted" })),
    });
    await sync();
    expect(await push([MIDNIGHT], "work-time-e2e-0002")).toMatchObject({
      items: [{ key: MIDNIGHT.key, outcome: "accepted" }],
    });
    await sync();
    // One extract with no capture lane switched on (the world's mail is answered from its recorded
    // outputs): for capture items, the link step alone, by code.
    const extracted = await inProcess(["extract"], s.pipeline, { deps: { model: fakeModelClient(s.outputs, calls) } });
    expect(extracted.exit, extracted.stderr).toBe(0);
    const evidence = (
      await queryAs<{ id: string }>(s.db.urls.admin, "select evidence_id as id from knowledge.captures")
    ).map((row) => row.id);
    expect(calls.filter((id) => evidence.includes(id))).toEqual([]);
    const rows = await queryAs<{ kind: string; revision: number; work: boolean }>(
      s.db.urls.admin,
      "select kind, revision, work_enc is not null as work from knowledge.captures where capture_key = any($1) order by kind, capture_key",
      [[NOON.key, MOMENT.key, DONE.key, OPEN.key]],
    );
    expect(rows).toEqual([
      { kind: "block", revision: 1, work: true },
      { kind: "moment", revision: 0, work: true },
      { kind: "task", revision: 0, work: true },
      { kind: "task", revision: 0, work: true },
    ]);
  });

  it("end to end, the world's day reads as its hand count with pi time day, with zero model calls for work time", async () => {
    const before = await queryAs<{ n: number }>(s.db.urls.admin, "select count(*)::int as n from vault.model_calls");
    const day = JSON.parse(await ok(["time", "day", DAY], adminEnv(), { tty: true })) as {
      day: string;
      zone: string | null;
      halfDays: {
        coverage: {
          observedMinutes: number;
          creditedMinutes: number;
          unattributedMinutes: number;
          through: string | null;
        };
        tasks: { title: { untrusted: string } }[];
        threads: { lines: number }[];
      }[];
      deepWork: {
        sessions: { minutes: number; target: { project?: { id: string } } }[];
        deepMinutes: number;
        switchingMinutes: number;
        meetingMinutes: number;
        switches: number;
        complete: boolean;
      };
      hours: { deep: number; switching: number; meetings: number };
    };
    expect({ day: day.day, zone: day.zone }).toEqual({ day: DAY, zone: null });
    // 00:00 to 12:00: the editor's hour on the anchored repository and twenty minutes of chat.
    expect(day.halfDays[0]?.coverage).toMatchObject({
      observedMinutes: 80,
      creditedMinutes: 60,
      unattributedMinutes: 20,
    });
    expect(day.halfDays[0]?.threads).toEqual([expect.objectContaining({ lines: 2 })]);
    // 12:00 to 24:00: the midnight revision's 45 minutes on the repository, and the done task.
    expect(day.halfDays[1]?.coverage).toMatchObject({
      observedMinutes: 45,
      creditedMinutes: 45,
      unattributedMinutes: 0,
      through: new Date(at("13:45:00")).toISOString(),
    });
    expect(day.halfDays[1]?.tasks.map((one) => one.title.untrusted).sort()).toEqual([
      "Read the plan",
      "Ship the parser",
    ]);
    // Deep work: two sessions on the project (60 and 45 minutes), the chat between them a switch
    // and switching time; nothing of a meeting.
    expect(day.deepWork.sessions.map((one) => [one.target.project?.id, one.minutes])).toEqual([
      [project, 60],
      [project, 45],
    ]);
    expect([
      day.deepWork.deepMinutes,
      day.deepWork.switchingMinutes,
      day.deepWork.meetingMinutes,
      day.deepWork.switches,
    ]).toEqual([105, 20, 0, 1]);
    expect(day.hours).toMatchObject({ deep: 1.8, switching: 0.3, meetings: 0 });
    // --half prints that half-day alone: deep work is the whole day's.
    expect(
      Object.keys(JSON.parse(await ok(["time", "day", DAY, "--half", "pm"], adminEnv(), { tty: true })) as object),
    ).toEqual(["day", "zone", "halfDays"]);
    expect(await queryAs<{ n: number }>(s.db.urls.admin, "select count(*)::int as n from vault.model_calls")).toEqual(
      before,
    );
  });

  it("WT23: pi time project prints the project's time and its done task's advisory minutes", async () => {
    const shown = JSON.parse(await ok(["time", "project", project], adminEnv(), { tty: true })) as {
      time: { last7: number; last30: number; openTasks: number; done30: number };
      sessions: { minutes: number }[];
      tasks: { title: { untrusted: string }; workedOn: { advisory: boolean; minutes: number } | null }[];
    };
    expect(shown.time).toMatchObject({ last7: 105, last30: 105, openTasks: 0, done30: 1 });
    expect(shown.sessions.map((one) => one.minutes)).toEqual([45, 60]);
    expect(shown.tasks).toEqual([
      expect.objectContaining({
        title: { untrusted: "Ship the parser" },
        workedOn: expect.objectContaining({ advisory: true, minutes: 100 }),
      }),
    ]);
  });

  it("WT23: pi time day and pi time project refuse a pipe with not_a_terminal, and an unknown project is not_found", async () => {
    for (const argv of [
      ["time", "day", DAY],
      ["time", "project", project],
    ]) {
      const piped = await spawned(argv, adminEnv());
      expect(piped.exit, argv.join(" ")).toBe(1);
      expect(piped.stdout).toBe("");
      expect(piped.stderr).toContain('"not_a_terminal"');
    }
    const unknown = await inProcess(["time", "project", `ent_${"0".repeat(25)}9`], adminEnv(), { tty: true });
    expect(unknown.exit).toBe(1);
    expect(unknown.stderr).toContain('"not_found"');
  });
});
