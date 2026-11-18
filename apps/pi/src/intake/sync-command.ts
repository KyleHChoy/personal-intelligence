// The `pi sync` command: its options, the job-run row, the sync lock, agent records, Lens's drain
// and retention, the sources built from the stored secrets, and the steps after the labels sync.
import { existsSync } from "node:fs";
import type { PersonalSource } from "@intelligence/personal-core/items";
import type { SourceAccountRow } from "@intelligence/personal-store";
import {
  boxHostOf,
  createWriter,
  DRIVE_CEILING_BYTES,
  googleSecretName,
  journalPath,
  loadKeys,
  withJobRun,
} from "@intelligence/personal-store";
import { driveNumberOf } from "../box/env-numbers.ts";
import type { CommandContext } from "../command-types.ts";
import { codeOf, refusal, restrictedKeyFile } from "../env.ts";
import { takeAgentPeople } from "./agent-people.ts";
import type { SyncKind, SyncOutcome } from "./sync.ts";
import { contactsOn, kindsOf, runSync } from "./sync.ts";
import { DRIVE_PAGES_PER_RUN } from "./sync-drive.ts";
import { clientOf, connectedLabels, googleSource } from "./sync-google.ts";
import { noCounts, outcomeOf } from "./sync-pages.ts";

function driveOptionsOf(env: CommandContext["env"]): { ceilingBytes: number; pagesPerRun: number } {
  return {
    ceilingBytes: driveNumberOf(env.PI_DRIVE_STORAGE_CEILING_BYTES) ?? DRIVE_CEILING_BYTES,
    pagesPerRun: driveNumberOf(env.PI_DRIVE_PAGES_PER_RUN) ?? DRIVE_PAGES_PER_RUN,
  };
}

// `--backfill-days N` and `--reset gmail|calendar|contacts|drive`, each a usage error when it is
// none of them. `--reset contacts` stores the People connector's reset cursor, so the next
// listing reconciles.
function optionsOf(values: CommandContext["values"]): { backfillDays?: number; reset: SyncKind[] } {
  const days = values["backfill-days"];
  const reset = Array.isArray(values.reset) ? values.reset : [];
  if (days !== undefined && !(typeof days === "string" && /^[1-9]\d{0,4}$/.test(days))) throw refusal("usage");
  if (
    !reset.every(
      (kind): kind is SyncKind => kind === "gmail" || kind === "calendar" || kind === "contacts" || kind === "drive",
    )
  )
    throw refusal("usage");
  return { ...(days === undefined ? {} : { backfillDays: Number(days) }), reset };
}

// `pi sync`: agent records into the vault, then one sync of every connected label, with its send-as
// list only under `--send-as`, and under `--fast` mail and calendar alone, with none of the steps
// around them, then Lens's inbox, then the identity sweep, all under the
// sync lock. It exits 0 when every outcome is `ok`, no re-derive failed, and no agent record and no
// item was refused. Otherwise it fails with the first outcome that is not `ok`; or, when the only
// fault is agent records or items refused, with `records_refused` or `items_refused`, so a run that
// left something out never looks like success. An agent record that waits for a key is counted and
// fails no run.
//
// For the coverage report: a timer sync, full or fast, writes one ledger.job_runs row
// at its end, whatever its outcome, with its kind and whether the file PI_READ_HOLD names exists as
// it ends, which is when the timer reads the hold; `--records` (the proposal wake) writes none. A
// row that cannot be written is logged by its code and changes nothing of the run's own exit.
export async function syncCommand(context: CommandContext): Promise<0> {
  const { values, env, log } = context;
  // The usage errors first: a command refused before it starts is no run.
  const options = optionsOf(values);
  const driveOptions = driveOptionsOf(env);
  if (values.records === true) {
    await syncOnce(context, options, driveOptions);
    return 0;
  }
  const hold = env.PI_READ_HOLD ?? "";
  const job = {
    job: "sync",
    syncKind: values.fast === true ? "fast" : "full",
    readHold: () => hold !== "" && existsSync(hold),
  } as const;
  await withJobRun(
    { url: env.PI_DATABASE_URL_WRITER ?? "", log },
    job,
    () => syncOnce(context, options, driveOptions),
    { ofError: codeOf, ofResult: (code) => code },
  );
  return 0;
}
type Writer = ReturnType<typeof createWriter>;
type Google = NonNullable<CommandContext["deps"]["google"]>;
type Log = CommandContext["log"];

