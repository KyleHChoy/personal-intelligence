import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodedError, type RestrictedCategory } from "@intelligence/contracts/personal";
import { repoRoot } from "@intelligence/personal-core";
import pg from "pg";
import { parseDatabaseUrl } from "../core/db.ts";
import { journalPath } from "../core/journal.ts";
import { addCompartmentKey, generateKeyFile, type Keys, loadKeys } from "../core/keys.ts";
import { applyDatabasePrivileges, applyMigrations, migrationsHash } from "../core/migrate.ts";
import { ensureRoles, scramVerifier } from "../core/roles.ts";
import type { Planner } from "../core/run-plan.ts";

// For database tests only. The package root does not export this module. A test database's name
// carries its run's id, and it is dropped by force, falling back to a plain drop.
export { fingerprint } from "../core/fingerprint.ts";
export { sealRow, sealUnder } from "../core/seal.ts";

// `restrictedKeyFile` is the restricted root when the database was made with restricted
// categories, and `keys` then holds both files' keys.
export type TestDatabase = {
  name: string;
  urls: {
    bootstrap: string;
    admin: string;
    writer: string;
    reader: string;
    pipeline: string;
    work: string;
    proxy: string;
    restricted: string;
    notify?: string;
  };
  keys: Keys;
  keyFile: string;
  restrictedKeyFile?: string;
  drop(): Promise<void>;
};

// The password of every role on the local server, as in docker-compose.yml. It guards a
// throwaway server bound to this machine. It is not a secret and no deployment uses it.
const LOCAL_PASSWORD = "local-only";
const HOUR_MS = 60 * 60 * 1000;

const urlFor = (role: string, database: string): string =>
  `postgres://${role}:${LOCAL_PASSWORD}@127.0.0.1:${Number(process.env.INTELLIGENCE_PG_PORT ?? 54329)}/${database}`;

// The local server's maintenance database, as the migrator: for a helper that keeps databases of
// its own, such as hidden-rows-world.ts's template worlds.
export const serverUrl = (): string => urlFor("migrator", "postgres");

// One small pool on the maintenance database, as the migrator, for the sweep and every create and
// drop: a database no longer opens connections of its own. Its connections close when idle, an
// idle one does not keep the process alive, and one the server ends is replaced at the next query.
let maintenancePool: pg.Pool | undefined;
function onServer<Row extends pg.QueryResultRow = Record<string, unknown>>(text: string): Promise<pg.QueryResult<Row>> {
  if (maintenancePool === undefined) {
    maintenancePool = new pg.Pool({
      connectionString: parseDatabaseUrl(serverUrl()).href,
      max: 2,
      idleTimeoutMillis: 1_000,
      allowExitOnIdle: true,
    });
    maintenancePool.on("error", () => {});
  }
  return maintenancePool.query<Row>(text);
}

async function connected<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: parseDatabaseUrl(url).href });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// The whole shape of a name this helper makes, pi_test_<time, base 36>_<pid>_<8 hex>, and of a
// copy a test names after one with a suffix of its own (the restored backups of contacts-gate,
// erase.e2e and lens.e2e: <name>_n1, <name>_c2), which is no older than the name it extends.
const GENERATED = /^pi_test_([0-9a-z]+)_[0-9]+_[0-9a-f]{8}(?:_[0-9a-z]+)*$/;

// Whether the sweep drops a database of this name, at `now`: of the generated shape, and no
// other, with a time part over an hour old.
export function sweepable(name: string, now = Date.now()): boolean {
  const time = GENERATED.exec(name)?.[1];
  return time !== undefined && now - Number.parseInt(time, 36) > HOUR_MS;
}

// Drops every test database a dead run left (sweepable) with nothing connected to it. A failure
// is ignored: another run may be sweeping too.
async function sweep(): Promise<void> {
  const { rows } = await onServer<{ name: string }>(
    `select d.datname as name from pg_database d
     where d.datname like 'pi\\_test\\_%' and not exists (select 1 from pg_stat_activity a where a.datname = d.datname)`,
  );
  for (const { name } of rows)
    if (sweepable(name)) await onServer(`drop database if exists ${pg.escapeIdentifier(name)}`).catch(() => {});
}

