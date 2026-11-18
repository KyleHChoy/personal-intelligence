import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CodedError } from "@intelligence/contracts/personal";
import { repoRoot } from "@intelligence/personal-core";
import pg from "pg";
import { parseDatabaseUrl } from "./db.ts";
import { MIGRATE_LOCK } from "./locks.ts";

// The migration runner.

// db/personal/migrations, found from this module's own location, never the working directory.
const DEFAULT_DIR = join(repoRoot(), "db", "personal", "migrations");

// A new install's start, when the file is there: one file that makes what the numbered files from
// the first up to some file make, its first line the digest of those files. In this repository the
// history starts with a baseline migration, so the file is absent and the runner applies the
// numbered files in order.
export const BASELINE = join(repoRoot(), "db", "personal", "baseline.sql");

// NNNN-<lower-case words joined by hyphens>.sql
const FILE_NAME = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.sql$/;

export class MigrationRefused extends Error {
  static {
    MigrationRefused.prototype.name = "MigrationRefused";
  }

  readonly code: "changed" | "missing" | "bad_name" | "transaction_control";
  readonly file: string;

  constructor(code: MigrationRefused["code"], file: string) {
    super(`migration refused (${code}): ${file}`);
    this.code = code;
    this.file = file;
  }
}

type Migration = { file: string; checksum: string; sql: string };

// The statements that end or split the transaction a file runs in. A file's top-level commit
// would commit what came before it and run the rest outside `set local role pi_owner`.
export const TRANSACTION_CONTROL =
  /^(begin|start|commit|end|rollback|abort|savepoint|release|prepare\s+transaction)\b/i;

// Each top-level statement of a file, trimmed: comments become a space, and quoted strings,
// quoted identifiers and dollar-quoted bodies become `_`, so a function's own begin and end are
// never a statement of the file.
export function topLevelStatements(sql: string): string[] {
  let code = "";
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    const dollar = /^\$(?:[A-Za-z_]\w*)?\$/.exec(rest);
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      code += " ";
    } else if (rest.startsWith("/*")) {
      let depth = 0;
      do {
        if (sql.startsWith("/*", i)) depth += 1;
        else if (sql.startsWith("*/", i)) depth -= 1;
        i += sql.startsWith("/*", i) || sql.startsWith("*/", i) ? 2 : 1;
      } while (depth > 0 && i < sql.length);
      code += " ";
    } else if (rest[0] === "'" || rest[0] === '"') {
      const quote = rest[0];
      // An E'...' string takes backslash escapes.
      const escapes = quote === "'" && /(?:^|[^\w])[eE]$/.test(code);
      i += 1;
      while (i < sql.length) {
        if (escapes && sql[i] === "\\") i += 2;
        else if (sql[i] === quote && sql[i + 1] === quote) i += 2;
        else if (sql[i] === quote) break;
        else i += 1;
      }
      i += 1;
      code += "_";
    } else if (dollar !== null && !/[\w$]$/.test(code)) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);
      i = end === -1 ? sql.length : end + dollar[0].length;
      code += "_";
    } else {
      code += rest[0];
      i += 1;
    }
  }
  return code
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
}

// Every entry of the folder, in order. So is a file with a top-level transaction control statement.
export async function readMigrations(dir: string): Promise<Migration[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).sort();
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
  const files: Migration[] = [];
  for (const [index, file] of names.entries()) {
    if (Number(FILE_NAME.exec(file)?.[1]) !== index + 1) throw new MigrationRefused("bad_name", file);
    // The checksum is over the raw bytes, so a file's line ends count: the root .gitattributes
    // checks every .sql file out with LF.
    const bytes = await readFile(join(dir, file));
    const sql = bytes.toString("utf8");
    if (topLevelStatements(sql).some((statement) => TRANSACTION_CONTROL.test(statement)))
      throw new MigrationRefused("transaction_control", file);
    files.push({ file, checksum: createHash("sha256").update(bytes).digest("hex"), sql });
  }
  return files;
}

// How many leading files a baseline stands for: the longest run from the first file whose digest
// (each file's name, a space, its bytes and a newline, in order) its first line holds. None when
// no run's does: a file in the run changed since the baseline was made.
export function baselineCovers(files: readonly Migration[], baseline: string): number {
  const first = baseline.slice(0, baseline.indexOf("\n"));
  const hash = createHash("sha256");
  let covers = 0;
  for (const [index, file] of files.entries()) {
    hash.update(`${file.file} `).update(Buffer.from(file.sql, "utf8")).update("\n");
    if (first === `-- migrations ${hash.copy().digest("hex")}`) covers = index + 1;
  }
  return covers;
}

// The baseline for a run, when one is given and the file is there.
async function readBaseline(path: string | undefined): Promise<string | undefined> {
  if (path === undefined) return undefined;
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
}

