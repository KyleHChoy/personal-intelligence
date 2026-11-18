import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersonalLogger } from "@intelligence/contracts/personal";
import { repoRoot } from "@intelligence/personal-core";
import { serveHttp } from "@intelligence/personal-mcp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The box's timer, its one supervisor and its log rotation, each with its paths moved under a
// directory of its own and the box's commands replaced by stubs that note their arguments and
// answer as each test sets, as wake.test.ts runs lib/wake-run.

const lib = (name: string): string => join(repoRoot(), "deploy/lib", name);

// A stub: notes `NAME ARGS` in root/calls, prints root/NAME.out (or, for pi-admin and pi-extract,
// root/NAME.<first two arguments>.out), and exits with root/NAME.<first two arguments>.status or
// root/NAME.status, else 0. With root/NAME.<first two arguments>.sleep or root/NAME.sleep it first
// takes that many seconds, and then notes `NAME ARGS done`, so a test sees when it ended.
const stub = (root: string, name: string): string =>
  `#!/bin/sh\necho "${name} $*" >> ${root}/calls\nkey=$(echo "$1.$2" | tr ' /' '__')\nnap=$(cat ${root}/${name}.$key.sleep 2> /dev/null || cat ${root}/${name}.sleep 2> /dev/null)\nif [ -n "$nap" ]; then sleep "$nap"; echo "${name} $* done" >> ${root}/calls; fi\nif [ -f ${root}/${name}.$key.out ]; then cat ${root}/${name}.$key.out; elif [ -f ${root}/${name}.out ]; then cat ${root}/${name}.out; fi\nexit $(cat ${root}/${name}.$key.status 2> /dev/null || cat ${root}/${name}.status 2> /dev/null || echo 0)\n`;

async function setUp(root: string, script: string, text: (source: string) => string): Promise<string> {
  for (const dir of ["bin", "lib", "run", "pistate", "data/pi"]) await mkdir(join(root, dir), { recursive: true });
  for (const name of ["pi-sync", "pi-admin", "pi-extract", "pi-work", "pi-reasoner", "pi-tester"]) {
    await writeFile(join(root, "bin", name), stub(root, name));
    await chmod(join(root, "bin", name), 0o755);
  }
  // `timeout -k 30 SECONDS COMMAND...`: notes `SECONDS COMMAND ARG` in root/limits and runs COMMAND,
  // or exits with root/timeout.<command>.status, as its limit would stop it.
  await writeFile(
    join(root, "bin", "timeout"),
    `#!/bin/sh\nname=$(basename "$4")\necho "$3 $name $5" >> ${root}/limits\n[ ! -f ${root}/timeout.$name.status ] || exit $(cat ${root}/timeout.$name.status)\nshift 3\nexec "$@"\n`,
  );
  await chmod(join(root, "bin", "timeout"), 0o755);
  for (const name of ["rotate-logs", "watchdog"]) {
    await writeFile(join(root, "lib", name), "#!/bin/sh\nexit 0\n");
    await chmod(join(root, "lib", name), 0o755);
  }
  const moved = text(await readFile(lib(script), "utf8"))
    .replaceAll("/run/pi/", `${root}/run/`)
    .replaceAll("/run/pistate/", `${root}/pistate/`)
    .replaceAll("/data/", `${root}/data/`)
    .replaceAll("/usr/local/bin/", `${root}/bin/`)
    .replaceAll("/usr/local/lib/pi/", `${root}/lib/`)
    .replaceAll("/usr/bin/timeout", `${root}/bin/timeout`);
  const path = join(root, script);
  await writeFile(path, moved);
  return path;
}

