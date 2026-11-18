import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "@intelligence/personal-core";
import { afterEach, describe, expect, it } from "vitest";

// bin/pi-migrate with its paths moved under a directory of its own, its superuser's psql and the
// migration replaced by stubs, so what it says and when it checks the roles run with no server.
// The check's own query is held by the store's role-check.db.test.ts.

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// The stub psql notes each statement it is sent in root/sql, then answers: the role check with
// root/found, the bootstrap's sessions with root/sessions (each 0 when absent), and the closing
// line as the server would. A statement that holds the text in root/refuse fails, as a server that
// refused it would. With root/accepts, a login (`select 1;`) is refused under any password but the
// one that file holds.
const SUPERUSER = (root: string, dbquery: string): string => `hostport=127.0.0.1:5432
dbquery='${dbquery}'
sql() {
  input=$(cat)
  printf '%s\\n--\\n' "$input" >> ${root}/sql
  if [ -f ${root}/refuse ]; then case $input in *"$(cat ${root}/refuse)"*) return 1 ;; esac; fi
  if [ -f ${root}/accepts ] && [ "$input" = 'select 1;' ] && [ "$PGPASSWORD" != "$(cat ${root}/accepts)" ]; then return 1; fi
  case $input in
    *pi.role_prefix*) cat ${root}/found 2> /dev/null || echo 0 ;;
    *"count(*) from pg_stat_activity"*) cat ${root}/sessions 2> /dev/null || echo 0 ;;
    *"bootstrap can log in"*) echo 'bootstrap can log in: false' ;;
  esac
}
`;

const CREDENTIAL = "data/pi-root/migrate.env";
const OLD = "a".repeat(64);
const NEXT = "b".repeat(64);
const VERIFIER = "SCRAM-SHA-256$4096:c2FsdA==$a2V5:c2VydmVy";

async function migrate(
  files: Record<string, string> = {},
  dbquery = "",
  args: string[] = [],
  // Files given a time an hour ahead once all are written, as the owner's later `touch`.
  touched: string[] = [],
): Promise<{
  status: number | null;
  lines: string[];
  err: string;
  sql: string;
  bootstrap: string;
  credential: string;
  verified: string[];
  left: string[];
  // Which of the box's hold files and its wait for this migration stand after the run.
  box: string[];
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-migrate-"));
  roots.push(root);
  for (const dir of ["lib", "run/pi", "run/pimcp", "run/pirestricted", "run/pisend", "run/pinotify", "data"])
    await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, "lib", "superuser.sh"), SUPERUSER(root, dbquery));
  await writeFile(join(root, "lib", "role-check.sql"), "select 1 -- pi.role_prefix\n");
  // The migration: noted in root/sql, so the order of what is sent is seen, with the bootstrap's
  // file as it was handed over kept in root/bootstrap. It writes root/migrate.err on its standard
  // error and ends with root/migrate.status, as `pi db migrate` would a refusal.
  await writeFile(
    join(root, "lib", "as-pi"),
    `#!/bin/sh\nprintf 'migrate %s\\n--\\n' "$*" >> ${root}/sql\ncp ${root}/run/pi/bootstrap.env ${root}/bootstrap\n[ ! -f ${root}/migrate.err ] || cat ${root}/migrate.err >&2\nexit $(cat ${root}/migrate.status 2> /dev/null || echo 0)\n`,
  );
  await chmod(join(root, "lib", "as-pi"), 0o755);
  // pi db verifier, run through setpriv: one fixed verifier.
  await writeFile(join(root, "lib", "setpriv"), `#!/bin/sh\necho '${VERIFIER}'\n`);
  await chmod(join(root, "lib", "setpriv"), 0o755);
  // pi db verifier, run as root for the migrator's own password: the same verifier, with each
  // password it was given on its standard input noted in root/verified.
  await writeFile(join(root, "lib", "pi-verifier"), `#!/bin/sh\ncat >> ${root}/verified\necho '${VERIFIER}'\n`);
  await chmod(join(root, "lib", "pi-verifier"), 0o755);
  for (const [name, value] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), value);
  }
  const later = new Date(Date.now() + 3_600_000);
  for (const name of touched) await utimes(join(root, name), later, later);
  const source = await readFile(join(repoRoot(), "deploy/bin/pi-migrate"), "utf8");
  expect(source).toContain("chown pi:pi ");
  expect(source).toContain("  sleep 1\n");
  const moved = source
    .replaceAll("/usr/local/lib/pi/", `${root}/lib/`)
    .replaceAll("/run/", `${root}/run/`)
    .replaceAll("/data/", `${root}/data/`)
    .replaceAll("/usr/bin/setpriv", `${root}/lib/setpriv`)
    .replace("/usr/local/bin/pi db verifier) || made=", `${root}/lib/pi-verifier) || made=`)
    .replace(/chown pi:pi [^\n]*/, ":")
    .replace("  sleep 1\n", "  :\n");
  await writeFile(join(root, "pi-migrate"), moved);
  const run = spawnSync("/bin/sh", [join(root, "pi-migrate"), ...args], { encoding: "utf8" });
  const text = (name: string): Promise<string> => readFile(join(root, name), "utf8").catch(() => "");
  return {
    status: run.status,
    lines: run.stdout.trim().split("\n"),
    err: run.stderr,
    sql: await text("sql"),
    bootstrap: await text("bootstrap"),
    credential: await text(CREDENTIAL),
    verified: (await text("verified")).split("\n").filter((one) => one !== ""),
    // What the run left in the two directories a password passes through.
    left: [
      ...(await readdir(join(root, "run/pi"))),
      ...(await readdir(join(root, "data/pi-root")).catch(() => [])),
    ].sort(),
    box: (
      await Promise.all(
        ["read-hold", "sync-hold", "migrate-wait"].map(async (name) =>
          (await stat(join(root, "data", name)).catch(() => null)) === null ? [] : [name],
        ),
      )
    ).flat(),
  };
}