// What a database copied from a migrated one lacks: its database-level privileges, which
// `create database ... template` does not copy (migrate.ts, prepare). The schema-level ones and
// every recorded migration are copied with the rows, and the creator, the migrator, owns it.
const grantDatabase = (name: string): Promise<unknown> => {
  const database = pg.escapeIdentifier(name);
  return onServer(`
    revoke all on database ${database} from public;
    grant connect on database ${database} to pi_admin, pi_writer, pi_reader, pi_pipeline, pi_work, pi_proxy, pi_restricted, pi_notify;
    grant create on database ${database} to pi_owner;
  `);
};

const generatedName = (): string =>
  `pi_test_${Date.now().toString(36)}_${process.pid}_${randomBytes(4).toString("hex")}`;

// A migrated template, pi_tpl_<time, base 36>_<16 hex of migrationsHash>: each test database is
// a copy of it, which its name says holds every migration file recorded, so a copy is not
// migrated again: it only takes its database-level privileges (grantDatabase). Migrating every
// database from nothing took a second or more each.
const TEMPLATE = /^pi_tpl_([0-9a-z]+)_([0-9a-f]{16})$/;

// The roles, made once per process. ensureRoles gives pi_proxy and pi_notify no password; on the
// box pi-migrate sets it. Here the bootstrap does, under ensureRoles' lock, so runs take turns.
async function makeRoles(server: string): Promise<void> {
  await ensureRoles(server, {
    admin: LOCAL_PASSWORD,
    writer: LOCAL_PASSWORD,
    reader: LOCAL_PASSWORD,
    pipeline: LOCAL_PASSWORD,
    work: LOCAL_PASSWORD,
    restricted: LOCAL_PASSWORD,
  });
  await connected(server, async (client) => {
    await client.query("select pg_advisory_lock(hashtext('intelligence personal roles'))");
    await client.query(`alter role pi_proxy password ${pg.escapeLiteral(scramVerifier(LOCAL_PASSWORD))}`);
    await client.query(`alter role pi_notify password ${pg.escapeLiteral(scramVerifier(LOCAL_PASSWORD))}`);
  });
}

// The template for these migration files, found or built once per process, one run at a time
// under a lock. Another set's template over an hour old is dropped, as the sweep drops a test
// database (a failure is ignored); a run whose template is dropped builds it again. The build
// goes into a database of the generated shape and is renamed when done, so one a dead run left
// is swept.
async function makeTemplate(server: string): Promise<string> {
  const hash = (await migrationsHash()).slice(0, 16);
  return connected(server, async (client) => {
    await client.query("select pg_advisory_lock(hashtext('intelligence personal test template'))");
    const { rows } = await client.query<{ name: string }>(
      "select datname as name from pg_database where datname like 'pi\\_tpl\\_%'",
    );
    let found: string | undefined;
    for (const { name } of rows) {
      const parts = TEMPLATE.exec(name);
      if (parts?.[1] === undefined) continue;
      if (parts[2] === hash) found = name;
      else if (Date.now() - Number.parseInt(parts[1], 36) > HOUR_MS)
        await client.query(`drop database if exists ${pg.escapeIdentifier(name)}`).catch(() => {});
    }
    if (found !== undefined) return found;
    const building = generatedName();
    const template = `pi_tpl_${Date.now().toString(36)}_${hash}`;
    await client.query(`create database ${pg.escapeIdentifier(building)} template template0`);
    try {
      await applyMigrations(urlFor("migrator", building));
      await client.query(`alter database ${pg.escapeIdentifier(building)} rename to ${pg.escapeIdentifier(template)}`);
    } catch (error) {
      await client.query(`drop database if exists ${pg.escapeIdentifier(building)}`).catch(() => {});
      throw error;
    }
    return template;
  });
}