describe("lib/sync-timer", { timeout: 30_000 }, () => {
  let root = "";
  let script = "";
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-timer-"));
    // One loop: the two minutes' wait ends the timer instead; and the page's 15 minutes off its
    // tailnet are none, so one loop shows its card.
    script = await setUp(root, "sync-timer", (source) => {
      expect(source).toContain("  sleep 120 &\n  wait $!\n");
      expect(source).toContain("-ge 900 ]");
      // Each loop here is a start of the timer: the start's record of the daily jobs has its own
      // tests below, and is taken as made in these.
      expect(source).toContain("\nstart_seen=\n");
      return source
        .replace("  sleep 120 &\n  wait $!\n", "  exit 0\n")
        .replace("-ge 900 ]", "-ge 0 ]")
        .replace("\nstart_seen=\n", "\nstart_seen=yes\n");
    });
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  const set = async (files: Record<string, string | null>): Promise<void> => {
    for (const [name, value] of Object.entries(files)) {
      if (value === null) await rm(join(root, name), { force: true });
      else await writeFile(join(root, name), value);
    }
  };
  const loop = async (): Promise<{
    calls: string[];
    limits: string[];
    out: Record<string, unknown>[];
    raw: string;
  }> => {
    for (const name of ["calls", "limits", "data/pi/sync-full-at"]) await rm(join(root, name), { force: true });
    const { stderr } = spawnSync("sh", [script], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    const lines = async (name: string): Promise<string[]> =>
      (await readFile(join(root, name), "utf8").catch(() => "")).split("\n").filter((line) => line !== "");
    return {
      calls: await lines("calls"),
      limits: await lines("limits"),
      out: stderr
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
      raw: stderr,
    };
  };
  // Every gate open, the night's pass due and done.
  const OPEN = {
    "run/extract.env": "",
    "data/extract-on": "",
    "data/sync-hold": null,
    "data/read-hold": null,
    "data/wake-off": null,
    "data/pi/dream-day": null,
    "data/dream-hold": null,
    // The nightly pass's time limit from the trials; no weekly one.
    "data/pi/dream-nightly-seconds": "1800\n",
    "data/pi/dream-nightly-usd": "25\n",
    "data/pi/dream-weekly-seconds": null,
    "pi-admin.health.dream-due.out": "due 2026-10-30\n",
    "pi-admin.status.--storage.out": "ok\n",
    "pi-admin.status.--coverage.out": '{"event":"coverage_silent","ids":{"job":"sync"},"code":"sync_gap"}\n',
    "pi-extract.dream.--pass.out": '{"stopped":"ok"}\n',
  };

  it("runs each child under its limit, in order, records the runs no job records itself, and copies coverage's silent lines out", async () => {
    await set(OPEN);
    const { calls, limits, out } = await loop();
    const order = (call: string): number => calls.findIndex((one) => one.startsWith(call));
    for (const call of [
      "pi-sync sync",
      "pi-admin erase settle",
      "pi-admin status --storage",
      "pi-admin status --coverage --record",
      "pi-admin health dream-due",
      "pi-extract dream",
      "pi-admin health job dream ok --started",
      "pi-work work tick",
      "pi-reasoner",
      "pi-admin health job reasoner ok --started",
    ])
      expect(order(call), call).toBeGreaterThanOrEqual(0);
    expect(order("pi-sync sync")).toBeLessThan(order("pi-admin erase settle"));
    expect(order("pi-admin health dream-due")).toBeLessThan(order("pi-extract dream"));
    // The night's pass in the background, after the extract of its subshell, so new arrivals are
    // never held up behind it (imp_01M6ST6KKR50FH9BHDKKNV89HX), and recorded once it ended.
    expect(order("pi-extract extract")).toBeLessThan(order("pi-extract dream"));
    expect(order("pi-admin health job extract")).toBeLessThan(order("pi-extract dream"));
    expect(order("pi-extract dream")).toBeLessThan(order("pi-admin health job dream"));
    expect(order("pi-work work tick")).toBeLessThan(order("pi-reasoner"));
    // The extract in the background, recorded once it ended.
    expect(calls).toEqual(
      expect.arrayContaining([
        "pi-extract extract",
        expect.stringMatching(/^pi-admin health job extract ok --started \d+$/),
      ]),
    );
    expect(limits).toEqual(
      expect.arrayContaining([
        "900 pi-sync sync",
        "300 pi-admin erase",
        "120 pi-admin status",
        "120 pi-admin health",
        "1800 pi-extract dream",
        "1800 pi-extract extract",
        "300 pi-work work",
        "1200 pi-reasoner ",
      ]),
    );
    expect(await readFile(join(root, "data/pi/dream-day"), "utf8")).toBe("2026-10-30\n");
    expect(out).toContainEqual({ event: "coverage_silent", ids: { job: "sync" }, code: "sync_gap" });
  });

  // imp_01M6ST6JZ4PW9BWNWVN61DHHMR (d): the night's row carries the counts its pass printed, from
  // which pi-admin keeps the sweep's backlog and each stage's spend.
  it("records the night's pass with the counts it printed, whether it ended ok, at its budget or unavailable", async () => {
    for (const stopped of ["ok", "budget", "unavailable"]) {
      const printed = `{"backlog":12,"stageMicroUsd":{"sweep":3},"stopped":"${stopped}"}`;
      await set({ ...OPEN, "pi-extract.dream.--pass.out": `${printed}\n`, "data/pi/dream-tries": null });
      const { calls } = await loop();
      const recorded = calls.filter((call) => call.startsWith("pi-admin health job dream "));
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.replace(/ --started \d+ /, " --started N ")).toBe(
        `pi-admin health job dream ${stopped} --started N --counts ${printed}`,
      );
    }
    // A busy pass printed none.
    await set({ ...OPEN, "pi-extract.dream.--pass.out": "busy\n" });
    expect((await loop()).calls).toEqual(
      expect.arrayContaining([expect.stringMatching(/^pi-admin health job dream busy --started \d+$/)]),
    );
  });

  it("does not run the night's pass again the same day of the owner's, nor before the sweep hour, and counts a busy or failed one as not done", async () => {
    await set(OPEN);
    expect((await loop()).calls.some((call) => call.startsWith("pi-extract dream"))).toBe(true);
    expect((await loop()).calls.some((call) => call.startsWith("pi-extract dream"))).toBe(false);
    // The owner's next day.
    await set({ "pi-admin.health.dream-due.out": "due 2026-10-31\n" });
    expect((await loop()).calls.some((call) => call.startsWith("pi-extract dream"))).toBe(true);
    await set({ "data/pi/dream-day": null, "pi-admin.health.dream-due.out": "not_due\n" });
    expect((await loop()).calls.some((call) => call.startsWith("pi-extract dream"))).toBe(false);
    await set({
      "pi-admin.health.dream-due.out": "due 2026-10-30\n",
      "pi-extract.dream.--pass.out": "busy\n",
      "data/pi/dream-tries": null,
    });
    // A busy pass is recorded, and is not a try.
    const busy = await loop();
    expect(busy.calls).toEqual(
      expect.arrayContaining([expect.stringMatching(/^pi-admin health job dream busy --started \d+$/)]),
    );
    await expect(readFile(join(root, "data/pi/dream-tries"), "utf8")).rejects.toThrow();
    await set({ "pi-extract.dream.--pass.out": '{"stopped":"unavailable"}\n' });
    const failed = await loop();
    expect(failed.calls).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^pi-admin health job dream unavailable --started \d+ --counts \{"stopped":"unavailable"\}$/,
        ),
      ]),
    );
    expect(failed.out).toContainEqual(
      expect.objectContaining({ event: "dream_timer_failed", level: "error", code: "unavailable" }),
    );
    await expect(readFile(join(root, "data/pi/dream-day"), "utf8")).rejects.toThrow();
    // Two tries a day of the owner's at most: after a second failure, none more that day; the next day, again.
    await set({ "pi-extract.dream.--pass.out": "", "pi-extract.status": "1" });
    expect((await loop()).calls.some((call) => call.startsWith("pi-extract dream"))).toBe(true);
    expect(await readFile(join(root, "data/pi/dream-tries"), "utf8")).toBe("2026-10-30 2\n");
    expect((await loop()).calls.some((call) => call.startsWith("pi-extract dream"))).toBe(false);
    await set({
      "pi-admin.health.dream-due.out": "due 2026-10-31\n",
      "pi-extract.status": null,
      "pi-extract.dream.--pass.out": '{"stopped":"ok"}\n',
    });
    expect((await loop()).calls.some((call) => call.startsWith("pi-extract dream"))).toBe(true);
    await set({ "data/pi/dream-tries": null });
  });

  // The owner's pause is a file on the volume, so a deploy cannot lift it.
  it("checks the key file against its record once a start, before the sync, and not under the sync hold", async () => {
    await set(OPEN);
    const { calls } = await loop();
    expect(calls.filter((call) => call.startsWith("pi-admin health keys"))).toEqual(["pi-admin health keys"]);
    expect(calls.indexOf("pi-admin health keys")).toBeLessThan(calls.findIndex((call) => call.startsWith("pi-sync")));
    await set({ "data/sync-hold": "" });
    expect((await loop()).calls.some((call) => call.startsWith("pi-admin health keys"))).toBe(false);
    await set({ "data/sync-hold": null });
  });

  it("asks for no dream and starts none while the owner's pause file stands, and resumes once it is gone", async () => {
    await set({ ...OPEN, "data/dream-hold": "", "data/pi/dream-off-day": null });
    const paused = (await loop()).calls;
    expect(paused.some((call) => call.startsWith("pi-admin health dream-due"))).toBe(false);
    expect(paused.some((call) => call.startsWith("pi-extract dream"))).toBe(false);
    // The pause itself is recorded once a day, as a pause.
    expect(
      paused.filter((call) => call.startsWith("pi-admin health job dream")).map((call) => call.split(" ")[4]),
    ).toEqual(["lane_off"]);
    expect((await loop()).calls.some((call) => call.startsWith("pi-admin health job dream"))).toBe(false);
    // The sync hold's record of the same day uses the same mark: no second row for the pass.
    await set({ "data/sync-hold": "" });
    expect((await loop()).calls.some((call) => call.startsWith("pi-admin health job dream"))).toBe(false);
    await set({ "data/sync-hold": null });
    await expect(readFile(join(root, "data/pi/dream-day"), "utf8")).rejects.toThrow();
    await set({ "data/dream-hold": null });
    expect((await loop()).calls.some((call) => call.startsWith("pi-extract dream"))).toBe(true);
  });

  // Each pass runs only under the time limit the owner set from the trials, is
  // told to stop two minutes before it, and the weekly pass runs once a week after the day's nightly one.
  it("runs no pass with no time limit set, each under its own, and the weekly pass after the nightly one", async () => {
    await set({
      ...OPEN,
      "data/pi/dream-nightly-seconds": null,
      "data/pi/dream-off-day": null,
      "data/pi/dream-tries": null,
    });
    const unset = await loop();
    expect(unset.calls.some((call) => call.startsWith("pi-extract dream"))).toBe(false);
    expect(unset.calls.some((call) => call.startsWith("pi-admin health dream-due"))).toBe(false);
    expect(
      unset.calls.filter((call) => call.startsWith("pi-admin health job dream")).map((call) => call.split(" ")[4]),
    ).toEqual(["lane_off"]);
    await set({
      ...OPEN,
      "data/pi/dream-nightly-seconds": "3600\n",
      "data/pi/dream-weekly-seconds": "7200\n",
      "data/pi/dream-weekly-usd": "40.50\n",
      "data/pi/dream-week": null,
      "data/pi/dream-week-tries": null,
    });
    const both = await loop();
    const passes = both.calls.filter((call) => call.startsWith("pi-extract dream"));
    expect(passes).toEqual([
      "pi-extract dream --pass nightly --seconds 3480 --usd 25",
      "pi-extract dream --pass weekly --seconds 7080 --usd 40.50",
    ]);
    expect(both.limits).toEqual(expect.arrayContaining(["3600 pi-extract dream", "7200 pi-extract dream"]));
    const week = await readFile(join(root, "data/pi/dream-week"), "utf8");
    expect(week).toMatch(/^\d{4}-W\d{2}\n$/);
    // Done for the day and the week: neither runs again.
    expect((await loop()).calls.some((call) => call.startsWith("pi-extract dream"))).toBe(false);
    await set({
      "data/pi/dream-weekly-seconds": null,
      "data/pi/dream-week": null,
      "data/pi/dream-week-tries": null,
      "data/pi/dream-nightly-seconds": "1800\n",
    });
  });

  // The merges a pass's candidates earned are applied as pi_admin after each pass that finished, and
  // after none that did not.
  it("runs no scheduled pass without the owner's dollar cap, however its time limit is set", async () => {
    await set({
      ...OPEN,
      "data/pi/dream-nightly-usd": null,
      "data/pi/dream-off-day": null,
      "data/pi/dream-tries": null,
    });
    const uncapped = await loop();
    expect(uncapped.calls.some((call) => call.startsWith("pi-extract dream"))).toBe(false);
    for (const bad of ["0", "0.000", "00", "abc", "1.2.3", ".5"]) {
      await set({ ...OPEN, "data/pi/dream-nightly-usd": `${bad}\n`, "data/pi/dream-tries": null });
      expect(
        (await loop()).calls.some((call) => call.startsWith("pi-extract dream")),
        bad,
      ).toBe(false);
    }
    await set({ ...OPEN, "data/pi/dream-tries": null });
  });

  it("runs no dream merges while a sync or read hold stands", async () => {
    await set({ ...OPEN, "data/pi/dream-tries": null });
    const stub = (await readFile(join(root, "bin", "pi-extract"), "utf8")).replace(
      "#!/bin/sh\n",
      `#!/bin/sh\n[ "$1" != dream ] || : > ${root}/data/read-hold\n`,
    );
    await writeFile(join(root, "bin", "pi-extract"), stub);
    try {
      expect((await loop()).calls.some((call) => call.startsWith("pi-admin identity dream-merges"))).toBe(false);
    } finally {
      await writeFile(
        join(root, "bin", "pi-extract"),
        stub.replace(`[ "$1" != dream ] || : > ${root}/data/read-hold\n`, ""),
      );
      await set({ "data/read-hold": null, "data/pi/dream-tries": null });
    }
  });

  it("runs the dream merges as pi-admin after a finished pass, and not after a busy or failed one", async () => {
    await set({ ...OPEN, "data/pi/dream-tries": null });
    const done = (await loop()).calls;
    const at = (call: string): number => done.findIndex((one) => one.startsWith(call));
    expect(at("pi-admin identity dream-merges")).toBeGreaterThan(at("pi-admin health job dream ok"));
    await set({ ...OPEN, "data/pi/dream-tries": null, "pi-extract.dream.--pass.out": "busy\n" });
    expect((await loop()).calls.some((call) => call.startsWith("pi-admin identity dream-merges"))).toBe(false);
    await set({ ...OPEN, "data/pi/dream-tries": null, "pi-extract.dream.--pass.out": '{"stopped":"unavailable"}\n' });
    expect((await loop()).calls.some((call) => call.startsWith("pi-admin identity dream-merges"))).toBe(false);
    // A refusal says so and stops nothing.
    await set({ ...OPEN, "data/pi/dream-tries": null, "pi-admin.identity.dream-merges.status": "1" });
    const refused = await loop();
    expect(refused.out).toContainEqual(expect.objectContaining({ event: "dream_merges_failed", level: "warn" }));
    await set({ "pi-admin.identity.dream-merges.status": null, "data/pi/dream-tries": null });
  });

  // The night's pass runs after the loop's extract, up to half an hour after the loop read the
  // gates: a hold the owner sets meanwhile keeps it from starting.
  it("starts no dream after the loop's extract when a hold was set while extract ran", async () => {
    await set({ ...OPEN, "data/pi/dream-tries": null });
    const holding = stub(root, "pi-extract").replace(
      "#!/bin/sh\n",
      `#!/bin/sh\n[ "$1" != extract ] || : > ${root}/data/read-hold\n`,
    );
    await writeFile(join(root, "bin", "pi-extract"), holding);
    try {
      const { calls } = await loop();
      expect(calls).toContain("pi-extract extract");
      expect(calls.some((call) => call.startsWith("pi-extract dream"))).toBe(false);
      await expect(readFile(join(root, "data/pi/dream-tries"), "utf8")).rejects.toThrow();
    } finally {
      await writeFile(join(root, "bin", "pi-extract"), stub(root, "pi-extract"));
      await set({ "data/read-hold": null });
    }
    expect((await loop()).calls.some((call) => call.startsWith("pi-extract dream"))).toBe(true);
  });

  // A loop whose extract found the lock held leaves the pass to the run that holds it: no try of
  // its own that could only find the lock held too and add a `busy` row.
  it("starts no dream after an extract that found the lock held", async () => {
    await set({ ...OPEN, "data/pi/dream-tries": null, "pi-extract.extract..out": "busy\n" });
    try {
      const { calls } = await loop();
      expect(calls).toContain("pi-extract extract");
      expect(calls.some((call) => call.startsWith("pi-extract dream"))).toBe(false);
      expect(calls.some((call) => call.startsWith("pi-admin health job dream"))).toBe(false);
    } finally {
      await set({ "pi-extract.extract..out": null });
    }
    expect((await loop()).calls.some((call) => call.startsWith("pi-extract dream"))).toBe(true);
  });

  // A supervised process's fast exits, three in a row, raise its card once.
  it("raises a restarting card for a process whose fast exits reach three, and reads no other file", async () => {
    await set({
      ...OPEN,
      "data/pi/dream-day": "2026-10-30\n",
      "pistate/notify.restarts": "3\n",
      "pistate/web.restarts": "2\n",
      "pistate/evil$(touch x).restarts": "9\n",
    });
    const { calls } = await loop();
    expect(calls.filter((call) => call.startsWith("pi-admin health restarting"))).toEqual([
      "pi-admin health restarting notify",
    ]);
    await set({
      "pistate/notify.restarts": null,
      "pistate/web.restarts": null,
      "pistate/evil$(touch x).restarts": null,
    });
  });

  // The page off the owner's tailnet raises its card only once the service names the page's host; joined
  // again, the card is closed only when one was raised by this process.
  it("raises a dashboard_down card when the page's node has not joined, once the page's host is set", async () => {
    await set({ ...OPEN, "data/pi/dream-day": "2026-10-30\n", "pistate/tail.joined_at": "" });
    expect((await loop()).calls.some((call) => call.startsWith("pi-admin health dashboard-down"))).toBe(false);
    await set({ "run/admin.env": "PI_WEB_TS_HOST=pi-box.example.ts.net\n" });
    expect((await loop()).calls).toContain("pi-admin health dashboard-down");
    await set({ "pistate/tail.joined_at": "1761800000" });
    expect((await loop()).calls.some((call) => call.startsWith("pi-admin health dashboard-down"))).toBe(false);
    await set({ "run/admin.env": null, "pistate/tail.joined_at": null });
  });

  it("a child its limit stopped is `<job>_timed_out`, with its timed-out run recorded, a sync's with its kind", async () => {
    await set({ ...OPEN, "timeout.pi-sync.status": "124", "timeout.pi-work.status": "137" });
    const { calls, out } = await loop();
    expect(out).toContainEqual(expect.objectContaining({ event: "sync_timed_out", level: "error" }));
    expect(out).toContainEqual(expect.objectContaining({ event: "work_tick_timed_out", level: "error" }));
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^pi-admin health job sync timed_out --started \d+ --kind full$/),
        expect.stringMatching(/^pi-admin health job work_tick timed_out --started \d+$/),
      ]),
    );
    // Every fixed line carries its time and level.
    for (const line of out.filter((one) => one.event !== "coverage_silent"))
      expect(Object.keys(line).slice(0, 3)).toEqual(["event", "at", "level"]);
    await set({ "timeout.pi-sync.status": null, "timeout.pi-work.status": null });
  });

  // The codes one loop records for a job, in order.
  const runsOf = async (job: string): Promise<string[]> =>
    (await loop()).calls
      .filter((call) => call.startsWith(`pi-admin health job ${job} `))
      .map((call) => call.split(" ")[4] ?? "");
  const OFF_DAYS = {
    "data/pi/extract-off-day": null,
    "data/pi/reasoner-off-day": null,
    "data/pi/outcome_test-off-day": null,
    "data/pi/improvement_filing-off-day": null,
  };

  it("records every extract run, ok after ok among them, so the stopped-job check has a row for each day", async () => {
    await set({ ...OPEN, "data/pi/dream-day": "2026-10-30\n" });
    expect(await runsOf("extract")).toEqual(["ok"]);
    expect(await runsOf("extract")).toEqual(["ok"]);
    await set({ "pi-extract.status": "1" });
    expect(await runsOf("extract")).toEqual(["exit_1"]);
    expect(await runsOf("extract")).toEqual(["exit_1"]);
    await set({ "pi-extract.status": null });
    expect(await runsOf("extract")).toEqual(["ok"]);
    // A run that found the lock held is no run, and is not recorded.
    await set({ "pi-extract.extract..out": "busy\n" });
    expect(await runsOf("extract")).toEqual([]);
    // A run that stopped at its dollar line exits 0 and says `budget`: recorded `budget`, not `ok`, so
    // the budget_stops check reads extraction as it reads the night's pass, and no failure line.
    await set({ "pi-extract.extract..out": "budget\n" });
    const stopped = await loop();
    expect(
      stopped.calls.filter((call) => call.startsWith("pi-admin health job extract ")).map((c) => c.split(" ")[4]),
    ).toEqual(["budget"]);
    expect(stopped.out.some((line) => line.event === "extract_timer_failed")).toBe(false);
    // A run its limit stopped is timed out, whatever it printed before.
    await set({ "timeout.pi-extract.status": "124" });
    expect(await runsOf("extract")).toEqual(["timed_out"]);
    await set({ "pi-extract.extract..out": null, "timeout.pi-extract.status": null });
  });

  it("records a job its switch or a hold keeps off as lane_off once a day, and never as a run", async () => {
    // Extraction closed by the owner's switch.
    await set({ ...OPEN, ...OFF_DAYS, "data/extract-on": null });
    expect(await runsOf("extract")).toEqual(["lane_off"]);
    expect(await runsOf("extract")).toEqual([]);
    expect((await loop()).calls.some((call) => call.startsWith("pi-extract extract"))).toBe(false);
    // The outcome test, its switch unset: once that day.
    await set({ ...OPEN, ...OFF_DAYS });
    const off = (await loop()).calls.filter((call) => / health job outcome_test /.test(call));
    expect(off.map((call) => call.split(" ").slice(3, 5).join(" "))).toEqual(["outcome_test lane_off"]);
    expect((await loop()).calls.filter((call) => / health job outcome_test /.test(call))).toEqual([]);
    // The reasoner under the read hold; extraction is closed by it too.
    await set({ ...OFF_DAYS, "data/read-hold": "" });
    const held = (await loop()).calls;
    expect(held.some((call) => call.startsWith("pi-reasoner"))).toBe(false);
    expect(
      held.filter((call) => / health job (reasoner|extract) /.test(call)).map((call) => call.split(" ")[4]),
    ).toEqual(["lane_off", "lane_off"]);
    expect(await runsOf("reasoner")).toEqual([]);
    // The day's mark is the UTC day: a mark of another day is recorded over.
    await set({ "data/pi/reasoner-off-day": "2000-01-01\n" });
    expect(await runsOf("reasoner")).toEqual(["lane_off"]);
    await set({ ...OFF_DAYS, "data/read-hold": null });
  });

  // What a stalled queue looks like from here: pi-admin's recordJob raises the streak's card from these
  // rows (box-health.db.test.ts).
  it("records every reasoner run: each failed one, which is what its failure streak reads, and each ok one", async () => {
    await set({ "pi-reasoner.status": "1" });
    for (let runs = 0; runs < 3; runs += 1)
      expect((await loop()).calls.filter((call) => call.startsWith("pi-admin health job reasoner"))).toEqual([
        expect.stringMatching(/^pi-admin health job reasoner exit_1 --started \d+$/),
      ]);
    await set({ "pi-reasoner.status": null });
    for (let runs = 0; runs < 2; runs += 1) expect(await runsOf("reasoner")).toEqual(["ok"]);
  });

  it("the outcome test is off unless its switch stands, the filing pass needs none, and each runs once a day under its limit", async () => {
    await set({ ...OPEN, "data/pi/filing-after": null });
    const off = await loop();
    expect(off.calls.some((call) => call.startsWith("pi-tester"))).toBe(false);
    expect(off.calls.some((call) => call.startsWith("pi-admin improvements file"))).toBe(true);
    await set({ "run/tester-on.env": "PI_OUTCOME_TEST=1\n", "data/pi/filing-after": null });
    const { calls } = await loop();
    expect(calls.some((call) => call.startsWith("pi-admin improvements file"))).toBe(true);
    // In the background, as extract is; spawnSync waits for it, since it holds the piped streams.
    expect((await readFile(join(root, "calls"), "utf8")).includes("pi-tester")).toBe(true);
    expect((await readFile(join(root, "limits"), "utf8")).includes("3600 pi-tester ")).toBe(true);
    // Each run recorded, an ok one too.
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^pi-admin health job outcome_test ok --started \d+$/),
        expect.stringMatching(/^pi-admin health job improvement_filing ok --started \d+$/),
      ]),
    );
    const again = await loop();
    expect(again.calls.some((call) => call.startsWith("pi-tester"))).toBe(false);
    expect(again.calls.some((call) => call.startsWith("pi-admin improvements file"))).toBe(false);
    // On and already run today: no run, and no lane_off either.
    expect(again.calls.some((call) => / health job (outcome_test|improvement_filing) /.test(call))).toBe(false);
    await set({
      "run/tester-on.env": null,
      "data/pi/tester-after": null,
      "data/pi/filing-after": null,
    });
  });

  it("a hold is one hold_on line, and stops what it holds", async () => {
    await set({ ...OPEN, "data/sync-hold": "" });
    const held = await loop();
    // Nothing starts: the only calls are the day's `lane_off` rows of the daily jobs.
    expect(held.calls.filter((call) => !/^pi-admin health job \w+ lane_off --started \d+$/.test(call))).toEqual([]);
    expect(held.out).toEqual([expect.objectContaining({ event: "hold_on", level: "info", code: "sync_hold" })]);
    await set({ "data/sync-hold": null, "data/read-hold": "" });
    const read = await loop();
    expect(read.out).toContainEqual(expect.objectContaining({ event: "hold_on", code: "read_hold" }));
    expect(read.calls.some((call) => /^pi-(work|reasoner|extract)/.test(call))).toBe(false);
    expect(read.calls.some((call) => call.startsWith("pi-sync sync"))).toBe(true);
    await set({ "data/read-hold": null });
  });

  it("while the box waits for its migration, with both holds its own, starts nothing and names the wait as a hold", async () => {
    await set({ ...OPEN, "data/sync-hold": "", "data/read-hold": "", "data/migrate-wait": "" });
    const waiting = await loop();
    expect(waiting.calls.filter((call) => !/^pi-admin health job \w+ lane_off --started \d+$/.test(call))).toEqual([]);
    expect(waiting.out).toContainEqual(
      expect.objectContaining({ event: "hold_on", level: "info", code: "migrate_wait" }),
    );
    // `pi-migrate` succeeded: the three files are gone, and the next loop runs as any other.
    await set({ "data/sync-hold": null, "data/read-hold": null, "data/migrate-wait": null });
    const after = await loop();
    expect(after.out.some((line) => line.event === "hold_on")).toBe(false);
    expect(after.calls.some((call) => call.startsWith("pi-sync sync"))).toBe(true);
    expect(after.calls.some((call) => /^pi-(work|reasoner)/.test(call))).toBe(true);
  });

  // The dead-man heartbeat: only once the service sets its URL, with the URL on the request's stdin
  // and never among its arguments, and a failed request one heartbeat_failed line naming nothing.
  it("pings the owner's check once a loop when its URL is set, the URL on stdin, and names a failure", async () => {
    await writeFile(
      join(root, "lib", "heartbeat"),
      `#!/bin/sh\ncat > ${root}/beat\nexit $(cat ${root}/heartbeat.status 2> /dev/null || echo 0)\n`,
    );
    await chmod(join(root, "lib", "heartbeat"), 0o755);
    await set({ ...OPEN, "data/pi/dream-day": "2026-10-30\n", "run/heartbeat.env": "PI_HEARTBEAT_URL=\n", beat: null });
    expect((await loop()).limits.some((line) => line.includes("heartbeat"))).toBe(false);
    const url = "https://hc-ping.example/0b1c-check";
    await set({ "run/heartbeat.env": `PI_HEARTBEAT_URL=${url}\n` });
    const beat = await loop();
    // `SECONDS COMMAND FIRST-ARGUMENT`: the request has no argument at all.
    expect(beat.limits).toContain("30 heartbeat ");
    expect(await readFile(join(root, "beat"), "utf8")).toBe(`${url}\n`);
    expect(beat.raw).not.toContain(url);
    expect(beat.out.some((line) => line.event === "heartbeat_failed")).toBe(false);
    await set({ "heartbeat.status": "1" });
    const failed = await loop();
    expect(failed.out).toContainEqual({ event: "heartbeat_failed", at: expect.any(String), level: "warn" });
    expect(failed.raw).not.toContain(url);
    await set({ "run/heartbeat.env": null, "heartbeat.status": null, beat: null });
  });

  // Off by default: a waiting card changes nothing and is not even read, until the owner sets it.
  it("tells the check of a new box health card only when the owner set that, and then says no more than /fail, once", async () => {
    await writeFile(join(root, "lib", "heartbeat"), `#!/bin/sh\ncat > ${root}/beat\n`);
    await chmod(join(root, "lib", "heartbeat"), 0o755);
    const url = "https://hc-ping.example/0b1c-check";
    await set({
      ...OPEN,
      "data/pi/dream-day": "2026-10-30\n",
      "run/heartbeat.env": `PI_HEARTBEAT_URL=${url}\nPI_HEARTBEAT_ON_CARD=\n`,
      "pi-admin.health.open.out": "2\n",
      beat: null,
    });
    const off = await loop();
    expect(off.calls.some((call) => call.startsWith("pi-admin health open"))).toBe(false);
    expect(await readFile(join(root, "beat"), "utf8")).toBe(`${url}\n`);

    await set({ "run/heartbeat.env": `PI_HEARTBEAT_URL=${url}\nPI_HEARTBEAT_ON_CARD=1\n` });
    const beats = async (cards: string): Promise<string> => {
      await set({ "pi-admin.health.open.out": cards });
      await loop();
      return readFile(join(root, "beat"), "utf8");
    };
    // Once for each rise: a plain beat between keeps a box that dies going quiet.
    expect(await beats("2\n")).toBe(`${url}/fail\n`);
    expect(await beats("2\n")).toBe(`${url}\n`);
    expect(await beats("1\n")).toBe(`${url}\n`);
    expect(await beats("2\n")).toBe(`${url}/fail\n`);
    expect(await beats("\n")).toBe(`${url}\n`);
    expect(await beats("0\n")).toBe(`${url}\n`);
    await set({ "data/pi/heartbeat-cards": null });
    await set({ "run/heartbeat.env": null, "pi-admin.health.open.out": null, beat: null });
  });

  it("records what next and the open items show at most once an hour", async () => {
    await set({ ...OPEN, "data/pi/backtest-at": null, "pi-admin.health.dream-due.out": "not_due\n" });
    const made = (calls: string[]): number => calls.filter((one) => one === "pi-admin backtest record").length;
    expect(made((await loop()).calls)).toBe(1);
    expect(made((await loop()).calls)).toBe(0);
    await set({ "data/pi/backtest-at": "1000\n", "data/sync-hold": "" });
    expect(made((await loop()).calls)).toBe(0);
    await set({ "data/pi/backtest-at": "1000\n", "data/sync-hold": null });
    expect(made((await loop()).calls)).toBe(1);
  });
});