describe("bin/pi-migrate", () => {
  it("says every role's password status with no send URL, and ends saying the bootstrap cannot log in", async () => {
    const { status, lines } = await migrate();
    expect(status).toBe(0);
    expect(lines).toEqual([
      "roles: as expected",
      "restricted password: skipped",
      "unattended migration: off",
      "notify password: skipped",
      "proxy password: skipped",
      "bootstrap can log in: false",
    ]);
  });

  it("says the restricted password was set when its URL was handed to the migration", async () => {
    const { lines } = await migrate({
      "run/pirestricted/restricted.env": "PI_DATABASE_URL_RESTRICTED=postgres://pi_restricted:x@h:5432/pi\n",
    });
    expect(lines).toContain("restricted password: set");
  });

  it("takes the login away and ends the sessions after the migration, then checks the roles", async () => {
    const { sql } = await migrate();
    const at = (text: string, from = 0): number => sql.indexOf(text, from);
    const migrated = at("migrate bootstrap db migrate");
    const disabled = at("nologin password null", migrated);
    const ended = at("pg_terminate_backend", disabled);
    const checked = at("pi.role_prefix", ended);
    expect([migrated, disabled, ended, checked].every((one) => one >= 0)).toBe(true);
    expect(sql).toContain("set pi.role_prefix = 'pi_';\nset pi.role_bootstrap = 'pi_bootstrap';");
  });

  it("fails with one fixed line, before any other role's password, when the roles are not as expected", async () => {
    const { status, lines } = await migrate({ found: "1\n" });
    expect(status).toBe(1);
    expect(lines).toEqual(["roles: not as expected", "bootstrap can log in: false"]);
  });

  it("fails the same way while a session of the bootstrap is left", async () => {
    const { status, lines } = await migrate({ sessions: "1\n" });
    expect(status).toBe(1);
    expect(lines).toEqual(["roles: not as expected", "bootstrap can log in: false"]);
  });

  it("fails the same way when the check cannot run", async () => {
    const { status, lines } = await migrate({ found: "" });
    expect(status).toBe(1);
    expect(lines[0]).toBe("roles: not as expected");
  });

  it("hands the migration a bootstrap URL with no query when the admin URL has none", async () => {
    const { bootstrap } = await migrate();
    expect(bootstrap).toMatch(
      /^PI_DATABASE_URL_BOOTSTRAP=postgres:\/\/pi_bootstrap:[0-9a-f]{64}@127\.0\.0\.1:5432\/pi$/m,
    );
  });

  it("carries the admin URL's sslmode and sslrootcert on to the bootstrap URL", async () => {
    const { bootstrap } = await migrate({}, "sslmode=verify-full&sslrootcert=/etc/ssl/pi/ca.pem");
    expect(bootstrap).toMatch(
      /^PI_DATABASE_URL_BOOTSTRAP=postgres:\/\/pi_bootstrap:[0-9a-f]{64}@127\.0\.0\.1:5432\/pi\?sslmode=verify-full&sslrootcert=\/etc\/ssl\/pi\/ca\.pem$/m,
    );
  });

  const NOTIFY = `postgres://pi_notify:${"a".repeat(64)}@h:5432/pi`;
  it("sets the notify password from a URL with no query, and from one with sslmode and sslrootcert", async () => {
    for (const url of [NOTIFY, `${NOTIFY}?sslmode=verify-full&sslrootcert=/etc/ssl/pi/ca.pem`]) {
      const { lines, sql } = await migrate({ "run/pinotify/notify.env": `PI_DATABASE_URL_NOTIFY=${url}\n` });
      expect(lines).toContain("notify password: set");
      expect(sql).toContain("alter role pi_notify password 'SCRAM-SHA-256$4096:c2FsdA==$a2V5:c2VydmVy';");
    }
  });

  it("refuses a notify URL whose query names anything but sslmode and sslrootcert", async () => {
    for (const query of ["host=elsewhere", "sslmode=require&host=elsewhere", "sslmode=require?x", "sslmode="]) {
      const { status, lines } = await migrate({
        "run/pinotify/notify.env": `PI_DATABASE_URL_NOTIFY=${NOTIFY}?${query}\n`,
      });
      expect(status).toBe(1);
      expect(lines).toContain("notify password: refused");
    }
  });
});