// One `pi sync`; the code it ended with when it did not fail.
async function syncOnce(
  { values, env, log, deps, io }: CommandContext,
  options: ReturnType<typeof optionsOf>,
  driveOptions: ReturnType<typeof driveOptionsOf>,
): Promise<string> {
  const google = deps.google ?? {};
  const now = new Date((google.now ?? Date.now)());
  const keyFile = env.PI_KEY_FILE ?? "";
  // Sync holds the restricted root too, when there is one, so it can seal what it screens.
  const keys = await loadKeys(keyFile, restrictedKeyFile(env));
  const writer = createWriter({ url: env.PI_DATABASE_URL_WRITER ?? "", keys, log, journal: journalPath(keyFile) });
  try {
    // Nothing is read or written before the erasures made since a restore are applied
    //.
    if ((await writer.erasureLevel()) === "behind") throw refusal("erasure_replay_needed");
    // Nor while the on categories and the restricted key file disagree.
    const restrictedOn = await writer.restrictedOn();
    // `pi sync --records`, the proposal wake's intake, takes agent records in and nothing else,
    // under the sync lock as every intake is: a deletion's second pass relies on no
    // record being taken in while it runs. With the lock held it prints `busy` and exits 0, and the
    // wake tries again.
    if (values.records === true) return await recordsOnly(writer, log, io);
    // `--fast` syncs mail and calendar alone: no agent records (the wake takes them), no contacts,
    // Drive or Lens inbox, no confirmed agent people and no identity sweep. The timer runs it every
    // loop and a full sync every ten minutes.
    const fast = values.fast === true;
    const result = await writer.withSyncLock(async () => {
      const synced = await syncAll(writer, {
        env,
        log,
        google,
        now,
        fast,
        restrictedOn,
        options,
        driveOptions,
        sendAs: values["send-as"] === true,
      });
      if (fast) return synced;
      return afterSync(writer, keys, google, log, synced);
    });
    if (result === "ok") return result;
    if (result !== "already_running" && result !== "no_accounts") throw refusal(result);
    log.info({ event: result });
    return result;
  } finally {
    await writer.close();
  }
}

// `pi sync --records`: agent records in, under the sync lock, and nothing else.
async function recordsOnly(writer: Writer, log: Log, io: CommandContext["io"]): Promise<string> {
  const records = await writer.withSyncLock(() => writer.takeRecords());
  if (records === "already_running") {
    log.info({ event: "already_running" });
    io.stdout.write("busy\n");
    return "already_running";
  }
  if (records.taken + records.removed + records.refused + records.waiting > 0)
    log.info({ event: "records_taken", counts: records });
  if (records.refused > 0) throw refusal("records_refused");
  return "ok";
}

type SyncRun = {
  env: CommandContext["env"];
  log: Log;
  google: Google;
  now: Date;
  fast: boolean;
  restrictedOn: Awaited<ReturnType<Writer["restrictedOn"]>>;
  options: ReturnType<typeof optionsOf>;
  driveOptions: ReturnType<typeof driveOptionsOf>;
  sendAs: boolean;
};

// Agent records, then every connected label's sync, then Lens's drain: the run's outcome.
async function syncAll(writer: Writer, run: SyncRun): Promise<string> {
  const { log, now, fast, restrictedOn, options, driveOptions, sendAs } = run;
  // Before the labels are looked for: with none connected, agent records are still taken in.
  const records = fast ? { taken: 0, removed: 0, refused: 0, waiting: 0 } : await writer.takeRecords();
  if (records.taken + records.removed + records.refused + records.waiting > 0)
    log.info({ event: "records_taken", counts: records });
  const recordsRefused = records.refused > 0;

  const labels = connectedLabels(await writer.listSecretNames("google/"));
  if (labels.length === 0) {
    const drained = await drain(writer, run);
    if (drained !== "ok") return drained;
    return recordsRefused ? "records_refused" : "no_accounts";
  }

  const { outcomes, sources, reading } = await sourcesOf(writer, labels, run);
  const synced = await runSync({
    writer,
    sources,
    log,
    now,
    contacts: reading,
    ...options,
    drive: driveOptions,
    restrictedOn,
    fast,
    sendAs,
  });
  const drained = await drain(writer, run);
  // A Drive at its storage ceiling is the owner's to act on,
  // shown by status, and fails no run: its deletions still went through.
  const failed = [...outcomes, ...synced.outcomes].find(
    (one) => one.outcome !== "ok" && one.outcome !== "storage_ceiling",
  );
  if (failed !== undefined) return failed.outcome;
  if (synced.rederive === "failed") return "unavailable";
  if (drained !== "ok") return drained;
  if (recordsRefused) return "records_refused";
  return synced.refused > 0 ? "items_refused" : "ok";
}

