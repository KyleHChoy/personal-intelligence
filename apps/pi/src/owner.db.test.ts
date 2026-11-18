import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersonalLogger } from "@intelligence/contracts/personal";
import { sha256 } from "@intelligence/personal-core";
import { fakeSources, world } from "@intelligence/personal-core/testing";
import { GOOGLE_SCOPES, scopesFor } from "@intelligence/personal-google";
import { createAdmin, createReader, createWriter, googleSecretName, loadKeys } from "@intelligence/personal-store";
import {
  copiesOf,
  createTestDatabase,
  fingerprint,
  queryAs,
  scanForPlaintext,
  type TestDatabase,
} from "@intelligence/personal-store/testing";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { RunDeps } from "./command-types.ts";
import { runSync } from "./intake/sync.ts";
import { RESTRICTED_OFF_HINT } from "./restricted-warning.ts";
import { pi, refusedWithHint as refused } from "./test-support/run-pi.ts";

// What `clients add` writes on stderr while no restricted category is on (restricted-warning.ts).
const WARNED = `${JSON.stringify({ event: "client_restricted_off", code: "no_restricted_category" })}\n${RESTRICTED_OFF_HINT}\n`;

// The owner commands, through `run`. Key files are written by `pi keys init` into a folder of the
// test's own; databases come from createTestDatabase.

type Env = Record<string, string>;

// The machine is shared: a test that makes a database and syncs the world may take a while.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const quiet: PersonalLogger = { info() {}, warn() {}, error() {} };

const DONE = { exit: 0, stdout: "", stderr: "" };

const folders: string[] = [];
const databases: TestDatabase[] = [];

// A key file's path in a new folder. Nothing is written.
async function keyPath(): Promise<Env> {
  const folder = await mkdtemp(join(tmpdir(), "pi-owner-test-"));
  folders.push(folder);
  return { PI_KEY_FILE: join(folder, "keys.json") };
}

afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
  for (const database of databases.splice(0)) await database.drop();
});

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;
const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("pi keys", () => {
  it("keys init refuses to overwrite", async () => {
    const env = await keyPath();
    expect(await pi(["keys", "init"], env)).toEqual(DONE);
    expect(await modeOf(env.PI_KEY_FILE ?? "")).toBe(0o600);
    expect([...(await loadKeys(env.PI_KEY_FILE ?? "")).compartments.keys()]).toEqual(["own"]);

    const written = await readFile(env.PI_KEY_FILE ?? "");
    expect(await pi(["keys", "init"], env)).toEqual(refused("key_file_exists"));
    expect(await pi(["keys", "init", "--compartments", "own,employer:example"], env)).toEqual(
      refused("key_file_exists"),
    );
    expect(await readFile(env.PI_KEY_FILE ?? "")).toEqual(written);

    // Each compartment named gets a key. A list with an empty entry is a usage error.
    const other = await keyPath();
    // So is one that names something that is no compartment.
    for (const list of ["own,", "own, employer:example", "Own", "own,agent:x", "employer:acme-released-released"]) {
      expect(await pi(["keys", "init", "--compartments", list], other), list).toEqual(refused("usage", undefined, 2));
    }
    expect(await exists(other.PI_KEY_FILE ?? "")).toBe(false);
    expect(await pi(["keys", "init", "--compartments", "own,employer:example"], other)).toEqual(DONE);
    expect([...(await loadKeys(other.PI_KEY_FILE ?? "")).compartments.keys()]).toEqual(["own", "employer:example"]);
  });

  it("a key file readable by others is refused", async () => {
    const env = await keyPath();
    const path = env.PI_KEY_FILE ?? "";
    expect(await pi(["keys", "init"], env)).toEqual(DONE);
    const written = await readFile(path);

    // The general file's group may read it: 0640 is not refused.
    for (const mode of [0o660, 0o604, 0o644]) {
      await chmod(path, mode);
      expect(await pi(["keys", "add-compartment", "employer:example"], env), mode.toString(8)).toEqual(
        refused("key_file_refused"),
      );
      expect(await readFile(path)).toEqual(written);
    }
    // A key file that is missing is refused with the same code, and no lock is left behind.
    const missing = await keyPath();
    expect(await pi(["keys", "add-compartment", "employer:example"], missing)).toEqual(refused("key_file_refused"));
    expect(await exists(`${missing.PI_KEY_FILE}.lock`)).toBe(false);

    // The positive control: readable by its owner and its group alone, the same command adds the
    // key, and the file keeps its mode.
    await chmod(path, 0o640);
    expect(await pi(["keys", "add-compartment", "employer:example"], env)).toEqual(DONE);
    expect([...(await loadKeys(path)).compartments.keys()]).toEqual(["own", "employer:example"]);
    expect(await modeOf(path)).toBe(0o640);
  });

  it("keys add-compartment keeps every existing key", async () => {
    const env = await keyPath();
    const path = env.PI_KEY_FILE ?? "";
    expect(await pi(["keys", "init", "--compartments", "own,employer:example"], env)).toEqual(DONE);
    const before = await loadKeys(path);

    expect(await pi(["keys", "add-compartment", "employer:other"], env)).toEqual(DONE);
    const after = await loadKeys(path);
    expect([...after.compartments.keys()]).toEqual(["own", "employer:example", "employer:other"]);
    expect(after.compartments.get("own")).toBe(before.compartments.get("own"));
    expect(after.compartments.get("employer:example")).toBe(before.compartments.get("employer:example"));
    expect(after.fingerprintKey.equals(before.fingerprintKey)).toBe(true);
    expect(await modeOf(path)).toBe(0o600);

    // One already there is refused, and so is a name that is no compartment, as a usage error.
    // The file stays as it was.
    const written = await readFile(path);
    expect(await pi(["keys", "add-compartment", "employer:other"], env)).toEqual(refused("key_file_exists"));
    for (const name of ["agent:x", "Employer:other", "work"])
      expect(await pi(["keys", "add-compartment", name], env), name).toEqual(refused("usage", undefined, 2));
    expect(await readFile(path)).toEqual(written);
    expect(await exists(`${path}.lock`)).toBe(false);
  });

  it("keys add-compartment refuses a locked key file, and its hint names the lock", async () => {
    const env = await keyPath();
    const path = env.PI_KEY_FILE ?? "";
    expect(await pi(["keys", "init"], env)).toEqual(DONE);
    const written = await readFile(path);

    await writeFile(`${path}.lock`, "");
    expect(await pi(["keys", "add-compartment", "employer:example"], env)).toEqual(
      refused("key_file_refused", `remove ${path}.lock if no add is running`),
    );
    expect(await readFile(path)).toEqual(written);

    // The positive control: with the lock removed, the same command adds the key.
    await rm(`${path}.lock`);
    expect(await pi(["keys", "add-compartment", "employer:example"], env)).toEqual(DONE);
  });
});