// The statement that sets the migrator's password: a verifier, never the password.
const PASSWORD_SET = `alter role pi_migrator password '${VERIFIER}';`;

describe("bin/pi-migrate and the standing migration credential", () => {
  it("makes no credential unless asked, and takes the login from a migrator left without its file", async () => {
    const { status, lines, sql, credential } = await migrate();
    expect(status).toBe(0);
    expect(lines).toContain("unattended migration: off");
    expect(credential).toBe("");
    expect(sql).toContain("alter role pi_migrator nologin password null");
    expect(sql).not.toMatch(/create role|grant pi_owner/);
  });

  it("--enable-auto makes the role as the superuser, after the bootstrap is shut and before the roles are checked, and keeps its password in root's file alone", async () => {
    const { status, lines, sql, bootstrap, credential, verified, left } = await migrate({}, "", ["--enable-auto"]);
    expect(status).toBe(0);
    expect(lines).toContain("unattended migration: on");
    const at = (text: string, from = 0): number => sql.indexOf(text, from);
    const shut = at("nologin password null", at("migrate bootstrap db migrate"));
    const made = at(
      "create role pi_migrator login nosuperuser nobypassrls nocreatedb nocreaterole noreplication",
      shut,
    );
    const checked = at("pi.role_prefix", made);
    expect([shut, made, checked].every((one) => one >= 0)).toBe(true);
    expect(sql).toContain("grant pi_owner to pi_migrator with set true, inherit false, admin false;");
    expect(sql).toContain("grant connect on database pi to pi_migrator;");
    // The password is in root's file and was sent to the server only as its verifier.
    expect(verified).toHaveLength(1);
    const password = verified[0] as string;
    expect(password).toMatch(/^[0-9a-f]{64}$/);
    expect(credential).toBe(`${password}\n`);
    expect(at(PASSWORD_SET, made)).toBeGreaterThan(made);
    expect(sql).not.toContain(password);
    // pi is handed the bootstrap's URL and never the migrator's password.
    expect(bootstrap).toContain("postgres://pi_bootstrap:");
    expect(bootstrap).not.toContain(password);
    expect(left).toEqual(["migrate.env"]);
  });

  it("--enable-auto over a credential keeps the old file when the server refuses the new password, and leaves no other", async () => {
    const { status, credential, left } = await migrate(
      { [CREDENTIAL]: `${OLD}\n`, refuse: "alter role pi_migrator password" },
      "",
      ["--enable-auto"],
    );
    expect(status).toBe(1);
    expect(credential).toBe(`${OLD}\n`);
    expect(left).toEqual(["migrate.env"]);
  });

  it("writes the new password beside the credential before the server has it, and renames it after", async () => {
    // The stub's server notes what root's directory held as the statement reached it.
    const source = await readFile(join(repoRoot(), "deploy/bin/pi-migrate"), "utf8");
    const replace = source.slice(
      source.indexOf("\nreplace() {"),
      source.indexOf("\n}\n", source.indexOf("\nreplace() {")),
    );
    const at = (text: string): number => replace.indexOf(text);
    const written = at(`> "$credential.next"`);
    const sent = at("alter role pi_migrator password");
    const renamed = at(`mv -f "$credential.next" "$credential"`);
    expect(written).toBeGreaterThan(0);
    expect(sent).toBeGreaterThan(written);
    expect(renamed).toBeGreaterThan(sent);
  });

  it("a run without the flag and without a credential removes a half-written one", async () => {
    const { lines, left } = await migrate({ [`${CREDENTIAL}.next`]: `${NEXT}\n` });
    expect(lines).toContain("unattended migration: off");
    expect(left).toEqual([]);
  });

  it("a run without the flag keeps a credential that is there", async () => {
    const { lines, sql, credential } = await migrate({ [CREDENTIAL]: `${OLD}\n` });
    expect(lines).toContain("unattended migration: on");
    expect(credential).toBe(`${OLD}\n`);
    expect(sql).not.toContain("pi_migrator");
  });

  it("fails before any role's password when the roles are not as expected, the new credential included", async () => {
    const { status, lines } = await migrate({ found: "1\n" }, "", ["--enable-auto"]);
    expect(status).toBe(1);
    expect(lines).toEqual(["roles: not as expected", "bootstrap can log in: false"]);
  });

  it("refuses any other argument, and a second one, before it asks or sends anything", async () => {
    for (const args of [["--force"], ["auto"], ["--auto", "--enable-auto"]]) {
      const { status, sql, err } = await migrate({ [CREDENTIAL]: `${OLD}\n` }, "", args);
      expect({ args, status, sql }).toEqual({ args, status: 2, sql: "" });
      expect(err).toContain("usage: pi-migrate [--enable-auto | --auto]");
    }
  });
});

