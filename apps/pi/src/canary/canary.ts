import { access, constants } from "node:fs/promises";
import { dirname } from "node:path";
import { CANARY_CLEARANCE, CANARY_COMPARTMENT, isCanaryCompartment } from "@intelligence/contracts/personal";
import {
  addCompartmentKey,
  boxHostOf,
  createAdmin,
  createWriter,
  journalPath,
  type Keys,
  loadKeys,
} from "@intelligence/personal-store";
import type { CommandContext } from "../command-types.ts";
import { refusal, restrictedKeyFile } from "../env.ts";
import { lanesOffOf } from "../extract/extract-config.ts";
import { runSync } from "../intake/sync.ts";
import { afterSync } from "../intake/sync-command.ts";
import { type CanaryApi, canaryApi, readTokens, writeTokens } from "./api.ts";
import { followAll } from "./check.ts";
import { CANARY_APP, CANARY_LABEL, CANARY_ROOT, canaryPlant } from "./plant.ts";
import { canarySource } from "./source.ts";

// `pi canary`: one day's synthetic items
// planted and followed to where each is used. `lib/canary-run` runs the steps in order, each under
// its own role, as every `pi` command is: plant, extract, answer, records, extract, check.

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = ({ values }: Pick<CommandContext, "values">): string => {
  const day = values.day;
  if (typeof day !== "string" || !DAY.test(day) || Number.isNaN(Date.parse(day))) throw refusal("usage");
  return day;
};
const variable = (env: CommandContext["env"], name: string): string => {
  const value = env[name] ?? "";
  if (value === "") throw refusal("missing_env", `set ${name}`);
  return value;
};

async function apiOf({ env, deps, log }: CommandContext): Promise<CanaryApi> {
  const tokens = await readTokens(variable(env, "PI_CANARY_TOKENS"));
  return canaryApi(variable(env, "PI_CANARY_API_URL"), tokens, deps.canaryFetch ?? fetch, {
    refused: (tool, code) => log.warn({ event: "canary_read_refused", code: `${tool}_${code}` }),
  });
}

// The check's own Admin: its two compartments' keys alone, so what it reads and answers cannot
// reach anything else. The fingerprint key is the file's.
const canaryKeys = (keys: Keys): Keys => ({
  ...keys,
  compartments: new Map([...keys.compartments].filter(([compartment]) => isCanaryCompartment(compartment))),
});

// `pia canary setup`, once, by the owner: the check's keys, clients, device, scope rule and Drive
// root, and the tokens in pi's own file. The offline copy of the key file is made again after it,
// as after any new key.
export async function canarySetup({ env, log, io }: CommandContext): Promise<0> {
  const keyFile = variable(env, "PI_KEY_FILE");
  const tokensAt = variable(env, "PI_CANARY_TOKENS");
  for (const compartment of CANARY_CLEARANCE)
    if (!(await loadKeys(keyFile)).compartments.has(compartment)) await addCompartmentKey(keyFile, compartment);
  const admin = createAdmin({
    url: variable(env, "PI_DATABASE_URL_ADMIN"),
    keys: await loadKeys(keyFile, restrictedKeyFile(env)),
    log,
    recordEnabled: true,
  });
  try {
    // Before anything is registered: a token is shown once, so a file that cannot be written must
    // stop the setup while there is nothing to undo.
    await access(dirname(tokensAt), constants.W_OK);
    const tokens = await admin.box.canarySetup({ bundle: CANARY_APP.bundle, root: CANARY_ROOT, label: CANARY_LABEL });
    await writeTokens(tokensAt, tokens);
  } finally {
    await admin.close();
  }
  io.stdout.write("set up\n");
  return 0;
}