describe("pi db migrate", () => {
  // A database with its privileges set and no migration applied.
  async function database(): Promise<{ db: TestDatabase; env: Env }> {
    const db = await createTestDatabase({ migrations: false });
    databases.push(db);
    return {
      db,
      env: {
        PI_DATABASE_URL_BOOTSTRAP: db.urls.bootstrap,
        PI_DATABASE_URL_ADMIN: db.urls.admin,
        PI_DATABASE_URL_WRITER: db.urls.writer,
        PI_DATABASE_URL_READER: db.urls.reader,
        PI_DATABASE_URL_PIPELINE: db.urls.pipeline,
        PI_DATABASE_URL_WORK: db.urls.work,
        PI_DATABASE_URL_RESTRICTED: db.urls.restricted,
      },
    };
  }
  const schemas = (db: TestDatabase) =>
    queryAs(
      db.urls.bootstrap,
      "select nspname as name from pg_namespace where nspname in ('policy', 'vault', 'knowledge') order by 1",
    );
  const migrations = (db: TestDatabase) =>
    queryAs(db.urls.admin, "select name, checksum, applied_at from policy.migrations order by name");

  it("db migrate makes the roles and applies the migrations, and a second run changes nothing", async () => {
    const { db, env } = await database();
    expect(await schemas(db)).toEqual([]);

    expect(await pi(["db", "migrate"], env)).toEqual(DONE);
    expect(await schemas(db)).toEqual([{ name: "knowledge" }, { name: "policy" }, { name: "vault" }]);
    const applied = await migrations(db);
    expect(applied.length).toBeGreaterThan(0);
    // Each role still logs in with the password in its URL.
    for (const url of [
      db.urls.admin,
      db.urls.writer,
      db.urls.reader,
      db.urls.pipeline,
      db.urls.work,
      db.urls.restricted,
    ])
      expect(await queryAs(url, "select 1 as one")).toEqual([{ one: 1 }]);

    expect(await pi(["db", "migrate"], env)).toEqual(DONE);
    expect(await migrations(db)).toEqual(applied);
  });

  // The restricted role's password is the owner's to set, so a migration never waits on it
  // (the restricted categories ship off). Roles belong to the server and the test database
  // helper has already given pi_restricted a password, so this shows what `db migrate` itself
  // does: it migrates with no URL and leaves that password alone. That a role with none cannot
  // log in is roles.db.test.ts's, on a role of its own.
  it("db migrate without the restricted URL migrates and leaves pi_restricted's password as it was", async () => {
    const { db, env } = await database();
    const { PI_DATABASE_URL_RESTRICTED: _unset, ...without } = env;
    expect(await pi(["db", "migrate"], without)).toEqual(DONE);
    expect((await schemas(db)).length).toBe(3);
    expect(await queryAs(db.urls.restricted, "select current_user as role")).toEqual([{ role: "pi_restricted" }]);
    expect(await queryAs(db.urls.work, "select current_user as role")).toEqual([{ role: "pi_work" }]);

    // The positive control: with the URL, the same command migrates and the role still logs in.
    expect(await pi(["db", "migrate"], env)).toEqual(DONE);
    expect(await queryAs(db.urls.restricted, "select current_user as role")).toEqual([{ role: "pi_restricted" }]);
  });

  it("db migrate refuses a role URL it cannot parse, with nothing of the URL", async () => {
    const { db, env } = await database();
    const bad = [
      "postgres://pi_writer:sentinel-7f3a91@[::1/pi",
      "sentinel-7f3a91",
      "https://pi_writer:sentinel-7f3a91@db.example.com/pi",
      "postgres://pi_writer@127.0.0.1:1/pi",
    ];
    for (const name of [
      "PI_DATABASE_URL_ADMIN",
      "PI_DATABASE_URL_WRITER",
      "PI_DATABASE_URL_READER",
      "PI_DATABASE_URL_PIPELINE",
      "PI_DATABASE_URL_WORK",
      "PI_DATABASE_URL_RESTRICTED",
    ]) {
      for (const url of bad)
        expect(await pi(["db", "migrate"], { ...env, [name]: url }), `${name} ${bad.indexOf(url)}`).toEqual(
          refused("bad_url"),
        );
    }
    // The bootstrap URL is the store's to parse, and it refuses one the same way.
    expect(
      await pi(["db", "migrate"], { ...env, PI_DATABASE_URL_BOOTSTRAP: "postgres://migrator:sentinel-7f3a91@[::1/pi" }),
    ).toEqual(refused("bad_url"));
    // Nothing ran.
    expect(await schemas(db)).toEqual([]);

    // The positive control: with URLs that parse, the same command migrates.
    expect(await pi(["db", "migrate"], env)).toEqual(DONE);
    expect((await schemas(db)).length).toBe(3);
  });

  it("db migrate refuses a work URL that names no password", async () => {
    const { db, env } = await database();
    expect(
      await pi(["db", "migrate"], { ...env, PI_DATABASE_URL_WORK: db.urls.work.replace(":local-only@", "@") }),
    ).toEqual(refused("bad_url"));
    expect(await schemas(db)).toEqual([]);
    // The positive control: with the password in it, the same command migrates, and pi_work logs in with it.
    expect(await pi(["db", "migrate"], env)).toEqual(DONE);
    expect(await queryAs(db.urls.work, "select current_user as role")).toEqual([{ role: "pi_work" }]);
  });
});

// A migrated database whose key file `pi keys init` wrote, and the owner commands' environment.
async function ownerDatabase(
  compartments = "own,employer:example",
): Promise<{ db: TestDatabase; env: Env; keyFile: string }> {
  const { PI_KEY_FILE: keyFile = "" } = await keyPath();
  expect(await pi(["keys", "init", "--compartments", compartments], { PI_KEY_FILE: keyFile })).toEqual(DONE);
  const db = await createTestDatabase({ keyFile });
  databases.push(db);
  return { db, keyFile, env: { PI_DATABASE_URL_ADMIN: db.urls.admin, PI_KEY_FILE: keyFile } };
}

const ALL_TOOLS = "get_self,search,get_entity,get_timeline";

describe("pi clients", () => {
  it("clients add prints the token once and list never shows it or its hash", async () => {
    const { db, env } = await ownerDatabase();
    const added = await pi(["clients", "add", "mine", "--broad", "--views", "self,people", "--tools", ALL_TOOLS], env);
    expect(added).toEqual({ exit: 0, stdout: expect.stringMatching(/^pit_[A-Za-z0-9_-]{43}\n$/), stderr: WARNED });
    const token = added.stdout.trim();
    // Only its hash is stored.
    expect(await queryAs(db.urls.admin, "select name, token_hash from policy.clients")).toEqual([
      { name: "mine", token_hash: sha256(token) },
    ]);

    const listed = await pi(["clients", "list"], env);
    expect(listed).toMatchObject({ exit: 0, stderr: "" });
    expect(listed.stdout.endsWith("\n")).toBe(true);
    expect(JSON.parse(listed.stdout)).toMatchObject([
      { name: "mine", status: "active", views: ["self", "people"], tools: ALL_TOOLS.split(","), revokedAt: null },
    ]);
    for (const secret of [token, sha256(token), "pit_", "token"]) expect(listed.stdout).not.toContain(secret);

    // A name that exists, and a registration that fails ClientRegistration, are refused.
    expect(await pi(["clients", "add", "mine", "--broad", "--views", "self", "--tools", "get_self"], env)).toEqual(
      refused("duplicate_name"),
    );
    const invalid = [
      ["clients", "add", "second", "--broad", "--views", "self", "--tools", "get_self,delete_everything"],
      ["clients", "add", "second", "--broad", "--views", "everything", "--tools", "get_self"],
      ["clients", "add", "second", "--views", "self", "--tools", "get_self", "--compartments", "restricted:health"],
      [
        "clients",
        "add",
        "second",
        "--views",
        "self",
        "--tools",
        "get_self,record",
        "--compartments",
        "own,restricted:health",
      ],
      ["clients", "add", "second", "--views", "self", "--tools", "get_self", "--compartments", "somewhere"],
      ["clients", "add", "Second", "--broad", "--views", "self", "--tools", "get_self"],
    ];
    for (const argv of invalid) expect(await pi(argv, env), argv.join(" ")).toEqual(refused("invalid_registration"));
    // An agent's views and tools default; a reasoner's are still required.
    expect(await pi(["clients", "add", "second", "--kind", "reasoner", "--tools", "get_self"], env)).toEqual(
      refused("usage", undefined, 2),
    );
    expect(await pi(["clients", "add", "second", "--kind", "reasoner", "--views", "self"], env)).toEqual(
      refused("usage", undefined, 2),
    );
    expect(await queryAs(db.urls.admin, "select name from policy.clients")).toEqual([{ name: "mine" }]);

    // A revoked client keeps its name, so a replacement needs a new one.
    expect(await pi(["clients", "revoke", "nobody"], env)).toEqual(refused("not_found"));
    expect(await pi(["clients", "revoke", "mine"], env)).toEqual(DONE);
    const after = JSON.parse((await pi(["clients", "list"], env)).stdout) as {
      name: string;
      status: string;
      revokedAt: string | null;
    }[];
    expect(after).toMatchObject([{ name: "mine", status: "revoked" }]);
    expect(after[0]?.revokedAt).not.toBeNull();
    expect(await pi(["clients", "add", "mine", "--broad", "--views", "self", "--tools", "get_self"], env)).toEqual(
      refused("duplicate_name"),
    );
  });

  it("clients add registers a restricted-cleared reader", async () => {
    const { db, env } = await ownerDatabase();
    const added = await pi(
      [
        "clients",
        "add",
        "cleared",
        "--views",
        "self,people",
        "--tools",
        "get_self,search",
        "--compartments",
        "own,restricted:health",
      ],
      env,
    );
    expect(added).toEqual({ exit: 0, stdout: expect.stringMatching(/^pit_[A-Za-z0-9_-]{43}\n$/), stderr: WARNED });
    expect(await queryAs(db.urls.admin, "select name, compartments, kind from policy.clients")).toEqual([
      { name: "cleared", compartments: ["own", "restricted:health"], kind: "agent" },
    ]);
    for (const argv of [
      [
        "clients",
        "add",
        "reasoner",
        "--kind",
        "reasoner",
        "--views",
        "self",
        "--tools",
        "get_self,next_run",
        "--compartments",
        "own,restricted:health",
      ],
      [
        "clients",
        "add",
        "drafter",
        "--views",
        "self",
        "--tools",
        "get_self,draft_message",
        "--compartments",
        "own,restricted:health",
      ],
    ]) {
      expect(await pi(argv, env), argv.join(" ")).toEqual(refused("invalid_registration"));
    }
    expect(await queryAs(db.urls.admin, "select name from policy.clients")).toEqual([{ name: "cleared" }]);
  });

  it("--runtime defaults to local, --broad clears for own; --retention defaults to unknown and is recorded only", async () => {
    const { db, env } = await ownerDatabase();
    const add = async (name: string, ...more: string[]): Promise<string> => {
      const added = await pi(
        [
          "clients",
          "add",
          name,
          // --broad and --compartments together are a usage error.
          ...(more.includes("--compartments") ? [] : ["--broad"]),
          "--views",
          "self,people",
          "--tools",
          ALL_TOOLS,
          ...more,
        ],
        env,
      );
      expect(added).toMatchObject({ exit: 0, stderr: WARNED });
      return added.stdout.trim();
    };
    const plain = await add("plain");
    const kept = await add("kept", "--retention", "retains");
    await add("cloudy", "--runtime", "cloud", "--compartments", "own,employer:example", "--retention", "none");
    expect(
      await pi(
        ["clients", "add", "odd", "--broad", "--views", "self", "--tools", "get_self", "--runtime", "orbit"],
        env,
      ),
    ).toEqual(refused("invalid_registration"));
    expect(
      await pi(
        ["clients", "add", "odd", "--broad", "--views", "self", "--tools", "get_self", "--retention", "forever"],
        env,
      ),
    ).toEqual(refused("invalid_registration"));

    const listed = JSON.parse((await pi(["clients", "list"], env)).stdout) as { name: string }[];
    expect(listed).toMatchObject([
      { name: "cloudy", runtime: "cloud", compartments: ["own", "employer:example"], vendorRetention: "none" },
      { name: "kept", runtime: "local", compartments: ["own"], vendorRetention: "retains" },
      { name: "plain", runtime: "local", compartments: ["own"], vendorRetention: "unknown" },
    ]);

    // Recorded only: what a client may see is the same whatever its vendor retains.
    const reader = createReader({ url: db.urls.reader, keys: db.keys, log: quiet });
    try {
      const [first, second] = [await reader.client(plain), await reader.client(kept)];
      expect(first).toMatchObject({ name: "plain", compartments: ["own"] });
      expect({ ...second, id: first?.id, name: first?.name }).toEqual(first);
    } finally {
      await reader.close();
    }
  });
});

