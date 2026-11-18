// `pi ties backfill`: mail older than the sync window, read by its headers
// alone into the interaction log and warmth. No body, no subject, no message row, no extraction.
// Each label's sent mail, then the rest, newest first. Google is read outside the sync lock and each
// batch is stored under it, so the timer's sync goes on between batches. It holds no state of its
// own: a run that stopped lists again from its oldest stored message, and what is stored or erased
// is never fetched.
import type { RawItem } from "@intelligence/contracts";
import type { PersonalLogger } from "@intelligence/contracts/personal";
import { DAY_MS, gmailItemId, PERSONAL_LIMITS } from "@intelligence/personal-core";
import {
  deriveItem,
  isConditional,
  isDraft,
  isJunk,
  type PersonalSource,
  type TiesPass,
  type TiesReader,
} from "@intelligence/personal-core/items";
import { TIES_MS_PER_MESSAGE } from "@intelligence/personal-google";
import type { SourceAccountRow, Writer } from "@intelligence/personal-store";
import {
  createWriter,
  DRIVE_CEILING_BYTES,
  googleSecretName,
  journalPath,
  loadKeys,
} from "@intelligence/personal-store";
import { driveNumberOf } from "../box/env-numbers.ts";
import type { CommandContext } from "../command-types.ts";
import { codeOf, refusal, restrictedKeyFile } from "../env.ts";
import { DEFAULT_BACKFILL_DAYS } from "./sync.ts";
import { clientOf, connectedLabels, googleSource } from "./sync-google.ts";
import { outcomeOf, REFUSED_FOR_GOOD } from "./sync-pages.ts";

// What one message read by its headers takes in the database: its evidence row and sealed blob, its
// interaction rows, the people it first names and every index on them. Measured on a synthetic
// mailbox at about 8,020 bytes.
export const TIES_BYTES_PER_MESSAGE = 8_192;
// One batch's Google reads and one hold of the sync lock.
const BATCH = 50;
const LOCK_PAUSE_MS = 30_000;
const LOCK_TRIES = 40;
// After this many pauses, two minutes, a batch is read again: a message deleted since its fetch would
// otherwise be stored after its deletion, which found nothing to remove.
const REFETCH_TRIES = 4;
// The backfill stops at this part of the storage ceiling, which Drive and capture's alarm also use:
// a large run must not leave them at it. Under the alarm's warning at 85.
const TIES_CEILING_PERCENT = 80;
export const tiesLimitBytes = (ceilingBytes: number): number => Math.floor((ceilingBytes * TIES_CEILING_PERCENT) / 100);
const DAY_SECONDS = DAY_MS / 1000;
const PASSES: readonly { pass: TiesPass; direction: "outbound" | "inbound" }[] = [
  { pass: "sent", direction: "outbound" },
  { pass: "rest", direction: "inbound" },
];

type Tally = {
  listed: number;
  known: number;
  stored: number;
  no_tie: number;
  left: number;
  repeat: number;
  removed: number;
  suppressed: number;
  gone: number;
  skipped: number;
  refused: number;
};
const noTally = (): Tally => ({
  listed: 0,
  known: 0,
  stored: 0,
  no_tie: 0,
  left: 0,
  repeat: 0,
  removed: 0,
  suppressed: 0,
  gone: 0,
  skipped: 0,
  refused: 0,
});

export type TiesRun = {
  writer: Writer;
  sources: PersonalSource[];
  log: PersonalLogger;
  now: Date;
  days: number;
  dryRun: boolean;
  ceilingBytes: number;
  sleep: (ms: number) => Promise<void>;
};
export type TiesLabel = { label: string; outcome: string; tally: Tally };

// Whether an item is left out by the mail rules sync applies: nothing of it is
// stored, and since it was never stored there is nothing to remove.
async function leftOut(writer: Writer, account: SourceAccountRow, raw: RawItem): Promise<boolean> {
  if (isDraft(raw) || isJunk(raw)) return true;
  if (!isConditional(raw)) return false;
  const wrote = await writer.ownerWrote(account, {
    ...(raw.sender === undefined ? {} : { sender: raw.sender }),
    ...(raw.threadId === undefined ? {} : { threadId: raw.threadId }),
    headers: true,
  });
  return !wrote.sender && !wrote.thread;
}