// The watchdog: a loop that stops coming round ends the timer with 70, which the host restarts on
// and alerts about; a loop that comes round, under a hold or not, is left alone. The limit is two
// seconds here and each check one, in place of the minutes and the minute.
describe("lib/sync-timer and its watchdog", { timeout: 30_000 }, () => {
  let root = "";
  let script = "";
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-watchdog-"));
    script = await setUp(root, "sync-timer", (source) => {
      expect(source).toContain('"$((stall * 60))" 60 &');
      expect(source).toContain("  sleep 120 &\n");
      return source.replace('"$((stall * 60))" 60 &', "2 1 &").replace("  sleep 120 &\n", "  sleep 1 &\n");
    });
    await writeFile(join(root, "lib", "watchdog"), await readFile(lib("watchdog"), "utf8"));
    await chmod(join(root, "lib", "watchdog"), 0o755);
  });
  afterAll(() => rm(root, { recursive: true, force: true }));
  const run = (ms: number) =>
    spawnSync("sh", [script], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: ms, killSignal: "SIGTERM" });
  const lines = (stderr: string): Record<string, unknown>[] =>
    stderr
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  it("ends the timer with 70 and one watchdog_stalled line when a job holds the loop past the limit", async () => {
    // The sync does not come back: the loop is stuck in its wait.
    await writeFile(join(root, "pi-sync.sleep"), "20");
    const stuck = run(15_000);
    await rm(join(root, "pi-sync.sleep"), { force: true });
    expect(stuck.status).toBe(70);
    expect(lines(stuck.stderr)).toContainEqual(
      expect.objectContaining({ event: "watchdog_stalled", level: "error", counts: { minutes: 0 } }),
    );
  });

  it("leaves a loop that comes round alone, the sync hold's among them", async () => {
    await writeFile(join(root, "data", "sync-hold"), "");
    const held = run(5_000);
    await rm(join(root, "data", "sync-hold"), { force: true });
    // Ended by the test's own TERM, which the timer's trap ends with 0, never by the watchdog.
    expect(held.status).toBe(0);
    expect(lines(held.stderr).some((line) => line.event === "watchdog_stalled")).toBe(false);
  });

  it("reads its minutes from the volume, and takes 90 for a value out of range", async () => {
    const source = await readFile(lib("sync-timer"), "utf8");
    expect(source).toContain("/data/pi/watchdog-minutes");
    expect(source).toContain('[ "$stall" -ge 10 ] && [ "$stall" -le 1440 ] || stall=90');
  });
});