describe("bin/pi-migrate --auto", () => {
  const auto = (files: Record<string, string> = {}) => migrate({ [CREDENTIAL]: `${OLD}\n`, ...files }, "", ["--auto"]);

  it("does nothing without the credential file, and says so", async () => {
    const { status, lines, sql } = await migrate({}, "", ["--auto"]);
    expect({ status, lines, sql }).toEqual({ status: 3, lines: ["no_migration_credential"], sql: "" });
  });

  it("applies the files as the migrator, replaces the password pi read, ends its sessions, then checks the roles", async () => {
    const { status, lines, sql, bootstrap, credential, verified, left } = await auto();
    expect({ status, lines }).toEqual({ status: 0, lines: ["migrated"] });
    expect(bootstrap).toMatch(
      new RegExp(`^PI_DATABASE_URL_BOOTSTRAP=postgres://pi_migrator:${OLD}@127\\.0\\.0\\.1:5432/pi$`, "m"),
    );
    const at = (text: string, from = 0): number => sql.indexOf(text, from);
    const migrated = at("migrate bootstrap db migrate --auto");
    const replaced = at(PASSWORD_SET, migrated);
    const ended = at("pg_terminate_backend", replaced);
    const checked = at("pi.role_prefix", ended);
    expect([migrated, replaced, ended, checked].every((one) => one >= 0)).toBe(true);
    // The new password reaches the server as a verifier alone: no statement holds it.
    const password = verified[0] as string;
    expect(verified).toHaveLength(1);
    expect(password).toMatch(/^[0-9a-f]{64}$/);
    expect(password).not.toBe(OLD);
    expect(credential).toBe(`${password}\n`);
    expect(sql).not.toContain(password);
    // Neither bootstrap.env nor a half-written credential is left.
    expect(left).toEqual(["migrate.env"]);
    // No role is made or altered, and no role's password but its own is set.
    expect(sql).not.toMatch(/pi_bootstrap nologin|create role|alter role pi_(?!migrator password)|grant /);
  });

  it("names a file that needs the superuser, sets no role's password, and still replaces its own", async () => {
    const { status, lines, sql, err, credential, verified } = await auto({
      "migrate.status": "1\n",
      "migrate.err": '{"event":"command_failed","level":"error","code":"needs_superuser"}\n',
    });
    expect({ status, lines }).toEqual({ status: 1, lines: ["needs_superuser"] });
    expect(err).toContain('"code":"needs_superuser"');
    expect(sql).toContain(PASSWORD_SET);
    expect(credential).toBe(`${verified[0]}\n`);
    expect(credential).not.toBe(`${OLD}\n`);
    expect(sql).not.toMatch(/pi\.role_prefix|alter role pi_(?!migrator password)/);
  });

  it("any other failure of the migration is migrate_failed", async () => {
    const { status, lines } = await auto({
      "migrate.status": "1\n",
      "migrate.err": '{"event":"command_failed","level":"error","code":"changed"}\n',
    });
    expect({ status, lines }).toEqual({ status: 1, lines: ["migrate_failed"] });
  });

  it("fails when the roles are not as expected, or a session of the migrator is left", async () => {
    for (const files of [{ found: "1\n" }, { sessions: "1\n" }, { found: "" }]) {
      const { status, lines } = await auto(files);
      expect({ files, status, lines }).toEqual({ files, status: 1, lines: ["roles_not_as_expected"] });
    }
  });

  it("refuses a credential that is not a password it made, or that the server refuses, and migrates nothing", async () => {
    for (const files of [{ [CREDENTIAL]: "postgres\n" }, { [CREDENTIAL]: `${OLD}0\n` }, { refuse: "select 1;" }]) {
      const { status, lines, sql } = await auto(files);
      expect({ status, lines }).toEqual({ status: 1, lines: ["migration_credential_refused"] });
      expect(sql).not.toContain("migrate bootstrap");
    }
  });

  it("says so when the password pi read could not be replaced, and keeps the file the server still takes", async () => {
    const { status, lines, credential, left } = await auto({ refuse: "alter role pi_migrator password" });
    expect(status).toBe(1);
    expect(lines.at(-1)).toBe("migration_credential_unrotated");
    expect(credential).toBe(`${OLD}\n`);
    expect(left).toEqual(["migrate.env"]);
  });

  it("says the same when no verifier could be made, and sends the server no password", async () => {
    const { status, lines, sql, credential, left } = await auto({ "lib/pi-verifier": "#!/bin/sh\necho plain\n" });
    expect(status).toBe(1);
    expect(lines.at(-1)).toBe("migration_credential_unrotated");
    expect(sql).not.toContain("alter role");
    expect(credential).toBe(`${OLD}\n`);
    expect(left).toEqual(["migrate.env"]);
  });

  it("takes a migrate.env.next a killed run left when the server refuses the file and takes it, and migrates", async () => {
    const { status, lines, bootstrap, credential, verified, left } = await auto({
      [`${CREDENTIAL}.next`]: `${NEXT}\n`,
      accepts: NEXT,
    });
    expect({ status, lines }).toEqual({ status: 0, lines: ["migrated"] });
    // The migration ran with the password the server takes, which is then replaced as any other.
    expect(bootstrap).toContain(`postgres://pi_migrator:${NEXT}@`);
    expect(credential).toBe(`${verified[0]}\n`);
    expect(left).toEqual(["migrate.env"]);
  });

  it("removes a migrate.env.next when the server takes the file, or takes neither", async () => {
    const taken = await auto({ [`${CREDENTIAL}.next`]: `${NEXT}\n` });
    expect(taken.lines).toEqual(["migrated"]);
    expect(taken.bootstrap).toContain(`postgres://pi_migrator:${OLD}@`);
    expect(taken.left).toEqual(["migrate.env"]);
    for (const next of [`${NEXT}\n`, "postgres\n"]) {
      const neither = await auto({ [`${CREDENTIAL}.next`]: next, accepts: "c".repeat(64) });
      expect({ status: neither.status, lines: neither.lines }).toEqual({
        status: 1,
        lines: ["migration_credential_refused"],
      });
      expect(neither.sql).not.toContain("migrate bootstrap");
      expect(neither.credential).toBe(`${OLD}\n`);
      expect(neither.left).toEqual(["migrate.env"]);
    }
  });
});