async function storeBatch(run: TiesRun, account: SourceAccountRow, items: RawItem[], tally: Tally): Promise<void> {
  const { writer, log } = run;
  // Checked under the lock, for each batch: a restore's erasures; a restricted category turned on,
  // since the restricted screen reads a subject and a text and this reads neither, so a message it
  // would restrict would stand under the account's label alone; a reconcile begun since the last
  // batch, whose end would remove what was stored behind it; and the volume.
  if ((await writer.erasureLevel()) === "behind") throw refusal("erasure_replay_needed");
  if ((await writer.restrictedOn()).length > 0) throw refusal("restricted_on");
  if (await writer.tiesListing(account)) throw refusal("listing_under_way");
  if ((await writer.databaseBytes()) >= tiesLimitBytes(run.ceilingBytes)) throw refusal("ties_reserve");
  for (const raw of items) {
    if (await leftOut(writer, account, raw)) {
      tally.left += 1;
      continue;
    }
    try {
      const answer = await writer.ingestItem(account, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS));
      if (answer === "stored" || answer === "no_tie" || answer === "repeat") tally[answer] += 1;
      else if (answer === "removed" || answer === "suppressed") tally[answer] += 1;
    } catch (error) {
      if (!REFUSED_FOR_GOOD.has(codeOf(error))) throw error;
      tally.refused += 1;
      log.warn({ event: "item_skipped", code: codeOf(error), ids: { account: account.id } });
    }
  }
}

// A batch read from Google and stored under one hold, read again if the lock has kept it waiting.
async function storeFetched(
  run: TiesRun,
  reader: TiesReader,
  ids: string[],
  account: SourceAccountRow,
  tally: Tally,
): Promise<void> {
  let fetched = await reader.fetch(ids);
  for (let tries = 0; tries < LOCK_TRIES; tries += 1) {
    if (tries > 0 && tries % REFETCH_TRIES === 0) fetched = await reader.fetch(ids);
    const { items, gone, skipped } = fetched;
    if ((await run.writer.withSyncLock(() => storeBatch(run, account, items, tally))) !== "already_running") {
      tally.gone += gone;
      tally.skipped += skipped.length;
      for (const { reason } of skipped)
        run.log.warn({ event: "item_skipped", code: reason, ids: { account: account.id } });
      return;
    }
    await run.sleep(LOCK_PAUSE_MS);
  }
  throw refusal("already_running");
}

async function onePass(
  run: TiesRun,
  source: PersonalSource,
  account: SourceAccountRow | undefined,
  { pass, direction }: (typeof PASSES)[number],
  tally: Tally,
): Promise<void> {
  const { writer, now, days, dryRun } = run;
  if (source.ties === undefined || (account === undefined && !dryRun)) throw refusal("no_ties_reader");
  const reader = source.ties((account?.id ?? "") as Parameters<typeof source.ties>[0]);
  // `--days` may reach before the epoch, which Gmail's `after:` does not take.
  const after = Math.max(0, Math.floor((now.getTime() - days * DAY_MS) / 1000));
  const oldest = account === undefined ? null : await writer.tiesOldest(account, direction);
  // Sync's window is sync's, whose messages are read in full. Past it, from the oldest stored, with a
  // day's overlap, whichever way Gmail rounds; what is stored is not fetched again.
  const edge = oldest?.getTime() ?? now.getTime() - DEFAULT_BACKFILL_DAYS * DAY_MS;
  const window = { after, before: Math.floor(edge / 1000) + DAY_SECONDS };
  let pageToken: string | undefined;
  do {
    const page = await reader.list(pass, window, pageToken);
    pageToken = page.next;
    tally.listed += page.ids.length;
    const known =
      account === undefined ? new Set<string>() : await writer.tiesKnown(account, page.ids.map(gmailItemId));
    const fresh = page.ids.filter((id) => !known.has(gmailItemId(id)));
    tally.known += page.ids.length - fresh.length;
    if (dryRun || account === undefined) continue;
    for (let at = 0; at < fresh.length; at += BATCH) {
      await storeFetched(run, reader, fresh.slice(at, at + BATCH), account, tally);
    }
  } while (pageToken !== undefined);
}