// Each connected label's source, or, for a label that cannot ask Google for anything, its accounts'
// outcome; and the labels that read contacts this run.
async function sourcesOf(
  writer: Writer,
  labels: string[],
  { log, google, now, fast }: SyncRun,
): Promise<{ outcomes: SyncOutcome[]; sources: PersonalSource[]; reading: string[] }> {
  const outcomes: SyncOutcome[] = [];
  const sources: PersonalSource[] = [];
  const reading: string[] = [];
  const secrets = await writer.listSecretNames("google/");
  for (const label of labels) {
    const refreshToken = await writer.secret(googleSecretName(label, "refresh_token"));
    const client = refreshToken === null ? null : clientOf(await writer.secret(googleSecretName(label, "client")));
    const contacts = !fast && contactsOn(secrets, label);
    if (refreshToken === null || client === null) {
      // With no refresh token, or a client that is not the three values `pi google connect`
      // seals, the label cannot ask Google for anything, and connecting again mends either.
      // No network call for this label: its accounts that are on, if it has any, record why.
      const off = (one: SourceAccountRow) => !contacts && one.connector === "google_contacts";
      for (const account of (await writer.listSourceAccounts()).filter((one) => one.label === label && !off(one)))
        await writer.recordOutcome(account, "reconnect_google", now.toISOString(), 0, noCounts(fast ? "fast" : "full"));
      for (const { kind } of kindsOf(contacts)) outcomes.push({ label, kind, outcome: "reconnect_google" });
      continue;
    }
    // The token read here is the run's one decision: a label reads contacts this run exactly
    // when it was found.
    const contactsToken = contacts ? await writer.secret(googleSecretName(label, "contacts_refresh_token")) : null;
    if (contactsToken !== null) reading.push(label);
    const driveToken = fast ? null : await writer.secret(googleSecretName(label, "drive_refresh_token"));
    sources.push(
      googleSource(label, client, { mail: refreshToken, contacts: contactsToken, drive: driveToken }, google, log),
    );
  }
  return { outcomes, sources, reading };
}

// Lens's drain, after every label's mail and calendar whatever their
// outcomes, and with no label connected too. Its failure is its own outcome and undoes
// nothing the labels stored; a row it could not take is counted and waits for the next run.
async function drain(writer: Writer, { env, log, now, fast }: SyncRun): Promise<string> {
  if (fast) return "ok";
  let drained = "ok";
  try {
    // The box's own host, from sync.env's PI_HTTP_BASE_URL; unset,
    // the drain admits nothing by default.
    const boxHost = boxHostOf(env.PI_HTTP_BASE_URL);
    const taken = await writer.takeCapture(undefined, boxHost === undefined ? {} : { boxHost });
    const dropped = Object.entries(taken.dropped);
    // The block attributes the drain's check left out, by method.
    const refused = Object.entries(taken.attributeRefused ?? {});
    if (taken.taken + taken.replaced + taken.failed + taken.waiting + dropped.length + refused.length > 0) {
      const counts: Record<string, number> = {
        taken: taken.taken,
        replaced: taken.replaced,
        failed: taken.failed,
        waiting: taken.waiting,
      };
      for (const [code, count] of dropped) counts[`dropped_${code}`] = count;
      for (const [method, count] of refused) counts[`attribute_refused_${method}`] = count;
      // The blocks the default admitted.
      if (taken.byDefault !== undefined) counts.by_default = taken.byDefault;
      // The meetings no scope rule named, and those with no account.
      if (taken.meetingsByDefault !== undefined) counts.meetings_by_default = taken.meetingsByDefault;
      if (taken.meetingsNoAccount !== undefined) counts.meetings_no_account = taken.meetingsNoAccount;
      // Whether hourly block days taint what cited them.
      if (taken.blockRevisions !== undefined) {
        counts.block_revision_grown = taken.blockRevisions.grown;
        counts.block_revision_changed = taken.blockRevisions.changed;
        counts.block_revision_tainted = taken.blockRevisions.tainted;
      }
      log.info({ event: "capture_taken", counts });
    }
    // The older rows' work_enc, at most WORK_CATCH_UP a full run, oldest first.
    const caught = await writer.catchUpWork();
    if (caught.filled + (caught.failed ?? 0) > 0)
      log.info({ event: "work_caught_up", counts: { filled: caught.filled, failed: caught.failed ?? 0 } });
  } catch (error) {
    drained = outcomeOf(error);
    log.error({ event: "capture_failed", code: drained });
  }
  // The Mac contacts Lens sent, after the capture items
  // and before the participant step, so this sync binds what it stored. Counts only, under
  // snake-case names; its failure is its own outcome, after the drain's.
  try {
    const contacts = await writer.takeContacts();
    const dropped = Object.entries(contacts.dropped);
    if (
      contacts.stored +
        contacts.unchanged +
        contacts.removed +
        contacts.momentsDue +
        contacts.failed +
        contacts.waiting +
        dropped.length >
      0
    ) {
      const counts: Record<string, number> = {
        stored: contacts.stored,
        unchanged: contacts.unchanged,
        removed: contacts.removed,
        moments_due: contacts.momentsDue,
        failed: contacts.failed,
        waiting: contacts.waiting,
      };
      for (const [code, count] of dropped) counts[`dropped_${code}`] = count;
      log.info({ event: "contacts_taken", counts });
    }
  } catch (error) {
    const code = outcomeOf(error);
    log.error({ event: "contacts_failed", code });
    if (drained === "ok") drained = code;
  }
  // Capture retention: after the drain, whatever its outcome, what the owner's rules have aged out.
  // Ageing, not erasure: nothing goes back to the Mac. Its failure is its own outcome, as the
  // drain's is, and the drain's comes first.
  try {
    const aged = await writer.expireCapture(now);
    const expired = Object.values(aged.expired).reduce((total, one) => total + one, 0);
    if (expired + aged.failed > 0) {
      const counts: Record<string, number> = { expired, failed: aged.failed };
      for (const [kind, count] of Object.entries(aged.expired)) counts[kind] = count;
      log.info({ event: "retention_ran", counts });
    }
    return drained;
  } catch (error) {
    const code = outcomeOf(error);
    log.error({ event: "retention_failed", code });
    return drained === "ok" ? code : drained;
  }
}