describe("pi google", () => {
  const CLIENT = {
    PI_GOOGLE_CLIENT_ID: "sentinel-client-id.apps.example.com",
    PI_GOOGLE_CLIENT_SECRET: "sentinel-client-secret-9c2e",
  };
  const REFRESH = "sentinel-refresh-token-7f3a91";
  const granted = (scope: string) => ({
    access_token: "sentinel-access-token",
    expires_in: 3600,
    token_type: "Bearer",
    scope,
    refresh_token: REFRESH,
  });

  // Runs `google connect` to its end: reads the URL it prints, and sends the one request the
  // owner's browser would send to the loopback listener. The token endpoint is a fake fetch.
  async function connect(argv: string[], env: Env, answer: unknown) {
    const calls: { url: string; body: URLSearchParams }[] = [];
    const fake: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), body: new URLSearchParams(String(init?.body ?? "")) });
      return new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    let printed = "";
    let tell: (line: string) => void = () => {};
    const line = new Promise<string>((resolve) => {
      tell = resolve;
    });
    const running = pi(argv, env, {
      deps: {
        google: { fetch: fake, sleep: async () => {}, now: () => Date.now(), random: () => 0.5, timeoutMs: 5000 },
        listenTimeoutMs: 10_000,
      },
      onStdout(text) {
        printed += text;
        if (printed.includes("\n")) tell(printed.slice(0, printed.indexOf("\n")));
      },
    });
    // A command that ends before it prints a URL fails the test at once.
    const ended = running.then((result) => Promise.reject(new Error(`no URL was printed: ${result.stderr}`)));
    const url = new URL(await Promise.race([line, ended]));
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const page = await fetch(
      `${redirectUri}?state=${encodeURIComponent(url.searchParams.get("state") ?? "")}&code=sentinel-code-4d1b`,
    );
    return { result: await running, url, redirectUri, calls, page: { status: page.status, text: await page.text() } };
  }

  const secrets = async (db: TestDatabase, label: string) => {
    const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log: quiet });
    try {
      return {
        client: await admin.secrets.secret(googleSecretName(label, "client")),
        refreshToken: await admin.secrets.secret(googleSecretName(label, "refresh_token")),
      };
    } finally {
      await admin.close();
    }
  };

  it("google connect stores the client and the refresh token sealed under googleSecretName, and prints only the URL", async () => {
    const { db, env } = await ownerDatabase();
    const { result, url, redirectUri, calls, page } = await connect(
      ["google", "connect", "--account", "personal"],
      { ...env, ...CLIENT },
      granted(GOOGLE_SCOPES.join(" ")),
    );

    // The URL, a newline, and nothing else on either stream.
    expect(result).toEqual({ exit: 0, stdout: `${url.toString()}\n`, stderr: "" });
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(CLIENT.PI_GOOGLE_CLIENT_ID);
    expect(url.searchParams.get("scope")).toBe(GOOGLE_SCOPES.join(" "));
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(page.status).toBe(200);
    for (const secret of [REFRESH, CLIENT.PI_GOOGLE_CLIENT_SECRET, "sentinel-code-4d1b", "sentinel-access-token"])
      expect(result.stdout + result.stderr + page.text).not.toContain(secret);

    // One exchange, for the code the listener was given, with the verifier of the URL's challenge.
    expect(calls.map((call) => call.url)).toEqual(["https://oauth2.googleapis.com/token"]);
    const sent = calls[0]?.body;
    expect(sent?.get("code")).toBe("sentinel-code-4d1b");
    expect(sent?.get("client_id")).toBe(CLIENT.PI_GOOGLE_CLIENT_ID);
    expect(sent?.get("client_secret")).toBe(CLIENT.PI_GOOGLE_CLIENT_SECRET);
    expect(sent?.get("redirect_uri")).toBe(redirectUri);
    expect(
      createHash("sha256")
        .update(sent?.get("code_verifier") ?? "")
        .digest("base64url"),
    ).toBe(url.searchParams.get("code_challenge"));

    // Both secrets, read back through the store, and in no column in plaintext.
    const stored = await secrets(db, "personal");
    expect(JSON.parse(stored.client ?? "null")).toEqual({
      clientId: CLIENT.PI_GOOGLE_CLIENT_ID,
      clientSecret: CLIENT.PI_GOOGLE_CLIENT_SECRET,
      compartment: "own",
    });
    expect(stored.refreshToken).toBe(REFRESH);
    expect(await queryAs(db.urls.admin, "select name from policy.secrets order by name")).toEqual([
      { name: "google/personal/client" },
      { name: "google/personal/refresh_token" },
    ]);
    expect(await scanForPlaintext(db.urls.admin, [REFRESH, CLIENT.PI_GOOGLE_CLIENT_SECRET])).toEqual([]);

    // An employer's account is connected under its own compartment.
    const work = await connect(
      ["google", "connect", "--account", "work", "--compartment", "employer:example"],
      { ...env, ...CLIENT },
      granted(GOOGLE_SCOPES.join(" ")),
    );
    expect(work.result.exit).toBe(0);
    expect(JSON.parse((await secrets(db, "work")).client ?? "null")).toMatchObject({ compartment: "employer:example" });

    // google list shows each label, its compartment and whether it holds a Drive token (GD,
    // "pi") before any sync, and no secret.
    const listed = await pi(["google", "list"], env);
    expect(listed).toMatchObject({ exit: 0, stderr: "" });
    expect(JSON.parse(listed.stdout)).toEqual([
      {
        label: "personal",
        compartment: "own",
        accounts: [],
        refreshTokenUpdatedAt: expect.stringMatching(/^\d{4}-/),
        contacts: false,
        contactsTokenUpdatedAt: null,
        drive: false,
      },
      {
        label: "work",
        compartment: "employer:example",
        accounts: [],
        refreshTokenUpdatedAt: expect.stringMatching(/^\d{4}-/),
        contacts: false,
        contactsTokenUpdatedAt: null,
        drive: false,
      },
    ]);
    for (const secret of [REFRESH, CLIENT.PI_GOOGLE_CLIENT_SECRET, CLIENT.PI_GOOGLE_CLIENT_ID])
      expect(listed.stdout).not.toContain(secret);
  });

  it("a scope mismatch is reported as scope_mismatch with its hint", async () => {
    const { db, env } = await ownerDatabase();
    const hint = "the consent did not grant exactly the two read-only scopes; connect again and leave both ticked";
    // A broader grant, and a narrower one.
    for (const scope of [
      `${GOOGLE_SCOPES.join(" ")} https://www.googleapis.com/auth/gmail.modify`,
      GOOGLE_SCOPES[0] ?? "",
    ]) {
      const { result, url } = await connect(
        ["google", "connect", "--account", "personal"],
        { ...env, ...CLIENT },
        granted(scope),
      );
      // The URL stays on stdout when the command later fails.
      expect(result).toEqual({
        exit: 1,
        stdout: `${url.toString()}\n`,
        stderr: `${JSON.stringify({ event: "command_failed", code: "scope_mismatch" })}\n${hint}\n`,
      });
    }
    expect(await secrets(db, "personal")).toEqual({ client: null, refreshToken: null });

    // The positive control: exactly the two scopes, and the same command stores both secrets.
    expect(
      (
        await connect(
          ["google", "connect", "--account", "personal"],
          { ...env, ...CLIENT },
          granted(GOOGLE_SCOPES.join(" ")),
        )
      ).result.exit,
    ).toBe(0);
    expect((await secrets(db, "personal")).refreshToken).toBe(REFRESH);
  });

  // A listener that nobody answers gives up at once, so a command that got as far as printing
  // its URL ends with oauth_failed.
  const unanswered: RunDeps = {
    google: { fetch: async () => Promise.reject(new Error("no call is expected")) },
    listenTimeoutMs: 20,
  };
  const reachedTheUrl = {
    exit: 1,
    stdout: expect.stringMatching(/^https:\/\/accounts\.google\.com\/.*\n$/),
    stderr: `${JSON.stringify({ event: "command_failed", code: "oauth_failed" })}\nrun pi google connect again (pia on the box)\n`,
  };

  it("google connect refuses a compartment the key file lacks", async () => {
    const { env } = await ownerDatabase("own");
    expect(
      await pi(
        ["google", "connect", "--account", "work", "--compartment", "employer:example"],
        { ...env, ...CLIENT },
        { deps: unanswered },
      ),
    ).toEqual(refused("unknown_compartment"));
    // The positive control: a compartment the key file has gets as far as the URL.
    expect(
      await pi(
        ["google", "connect", "--account", "work", "--compartment", "own"],
        { ...env, ...CLIENT },
        { deps: unanswered },
      ),
    ).toEqual(reachedTheUrl);
  });

  it("google connect refuses a compartment that is not own or employer:<slug>", async () => {
    // The key file has a key for each, so only the rule refuses them.
    const { env } = await ownerDatabase("own,employer:acme,employer:acme-released,public,agent:helper");
    for (const compartment of ["employer:acme-released", "public", "agent:helper"]) {
      expect(
        await pi(
          ["google", "connect", "--account", "work", "--compartment", compartment],
          { ...env, ...CLIENT },
          { deps: unanswered },
        ),
        compartment,
      ).toEqual(refused("usage", undefined, 2));
    }
    // An invalid label, and a port that is no port, are usage errors too.
    expect(await pi(["google", "connect", "--account", "Work"], { ...env, ...CLIENT }, { deps: unanswered })).toEqual(
      refused("usage", undefined, 2),
    );
    expect(await pi(["google", "connect"], { ...env, ...CLIENT }, { deps: unanswered })).toEqual(
      refused("usage", undefined, 2),
    );
    expect(
      await pi(
        ["google", "connect", "--account", "work", "--port", "70000"],
        { ...env, ...CLIENT },
        { deps: unanswered },
      ),
    ).toEqual(refused("usage", undefined, 2));
    // The positive control: an employer's compartment gets as far as the URL.
    expect(
      await pi(
        ["google", "connect", "--account", "work", "--compartment", "employer:acme"],
        { ...env, ...CLIENT },
        { deps: unanswered },
      ),
    ).toEqual(reachedTheUrl);
  });

  it("google connect refuses a compartment other than the one the label's source accounts have", async () => {
    const { db, env } = await ownerDatabase();
    const writer = createWriter({ url: db.urls.writer, keys: db.keys, log: quiet });
    try {
      await writer.ensureSourceAccount("work", "google_mail", "employer:example", "owner@employer.test");
    } finally {
      await writer.close();
    }
    expect(await pi(["google", "connect", "--account", "work"], { ...env, ...CLIENT }, { deps: unanswered })).toEqual(
      refused(
        "compartment_mismatch",
        "the compartments differ: the label's accounts and --compartment, the person and the item, the thread or the meeting and the project",
      ),
    );
    // The positive control: the compartment the accounts have gets as far as the URL.
    expect(
      await pi(
        ["google", "connect", "--account", "work", "--compartment", "employer:example"],
        { ...env, ...CLIENT },
        { deps: unanswered },
      ),
    ).toEqual(reachedTheUrl);
  });

  it("google disconnect deletes both secrets", async () => {
    const { db, env } = await ownerDatabase();
    for (const label of ["personal", "work"]) {
      expect(
        (
          await connect(
            ["google", "connect", "--account", label],
            { ...env, ...CLIENT },
            granted(GOOGLE_SCOPES.join(" ")),
          )
        ).result.exit,
      ).toBe(0);
    }
    expect(await pi(["google", "disconnect", "Personal"], env)).toEqual(refused("usage", undefined, 2));
    // A label that is not connected is refused: a mistyped one must not look like success.
    expect(await pi(["google", "disconnect", "personel"], env)).toEqual(refused("not_found"));
    expect(await queryAs(db.urls.admin, "select count(*)::int as n from policy.secrets")).toEqual([{ n: 4 }]);
    expect(await pi(["google", "disconnect", "personal"], env)).toEqual(DONE);
    expect(await pi(["google", "disconnect", "personal"], env)).toEqual(refused("not_found"));

    // The other label's secrets stay.
    expect(await secrets(db, "personal")).toEqual({ client: null, refreshToken: null });
    expect(await queryAs(db.urls.admin, "select name from policy.secrets order by name")).toEqual([
      { name: "google/work/client" },
      { name: "google/work/refresh_token" },
    ]);
    expect(
      (JSON.parse((await pi(["google", "list"], env)).stdout) as { label: string }[]).map((one) => one.label),
    ).toEqual(["work"]);

    // A label is connected while either secret is stored. With its client gone and only the
    // refresh token left, disconnect still removes it; with neither, it is not found.
    const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log: quiet });
    try {
      await admin.secrets.deleteSecret(googleSecretName("work", "client"));
    } finally {
      await admin.close();
    }
    expect(await queryAs(db.urls.admin, "select name from policy.secrets order by name")).toEqual([
      { name: "google/work/refresh_token" },
    ]);
    expect(await pi(["google", "disconnect", "work"], env)).toEqual(DONE);
    expect(await queryAs(db.urls.admin, "select name from policy.secrets")).toEqual([]);
    expect(await pi(["google", "disconnect", "work"], env)).toEqual(refused("not_found"));
  });

  // A label's contacts are a grant of their own, with the label's stored read client and its stored
  // address.
  describe("contacts", () => {
    const ADDRESS = "owner@personal.test";
    const CONTACTS_REFRESH = "sentinel-contacts-refresh-token-5b8e";
    const CONTACTS_GRANTED =
      "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/contacts.readonly";
    const idToken = (payload: unknown): string =>
      ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "fake-signature"].join(".");
    const contactsAnswer = (scope: string, email = ADDRESS, verified = true) => ({
      access_token: "sentinel-access-token",
      expires_in: 3600,
      token_type: "Bearer",
      scope,
      refresh_token: CONTACTS_REFRESH,
      id_token: idToken({ email, email_verified: verified, sub: "fake-subject" }),
    });

    // A label connected for mail, whose mail account holds its address as the first sync stores it.
    async function connected(label = "personal") {
      const { db, env } = await ownerDatabase();
      expect(
        (
          await connect(
            ["google", "connect", "--account", label],
            { ...env, ...CLIENT },
            granted(GOOGLE_SCOPES.join(" ")),
          )
        ).result.exit,
      ).toBe(0);
      const writer = createWriter({ url: db.urls.writer, keys: db.keys, log: quiet });
      try {
        await writer.ensureSourceAccount(label, "google_mail", "own", ADDRESS);
      } finally {
        await writer.close();
      }
      return { db, env };
    }

    const stored = async (db: TestDatabase) =>
      queryAs<{ name: string; value_enc: Buffer; updated_at: Date }>(
        db.urls.admin,
        'select name, value_enc, updated_at from policy.secrets order by name collate "C"',
      );
    const contactsToken = async (db: TestDatabase, label = "personal") => {
      const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log: quiet });
      try {
        return await admin.secrets.secret(googleSecretName(label, "contacts_refresh_token"));
      } finally {
        await admin.close();
      }
    };

    it("connect with --contacts asks for the contacts grant's three scopes with the login hint, and stores the contacts token alone", async () => {
      const { db, env } = await connected();
      const before = await stored(db);
      // No PI_GOOGLE_CLIENT_* in the environment: the label's stored read client is used.
      const { result, url, calls } = await connect(
        ["google", "connect", "--account", "personal", "--contacts"],
        env,
        contactsAnswer(CONTACTS_GRANTED),
      );
      expect(result).toEqual({ exit: 0, stdout: `${url.toString()}\n`, stderr: "" });
      expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual([...scopesFor("contacts")].sort());
      expect(url.searchParams.get("login_hint")).toBe(ADDRESS);
      expect(url.searchParams.get("client_id")).toBe(CLIENT.PI_GOOGLE_CLIENT_ID);
      expect(url.searchParams.has("include_granted_scopes")).toBe(false);
      expect(calls[0]?.body.get("client_secret")).toBe(CLIENT.PI_GOOGLE_CLIENT_SECRET);
      expect(await contactsToken(db)).toBe(CONTACTS_REFRESH);

      // The mail token and the stored client are byte for byte the same after a contacts connect.
      const after = await stored(db);
      expect(after.map((row) => row.name)).toEqual([
        "google/personal/client",
        "google/personal/contacts_refresh_token",
        "google/personal/refresh_token",
      ]);
      for (const name of ["google/personal/client", "google/personal/refresh_token"]) {
        expect(after.find((row) => row.name === name)).toEqual(before.find((row) => row.name === name));
      }
      expect(await scanForPlaintext(db.urls.admin, [CONTACTS_REFRESH])).toEqual([]);
    });

    it("a consent with the contacts scope unticked is scope_mismatch and the old token stays", async () => {
      const { db, env } = await connected();
      expect(
        (
          await connect(
            ["google", "connect", "--account", "personal", "--contacts"],
            env,
            contactsAnswer(CONTACTS_GRANTED),
          )
        ).result.exit,
      ).toBe(0);
      const before = await stored(db);
      const unticked = await connect(["google", "connect", "--account", "personal", "--contacts"], env, {
        ...contactsAnswer("openid https://www.googleapis.com/auth/userinfo.email"),
        refresh_token: "sentinel-other-refresh",
      });
      expect(unticked.result).toMatchObject({
        exit: 1,
        stderr: expect.stringContaining(JSON.stringify({ event: "command_failed", code: "scope_mismatch" })),
      });
      expect(await stored(db)).toEqual(before);
      expect(await contactsToken(db)).toBe(CONTACTS_REFRESH);
    });

    it("a consent by another account, or an unverified one, is wrong_account and stores nothing", async () => {
      const { db, env } = await connected();
      const before = await stored(db);
      for (const answer of [
        contactsAnswer(CONTACTS_GRANTED, "someone.else@example.test"),
        contactsAnswer(CONTACTS_GRANTED, ADDRESS, false),
      ]) {
        const { result } = await connect(["google", "connect", "--account", "personal", "--contacts"], env, answer);
        expect(result).toMatchObject({
          exit: 1,
          stderr: expect.stringContaining(JSON.stringify({ event: "command_failed", code: "wrong_account" })),
        });
      }
      expect(await stored(db)).toEqual(before);
      // The positive control: the label's own address, verified.
      expect(
        (
          await connect(
            ["google", "connect", "--account", "personal", "--contacts"],
            env,
            contactsAnswer(CONTACTS_GRANTED),
          )
        ).result.exit,
      ).toBe(0);
    });

    it("connect --contacts refuses a label with no stored client or no stored address as not_found", async () => {
      const { db, env } = await ownerDatabase();
      const unanswered: RunDeps = {
        google: { fetch: async () => Promise.reject(new Error("no call is expected")) },
        listenTimeoutMs: 20,
      };
      // Never connected.
      expect(await pi(["google", "connect", "--account", "personal", "--contacts"], env, { deps: unanswered })).toEqual(
        refused("not_found"),
      );
      // Connected for mail, never synced: no stored address.
      expect(
        (
          await connect(
            ["google", "connect", "--account", "personal"],
            { ...env, ...CLIENT },
            granted(GOOGLE_SCOPES.join(" ")),
          )
        ).result.exit,
      ).toBe(0);
      expect(await pi(["google", "connect", "--account", "personal", "--contacts"], env, { deps: unanswered })).toEqual(
        refused("not_found"),
      );
      expect(await contactsToken(db)).toBeNull();
      // --compartment is the mail grant's; with --contacts it is a usage error.
      expect(
        await pi(["google", "connect", "--account", "personal", "--contacts", "--compartment", "own"], env, {
          deps: unanswered,
        }),
      ).toEqual(refused("usage", undefined, 2));
    });

    it("disconnect --contacts deletes the contacts token alone, and disconnect deletes both", async () => {
      const { db, env } = await connected();
      expect(
        (
          await connect(
            ["google", "connect", "--account", "personal", "--contacts"],
            env,
            contactsAnswer(CONTACTS_GRANTED),
          )
        ).result.exit,
      ).toBe(0);
      expect(await pi(["google", "disconnect", "personal", "--contacts"], env)).toEqual(DONE);
      expect((await stored(db)).map((row) => row.name)).toEqual([
        "google/personal/client",
        "google/personal/refresh_token",
      ]);
      // Nothing left to disconnect.
      expect(await pi(["google", "disconnect", "personal", "--contacts"], env)).toEqual(refused("not_found"));

      expect(
        (
          await connect(
            ["google", "connect", "--account", "personal", "--contacts"],
            env,
            contactsAnswer(CONTACTS_GRANTED),
          )
        ).result.exit,
      ).toBe(0);
      expect(await pi(["google", "disconnect", "personal"], env)).toEqual(DONE);
      expect(await stored(db)).toEqual([]);
    });

    it("list shows whether contacts are connected and no token", async () => {
      const { env } = await connected();
      const off = JSON.parse((await pi(["google", "list"], env)).stdout) as Record<string, unknown>[];
      expect(off).toMatchObject([{ label: "personal", contacts: false, contactsTokenUpdatedAt: null }]);
      expect(
        (
          await connect(
            ["google", "connect", "--account", "personal", "--contacts"],
            env,
            contactsAnswer(CONTACTS_GRANTED),
          )
        ).result.exit,
      ).toBe(0);
      const listed = await pi(["google", "list"], env);
      expect(JSON.parse(listed.stdout)).toMatchObject([
        { label: "personal", contacts: true, contactsTokenUpdatedAt: expect.stringMatching(/^\d{4}-/) },
      ]);
      for (const secret of [CONTACTS_REFRESH, REFRESH, CLIENT.PI_GOOGLE_CLIENT_SECRET])
        expect(listed.stdout).not.toContain(secret);
      // Disconnected: contacts off again.
      expect(await pi(["google", "disconnect", "personal", "--contacts"], env)).toEqual(DONE);
      expect(JSON.parse((await pi(["google", "list"], env)).stdout)).toMatchObject([
        { label: "personal", contacts: false, contactsTokenUpdatedAt: null },
      ]);
    });
  });
});

