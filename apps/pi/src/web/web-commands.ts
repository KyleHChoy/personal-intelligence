// The commands of the digest and the owner's dashboard: `pi digest`, and `pi web serve`, `link`
// and `stop`, which start the server web.ts holds and speak to its control socket.
import { createConnection } from "node:net";
import { createRestrictedUnlock } from "@intelligence/personal-store";
import { agentJournalRefresh } from "../agents/agent-keys.ts";
import { driveNumberOf } from "../box/env-numbers.ts";
import type { CommandContext } from "../command-types.ts";
import { codeOf, refusal, restrictedKeyFile } from "../env.ts";
import { printJson, withAdmin } from "../owner/owner-kit.ts";
import { untilDone } from "./until-done.ts";
import { type Ended, startWeb, TOKEN, tailscaleOf } from "./web.ts";
import { loadClient } from "./web-client.ts";

// The port the link names when no `ts.net` name is set: the stdio relay's, used only when
// Tailscale is down. The page answers on any port.
const LINK_PORT = 8765;

// One word to the server's control socket, and its one-line answer.
function ask(path: string, word: "link" | "register" | "stop"): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    const connection = createConnection({ path });
    connection.setTimeout(10_000, () => connection.destroy(refusal("unavailable")));
    connection.setEncoding("utf8");
    connection.on("connect", () => connection.write(`${word}\n`));
    connection.on("data", (chunk: string) => (text += chunk));
    connection.on("end", () => resolve(text.trim()));
    connection.on("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? refusal("web_not_running") : error),
    );
  });
}

const SIGNALS = ["SIGINT", "SIGTERM"] as const;

// `pi digest`: the counts, as one JSON document.
export async function digestCommand(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.cards.digest());
  });
}

// `pi web serve`: started by the box's `web-serve` script as `pi`, with no terminal. The key file
// is read once, at the start check. It prints nothing, and serves until SIGINT or SIGTERM (exit 0,
// which the box's supervisor restarts) or `pi web stop` (exit 3, which it does not). The box's
// `--agent-journal`: the journal's mark handed to the agent endpoint after a write (agent-keys.ts).
export async function webServeCommand(context: CommandContext): Promise<0 | 3> {
  const { env, log, deps, values } = context;
  const tailscale = tailscaleOf(env);
  // Read as sync and `pia status` read it: a value that is no whole number refuses the start.
  const driveCeilingBytes = driveNumberOf(env.PI_DRIVE_STORAGE_CEILING_BYTES);
  const folder = env.PI_WEB_CLIENT_DIR ?? "";
  const client = folder === "" ? await loadClient() : await loadClient(folder, { required: true });
  let how = "close" as Ended;
  // With PI_RESTRICTED_KEY_FILE set, the unlock this process alone holds (web-restricted.ts): the
  // Admin sees the restricted keys only while an unlock's window lasts.
  const restrictedPath = restrictedKeyFile(env);
  const unlock = createRestrictedUnlock(deps.now ?? (() => new Date()));
  await withAdmin(
    context,
    async (admin) => {
      // Tried until it lands (a server started before its migration was applied fails at first),
      // while the page serves meanwhile. In the serve loop, not on a first request: the hand-over
      // exists so the owner need not open the page, so a first request may never come. A host the
      // store refuses (`invalid_argument`) cannot heal: it is told once and not tried again.
      let closed = false;
      void untilDone(
        () => admin.work.setOwnerPageHost(tailscale?.host ?? null),
        (error) => log.warn({ event: "web_owner_page_host_failed", code: codeOf(error) }),
        (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
        () => closed,
        { lasting: (error) => codeOf(error) === "invalid_argument" },
      );
      try {
        const web = await startWeb({
          socket: `${env.PI_KEY_FILE ?? ""}.web`,
          admin,
          log,
          client,
          ...(restrictedPath === undefined ? {} : { restricted: { path: restrictedPath, unlock } }),
          ...(tailscale === undefined ? {} : { tailscale }),
          ...(driveCeilingBytes === undefined ? {} : { driveCeilingBytes }),
          ...(deps.now === undefined ? {} : { now: deps.now }),
          ...(values["agent-journal"] === true ? { afterWrite: agentJournalRefresh(env.PI_KEY_FILE ?? "", log) } : {}),
        });
        const stop = (): void => void web.close();
        for (const signal of SIGNALS) process.once(signal, stop);
        try {
          how = await web.closed;
        } finally {
          for (const signal of SIGNALS) process.off(signal, stop);
        }
      } finally {
        // The page has closed, or never started: no more tries at the host.
        closed = true;
      }
      // A room fires its reads at once (Today about ten): two connections queued them in pairs.
    },
    { poolSize: 8, unlock },
  );
  return how === "stop" ? 3 : 0;
}

// `pi web link`: to a terminal only (`commands.ts` refuses any other stdout). A new code from the
// running server, good once within 5 minutes, printed as the link at the `ts.net` name, or at
// localhost when none is set. The last code no longer works. `--register`: a code to register the
// phone's passkey, at the `ts.net` name only, as a link the owner pastes into the page on the phone.
export async function webLinkCommand(context: CommandContext): Promise<0> {
  const { env, io, values } = context;
  const tailscale = tailscaleOf(env);
  const register = values.register === true;
  if (register && tailscale === undefined)
    throw refusal("usage", "a passkey is registered at the page's ts.net name: set PI_WEB_TS_HOST and PI_WEB_TS_LOGIN");
  const code = await ask(`${env.PI_KEY_FILE ?? ""}.web-control`, register ? "register" : "link");
  if (!TOKEN.test(code)) throw refusal("unavailable");
  const origin = tailscale === undefined ? `http://localhost:${LINK_PORT}` : `https://${tailscale.host}`;
  io.stdout.write(`${origin}/${register ? "register" : "login"}?code=${code}\n`);
  return 0;
}

// `pi web stop`: ends the running server at once.
export async function webStopCommand(context: CommandContext): Promise<0> {
  if ((await ask(`${context.env.PI_KEY_FILE ?? ""}.web-control`, "stop")) !== "ok") throw refusal("unavailable");
  return 0;
}
