import {
  CaptureExcludeView,
  type ErasureJournalEntry,
  LensBrowsingView,
  LensDeviceView,
} from "@intelligence/contracts/personal";
import { sha256 } from "@intelligence/personal-core";
import { appendJournal, journalPath } from "@intelligence/personal-store";
import {
  createTestDatabase,
  fingerprint,
  queryAs,
  sealRow,
  type TestDatabase,
} from "@intelligence/personal-store/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { failed, pi as runPi } from "../test-support/run-pi.ts";

// `pi lens add`, `list`, `rotate`, `revoke` and `scope`, and `pi status`'s device lines, through
// `run` in-process with a terminal stand-in, each on a database of its own.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const dbs: TestDatabase[] = [];
afterEach(async () => {
  for (const db of dbs.splice(0)) await db.drop();
});

async function database(): Promise<TestDatabase> {
  const db = await createTestDatabase();
  dbs.push(db);
  return db;
}

// `input`: the lines the command reads, as an owner typing them (`lens browsing deny` asks).
const pi = (
  argv: string[],
  env: Record<string, string>,
  { tty = false, input = [] }: { tty?: boolean; input?: string[] } = {},
) => runPi(argv, env, { tty, stdin: input.map((line) => `${line}\n`) });

const ownerEnv = (db: TestDatabase): Record<string, string> => ({
  PI_DATABASE_URL_ADMIN: db.urls.admin,
  PI_KEY_FILE: db.keyFile,
});
const admin = <Row = Record<string, unknown>>(db: TestDatabase, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);
const hashes = async (db: TestDatabase, name: string): Promise<string[]> =>
  (
    await admin<{ token_hash: string }>(
      db,
      "select token_hash from policy.clients where name in ($1, $1 || '-capture') order by name",
      [name],
    )
  ).map((row) => row.token_hash);