describe("lib/sync-timer and the stopped-job check's rows", { timeout: 30_000 }, () => {
  let root = "";
  let script = "";
  const DAILY = ["dream", "extract", "reasoner", "outcome_test", "improvement_filing"];
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-daily-timer-"));
    script = await setUp(root, "sync-timer", (source) => source.replace("  sleep 120 &\n  wait $!\n", "  exit 0\n"));
    for (const name of ["run/extract.env", "data/extract-on", "run/tester-on.env"])
      await writeFile(join(root, name), "");
    await writeFile(join(root, "pi-admin.health.dream-due.out"), "not_due\n");
    // The nightly pass has a time limit set, so it is not paused for want of one.
    await writeFile(join(root, "data/pi/dream-nightly-seconds"), "1800\n");
    await writeFile(join(root, "data/pi/dream-nightly-usd"), "25\n");
  });
  afterAll(() => rm(root, { recursive: true, force: true }));
  const loop = async (): Promise<string[]> => {
    for (const name of ["calls", "data/pi/sync-full-at"]) await rm(join(root, name), { force: true });
    spawnSync("sh", [script], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    return (await readFile(join(root, "calls"), "utf8").catch(() => "")).split("\n").filter((one) => one !== "");
  };
  const jobs = (calls: string[], code: string): string[] =>
    calls
      .filter((call) => call.startsWith("pi-admin health job ") && call.split(" ")[4] === code)
      .map((call) => call.split(" ")[3] ?? "");

  // A box whose timer recorded only failed runs before, or that was down for days, holds last rows
  // older than the check's window for jobs that are well.
  it("a start records each daily job once before anything runs, and the coverage record comes after the loop's job records", async () => {
    const calls = await loop();
    const at = (call: string): number => calls.findIndex((one) => one.startsWith(call));
    expect(jobs(calls, "lane_off")).toEqual(DAILY);
    const seen = calls.map((call, index) => (call.includes(" lane_off ") ? index : -1)).filter((index) => index >= 0);
    expect(Math.max(...seen)).toBeLessThan(at("pi-sync sync"));
    const record = at("pi-admin status --coverage --record");
    expect(record).toBeGreaterThan(Math.max(...seen));
    // The waited tick and reasoner run before the record reads the loop's rows. The filing pass runs
    // in the background, as extract does, and is recorded when it ends: a record that comes before
    // it reads its row at the next full loop.
    for (const job of ["reasoner", "improvement_filing"])
      expect(at(`pi-admin health job ${job} ok`), job).toBeGreaterThanOrEqual(0);
    expect(at("pi-work work tick")).toBeLessThan(record);
  });

  it("a start whose record fails is tried again, and says so", async () => {
    await writeFile(join(root, "pi-admin.status"), "1");
    const { stderr } = spawnSync("sh", [script], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    await rm(join(root, "pi-admin.status"));
    expect(stderr).toContain('"event":"health_unrecorded"');
  });

  it("under the sync hold nothing starts, and each daily job is recorded lane_off once a UTC day", async () => {
    await writeFile(join(root, "data/sync-hold"), "");
    const held = await loop();
    expect(held.some((call) => /^pi-(sync|extract|work|reasoner|tester)/.test(call))).toBe(false);
    expect(held.some((call) => call.startsWith("pi-admin status --coverage"))).toBe(false);
    expect(jobs(held, "lane_off")).toEqual(DAILY);
    // The same day: no second row.
    expect(jobs(await loop(), "lane_off")).toEqual([]);
    // Another day's mark is recorded over.
    await writeFile(join(root, "data/pi/extract-off-day"), "2000-01-01\n");
    expect(jobs(await loop(), "lane_off")).toEqual(["extract"]);
    await rm(join(root, "data/sync-hold"));
  });
});

// The filing pass (up to 10 minutes) runs in the background, so it never delays the next sync. The
// reasoner (up to 20) is waited for: a sync's source deletions must not land while a run that read
// those items is still writing.
describe("lib/sync-timer: the filing pass never holds up a sync, and the reasoner never overlaps one", {
  timeout: 30_000,
}, () => {
  let root = "";
  let script = "";
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-background-timer-"));
    // Two loops in one timer, with no wait between them.
    script = await setUp(root, "sync-timer", (source) =>
      source.replace("  sleep 120 &\n  wait $!\n", '  loops=$((loops + 1))\n  [ "$loops" -lt 2 ] || exit 0\n'),
    );
    await writeFile(join(root, "run/extract.env"), "");
    await writeFile(join(root, "pi-admin.health.dream-due.out"), "not_due\n");
    // Each takes two seconds; everything else ends at once.
    await writeFile(join(root, "pi-reasoner.sleep"), "2");
    await writeFile(join(root, "pi-admin.improvements.file.sleep"), "2");
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it("starts the next loop's sync while the filing pass still runs, and only after the reasoner ended", async () => {
    spawnSync("sh", [script], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    const calls = (await readFile(join(root, "calls"), "utf8")).split("\n").filter((one) => one !== "");
    const at = (call: string): number => calls.findIndex((one) => one.replace(/ +/g, " ").startsWith(call));
    const syncs = calls.flatMap((one, index) => (one.startsWith("pi-sync sync") ? [index] : []));
    expect(syncs).toHaveLength(2);
    const second = syncs[1] as number;
    // The first loop's reasoner ended before the second loop's sync; the filing pass had not.
    expect(at("pi-reasoner done")).toBeLessThan(second);
    expect(at("pi-admin improvements file done")).toBeGreaterThan(second);
    // The tick still runs in each loop, waited for.
    expect(calls.filter((one) => one.startsWith("pi-work work tick"))).toHaveLength(2);
    // One reasoner run a loop, each recorded once it ended.
    expect(calls.filter((one) => one === "pi-reasoner ")).toHaveLength(2);
    // (Besides the start's lane_off row, which every start writes.)
    expect(
      calls.filter((one) => one.startsWith("pi-admin health job reasoner ") && !one.includes(" lane_off ")),
    ).toEqual([
      expect.stringMatching(/^pi-admin health job reasoner ok --started \d+$/),
      expect.stringMatching(/^pi-admin health job reasoner ok --started \d+$/),
    ]);
    expect(at("pi-admin health job reasoner ok")).toBeGreaterThan(at("pi-reasoner done"));
    expect(at("pi-admin health job improvement_filing ok")).toBeGreaterThan(at("pi-admin improvements file done"));
    // Each under its limit.
    const limits = await readFile(join(root, "limits"), "utf8");
    expect(limits).toContain("1200 pi-reasoner ");
    expect(limits).toContain("600 pi-admin improvements");
  });
});

describe("lib/sync-timer and the standing check", { timeout: 30_000 }, () => {
  let root = "";
  let script = "";
  const today = new Date().toISOString().slice(0, 10);
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-canary-timer-"));
    script = await setUp(root, "sync-timer", (source) => source.replace("  sleep 120 &\n  wait $!\n", "  exit 0\n"));
    await writeFile(join(root, "lib", "canary-run"), stub(root, "canary-run"));
    await chmod(join(root, "lib", "canary-run"), 0o755);
    await writeFile(join(root, "run/extract.env"), "");
    await writeFile(join(root, "data/extract-on"), "");
  });
  afterAll(() => rm(root, { recursive: true, force: true }));
  const loop = async (): Promise<string[]> => {
    for (const name of ["calls", "data/pi/sync-full-at"]) await rm(join(root, name), { force: true });
    spawnSync("sh", [script], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    // spawnSync returns once the piped streams close, so after the background subshell's calls.
    return (await readFile(join(root, "calls"), "utf8").catch(() => "")).split("\n").filter((one) => one !== "");
  };
  const ran = (calls: string[]): number => calls.filter((one) => one.startsWith("canary-run ")).length;
  const on = async (): Promise<void> => {
    await writeFile(join(root, "run/admin.env"), "PI_CANARY_TOKENS=/data/pi/canary-tokens.json\n");
    await writeFile(join(root, "data/pi/canary-tokens.json"), "{}");
    await rm(join(root, "data/pi/canary-day"), { force: true });
    await rm(join(root, "data/pi/canary-tries"), { force: true });
    await rm(join(root, "canary-run.out"), { force: true });
    await rm(join(root, "canary-run.status"), { force: true });
  };

  it("starts nothing until PI_CANARY puts its lines in admin.env and setup has made its tokens", async () => {
    await writeFile(join(root, "run/admin.env"), "");
    await writeFile(join(root, "data/pi/canary-tokens.json"), "{}");
    expect(ran(await loop())).toBe(0);
    await writeFile(join(root, "run/admin.env"), "PI_CANARY_TOKENS=/data/pi/canary-tokens.json\n");
    await rm(join(root, "data/pi/canary-tokens.json"), { force: true });
    expect(ran(await loop())).toBe(0);
  });

  it("runs once a day, before the loop's extract, and a second loop that day runs nothing", async () => {
    await on();
    const calls = await loop();
    expect(ran(calls)).toBe(1);
    const at = (start: string): number => calls.findIndex((one) => one.startsWith(start));
    expect(at("canary-run ")).toBeLessThan(at("pi-extract extract"));
    expect(calls[at("canary-run ")]).toContain(today);
    expect(await readFile(join(root, "data/pi/canary-day"), "utf8")).toBe(`${today}\n`);
    expect(ran(await loop())).toBe(0);
  });

  it("a busy try is no try; a failure is one fixed row and at most two tries a day", async () => {
    await on();
    await writeFile(join(root, "canary-run.out"), "busy\n");
    expect(ran(await loop())).toBe(1);
    await expect(readFile(join(root, "data/pi/canary-tries"), "utf8")).rejects.toThrow();
    await rm(join(root, "canary-run.out"), { force: true });
    await writeFile(join(root, "canary-run.status"), "1");
    const failed = await loop();
    expect(ran(failed)).toBe(1);
    expect(failed.some((one) => one.startsWith("pi-admin health job canary exit_1 --started"))).toBe(true);
    expect(ran(await loop())).toBe(1);
    expect(await readFile(join(root, "data/pi/canary-tries"), "utf8")).toBe(`${today} 2\n`);
    expect(ran(await loop())).toBe(0);
  });

  it("is held back by extract's gates and a hold", async () => {
    await on();
    await rm(join(root, "data/extract-on"), { force: true });
    expect(ran(await loop())).toBe(0);
    await writeFile(join(root, "data/extract-on"), "");
  });
});