// A key file in a folder of its own and a database, synced by `sync`, built once for the file;
// each test gets a copy of the database and key file (copiesOf). Dropped when the file ends.
const builtFolders: string[] = [];
function syncedOnce(sync: (db: TestDatabase) => Promise<void>) {
  const copies = copiesOf(async () => {
    const folder = await mkdtemp(join(tmpdir(), "pi-owner-test-"));
    builtFolders.push(folder);
    const keyFile = join(folder, "keys.json");
    expect(await pi(["keys", "init", "--compartments", "own,employer:example"], { PI_KEY_FILE: keyFile })).toEqual(
      DONE,
    );
    const db = await createTestDatabase({ keyFile });
    try {
      await sync(db);
    } catch (error) {
      await db.drop();
      throw error;
    }
    return db;
  });
  afterAll(() => copies.drop());
  return async (): Promise<{ db: TestDatabase; env: Env; keyFile: string }> => {
    const db = await copies.copy();
    databases.push(db);
    return { db, keyFile: db.keyFile, env: { PI_DATABASE_URL_ADMIN: db.urls.admin, PI_KEY_FILE: db.keyFile } };
  };
}
afterAll(async () => {
  for (const folder of builtFolders.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe("pi owner, inspect and status", () => {
  const NOW = new Date("2026-06-15T12:00:00.000Z");

  // The synthetic world, synced into the database.
  const syncedCopy = syncedOnce(async (db) => {
    const writer = createWriter({ url: db.urls.writer, keys: db.keys, log: quiet });
    try {
      expect(
        (await runSync({ writer, sources: fakeSources(world({ now: NOW })), log: quiet, now: NOW })).outcomes.every(
          (one) => one.outcome === "ok",
        ),
      ).toBe(true);
    } finally {
      await writer.close();
    }
  });
  async function synced() {
    return { ...(await syncedCopy()), w: world({ now: NOW }) };
  }

  it("owner add-address records the address and re-points the person who held it to the owner in the same transaction", async () => {
    const { db, env, w } = await synced();
    const address = w.handles.topContactAddress;
    const fp = fingerprint(db.keys, "address", address);
    const held = await queryAs<{ entity_id: string }>(
      db.urls.admin,
      "select distinct a.entity_id from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where e.kind = 'person' and a.value_fp = $1",
      [fp],
    );
    expect(held).toHaveLength(1);

    const result = await pi(["owner", "add-address", address], env);
    expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
    const printed = JSON.parse(result.stdout) as { rederived: boolean; items: number };
    expect(printed.rederived).toBe(true);
    expect(printed.items).toBeGreaterThan(0);

    // The owner holds the address alone, and the person who held it is gone.
    expect(
      await queryAs(
        db.urls.admin,
        "select e.kind from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where a.value_fp = $1 order by 1",
        [fp],
      ),
    ).toEqual([{ kind: "owner" }]);
    expect(
      await queryAs(db.urls.admin, "select id from knowledge.entities where id = $1", [held[0]?.entity_id]),
    ).toEqual([]);
    // A second add of the same address finds no one to re-point.
    expect(JSON.parse((await pi(["owner", "add-address", address], env)).stdout)).toEqual({
      rederived: false,
      items: 0,
    });

    expect(await pi(["owner", "add-address", "not an address"], env)).toEqual(refused("invalid_address"));
    expect(await pi(["owner", "add-address", address, "--compartment", "employer:other"], env)).toEqual(
      refused("unknown_compartment"),
    );
    expect(await pi(["owner", "add-address", address, "--compartment", "Own"], env)).toEqual(
      refused("usage", undefined, 2),
    );
    // One compartment, not a list: the first of two is never taken silently.
    expect(
      await pi(["owner", "add-address", "another@quinn.test", "--compartment", "own,employer:example"], env),
    ).toEqual(refused("usage", undefined, 2));
    expect(
      await queryAs(db.urls.admin, "select 1 from knowledge.accounts where value_fp = $1", [
        fingerprint(db.keys, "address", "another@quinn.test"),
      ]),
    ).toEqual([]);
  });

  // The world, and a second held message from a sender of the test's own whose subject is a
  // canary, synced into the database.
  const HELD_CANARY = {
    subject: "CANARY-HELD-SUBJ-Q4W8 verification code",
    sender: "canary-held-r2t6@vault.example.org",
  };
  const syncedWithHeldCopy = syncedOnce(async (db) => {
    const w = world({ now: NOW });
    const sources = fakeSources(w);
    const at = NOW.getTime() - 10 * 86_400_000 - 3_600_000;
    sources[0]?.gmail.add({
      id: "19c00000000000aa",
      threadId: "19c00000000000aa",
      internalDate: at,
      labelIds: ["INBOX"],
      headers: [
        { name: "From", value: `Vault <${HELD_CANARY.sender}>` },
        { name: "To", value: w.owner.addresses[0] ?? "" },
        { name: "Date", value: new Date(at - 60_000).toUTCString().replace("GMT", "+0000") },
        { name: "Subject", value: HELD_CANARY.subject },
        { name: "Message-ID", value: "<held-canary@id.example.com>" },
      ],
      text: "Enter 551204 to continue.\r\n",
    });
    const writer = createWriter({ url: db.urls.writer, keys: db.keys, log: quiet });
    try {
      expect(
        (await runSync({ writer, sources, log: quiet, now: NOW })).outcomes.every((one) => one.outcome === "ok"),
      ).toBe(true);
    } finally {
      await writer.close();
    }
  });
  async function syncedWithHeld() {
    return { ...(await syncedWithHeldCopy()), w: world({ now: NOW }) };
  }
  type Held = { held: number; messages: { id: string; at: string; by: string }[] };
  const heldOf = async (env: Env): Promise<Held> => JSON.parse((await pi(["messages", "held"], env)).stdout) as Held;

  it("messages held prints the count and the newest held ids with their times, and nothing a message says", async () => {
    const { env, w } = await syncedWithHeld();
    const result = await pi(["messages", "held"], env);
    expect({ exit: result.exit, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    const view = JSON.parse(result.stdout) as Held;
    // The canary message and the world's recovery message, newest first, each by its id, time and
    // what held it: the recovery markers, as no model holds anything in this world.
    expect(view.held).toBe(2);
    expect(view.messages.map((one) => Object.keys(one))).toEqual([
      ["id", "at", "by"],
      ["id", "at", "by"],
    ]);
    expect(view.messages.map((one) => one.by)).toEqual(["markers", "markers"]);
    for (const one of view.messages) expect(one.id).toMatch(/^msg_[0-9A-Z]{26}$/);
    expect(view.messages[0]?.at).toBe(new Date(NOW.getTime() - 10 * 86_400_000 - 3_600_000 - 60_000).toISOString());
    expect(Date.parse(view.messages[1]?.at ?? "")).toBeLessThan(Date.parse(view.messages[0]?.at ?? ""));
    // Nothing a message says: no subject, sender or text, the canaries' among them.
    const held = w.accounts[0]?.messages.find((one) => one.id === w.handles.heldMessageId);
    for (const value of [
      HELD_CANARY.subject,
      HELD_CANARY.sender,
      "551204",
      "482913",
      ...(held?.headers.map((one) => one.value) ?? []),
    ]) {
      expect(result.stdout.toLowerCase(), value).not.toContain(value.toLowerCase().slice(0, 40));
    }
  });

  it("messages release by id releases that message and prints the count, and an id that names no held message is not_found", async () => {
    const { db, env } = await syncedWithHeld();
    const before = await heldOf(env);
    const [newest] = before.messages;
    expect(await pi(["messages", "release", newest?.id ?? ""], env)).toEqual({
      exit: 0,
      stdout: `${JSON.stringify({ released: 1 })}\n`,
      stderr: "",
    });
    expect(await heldOf(env)).toEqual({ held: 1, messages: before.messages.slice(1) });
    // Released, it is no held message; nor is one that never was, nor an id of no message.
    const [plain] = await queryAs<{ id: string }>(
      db.urls.admin,
      "select id from knowledge.messages where not held order by id limit 1",
    );
    for (const id of [newest?.id ?? "", plain?.id ?? "", `msg_${"0".repeat(25)}1`])
      expect(await pi(["messages", "release", id], env), id).toEqual(refused("not_found"));
    expect((await heldOf(env)).held).toBe(1);
  });

  it("messages release --older-than releases only the held messages older than that, and prints 0 when there is none", async () => {
    const { env } = await syncedWithHeld();
    const before = await heldOf(env);
    // The world's recovery message is 42 days older than the world's now; the canary one 10.
    // The command counts from the real clock, so the ages are counted from it.
    const behind = Math.ceil((Date.now() - NOW.getTime()) / 86_400_000);
    const older = (days: number): string[] => ["messages", "release", "--older-than", `${behind + days}d`];
    expect(await pi(older(30), env)).toEqual({ exit: 0, stdout: `${JSON.stringify({ released: 1 })}\n`, stderr: "" });
    expect(await heldOf(env)).toEqual({ held: 1, messages: before.messages.slice(0, 1) });
    expect(await pi(older(30), env)).toEqual({ exit: 0, stdout: `${JSON.stringify({ released: 0 })}\n`, stderr: "" });
    expect(await pi(older(5), env)).toEqual({ exit: 0, stdout: `${JSON.stringify({ released: 1 })}\n`, stderr: "" });
    expect(await heldOf(env)).toEqual({ held: 0, messages: [] });
  });

  it("inspect and status print one JSON document, and inspect only for an entity that exists", async () => {
    const { env, w } = await synced();
    const address = w.handles.topContactAddress;

    const byAddress = await pi(["inspect", address], env, { tty: true });
    expect(byAddress).toMatchObject({ exit: 0, stderr: "" });
    const entity = JSON.parse(byAddress.stdout) as { id: string; kind: string; addresses: { value: string }[] };
    expect(entity).toMatchObject({ kind: "person", addresses: [{ value: address, compartment: "own" }] });
    expect(JSON.parse((await pi(["inspect", entity.id], env, { tty: true })).stdout)).toEqual(entity);
    expect(await pi(["inspect", `ent_${"0".repeat(25)}1`], env, { tty: true })).toEqual(refused("not_found"));
    expect(await pi(["inspect", "nobody@example.com"], env, { tty: true })).toEqual(refused("not_found"));

    const status = await pi(["status"], env);
    expect(status).toMatchObject({ exit: 0, stderr: "" });
    const view = JSON.parse(status.stdout) as { accounts: unknown[]; tables: Record<string, number> };
    expect(view).toMatchObject({ keyCheck: "ok", clients: [], googleTokens: [] });
    // What is deployed: the commit, unknown in a checkout no deploy wrote, and the migration level.
    expect(view).toMatchObject({
      commit: expect.stringMatching(/^([0-9a-f]{7,40}|unknown)$/),
      migration: expect.stringMatching(/^\d{4}$/),
    });
    expect(view.accounts).toMatchObject([
      { label: "personal", connector: "google_calendar", compartment: "own", lastOutcome: "ok" },
      { label: "personal", connector: "google_mail", compartment: "own", lastOutcome: "ok" },
      { label: "work", connector: "google_calendar", compartment: "employer:example", lastOutcome: "ok" },
      { label: "work", connector: "google_mail", compartment: "employer:example", lastOutcome: "ok" },
    ]);
    expect(view.tables["vault.evidence_items"]).toBeGreaterThan(60);
    // Counts and ids only: no address, name or subject of the world.
    for (const value of [address, ...w.owner.addresses, ...Object.values(w.canaries)])
      expect(status.stdout.toLowerCase()).not.toContain(value.toLowerCase());
  });
});

// A client that records, its tools and its token, and the owner's agent-records commands.
// `PI_RECORD_ENABLED` lets a client be given record once the owner has decided backups.
describe("pi clients and agent records", () => {
  const RECORDING = { PI_RECORD_ENABLED: "1" };
  const keyNames = async (keyFile: string): Promise<string[]> =>
    [...(await loadKeys(keyFile)).compartments.keys()].sort();

  // The reader and writer on the database, with the key file as it is now.
  async function stores(db: TestDatabase, keyFile: string) {
    const keys = await loadKeys(keyFile);
    const reader = createReader({ url: db.urls.reader, keys, log: quiet });
    const writer = createWriter({ url: db.urls.writer, keys, log: quiet });
    return { reader, writer, close: async () => Promise.all([reader.close(), writer.close()]) };
  }

  it("clients add with record adds the agent key once and registers", async () => {
    const { db, env, keyFile } = await ownerDatabase();
    // Not until the deployment allows it: nothing is written, the key included.
    expect(
      await pi(["clients", "add", "scribe", "--broad", "--views", "self", "--tools", "get_self,record"], env),
    ).toEqual(refused("record_disabled"));
    expect(await keyNames(keyFile)).toEqual(["employer:example", "own"]);
    expect(await queryAs(db.urls.admin, "select name from policy.clients")).toEqual([]);

    const added = await pi(["clients", "add", "scribe", "--broad", "--views", "self", "--tools", "get_self,record"], {
      ...env,
      ...RECORDING,
    });
    expect(added).toEqual({ exit: 0, stdout: expect.stringMatching(/^pit_[A-Za-z0-9_-]{43}\n$/), stderr: WARNED });
    expect(await keyNames(keyFile)).toEqual(["agent:scribe", "employer:example", "own"]);
    expect(await queryAs(db.urls.admin, "select name, compartments, tools from policy.clients")).toEqual([
      { name: "scribe", compartments: ["own", "agent:scribe"], tools: ["get_self", "record"] },
    ]);
    expect(await queryAs(db.urls.admin, "select label, connector from vault.source_accounts")).toEqual([
      { label: "agent:scribe", connector: "agent" },
    ]);
    // Once: the name taken, the key file is as it was.
    const file = await readFile(keyFile);
    expect(
      await pi(["clients", "add", "scribe", "--broad", "--views", "self", "--tools", "get_self,record"], {
        ...env,
        ...RECORDING,
      }),
    ).toEqual(refused("duplicate_name"));
    expect(await readFile(keyFile)).toEqual(file);
  });

  it("a second run after a crash between the key and the registration succeeds", async () => {
    const { db, env, keyFile } = await ownerDatabase();
    // As a crash leaves it: the key written, no client.
    expect(await pi(["keys", "add-compartment", "agent:late"], { PI_KEY_FILE: keyFile })).toEqual(DONE);
    const file = await readFile(keyFile);
    expect(
      (
        await pi(["clients", "add", "late", "--broad", "--views", "self", "--tools", "get_self,record"], {
          ...env,
          ...RECORDING,
        })
      ).exit,
    ).toBe(0);
    expect(await readFile(keyFile)).toEqual(file);
    expect(await queryAs(db.urls.admin, "select name, compartments from policy.clients")).toEqual([
      { name: "late", compartments: ["own", "agent:late"] },
    ]);
  });

  it("set-tools prints nothing and keeps the token working", async () => {
    const { db, env, keyFile } = await ownerDatabase();
    const token = (
      await pi(["clients", "add", "scout", "--broad", "--views", "self", "--tools", "get_self"], env)
    ).stdout.trim();
    expect(await pi(["clients", "set-tools", "scout", "--tools", "get_self,record"], env)).toEqual(
      refused("record_disabled"),
    );
    expect(await pi(["clients", "set-tools", "scout", "--tools", "get_self,record"], { ...env, ...RECORDING })).toEqual(
      DONE,
    );
    expect(await keyNames(keyFile)).toContain("agent:scout");
    expect(await queryAs(db.urls.admin, "select tools, compartments from policy.clients")).toEqual([
      { tools: ["get_self", "record"], compartments: ["own", "agent:scout"] },
    ]);
    const { reader, close } = await stores(db, keyFile);
    try {
      expect((await reader.getSelf(token)).ok).toBe(true);
      expect(
        (await reader.record(token, { kind: "note", body: "after set-tools", requestId: "set-tools-0001" })).ok,
      ).toBe(true);
    } finally {
      await close();
    }
    expect(await pi(["clients", "set-tools", "nobody", "--tools", "get_self"], env)).toEqual(refused("not_found"));
    // A name that is no active client adds no key, also with record.
    expect((await pi(["clients", "add", "gone", "--broad", "--views", "self", "--tools", "get_self"], env)).exit).toBe(
      0,
    );
    expect(await pi(["clients", "revoke", "gone"], env)).toEqual(DONE);
    const file = await readFile(keyFile);
    for (const name of ["nobody", "gone", "Not-A-Name"]) {
      expect(
        await pi(["clients", "set-tools", name, "--tools", "get_self,record"], { ...env, ...RECORDING }),
        name,
      ).toEqual(refused("not_found"));
    }
    expect(await readFile(keyFile)).toEqual(file);
  });

  it("set-tools with an unknown tool is a usage error", async () => {
    const { db, env } = await ownerDatabase();
    expect((await pi(["clients", "add", "scout", "--broad", "--views", "self", "--tools", "get_self"], env)).exit).toBe(
      0,
    );
    for (const tools of ["get_self,delete_everything", "get_self,", "get_self, search"])
      expect(await pi(["clients", "set-tools", "scout", "--tools", tools], env), tools).toEqual(
        refused("usage", undefined, 2),
      );
    expect(await pi(["clients", "set-tools", "scout"], env)).toEqual(refused("usage", undefined, 2));
    expect(await queryAs(db.urls.admin, "select tools from policy.clients")).toEqual([{ tools: ["get_self"] }]);
  });

  it("set-compartments widens a registered client, prints nothing and keeps its token; it never narrows one", async () => {
    const { db, env, keyFile } = await ownerDatabase();
    const token = (
      await pi(["clients", "add", "lark", "--broad", "--views", "self", "--tools", "get_self,record"], {
        ...env,
        ...RECORDING,
      })
    ).stdout.trim();
    expect(
      (
        await pi(["clients", "add", "wren", "--broad", "--views", "self", "--tools", "get_self,record"], {
          ...env,
          ...RECORDING,
        })
      ).exit,
    ).toBe(0);
    const compartmentsOf = async () =>
      queryAs(db.urls.admin, "select compartments, tools from policy.clients where name = 'lark'");
    expect(
      await pi(["clients", "set-compartments", "lark", "--compartments", "own,agent:lark,agent:wren"], env),
    ).toEqual(DONE);
    expect(await compartmentsOf()).toEqual([
      { compartments: ["agent:lark", "agent:wren", "own"], tools: ["get_self", "record"] },
    ]);
    const { reader, close } = await stores(db, keyFile);
    try {
      expect((await reader.getSelf(token)).ok).toBe(true);
    } finally {
      await close();
    }
    expect(await pi(["clients", "set-compartments", "lark", "--compartments", "own,agent:wren"], env)).toEqual(
      refused(
        "would_narrow",
        "a clearance only widens in place; to narrow one, revoke the client and register a new name (pia clients revoke NAME)",
      ),
    );
    expect(
      await pi(
        ["clients", "set-compartments", "lark", "--compartments", "own,agent:lark,agent:wren,agent:keyless"],
        env,
      ),
    ).toEqual(refused("unknown_compartment"));
    expect(await pi(["clients", "set-compartments", "nobody", "--compartments", "own"], env)).toEqual(
      refused("not_found"),
    );
    for (const given of ["own,nonsense", "own,", "own, agent:lark"])
      expect(await pi(["clients", "set-compartments", "lark", "--compartments", given], env), given).toEqual(
        refused("usage", undefined, 2),
      );
    expect(await pi(["clients", "set-compartments", "lark"], env)).toEqual(refused("usage", undefined, 2));
    expect(await compartmentsOf()).toEqual([
      { compartments: ["agent:lark", "agent:wren", "own"], tools: ["get_self", "record"] },
    ]);
  });

  it("rotate prints a token that answers, the old one answers unauthorized, and client_rotated is logged with no token in it", async () => {
    const { db, env, keyFile } = await ownerDatabase();
    const old = (
      await pi(["clients", "add", "rotor", "--broad", "--views", "self", "--tools", "get_self,record"], {
        ...env,
        ...RECORDING,
      })
    ).stdout.trim();
    const before = await queryAs(
      db.urls.admin,
      "select id, name, compartments, views, tools, status from policy.clients",
    );
    const rotated = await pi(["clients", "rotate", "rotor"], env);
    expect(rotated).toEqual({
      exit: 0,
      stdout: expect.stringMatching(/^pit_[A-Za-z0-9_-]{43}\n$/),
      stderr: `${JSON.stringify({ event: "client_rotated", ids: { client: "rotor" } })}\n`,
    });
    const token = rotated.stdout.trim();
    expect(rotated.stderr).not.toContain(token);
    expect(rotated.stderr).not.toContain(sha256(token));
    expect(
      await queryAs(db.urls.admin, "select id, name, compartments, views, tools, status from policy.clients"),
    ).toEqual(before);
    const { reader, close } = await stores(db, keyFile);
    try {
      expect((await reader.getSelf(token)).ok).toBe(true);
      expect(await reader.getSelf(old)).toEqual({ ok: false, code: "unauthorized" });
    } finally {
      await close();
    }
  });

  it("rotate of an unknown name exits 1 with not_found", async () => {
    const { db, env } = await ownerDatabase();
    expect(await pi(["clients", "rotate", "nobody"], env)).toEqual(refused("not_found"));
    expect((await pi(["clients", "add", "gone", "--broad", "--views", "self", "--tools", "get_self"], env)).exit).toBe(
      0,
    );
    expect(await pi(["clients", "revoke", "gone"], env)).toEqual(DONE);
    const before = await queryAs(db.urls.admin, "select token_hash from policy.clients");
    expect(await pi(["clients", "rotate", "gone"], env)).toEqual(refused("not_found"));
    expect(await queryAs(db.urls.admin, "select token_hash from policy.clients")).toEqual(before);
  });

  it("A14: agent-records rm leaves no body, evidence row or blob, removes no other agent record, and prints its count; list prints no content; show only to a terminal", async () => {
    const { db, env, keyFile } = await ownerDatabase();
    const token = (
      await pi(["clients", "add", "scribe", "--broad", "--views", "self", "--tools", "get_self,record"], {
        ...env,
        ...RECORDING,
      })
    ).stdout.trim();
    const body = "CANARY-a14 the owner's command never prints this";
    const { reader, writer, close } = await stores(db, keyFile);
    let first: string;
    let second: string;
    try {
      first = valueOrThrow(await reader.record(token, { kind: "handoff", body, requestId: "a14-request-1" })).recordId;
      second = valueOrThrow(await reader.record(token, { kind: "note", body, requestId: "a14-request-2" })).recordId;
      expect(await writer.takeRecords()).toEqual({ taken: 2, removed: 0, refused: 0, waiting: 0 });
    } finally {
      await close();
    }

    // The list: ids, names, kinds, times, labels and states, and no content.
    const listed = await pi(["agent-records", "list"], env);
    expect(listed).toMatchObject({ exit: 0, stderr: "" });
    expect(JSON.parse(listed.stdout)).toEqual([
      {
        id: second,
        client: "scribe",
        kind: "note",
        createdAt: expect.any(String),
        compartments: ["agent:scribe", "own"],
        state: "taken",
        flagged: false,
      },
      {
        id: first,
        client: "scribe",
        kind: "handoff",
        createdAt: expect.any(String),
        compartments: ["agent:scribe", "own"],
        state: "taken",
        flagged: false,
      },
    ]);
    expect(listed.stdout).not.toContain("CANARY-a14");
    expect(
      JSON.parse((await pi(["agent-records", "list", "--kind", "handoff", "--limit", "5"], env)).stdout),
    ).toHaveLength(1);
    // `decision` is a record kind; `verdict` is none.
    for (const argv of [
      ["--kind", "verdict"],
      ["--state", "lost"],
      ["--limit", "0"],
      ["--limit", "201"],
    ]) {
      expect(await pi(["agent-records", "list", ...argv], env), argv.join(" ")).toEqual(refused("usage", undefined, 2));
    }

    // Show: to a terminal only, refused before any connection otherwise.
    expect(
      await pi(["agent-records", "show", first], {
        ...env,
        PI_DATABASE_URL_ADMIN: "postgres://pi_admin:local-only@127.0.0.1:1/none",
      }),
    ).toEqual(refused("not_a_terminal"));
    const shown = await pi(["agent-records", "show", first], env, { tty: true });
    expect(shown).toMatchObject({ exit: 0, stderr: "" });
    expect(JSON.parse(shown.stdout)).toMatchObject({ id: first, body, state: "taken", refusedCode: null });
    expect(await pi(["agent-records", "show", "rec_00000000000000000000000000"], env, { tty: true })).toEqual(
      refused("not_found"),
    );

    // Remove: that one, and no other.
    const [{ evidence_id: evidence = "" } = {}] = await queryAs<{ evidence_id: string }>(
      db.urls.admin,
      "select evidence_id from ledger.agent_writes where id = $1",
      [first],
    );
    const [{ blob_ref: blob = "" } = {}] = await queryAs<{ blob_ref: string }>(
      db.urls.admin,
      "select blob_ref from vault.evidence_items where id = $1",
      [evidence],
    );
    expect(await pi(["agent-records", "rm", first], env)).toEqual({
      exit: 0,
      stdout: `${JSON.stringify({ removed: 1 })}\n`,
      stderr: "",
    });
    expect(
      await queryAs(db.urls.admin, "select id, body_enc is null as emptied from ledger.agent_writes order by id"),
    ).toEqual(
      [
        { id: first, emptied: true },
        { id: second, emptied: false },
      ].sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
    expect(await queryAs(db.urls.admin, "select id from vault.evidence_items where id = $1", [evidence])).toEqual([]);
    expect(
      await queryAs(db.urls.admin, "select blob_ref from vault.evidence_blobs where blob_ref = $1", [blob]),
    ).toEqual([]);
    expect(await pi(["agent-records", "rm", first], env)).toEqual({
      exit: 0,
      stdout: `${JSON.stringify({ removed: 0 })}\n`,
      stderr: "",
    });
    expect(await pi(["agent-records", "rm", "rec_00000000000000000000000000"], env)).toEqual(refused("not_found"));
    expect(
      JSON.parse((await pi(["agent-records", "list", "--state", "removed"], env)).stdout).map(
        (row: { id: string }) => row.id,
      ),
    ).toEqual([first]);
    expect(await scanForPlaintext(db.urls.admin, ["CANARY-a14"])).toEqual([]);
  });
});

// The value of an answer that must be ok.
function valueOrThrow<T>(outcome: { ok: true; value: T } | { ok: false; code: string }): T {
  if (!outcome.ok) throw new Error(`refused: ${outcome.code}`);
  return outcome.value;
}
