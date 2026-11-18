import { copyFile, rm } from "node:fs/promises";
import { type Admin, createAdmin, journalPath, loadKeys } from "@intelligence/personal-store";
import type { CommandContext } from "../command-types.ts";
import { refusal, restrictedKeyFile } from "../env.ts";
import { printJson } from "../owner/owner-kit.ts";

// `pi restore check`: a dump restored into a database of its own is checked, as pi_admin, with the box's
// key file and a copy of its journal. It proves the copy opens under the keys, and that every erasure since
// the dump is applied again and stays applied (invariant 10). The result is one `restore_drill` run of the
// live store. Nothing else of the live store, its key file or its journal changes: replay can append to the
// journal it is given, so it is given a copy, which goes when the check ends.

export const RESTORE_DATABASE = "pi_restore_test";

// The same server and role with the restored database's name. Any other database is refused here and
// again by what the database itself answers, since a replay writes.
const urlOf = (url: string, database: string): string => {
  const at = new URL(url);
  at.pathname = `/${database}`;
  return at.toString();
};

export type RestoreCode =
  | "ok"
  | "empty"
  | "keys_failed"
  | "still_behind"
  | "erased_came_back"
  | "failed"
  | "schema_behind";

export type RestoreResult = {
  code: RestoreCode;
  before: "level" | "behind";
  after: "level" | "behind";
  // The erasures this run applied. With 0 the dump is newer than every erasure, and the check says
  // only that none it holds came back.
  applied: number;
  survivors: number;
  messages: number;
};

async function checked(restored: Admin): Promise<RestoreResult> {
  const before = await restored.erasure.level();
  const { applied } = await restored.erasure.replayErasures();
  const after = await restored.erasure.level();
  const { messages, survivors } = await restored.box.restoredFacts();
  const status = await restored.accounts.status();
  const opens = status.keyCheck === "ok" && status.missingKeys.length === 0;
  const code: RestoreCode =
    messages === 0
      ? "empty"
      : !opens
        ? "keys_failed"
        : after !== "level"
          ? "still_behind"
          : survivors > 0
            ? "erased_came_back"
            : "ok";
  return { code, before, after, applied, survivors, messages };
}

// `database` is the name it is told to check; only the test of this command names another, and every
// name must begin with RESTORE_DATABASE.
export async function restoreCheck(context: CommandContext, database = RESTORE_DATABASE): Promise<0> {
  const { env, log } = context;
  const url = env.PI_DATABASE_URL_ADMIN ?? "";
  const keyFile = env.PI_KEY_FILE ?? "";
  if (url === "") throw refusal("missing_env", "set PI_DATABASE_URL_ADMIN");
  if (keyFile === "") throw refusal("missing_env", "set PI_KEY_FILE");
  if (!database.startsWith(RESTORE_DATABASE)) throw refusal("not_restore_database");
  const keys = await loadKeys(keyFile, restrictedKeyFile(env));
  const started = new Date();
  const journal = `${journalPath(keyFile)}.restore-test`;
  // A store that never erased anything has no journal yet: the copy starts with none, too.
  await copyFile(journalPath(keyFile), journal).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  const restored = createAdmin({ url: urlOf(url, database), keys, log, recordEnabled: false, journal });
  let result: RestoreResult;
  try {
    // A copy that cannot be reached, or the wrong database, records nothing: no restore was tested.
    // One that answers and cannot be read, a dump that restored nothing, is a test that failed.
    if ((await restored.box.currentDatabase()) !== database) throw refusal("not_restore_database");
    try {
      // A dump older than the newest migration says nothing of whether a restore works: this code reads
      // tables it lacks. Its own code, no card, and the next dump tests.
      const live = createAdmin({ url, keys, log, recordEnabled: false });
      let behind = false;
      try {
        const [mine, theirs] = [await restored.box.latestMigration(), await live.box.latestMigration()];
        behind = mine !== null && theirs !== null && mine < theirs;
      } finally {
        await live.close();
      }
      result = behind
        ? { code: "schema_behind", before: "behind", after: "behind", applied: 0, survivors: 0, messages: 0 }
        : await checked(restored);
    } catch {
      result = { code: "failed", before: "behind", after: "behind", applied: 0, survivors: 0, messages: 0 };
    }
  } finally {
    await restored.close();
    await rm(journal, { force: true });
  }
  if (result.code === "schema_behind") log.warn({ event: "restore_check_skipped", code: result.code });
  else if (result.code !== "ok") log.error({ event: "restore_check_failed", code: result.code });
  const live = createAdmin({ url, keys, log, recordEnabled: false });
  try {
    if (result.code === "schema_behind") await live.box.recordRestoreSkipped(started);
    else await live.box.recordRestoreTest(result.code === "ok", started);
  } finally {
    await live.close();
  }
  printJson(context, result);
  return 0;
}
