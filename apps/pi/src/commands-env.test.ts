// Covers commands.ts and env.ts, the `pi` command line, through the commands of one area.
// Roles' database URLs, keys, secrets and the environment each command checks before any connection.
import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { run } from "./commands.ts";
import {
  ADMIN,
  BOOTSTRAP,
  ENTITY,
  expectRefused,
  expectUnavailable,
  failed,
  failureLines,
  folder,
  KEYS,
  MESSAGE,
  MODEL,
  OWNER_COMMANDS,
  PIPELINE,
  PIPELINE_COMMANDS,
  PROXY,
  pi,
  READER,
  REAL,
  RESTRICTED,
  RESTRICTED_KEYS,
  request,
  url,
  useRealKeyFile,
  WORK,
  WRITER,
} from "./test-support/commands-fixtures.ts";

useRealKeyFile();

describe("pi", () => {
  it("pi mcp refuses the bootstrap, admin or writer URL, or a Google client secret", async () => {
    // A reader handed another role's URL would read with that role's rights, and this check is
    // the only guard: it refuses before the key file is read or any connection is made.
    for (const extra of [BOOTSTRAP, ADMIN, WRITER, { PI_GOOGLE_CLIENT_SECRET: "sentinel-client-secret" }]) {
      for (const keys of [KEYS, REAL]) {
        const result = await pi(
          ["mcp"],
          { ...READER, ...keys, PI_CLIENT_TOKEN: "sentinel-token-7f3a91", ...extra },
          { stdin: [request(1, "tools/list")] },
        );
        expect(result).toEqual({ exit: 1, stdout: "", stderr: failed("wrong_role_url") });
      }
    }

    // The positive control: with the reader URL alone it starts and serves. The port is closed,
    // so a request that needs the database answers -32603 on stdout.
    const served = await pi(
      ["mcp"],
      { ...READER, ...REAL, PI_CLIENT_TOKEN: "sentinel-token-7f3a91" },
      { stdin: [request(1, "tools/list"), request(2, "ping")] },
    );
    expect(served.exit).toBe(0);
    expect(
      served.stdout
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual([
      { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "unavailable" } },
      { jsonrpc: "2.0", id: 2, result: {} },
    ]);
    expect(served.stderr).not.toContain("sentinel-token-7f3a91");
    failureLines(served.stderr);

    // With no token it still starts, and answers unauthorized without asking the database.
    const anonymous = await pi(["mcp"], { ...READER, ...REAL }, { stdin: [request(1, "tools/list")] });
    expect(anonymous).toMatchObject({
      exit: 0,
      stdout: `${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "unauthorized" } })}\n`,
    });
  });

  it("pi org refold refuses the bootstrap, admin or reader URL, and takes no argument", async () => {
    for (const extra of [BOOTSTRAP, ADMIN, READER]) {
      await expectRefused(["org", "refold", "--dry-run"], { ...WRITER, ...KEYS, ...extra }, "wrong_role_url");
    }
    await expectRefused(["org", "refold", ENTITY], { ...WRITER, ...REAL }, "usage", 2);
    // The positive control: the writer URL alone passes the check, with and without the dry run.
    await expectUnavailable(["org", "refold", "--dry-run"], { ...WRITER, ...REAL });
    await expectUnavailable(["org", "refold"], { ...WRITER, ...REAL });
  });

  // Contact import: the file is taken in as the writer, from stdin.
  it("pi import contacts refuses another role's URL, a bad adapter, name or mapping, and a file that reads as nothing", async () => {
    const file = [
      "First Name,Last Name,URL,Email Address,Company,Position,Connected On\r\nIvo,Brandt,,ivo@commands-import.test,,,\r\n",
    ];
    const args = ["import", "contacts", "--adapter", "linkedin-connections", "--name", "linkedin"];
    for (const extra of [BOOTSTRAP, ADMIN, READER])
      await expectRefused(args, { ...WRITER, ...KEYS, ...extra }, "wrong_role_url", 1, { stdin: file });
    await expectRefused(
      ["import", "contacts", "--adapter", "vcard", "--name", "linkedin"],
      { ...WRITER, ...REAL },
      "usage",
      2,
      { stdin: file },
    );
    await expectRefused(
      ["import", "contacts", "--adapter", "linkedin-connections", "--name", "Linked In"],
      { ...WRITER, ...REAL },
      "usage",
      2,
      { stdin: file },
    );
    await expectRefused([...args, "--map", join(folder, "none.json")], { ...WRITER, ...REAL }, "usage", 2, {
      stdin: file,
    });
    await expectRefused(
      ["import", "contacts", "--adapter", "mapped-csv", "--name", "sheet"],
      { ...WRITER, ...REAL },
      "usage",
      2,
      { stdin: file },
    );
    await expectRefused(
      ["import", "contacts", "--adapter", "mapped-csv", "--name", "sheet", "--map", join(folder, "none.json")],
      { ...WRITER, ...REAL },
      "bad_mapping",
      1,
      {
        stdin: file,
        hint: "the mapping is not a contact mapping as the contact import spec gives it",
      },
    );
    await expectRefused(args, { ...WRITER, ...REAL }, "no_header", 1, {
      stdin: ["Name\r\nIvo\r\n"],
      hint: "no row of the file holds the mapping's name columns",
    });
    await expectRefused(args, { ...WRITER, ...REAL }, "bad_csv", 1, { stdin: ['First Name\r\n"Ivo'] });
    // Bytes that are not UTF-8 are refused, never stored as replacement characters.
    await expectRefused(args, { ...WRITER, ...REAL }, "bad_encoding", 1, {
      stdin: [Buffer.from([0x4e, 0x61, 0xff, 0x6d, 0x65]) as unknown as string],
      hint: "the file is not UTF-8: export it again as UTF-8",
    });
    await expectRefused(args, { ...WRITER, ...REAL }, "missing_column", 1, {
      stdin: ["First Name,Last Name,URL,E-mail\r\nIvo,Brandt,,ivo@commands-import.test\r\n"],
      hint: "a row holds the name columns but not every address column the mapping names: check its spelling",
    });
    await expectRefused(args, { ...WRITER, ...REAL }, "no_rows", 1, {
      stdin: ["First Name,Last Name,Email Address\r\n"],
      hint: "the file reads as no contact; to remove an import, run pi import remove NAME (pia on the box)",
    });
    // The positive control: a file that reads, with the writer URL alone, reaches the database.
    const result = await pi(args, { ...WRITER, ...REAL }, { stdin: file });
    expect({ exit: result.exit, stdout: result.stdout, last: failureLines(result.stderr).at(-1) }).toEqual({
      exit: 1,
      stdout: "",
      last: { event: "command_failed", code: "unavailable" },
    });
  });

  it("pi sync refuses the bootstrap, admin or reader URL", async () => {
    for (const extra of [BOOTSTRAP, ADMIN, READER]) {
      await expectRefused(["sync"], { ...WRITER, ...KEYS, ...extra }, "wrong_role_url");
    }
    // The positive control: the writer URL alone passes the check.
    await expectUnavailable(["sync"], { ...WRITER, ...REAL });
  });

  // The positive control, a tick that reaches its body, is in tick.db.test.ts.
  it("pi work tick refuses a key file, or the admin, writer, reader or pipeline URL", async () => {
    const work = { PI_DATABASE_URL_WORK: url("pi_work"), PI_ERASURE_JOURNAL: "/nonexistent/pi/erasures.jsonl" };
    for (const extra of [KEYS, BOOTSTRAP, ADMIN, WRITER, READER, { PI_DATABASE_URL_PIPELINE: url("pi_pipeline") }]) {
      await expectRefused(["work", "tick"], { ...work, ...extra }, "wrong_role_url");
    }
    await expectRefused(["work", "tick"], { PI_DATABASE_URL_WORK: url("pi_work") }, "missing_env", 1, {
      hint: "set PI_ERASURE_JOURNAL",
    });
  });

  it("an owner command refuses the bootstrap, writer or reader URL", async () => {
    const google = { PI_GOOGLE_CLIENT_ID: "sentinel-client-id", PI_GOOGLE_CLIENT_SECRET: "sentinel-client-secret" };
    for (const argv of OWNER_COMMANDS) {
      for (const extra of [BOOTSTRAP, WRITER, READER]) {
        await expectRefused(argv, { ...ADMIN, ...KEYS, ...google, ...extra }, "wrong_role_url", 1, { tty: true });
      }
      // The positive control: the admin URL alone passes the check.
      await expectUnavailable(argv, { ...ADMIN, ...REAL, ...google }, { tty: true });
    }
  });

  it("every command but pi extract refuses the pipeline URL", async () => {
    const google = { PI_GOOGLE_CLIENT_ID: "sentinel-client-id", PI_GOOGLE_CLIENT_SECRET: "sentinel-client-secret" };
    await expectRefused(
      ["mcp"],
      { ...READER, ...KEYS, PI_CLIENT_TOKEN: "sentinel-token-7f3a91", ...PIPELINE },
      "wrong_role_url",
    );
    await expectRefused(["sync"], { ...WRITER, ...KEYS, ...PIPELINE }, "wrong_role_url");
    for (const argv of OWNER_COMMANDS)
      await expectRefused(argv, { ...ADMIN, ...KEYS, ...google, ...PIPELINE }, "wrong_role_url", 1, { tty: true });
    // The positive control: db migrate holds the pipeline URL by design, and the same
    // environment without it reaches the body.
    await expectUnavailable(["sync"], { ...WRITER, ...REAL });
  });

  it("keys init, keys add-compartment and db migrate refuse no database URL", async () => {
    // With every URL set and a required variable missing, the refusal is the missing variable.
    const all = { ...BOOTSTRAP, ...ADMIN, ...WRITER, ...READER };
    await expectRefused(["keys", "init"], all, "missing_env", 1, { hint: "set PI_KEY_FILE" });
    await expectRefused(["keys", "add-compartment", "employer:example"], all, "missing_env", 1, {
      hint: "set PI_KEY_FILE",
    });
    await expectRefused(["db", "migrate"], { ...BOOTSTRAP, ...ADMIN, ...WRITER }, "missing_env", 1, {
      hint: "set PI_DATABASE_URL_READER",
    });
  });

  it("db migrate without the pipeline URL refuses to start", async () => {
    await expectRefused(["db", "migrate"], { ...BOOTSTRAP, ...ADMIN, ...WRITER, ...READER }, "missing_env", 1, {
      hint: "set PI_DATABASE_URL_PIPELINE",
    });
    // The positive control: with it, the command goes on to the closed port.
    await expectUnavailable(["db", "migrate"], {
      ...BOOTSTRAP,
      ...ADMIN,
      ...WRITER,
      ...READER,
      ...PIPELINE,
      ...WORK,
      ...RESTRICTED,
    });
  });

  it("db migrate without the work URL refuses to start", async () => {
    await expectRefused(
      ["db", "migrate"],
      { ...BOOTSTRAP, ...ADMIN, ...WRITER, ...READER, ...PIPELINE },
      "missing_env",
      1,
      { hint: "set PI_DATABASE_URL_WORK" },
    );
    // The positive control: with it, the command goes on to the closed port.
    await expectUnavailable(["db", "migrate"], {
      ...BOOTSTRAP,
      ...ADMIN,
      ...WRITER,
      ...READER,
      ...PIPELINE,
      ...WORK,
      ...RESTRICTED,
    });
  });

  it("db migrate --auto takes the URLs db migrate takes and no other option, and db pending is the admin role's", async () => {
    const all = { ...BOOTSTRAP, ...ADMIN, ...WRITER, ...READER, ...PIPELINE, ...WORK, ...RESTRICTED };
    await expectRefused(["db", "migrate", "--auto"], { ...BOOTSTRAP, ...ADMIN, ...WRITER }, "missing_env", 1, {
      hint: "set PI_DATABASE_URL_READER",
    });
    await expectUnavailable(["db", "migrate", "--auto"], all);
    await expectRefused(["db", "migrate", "--force"], all, "usage", 2);
    await expectRefused(["db", "migrate", "--auto", "now"], all, "usage", 2);
    await expectRefused(["db", "pending"], { ...KEYS }, "missing_env", 1, { hint: "set PI_DATABASE_URL_ADMIN" });
    await expectRefused(["db", "pending"], { ...ADMIN, ...KEYS, ...BOOTSTRAP }, "wrong_role_url", 1);
    await expectUnavailable(["db", "pending"], { ...ADMIN, ...KEYS });
  });

  it("db migrate without the restricted URL goes on, since that password is the owner's to set", async () => {
    // Setting PI_DATABASE_URL_RESTRICTED is a credential only the owner makes, so a deploy with a
    // migration never waits on it: the role is made with no password and cannot log in. The
    // other roles' URLs are still required.
    const without = { ...BOOTSTRAP, ...ADMIN, ...WRITER, ...READER, ...PIPELINE, ...WORK };
    await expectUnavailable(["db", "migrate"], without);
    await expectUnavailable(["db", "migrate"], { ...without, PI_DATABASE_URL_RESTRICTED: "" });
    await expectRefused(
      ["db", "migrate"],
      { ...BOOTSTRAP, ...ADMIN, ...WRITER, ...READER, ...PIPELINE },
      "missing_env",
      1,
      { hint: "set PI_DATABASE_URL_WORK" },
    );
    // Set, it is still checked: one that names no password is refused, as any role's URL is.
    await expectRefused(
      ["db", "migrate"],
      { ...without, PI_DATABASE_URL_RESTRICTED: "postgres://pi_restricted@127.0.0.1:1/pi_test" },
      "bad_url",
    );
    await expectRefused(
      ["db", "migrate"],
      { ...without, PI_DATABASE_URL_RESTRICTED: "https://pi_restricted:sentinel-7f3a91@db.example.com/pi" },
      "bad_url",
    );
    // The positive control: with a good one, the command goes on to the closed port.
    await expectUnavailable(["db", "migrate"], { ...without, ...RESTRICTED });
  });

  it("db migrate refuses a pipeline URL that names no password", async () => {
    await expectRefused(
      ["db", "migrate"],
      {
        ...BOOTSTRAP,
        ...ADMIN,
        ...WRITER,
        ...READER,
        ...WORK,
        ...RESTRICTED,
        PI_DATABASE_URL_PIPELINE: "postgres://pi_pipeline@127.0.0.1:1/pi_test",
      },
      "bad_url",
    );
    await expectUnavailable(["db", "migrate"], {
      ...BOOTSTRAP,
      ...ADMIN,
      ...WRITER,
      ...READER,
      ...PIPELINE,
      ...WORK,
      ...RESTRICTED,
    });
  });

  it("a command refuses to start without a variable it requires", async () => {
    // The hint names the first required variable that is unset, and never a value.
    await expectRefused(["mcp"], READER, "missing_env", 1, { hint: "set PI_KEY_FILE" });
    await expectRefused(["mcp"], KEYS, "missing_env", 1, { hint: "set PI_DATABASE_URL_READER" });
    await expectRefused(["sync"], KEYS, "missing_env", 1, { hint: "set PI_DATABASE_URL_WRITER" });
    await expectRefused(["sync"], {}, "missing_env", 1, { hint: "set PI_DATABASE_URL_WRITER" });
    await expectRefused(["status"], { ...ADMIN, PI_KEY_FILE: "" }, "missing_env", 1, { hint: "set PI_KEY_FILE" });
    await expectRefused(
      ["google", "connect", "--account", "personal"],
      { ...ADMIN, ...KEYS, PI_GOOGLE_CLIENT_ID: "sentinel-client-id" },
      "missing_env",
      1,
      {
        hint: "set PI_GOOGLE_CLIENT_SECRET",
      },
    );
  });

  it("a secret given as an argument is refused", async () => {
    const value = "sentinel-7f3a91";
    const secrets: string[][] = [
      [`pit_${value}`],
      [`postgres://pi_admin:${value}@db.example.com:5432/pi`],
      ["--token", value],
      [`--token=${value}`],
      ["--password", value],
      [`--secret=${value}`],
      ["--refresh-token", value],
      [`--retention=pit_${value}`],
    ];
    for (const secret of secrets) {
      // A command that would otherwise parse, and one that would otherwise be a usage error:
      // the secret is refused first in both, and its value is on neither stream.
      for (const argv of [
        ["clients", "revoke", "mine"],
        ["clients", "add", "mine", "--bogus"],
        ["frobnicate"],
        ["--help"],
      ]) {
        const result = await pi([...argv, ...secret], { ...ADMIN, ...KEYS });
        expect(result, argv.join(" ")).toEqual({ exit: 1, stdout: "", stderr: failed("secret_in_argument") });
        expect(result.stderr).not.toContain(value);
      }
    }
    // The positive control: the same arguments with no secret among them pass the check, and
    // are refused by the parser instead.
    for (const plain of [["pita"], ["https://db.example.com:5432/pi"], ["--tokens", value], ["owner@example.com"]]) {
      await expectRefused(["clients", "add", "mine", "--bogus", ...plain], { ...ADMIN, ...KEYS }, "usage", 2);
    }
  });

  it("pi extract refuses the bootstrap, admin, writer or reader URL", async () => {
    for (const argv of PIPELINE_COMMANDS) {
      for (const extra of [BOOTSTRAP, ADMIN, WRITER, READER]) {
        for (const keys of [KEYS, REAL])
          await expectRefused(argv, { ...PIPELINE, ...keys, ...MODEL, ...extra }, "wrong_role_url");
      }
      // The positive control: the pipeline URL alone passes the check, and the command goes on
      // to the closed port.
      await expectUnavailable(argv, { ...PIPELINE, ...REAL, ...MODEL });
    }
  });

  it("pi extract age needs no model setting, refuses another role's URL and the model key, and goes on to the closed port", async () => {
    for (const extra of [BOOTSTRAP, ADMIN, WRITER, READER])
      await expectRefused(["extract", "age"], { ...PIPELINE, ...REAL, ...extra }, "wrong_role_url");
    await expectRefused(
      ["extract", "age"],
      { ...PIPELINE, ...REAL, PI_OPENROUTER_KEY: "sentinel-key-7f3a91" },
      "wrong_role_url",
    );
    await expectRefused(["extract", "age"], { ...REAL }, "missing_env", 1, { hint: "set PI_DATABASE_URL_PIPELINE" });
    // The positive control: the pipeline URL and the key file alone, with no PI_EXTRACT_MODEL.
    await expectUnavailable(["extract", "age"], { ...PIPELINE, ...REAL });
  });

  it("pi mcp and pi sync refuse the pipeline URL", async () => {
    // So does every owner command. A process that holds the pipeline's URL could read the model key
    // and write claims.
    await expectRefused(["mcp"], { ...READER, ...REAL, ...PIPELINE }, "wrong_role_url");
    await expectRefused(["sync"], { ...WRITER, ...REAL, ...PIPELINE }, "wrong_role_url");
    const google = { PI_GOOGLE_CLIENT_ID: "sentinel-client-id", PI_GOOGLE_CLIENT_SECRET: "sentinel-client-secret" };
    for (const argv of OWNER_COMMANDS)
      await expectRefused(argv, { ...ADMIN, ...REAL, ...google, ...PIPELINE }, "wrong_role_url", 1, { tty: true });
    await expectRefused(["models", "set-key"], { ...ADMIN, ...REAL, ...PIPELINE }, "wrong_role_url");
    // The positive controls: without it each goes on to the closed port.
    await expectUnavailable(["sync"], { ...WRITER, ...REAL });
    await expectUnavailable(["extract", "status"], { ...ADMIN, ...REAL });
  });

  // The agent API may.
  it("pi extract refuses PI_RESTRICTED_KEY_FILE", async () => {
    for (const argv of PIPELINE_COMMANDS)
      await expectRefused(argv, { ...PIPELINE, ...REAL, ...MODEL, ...RESTRICTED_KEYS }, "wrong_role_url");
    // The control: pi sync, a restricted holder, takes it and goes on to the closed port, as
    // pi extract does without it.
    await expectUnavailable(["sync"], { ...WRITER, ...REAL, ...RESTRICTED_KEYS });
    await expectUnavailable(["extract"], { ...PIPELINE, ...REAL, ...MODEL });
    const served = await pi(["mcp"], { ...READER, ...REAL, ...RESTRICTED_KEYS }, { stdin: [request(1, "ping")] });
    expect(served.exit).toBe(0);
  });

  it("every command but pi restricted extract and db migrate refuses the restricted URL", async () => {
    const google = { PI_GOOGLE_CLIENT_ID: "sentinel-client-id", PI_GOOGLE_CLIENT_SECRET: "sentinel-client-secret" };
    await expectRefused(["mcp"], { ...READER, ...REAL, ...RESTRICTED }, "wrong_role_url");
    await expectRefused(["sync"], { ...WRITER, ...REAL, ...RESTRICTED }, "wrong_role_url");
    for (const argv of PIPELINE_COMMANDS)
      await expectRefused(argv, { ...PIPELINE, ...REAL, ...MODEL, ...RESTRICTED }, "wrong_role_url");
    for (const argv of OWNER_COMMANDS)
      await expectRefused(argv, { ...ADMIN, ...REAL, ...google, ...RESTRICTED }, "wrong_role_url", 1, { tty: true });
    await expectRefused(
      ["work", "tick"],
      { ...WORK, PI_ERASURE_JOURNAL: "/nonexistent/pi/erasures.jsonl", ...RESTRICTED },
      "wrong_role_url",
    );
    await expectRefused(["send", "list"], { ...PROXY, ...REAL, ...RESTRICTED }, "wrong_role_url");
    // The positive control: without it each goes on to the closed port.
    await expectUnavailable(["sync"], { ...WRITER, ...REAL });
    await expectUnavailable(["status"], { ...ADMIN, ...REAL });
  });

  it("keys add-compartment restricted:C needs the admin URL and the restricted key file, and checks both before it writes", async () => {
    const add = ["keys", "add-compartment", "restricted:health"];
    await expectRefused(add, { ...REAL, ...RESTRICTED_KEYS }, "missing_env", 1, { hint: "set PI_DATABASE_URL_ADMIN" });
    await expectRefused(
      add,
      { ...REAL, ...RESTRICTED_KEYS, PI_DATABASE_URL_ADMIN: "postgres://pi_admin@127.0.0.1:1/pi_test" },
      "bad_url",
    );
    await expectRefused(add, { ...REAL, ...ADMIN }, "restricted_key_file_unset", 1, {
      hint: "set PI_RESTRICTED_KEY_FILE",
    });
    await expectRefused(
      ["keys", "add-compartment", "restricted:other"],
      { ...REAL, ...ADMIN, ...RESTRICTED_KEYS },
      "usage",
      2,
    );
    // A restricted file in a folder that is not there is refused as the key file is, and the
    // general file never takes the key.
    await expectRefused(add, { ...REAL, ...ADMIN, ...RESTRICTED_KEYS }, "key_file_refused");
    const generalKeys = async (): Promise<string[]> =>
      Object.keys(
        (JSON.parse(await readFile(REAL.PI_KEY_FILE ?? "", "utf8")) as { compartments: object }).compartments,
      );
    expect(await generalKeys()).toEqual(["own", "employer:example"]);
    // The positive control: with a restricted file it can write, the key is written there and
    // the row goes on to the closed port.
    const restrictedFile = join(folder, "restricted-keys.json");
    await expectUnavailable(add, { ...REAL, ...ADMIN, PI_RESTRICTED_KEY_FILE: restrictedFile });
    expect(
      Object.keys((JSON.parse(await readFile(restrictedFile, "utf8")) as { compartments: object }).compartments),
    ).toEqual(["restricted:health"]);
    expect(await generalKeys()).toEqual(["own", "employer:example"]);
  });

  it("keys add-compartment restricted:C makes the admin role's checks, since it writes as pi_admin", async () => {
    const add = ["keys", "add-compartment", "restricted:money"];
    const restrictedFile = join(folder, "money-keys.json");
    for (const extra of [
      BOOTSTRAP,
      WRITER,
      READER,
      PIPELINE,
      RESTRICTED,
      { PI_CLIENT_TOKEN: "sentinel-token-7f3a91" },
    ]) {
      await expectRefused(
        add,
        { ...REAL, ...ADMIN, PI_RESTRICTED_KEY_FILE: restrictedFile, ...extra },
        "wrong_role_url",
      );
    }
    // Nothing was written: the checks come before the key.
    await expect(readFile(restrictedFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    // A lock left on the restricted file is named in the hint, not the key file's.
    await writeFile(`${restrictedFile}.lock`, "");
    await expectRefused(add, { ...REAL, ...ADMIN, PI_RESTRICTED_KEY_FILE: restrictedFile }, "key_file_refused", 1, {
      hint: `remove ${restrictedFile}.lock if no add is running`,
    });
    await rm(`${restrictedFile}.lock`);
    // The positive control: the same environment goes on to the closed port.
    await expectUnavailable(add, { ...REAL, ...ADMIN, PI_RESTRICTED_KEY_FILE: restrictedFile });
  });

  it("pi restricted lift is a stub, behind the owner's checks", async () => {
    const lift = ["restricted", "lift", "--message", MESSAGE, "--category", "health"];
    for (const extra of [BOOTSTRAP, WRITER, READER, PIPELINE, RESTRICTED])
      await expectRefused(lift, { ...ADMIN, ...REAL, ...extra }, "wrong_role_url");
    await expectRefused(lift, { ...ADMIN, ...REAL }, "not_built");
  });

  it("pi extract without a model refuses to start", async () => {
    // The model id is the owner's configuration, and none is in code: without it no run starts.
    for (const argv of PIPELINE_COMMANDS) {
      await expectRefused(argv, { ...PIPELINE, ...REAL }, "missing_env", 1, { hint: "set PI_EXTRACT_MODEL" });
      await expectRefused(argv, { ...PIPELINE, ...REAL, PI_EXTRACT_MODEL: "" }, "missing_env", 1, {
        hint: "set PI_EXTRACT_MODEL",
      });
      await expectRefused(argv, { ...REAL, ...MODEL }, "missing_env", 1, { hint: "set PI_DATABASE_URL_PIPELINE" });
    }
  });

  it("jev-item-decisions: PI_DECIDE_MODEL other than typesafe/jev-1.13 makes extract and extract check refuse with bad_env, before any connection", async () => {
    for (const argv of PIPELINE_COMMANDS) {
      for (const value of ["~typesafe/jev-latest", "typesafe/jev-1.12", "openai/gpt-6-luna"]) {
        await expectRefused(argv, { ...PIPELINE, ...REAL, ...MODEL, PI_DECIDE_MODEL: value }, "bad_env", 1);
      }
      // The positive controls: the pinned id, and unset, go on to the closed port.
      await expectUnavailable(argv, { ...PIPELINE, ...REAL, ...MODEL, PI_DECIDE_MODEL: "typesafe/jev-1.13" });
      await expectUnavailable(argv, { ...PIPELINE, ...REAL, ...MODEL, PI_DECIDE_MODEL: "" });
    }
  });

  it("jev-calibration: identity sweep refuses a PI_DECIDE_MODEL other than Jev's with bad_env, and PI_IDENTITY_MAX_CALLS outside 1 to 500 with usage, before any connection", async () => {
    const argv = ["identity", "sweep"];
    await expectRefused(argv, { ...ADMIN, ...REAL, PI_DECIDE_MODEL: "typesafe/jev-1.12" }, "bad_env", 1);
    for (const value of ["0", "501", "5.5", "-1", "fifty"])
      await expectRefused(argv, { ...ADMIN, ...REAL, PI_IDENTITY_MAX_CALLS: value }, "usage", 2);
    // The positive controls go on to the closed port.
    for (const value of ["1", "500", ""])
      await expectUnavailable(argv, {
        ...ADMIN,
        ...REAL,
        PI_IDENTITY_MAX_CALLS: value,
        PI_DECIDE_MODEL: "typesafe/jev-1.13",
      });
  });

  it("PI_EXTRACT_MODEL off the exposure record's model id form makes extract and extract check refuse with bad_env, before any connection", async () => {
    for (const argv of PIPELINE_COMMANDS) {
      for (const value of ["Example/Model", "~openai/gpt-6-luna", "no-slash", `example/${"m".repeat(100)}`]) {
        await expectRefused(argv, { ...PIPELINE, ...REAL, PI_EXTRACT_MODEL: value }, "bad_env", 1);
      }
      // The positive control goes on to the closed port.
      await expectUnavailable(argv, { ...PIPELINE, ...REAL, PI_EXTRACT_MODEL: "openai/gpt-6-luna:beta" });
    }
  });

  it("a key given as an argument is refused", async () => {
    const value = "sentinel-7f3a91";
    for (const secret of [
      [`sk-or-v1-${value}`],
      ["--key", value],
      [`--key=${value}`],
      ["--api-key", value],
      [`--max-calls=sk-or-v1-${value}`],
    ]) {
      for (const argv of [["models", "set-key"], ["extract"], ["extract", "check"]]) {
        const result = await pi([...argv, ...secret], { ...ADMIN, ...PIPELINE, ...KEYS, ...MODEL });
        expect(result, argv.join(" ")).toEqual({ exit: 1, stdout: "", stderr: failed("secret_in_argument") });
      }
    }
    // The positive control: an argument that only looks like one is refused by the parser.
    await expectRefused(["models", "set-key", "sk-other"], { ...ADMIN, ...KEYS }, "usage", 2);
    await expectRefused(["models", "set-key", "--keys", value], { ...ADMIN, ...KEYS }, "usage", 2);
  });

  it("pi db verifier prints one SCRAM-SHA-256 verifier of the password on stdin, and nothing else", async () => {
    // No role URL and no key file: it opens no connection and reads no key.
    const password = "sentinel-proxy-password-7f3a91";
    const result = await pi(["db", "verifier"], {}, { stdin: [`${password}\n`] });
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(password);
    const match = /^SCRAM-SHA-256\$4096:([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)\n$/.exec(result.stdout);
    expect(match, result.stdout).not.toBeNull();
    // The verifier ensureRoles would have set for that password, under the salt it chose.
    const [, salt, storedKey, serverKey] = match as unknown as [string, string, string, string];
    const salted = pbkdf2Sync(password, Buffer.from(salt, "base64"), 4096, 32, "sha256");
    const hmac = (key: Buffer, text: string): Buffer => createHmac("sha256", key).update(text, "utf8").digest();
    expect(createHash("sha256").update(hmac(salted, "Client Key")).digest().toString("base64")).toBe(storedKey);
    expect(hmac(salted, "Server Key").toString("base64")).toBe(serverKey);

    // One line feed that ends the input is taken off, and nothing else: without it the same
    // password gives a verifier of the same password.
    const bare = await pi(["db", "verifier"], {}, { stdin: [password] });
    const [, bareSalt, bareStored] = /^SCRAM-SHA-256\$4096:([^$]+)\$([^:]+):/.exec(bare.stdout) as unknown as [
      string,
      string,
      string,
    ];
    const bareSalted = pbkdf2Sync(password, Buffer.from(bareSalt, "base64"), 4096, 32, "sha256");
    expect(createHash("sha256").update(hmac(bareSalted, "Client Key")).digest().toString("base64")).toBe(bareStored);
  });

  it("pi db verifier refuses a terminal on stdin, and an empty password", async () => {
    const terminal = Object.assign(Readable.from([]), { isTTY: true });
    const collect = new Writable({ write: (_chunk, _encoding, done) => done() });
    const err: Buffer[] = [];
    const exit = await run(
      ["db", "verifier"],
      {},
      {
        stdout: collect,
        stderr: new Writable({
          write: (chunk: Buffer, _e, done) => {
            err.push(chunk);
            done();
          },
        }),
        stdin: terminal,
        stdoutIsTTY: true,
      },
    );
    expect({ exit, stderr: Buffer.concat(err).toString("utf8") }).toEqual({
      exit: 1,
      stderr: failed("stdin_is_terminal"),
    });
    await expectRefused(["db", "verifier"], {}, "empty_password", 1, { stdin: [] });
  });
});