describe("lib/canary-run", { timeout: 30_000 }, () => {
  let root = "";
  let script = "";
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-canary-run-"));
    script = await setUp(root, "canary-run", (source) => source);
  });
  afterAll(() => rm(root, { recursive: true, force: true }));
  const run = async (): Promise<{ calls: string[]; stdout: string }> => {
    await rm(join(root, "calls"), { force: true });
    const { stdout } = spawnSync("sh", [script, "2026-11-04", "1800000000"], {
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });
    const calls = (await readFile(join(root, "calls"), "utf8").catch(() => "")).split("\n").filter((one) => one !== "");
    return { calls, stdout };
  };

  it("runs its six steps in order and prints the check's lines, whatever a step before it ended with", async () => {
    await writeFile(join(root, "pi-admin.canary.check.out"), "gmail ok\n");
    await writeFile(join(root, "pi-extract.status"), "1");
    const { calls, stdout } = await run();
    await rm(join(root, "pi-extract.status"), { force: true });
    expect(calls).toEqual([
      "pi-sync canary plant --day 2026-11-04",
      "pi-extract extract --canary --max-calls 30",
      "pi-admin canary answer --day 2026-11-04",
      "pi-sync sync --records",
      "pi-extract extract --canary --max-calls 30",
      "pi-admin canary check --day 2026-11-04 --started 1800000000",
    ]);
    expect(stdout).toBe("gmail ok\n");
  });

  it("hands the check `--budget` when an extraction found the day's budget spent", async () => {
    await writeFile(join(root, "pi-extract.extract.--canary.out"), "budget\n");
    const { calls } = await run();
    await rm(join(root, "pi-extract.extract.--canary.out"), { force: true });
    expect(calls.at(-1)).toBe("pi-admin canary check --day 2026-11-04 --started 1800000000 --budget");
  });

  it("stops at `busy`, and at a hold set before a step, with no check", async () => {
    await writeFile(join(root, "pi-sync.canary.plant.out"), "busy\n");
    const locked = await run();
    expect(locked.calls).toEqual(["pi-sync canary plant --day 2026-11-04"]);
    expect(locked.stdout).toBe("busy\n");
    await rm(join(root, "pi-sync.canary.plant.out"), { force: true });
    await writeFile(join(root, "data/read-hold"), "");
    const held = await run();
    await rm(join(root, "data/read-hold"), { force: true });
    expect(held).toEqual({ calls: [], stdout: "busy\n" });
  });
});

// The host's pre-deploy step: a deploy whose migration only the owner's run applies, or whose
// database cannot be read, never replaces the running box. Root's own steps are left out here.
describe("lib/predeploy", { timeout: 30_000 }, () => {
  const made: string[] = [];
  afterAll(async () => {
    for (const root of made) await rm(root, { recursive: true, force: true });
  });
  const URL = "postgres://pi_admin:secret-value@db.internal:5432/pi";
  const deploy = async (answer: string | null, env: Record<string, string> = { PI_DATABASE_URL_ADMIN: URL }) => {
    const root = await mkdtemp(join(tmpdir(), "pi-predeploy-"));
    made.push(root);
    const script = await setUp(root, "predeploy", (source) => {
      for (const part of [
        '[ "$(id -u)" -eq 0 ] || { say not_root error; exit 1; }\n',
        "-o root -g pi ",
        "chown pi:pi",
        "|| sleep 10\n",
      ])
        expect(source).toContain(part);
      return source
        .replace('[ "$(id -u)" -eq 0 ] || { say not_root error; exit 1; }\n', "")
        .replace("-o root -g pi ", "")
        .replace("chown pi:pi", ": ")
        .replace("|| sleep 10\n", "|| :\n");
    });
    await writeFile(join(root, "lib", "as-pi"), stub(root, "as-pi"));
    await chmod(join(root, "lib", "as-pi"), 0o755);
    if (answer !== null) await writeFile(join(root, "as-pi.predeploy.db.out"), answer);
    else await writeFile(join(root, "as-pi.status"), "1");
    const run = spawnSync("sh", [script], { env: { PATH: "/usr/bin:/bin", ...env }, encoding: "utf8" });
    const calls = (await readFile(join(root, "calls"), "utf8").catch(() => "")).split("\n").filter((one) => one !== "");
    return {
      status: run.status,
      codes: run.stderr
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => (JSON.parse(line) as { code: string }).code),
      calls,
      left: await readFile(join(root, "run", "predeploy.env"), "utf8").catch(() => null),
      raw: run.stderr,
    };
  };

  it("lets a deploy through when nothing waits, or when the box's start migrates by itself", async () => {
    expect(await deploy("none\n")).toMatchObject({ status: 0, codes: ["current"], left: null });
    expect(await deploy("unattended\n")).toMatchObject({ status: 0, codes: ["migrates_at_start"], left: null });
  });

  it("refuses a deploy whose migration only the owner applies, or whose database does not answer", async () => {
    expect(await deploy("owner\n")).toMatchObject({ status: 1, codes: ["needs_owner"], left: null });
    const unread = await deploy(null);
    expect(unread).toMatchObject({ status: 1, codes: ["pending_unread"], left: null });
    // Asked six times, as the box's start asks.
    expect(unread.calls).toEqual(Array(6).fill("as-pi predeploy db pending --deploy"));
    expect(await deploy("none\n", {})).toMatchObject({ status: 1, codes: ["missing_env"] });
  });

  it("never puts the admin URL in an argument or on its output", async () => {
    const ran = await deploy("none\n");
    expect(ran.calls.join("\n")).not.toContain("secret-value");
    expect(ran.raw).not.toContain("secret-value");
  });
});