export async function runTies(run: TiesRun): Promise<TiesLabel[]> {
  const { writer, sources, dryRun } = run;
  const labels: TiesLabel[] = [];
  for (const source of sources) {
    const tally = noTally();
    let outcome = "ok";
    let account: SourceAccountRow | undefined;
    try {
      const { address } = await source.profile();
      // A dry run writes nothing: a label not yet synced has no account, and all it lists is new.
      account = dryRun
        ? (await writer.listSourceAccounts()).find(
            (one) => one.label === source.label && one.connector === "google_mail",
          )
        : await writer.ensureSourceAccount(source.label, "google_mail", source.compartment, address);
      for (const pass of PASSES) await onePass(run, source, account, pass, tally);
    } catch (error) {
      outcome = outcomeOf(error);
    }
    if (account !== undefined)
      run.log.info({ event: "ties_backfill", ids: { account: account.id }, counts: tally, code: outcome });
    labels.push({ label: source.label, outcome, tally });
  }
  return labels;
}

function optionsOf({ days, "dry-run": dryRun }: CommandContext["values"]): { days: number; dryRun: boolean } {
  if (typeof days !== "string" || !/^[1-9]\d{0,4}$/.test(days)) throw refusal("usage");
  return { days: Number(days), dryRun: dryRun === true };
}

// The dry run's lines: what each label lists and what is new, what that would take in the database
// and in hours at Gmail's pace, against the storage ceiling. Counts it fetches nothing to learn, so
// what is bulk among the new is unknown and the estimate is an upper bound.
function report(
  { stdout }: CommandContext["io"],
  labels: TiesLabel[],
  { dryRun, databaseBytes, ceilingBytes }: { dryRun: boolean; databaseBytes: number; ceilingBytes: number },
): void {
  let fresh = 0;
  for (const { label, outcome, tally } of labels) {
    const left = tally.listed - tally.known;
    fresh += left;
    const line = dryRun
      ? `listed=${tally.listed} known=${tally.known} new=${left} most_bytes=${left * TIES_BYTES_PER_MESSAGE} most_hours=${((left * TIES_MS_PER_MESSAGE) / 3_600_000).toFixed(1)}`
      : Object.entries(tally)
          .map(([name, count]) => `${name}=${count}`)
          .join(" ");
    stdout.write(`${label} ${outcome} ${line}\n`);
  }
  const most = databaseBytes + fresh * TIES_BYTES_PER_MESSAGE;
  const limit = tiesLimitBytes(ceilingBytes);
  if (dryRun)
    stdout.write(
      `database_bytes=${databaseBytes} most_bytes_after=${most} limit_bytes=${limit} ceiling_bytes=${ceilingBytes} fits=${most < limit ? "yes" : "no"}\n`,
    );
}

export async function tiesBackfill({ values, env, log, deps, io }: CommandContext): Promise<0> {
  const { days, dryRun } = optionsOf(values);
  const google = deps.google ?? {};
  const ceilingBytes = driveNumberOf(env.PI_DRIVE_STORAGE_CEILING_BYTES) ?? DRIVE_CEILING_BYTES;
  const keyFile = env.PI_KEY_FILE ?? "";
  const keys = await loadKeys(keyFile, restrictedKeyFile(env));
  const writer = createWriter({ url: env.PI_DATABASE_URL_WRITER ?? "", keys, log, journal: journalPath(keyFile) });
  try {
    if ((await writer.erasureLevel()) === "behind") throw refusal("erasure_replay_needed");
    if ((await writer.restrictedOn()).length > 0) throw refusal("restricted_on");
    const sources: PersonalSource[] = [];
    for (const label of connectedLabels(await writer.listSecretNames("google/"))) {
      const refreshToken = await writer.secret(googleSecretName(label, "refresh_token"));
      const client = refreshToken === null ? null : clientOf(await writer.secret(googleSecretName(label, "client")));
      if (refreshToken === null || client === null) throw refusal("reconnect_google");
      sources.push(googleSource(label, client, { mail: refreshToken, contacts: null, drive: null }, google, log));
    }
    const labels = await runTies({
      writer,
      sources,
      log,
      now: new Date((google.now ?? Date.now)()),
      days,
      dryRun,
      ceilingBytes,
      sleep: google.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    });
    report(io, labels, { dryRun, databaseBytes: await writer.databaseBytes(), ceilingBytes });
    const failed = labels.find((one) => one.outcome !== "ok");
    if (failed !== undefined) throw refusal(failed.outcome);
    if (labels.some((one) => one.tally.refused > 0)) throw refusal("items_refused");
    return 0;
  } finally {
    await writer.close();
  }
}
