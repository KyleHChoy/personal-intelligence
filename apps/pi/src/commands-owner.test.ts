// Covers commands.ts, the `pi` command line, through the commands of one area.
// The owner's commands' arguments: each checked before any connection, and what prints to a terminal only.
import { readFile } from "node:fs/promises";
import { LIFE_DOMAINS } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import {
  ADMIN,
  ENTITY,
  expectRefused,
  expectUnavailable,
  failed,
  KEYS,
  pi,
  REAL,
  useRealKeyFile,
} from "./test-support/commands-fixtures.ts";

useRealKeyFile();

describe("pi", () => {
  // A goal the owner sets names its life domain, so it is one belief with the same goal stated in their
  // mail; without one, or with a word that is no domain, it is a usage error naming the domains,
  // before any connection.
  it("goal add requires --domain, one of the life domains", async () => {
    const usage = `pi goal add --domain ${LIFE_DOMAINS.join("|")} [--compartment C]`;
    await expectRefused(["goal", "add"], { ...ADMIN, ...REAL }, "usage", 2, {
      hint: usage,
      stdin: ["Run a half marathon this year.\n"],
    });
    await expectRefused(["goal", "add", "--domain", "hobbies"], { ...ADMIN, ...REAL }, "usage", 2, {
      hint: usage,
      stdin: ["Run a half marathon this year.\n"],
    });
    await expectUnavailable(
      ["goal", "add", "--domain", "health"],
      { ...ADMIN, ...REAL },
      { stdin: ["Run a half marathon this year.\n"] },
    );
  });

  // A goal's target by a full name; one word, an empty name, --name with --none, and a bad --entity
  // are refused before any connection.
  it("goal target --name takes a full name, alone or with --entity, and refuses one word", async () => {
    const goal = `gol_${"0".repeat(26)}`;
    const entity = `ent_${"0".repeat(26)}`;
    await expectUnavailable(["goal", "target", goal, "--name", "Theo Marsh"], { ...ADMIN, ...REAL });
    await expectUnavailable(["goal", "target", goal, "--name", "Theo Marsh", "--entity", entity], {
      ...ADMIN,
      ...REAL,
    });
    await expectRefused(["goal", "target", goal, "--name", "Theo"], { ...ADMIN, ...REAL }, "one_word_name");
    // An organization's name may be one word, and --org goes with --name alone.
    await expectUnavailable(["goal", "target", goal, "--name", "Northwind", "--org"], { ...ADMIN, ...REAL });
    await expectRefused(["goal", "target", goal, "--org", "--entity", entity], { ...ADMIN, ...REAL }, "usage", 2);
    await expectRefused(["goal", "target", goal, "--name", "  Theo  "], { ...ADMIN, ...REAL }, "one_word_name");
    await expectRefused(["goal", "target", goal, "--name", " "], { ...ADMIN, ...REAL }, "usage", 2);
    await expectRefused(["goal", "target", goal, "--name", "Theo Marsh", "--none"], { ...ADMIN, ...REAL }, "usage", 2);
    await expectRefused(
      ["goal", "target", goal, "--name", "Theo Marsh", "--entity", "Theo"],
      { ...ADMIN, ...REAL },
      "usage",
      2,
    );
    await expectRefused(["goal", "target", "Theo", "--name", "Theo Marsh"], { ...ADMIN, ...REAL }, "usage", 2);
    // Without --name: exactly one of --entity and --none.
    await expectRefused(["goal", "target", goal], { ...ADMIN, ...REAL }, "usage", 2);
    await expectUnavailable(["goal", "target", goal, "--none"], { ...ADMIN, ...REAL });
  });

  // The kind is stored: agent and reasoner are taken, and any other word is a usage error.
  it("clients add takes --kind agent or reasoner and nothing else, and pi work budget takes its six options", async () => {
    for (const kind of ["agent", "reasoner"])
      await expectUnavailable(["clients", "add", "mine", "--kind", kind, "--views", "self", "--tools", "search"], {
        ...ADMIN,
        ...REAL,
      });
    await expectRefused(
      ["clients", "add", "mine", "--kind", "robot", "--views", "self", "--tools", "search"],
      { ...ADMIN, ...REAL },
      "usage",
      2,
    );
    await expectUnavailable(
      [
        "work",
        "budget",
        "--runs",
        "4",
        "--usd",
        "2",
        "--cards",
        "10",
        "--input-chars",
        "200000",
        "--token-price",
        "100",
        "--output-tokens",
        "16000",
      ],
      { ...ADMIN, ...REAL },
    );
    // One model call's output tokens, 1 000 to 32 000, checked before any connection.
    for (const tokens of ["1000", "32000"])
      await expectUnavailable(["work", "budget", "--output-tokens", tokens], { ...ADMIN, ...REAL });
    for (const tokens of ["999", "32001", "0", "-1", "16k"])
      await expectRefused(["work", "budget", "--output-tokens", tokens], { ...ADMIN, ...REAL }, "usage", 2);
    // The daily sweep's hour, 0 to 23, checked before any connection.
    for (const hour of ["0", "23"])
      await expectUnavailable(["work", "budget", "--sweep-hour", hour], { ...ADMIN, ...REAL });
    for (const hour of ["24", "-1", "7am", "6.5"])
      await expectRefused(["work", "budget", "--sweep-hour", hour], { ...ADMIN, ...REAL }, "usage", 2);
  });

  // Two different facts, a ruling id, a mode; anything else is a usage error before any connection.
  it("facts join, split, lift and grouping refuse a bad argument with usage", async () => {
    const fact = "a".repeat(64);
    for (const verdict of ["join", "split"]) {
      await expectRefused(["facts", verdict, fact, fact], { ...ADMIN, ...REAL }, "usage", 2);
      await expectRefused(["facts", verdict, fact, "not-a-fact"], { ...ADMIN, ...REAL }, "usage", 2);
    }
    await expectRefused(["facts", "lift", "not-a-ruling"], { ...ADMIN, ...REAL }, "usage", 2);
    for (const mode of ["on", "Apply", ""])
      await expectRefused(["facts", "grouping", mode], { ...ADMIN, ...REAL }, "usage", 2);
  });

  // --default takes a role or --none, and nothing else; a trigger's route is unchanged.
  it("work route takes TRIGGER with ROLE or --none, or --default with ROLE or --none", async () => {
    for (const argv of [
      ["no_warm_path", "research"],
      ["no_warm_path", "--none"],
      ["--default", "chief-of-staff"],
      ["--default", "--none"],
      ["--questions", "chief-of-staff"],
      ["--questions", "--none"],
    ])
      await expectUnavailable(["work", "route", ...argv], { ...ADMIN, ...REAL });
    for (const argv of [
      [],
      ["no_warm_path"],
      ["--default"],
      ["--questions"],
      ["--questions", "chief-of-staff", "--none"],
      ["--questions", "--default", "chief-of-staff"],
      ["--default", "chief-of-staff", "--none"],
      ["--default", "no_warm_path", "research"],
      ["--default", "Chief Of Staff"],
    ])
      await expectRefused(["work", "route", ...argv], { ...ADMIN, ...REAL }, "usage", 2);
  });

  it("lens contacts takes a device and on or off, and refuses any other word, a bad name or none with usage", async () => {
    for (const argv of [
      ["lens", "contacts", "mac", "maybe"],
      ["lens", "contacts", "Mac Book"],
      ["lens", "contacts"],
      ["lens", "contacts", "mac", "on", "now"],
    ]) {
      await expectRefused(argv, { ...ADMIN, ...REAL }, "usage", 2);
    }
  });

  // An IANA name Intl knows, in any case; any other is a usage error before any connection.
  it("owner timezone takes one IANA name and refuses any other with usage", async () => {
    for (const zone of ["America/Chicago", "america/chicago", "UTC"])
      await expectUnavailable(["owner", "timezone", zone], { ...ADMIN, ...REAL });
    for (const zone of ["Mars/Base", "", "Chicago time"])
      await expectRefused(["owner", "timezone", zone], { ...ADMIN, ...REAL }, "usage", 2);
    await expectRefused(["owner", "timezone"], { ...ADMIN, ...REAL }, "usage", 2);
  });

  // The filed rows' summary prints to the owner's terminal only, and takes no limit.
  it("identity mentions --summary prints to a terminal only and refuses a limit with usage", async () => {
    await expectRefused(["identity", "mentions", "--summary"], { ...ADMIN, ...KEYS }, "not_a_terminal");
    await expectRefused(["identity", "mentions", "--summary", "--limit", "5"], { ...ADMIN, ...REAL }, "usage", 2, {
      tty: true,
    });
  });

  // Work time: the views name places and task titles, so both print to a terminal only; a bad date,
  // half, project or day count is a usage error first.
  it("time day and time project print to a terminal only and refuse a malformed argument with usage", async () => {
    await expectRefused(["time", "day"], { ...ADMIN, ...KEYS }, "not_a_terminal");
    await expectRefused(["time", "day", "2026-10-01"], { ...ADMIN, ...KEYS }, "not_a_terminal");
    await expectRefused(["time", "project", `ent_${"0".repeat(25)}1`], { ...ADMIN, ...KEYS }, "not_a_terminal");
    for (const argv of [
      ["time", "day", "yesterday"],
      ["time", "day", "2026-10-01", "--half", "noon"],
      ["time", "day", "2026-10-01", "2026-10-02"],
      ["time", "project", "alpha"],
      ["time", "project", `ent_${"0".repeat(25)}1`, "--days", "0"],
      ["time", "project", `ent_${"0".repeat(25)}1`, "--days", "400"],
    ]) {
      await expectRefused(argv, { ...ADMIN, ...REAL }, "usage", 2, { tty: true });
      // Usage before the terminal check: a malformed argument on a pipe is a usage error too.
      await expectRefused(argv, { ...ADMIN, ...REAL }, "usage", 2);
    }
  });

  // The warmth commands print names, so to a terminal only; a tier that is none of the six, or a
  // count outside 1 to 5 000, is a usage error first.
  it("people tiers and people warmth print to a terminal only and refuse a malformed argument with usage", async () => {
    await expectRefused(["people", "tiers"], { ...ADMIN, ...KEYS }, "not_a_terminal");
    await expectRefused(
      ["people", "tiers", "--tier", "close", "--dormant", "--limit", "20"],
      { ...ADMIN, ...KEYS },
      "not_a_terminal",
    );
    await expectRefused(["people", "warmth", ENTITY], { ...ADMIN, ...KEYS }, "not_a_terminal");
    for (const argv of [
      ["people", "tiers", "--tier", "warm"],
      ["people", "tiers", "--limit", "0"],
      ["people", "tiers", "--limit", "5001"],
      ["people", "tiers", "--limit", "ten"],
      ["people", "warmth"],
    ]) {
      await expectRefused(argv, { ...ADMIN, ...REAL }, "usage", 2, { tty: true });
      await expectRefused(argv, { ...ADMIN, ...REAL }, "usage", 2);
    }
  });

  // A tier that is no ranked tier, a tier with --clear or none without it, and --ruled with a
  // filter, are usage errors before any connection.
  it("people tier and people tiers --ruled refuse a malformed argument with usage", async () => {
    for (const argv of [
      ["people", "tier", ENTITY],
      ["people", "tier", ENTITY, "one-way"],
      ["people", "tier", ENTITY, "warm"],
      ["people", "tier", ENTITY, "close", "--clear"],
      ["people", "tier", "--clear"],
      ["people", "tier", ENTITY, "close", "extra"],
      ["people", "tiers", "--ruled", "--tier", "close"],
      ["people", "tiers", "--ruled", "--limit", "5"],
    ]) {
      await expectRefused(argv, { ...ADMIN, ...REAL }, "usage", 2);
    }
  });

  // `lists`, which prints names, prints to a terminal only.
  it("lists refuse a malformed argument or name with usage, and print names to a terminal only", async () => {
    const LIST = "lst_01JABCDEFGHJKMNPQRSTVWXYZ0";
    for (const argv of [
      ["lists", "add", "lst_bad", ENTITY],
      ["lists", "add", LIST],
      ["lists", "remove", ENTITY, ENTITY],
      ["lists", "delete", "list"],
      ["lists", "rename", "lst_bad"],
    ]) {
      await expectRefused(argv, { ...ADMIN, ...REAL }, "usage", 2, { stdin: ["A name\n"] });
    }
    for (const name of ["", "   \n", "one\ntwo", "x".repeat(101)]) {
      await expectRefused(["lists", "create"], { ...ADMIN, ...REAL }, "usage", 2, { stdin: [name] });
      await expectRefused(["lists", "rename", LIST], { ...ADMIN, ...REAL }, "usage", 2, { stdin: [name] });
    }
    await expectRefused(["lists"], { ...ADMIN, ...KEYS }, "not_a_terminal");
  });

  // `areas`, which prints names, prints to a terminal only; with arguments that parse, each command
  // goes on to the database.
  it("areas refuse a malformed key or name with usage, and print names to a terminal only", async () => {
    for (const argv of [
      ["areas", "add", "Field Work"],
      ["areas", "add"],
      ["areas", "rename", "x"],
      ["areas", "order"],
      ["areas", "order", "field-work", "field-work"],
      ["areas", "order", "field-work", "Back Office"],
      ["areas", "retire", "field_work"],
      ["areas", "retire", "field-work", "back-office"],
      ["areas", "default", "research"],
      ["areas", "default", "research", "field-work", "--none"],
      ["areas", "default", "Research", "field-work"],
      ["project", "area", ENTITY],
      ["project", "area", ENTITY, "field-work", "--none"],
      ["project", "area", "ent_bad", "field-work"],
      ["project", "area", ENTITY, "Field Work"],
    ]) {
      await expectRefused(argv, { ...ADMIN, ...REAL }, "usage", 2, { stdin: ["A name\n"] });
    }
    for (const name of ["", "   \n", "one\ntwo", "x".repeat(201)]) {
      await expectRefused(["areas", "add", "field-work"], { ...ADMIN, ...REAL }, "usage", 2, { stdin: [name] });
      await expectRefused(["areas", "rename", "field-work"], { ...ADMIN, ...REAL }, "usage", 2, { stdin: [name] });
    }
    await expectRefused(["areas"], { ...ADMIN, ...KEYS }, "not_a_terminal");
    for (const argv of [
      ["areas", "add", "field-work"],
      ["areas", "rename", "field-work"],
      ["areas", "order", "back-office", "field-work"],
      ["areas", "retire", "field-work"],
      ["areas", "default", "research", "field-work"],
      ["areas", "default", "research", "--none"],
      ["project", "area", ENTITY, "field-work"],
      ["project", "area", ENTITY, "--none"],
    ]) {
      await expectUnavailable(argv, { ...ADMIN, ...REAL }, { stdin: ["A name\n"] });
    }
  });

  // The send-as aliases are addresses, so they print to a terminal only.
  it("owner aliases prints to a terminal only and takes no argument", async () => {
    await expectRefused(["owner", "aliases"], { ...ADMIN, ...KEYS }, "not_a_terminal");
    await expectRefused(["owner", "aliases", "extra"], { ...ADMIN, ...KEYS }, "usage", 2);
  });

  // Kind device is refused before the registration is checked and before any key is added, whatever
  // else is given.
  it("clients add refuses kind device with device_fixed, and adds no key", async () => {
    const before = await readFile(REAL.PI_KEY_FILE ?? "", "utf8");
    for (const tools of ["push_capture", "record", "search"]) {
      await expectRefused(
        [
          "clients",
          "add",
          "mac-capture",
          "--kind",
          "device",
          "--views",
          "self",
          "--tools",
          tools,
          "--retention",
          "none",
        ],
        { ...ADMIN, ...REAL, PI_RECORD_ENABLED: "1" },
        "device_fixed",
      );
    }
    expect(await readFile(REAL.PI_KEY_FILE ?? "", "utf8")).toBe(before);
    // The control: an agent with the same name passes every check and reaches the closed port.
    await expectUnavailable(
      ["clients", "add", "mac-capture", "--kind", "agent", "--views", "self", "--tools", "search"],
      { ...ADMIN, ...REAL },
    );
  });

  // Lens: `--show` prints each rule's value, so to a terminal only, checked in the body as `drive
  // list --show` is.
  it("scope list --show refuses without a terminal", async () => {
    const hint = "scope list --show prints each rule's value: run it in a terminal";
    await expectRefused(["lens", "scope", "list", "--show"], { ...ADMIN, ...KEYS }, "not_a_terminal", 1, { hint });
    await expectRefused(["lens", "scope", "list", "--show"], { ...ADMIN, ...REAL }, "not_a_terminal", 1, { hint });
    // The controls: on a terminal, and without --show off one, it reaches the closed port.
    await expectUnavailable(["lens", "scope", "list", "--show"], { ...ADMIN, ...REAL }, { tty: true });
    await expectUnavailable(["lens", "scope", "list"], { ...ADMIN, ...REAL });
  });

  it("lens browsing deny and the lists' --show refuse without a terminal, and a malformed argument is usage", async () => {
    const env = { ...ADMIN, ...REAL };
    await expectRefused(["lens", "browsing", "mac", "deny"], env, "not_a_terminal", 1, {
      hint: "lens browsing deny prints the exclude list and the account map and asks: run it in a terminal",
    });
    await expectRefused(["lens", "browsing", "exclude", "list", "--show"], env, "not_a_terminal", 1, {
      hint: "exclude list --show prints each excluded host: run it in a terminal",
    });
    await expectRefused(["lens", "browsing", "account", "list", "--show"], env, "not_a_terminal", 1, {
      hint: "account list --show prints each mapped account: run it in a terminal",
    });
    // A piped answer on a terminal's output is refused too.
    expect(
      await pi(["lens", "browsing", "mac", "deny"], env, { tty: true, stdinTty: false, stdin: ["yes\n"] }),
    ).toEqual({
      exit: 1,
      stdout: "",
      stderr: `${failed("not_a_terminal")}lens browsing deny prints the exclude list and the account map and asks: run it in a terminal\n`,
    });
    await expectUnavailable(["lens", "browsing", "mac", "deny"], env, { tty: true });
    // The controls: on a terminal each reaches the closed port, and `allow` and the bare view off one.
    for (const argv of [
      ["lens", "browsing", "mac", "deny"],
      ["lens", "browsing", "exclude", "list", "--show"],
      ["lens", "browsing", "account", "list", "--show"],
    ])
      await expectUnavailable(argv, env, { tty: true });
    for (const argv of [
      ["lens", "browsing", "mac"],
      ["lens", "browsing", "mac", "allow"],
    ])
      await expectUnavailable(argv, env);
    for (const argv of [
      ["lens", "browsing", "mac", "maybe"],
      ["lens", "browsing", "Mac Book"],
      ["lens", "browsing", "mac", "deny", "now"],
      ["lens", "browsing", "exclude", "add"],
      ["lens", "browsing", "exclude", "drop", "bank.example.com"],
      ["lens", "browsing", "exclude", "remove", `csr_${"0".repeat(25)}1`],
      ["lens", "browsing", "exclude", "add", "bank.example.com", "--show"],
      ["lens", "browsing", "account", "add", "owner@example.test"],
      ["lens", "browsing", "account", "add", "owner@example.test", "--compartment", "nowhere"],
      ["lens", "browsing", "account", "list", "--compartment", "own"],
      ["lens", "browsing", "account", "remove", `cex_${"0".repeat(25)}1`],
    ]) {
      await expectRefused(argv, env, "usage", 2, { tty: true });
    }
  });

  it("lens scope add and remove refuse a malformed rule before any connection", async () => {
    const env = { ...ADMIN, ...REAL };
    const host = ["--host", "example.test"];
    for (const argv of [
      ["lens", "scope", "add", "--compartment", "own"],
      ["lens", "scope", "add", "--bundle", "com.example.app", ...host, "--compartment", "own"],
      ["lens", "scope", "add", ...host],
      ["lens", "scope", "add", ...host, "--compartment", "own", "--kinds", "meeting,film"],
      ["lens", "scope", "add", ...host, "--compartment", "own", "--kinds", "meeting,meeting"],
      ["lens", "scope", "add", ...host, "--compartment", "own", "--kinds", ""],
      ["lens", "scope", "add", ...host, "--compartment", "own", "extra"],
      ["lens", "scope", "remove", "csr_bad"],
      ["lens", "scope", "remove"],
      ["lens", "scope", "list", "extra"],
      // Three words make a command only as three arguments.
      ["lens", "scope"],
      ["lens scope list"],
      ["lens", "scope list"],
    ]) {
      await expectRefused(argv, env, "usage", 2);
    }
    // The controls: each form passes every check and reaches the closed port.
    for (const kinds of [[], ["--kinds", "meeting"], ["--kinds", "block,moment,meeting"]])
      await expectUnavailable(["lens", "scope", "add", ...host, "--compartment", "own", ...kinds], env);
    await expectUnavailable(["lens", "scope", "remove", `csr_${"0".repeat(25)}1`], env);
  });

  it("lens scope add takes --client only with --agent-app, in a client name's form", async () => {
    const env = { ...ADMIN, ...REAL };
    const rule = ["lens", "scope", "add", "--bundle", "test.example.agent", "--compartment", "own"];
    for (const argv of [
      [...rule, "--client", "desk"],
      [...rule, "--agent-app", "--client", "Not A Name"],
      [...rule, "--agent-app", "--client", ""],
    ]) {
      await expectRefused(argv, env, "usage", 2);
    }
    // The controls: the flag alone, with a client, and with kinds; the store refuses a meeting kind.
    for (const extra of [[], ["--client", "desk"], ["--kinds", "moment"]])
      await expectUnavailable([...rule, "--agent-app", ...extra], env);
  });

  it("lens backfill vouch takes one device name and nothing else", async () => {
    const env = { ...ADMIN, ...REAL };
    for (const argv of [
      ["lens", "backfill", "vouch"],
      ["lens", "backfill", "vouch", "Not A Name"],
      ["lens", "backfill", "vouch", "mac", "extra"],
      ["lens", "backfill", "vouch", "mac", "--days", "35"],
    ]) {
      await expectRefused(argv, env, "usage", 2);
    }
    await expectUnavailable(["lens", "backfill", "vouch", "mac"], env);
  });

  it("lens scope add --source takes a bundle rule of moments alone, with no account and not --agent-app", async () => {
    const env = { ...ADMIN, ...REAL };
    const rule = [
      "lens",
      "scope",
      "add",
      "--bundle",
      "com.apple.MobileSMS",
      "--compartment",
      "own",
      "--source",
      "imessage",
    ];
    for (const argv of [
      ["lens", "scope", "add", "--host", "example.test", "--compartment", "own", "--source", "imessage"],
      [...rule.slice(0, -1), "screen"],
      [...rule, "--agent-app"],
      [...rule, "--account", "avery@quinn.test"],
      [...rule, "--kinds", "block"],
      [...rule, "--kinds", "moment,block"],
    ]) {
      await expectRefused(argv, env, "usage", 2);
    }
    // The controls: the rule alone and with its one kind; the store refuses another bundle.
    for (const extra of [[], ["--kinds", "moment"]]) await expectUnavailable([...rule, ...extra], env);
    await expectUnavailable(
      ["lens", "scope", "add", "--bundle", "test.example.chat", "--compartment", "own", "--source", "imessage"],
      env,
    );
  });

  it("retain set takes a class and exactly one of --days N and --keep", async () => {
    const env = { ...ADMIN, ...REAL };
    for (const argv of [
      ["retain", "set", "capture_moment"],
      ["retain", "set", "capture_moment", "--days", "90", "--keep"],
      ["retain", "set", "capture_moment", "--days", "0"],
      ["retain", "set", "capture_moment", "--days", "90d"],
      ["retain", "set", "capture_audio", "--days", "90"],
      ["retain", "set", "capture_moment", "--days", "90", "--account", "not-an-account"],
      ["retain", "set", "--days", "90"],
      ["retain", "adopt", "extra"],
    ]) {
      await expectRefused(argv, env, "usage", 2);
    }
    for (const argv of [
      ["retain", "set", "capture_moment", "--days", "90"],
      ["retain", "set", "capture_transcript", "--keep"],
      ["retain", "adopt"],
      ["retain", "list"],
      ["retain", "plan"],
      ["retain", "run"],
      ["status", "--storage"],
    ]) {
      await expectUnavailable(argv, env);
    }
  });

  // The report prints summaries and notes, so to a terminal only, and takes --days from 1 to 90.
  it("pi work report prints to a terminal only and takes --days from 1 to 90", async () => {
    await expectRefused(["work", "report"], { ...ADMIN, ...KEYS }, "not_a_terminal");
    for (const days of ["1", "90"])
      await expectUnavailable(["work", "report", "--days", days], { ...ADMIN, ...REAL }, { tty: true });
    await expectUnavailable(["work", "report"], { ...ADMIN, ...REAL }, { tty: true });
    for (const days of ["0", "91", "-1", "7d"])
      await expectRefused(["work", "report", "--days", days], { ...ADMIN, ...REAL }, "usage", 2, { tty: true });
  });

  // A trial's stage, model and effort, and translate's idea, are checked before any connection; the list and one trial's output print to a terminal only.
  it("pi work trial checks its arguments before any connection; pi work trials and trial-show print to a terminal only", async () => {
    const env = { ...ADMIN, ...REAL };
    const IDEA = "hyp_01JABCDEFGHJKMNPQRSTVWXYZ0";
    const trial = (stage: string, ...rest: string[]) => [
      "work",
      "trial",
      "--stage",
      stage,
      "--model",
      "anthropic/claude-haiku-5.5",
      "--effort",
      "high",
      ...rest,
    ];
    for (const args of [
      trial("ideas"),
      trial("lessons"),
      trial("translate", "--idea", IDEA),
      [
        "work",
        "trial",
        "--stage",
        "ideas",
        "--model",
        "openai/gpt-6-luna,anthropic/claude-haiku-5.5",
        "--effort",
        "high",
      ],
      [
        "work",
        "trial",
        "--stage",
        "lessons",
        "--model",
        "openai/gpt-6-luna,anthropic/claude-haiku-5.5",
        "--effort",
        "high,medium",
      ],
    ]) {
      await expectUnavailable(args, env);
    }
    for (const args of [
      trial("sweep"),
      trial("translate"),
      trial("ideas", "--idea", IDEA),
      trial("translate", "--idea", "idea-1"),
      trial("predict"),
      ["work", "trial", "--stage", "ideas", "--model", "claude-haiku", "--effort", "high"],
      ["work", "trial", "--stage", "ideas", "--model", "Anthropic/Claude", "--effort", "high"],
      ["work", "trial", "--stage", "ideas", "--model", "anthropic/claude-haiku-5.5", "--effort", "max"],
      ["work", "trial", "--stage", "ideas", "--model", "anthropic/claude-haiku-5.5"],
      ["work", "trial", "--stage", "ideas", "--model", "a/b,c/d,e/f", "--effort", "high,low"],
      ["work", "trial", "--stage", "ideas", "--model", "a/b,c/d,e/f,g/h,i/j", "--effort", "high"],
      ["work", "trial", "--stage", "ideas", "--model", "a/b,", "--effort", "high"],
    ]) {
      await expectRefused(args, env, "usage", 2);
    }
    await expectRefused(["work", "trials"], { ...ADMIN, ...KEYS }, "not_a_terminal");
    await expectRefused(
      ["work", "trial-show", "run_01JABCDEFGHJKMNPQRSTVWXYZ0"],
      { ...ADMIN, ...KEYS },
      "not_a_terminal",
    );
    await expectUnavailable(["work", "trials"], env, { tty: true });
    await expectUnavailable(["work", "trials", "--stage", "lessons"], env, { tty: true });
    await expectRefused(["work", "trials", "--stage", "predict"], env, "usage", 2, { tty: true });
    await expectRefused(["work", "trials", "--stage", "sweep"], env, "usage", 2, { tty: true });
    await expectUnavailable(["work", "trial-show", "run_01JABCDEFGHJKMNPQRSTVWXYZ0"], env, { tty: true });
    await expectRefused(["work", "trial-show", "opp_01JABCDEFGHJKMNPQRSTVWXYZ0"], env, "usage", 2, { tty: true });
  });

  // Each budget within ClientQuota's bounds, checked before any connection.
  it("pi clients quota refuses a value outside the contract's bounds", async () => {
    const env = { ...ADMIN, ...REAL };
    for (const bad of [
      ["--per-minute", "0"],
      ["--per-minute", "601"],
      ["--items", "100001"],
      ["--chars", "100000001"],
      ["--rows", "1000001"],
      ["--items", "-1"],
      ["--items", "1.5"],
      ["--items", "five"],
      ["--items", ""],
    ]) {
      await expectRefused(["clients", "quota", "mine", ...bad], env, "usage", 2);
    }
    // No budget named, and no name, are usage errors too.
    await expectRefused(["clients", "quota", "mine"], env, "usage", 2);
    await expectRefused(["clients", "quota", "--items", "5"], env, "usage", 2);
    // The controls: the bounds themselves pass every check and reach the closed port.
    await expectUnavailable(
      ["clients", "quota", "mine", "--per-minute", "1", "--items", "0", "--chars", "100000000", "--rows", "1000000"],
      env,
    );
    await expectUnavailable(["clients", "quota", "mine", "--per-minute", "600"], env);
    await expectUnavailable(["clients", "usage", "mine"], env);
    await expectRefused(["clients", "usage", "mine", "other"], env, "usage", 2);
  });
});