// The container's own migration: lib/migrate-start with `pi db pending` (through as-pi) and
// pi-migrate replaced by stubs. pi-migrate's stub notes what each hold file held while it ran.
describe("lib/migrate-start", { timeout: 30_000 }, () => {
  const made: string[] = [];
  afterAll(async () => {
    for (const root of made) await rm(root, { recursive: true, force: true });
  });
  const CREDENTIAL = "data/pi-root/migrate.env";
  const PENDING = { [CREDENTIAL]: "x\n", "as-pi.admin.db.out": "pending\n", "pi-migrate.out": "migrated\n" };
  // The last start's directory, for what a test reads beside what `start` returns.
  let last = "";

  // `touched`: files given a time an hour ahead once all are written, as the owner's later `touch`.
  const start = async (
    files: Record<string, string>,
    touched: string[] = [],
  ): Promise<{
    status: number | null;
    calls: string[];
    codes: string[];
    out: Record<string, unknown>[];
    holds: Record<string, string | null>;
    marker: string | null;
    waiting: string | null;
    log: string;
  }> => {
    const root = await mkdtemp(join(tmpdir(), "pi-migrate-start-"));
    made.push(root);
    last = root;
    const script = await setUp(root, "migrate-start", (source) => {
      expect(source).toContain("|| sleep 10\n");
      return source.replace("|| sleep 10\n", "|| :\n");
    });
    await writeFile(join(root, "lib", "as-pi"), stub(root, "as-pi"));
    await chmod(join(root, "lib", "as-pi"), 0o755);
    await writeFile(
      join(root, "bin", "pi-migrate"),
      `#!/bin/sh\necho "pi-migrate $* read-hold=$(cat ${root}/data/read-hold 2>&1) sync-hold=$(cat ${root}/data/sync-hold 2>&1)" >> ${root}/calls\necho '{"event":"command_failed"}' >&2\ncat ${root}/pi-migrate.out 2> /dev/null\nexit $(cat ${root}/pi-migrate.status 2> /dev/null || echo 0)\n`,
    );
    await chmod(join(root, "bin", "pi-migrate"), 0o755);
    for (const [name, value] of Object.entries(files)) {
      await mkdir(join(root, name, ".."), { recursive: true });
      await writeFile(join(root, name), value);
    }
    const later = new Date(Date.now() + 3_600_000);
    for (const name of touched) await utimes(join(root, name), later, later);
    const run = spawnSync("sh", [script], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    const text = (name: string): Promise<string | null> => readFile(join(root, name), "utf8").catch(() => null);
    const out = run.stderr
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    return {
      status: run.status,
      calls: ((await text("calls")) ?? "").split("\n").filter((one) => one !== ""),
      codes: out.map((line) => `${line.level} ${line.code}`),
      out,
      holds: { read: await text("data/read-hold"), sync: await text("data/sync-hold") },
      marker: await text(MARKER),
      waiting: await text(WAIT),
      log: (await text("data/pi-root/migrate.log")) ?? "",
    };
  };
  const NONE = { read: null, sync: null };
  const HELD = { read: "", sync: "" };
  // What a start that failed leaves: both holds, and the file that names them as this step's.
  const MARKER = "data/pi-root/migrate-holds";
  // The box's wait for the owner's migration, which a start with no credential makes.
  const WAIT = "data/migrate-wait";
  const FAILED_START = { "data/read-hold": "", "data/sync-hold": "", [MARKER]: "read-hold\nsync-hold\n" };

  // With no credential the migration is the owner's `pi-migrate`: the box holds itself and waits.
  const { [CREDENTIAL]: _credential, ...UNATTENDED_OFF } = PENDING;
  const WAITING = {
    ...UNATTENDED_OFF,
    "data/read-hold": "",
    "data/sync-hold": "",
    [MARKER]: "read-hold\nsync-hold\n",
    [WAIT]: "",
  };

  it("without the credential file and with a migration pending, holds reads and sync as its own, says it waits, and runs no migration", async () => {
    expect(await start(UNATTENDED_OFF)).toEqual({
      status: 0,
      calls: ["as-pi admin db pending", "as-pi admin health hold migrate_wait"],
      codes: ["warn waiting"],
      out: [expect.objectContaining({ event: "box_migrate", level: "warn", code: "waiting" })],
      holds: HELD,
      marker: "read-hold\nsync-hold\n",
      waiting: "",
      log: "",
    });
    // The card could not be raised: the box waits and is held all the same.
    const unrecorded = await start({ ...UNATTENDED_OFF, "as-pi.admin.health.status": "1\n" });
    expect(unrecorded.codes).toEqual(["warn waiting", "warn health_unrecorded"]);
    expect({ holds: unrecorded.holds, waiting: unrecorded.waiting }).toEqual({ holds: HELD, waiting: "" });
  });

  // The schema mark `pi http`'s /healthz reads: the host's health check refuses a deploy whose
  // database is behind this image, or whose state could not be read.
  it("marks the schema current after none or migrated, behind while it waits or after a failure, and leaves unknown", async () => {
    const schema = async (files: Record<string, string>): Promise<string | null> => {
      await start({ ...files, "pistate/schema": "unknown\n" });
      return readFile(join(last, "pistate", "schema"), "utf8").catch(() => null);
    };
    expect(await schema({ ...PENDING, "as-pi.admin.db.out": "none\n" })).toBe("current\n");
    expect(await schema(PENDING)).toBe("current\n");
    expect(await schema(UNATTENDED_OFF)).toBe("behind\n");
    expect(await schema({ ...PENDING, "pi-migrate.out": "needs_superuser\n", "pi-migrate.status": "1" })).toBe(
      "behind\n",
    );
    expect(await schema({ ...PENDING, "as-pi.admin.db.out": "\n" })).toBe("unknown\n");
  });

  it("without the credential file and with nothing pending, starts as before: no hold, no wait, one line", async () => {
    expect(await start({ ...UNATTENDED_OFF, "as-pi.admin.db.out": "none\n" })).toEqual({
      status: 0,
      calls: ["as-pi admin db pending"],
      codes: ["info none"],
      out: [expect.objectContaining({ code: "none" })],
      holds: NONE,
      marker: null,
      waiting: null,
      log: "",
    });
  });

  it("a start while it waits, and the one after, wait again with the holds still its own", async () => {
    for (const _ of [1, 2]) {
      const again = await start(WAITING);
      expect(again.calls).toEqual(["as-pi admin db pending", "as-pi admin health hold migrate_wait"]);
      expect(again.codes).toEqual(["warn waiting"]);
      expect({ holds: again.holds, marker: again.marker, waiting: again.waiting }).toEqual({
        holds: HELD,
        marker: "read-hold\nsync-hold\n",
        waiting: "",
      });
    }
  });

  it("while it waits, a hold the owner set before the deploy, or set again since, is not named as its own", async () => {
    const before = await start({ ...UNATTENDED_OFF, "data/read-hold": "", "data/sync-hold": "" });
    expect(before.codes).toEqual(["warn waiting"]);
    expect({ holds: before.holds, marker: before.marker, waiting: before.waiting }).toEqual({
      holds: HELD,
      marker: "",
      waiting: "",
    });
    const one = await start({ ...UNATTENDED_OFF, "data/sync-hold": "" });
    expect({ holds: one.holds, marker: one.marker }).toEqual({ holds: HELD, marker: "read-hold\n" });
    // `pi-read-hold on` while it waited: at the next start the read hold is the owner's.
    const since = await start(WAITING, ["data/read-hold"]);
    expect({ holds: since.holds, marker: since.marker, waiting: since.waiting }).toEqual({
      holds: HELD,
      marker: "sync-hold\n",
      waiting: "",
    });
  });

  it("with nothing pending, clears what a start that waited left: its own holds, their cards, the wait and its card", async () => {
    for (const credential of [{}, { [CREDENTIAL]: "x\n" }]) {
      const cleared = await start({ ...WAITING, ...credential, "as-pi.admin.db.out": "none\n" });
      expect(cleared.calls).toEqual([
        "as-pi admin db pending",
        "as-pi admin health hold read_hold --off",
        "as-pi admin health hold sync_hold --off",
        "as-pi admin health hold migrate_wait --off",
      ]);
      expect(cleared.codes).toEqual(["info none"]);
      expect({ holds: cleared.holds, marker: cleared.marker, waiting: cleared.waiting }).toEqual({
        holds: NONE,
        marker: null,
        waiting: null,
      });
    }
    // A hold the owner set again stays; the rest is cleared.
    const owners = await start({ ...WAITING, "as-pi.admin.db.out": "none\n" }, ["data/sync-hold"]);
    expect(owners.calls.slice(1)).toEqual([
      "as-pi admin health hold read_hold --off",
      "as-pi admin health hold migrate_wait --off",
    ]);
    expect({ holds: owners.holds, marker: owners.marker, waiting: owners.waiting }).toEqual({
      holds: { read: null, sync: "" },
      marker: null,
      waiting: null,
    });
    // What a failed unattended start left, once the owner's run has migrated: the same, with no wait to clear.
    const failed = await start({ ...PENDING, ...FAILED_START, "as-pi.admin.db.out": "none\n" });
    expect(failed.calls.slice(1)).toEqual([
      "as-pi admin health hold read_hold --off",
      "as-pi admin health hold sync_hold --off",
    ]);
    expect({ holds: failed.holds, marker: failed.marker }).toEqual({ holds: NONE, marker: null });
  });

  it("when it cannot learn whether a migration waits, a box that waited stays as it was", async () => {
    const left = await start({ ...WAITING, "as-pi.status": "1\n" });
    expect(left.codes).toEqual(["warn pending_unread"]);
    expect({ holds: left.holds, marker: left.marker, waiting: left.waiting }).toEqual({
      holds: HELD,
      marker: "read-hold\nsync-hold\n",
      waiting: "",
    });
  });

  it("with the credential made since, a start that migrates ends the wait an earlier start left", async () => {
    const { calls, codes, holds, marker, waiting } = await start({ ...WAITING, [CREDENTIAL]: "x\n" });
    expect(calls.slice(1)).toEqual([
      "pi-migrate --auto read-hold= sync-hold=",
      "as-pi admin health hold read_hold --off",
      "as-pi admin health hold sync_hold --off",
      "as-pi admin health hold migrate_wait --off",
    ]);
    expect(codes).toEqual(["info started", "info migrated"]);
    expect({ holds, marker, waiting }).toEqual({ holds: NONE, marker: null, waiting: null });
  });

  it("with nothing pending takes no hold and runs no migration", async () => {
    const { status, calls, codes, holds } = await start({ ...PENDING, "as-pi.admin.db.out": "none\n" });
    expect({ status, calls, codes, holds }).toEqual({
      status: 0,
      calls: ["as-pi admin db pending"],
      codes: ["info none"],
      holds: NONE,
    });
  });

  it("with a migration pending holds reads and sync, runs pi-migrate --auto, and lifts both holds once it migrated", async () => {
    const { status, calls, out, holds, marker, log } = await start(PENDING);
    expect(status).toBe(0);
    expect(calls).toEqual(["as-pi admin db pending", "pi-migrate --auto read-hold= sync-hold="]);
    expect(out.map((line) => [line.event, line.level, line.code])).toEqual([
      ["box_migrate", "info", "started"],
      ["box_migrate", "info", "migrated"],
    ]);
    expect({ holds, marker }).toEqual({ holds: NONE, marker: null });
    // What the migration wrote on its standard error is in root's log, not on the box's output.
    expect(log).toBe('{"event":"command_failed"}\n');
  });

  it("on a failure leaves both holds on, says the code, and raises the read hold's health card at once", async () => {
    const { status, calls, codes, holds, marker } = await start({
      ...PENDING,
      "pi-migrate.out": "needs_superuser\n",
      "pi-migrate.status": "1\n",
    });
    expect(status).toBe(0);
    expect(calls.slice(1)).toEqual(["pi-migrate --auto read-hold= sync-hold=", "as-pi admin health hold read_hold"]);
    expect(codes).toEqual(["info started", "error needs_superuser"]);
    // Both holds stay, named as this step's own in root's directory and not in the hold files.
    expect({ holds, marker }).toEqual({ holds: HELD, marker: "read-hold\nsync-hold\n" });
  });

  it("takes a run that ended 0 without saying migrated, or said it and failed, as a failure", async () => {
    for (const files of [{ "pi-migrate.out": "" }, { "pi-migrate.out": "migrated\n", "pi-migrate.status": "1\n" }]) {
      const { codes, holds } = await start({ ...PENDING, ...files });
      expect(codes).toEqual(["info started", "error migrate_failed"]);
      expect(holds).toEqual(HELD);
    }
  });

  it("never lifts a hold that was on already, whether the migration passed or failed", async () => {
    const owners = { "data/read-hold": "", "data/sync-hold": "" };
    const passed = await start({ ...PENDING, ...owners });
    expect(passed.codes).toEqual(["info started", "info migrated"]);
    expect(passed.holds).toEqual(HELD);
    // One of the two the owner's: only the other is this step's to lift.
    const one = await start({ ...PENDING, "data/sync-hold": "" });
    expect(one.holds).toEqual({ read: null, sync: "" });
    const failed = await start({ ...PENDING, ...owners, "pi-migrate.status": "1\n", "pi-migrate.out": "x\n" });
    expect({ holds: failed.holds, marker: failed.marker }).toEqual({ holds: HELD, marker: "" });
    // The start after that failure passes, and the holds are still the owner's.
    const next = await start({ ...PENDING, ...owners, [MARKER]: "" });
    expect(next.holds).toEqual(HELD);
    // What a hold file holds says nothing of whose it is.
    const worded = await start({ ...PENDING, "data/read-hold": "migrate\n", "data/sync-hold": "migrate\n" });
    expect(worded.holds).toEqual({ read: "migrate\n", sync: "migrate\n" });
  });

  it("at a later start lifts the holds a failed start left, and closes their cards", async () => {
    const { calls, codes, holds, marker } = await start({ ...PENDING, ...FAILED_START });
    expect(calls.slice(1)).toEqual([
      "pi-migrate --auto read-hold= sync-hold=",
      "as-pi admin health hold read_hold --off",
      "as-pi admin health hold sync_hold --off",
    ]);
    expect(codes).toEqual(["info started", "info migrated"]);
    expect({ holds, marker }).toEqual({ holds: NONE, marker: null });
  });

  it("never lifts a hold the owner set again over one a failed start left", async () => {
    // The owner's `touch /data/sync-hold` after the failure: the file is newer than the step's record.
    const { calls, codes, holds, marker } = await start({ ...PENDING, ...FAILED_START }, ["data/sync-hold"]);
    expect(calls.slice(1)).toEqual([
      "pi-migrate --auto read-hold= sync-hold=",
      "as-pi admin health hold read_hold --off",
    ]);
    expect(codes).toEqual(["info started", "info migrated"]);
    expect({ holds, marker }).toEqual({ holds: { read: null, sync: "" }, marker: null });
    // And when that start fails too, the hold is no longer recorded as the step's.
    const failed = await start({ ...PENDING, ...FAILED_START, "pi-migrate.status": "1\n" }, ["data/sync-hold"]);
    expect({ holds: failed.holds, marker: failed.marker }).toEqual({ holds: HELD, marker: "read-hold\n" });
  });

  it("when it cannot learn whether a migration waits, asks six times, then takes no hold and migrates nothing", async () => {
    for (const files of [{ "as-pi.status": "1\n" }, { "as-pi.admin.db.out": "" }, { "as-pi.admin.db.out": "soon\n" }]) {
      const { status, calls, codes, holds, marker } = await start({ ...PENDING, ...files });
      expect(status).toBe(0);
      expect(calls).toEqual(Array("as-pi.status" in files ? 6 : 1).fill("as-pi admin db pending"));
      expect(codes).toEqual(["warn pending_unread"]);
      expect({ holds, marker }).toEqual({ holds: NONE, marker: null });
    }
    // The holds a failed start left stay as they are, for the next start that can ask.
    const left = await start({ ...PENDING, ...FAILED_START, "as-pi.status": "1\n" });
    expect(left.codes).toEqual(["warn pending_unread"]);
    expect({ holds: left.holds, marker: left.marker }).toEqual({ holds: HELD, marker: "read-hold\nsync-hold\n" });
  });

  it("the entrypoint runs it from an empty environment, once the server's address is written and before any process that uses the database", async () => {
    const entrypoint = await readFile(lib("entrypoint"), "utf8");
    const at = (text: string): number => entrypoint.indexOf(text);
    const step = at('\n/usr/bin/env -i PATH="$PATH" /usr/local/lib/pi/migrate-start < /dev/null || :\n');
    expect(step).toBeGreaterThan(at("> /run/pi-root/admin-query"));
    for (const later of [
      "models import-key",
      "/usr/local/lib/pi/agent-keys",
      "http-serve",
      "wake-serve",
      "sync-timer\n",
    ])
      expect(at(later), later).toBeGreaterThan(step);
    expect(step).toBeGreaterThan(at("put work "));
  });
});

describe("lib/heartbeat", { timeout: 30_000 }, () => {
  // One request to the URL read from stdin; 0 for a 2xx answer, 1 for any other or none, and nothing
  // printed.
  const ping = async (status: number): Promise<{ code: number | null; out: string; hits: string[] }> => {
    const hits: string[] = [];
    const server = createServer((request, response) => {
      hits.push(`${request.method} ${request.url}`);
      response.writeHead(status).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const child = spawn(process.execPath, [lib("heartbeat")], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.stderr.on("data", (chunk) => {
        out += chunk;
      });
      child.stdin.end(`http://127.0.0.1:${port}/ping/0b1c\n`);
      const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
      return { code, out, hits };
    } finally {
      server.close();
    }
  };

  it("exits 0 after one request when the check answers 2xx, 1 when it does not, printing nothing", async () => {
    expect(await ping(200)).toEqual({ code: 0, out: "", hits: ["GET /ping/0b1c"] });
    expect(await ping(503)).toEqual({ code: 1, out: "", hits: ["GET /ping/0b1c"] });
  });
});

// The wrapper every caller of extraction goes through: the last place a dream can be stopped.
describe("bin/pi-extract", () => {
  let root = "";
  let script = "";
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-extract-"));
    await mkdir(join(root, "data"), { recursive: true });
    const asPi = join(root, "as-pi");
    await writeFile(asPi, `#!/bin/sh\necho "as-pi $*" >> ${root}/calls\n`);
    await chmod(asPi, 0o755);
    const source = await readFile(join(repoRoot(), "deploy/bin/pi-extract"), "utf8");
    expect(source).toContain("/usr/local/lib/pi/as-pi");
    script = join(root, "pi-extract");
    await writeFile(script, source.replaceAll("/data/", `${root}/data/`).replaceAll("/usr/local/lib/pi/as-pi", asPi));
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  const run = async (...args: string[]): Promise<{ status: number | null; stdout: string; calls: string }> => {
    await rm(join(root, "calls"), { force: true });
    const { status, stdout } = spawnSync("sh", [script, ...args], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    return { status, stdout, calls: await readFile(join(root, "calls"), "utf8").catch(() => "") };
  };

  it("starts no dream while the owner's pause file stands, says so, and runs everything else", async () => {
    await writeFile(join(root, "data", "dream-hold"), "");
    expect(await run("dream")).toEqual({ status: 0, stdout: "dream_paused\n", calls: "" });
    expect(await run("dream", "--max-calls", "5")).toEqual({ status: 0, stdout: "dream_paused\n", calls: "" });
    expect((await run("extract", "--agent-records")).calls).toBe("as-pi extract extract --agent-records\n");
    await rm(join(root, "data", "dream-hold"));
    expect((await run("dream")).calls).toBe("as-pi extract dream\n");
  });
});

describe("lib/supervise and lib/rotate-logs", () => {
  let root = "";
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-supervise-"));
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it("starts the command with a start and an end line, and stops on the exit code it was given", async () => {
    const script = await setUp(root, "supervise", (source) => source);
    const log = join(root, "data", "pi", "x.log");
    const { status } = spawnSync("sh", [script, "x", log, "--stop", "3", "--", "sh", "-c", "echo said >&2; exit 3"], {
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });
    expect(status).toBe(0);
    const lines = (await readFile(log, "utf8")).trim().split("\n");
    expect(JSON.parse(lines[0] ?? "")).toEqual({ event: "x_start", at: expect.any(String), level: "info" });
    expect(lines[1]).toBe("said");
    expect(JSON.parse(lines[2] ?? "")).toEqual({
      event: "x_end",
      at: expect.any(String),
      level: "warn",
      code: "exit_3",
    });
  });

  // The fast exits in a row, in --state's file, for the timer.
  it("counts the fast exits in a row in its state file", async () => {
    const script = await setUp(root, "supervise", (source) => {
      expect(source).toContain("sleep 5\n    left=");
      return source.replace("sleep 5\n    left=", "sleep 0\n    left=");
    });
    const log = join(root, "data", "pi", "y.log");
    const state = join(root, "y.restarts");
    const runs = join(root, "y.runs");
    // Two fast failures, then the stop code on the third run.
    const command = `n=$(( $(cat "${runs}" 2> /dev/null || echo 0) + 1 )); echo "$n" > "${runs}"; [ "$n" -lt 3 ] || exit 3; exit 1`;
    const { status } = spawnSync("sh", [script, "y", log, "--state", state, "--stop", "3", "--", "sh", "-c", command], {
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });
    expect(status).toBe(0);
    expect(await readFile(state, "utf8")).toBe("2\n");
    expect((await readFile(log, "utf8")).match(/"y_end"/g)).toHaveLength(3);
  });

  // A read hold ends the process and is lifted when the migration has run: neither is a fault of the
  // process, so neither may leave it waiting out a backoff.
  describe("across a hold", { timeout: 20_000 }, () => {
    const until = async (done: () => Promise<boolean>): Promise<void> => {
      for (let tries = 0; tries < 200 && !(await done()); tries += 1)
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await done()).toBe(true);
    };
    const exists = (path: string): Promise<boolean> =>
      readFile(path, "utf8").then(
        () => true,
        () => false,
      );
    // Every wait is the longest there is, so a start that waits one out never comes in time.
    const longBackoff = (source: string): string => {
      expect(source).toContain("wait_s=5\nheld=");
      expect(source).toContain("sleep 5");
      return source.replace("wait_s=5\nheld=", "wait_s=300\nheld=").replaceAll("sleep 5", "sleep 0.1");
    };
    const started = (script: string, name: string, args: string[]): Promise<number | null> =>
      new Promise((resolve) => {
        spawn("sh", [script, name, join(root, "data", "pi", `${name}.log`), ...args], {
          env: { PATH: "/usr/bin:/bin" },
          stdio: "ignore",
        }).on("exit", resolve);
      });

    it("starts the process at once after a hold set during its backoff is lifted", async () => {
      const script = await setUp(root, "supervise", longBackoff);
      const [hold, runs] = [join(root, "h1.hold"), join(root, "h1.runs")];
      const command = `n=$(( $(cat "${runs}" 2> /dev/null || echo 0) + 1 )); echo "$n" > "${runs}"; [ "$n" -lt 2 ] || exit 3; exit 1`;
      const ended = started(script, "h1", ["--hold", hold, "--stop", "3", "--", "sh", "-c", command]);
      await until(() => exists(runs));
      await writeFile(hold, "");
      await until(async () => (await readFile(join(root, "data", "pi", "h1.log"), "utf8")).includes('"h1_held"'));
      await rm(hold);
      expect(await ended).toBe(0);
    });

    it("counts a process a hold ended as no fast exit, and starts it at once when the hold is lifted", async () => {
      const script = await setUp(root, "supervise", longBackoff);
      const [hold, runs, state] = [join(root, "h2.hold"), join(root, "h2.runs"), join(root, "h2.restarts")];
      // The first run ends when the hold is set, as pi-read-hold's kill ends it.
      const command = `n=$(( $(cat "${runs}" 2> /dev/null || echo 0) + 1 )); echo "$n" > "${runs}"; [ "$n" -lt 2 ] || { cat "${state}" > "${state}.seen"; exit 3; }; while [ ! -e "${hold}" ]; do sleep 0.05; done; exit 143`;
      const ended = started(script, "h2", ["--hold", hold, "--state", state, "--stop", "3", "--", "sh", "-c", command]);
      await until(() => exists(runs));
      await writeFile(hold, "");
      await until(async () => (await readFile(join(root, "data", "pi", "h2.log"), "utf8")).includes('"h2_held"'));
      await rm(hold);
      expect(await ended).toBe(0);
      expect(await readFile(`${state}.seen`, "utf8")).toBe("0\n");
    });
  });

  // The agent API's port while the read hold stands: the held answer in `pi http`'s place, never
  // beside it.
  it("while a hold stands runs --while-held's command, and ends it before the command starts, every time", {
    timeout: 30_000,
  }, async () => {
    const script = await setUp(root, "supervise", (source) => {
      expect(source).toContain("sleep 5");
      return source.replaceAll("sleep 5", "sleep 0.1");
    });
    const port = await freePort();
    const [hold, bound] = [join(root, "h3.hold"), join(root, "h3.bound")];
    const log = join(root, "data", "pi", "h3.log");
    await writeFile(hold, "");
    // --while-held's words are split on spaces, as on the box, whose paths hold none: a copy in the
    // temporary folder keeps a checkout path with a space from splitting the command.
    const answer = join(root, "held-answer");
    await writeFile(answer, await readFile(HELD));
    // The command stands for `pi http`: it binds the same port and notes its pid, or notes `refused`
    // and exits 1 when the port is still taken.
    const command = `const fs = require("node:fs"); require("node:http").createServer((q, s) => s.end("served")).on("error", () => { fs.appendFileSync(${JSON.stringify(bound)}, "refused\\n"); process.exit(1); }).listen(${port}, () => fs.appendFileSync(${JSON.stringify(bound)}, process.pid + "\\n"));`;
    const child = spawn(
      "sh",
      [
        script,
        "h3",
        log,
        "--hold",
        hold,
        "--while-held",
        `${process.execPath} ${answer} ${port}`,
        "--",
        process.execPath,
        "-e",
        command,
      ],
      { env: { PATH: "/usr/bin:/bin" }, stdio: "ignore", detached: true },
    );
    const answered = async (text: string): Promise<boolean> => (await ask(port))?.text === text;
    try {
      await waitUntil(() => answered(UNAVAILABLE));
      expect(await readFile(bound, "utf8").catch(() => "")).toBe("");
      await rm(hold);
      await waitUntil(() => answered("served"));
      // pi-read-hold: the hold, then the command ended.
      await writeFile(hold, "");
      process.kill(Number((await readFile(bound, "utf8")).trim()), "SIGTERM");
      await waitUntil(() => answered(UNAVAILABLE));
      await rm(hold);
      await waitUntil(() => answered("served"));
      // Each start found the port free: the held answer had ended first.
      expect((await readFile(bound, "utf8")).trim().split("\n")).toEqual([
        expect.stringMatching(/^\d+$/),
        expect.stringMatching(/^\d+$/),
      ]);
      const events = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event: string; code?: string });
      expect(events.map(({ event, code }) => (code === undefined ? event : `${event} ${code}`))).toEqual([
        "h3_held h3.hold",
        "h3_start",
        "h3_end exit_143",
        "h3_held h3.hold",
        "h3_start",
      ]);
    } finally {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    }
  });

  it("starts the held answer again, and says so, when it ends while the hold still stands", {
    timeout: 20_000,
  }, async () => {
    const script = await setUp(root, "supervise", (source) => source.replaceAll("sleep 5", "sleep 0.1"));
    const [hold, runs] = [join(root, "h4.hold"), join(root, "h4.runs")];
    const log = join(root, "data", "pi", "h4.log");
    await writeFile(hold, "");
    // A held answer that ends at once, twice: the third run lifts the hold.
    const held = join(root, "h4-held");
    await writeFile(
      held,
      `#!/bin/sh\nn=$(( $(cat "${runs}" 2> /dev/null || echo 0) + 1 )); echo "$n" > "${runs}"; [ "$n" -lt 3 ] || rm -f "${hold}"; exit 1\n`,
    );
    await chmod(held, 0o755);
    const { status } = spawnSync(
      "sh",
      [script, "h4", log, "--hold", hold, "--while-held", held, "--stop", "3", "--", "sh", "-c", "exit 3"],
      { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 15_000 },
    );
    expect(status).toBe(0);
    const codes = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; code?: string; level: string })
      .map(({ event, code, level }) => `${level} ${event}${code === undefined ? "" : ` ${code}`}`);
    expect(codes).toEqual([
      "info h4_held h4.hold",
      "warn h4_held_answer_end exit_1",
      "warn h4_held_answer_end exit_1",
      "info h4_start",
      "warn h4_end exit_3",
    ]);
  });

  // A supervisor killed while a hold stands leaves no held answer, and no watcher, behind.
  it("ends the held answer and its watcher when the supervisor is killed while a hold stands", {
    timeout: 20_000,
  }, async () => {
    const script = await setUp(root, "supervise", (source) => source.replaceAll("sleep 5", "sleep 0.1"));
    const [hold, answering] = [join(root, "h5.hold"), join(root, "h5.answering")];
    const log = join(root, "data", "pi", "h5.log");
    await writeFile(hold, "");
    // A held answer that notes its pid and stands until it is ended.
    const held = join(root, "h5-held");
    await writeFile(
      held,
      `#!/bin/sh
echo $$ > "${answering}"
exec sleep 30
`,
    );
    await chmod(held, 0o755);
    const child = spawn("sh", [script, "h5", log, "--hold", hold, "--while-held", held, "--", "sh", "-c", "exit 3"], {
      env: { PATH: "/usr/bin:/bin" },
      stdio: "ignore",
      detached: true,
    });
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await waitUntil(async () => (await readFile(answering, "utf8").catch(() => "")).trim() !== "");
      const answer = Number((await readFile(answering, "utf8")).trim());
      expect(alive(answer)).toBe(true);
      // The supervisor alone, as a stop of its container's process would end it; the hold stays.
      process.kill(child.pid as number, "SIGKILL");
      await waitUntil(async () => !alive(answer));
      expect(alive(answer)).toBe(false);
    } finally {
      if (child.pid !== undefined)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The group is already gone.
        }
    }
  });

  it("rotates a log past its size while its writer runs, and the writer goes on in the emptied file", {
    timeout: 20_000,
  }, async () => {
    const log = join(root, "w.log");
    await writeFile(log, "x".repeat(2000));
    // The rotation's parent: a shell that appends to the log, then waits.
    const parent = spawn(
      "sh",
      [
        "-c",
        `ROTATE_EVERY=1 ROTATE_BYTES=1000 sh "${lib("rotate-logs")}" "${log}" & sleep 2; echo after >> "${log}"; sleep 1; kill $!`,
      ],
      { stdio: "ignore" },
    );
    await new Promise((done) => parent.on("exit", done));
    expect((await readFile(`${log}.1`, "utf8")).length).toBe(2000);
    expect(await readFile(log, "utf8")).toBe("after\n");
  });
});