// lib/superuser.sh with its root-only directory moved, sourced with the name and password on
// standard input, printing the variables libpq reads.
async function superuser(query: string | undefined): Promise<{ status: number | null; out: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-superuser-"));
  roots.push(root);
  await mkdir(join(root, "run/pi-root"), { recursive: true });
  await writeFile(join(root, "run/pi-root/admin-host"), "db.internal:5432\n");
  if (query !== undefined) await writeFile(join(root, "run/pi-root/admin-query"), `${query}\n`);
  const source = await readFile(join(repoRoot(), "deploy/lib/superuser.sh"), "utf8");
  await writeFile(join(root, "superuser.sh"), source.replaceAll("/run/", `${root}/run/`));
  const script = `set -eu; . ${root}/superuser.sh; printf '%s|%s|%s|%s|%s\\n' "$PGHOST" "\${PGSSLMODE-unset}" "\${PGREQUIREAUTH-unset}" "\${PGSSLROOTCERT-unset}" "$dbquery"`;
  const run = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", input: "postgres\nsecret\n" });
  return { status: run.status, out: run.stdout.trim() };
}

describe("lib/superuser.sh", () => {
  it("leaves libpq's TLS defaults alone when the admin URL has no sslmode, or the box predates the file", async () => {
    for (const query of [undefined, ""]) {
      expect(await superuser(query)).toEqual({ status: 0, out: "db.internal|unset|unset|unset|" });
    }
  });

  it("connects with the admin URL's sslmode and root certificate, by SCRAM alone", async () => {
    expect(await superuser("sslmode=verify-full&sslrootcert=/etc/ssl/pi/ca.pem")).toEqual({
      status: 0,
      out: "db.internal|verify-full|scram-sha-256|/etc/ssl/pi/ca.pem|sslmode=verify-full&sslrootcert=/etc/ssl/pi/ca.pem",
    });
  });

  it("asks nothing and names no user for pi-migrate --auto, which sets `standing` first", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-superuser-"));
    roots.push(root);
    await mkdir(join(root, "run/pi-root"), { recursive: true });
    await writeFile(join(root, "run/pi-root/admin-host"), "db.internal:5432\n");
    const source = await readFile(join(repoRoot(), "deploy/lib/superuser.sh"), "utf8");
    await writeFile(join(root, "superuser.sh"), source.replaceAll("/run/", `${root}/run/`));
    const script = `set -eu; standing=yes; . ${root}/superuser.sh; IFS= read -r next; printf '%s|%s|%s|%s\\n' "$PGHOST" "\${PGUSER-unset}" "\${PGPASSWORD-unset}" "$next"`;
    const run = spawnSync("/bin/sh", ["-c", script], {
      encoding: "utf8",
      input: "untouched\n",
      env: { PATH: "/usr/bin:/bin" },
    });
    expect({ status: run.status, out: run.stdout.trim(), err: run.stderr }).toEqual({
      status: 0,
      out: "db.internal|unset|unset|untouched",
      err: "",
    });
  });

  it("refuses an sslmode or sslrootcert it could not carry on whole", async () => {
    expect((await superuser("sslmode=verify+full")).status).toBe(1);
    expect((await superuser("sslrootcert=/a;b")).status).toBe(1);
  });

  it("refuses an sslmode that lets libpq fall back to an unencrypted connection", async () => {
    for (const mode of ["disable", "allow", "prefer"])
      expect((await superuser(`sslmode=${mode}`)).status, mode).toBe(1);
    for (const mode of ["require", "verify-ca"]) expect((await superuser(`sslmode=${mode}`)).status, mode).toBe(0);
  });
});