// One connection of its own, as whoever the URL names: the bootstrap, the migrator, or, for
// `pendingMigrations`, a role that reads the ledger.
async function connected<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: parseDatabaseUrl(url).href });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// Who a run connects as. The bootstrap owns the database and can make roles: the owner's run, with
// a superuser at hand. The migrator is the box's standing credential: it can become pi_owner and
// holds nothing else, so its run applies files and leaves the database-level statements, and every
// role, as the owner's last run left them.
export type MigrateAs = "bootstrap" | "migrator";

// What a file's statement fails with when it needs what the migrator lacks: a right pi_owner
// does not hold (42501), or a role nobody has made yet (42704).
const NEEDS_SUPERUSER: ReadonlySet<string> = new Set(["42501", "42704"]);

// The files no ledger row records, in the folder's order.
export function pendingOf(files: readonly string[], recorded: Iterable<string>): string[] {
  const done = new Set(recorded);
  return files.filter((file) => !done.has(file));
}

// What every run does first. It takes the lock, held until the connection closes, so two runs
// take turns from their first statement to their last. It then refuses a policy schema that is
// not pi_owner's: the ledger and the functions go into that schema, and whoever owns it could
// replace them. A bootstrap that does not own the database is refused too. A migrator is refused
// when it owns the database or holds any attribute of its own (role_attributes): the standing
// credential is never a superuser's or the bootstrap's. Last, as the bootstrap alone, the
// database-level statements, which only the database's owner can run (a REVOKE pi_owner ran
// would only warn). They are one implicit transaction, and safe to repeat.
async function prepare(client: pg.Client, as: MigrateAs): Promise<void> {
  await client.query(MIGRATE_LOCK);
  const { rows } = await client.query<{ name: string; owns: boolean; policy: boolean; wide: boolean }>(
    `select current_database() as name,
       (select d.datdba = (select r.oid from pg_roles r where r.rolname = current_user)
        from pg_database d where d.datname = current_database()) as owns,
       not exists (select 1 from pg_namespace n
                   where n.nspname = 'policy' and n.nspowner <> (select r.oid from pg_roles r where r.rolname = 'pi_owner')) as policy,
       (select r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolbypassrls or r.rolreplication
        from pg_roles r where r.rolname = current_user) as wide`,
  );
  const [found] = rows;
  if (found === undefined || !found.policy) throw new CodedError("not_owner");
  if (as === "migrator") {
    if (found.owns !== false || found.wide !== false) throw new CodedError("role_attributes");
    return;
  }
  if (found.owns !== true) throw new CodedError("not_owner");
  const database = pg.escapeIdentifier(found.name);
  await client.query(`
    revoke all on database ${database} from public;
    grant connect on database ${database} to pi_admin, pi_writer, pi_reader, pi_pipeline, pi_work, pi_proxy, pi_restricted, pi_notify;
    grant create on database ${database} to pi_owner;
    revoke all on schema public from public;
  `);
}

// The database-level statements alone, for a test database that takes no migrations.
export async function applyDatabasePrivileges(bootstrapUrl: string): Promise<void> {
  await connected(bootstrapUrl, (client) => prepare(client, "bootstrap"));
}

// The names of the files the database has not applied, read as any role that may select the
// ledger (pi_admin on the box: `pi db pending`). It takes no lock and changes nothing; a database
// with no ledger has applied none.
export async function pendingMigrations(url: string, dir: string = DEFAULT_DIR): Promise<string[]> {
  const files = await readMigrations(dir);
  return connected(url, async (client) => {
    const ledger = await client.query<{ found: boolean }>(
      "select to_regclass('policy.migrations') is not null as found",
    );
    const { rows } =
      ledger.rows[0]?.found === true
        ? await client.query<{ name: string }>("select name from policy.migrations")
        : { rows: [] };
    return pendingOf(
      files.map((one) => one.file),
      rows.map((row) => row.name),
    );
  });
}

// Whether the box's standing migration role can log in: `pi-migrate --enable-auto` gave it a login
// and a run without its credential file takes the login away, so this is whether a start of the box
// applies pending files by itself. Read as any role, from pg_roles; it changes nothing.
export async function unattendedMigration(url: string): Promise<boolean> {
  return connected(url, async (client) => {
    const { rows } = await client.query<{ login: boolean }>(
      "select coalesce((select rolcanlogin from pg_roles where rolname = 'pi_migrator'), false) as login",
    );
    return rows[0]?.login === true;
  });
}

// How long a statement of a migration waits for a table lock before it gives up, and how often a
// file that gave up is tried again. A migration that waited without a limit would queue every
// later reader and writer of that table behind its own lock; this way a busy table costs a short
// pause, and a lock held for long fails the run with 55P03 and changes nothing. Only the wait is
// bounded: a lock a file has taken is held until the file commits, so readers and writers of that
// table wait out the file's own work. No statement_timeout is set, because a file's backfill or
// index build takes as long as the data needs, and a limit would only fail a deploy that would
// have finished; a file that needs one sets it with `set local`.
type LockLimits = { timeoutMs: number; attempts: number; pauseMs: number };
const LOCK_LIMITS: LockLimits = { timeoutMs: 5000, attempts: 3, pauseMs: 2000 };
const LOCK_NOT_AVAILABLE = "55P03";