// Each is made once per process; a failure is forgotten, so the next call tries again.
let roles: Promise<void> | undefined;
let template: Promise<string> | undefined;
const rolesReady = (server: string): Promise<void> =>
  (roles ??= makeRoles(server).catch((error: unknown) => {
    roles = undefined;
    throw error;
  }));
const templateReady = (server: string): Promise<string> =>
  (template ??= makeTemplate(server).catch((error: unknown) => {
    template = undefined;
    throw error;
  }));

// The local server answers as the migrator, or a failure that says what to run: the server is down,
// or it was not started from this repository's docker-compose.yml, whose first start makes the
// migrator. Checked once per process; a failure is forgotten, so the next call checks again.
let reachable: Promise<void> | undefined;
const serverReady = (): Promise<void> =>
  (reachable ??= onServer("select 1").then(
    () => {},
    (error: unknown) => {
      reachable = undefined;
      const code = (error as { code?: string }).code;
      if (code === "ECONNREFUSED" || code === "ETIMEDOUT")
        throw new CodedError("test_server_down", {
          message: "the local Postgres server is not running: run pnpm db:up",
        });
      if (code === "28P01" || code === "28000")
        throw new CodedError("test_server_foreign", {
          message: "the server on the test port has no migrator role: run pnpm db:down && pnpm db:up",
        });
      throw error;
    },
  ));

// Everything a test database is copied from, made when it is missing: the roles, and the template
// every migration file was applied to. Tests call it through createTestDatabase; a run of many test
// files calls it first, so a migration that fails shows as that and not as every test failing. The
// template's name.
export async function prepareTestServer(): Promise<string> {
  const server = serverUrl();
  await serverReady();
  await rolesReady(server);
  return templateReady(server);
}

// `restricted` names the categories whose keys go into a restricted key file beside the key file. It
// writes no policy.restricted_categories row: a test turns a category on itself, as pi_admin.
// `migrated` keeps what the migrations left.
export async function createTestDatabase(options?: {
  compartments?: string[];
  migrations?: boolean;
  keyFile?: string;
  restricted?: RestrictedCategory[];
  planner?: Planner | "migrated";
}): Promise<TestDatabase> {
  const server = urlFor("migrator", "postgres");
  await serverReady();
  await sweep();

  const name = generatedName();
  await rolesReady(server);
  const create = (source: string) =>
    onServer(`create database ${pg.escapeIdentifier(name)} template ${pg.escapeIdentifier(source)}`);
  // template0 holds nothing: the core uses no extension.
  if (options?.migrations === false) await create("template0");
  else {
    try {
      await create(await templateReady(server));
    } catch (error) {
      // 3D000: another run dropped the template this process found. Build it again, once.
      if ((error as { code?: string }).code !== "3D000") throw error;
      template = undefined;
      await create(await templateReady(server));
    }
  }

  // A key file of its own in a fresh folder, unless the caller shares one. A restricted file is
  // always the helper's own, in a fresh folder.
  const keyFolder = options?.keyFile === undefined ? await mkdtemp(join(tmpdir(), "pi-test-keys-")) : undefined;
  const keyFile = options?.keyFile ?? join(keyFolder ?? "", "keys.json");
  const restrictedFolder =
    options?.restricted === undefined ? undefined : await mkdtemp(join(tmpdir(), "pi-test-restricted-"));
  const restrictedKeyFile = restrictedFolder === undefined ? undefined : join(restrictedFolder, "restricted-keys.json");

  const drop = dropper(name, [keyFolder, restrictedFolder]);
  try {
    if (keyFolder !== undefined) await generateKeyFile(keyFile, options?.compartments ?? ["own", "employer:example"]);
    for (const category of options?.restricted ?? [])
      await addCompartmentKey(keyFile, `restricted:${category}`, restrictedKeyFile);
    const keys = await loadKeys(keyFile, restrictedKeyFile);
    // A database from template0 also needs `revoke all on schema public from public`, which only
    // a connection to it can run; a copy of the template has it already.
    if (options?.migrations === false) await applyDatabasePrivileges(urlFor("migrator", name));
    else await grantDatabase(name);
    const planner = options?.planner ?? "split";
    if (options?.migrations !== false && planner !== "migrated")
      await queryAs(urlFor("pi_admin", name), "update policy.work_settings set planner = $1", [planner]);
    return made(name, keys, keyFile, restrictedKeyFile, drop);
  } catch (error) {
    await drop().catch(() => {});
    throw error;
  }
}