// `pi canary plant --day D`, as pi_writer: what an agent and a device send, over the agent API, then
// the connector seam's items, the records and the Lens inbox, under the sync lock, as a sync takes
// them. Prints `busy` when another sync holds the lock. A step that fails leaves its item missing,
// which `check` reports as the hop it is.
export async function canaryPlantCommand(context: CommandContext): Promise<0> {
  const { env, log, io, deps } = context;
  const day = dayOf(context);
  const plant = canaryPlant(day);
  const api = await apiOf(context);
  const google = deps.google ?? {};
  const now = new Date((google.now ?? Date.now)());
  const keyFile = variable(env, "PI_KEY_FILE");
  const keys = await loadKeys(keyFile, restrictedKeyFile(env));
  const writer = createWriter({
    url: variable(env, "PI_DATABASE_URL_WRITER"),
    keys,
    log,
    journal: journalPath(keyFile),
  });
  try {
    if ((await writer.erasureLevel()) === "behind") throw refusal("erasure_replay_needed");
    await api("capture", "push_capture", { batch: `canary-${day}`, items: [plant.meeting, plant.moment] });
    const held = await writer.withSyncLock(async () => {
      const synced = await runSync({
        writer,
        sources: [canarySource(plant, day, now.toISOString())],
        log,
        now,
        backfillDays: 3650,
        contacts: [CANARY_LABEL],
      });
      // Whatever else waits in the inbox is taken here, so it is taken as a sync's drain takes it.
      const boxHost = boxHostOf(env.PI_HTTP_BASE_URL);
      await writer.takeCapture(undefined, boxHost === undefined ? {} : { boxHost });
      await afterSync(writer, keys, google, log, "ok");
      // After the sync, so the finding's typed claim finds its subject even on the first day.
      await api("writer", "record", plant.finding);
      await api("writer", "propose_about_you", plant.proposal);
      const taken = await writer.takeRecords();
      if (taken.refused > 0) log.warn({ event: "records_taken", counts: taken });
      return synced.outcomes.every((one) => one.outcome === "ok") ? "ok" : "partial";
    });
    if (held === "already_running") {
      io.stdout.write("busy\n");
      return 0;
    }
    if (held !== "ok") log.warn({ event: "canary_partial", code: CANARY_COMPARTMENT });
  } finally {
    await writer.close();
  }
  return 0;
}

// `pi canary answer --day D`, as pi_admin: the day's proposal card answered as the owner would, and
// the same proposal asked again over the agent API, which must raise no second card.
export async function canaryAnswer(context: CommandContext): Promise<0> {
  const { env, log } = context;
  const day = dayOf(context);
  const plant = canaryPlant(day);
  const admin = createAdmin({
    url: variable(env, "PI_DATABASE_URL_ADMIN"),
    keys: canaryKeys(await loadKeys(variable(env, "PI_KEY_FILE"), restrictedKeyFile(env))),
    log,
    recordEnabled: true,
  });
  try {
    const what = admin.box.canaryWhat();
    await what.withdrawFindingCards();
    const { waiting } = await what.proposalCards([plant.proposal.requestId]);
    if (waiting.length > 0)
      await admin.cards.decide({ cards: waiting, answer: "confirm", requestId: `canary-${day}-answer-v4` });
  } finally {
    await admin.close();
  }
  await (await apiOf(context))("writer", "propose_about_you", plant.proposalAgain);
  return 0;
}

// `pi canary check --day D`, as pi_admin: each source's result, one ledger.job_runs row each, and one
// line per source on stdout. Always exits 0 once its rows are written: a red source is a result, not
// a failure of the command.
export async function canaryCheck(context: CommandContext): Promise<0> {
  const { env, log, io, values } = context;
  const day = dayOf(context);
  const started = new Date(typeof values.started === "string" ? Number(values.started) * 1000 : Date.now());
  const admin = createAdmin({
    url: variable(env, "PI_DATABASE_URL_ADMIN"),
    keys: canaryKeys(await loadKeys(variable(env, "PI_KEY_FILE"), restrictedKeyFile(env))),
    log,
    recordEnabled: true,
  });
  try {
    const results = await followAll(canaryPlant(day), day, {
      api: await apiOf(context),
      tables: admin.box.canaryWhat(),
      budget: values.budget === true,
      // This process's own switches, the service's, as this run's extraction read them: no other
      // run's row can decide them.
      lanesOff: lanesOffOf(env),
    });
    await admin.box.recordCanary(results, started);
    for (const { source, code } of results) io.stdout.write(`${source} ${code}\n`);
  } finally {
    await admin.close();
  }
  return 0;
}
