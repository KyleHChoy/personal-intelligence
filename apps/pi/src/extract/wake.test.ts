import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import type { PersonalLogEvent } from "@intelligence/contracts/personal";
import { repoRoot } from "@intelligence/personal-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { run } from "../commands.ts";
import { type WakeDeps, wakeLoop } from "./wake.ts";

// The proposal wake's listener, with a fake listener and fake runs, on short real timers; then the
// box's wake script's gates, run by sh against a directory of its own.

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
// Until `check` holds, however slow the machine is.
const until = (check: () => boolean): Promise<void> =>
  vi.waitFor(() => expect(check()).toBe(true), { timeout: 20_000, interval: 5 });
// Long enough for a wake that should not come to have come: a slow machine only makes this prove less.
const QUIET = 100;

type Harness = {
  notice(): void;
  lose(): void;
  lines: PersonalLogEvent[];
  runs: number[];
  closed: () => boolean;
  ended: Promise<"lost" | "renew" | "stopped">;
  stop(): void;
};

// A loop whose runs answer `statuses` in turn (then 0), each taking `runMs`.
function harness(
  options: { statuses?: number[]; runMs?: number; debounceMs?: number; retryMs?: number; renewMs?: number } = {},
): Harness {
  const statuses = [...(options.statuses ?? [])];
  const lines: PersonalLogEvent[] = [];
  const runs: number[] = [];
  let handlers: Parameters<WakeDeps["listen"]>[0] | undefined;
  let closed = false;
  const controller = new AbortController();
  const ended = wakeLoop({
    listen: async (given) => {
      handlers = given;
      return { close: async () => void (closed = true) };
    },
    run: async () => {
      runs.push(Date.now());
      await pause(options.runMs ?? 0);
      return statuses.shift() ?? 0;
    },
    log: { info: (line) => void lines.push(line), warn: () => {}, error: () => {} },
    now: Date.now,
    debounceMs: options.debounceMs ?? 40,
    retryMs: options.retryMs ?? 60,
    renewMs: options.renewMs ?? 60_000,
    signal: controller.signal,
  });
  return {
    notice: () => handlers?.onNotice(),
    lose: () => handlers?.onLost(),
    lines,
    runs,
    closed: () => closed,
    ended,
    stop: () => controller.abort(),
  };
}

describe("the wake loop", () => {
  it("wakes once at its start, then once for a burst of notices, after the burst's wait, and logs each with its notices", async () => {
    const h = harness();
    await until(() => h.lines.length === 1);
    h.notice();
    await pause(10);
    h.notice();
    h.notice();
    expect(h.runs).toHaveLength(1);
    await until(() => h.lines.length === 2);
    expect(h.runs).toHaveLength(2);
    h.stop();
    expect(await h.ended).toBe("stopped");
    expect(h.closed()).toBe(true);
    expect(h.lines.map((line) => [line.event, line.code, line.counts?.notices])).toEqual([
      ["extract_wake", "ok", 0],
      ["extract_wake", "ok", 3],
    ]);
    expect(h.lines.every((line) => typeof line.durationMs === "number")).toBe(true);
  });

  it("notices during a wake make one more wake after it, not one each", async () => {
    const h = harness({ runMs: 60 });
    await until(() => h.runs.length === 1);
    for (let n = 0; n < 5; n += 1) h.notice();
    await until(() => h.lines.length === 2);
    await pause(QUIET);
    expect(h.runs).toHaveLength(2);
    expect(h.lines.map((line) => line.counts?.notices)).toEqual([0, 5]);
    h.stop();
    await h.ended;
  });

  it("tries again after the retry wait when an extraction run held the lock, with no notice", async () => {
    const h = harness({ statuses: [75] });
    await until(() => h.lines.length === 2);
    expect((h.runs[1] ?? 0) - (h.runs[0] ?? 0)).toBeGreaterThanOrEqual(55);
    h.stop();
    await h.ended;
    expect(h.lines.map((line) => line.code)).toEqual(["busy", "ok"]);
  });

  it("names the wake script's other statuses, and does not try again after them", async () => {
    const h = harness({ statuses: [3] });
    await until(() => h.lines.length === 1);
    await pause(QUIET);
    expect(h.runs).toHaveLength(1);
    h.notice();
    await until(() => h.lines.length === 2);
    h.notice();
    await until(() => h.lines.length === 3);
    h.stop();
    await h.ended;
    expect(h.runs).toHaveLength(3);
    expect(h.lines.map((line) => line.code)).toEqual(["held", "ok", "ok"]);
    const failed = harness({ statuses: [4, 5, 2] });
    await until(() => failed.lines.length === 1);
    failed.notice();
    await until(() => failed.lines.length === 2);
    failed.notice();
    await until(() => failed.lines.length === 3);
    failed.stop();
    await failed.ended;
    expect(failed.lines.map((line) => line.code)).toEqual(["intake_failed", "yield", "exit_2"]);
  });

  it("ends `lost` when its connection is lost, even inside a burst's wait, and closes the listener", async () => {
    const h = harness();
    await until(() => h.lines.length === 1);
    h.notice();
    h.lose();
    expect(await h.ended).toBe("lost");
    expect(h.runs).toHaveLength(1);
    expect(h.closed()).toBe(true);
  });

  it("ends `renew` once its day is up and no wake is waiting", async () => {
    const h = harness({ renewMs: 100 });
    expect(await h.ended).toBe("renew");
    expect(h.runs).toHaveLength(1);
  });
});