// Drops a test database by its name, for a test that made a copy of its own. The forced drop ends
// the migrator's own connections and is refused whole ("permission denied to terminate process")
// while any other backend is in the database: a pi_* connection, which a test ends first, whose
// backend has not yet left though its client has closed, as happens under load, or an autovacuum
// worker on the new database. So a refused forced drop falls back to the plain one, which waits
// up to five seconds for those backends to leave and ends an autovacuum worker itself.
export async function dropDatabase(name: string): Promise<void> {
  const statement = `drop database if exists ${pg.escapeIdentifier(name)}`;
  await onServer(`${statement} with (force)`)
    .catch(() => onServer(statement))
    .catch(() => {
      throw new Error(`could not drop test database ${name}`);
    });
}

// The helper keeps no connection to a test database open, and a test ends its own pools and
// writers first. The folders go with the database.
function dropper(name: string, folders: (string | undefined)[]): () => Promise<void> {
  return async () => {
    try {
      await dropDatabase(name);
    } finally {
      for (const folder of folders) if (folder !== undefined) await rm(folder, { recursive: true, force: true });
    }
  };
}

function made(
  name: string,
  keys: Keys,
  keyFile: string,
  restrictedKeyFile: string | undefined,
  drop: () => Promise<void>,
): TestDatabase {
  return {
    name,
    urls: {
      bootstrap: urlFor("migrator", name),
      admin: urlFor("pi_admin", name),
      writer: urlFor("pi_writer", name),
      reader: urlFor("pi_reader", name),
      pipeline: urlFor("pi_pipeline", name),
      work: urlFor("pi_work", name),
      proxy: urlFor("pi_proxy", name),
      restricted: urlFor("pi_restricted", name),
      notify: urlFor("pi_notify", name),
    },
    keys,
    keyFile,
    ...(restrictedKeyFile === undefined ? {} : { restrictedKeyFile }),
    drop,
  };
}

// A copy of a test database, rows and all, made by Postgres with `source` as its template: for
// tests that would each build the same rows again (a world synced is thousands of statements; a
// copy is one). Nothing may be connected to `source` while it is copied, so its writers and pools
// are closed first. The copy's key files, and the erasure journal beside them when there is one,
// are copies of the source's, in a fresh folder: what a test adds to them is the copy's own.
export async function copyTestDatabase(source: TestDatabase): Promise<TestDatabase> {
  const name = generatedName();
  await onServer(`create database ${pg.escapeIdentifier(name)} template ${pg.escapeIdentifier(source.name)}`);
  const folder = await mkdtemp(join(tmpdir(), "pi-test-keys-"));
  const drop = dropper(name, [folder]);
  try {
    // The database's own privileges are not copied with it; the migrations are all recorded.
    await grantDatabase(name);
    const keyFile = join(folder, "keys.json");
    await copyFile(source.keyFile, keyFile);
    const restrictedKeyFile = source.restrictedKeyFile === undefined ? undefined : join(folder, "restricted-keys.json");
    if (source.restrictedKeyFile !== undefined && restrictedKeyFile !== undefined)
      await copyFile(source.restrictedKeyFile, restrictedKeyFile);
    await copyFile(journalPath(source.keyFile), journalPath(keyFile)).catch((error: unknown) => {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    });
    return made(name, await loadKeys(keyFile, restrictedKeyFile), keyFile, restrictedKeyFile, drop);
  } catch (error) {
    await drop().catch(() => {});
    throw error;
  }
}