describe("pi lens", () => {
  it("lens add prints the capture token once to a terminal and refuses not_a_terminal otherwise; the mirror's first token is rotate --mirror's", async () => {
    const db = await database();
    const env = ownerEnv(db);
    // Without a terminal: refused before any connection, and nothing is written.
    expect(await pi(["lens", "add", "mac"], env)).toEqual({
      exit: 1,
      stdout: "",
      stderr: failed("not_a_terminal", "lens add prints the device's capture token once: run it in a terminal"),
    });
    expect(await admin(db, "select name from policy.lens_devices")).toEqual([]);

    // The positive control, on a terminal: one JSON line holding the capture token alone, whose
    // hash alone is stored. The mirror client holds a hash no printed token has.
    const added = await pi(["lens", "add", "mac"], env, { tty: true });
    expect({ exit: added.exit, stderr: added.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(added.stdout.endsWith("\n")).toBe(true);
    expect(added.stdout.trimEnd().split("\n")).toHaveLength(1);
    const tokens = JSON.parse(added.stdout) as { capture: string };
    expect(Object.keys(tokens)).toEqual(["capture"]);
    expect(tokens.capture).toMatch(/^pit_/);
    const [unissued, captureHash] = await hashes(db, "mac");
    expect(captureHash).toBe(sha256(tokens.capture));
    expect(unissued).toMatch(/^[0-9a-f]{64}$/);
    expect(unissued).not.toBe(captureHash);
    expect(await admin(db, "select compartments, views from policy.clients where name = 'mac'")).toEqual([
      { compartments: ["own"], views: ["self", "people", "work"] },
    ]);
    // Once: the same name again is refused and prints nothing.
    expect(await pi(["lens", "add", "mac"], env, { tty: true })).toEqual({
      exit: 1,
      stdout: "",
      stderr: failed("duplicate_name"),
    });
    // A restricted compartment is refused, and so is a value that is no compartment.
    expect(await pi(["lens", "add", "health", "--compartments", "own,restricted:health"], env, { tty: true })).toEqual({
      exit: 1,
      stdout: "",
      stderr: failed("restricted_not_served"),
    });
    expect((await pi(["lens", "add", "bad", "--views", "self,"], env, { tty: true })).exit).toBe(2);

    // Rotate prints one channel's new token, to a terminal only, and keeps the other. The
    // mirror's first rotation issues its first token.
    expect(await pi(["lens", "rotate", "mac", "--capture"], env)).toEqual({
      exit: 1,
      stdout: "",
      stderr: failed("not_a_terminal", "lens rotate prints a new token once: run it in a terminal"),
    });
    expect((await pi(["lens", "rotate", "mac", "--capture", "--mirror"], env, { tty: true })).exit).toBe(2);
    expect((await pi(["lens", "rotate", "mac"], env, { tty: true })).exit).toBe(2);
    const issued = await pi(["lens", "rotate", "mac", "--mirror"], env, { tty: true });
    expect(issued.exit).toBe(0);
    const mirror = issued.stdout.trimEnd();
    expect(mirror).toMatch(/^pit_/);
    expect(await hashes(db, "mac")).toEqual([sha256(mirror), sha256(tokens.capture)]);
    const rotated = await pi(["lens", "rotate", "mac", "--capture"], env, { tty: true });
    expect(rotated.exit).toBe(0);
    const capture = rotated.stdout.trimEnd();
    expect(capture).toMatch(/^pit_/);
    expect(await hashes(db, "mac")).toEqual([sha256(mirror), sha256(capture)]);
    const hint = "a Lens device's capture token: run pi lens rotate DEVICE --capture in a terminal (pia on the box)";
    expect(await pi(["clients", "rotate", "mac-capture"], env)).toEqual({
      exit: 1,
      stdout: "",
      stderr: failed("device_fixed", hint),
    });
    expect(await pi(["clients", "rotate", "mac-capture"], env, { tty: true })).toEqual({
      exit: 1,
      stdout: "",
      stderr: failed("device_fixed", hint),
    });
    expect(await hashes(db, "mac")).toEqual([sha256(mirror), sha256(capture)]);

    // List prints one JSON document; revoke prints nothing and ends both.
    const listed = await pi(["lens", "list"], env);
    expect(listed.exit).toBe(0);
    expect((JSON.parse(listed.stdout) as unknown[]).map((view) => LensDeviceView.parse(view).status)).toEqual([
      "active",
    ]);
    expect(listed.stdout).not.toContain("pit_");
    expect(await pi(["lens", "revoke", "mac"], env)).toEqual({ exit: 0, stdout: "", stderr: "" });
    expect(await admin(db, "select status from policy.clients where name in ('mac', 'mac-capture')")).toEqual([
      { status: "revoked" },
      { status: "revoked" },
    ]);
    expect(await pi(["lens", "revoke", "nobody"], env)).toEqual({ exit: 1, stdout: "", stderr: failed("not_found") });
  });

  it("every lens command refuses erasure_replay_needed when the journal is ahead", async () => {
    const db = await database();
    const env = ownerEnv(db);
    expect((await pi(["lens", "add", "mac"], env, { tty: true })).exit).toBe(0);
    const [account] = await admin<{ id: string }>(
      db,
      "select id from vault.source_accounts where label = 'device:mac' and connector = 'lens_meetings'",
    );
    await appendJournal(journalPath(db.keyFile), {
      seq: 1,
      erasure: "ers_01JABCDEFGHJKMNPQRSTVWXYZ0",
      kind: "item",
      items: [{ account: account?.id ?? "", fp: "a".repeat(64) }],
      suppress: [],
    } as unknown as ErasureJournalEntry);
    const commands = [
      ["lens", "add", "other"],
      ["lens", "list"],
      ["lens", "rotate", "mac", "--mirror"],
      ["lens", "scope", "add", "--host", "example.test", "--compartment", "own"],
      ["lens", "scope", "list"],
      ["lens", "scope", "list", "--show"],
      ["lens", "scope", "remove", `csr_${ulid(9)}`],
      ["lens", "revoke", "mac"],
    ];
    for (const argv of commands)
      expect(await pi(argv, env, { tty: true }), argv.join(" ")).toEqual({
        exit: 1,
        stdout: "",
        stderr: failed("erasure_replay_needed", "run pi erase replay (pia on the box)"),
      });
    expect(await admin(db, "select name from policy.lens_devices")).toEqual([{ name: "mac" }]);
    expect(await admin(db, "select id from policy.capture_scope")).toEqual([]);
    expect((await pi(["erase", "replay"], env)).exit).toBe(0);
    // The positive control: level again, each runs. The rule removed is the one just added.
    for (const argv of commands) {
      const ran = await pi(
        argv[1] === "scope" && argv[2] === "remove" ? ["lens", "scope", "remove", await onlyRule(db)] : argv,
        env,
        { tty: true },
      );
      expect(ran.exit, argv.join(" ")).toBe(0);
    }
  });

  it("scope add prints a rule's id, list shows no value but with --show, and remove ends it", async () => {
    const db = await database();
    const env = ownerEnv(db);
    // A multi-account surface with no account, and a browser's bundle, are refused as their codes.
    expect(await pi(["lens", "scope", "add", "--host", "mail.google.com", "--compartment", "own"], env)).toEqual({
      exit: 1,
      stdout: "",
      stderr: failed("account_required"),
    });
    expect(
      await pi(
        ["lens", "scope", "add", "--bundle", "com.apple.Safari", "--compartment", "own", "--kinds", "meeting"],
        env,
      ),
    ).toEqual({ exit: 1, stdout: "", stderr: failed("browser_bundle") });
    expect(await admin(db, "select id from policy.capture_scope")).toEqual([]);

    // The controls: the same host with an account, and a host rule.
    const added = await pi(
      [
        "lens",
        "scope",
        "add",
        "--host",
        "mail.google.com",
        "--account",
        "owner@example.test",
        "--compartment",
        "employer:example",
        "--kinds",
        "moment",
      ],
      env,
    );
    expect({ exit: added.exit, stderr: added.stderr }).toEqual({ exit: 0, stderr: "" });
    const mail = added.stdout.trimEnd();
    expect(mail).toMatch(/^csr_[0-9A-HJKMNP-TV-Z]{26}$/);
    const docs = (
      await pi(["lens", "scope", "add", "--host", "Docs.Example.TEST.", "--compartment", "own"], env)
    ).stdout.trimEnd();
    expect(docs).toMatch(/^csr_/);
    // The same rule again is a duplicate.
    expect(await pi(["lens", "scope", "add", "--host", "docs.example.test", "--compartment", "own"], env)).toEqual({
      exit: 1,
      stdout: "",
      stderr: failed("duplicate_name"),
    });

    // List: ids, compartments and kinds, and no value or account.
    const listed = await pi(["lens", "scope", "list"], env);
    expect(listed.exit).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([
      {
        id: mail,
        match: "host",
        account: true,
        compartment: "employer:example",
        kinds: ["moment"],
        agentApp: false,
        client: null,
      },
      {
        id: docs,
        match: "host",
        account: false,
        compartment: "own",
        kinds: ["meeting", "moment", "block"],
        agentApp: false,
        client: null,
      },
    ]);
    for (const value of ["mail.google.com", "owner@example.test", "example.test"])
      expect(listed.stdout).not.toContain(value);
    // --show: to a terminal only, each value and account as stored, normalized.
    expect(await pi(["lens", "scope", "list", "--show"], env)).toEqual({
      exit: 1,
      stdout: "",
      stderr: failed("not_a_terminal", "scope list --show prints each rule's value: run it in a terminal"),
    });
    const shown = await pi(["lens", "scope", "list", "--show"], env, { tty: true });
    expect(shown.exit).toBe(0);
    expect(JSON.parse(shown.stdout)).toEqual([
      {
        id: mail,
        match: "host",
        account: true,
        compartment: "employer:example",
        kinds: ["moment"],
        agentApp: false,
        client: null,
        value: "mail.google.com",
        accountValue: "owner@example.test",
      },
      {
        id: docs,
        match: "host",
        account: false,
        compartment: "own",
        kinds: ["meeting", "moment", "block"],
        agentApp: false,
        client: null,
        value: "docs.example.test",
        accountValue: null,
      },
    ]);

    // Remove prints nothing; a second time, and an id that names none, are not_found.
    expect(await pi(["lens", "scope", "remove", docs], env)).toEqual({ exit: 0, stdout: "", stderr: "" });
    expect(await pi(["lens", "scope", "remove", docs], env)).toEqual({
      exit: 1,
      stdout: "",
      stderr: failed("not_found"),
    });
    expect(await admin(db, "select id from policy.capture_scope")).toEqual([{ id: mail }]);
  });

  it("scope add --agent-app marks a rule, moment and block by default, naming a client by --client; a meeting kind is refused", async () => {
    const db = await database();
    const env = ownerEnv(db);
    expect((await pi(["clients", "add", "desk", "--broad"], env, { tty: true })).exit).toBe(0);
    const [desk] = await admin<{ id: string }>(db, "select id from policy.clients where name = 'desk'");
    expect(
      await pi(
        [
          "lens",
          "scope",
          "add",
          "--bundle",
          "test.example.agent",
          "--compartment",
          "own",
          "--agent-app",
          "--kinds",
          "moment,meeting",
        ],
        env,
      ),
    ).toEqual({
      exit: 1,
      stdout: "",
      stderr: failed(
        "agent_app_meeting",
        "an agent-app rule admits moment and block only: an agent app's calls are not captured as meetings",
      ),
    });
    expect(
      await pi(
        [
          "lens",
          "scope",
          "add",
          "--bundle",
          "test.example.agent",
          "--compartment",
          "own",
          "--agent-app",
          "--client",
          "absent",
        ],
        env,
      ),
    ).toEqual({ exit: 1, stdout: "", stderr: failed("not_found") });
    const app = (
      await pi(
        [
          "lens",
          "scope",
          "add",
          "--bundle",
          "test.example.agent",
          "--compartment",
          "own",
          "--agent-app",
          "--client",
          "desk",
        ],
        env,
      )
    ).stdout.trimEnd();
    const web = (
      await pi(["lens", "scope", "add", "--host", "chat.example.test", "--compartment", "own", "--agent-app"], env)
    ).stdout.trimEnd();
    expect(JSON.parse((await pi(["lens", "scope", "list"], env)).stdout)).toEqual([
      {
        id: app,
        match: "bundle",
        account: false,
        compartment: "own",
        kinds: ["moment", "block"],
        agentApp: true,
        client: desk?.id,
      },
      {
        id: web,
        match: "host",
        account: false,
        compartment: "own",
        kinds: ["moment", "block"],
        agentApp: true,
        client: null,
      },
    ]);
  });

  it("scope add --source imessage makes a source rule of moments beside a plain rule of the same bundle, and list prints its source", async () => {
    const db = await database();
    const env = ownerEnv(db);
    expect(
      await pi(
        ["lens", "scope", "add", "--bundle", "test.example.chat", "--compartment", "own", "--source", "imessage"],
        env,
      ),
    ).toEqual({
      exit: 1,
      stdout: "",
      stderr: failed(
        "source_bundle",
        "a source rule names its source's app: --bundle com.apple.MobileSMS for --source imessage",
      ),
    });
    const plain = (
      await pi(
        ["lens", "scope", "add", "--bundle", "com.apple.MobileSMS", "--compartment", "own", "--kinds", "block"],
        env,
      )
    ).stdout.trimEnd();
    const made = await pi(
      ["lens", "scope", "add", "--bundle", "com.apple.MobileSMS", "--compartment", "own", "--source", "imessage"],
      env,
    );
    expect({ exit: made.exit, stderr: made.stderr }).toEqual({ exit: 0, stderr: "" });
    const source = made.stdout.trimEnd();
    expect(source).toMatch(/^csr_[0-9A-HJKMNP-TV-Z]{26}$/);
    // The same source rule again is a duplicate.
    expect(
      await pi(
        ["lens", "scope", "add", "--bundle", "com.apple.MobileSMS", "--compartment", "own", "--source", "imessage"],
        env,
      ),
    ).toEqual({ exit: 1, stdout: "", stderr: failed("duplicate_name") });
    const listed = await pi(["lens", "scope", "list"], env);
    expect(JSON.parse(listed.stdout)).toEqual([
      {
        id: plain,
        match: "bundle",
        account: false,
        compartment: "own",
        kinds: ["block"],
        agentApp: false,
        client: null,
      },
      {
        id: source,
        match: "bundle",
        account: false,
        compartment: "own",
        kinds: ["moment"],
        agentApp: false,
        client: null,
        source: "imessage",
      },
    ]);
    expect(listed.stdout).not.toContain("com.apple.MobileSMS");
  });

  it("lens contacts prints the device's Mac contacts' view; on makes its account once; off removes; each logs mac_contacts_switched, off with the count", async () => {
    const db = await database();
    const env = ownerEnv(db);
    expect(await pi(["lens", "contacts", "mac"], env)).toEqual({ exit: 1, stdout: "", stderr: failed("not_found") });
    expect((await pi(["lens", "add", "mac"], env, { tty: true })).exit).toBe(0);
    expect(await pi(["lens", "contacts", "mac"], env)).toEqual({
      exit: 0,
      stdout: `${JSON.stringify({ device: "mac", on: false, stored: 0, dropped: {} })}\n`,
      stderr: "",
    });
    const on = await pi(["lens", "contacts", "mac", "on"], env);
    expect(on).toEqual({
      exit: 0,
      stdout: `${JSON.stringify({ device: "mac", on: true, stored: 0, dropped: {} })}\n`,
      stderr: `${JSON.stringify({ event: "mac_contacts_switched", code: "on" })}\n`,
    });
    expect((await pi(["lens", "contacts", "mac", "on"], env)).exit).toBe(0);
    expect(
      await admin(
        db,
        "select label, source_kind, compartments from vault.source_accounts where connector = 'lens_contacts'",
      ),
    ).toEqual([{ label: "device:mac", source_kind: "crm", compartments: ["own"] }]);
    const off = await pi(["lens", "contacts", "mac", "off"], env);
    expect(off).toEqual({
      exit: 0,
      stdout: `${JSON.stringify({ device: "mac", on: false, stored: 0, dropped: {} })}\n`,
      stderr: `${JSON.stringify({ event: "mac_contacts_switched", counts: { removed: 0 }, code: "off" })}\n`,
    });
    const listed = LensDeviceView.array().parse(JSON.parse((await pi(["lens", "list"], env)).stdout));
    expect(listed[0]?.macContacts).toEqual({ on: false, stored: 0, dropped: {} });
  });

  it("lens browsing prints the view; deny off a terminal changes nothing, on one prints the lists and sets deny only on yes; allow at once", async () => {
    const db = await database();
    const env = ownerEnv(db);
    expect(await pi(["lens", "browsing", "mac"], env)).toEqual({ exit: 1, stdout: "", stderr: failed("not_found") });
    expect((await pi(["lens", "add", "mac"], env, { tty: true })).exit).toBe(0);
    const view = (mode: string, excludes = 0, accounts = 0) =>
      `${JSON.stringify({ device: "mac", mode, excludes, accounts })}\n`;
    expect(await pi(["lens", "browsing", "mac"], env)).toEqual({ exit: 0, stdout: view("allow"), stderr: "" });
    expect(LensBrowsingView.parse(JSON.parse((await pi(["lens", "browsing", "mac"], env)).stdout))).toEqual({
      device: "mac",
      mode: "allow",
      excludes: 0,
      accounts: 0,
    });

    // The lists, with values to a terminal only.
    const added = await pi(["lens", "browsing", "exclude", "add", "bank.example.com"], env);
    expect({ exit: added.exit, stderr: added.stderr }).toEqual({ exit: 0, stderr: "" });
    const excludeId = added.stdout.trim();
    expect(await pi(["lens", "browsing", "exclude", "add", "bank.example.com"], env)).toEqual({
      exit: 1,
      stdout: "",
      stderr: failed("duplicate_name"),
    });
    expect(await pi(["lens", "browsing", "exclude", "add", "localhost"], env)).toEqual({
      exit: 1,
      stdout: "",
      stderr: failed("invalid_argument"),
    });
    const listed = await pi(["lens", "browsing", "exclude", "list"], env);
    expect(
      CaptureExcludeView.array()
        .parse(JSON.parse(listed.stdout))
        .map((one) => one.id),
    ).toEqual([excludeId]);
    expect(listed.stdout).not.toContain("bank.example.com");
    expect(
      JSON.parse((await pi(["lens", "browsing", "exclude", "list", "--show"], env, { tty: true })).stdout),
    ).toEqual([expect.objectContaining({ id: excludeId, value: "bank.example.com" })]);
    const mapped = await pi(["lens", "browsing", "account", "add", "Owner@Example.test", "--compartment", "own"], env);
    expect(mapped.exit).toBe(0);
    expect(mapped.stdout).toMatch(/^cac_[0-9A-HJKMNP-TV-Z]{26}\n$/);
    // A scope rule naming an account with `own`, then a map of it to an employer: refused, the hint
    // naming the rule; and a scope rule of the mapped account with another compartment likewise.
    const rule = (
      await pi(
        [
          "lens",
          "scope",
          "add",
          "--host",
          "mail.google.com",
          "--account",
          "work@example.test",
          "--compartment",
          "own",
          "--kinds",
          "moment",
        ],
        env,
      )
    ).stdout.trim();
    expect(rule).toMatch(/^csr_/);
    expect(
      await pi(["lens", "browsing", "account", "add", "work@example.test", "--compartment", "employer:example"], env),
    ).toEqual({
      exit: 1,
      stdout: "",
      stderr: failed(
        "rule_conflict",
        `scope rules name the account with another compartment: ${rule}; remove them with pi lens scope remove ID (pia on the box), or map it to theirs`,
      ),
    });
    expect(
      await pi(
        [
          "lens",
          "scope",
          "add",
          "--host",
          "mail.google.com",
          "--account",
          "owner@example.test",
          "--compartment",
          "employer:example",
          "--kinds",
          "moment",
        ],
        env,
      ),
    ).toEqual({
      exit: 1,
      stdout: "",
      stderr: failed(
        "rule_conflict",
        "the account map gives the account another compartment: see pi lens browsing account list --show (pia on the box)",
      ),
    });
    expect(await pi(["lens", "browsing", "mac"], env)).toEqual({ exit: 0, stdout: view("allow", 1, 1), stderr: "" });

    // deny off a terminal: refused, nothing changed.
    expect(await pi(["lens", "browsing", "mac", "deny"], env, { input: ["yes"] })).toEqual({
      exit: 1,
      stdout: "",
      stderr: failed(
        "not_a_terminal",
        "lens browsing deny prints the exclude list and the account map and asks: run it in a terminal",
      ),
    });
    expect(await admin(db, "select browsing from policy.lens_devices")).toEqual([{ browsing: "allow" }]);
    // On a terminal, answered no: the lists are printed, and nothing changes.
    const declined = await pi(["lens", "browsing", "mac", "deny"], env, { tty: true, input: ["no"] });
    expect(declined.exit).toBe(0);
    for (const shown of [
      excludeId,
      "bank.example.com",
      "owner@example.test",
      "own",
      "login",
      "claude.ai",
      "the box's own host",
      "apps, moments and meetings stay on the allow-list",
    ])
      expect(declined.stdout, shown).toContain(shown);
    expect(declined.stdout.endsWith(view("allow", 1, 1))).toBe(true);
    expect(await admin(db, "select browsing from policy.lens_devices")).toEqual([{ browsing: "allow" }]);
    // Answered yes: deny. Then allow, at once, with no question.
    const accepted = await pi(["lens", "browsing", "mac", "deny"], env, { tty: true, input: ["yes"] });
    expect({ exit: accepted.exit, stderr: accepted.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(accepted.stdout.endsWith(view("deny", 1, 1))).toBe(true);
    expect(await pi(["lens", "browsing", "mac", "allow"], env)).toEqual({
      exit: 0,
      stdout: view("allow", 1, 1),
      stderr: "",
    });
    expect(await admin(db, "select browsing from policy.lens_devices")).toEqual([{ browsing: "allow" }]);
    expect((await pi(["lens", "browsing", "exclude", "remove", excludeId], env)).exit).toBe(0);
    expect(await pi(["lens", "browsing", "exclude", "remove", excludeId], env)).toEqual({
      exit: 1,
      stdout: "",
      stderr: failed("not_found"),
    });
  });

  it("status shows each device's counts and ceilings and no canary", async () => {
    const db = await database();
    const env = ownerEnv(db);
    expect((await pi(["lens", "add", "mac"], env, { tty: true })).exit).toBe(0);
    const [capture] = await admin<{ id: string }>(db, "select id from policy.clients where name = 'mac-capture'");
    const [meetings] = await admin<{ id: string }>(
      db,
      "select id from vault.source_accounts where label = 'device:mac' and connector = 'lens_meetings'",
    );
    await seed(db, capture?.id ?? "", meetings?.id ?? "");

    const status = await pi(["status"], { ...env, PI_CAPTURE_STORAGE_CEILING_BYTES: "1000000000" });
    expect({ exit: status.exit, stderr: status.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(status.stdout.trimEnd().split("\n")).toHaveLength(1);
    const view = JSON.parse(status.stdout) as {
      keyCheck: string;
      drive: { databaseBytes: number; ceilingBytes: number };
      capture: { databaseBytes: number; ceilingBytes: number };
      devices: unknown[];
    };
    // The device's accounts have no address, and the key check passes.
    expect(view.keyCheck).toBe("ok");
    expect(view.capture).toEqual({ databaseBytes: view.drive.databaseBytes, ceilingBytes: 1_000_000_000, alarm: "ok" });
    expect(view.drive.ceilingBytes).toBe(3 * 1024 * 1024 * 1024);
    expect(view.devices.map((one) => LensDeviceView.parse(one))).toEqual([
      expect.objectContaining({
        name: "mac",
        status: "active",
        inbox: { waiting: 1, forgetsWaiting: 1, refused: {}, dropped: { recovery: 1 } },
        blankedSegments: 2,
      }),
    ]);
    for (const canary of [CANARY_TITLE, CANARY_HOST, "canary-lens-words"]) expect(status.stdout).not.toContain(canary);
    // A ceiling that is no whole number is the usage error sync answers.
    expect((await pi(["status"], { ...env, PI_CAPTURE_STORAGE_CEILING_BYTES: "lots" })).exit).toBe(2);

    // Past 70 percent status logs `capture_storage` with the code and says so in `capture.alarm`;
    // --storage prints the code alone, as the box's timer reads it.
    const bytes = view.drive.databaseBytes;
    const near = String(Math.ceil(bytes / 0.75));
    const warned = await pi(["status"], { ...env, PI_CAPTURE_STORAGE_CEILING_BYTES: near });
    expect(warned.exit).toBe(0);
    expect((JSON.parse(warned.stdout) as { capture: { alarm: string } }).capture.alarm).toBe("warn_70");
    expect(warned.stderr).toBe(`${JSON.stringify({ event: "capture_storage", code: "warn_70" })}\n`);
    const levels: [string, string][] = [
      ["1000000000000", "ok"],
      [near, "warn_70"],
      [String(Math.ceil(bytes / 0.9)), "warn_85"],
      ["1", "ceiling"],
    ];
    for (const [ceiling, code] of levels) {
      expect(await pi(["status", "--storage"], { ...env, PI_CAPTURE_STORAGE_CEILING_BYTES: ceiling })).toEqual({
        exit: 0,
        stdout: `${code}\n`,
        stderr: "",
      });
    }
  });
});

const CANARY_TITLE = "canary-lens-status-title";
const CANARY_HOST = "canary-lens-status.example.test";
const onlyRule = async (db: TestDatabase): Promise<string> =>
  (await admin<{ id: string }>(db, "select id from policy.capture_scope")).map((row) => row.id).join(",");
const ulid = (n: number): string => `01JABCDEFGHJKMNPQRSTVWX${String(n).padStart(3, "0")}`;

// The device's inbox as push and drain leave it (one waiting, a forget waiting, one dropped),
// and one stored meeting with two blanked segments, its title and host sealed.
async function seed(db: TestDatabase, client: string, account: string): Promise<void> {
  // As pi_owner, which alone inserts these rows (by policy.push_capture): `set role` and the
  // statement in one simple query, so every value is a literal of a fixed form.
  const owner = (text: string): Promise<unknown> => queryAs(db.urls.bootstrap, `set role pi_owner; ${text}`);
  const session = `ses_${ulid(1)}`;
  await owner(`insert into ledger.sessions (id, client_id, compartments) values ('${session}', '${client}', '{own}')`);
  const rows: [string, string, string][] = [
    ["moment", "'{}'::jsonb", "null"],
    ["forget", "'{}'::jsonb", "null"],
    ["moment", "null", "'recovery'"],
  ];
  for (const [n, [kind, body, code]] of rows.entries()) {
    const key = sha256(`key ${n}`);
    await owner(
      `insert into ledger.capture_inbox (id, client_id, session_id, batch, source_key_fp, revision, kind, content_fp, body_bytes, compartments, body_enc, refused_code)
       values ('cin_${ulid(n + 1)}', '${client}', '${session}', 'batch-status-1', '${key}', 0, '${kind}', '${key}', 10, '{own}', ${body}, ${code})`,
    );
  }
  const evidenceId = sha256("lens status meeting");
  const blob = `blb_${ulid(1)}`;
  const id = `cap_${ulid(1)}`;
  const sealed = (table: string, row: string, column: string, value: string): string =>
    JSON.stringify(sealRow(db.keys, "own", { table, id: row, column }, value));
  const facts = JSON.stringify({
    kind: "meeting",
    title: CANARY_TITLE,
    host: CANARY_HOST,
    counts: { segments: 3, chars: 30, minutes: 20, blanked: 2 },
  });
  await admin(
    db,
    "insert into vault.evidence_blobs (blob_ref, envelope, compartments) values ($1, $2::jsonb, '{own}')",
    [blob, sealed("vault.evidence_blobs", blob, "envelope", Buffer.from("canary-lens-words").toString("base64"))],
  );
  await admin(
    db,
    `insert into vault.evidence_items (id, source_account_id, source_kind, source_item_fp, revision_tag_fp, revision, next_revision_id, content_hash, media_type,
       observed_at, change_kind, participant_members, system_originated, answers_system, payload_state, compartments, readers, blob_ref, item_enc)
     values ($1, $2, 'transcript', $3, $4, 0, $5, $6, 'application/json', '2026-10-07T09:00:00Z', 'live', '{m-owner}', false, false, 'present', '{own}', '{m-owner}', $7, $8::jsonb)`,
    [
      evidenceId,
      account,
      fingerprint(db.keys, "source_id", "lens-status"),
      fingerprint(db.keys, "revision_tag", "h:lens-status"),
      `${evidenceId}:1`,
      sha256("content"),
      blob,
      sealed("vault.evidence_items", evidenceId, "item_enc", facts),
    ],
  );
  await admin(
    db,
    `insert into knowledge.captures (id, evidence_id, source_account_id, capture_key, revision, kind, started_at, ended_at, first_pushed_at, local_day, facts_enc, compartments)
     values ($1, $2, $3, $4, 0, 'meeting', '2026-10-07T09:00:00Z', '2026-10-07T09:20:00Z', '2026-10-07T09:30:00Z', '2026-10-07', $5::jsonb, '{own}')`,
    [id, evidenceId, account, `meeting:${ulid(1)}`, sealed("knowledge.captures", id, "facts_enc", facts)],
  );
}
