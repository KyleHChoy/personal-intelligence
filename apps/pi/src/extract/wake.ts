import { spawn } from "node:child_process";
import type { PersonalLogger } from "@intelligence/contracts/personal";
import type { CommandContext } from "../command-types.ts";
import { refusal } from "../env.ts";

// `pi extract wake RUN`, as pi_pipeline: it listens for the notice an agent proposal or an owner's
// answer gives when its write commits, waits a moment for the rest of a burst, and starts RUN, the
// box's wake script, which checks the gates the timer checks, takes the records in as the writer
// and runs `pi extract --agent-records`. It holds no key and reads nothing; RUN's processes do the
// work, each with its own role's file, as the timer's do.

// Provisional defaults: the wait for a burst, the wait before trying again when an extraction run
// already held the lock, and the time after which the listener ends so its supervisor can start it
// again on a fresh connection and a rotated log.
const WAKE_DEBOUNCE_MS = 2_000;
const WAKE_RETRY_MS = 15_000;
const WAKE_RENEW_MS = 24 * 60 * 60 * 1000;

// RUN's exit statuses (deploy/lib/wake-run), as the wake's line names them.
const CODES = new Map<number, string>([
  [0, "ok"],
  [3, "held"],
  [4, "intake_failed"],
  [5, "yield"],
  [75, "busy"],
]);
const BUSY = 75;

export type WakeDeps = {
  listen(handlers: { onNotice(): void; onLost(): void }): Promise<{ close(): Promise<void> }>;
  // One wake: RUN's exit status.
  run(): Promise<number>;
  log: PersonalLogger;
  now(): number;
  debounceMs: number;
  retryMs: number;
  renewMs: number;
  signal?: AbortSignal;
};

// Until the connection is lost, the renewal is due or the signal aborts. One wake at the start,
// so a write made while no listener was up waits for nothing. A notice starts the burst's wait if
// none is running; notices during a wake make one more wake after it, never more. One line for
// each wake: its code, the notices it answers and how long it took.
export async function wakeLoop(deps: WakeDeps): Promise<"lost" | "renew" | "stopped"> {
  let notices = 0;
  let lost = false;
  // When the next wake is due; undefined while nothing is waiting.
  let dueAt: number | undefined = deps.now() + deps.debounceMs;
  let nudge = (): void => {};
  const ended = (): boolean => lost || deps.signal?.aborted === true;
  const sleep = (ms: number, early: () => boolean): Promise<void> =>
    new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        nudge = () => {};
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      nudge = () => {
        if (early()) done();
      };
    });
  const listener = await deps.listen({
    onNotice: () => {
      notices += 1;
      dueAt ??= deps.now() + deps.debounceMs;
      nudge();
    },
    onLost: () => {
      lost = true;
      nudge();
    },
  });
  const abort = (): void => nudge();
  deps.signal?.addEventListener("abort", abort);
  const renewAt = deps.now() + deps.renewMs;
  try {
    for (;;) {
      if (ended()) return lost ? "lost" : "stopped";
      if (dueAt === undefined) {
        if (deps.now() >= renewAt) return "renew";
        await sleep(renewAt - deps.now(), () => true);
        continue;
      }
      if (deps.now() < dueAt) {
        await sleep(dueAt - deps.now(), ended);
        continue;
      }
      dueAt = undefined;
      const answered = notices;
      notices = 0;
      const started = deps.now();
      const status = await deps.run();
      if (status === BUSY) dueAt ??= deps.now() + deps.retryMs;
      deps.log.info({
        event: "extract_wake",
        code: CODES.get(status) ?? `exit_${status}`,
        counts: { notices: answered },
        durationMs: Math.max(0, deps.now() - started),
      });
    }
  } finally {
    deps.signal?.removeEventListener("abort", abort);
    await listener.close();
  }
}

// RUN, as its own process, from an empty environment but for the path, with nothing on its
// standard streams: it writes its lines to the box's logs itself.
function runScript(path: string): () => Promise<number> {
  return () =>
    new Promise((resolve) => {
      const child = spawn(path, [], { env: { PATH: "/usr/local/bin:/usr/bin:/bin" }, stdio: "ignore", shell: false });
      child.on("error", () => resolve(127));
      child.on("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
    });
}

export async function extractWake({ positionals, env, log }: CommandContext): Promise<0> {
  const path = positionals[0] ?? "";
  if (!/^\/[A-Za-z0-9._/-]+$/.test(path)) throw refusal("usage");
  const { listenAgentWrites } = await import("@intelligence/personal-store");
  const end = await wakeLoop({
    listen: (handlers) => listenAgentWrites(env.PI_DATABASE_URL_PIPELINE ?? "", log, handlers),
    run: runScript(path),
    log,
    now: Date.now,
    debounceMs: WAKE_DEBOUNCE_MS,
    retryMs: WAKE_RETRY_MS,
    renewMs: WAKE_RENEW_MS,
  });
  log.info({ event: "extract_wake_end", code: end });
  // A lost connection is the command's failure: its supervisor starts it again.
  if (end === "lost") throw refusal("unavailable");
  return 0;
}