// For a file whose tests each start from the same rows: `build` runs once, at the first `copy`,
// and each `copy` is a copy of what it built (copyTestDatabase). `build` closes every connection
// it opens. The file drops what was built with `drop`, in its afterAll.
export function copiesOf(build: () => Promise<TestDatabase>): { copy(): Promise<TestDatabase>; drop(): Promise<void> } {
  let built: Promise<TestDatabase> | undefined;
  return {
    async copy() {
      if (built === undefined) {
        const making = build();
        built = making;
        making.catch(() => {
          built = undefined;
        });
      }
      return copyTestDatabase(await built);
    },
    async drop() {
      const was = built;
      built = undefined;
      await (await was?.catch(() => undefined))?.drop();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// States kept across the files of a run
// ---------------------------------------------------------------------------------------------

// A state that many files build alike (the synthetic world synced, say) is built once and kept
// as a template database, pi_syn_<time, base 36>_<16 hex>_<8 hex>: the first hex is the key of
// the code that builds it (keptKey), the second names the state. Its key files, its erasure
// journal when there is one, and what its build made are kept beside it, in KEPT. A state is
// reused for REUSE_MS after it was built and then built again, so the time it was built at, which
// its rows and what it made may carry, is never far from the clock a test reads. A state built
// again is dropped once a file that found the old one is likely done with it (twice REUSE_MS);
// any other over an hour old is dropped too.
const KEPT = join(tmpdir(), "pi-kept-states");
const KEPT_NAME = /^pi_syn_([0-9a-z]+)_([0-9a-f]{16})_([0-9a-f]{8})$/;
export const REUSE_MS = 10 * 60 * 1000;

// Of the kept states' names, the one to reuse for `key` and `label` at `now`, and those to drop.
export function keptPlan(names: string[], key: string, label: string, now: number): { reuse?: string; drop: string[] } {
  let reuse: { name: string; time: number } | undefined;
  const drop: string[] = [];
  for (const name of names) {
    const parts = KEPT_NAME.exec(name);
    if (parts?.[1] === undefined) continue;
    const time = Number.parseInt(parts[1], 36);
    const same = parts[2] === key && parts[3] === label;
    if (same && now - time < REUSE_MS) {
      if (reuse === undefined || time > reuse.time) reuse = { name, time };
    } else if (now - time > (same ? 2 * REUSE_MS : HOUR_MS)) drop.push(name);
  }
  return { ...(reuse === undefined ? {} : { reuse: reuse.name }), drop };
}

// The repository's root, and the code under it a kept state is built by: everything in the
// personal apps and packages and in the shared packages, but tests and docs.
const ROOT = repoRoot();
const CODE = ["apps", "packages"];
const SKIPPED = new Set(["node_modules", "dist"]);

// One hash of every file under `dirs` of `root`, by its path and its bytes, but tests (*.test.ts)
// and docs (*.md): a change to any of them changes the key.
export async function codeKey(root: string, dirs: string[]): Promise<string> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true }).catch(() => [])) {
      const path = `${dir}/${entry.name}`;
      if (entry.name.startsWith(".") || SKIPPED.has(entry.name)) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".md")) files.push(path);
    }
  };
  for (const dir of dirs) await walk(dir);
  const hash = createHash("sha256");
  for (const file of files.sort())
    hash
      .update(`${file}\0`)
      .update(await readFile(join(root, file)))
      .update("\0");
  return hash.digest("hex");
}

// The key of a kept state: the migrations, the lockfile and the code (codeKey), once per process.
let keyOfCode: Promise<string> | undefined;
const keptKey = (): Promise<string> =>
  (keyOfCode ??= (async () => {
    const hash = createHash("sha256")
      .update(await migrationsHash())
      .update(await readFile(join(ROOT, "pnpm-lock.yaml")));
    return hash
      .update(await codeKey(ROOT, CODE))
      .digest("hex")
      .slice(0, 16);
  })());

export type Kept<T> = { db: TestDatabase; made: T };
const keptStates = new Map<string, Promise<Kept<unknown>>>();