describe("pi extract wake", () => {
  const io = () => {
    const sink = new Writable({ write: (_chunk, _encoding, done) => done() });
    return { stdout: sink, stderr: sink, stdin: Readable.from([]), stdoutIsTTY: false };
  };
  const env = { PI_DATABASE_URL_PIPELINE: "postgres://pi_pipeline:local-only@127.0.0.1:1/pi_test" };

  // Its first run loads the store; on a loaded machine that alone can take seconds.
  it("takes one absolute path and the pipeline's URL alone", { timeout: 30_000 }, async () => {
    expect(await run(["extract", "wake"], env, io())).toBe(2);
    expect(await run(["extract", "wake", "wake-run"], env, io())).toBe(2);
    expect(
      await run(
        ["extract", "wake", "/usr/local/lib/pi/wake-run"],
        { ...env, PI_DATABASE_URL_WRITER: "postgres://pi_writer:x@127.0.0.1:1/pi_test" },
        io(),
      ),
    ).toBe(1);
    // A positive control: past every check, the closed port fails the listen.
    expect(await run(["extract", "wake", "/usr/local/lib/pi/wake-run"], env, io())).toBe(1);
  });
});

// The box's wake script with its paths moved under a directory of its own, and pi-sync and
// pi-extract replaced by stubs that note their arguments and answer as each test sets.
describe("lib/wake-run", () => {
  const source = join(repoRoot(), "deploy/lib/wake-run");
  let root = "";
  let script = "";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-wake-"));
    const text = (await readFile(source, "utf8"))
      .replaceAll("/run/pi/", `${root}/run/`)
      .replaceAll("/data/", `${root}/data/`)
      .replaceAll("/usr/local/bin/", `${root}/bin/`)
      .replaceAll("/usr/bin/timeout", `${root}/bin/timeout`);
    script = join(root, "wake-run");
    await writeFile(script, text);
    await mkdir(join(root, "run"));
    await mkdir(join(root, "data", "pi"), { recursive: true });
    await mkdir(join(root, "bin"));
    // Each stub notes its call, then answers from its file of the same name in root: an exit
    // status, and for pi-extract what it prints.
    for (const name of ["pi-sync", "pi-extract"]) {
      await writeFile(
        join(root, "bin", name),
        `#!/bin/sh\necho "${name} $*" >> ${root}/calls\n[ ! -f ${root}/${name}.out ] || cat ${root}/${name}.out\nexit $(cat ${root}/${name}.status 2> /dev/null || echo 0)\n`,
      );
      await chmod(join(root, "bin", name), 0o755);
    }
    // `timeout -k 30 SECONDS COMMAND...` notes its limit and command in root/limits and runs
    // COMMAND, or, with a timeout.status file, stops it as its limit would.
    await writeFile(
      join(root, "bin", "timeout"),
      `#!/bin/sh\necho "$3 $4" >> ${root}/limits\n[ ! -f ${root}/timeout.status ] || exit $(cat ${root}/timeout.status)\nshift 3\nexec "$@"\n`,
    );
    await chmod(join(root, "bin", "timeout"), 0o755);
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  const set = async (files: Record<string, string | null>): Promise<void> => {
    for (const [name, value] of Object.entries(files)) {
      if (value === null) await rm(join(root, name), { force: true });
      else await writeFile(join(root, name), value);
    }
  };
  const wake = async (): Promise<{ status: number | null; calls: string[] }> => {
    await rm(join(root, "calls"), { force: true });
    const { status } = spawnSync("sh", [script], { env: { PATH: "/usr/bin:/bin" } });
    const calls = await readFile(join(root, "calls"), "utf8").catch(() => "");
    return { status, calls: calls.split("\n").filter((line) => line !== "") };
  };
  // A timer run held the extract lock a moment ago: the wake does not yield.
  const OPEN = {
    "run/extract.env": "",
    "data/extract-on": "",
    "data/sync-hold": null,
    "data/read-hold": null,
    "data/wake-off": null,
    "data/pi/extract-full-at": "",
  };

  it("starts nothing, and exits 3, unless every gate holds", async () => {
    for (const shut of [
      { "run/extract.env": null },
      { "data/extract-on": null },
      { "data/sync-hold": "" },
      { "data/read-hold": "" },
      { "data/wake-off": "" },
    ]) {
      await set({ ...OPEN, ...shut });
      expect(await wake(), JSON.stringify(shut)).toEqual({ status: 3, calls: [] });
    }
  });

  it("with every gate open takes the records in, then runs the agent records alone, each logging to its own file", async () => {
    await set({ ...OPEN, "pi-sync.status": null, "pi-extract.status": null, "pi-extract.out": null });
    expect(await wake()).toEqual({
      status: 0,
      calls: ["pi-sync sync --records", "pi-extract extract --agent-records"],
    });
    expect(await readFile(join(root, "data", "pi", "sync.log"), "utf8")).toMatch(/"event":"sync_wake_run"/);
    expect(await readFile(join(root, "data", "pi", "extract.log"), "utf8")).toMatch(/"event":"extract_wake_run"/);
  });

  it("exits 75 when the run was busy, 4 when the intake failed but the run still ran, and the run's status when it failed", async () => {
    await set({ ...OPEN, "pi-extract.out": "busy\n" });
    expect((await wake()).status).toBe(75);
    await set({ "pi-extract.out": null, "pi-sync.status": "1" });
    expect(await wake()).toEqual({
      status: 4,
      calls: ["pi-sync sync --records", "pi-extract extract --agent-records"],
    });
    await set({ "pi-sync.status": null, "pi-extract.status": "1" });
    expect((await wake()).status).toBe(1);
    await set({ "pi-extract.status": null });
  });

  it("exits 75 when the sync lock is held, so the listener tries again", async () => {
    await set({ ...OPEN, "pi-sync.out": "busy\n" });
    expect(await wake()).toEqual({
      status: 75,
      calls: ["pi-sync sync --records", "pi-extract extract --agent-records"],
    });
    await set({ "pi-sync.out": null });
  });

  it("yields to the timer, taking the records in and running nothing, when no timer run held the lock within eleven minutes", async () => {
    await set({ ...OPEN, "data/pi/extract-full-at": null });
    expect(await wake()).toEqual({ status: 5, calls: ["pi-sync sync --records"] });
    await set({ "data/pi/extract-full-at": "" });
    const twelveMinutesAgo = new Date(Date.now() - 12 * 60_000);
    await utimes(join(root, "data", "pi", "extract-full-at"), twelveMinutesAgo, twelveMinutesAgo);
    expect(await wake()).toEqual({ status: 5, calls: ["pi-sync sync --records"] });
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    await utimes(join(root, "data", "pi", "extract-full-at"), tenMinutesAgo, tenMinutesAgo);
    expect((await wake()).status).toBe(0);
  });

  it("runs the intake under 15 minutes and the run under 30, and a limit that stops them is a failed intake and the run's own status", async () => {
    await set({
      ...OPEN,
      "pi-sync.out": null,
      "pi-extract.out": null,
      "pi-sync.status": null,
      "pi-extract.status": null,
      limits: null,
    });
    expect((await wake()).status).toBe(0);
    expect((await readFile(join(root, "limits"), "utf8")).trim().split("\n")).toEqual([
      `900 ${root}/bin/pi-sync`,
      `1800 ${root}/bin/pi-extract`,
    ]);
    // Both stopped by their limits: the run's status is the listener's code.
    await set({ "timeout.status": "124" });
    expect((await wake()).status).toBe(124);
    await set({ "timeout.status": null });
  });
});