// One request to the port on loopback, on a connection of its own: its status, headers and body, or
// null when nothing answers.
const ask = (
  port: number,
  method = "GET",
  path = "/healthz",
  body?: string,
): Promise<{ status: number; headers: Record<string, unknown>; text: string } | null> =>
  new Promise((resolve) => {
    const options = { host: "127.0.0.1", port, method, path, agent: false, timeout: 2_000 };
    // Asked to keep the connection open, so an answer that closes it shows.
    const sent = request({ ...options, headers: { connection: "keep-alive" } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        text += chunk;
      });
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, headers: { ...response.headers }, text });
        sent.destroy();
      });
      response.on("error", () => resolve(null));
    });
    sent.on("error", () => resolve(null));
    sent.on("timeout", () => sent.destroy());
    sent.end(body);
  });

const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
};

const waitUntil = async (done: () => Promise<boolean>): Promise<void> => {
  for (let tries = 0; tries < 200 && !(await done()); tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 50));
  expect(await done()).toBe(true);
};

const HELD = lib("held-answer");
const UNAVAILABLE = '{"error":"unavailable"}';

describe("lib/held-answer", { timeout: 20_000 }, () => {
  const started = (args: string[]) => {
    const child = spawn(process.execPath, [HELD, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      out += chunk;
    });
    const ended = new Promise<number | null>((resolve) => child.on("exit", resolve));
    return { child, ended, out: () => out };
  };

  it("answers every request as `pi http` answers one under the read hold, /healthz included, and prints nothing", async () => {
    const port = await freePort();
    const held = started([String(port)]);
    try {
      await waitUntil(async () => (await ask(port)) !== null);
      // `pi http` itself under the hold, for the headers it sends: its held routes read no port.
      const silent: PersonalLogger = { info: () => {}, warn: () => {}, error: () => {} };
      const real = serveHttp({} as Parameters<typeof serveHttp>[0], silent, { held: () => true });
      await new Promise<void>((resolve) => real.listen(0, "127.0.0.1", resolve));
      const realPort = (real.address() as AddressInfo).port;
      const comparable = (answer: Awaited<ReturnType<typeof ask>>) => {
        const { date: _date, ...headers } = answer?.headers ?? {};
        return { status: answer?.status, headers, text: answer?.text };
      };
      try {
        // A read, and a push, which `pi http` answers before its body is read and closes after.
        for (const [method, path, body] of [
          ["GET", "/v1/tools", undefined],
          ["POST", "/v1/tools/push_capture", "{}"],
        ] as const) {
          const theirs = comparable(await ask(realPort, method, path, body));
          expect(theirs).toMatchObject({ status: 503, text: UNAVAILABLE });
          expect(comparable(await ask(port, method, path, body)), path).toEqual(theirs);
        }
      } finally {
        await new Promise((resolve) => real.close(resolve));
      }
      const answers = await Promise.all([
        ask(port, "GET", "/healthz"),
        ask(port, "POST", "/mcp", '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'),
        ask(port, "POST", "/v1/tools/search", '{"query":"Jo Example"}'),
        ask(port, "GET", "/openapi.json"),
        ask(port, "GET", "/.well-known/oauth-authorization-server"),
        ask(port, "POST", "/v1/tools/push_capture", "x".repeat(200_000)),
        ask(port, "DELETE", "/no/such/route?x=1"),
      ]);
      for (const answer of answers) {
        expect(answer).toMatchObject({
          status: 503,
          text: UNAVAILABLE,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
        expect(answer?.headers).not.toHaveProperty("retry-after");
      }
      // A request with a body is answered before the body is read, and its connection closed.
      expect(answers[1]?.headers.connection).toBe("close");
      expect(answers[0]?.headers.connection).toBe("keep-alive");
      expect(held.out()).toBe("");
    } finally {
      held.child.kill("SIGKILL");
    }
  });

  it("refuses a port that is not one, with nothing printed and nothing bound", async () => {
    for (const args of [[], [""], ["0"], ["65536"], ["80 81"], ["8o"], ["-1"]]) {
      const held = started(args);
      expect(await held.ended, JSON.stringify(args)).toBe(2);
      expect(held.out()).toBe("");
    }
  });

  it("ends when its parent does, so no orphan keeps the port", async () => {
    const port = await freePort();
    const parent = spawn("sh", ["-c", `"${process.execPath}" "${HELD}" ${port} & sleep 1`], { stdio: "ignore" });
    await waitUntil(async () => (await ask(port))?.status === 503);
    await new Promise((resolve) => parent.on("exit", resolve));
    await waitUntil(async () => (await ask(port)) === null);
  });

  it("http-serve runs it on the port the entrypoint hands it, and runs none for a port that is not one", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-http-serve-"));
    try {
      const script = await setUp(root, "http-serve", (source) => source);
      await writeFile(join(root, "lib", "supervise"), `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > ${root}/args\n`);
      await chmod(join(root, "lib", "supervise"), 0o755);
      const args = async (port: string | undefined): Promise<string[]> => {
        spawnSync("sh", [script, ...(port === undefined ? [] : [port])], { env: { PATH: "/usr/bin:/bin" } });
        return (await readFile(join(root, "args"), "utf8")).trim().split("\n");
      };
      const tail = ["--", `${root}/lib/mcp-run`, "http", "http"];
      const hold = ["--hold", `${root}/data/read-hold`];
      expect(await args("8080")).toEqual([
        "http",
        `${root}/data/pihttp/http.log`,
        "--state",
        "/run/pistate/http.restarts".replace("/run/pistate/", `${root}/pistate/`),
        ...hold,
        "--while-held",
        `${root}/lib/held-answer 8080`,
        ...tail,
      ]);
      for (const port of [undefined, "", "0", "080", "65536", "123456", "80 81", "8o*"])
        expect((await args(port)).includes("--while-held"), String(port)).toBe(false);
      // The port it hands http-serve is the one http.env names for `pi http`.
      const entrypoint = await readFile(lib("entrypoint"), "utf8");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the shell's own text.
      const hostPort = '"${PORT:-8080}"';
      expect(entrypoint).toContain(`/usr/local/lib/pi/http-serve ${hostPort} < /dev/null`);
      expect(entrypoint).toContain(`"PI_HTTP_PORT=${hostPort.slice(1)}`);
      expect(await readFile(join(repoRoot(), "deploy/Dockerfile"), "utf8")).toMatch(
        /(?:personal\/)?deploy\/lib\/held-answer[^\n]*\/usr\/local\/lib\/pi\//,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