// A copy of the kept state named `state` (copyTestDatabase), and what its build made. The state
// is found or built once per process, and built by one process at a time, under a lock. `build`
// returns its database with every connection closed, a `drop` that removes what the build made
// beside it, and what it made, as JSON. Every copy a process makes is of the same state, unless
// another process dropped it meanwhile: then it is found or built again, once.
export async function copyKept<T>(state: string, build: () => Promise<Kept<T>>): Promise<Kept<T>> {
  for (let attempt = 0; ; attempt += 1) {
    let found = keptStates.get(state) as Promise<Kept<T>> | undefined;
    if (found === undefined) {
      found = findOrBuildKept(state, build);
      keptStates.set(state, found);
      found.catch(() => keptStates.delete(state));
    }
    const kept = await found;
    try {
      return { db: await copyTestDatabase(kept.db), made: kept.made };
    } catch (error) {
      // 3D000: the state no longer exists.
      if ((error as { code?: string }).code !== "3D000" || attempt > 0) throw error;
      keptStates.delete(state);
    }
  }
}

async function findOrBuildKept<T>(state: string, build: () => Promise<Kept<T>>): Promise<Kept<T>> {
  const key = await keptKey();
  const label = createHash("sha256").update(state).digest("hex").slice(0, 8);
  return connected(serverUrl(), async (client) => {
    await client.query("select pg_advisory_lock(hashtext('intelligence personal kept states'))");
    const { rows } = await client.query<{ name: string }>(
      "select datname as name from pg_database where datname like 'pi\\_syn\\_%'",
    );
    const plan = keptPlan(
      rows.map((row) => row.name),
      key,
      label,
      Date.now(),
    );
    for (const name of plan.drop) {
      await client.query(`drop database if exists ${pg.escapeIdentifier(name)}`).then(
        () => rm(join(KEPT, name), { recursive: true, force: true }),
        () => {},
      );
    }
    if (plan.reuse !== undefined) {
      const made = await readFile(join(KEPT, plan.reuse, "made.json"), "utf8").catch(() => undefined);
      if (made !== undefined) return { db: keptDb(plan.reuse), made: JSON.parse(made) as T };
      // Its folder is gone (a cleared temporary folder): built again.
      await client.query(`drop database if exists ${pg.escapeIdentifier(plan.reuse)}`);
    }
    const built = await build();
    const name = `pi_syn_${Date.now().toString(36)}_${key}_${label}`;
    const folder = join(KEPT, name);
    try {
      // No state yet has a restricted key file, and keptDb would not find one.
      if (built.db.restrictedKeyFile !== undefined)
        throw new Error("copyKept: a state with a restricted key file is not kept");
      await mkdir(folder, { recursive: true });
      const kept = keptDb(name);
      await copyFile(built.db.keyFile, kept.keyFile);
      await copyFile(journalPath(built.db.keyFile), journalPath(kept.keyFile)).catch((error: unknown) => {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
      });
      await client.query(`alter database ${pg.escapeIdentifier(built.db.name)} rename to ${pg.escapeIdentifier(name)}`);
      // Written last: a state without it is built again.
      await writeFile(join(folder, "made.json"), JSON.stringify(built.made));
      return { db: kept, made: built.made };
    } catch (error) {
      await rm(folder, { recursive: true, force: true });
      throw error;
    } finally {
      // The build's own database, when it was not renamed, and its folders.
      await built.db.drop().catch(() => {});
    }
  });
}

// A kept state as copyTestDatabase reads a source: its name and its key files. It is never opened.
function keptDb(name: string): TestDatabase {
  return {
    name,
    urls: { bootstrap: urlFor("migrator", name) } as TestDatabase["urls"],
    keys: undefined as never,
    keyFile: join(KEPT, name, "keys.json"),
    drop: async () => {},
  };
}