// One transaction as pi_owner. The run already holds the lock.
async function asOwner<T>(client: pg.Client, fn: () => Promise<T>, timeoutMs = LOCK_LIMITS.timeoutMs): Promise<T> {
  await client.query("begin");
  try {
    await client.query("set local role pi_owner");
    await client.query(`set local lock_timeout = ${Math.trunc(timeoutMs)}`);
    const result = await fn();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

// asOwner, tried again from the start while a lock was not granted in time, `attempts` times in all.
async function withRetry<T>(client: pg.Client, limits: LockLimits, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await asOwner(client, fn, limits.timeoutMs);
    } catch (error) {
      if ((error as { code?: string }).code !== LOCK_NOT_AVAILABLE || attempt >= limits.attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, limits.pauseMs));
    }
  }
}

// The runner's own table. Migrations never create it. Row-level security is forced, so the
// owner needs its policy too.
const LEDGER = `
  create schema if not exists policy;
  create table policy.migrations (
    name text primary key,
    checksum text not null,
    applied_at timestamptz not null default now()
  );
  alter table policy.migrations enable row level security;
  alter table policy.migrations force row level security;
  create policy pi_owner_all on policy.migrations for all to pi_owner using (true) with check (true);
  create policy pi_admin_select on policy.migrations for select to pi_admin using (true);
  grant select on policy.migrations to pi_admin;
`;

// One hash of the runner's own ledger and every migration file's name and checksum: a test
// helper names its migrated template by it, so a changed file or ledger makes a new one.
export async function migrationsHash(dir: string = DEFAULT_DIR): Promise<string> {
  const files = await readMigrations(dir);
  return createHash("sha256")
    .update(LEDGER)
    .update(files.map((one) => `${one.file} ${one.checksum}\n`).join(""))
    .digest("hex");
}

// `baseline`, a file path: a database with no ledger yet, a new install, takes the baseline in one
// transaction and records each file it stands for, then the files after them as usual. A database
// with a ledger, a live box, keeps its history and never reads it. With no baseline, or one that
// stands for no file, every file runs from the first.
export async function applyMigrations(
  bootstrapUrl: string,
  dir: string = DEFAULT_DIR,
  limits: LockLimits = LOCK_LIMITS,
  as: MigrateAs = "bootstrap",
  baseline?: string,
): Promise<{ applied: string[] }> {
  // File names are checked before the database is touched.
  const files = await readMigrations(dir);
  const start = await readBaseline(baseline);
  try {
    return await applyFiles(bootstrapUrl, files, limits, as, start);
  } catch (error) {
    // The file that failed rolled back and is not recorded: the owner's run applies it.
    if (as === "migrator" && NEEDS_SUPERUSER.has((error as { code?: string }).code ?? ""))
      throw new CodedError("needs_superuser", { cause: error });
    throw error;
  }
}

function applyFiles(
  url: string,
  files: Migration[],
  limits: LockLimits,
  as: MigrateAs,
  baseline: string | undefined,
): Promise<{ applied: string[] }> {
  return connected(url, async (client) => {
    await prepare(client, as);

    // Every recorded file is checked before any file is applied.
    const { recorded, fresh } = await withRetry(client, limits, async () => {
      const ledger = await client.query<{ found: boolean }>(
        "select to_regclass('policy.migrations') is not null as found",
      );
      if (ledger.rows[0]?.found !== true) await client.query(LEDGER);
      const { rows } = await client.query<{ name: string; checksum: string }>(
        "select name, checksum from policy.migrations order by name",
      );
      for (const row of rows) {
        const file = files.find((candidate) => candidate.file === row.name);
        if (file === undefined) throw new MigrationRefused("missing", row.name);
        if (file.checksum !== row.checksum) throw new MigrationRefused("changed", row.name);
      }
      return { recorded: new Set(rows.map((row) => row.name)), fresh: rows.length === 0 };
    });

    // A new install: the baseline, and a ledger row for each file it stands for, in one transaction.
    const covered = fresh && baseline !== undefined ? files.slice(0, baselineCovers(files, baseline)) : [];
    if (covered.length > 0 && baseline !== undefined)
      await withRetry(client, limits, async () => {
        await client.query(baseline.slice(baseline.indexOf("\n") + 1));
        for (const file of covered)
          await client.query("insert into policy.migrations (name, checksum) values ($1, $2)", [
            file.file,
            file.checksum,
          ]);
      });
    for (const file of covered) recorded.add(file.file);

    // One transaction per file. No other run can record one meanwhile: this one holds the lock.
    const applied: string[] = covered.map((file) => file.file);
    for (const file of files) {
      if (recorded.has(file.file)) continue;
      await withRetry(client, limits, async () => {
        await client.query(file.sql);
        await client.query("insert into policy.migrations (name, checksum) values ($1, $2)", [
          file.file,
          file.checksum,
        ]);
      });
      applied.push(file.file);
    }
    return { applied };
  });
}