// The steps after a full sync, each under the same lock: a failure is logged, and is the run's
// outcome only when nothing else failed.
export async function afterSync(
  writer: Writer,
  keys: Awaited<ReturnType<typeof loadKeys>>,
  google: Google,
  log: Log,
  outcome: string,
): Promise<string> {
  let synced = outcome;
  const step = async (failed: (code: string) => void, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      const code = outcomeOf(error);
      failed(code);
      if (synced === "ok" || synced === "no_accounts") synced = code;
    }
  };
  // The people the owner confirmed from agents' proposals, as contacts, before the sweep, so a
  // shared name among them raises its card this run.
  await step(
    (code) => log.error({ event: "agent_people_failed", code }),
    () => takeAgentPeople(writer, keys, new Date((google.now ?? Date.now)()), log),
  );
  // The meetings' participants bound to people by code, or made people, before the sweep, so a
  // name two people share raises its card this run. Counts only.
  await step(
    (code) => log.error({ event: "participants_failed", code }),
    async () => {
      const counts = await writer.bindParticipants(new Date((google.now ?? Date.now)()));
      // And the phone handles bound and unbound, the contacts' phones filled, the chat lines
      // written and removed, the moments with no lines, the owner's lines refused, the owner's own
      // handles, and the moments due for their held claims (`held_due`). The logger takes counts
      // under snake-case names alone, so each name is written so: a camel-case name would make
      // the whole line `log_field_refused`.
      if (
        counts.bound +
          counts.created +
          counts.capped +
          counts.failed +
          counts.handlesBound +
          counts.handlesRemoved +
          counts.phonesFilled +
          counts.linesWritten +
          counts.linesRemoved +
          counts.noLines +
          counts.notOwnerWord +
          counts.ownerHandle +
          counts.heldDue >
        0
      ) {
        log.info({
          event: "participants_bound",
          counts: Object.fromEntries(
            Object.entries(counts).map(([name, n]) => [name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase(), n]),
          ),
        });
      }
    },
  );
  // What research fills found lands, before the binding step, so a researched domain's join holds
  // when named organizations bind. It logs its own counts.
  await step(
    (code) => log.error({ event: "research_failed", code }),
    async () => {
      await writer.landResearch(new Date((google.now ?? Date.now)()));
    },
  );
  // The names relations filed bound to people, or named people made, after the participants and
  // before the sweep, so a name two people share raises its card this run; then the named people
  // nothing names removed. Counts only, under snake-case names.
  await step(
    (code) => log.error({ event: "named_failed", code }),
    async () => {
      const counts = await writer.bindNamed(new Date((google.now ?? Date.now)()));
      if (Object.entries(counts).some(([name, n]) => name !== "skipped" && n > 0))
        log.info({ event: "named_bound", counts });
    },
  );
  // The identity sweep, whatever the run's outcome. It logs its
  // own counts, and a sweep that keeps failing is seen.
  await step(
    (code) => log.error({ event: "identity_sweep_failed", code }),
    async () => {
      await writer.proposeIdentity(new Date((google.now ?? Date.now)()));
    },
  );
  return synced;
}