// One statement as the role in `url`, any role.
export async function queryAs<Row = Record<string, unknown>>(
  url: string,
  text: string,
  values?: unknown[],
): Promise<Row[]> {
  return connected(url, async (client) => (await client.query(text, values)).rows as Row[]);
}

// One statement as pi_admin in a test store's database.
export const adminRows = <Row = Record<string, unknown>>(
  store: { db: { urls: { admin: string } } },
  text: string,
  values?: unknown[],
): Promise<Row[]> => queryAs<Row>(store.db.urls.admin, text, values);

// Whether a value read from a column holds a needle: in a string, in that string read as
// base64, in an element of an array, or in a key or a value of a JSON object, at any depth.
function holds(value: unknown, needles: string[]): boolean {
  if (typeof value === "string") {
    const texts = [value.toLowerCase(), Buffer.from(value, "base64").toString("utf8").toLowerCase()];
    return needles.some((needle) => texts.some((text) => text.includes(needle)));
  }
  if (Array.isArray(value)) return value.some((one) => holds(one, needles));
  if (typeof value === "object" && value !== null)
    return Object.entries(value).some(([key, one]) => holds(key, needles) || holds(one, needles));
  return false;
}

// The column types the scan reads, and those that hold no text at all. A column of any other
// type stops the scan: it could hold a needle the scan would never see. `float4` is `real`,
// which the opportunities use (their two probabilities).
const READ = new Set(["text", "varchar", "_text", "_varchar", "jsonb"]);
// float8 holds the warmth projection's scores; _float8 an explore flag's value parts.
const NO_TEXT = new Set(["bool", "int4", "int8", "timestamptz", "date", "float4", "float8", "_float8", "numeric"]);

// It reads the catalogue, not the information schema, so a table the role may not read fails the
// scan and is never passed over.
export async function scanForPlaintext(
  adminUrl: string,
  needles: string[],
): Promise<{ table: string; column: string }[]> {
  const wanted = needles.filter((needle) => needle !== "").map((needle) => needle.toLowerCase());
  return connected(adminUrl, async (client) => {
    const columns = await client.query<{ schema: string; table: string; column: string; type: string }>(
      `select n.nspname as schema, c.relname as table, a.attname as column, t.typname as type
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_type t on t.oid = a.atttypid
       where c.relkind in ('r', 'p') and n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
         -- ledger.handles is read by no runtime role, pi_admin included, and holds ids and
         -- handles only (handles-database.db.test.ts); policy.capture_push_refusals the same,
         -- client ids, hours and counts (lens-functions.db.test.ts); policy.labels the same,
         -- compartment names only, each label key and its compartments (label-key-schema.db.test.ts);
         -- ledger.owner_read_marks the same, a writing transaction's id, until a compaction. The scan passes over those four by name, and
         -- only them.
         and not (n.nspname = 'ledger' and c.relname = 'handles')
         and not (n.nspname = 'ledger' and c.relname = 'owner_read_marks')
         and not (n.nspname = 'policy' and c.relname = 'capture_push_refusals')
         and not (n.nspname = 'policy' and c.relname = 'labels')
         and a.attnum > 0 and not a.attisdropped
       order by n.nspname, c.relname, a.attnum`,
    );
    const unknown = columns.rows.find((one) => !READ.has(one.type) && !NO_TEXT.has(one.type));
    if (unknown !== undefined) {
      const at = `${unknown.schema}.${unknown.table}.${unknown.column}`;
      throw new CodedError("unknown_column_type", { message: `the scan cannot read ${at}, of type ${unknown.type}` });
    }
    const found: { table: string; column: string }[] = [];
    for (const { schema, table, column } of columns.rows.filter((one) => READ.has(one.type))) {
      const name = pg.escapeIdentifier(column);
      const { rows } = await client.query<{ value: unknown }>(
        `select ${name} as value from ${pg.escapeIdentifier(schema)}.${pg.escapeIdentifier(table)} where ${name} is not null`,
      );
      if (rows.some((row) => holds(row.value, wanted))) found.push({ table: `${schema}.${table}`, column });
    }
    return found;
  });
}