// The box's wait for this migration (lib/migrate-start): a start that found a migration pending and
// no credential took both holds as its own, named them in its marker and made the wait's file.
describe("bin/pi-migrate and a box that waits for it", () => {
  const MARKER = "data/pi-root/migrate-holds";
  // The holds before the marker, as migrate-start writes them: none is newer than it.
  const WAITING = {
    "data/read-hold": "",
    "data/sync-hold": "",
    [MARKER]: "read-hold\nsync-hold\n",
    "data/migrate-wait": "",
  };
  // The health calls, which the stub of as-pi notes among the statements.
  const closed = (sql: string): string[] =>
    [...sql.matchAll(/^migrate admin health hold (.*)$/gm)].map((one) => one[1] as string);

  it("once it has succeeded, lifts the holds the box took, removes the wait, closes their cards and says so", async () => {
    for (const args of [[], ["--enable-auto"]]) {
      const { status, lines, sql, box, left } = await migrate(WAITING, "", args);
      expect(status).toBe(0);
      expect(lines.slice(-3)).toEqual([
        "proxy password: skipped",
        "migration wait: ended",
        "bootstrap can log in: false",
      ]);
      expect(box).toEqual([]);
      expect(left).not.toContain("migrate-holds");
      expect(closed(sql)).toEqual(["read_hold --off", "sync_hold --off", "migrate_wait --off"]);
      // After the migration and the role check.
      expect(sql.indexOf("migrate admin health hold")).toBeGreaterThan(sql.indexOf("pi.role_prefix"));
    }
    // With the send role's password set, the run's other successful end.
    const proxy = `postgres://pi_proxy:${"a".repeat(64)}@h:5432/pi`;
    const set = await migrate({ ...WAITING, "run/pisend/send.env": `PI_DATABASE_URL_PROXY=${proxy}\n` });
    expect(set.lines.slice(-3)).toEqual([
      "proxy password: set",
      "migration wait: ended",
      "bootstrap can log in: false",
    ]);
    expect(set.box).toEqual([]);
  });

  it("leaves on a hold the owner set before the deploy, or set again while the box waited", async () => {
    // Both the owner's: the marker names neither.
    const owners = await migrate({ ...WAITING, [MARKER]: "" });
    expect(owners.status).toBe(0);
    expect(owners.box).toEqual(["read-hold", "sync-hold"]);
    expect(owners.left).not.toContain("migrate-holds");
    expect(closed(owners.sql)).toEqual(["migrate_wait --off"]);
    expect(owners.lines).toContain("migration wait: ended");
    // `pi-read-hold on` after the start: the read hold is newer than the marker, and the owner's.
    const since = await migrate(WAITING, "", [], ["data/read-hold"]);
    expect(since.box).toEqual(["read-hold"]);
    expect(closed(since.sql)).toEqual(["sync_hold --off", "migrate_wait --off"]);
  });

  it("when it fails, leaves the box waiting and held, whatever failed", async () => {
    const notify = `postgres://pi_notify:${"a".repeat(64)}@h:5432/pi?host=elsewhere`;
    for (const files of [
      { "migrate.status": "1\n" },
      { found: "1\n" },
      { sessions: "1\n" },
      { "run/pinotify/notify.env": `PI_DATABASE_URL_NOTIFY=${notify}\n` },
      { "run/pisend/send.env": "PI_DATABASE_URL_PROXY=postgres://someone:x@h:5432/pi\n" },
    ]) {
      const { status, lines, sql, box, left } = await migrate({ ...WAITING, ...files });
      expect(status, JSON.stringify(files)).toBe(1);
      expect(box).toEqual(["read-hold", "sync-hold", "migrate-wait"]);
      expect(left).toContain("migrate-holds");
      expect(closed(sql)).toEqual([]);
      expect(lines).not.toContain("migration wait: ended");
    }
  });

  it("with nothing waiting, touches no hold, closes no card and says nothing more", async () => {
    const { status, lines, sql, box } = await migrate({ "data/read-hold": "", "data/sync-hold": "" });
    expect(status).toBe(0);
    expect(box).toEqual(["read-hold", "sync-hold"]);
    expect(closed(sql)).toEqual([]);
    expect(lines).not.toContain("migration wait: ended");
  });

  it("ends what a failed unattended start left, which has a marker and no wait file", async () => {
    const { "data/migrate-wait": _, ...failed } = WAITING;
    const { status, lines, sql, box, left } = await migrate(failed);
    expect(status).toBe(0);
    expect(box).toEqual([]);
    expect(left).not.toContain("migrate-holds");
    expect(closed(sql)).toEqual(["read_hold --off", "sync_hold --off", "migrate_wait --off"]);
    expect(lines).toContain("migration wait: ended");
  });

  it("the box's own run leaves the wait to the start that called it", async () => {
    const { status, lines, sql, box, left } = await migrate({ ...WAITING, [CREDENTIAL]: `${OLD}\n` }, "", ["--auto"]);
    expect({ status, last: lines.at(-1) }).toEqual({ status: 0, last: "migrated" });
    expect(box).toEqual(["read-hold", "sync-hold", "migrate-wait"]);
    expect(left).toContain("migrate-holds");
    expect(closed(sql)).toEqual([]);
  });
});
