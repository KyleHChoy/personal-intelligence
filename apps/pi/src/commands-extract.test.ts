// Covers commands.ts, the `pi` command line, through the commands of one area.
// Extraction, learning, the ladder and the model key: their arguments and settings.
import { createServer, type Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { run } from "./commands.ts";
import {
  ADMIN,
  BOOTSTRAP,
  DOCUMENT,
  type Env,
  expectRefused,
  expectUnavailable,
  failed,
  failureLines,
  KEYS,
  MESSAGE,
  MODEL,
  PIPELINE,
  PROXY,
  pi,
  READER,
  REAL,
  useRealKeyFile,
  WORK,
  WRITER,
} from "./test-support/commands-fixtures.ts";

useRealKeyFile();

describe("pi", () => {
  // The blind review is for a terminal only, and a pipe gets nothing.
  it("ladder review prints nothing when stdout is not a terminal, and needs a point", async () => {
    await expectRefused(["ladder", "review", "--point", "extract_recovery"], { ...ADMIN, ...KEYS }, "not_a_terminal");
    await expectRefused(
      ["ladder", "review", "--point", "extract_recovery", "--sample", "30"],
      { ...ADMIN, ...REAL },
      "not_a_terminal",
    );
    await expectRefused(["ladder", "review"], { ...ADMIN, ...KEYS }, "usage", 2, { tty: true });
    await expectRefused(
      ["ladder", "review", "--point", "extract_recovery", "--sample", "0"],
      { ...ADMIN, ...KEYS },
      "usage",
      2,
      { tty: true },
    );
  });

  it("learn silences prints nothing when stdout is not a terminal, and learn label and learn silences refuse a value that is not one", async () => {
    await expectRefused(["learn", "silences"], { ...ADMIN, ...KEYS }, "not_a_terminal");
    await expectRefused(["learn", "silences", "--pending"], { ...ADMIN, ...REAL }, "not_a_terminal");
    for (const argv of [
      ["learn", "silences", "--sample", "0"],
      ["learn", "silences", "--sample", "21"],
      ["learn", "silences", "--sample", "5", "--pending"],
      ["learn", "silences", "extra"],
      ["learn", "label", "crd_short", "--labels", "acted"],
      ["learn", "label", `crd_${"0".repeat(25)}1`],
      ["learn", "label", `crd_${"0".repeat(25)}1`, "--labels", "acted,everything"],
      ["learn", "label", `crd_${"0".repeat(25)}1`, "--labels", "acted,"],
    ]) {
      await expectRefused(argv, { ...ADMIN, ...KEYS }, "usage", 2, { tty: true });
    }
  });

  it("jev-calibration's commands refuse a point, a value or an id that is not one, before any connection", async () => {
    // identity_rank's labels are its cards' answers, and no point is reviewed by name alone.
    await expectRefused(["ladder", "review", "--point", "identity_rank"], { ...ADMIN, ...KEYS }, "usage", 2, {
      tty: true,
    });
    await expectRefused(["ladder", "resume", "no_such_point"], { ...ADMIN, ...KEYS }, "usage", 2);
    await expectRefused(
      ["thresholds", "set", "extract_recovery", "--name", "hold", "--value", "1.5"],
      { ...ADMIN, ...KEYS },
      "usage",
      2,
    );
    await expectRefused(["thresholds", "target", "extract_recovery"], { ...ADMIN, ...KEYS }, "usage", 2);
    await expectRefused(["thresholds", "grant", "a-proposal"], { ...ADMIN, ...KEYS }, "usage", 2);
    await expectRefused(["agent-records", "release", "a-record"], { ...ADMIN, ...KEYS }, "usage", 2);
  });

  it("sync refuses --fast with --send-as, --records or a Drive or contacts reset, before any connection", async () => {
    for (const argv of [
      ["sync", "--fast", "--send-as"],
      ["sync", "--records", "--fast"],
      ["sync", "--records", "--send-as"],
      ["sync", "--fast", "--reset", "drive"],
      ["sync", "--fast", "--reset", "contacts"],
    ])
      await expectRefused(argv, { ...WRITER, ...KEYS }, "usage", 2);
  });

  it("restatements refuse an answer, a limit, a name or an id that is not one, before any connection", async () => {
    for (const argv of [
      ["restatements", "list", "--answer", "maybe"],
      ["restatements", "list", "--limit", "0"],
      ["restatements", "list", "--limit", "201"],
      ["restatements", "list", "--client", "Not A Name"],
      ["restatements", "clear", "0"],
      ["restatements", "clear", "one"],
      ["restatements", "clear", "-1"],
      ["restatements", "clear"],
    ]) {
      await expectRefused(argv, { ...ADMIN, ...KEYS }, "usage", 2);
    }
  });

  it("a key given as an argument to a command of jev-calibration is refused", async () => {
    await expectRefused(
      ["thresholds", "set", "extract_recovery", "--name", "sk-or-v1-0000", "--value", "0.6"],
      { ...ADMIN, ...KEYS },
      "secret_in_argument",
    );
  });

  it("extract review prints nothing when stdout is not a terminal", async () => {
    await expectRefused(["extract", "review"], { ...ADMIN, ...KEYS }, "not_a_terminal");
    await expectRefused(["extract", "review", "--type", "commitment"], { ...ADMIN, ...REAL }, "not_a_terminal");
    // The positive control: a terminal passes the guard, and the command goes on to the database.
    await expectUnavailable(["extract", "review"], { ...ADMIN, ...REAL }, { tty: true });
  });

  it("extract review with a type that is no fact type, or a sample that is not a count, is a usage error", async () => {
    for (const argv of [
      ["extract", "review", "--type", "receipt"],
      ["extract", "review", "--sample", "0"],
      ["extract", "review", "--sample", "ten"],
      ["extract", "review", "--sample", "501"],
    ]) {
      await expectRefused(argv, { ...ADMIN, ...REAL }, "usage", 2, { tty: true });
    }
    await expectUnavailable(
      ["extract", "review", "--type", "transaction.receipt", "--sample", "20"],
      { ...ADMIN, ...REAL },
      { tty: true },
    );
  });

  it("extract review-export prints nothing when stdout is not a terminal", async () => {
    const hint = "review-export prints decrypted mail: run it in a terminal, not into a pipe or a file";
    // Refused before any connection: the key file and the database are never reached.
    await expectRefused(["extract", "review-export"], { ...ADMIN, ...KEYS }, "not_a_terminal", 1, { hint });
    await expectRefused(
      ["extract", "review-export", "--type", "plan", "--sample", "20"],
      { ...ADMIN, ...REAL },
      "not_a_terminal",
      1,
      { hint },
    );
    // The positive control: a terminal passes the guard, and the command goes on to the database.
    await expectUnavailable(["extract", "review-export"], { ...ADMIN, ...REAL }, { tty: true });
    await expectUnavailable(
      ["extract", "review-export", "--type", "plan", "--sample", "20"],
      { ...ADMIN, ...REAL },
      { tty: true },
    );
  });

  it("extract review-import needs no terminal, and review-export takes the review's arguments", async () => {
    // A document that is not JSON, or not the import's shape, is refused before any connection.
    await expectRefused(["extract", "review-import"], { ...ADMIN, ...REAL }, "review_invalid");
    await expectRefused(["extract", "review-import"], { ...ADMIN, ...REAL }, "review_invalid", 1, {
      stdin: ['{"sample_id":"x","verdicts":[{}]}'],
    });
    const result = await pi(
      ["extract", "review-import"],
      { ...ADMIN, ...REAL },
      { stdin: ['{"sample_id":"x",', '"verdicts":[]}'] },
    );
    expect(failureLines(result.stderr).at(-1)).toEqual({ event: "command_failed", code: "unavailable" });
    for (const argv of [
      ["extract", "review-export", "--type", "receipt"],
      ["extract", "review-export", "--sample", "0"],
      ["extract", "review-export", "--sample", "501"],
      ["extract", "review-import", "--sample", "3"],
      ["extract", "review-import", "verdicts.json"],
    ]) {
      await expectRefused(argv, { ...ADMIN, ...REAL }, "usage", 2, { tty: true });
    }
  });

  it("extract retry with no selection, with two, or with a status outside the four is a usage error", async () => {
    for (const argv of [
      ["extract", "retry"],
      ["extract", "retry", "--lane", "skip"],
      ["extract", "retry", "--all", "--status", "failed"],
      ["extract", "retry", "--all", "--message", MESSAGE],
      ["extract", "retry", "--status", "failed", "--message", MESSAGE],
      ["extract", "retry", "--status", "waiting"],
      ["extract", "retry", "--status", "Failed"],
      ["extract", "retry", "--all", "--lane", "other"],
      // The page lane is a stored page's, set by code, never the owner's.
      ["extract", "retry", "--all", "--lane", "page", "--yes"],
      ["extract", "retry", "--message", MESSAGE, "--lane", "page"],
      ["extract", "retry", "--document", DOCUMENT, "--lane", "page"],
      ["extract", "retry", "--message", "not-an-id"],
      ["extract", "retry", "--all", "extra"],
    ]) {
      await expectRefused(argv, { ...ADMIN, ...REAL }, "usage", 2);
    }
    // The positive controls: each form alone passes the check, and goes on to the database.
    for (const status of ["failed", "withheld", "skipped", "done"])
      await expectUnavailable(["extract", "retry", "--status", status], { ...ADMIN, ...REAL });
    await expectUnavailable(["extract", "retry", "--all", "--lane", "transaction", "--yes"], { ...ADMIN, ...REAL });
    await expectUnavailable(["extract", "retry", "--message", MESSAGE, "--lane", "skip"], { ...ADMIN, ...REAL });
  });

  // `reroute` takes only --dry-run; item takes exactly one message id.
  it("extract reroute takes only --dry-run, and extract item exactly --message ID; anything else is a usage error", async () => {
    for (const argv of [
      ["extract", "reroute", "--all"],
      ["extract", "reroute", "extra"],
      ["extract", "item"],
      ["extract", "item", "--message", "not-an-id"],
      ["extract", "item", "--message", MESSAGE, "extra"],
      ["extract", "item", MESSAGE],
    ]) {
      await expectRefused(argv, { ...ADMIN, ...REAL }, "usage", 2);
    }
    // The positive controls: each goes on to the database.
    await expectUnavailable(["extract", "reroute"], { ...ADMIN, ...REAL });
    await expectUnavailable(["extract", "reroute", "--dry-run"], { ...ADMIN, ...REAL });
    await expectUnavailable(["extract", "item", "--message", MESSAGE], { ...ADMIN, ...REAL });
  });

  // One document by its id, the fourth selector, with a lane of its own.
  it("extract retry --document takes a document id, alone, with the document lane or skip; a message's lanes, or the document lane for any other selector, are usage errors", async () => {
    for (const argv of [
      ["extract", "retry", "--document", "not-an-id"],
      ["extract", "retry", "--document", MESSAGE],
      ["extract", "retry", "--document", DOCUMENT, "--message", MESSAGE],
      ["extract", "retry", "--document", DOCUMENT, "--all"],
      ["extract", "retry", "--document", DOCUMENT, "--lane", "correspondence"],
      ["extract", "retry", "--document", DOCUMENT, "--lane", "transaction"],
      ["extract", "retry", "--document", DOCUMENT, "--override"],
      ["extract", "retry", "--message", MESSAGE, "--lane", "document"],
      ["extract", "retry", "--all", "--lane", "document", "--yes"],
      ["extract", "retry", "--status", "done", "--lane", "document"],
    ]) {
      await expectRefused(argv, { ...ADMIN, ...REAL }, "usage", 2);
    }
    // The positive controls: each passes the check and goes on to the database.
    await expectUnavailable(["extract", "retry", "--document", DOCUMENT], { ...ADMIN, ...REAL });
    await expectUnavailable(["extract", "retry", "--document", DOCUMENT, "--lane", "document"], { ...ADMIN, ...REAL });
    await expectUnavailable(["extract", "retry", "--document", DOCUMENT, "--lane", "skip"], { ...ADMIN, ...REAL });
  });

  // One kind of capture item, alone or by status, and one capture item by its cap_ id or its
  // capture key; neither takes a lane or another selector.
  it("extract retry --kind takes meeting or moment, alone or with --status; --capture takes a cap_ id or a meeting's or moment's key; neither takes a lane", async () => {
    const ULID = "01JMMNTSAA0000000000000001";
    for (const argv of [
      ["extract", "retry", "--kind", "block"],
      ["extract", "retry", "--kind", "message"],
      ["extract", "retry", "--kind", "moment", "--lane", "moment"],
      ["extract", "retry", "--kind", "moment", "--lane", "skip"],
      ["extract", "retry", "--kind", "moment", "--all"],
      ["extract", "retry", "--kind", "moment", "--message", MESSAGE],
      ["extract", "retry", "--kind", "moment", "--status", "waiting"],
      ["extract", "retry", "--kind", "moment", "--capture", `cap_${ULID}`],
      ["extract", "retry", "--capture", "not-a-capture"],
      ["extract", "retry", "--capture", `block:${ULID}`],
      ["extract", "retry", "--capture", `cap_${ULID}`, "--lane", "skip"],
      ["extract", "retry", "--capture", `cap_${ULID}`, "--status", "done"],
      ["extract", "retry", "--capture", `cap_${ULID}`, "--override"],
    ]) {
      await expectRefused(argv, { ...ADMIN, ...REAL }, "usage", 2);
    }
    // The positive controls: each passes the check and goes on to the database.
    await expectUnavailable(["extract", "retry", "--kind", "moment"], { ...ADMIN, ...REAL });
    await expectUnavailable(["extract", "retry", "--kind", "meeting", "--status", "done", "--yes"], {
      ...ADMIN,
      ...REAL,
    });
    await expectUnavailable(["extract", "retry", "--capture", `cap_${ULID}`], { ...ADMIN, ...REAL });
    await expectUnavailable(["extract", "retry", "--capture", `moment:${ULID}`], { ...ADMIN, ...REAL });
  });

  it("extract retry --in-lane takes a message lane, alone or with --status, and no lane, kind or other selector", async () => {
    for (const argv of [
      ["extract", "retry", "--in-lane", "moment"],
      ["extract", "retry", "--in-lane", "document"],
      ["extract", "retry", "--in-lane", "correspondence", "--lane", "transaction"],
      ["extract", "retry", "--in-lane", "correspondence", "--kind", "moment"],
      ["extract", "retry", "--in-lane", "correspondence", "--all"],
      ["extract", "retry", "--in-lane", "correspondence", "--message", MESSAGE],
      ["extract", "retry", "--in-lane", "correspondence", "--status", "waiting"],
    ]) {
      await expectRefused(argv, { ...ADMIN, ...REAL }, "usage", 2);
    }
    await expectUnavailable(["extract", "retry", "--in-lane", "correspondence"], { ...ADMIN, ...REAL });
    await expectUnavailable(["extract", "retry", "--in-lane", "agent", "--status", "done", "--yes"], {
      ...ADMIN,
      ...REAL,
    });
  });

  it("extract check takes --world and --lane document together, and neither alone, and the transaction lane likewise", async () => {
    for (const argv of [
      ["extract", "check", "--world"],
      ["extract", "check", "--lane", "document"],
      ["extract", "check", "--lane", "correspondence"],
      ["extract", "check", "--lane", "transaction"],
      ["extract", "check", "--world", "--lane", "agent_record"],
      ["extract", "check", "--world", "--lane", "Document"],
    ]) {
      await expectRefused(argv, { ...PIPELINE, ...REAL, ...MODEL }, "usage", 2);
    }
    await expectUnavailable(["extract", "check", "--world", "--lane", "document"], { ...PIPELINE, ...REAL, ...MODEL });
    await expectUnavailable(["extract", "check", "--world", "--lane", "correspondence"], {
      ...PIPELINE,
      ...REAL,
      ...MODEL,
    });
    // The transaction lane's notices and receipts, with --detail.
    await expectUnavailable(["extract", "check", "--world", "--lane", "transaction"], {
      ...PIPELINE,
      ...REAL,
      ...MODEL,
    });
    await expectUnavailable(["extract", "check", "--world", "--lane", "transaction", "--detail"], {
      ...PIPELINE,
      ...REAL,
      ...MODEL,
    });
    // The second-degree set, without --detail or --runs.
    await expectUnavailable(["extract", "check", "--world", "--lane", "second-degree"], {
      ...PIPELINE,
      ...REAL,
      ...MODEL,
    });
    for (const extra of [["--detail"], ["--runs", "3"]])
      await expectRefused(
        ["extract", "check", "--world", "--lane", "second-degree", ...extra],
        { ...PIPELINE, ...REAL, ...MODEL },
        "usage",
        2,
      );
    await expectUnavailable(["extract", "check"], { ...PIPELINE, ...REAL, ...MODEL });
  });

  // A model comparison, on the synthetic world alone.
  it("extract check --world takes --vendor anthropic with --model and --effort, and --detail on the meeting, moment and correspondence lanes; each is checked before any connection", async () => {
    const world = ["extract", "check", "--world", "--lane", "meeting"];
    const ANTHROPIC = { PI_EXTRACT_ANTHROPIC_KEY: "sk-ant-test-not-a-real-key-0000" };
    for (const argv of [
      ["extract", "check", "--vendor", "anthropic"],
      ["extract", "check", "--detail"],
      [...world, "--vendor", "bedrock"],
      [...world, "--effort", "low"],
      [...world, "--vendor", "openrouter", "--model", "claude-haiku-5-5"],
      [...world, "--vendor", "anthropic", "--effort", "xhigh"],
      [...world, "--vendor", "anthropic", "--model", "openai/gpt-6-luna"],
      [...world, "--vendor", "anthropic", "--model", "Claude-Haiku"],
      ["extract", "check", "--world", "--lane", "document", "--detail"],
      ["extract", "check", "--world", "--lane", "correspondence", "--effort", "low"],
      // --runs is the meeting lane's and the moment lane's alone, 1 to 5, and needs --world.
      ["extract", "check", "--runs", "3"],
      ["extract", "check", "--world", "--lane", "document", "--runs", "3"],
      [...world, "--runs", "0"],
      [...world, "--runs", "6"],
      [...world, "--runs", "three"],
    ]) {
      await expectRefused(argv, { ...PIPELINE, ...REAL, ...MODEL, ...ANTHROPIC }, "usage", 2);
    }
    // The key is read from its variable alone, and must be Anthropic's.
    await expectRefused([...world, "--vendor", "anthropic"], { ...PIPELINE, ...REAL, ...MODEL }, "missing_env", 1, {
      hint: "set PI_EXTRACT_ANTHROPIC_KEY",
    });
    await expectRefused(
      [...world, "--vendor", "anthropic"],
      { ...PIPELINE, ...REAL, ...MODEL, PI_EXTRACT_ANTHROPIC_KEY: "sk-or-v1-0000" },
      "bad_env",
      1,
      { hint: "set PI_EXTRACT_ANTHROPIC_KEY" },
    );
    // The positive controls: each passes its checks and goes on to the database. With the key in
    // the environment and no --vendor the configured vendor is Anthropic, so the configured
    // OpenRouter model's check runs without it.
    await expectUnavailable([...world, "--detail"], { ...PIPELINE, ...REAL, ...MODEL });
    await expectUnavailable([...world, "--runs", "3"], { ...PIPELINE, ...REAL, ...MODEL });
    await expectUnavailable(["extract", "check", "--world", "--lane", "moment", "--runs", "3"], {
      ...PIPELINE,
      ...REAL,
      ...MODEL,
    });
    await expectUnavailable(["extract", "check", "--world", "--lane", "correspondence", "--detail"], {
      ...PIPELINE,
      ...REAL,
      ...MODEL,
    });
    for (const argv of [
      [...world, "--vendor", "openrouter"],
      [...world, "--vendor", "anthropic"],
      [...world, "--vendor", "anthropic", "--model", "anthropic/claude-haiku-5.5", "--effort", "max", "--detail"],
      ["extract", "check", "--world", "--lane", "moment", "--vendor", "anthropic", "--effort", "low"],
      ["extract", "check", "--world", "--lane", "moment", "--vendor", "anthropic", "--effort", "medium", "--detail"],
      [
        "extract",
        "check",
        "--world",
        "--lane",
        "correspondence",
        "--vendor",
        "anthropic",
        "--model",
        "claude-sonnet-5-5",
        "--effort",
        "medium",
        "--detail",
      ],
    ]) {
      await expectUnavailable(argv, { ...PIPELINE, ...REAL, ...MODEL, ...ANTHROPIC });
    }
  });

  // Extraction on Anthropic, picked by PI_EXTRACT_ANTHROPIC_KEY, checked before any connection.
  it("PI_EXTRACT_ANTHROPIC_KEY picks Anthropic for extract, trial and check, with an Anthropic model and PI_EXTRACT_EFFORT; each is checked before any connection", async () => {
    const KEY = { PI_EXTRACT_ANTHROPIC_KEY: "sk-ant-test-not-a-real-key-0000" };
    const HAIKU = { PI_EXTRACT_MODEL: "anthropic/claude-haiku-5-5" };
    const commands = [
      ["extract"],
      ["extract", "trial"],
      ["extract", "check"],
      ["extract", "check", "--world", "--lane", "meeting"],
    ];
    for (const argv of commands) {
      await expectRefused(
        argv,
        { ...PIPELINE, ...REAL, ...HAIKU, PI_EXTRACT_ANTHROPIC_KEY: "sk-or-v1-0000" },
        "bad_env",
        1,
        { hint: "set PI_EXTRACT_ANTHROPIC_KEY" },
      );
      await expectRefused(argv, { ...PIPELINE, ...REAL, ...MODEL, ...KEY }, "bad_env", 1, {
        hint: "set PI_EXTRACT_MODEL",
      });
      await expectRefused(argv, { ...PIPELINE, ...REAL, ...MODEL, PI_EXTRACT_EFFORT: "low" }, "bad_env", 1, {
        hint: "set PI_EXTRACT_EFFORT",
      });
      await expectRefused(argv, { ...PIPELINE, ...REAL, ...HAIKU, ...KEY, PI_EXTRACT_EFFORT: "xhigh" }, "bad_env", 1, {
        hint: "set PI_EXTRACT_EFFORT",
      });
      // The positive controls: unset is OpenRouter, and a whole Anthropic setting goes on to the
      // closed port.
      await expectUnavailable(argv, { ...PIPELINE, ...REAL, ...MODEL });
      await expectUnavailable(argv, { ...PIPELINE, ...REAL, ...HAIKU, ...KEY, PI_EXTRACT_EFFORT: "high" });
    }
    // Only a pipeline command may hold the key: a copy in another role's file stops that command.
    await expectRefused(["status"], { ...ADMIN, ...REAL, ...KEY }, "wrong_role_url");
    await expectUnavailable(["status"], { ...ADMIN, ...REAL });
  });

  // The judge model, checked by extract and dream before any connection.
  it("PI_JUDGE_MODEL is checked by extract and dream before any connection, a bare Anthropic id read as one", async () => {
    const ON = {
      PI_EXTRACT_ANTHROPIC_KEY: "sk-ant-test-not-a-real-key-0000",
      PI_EXTRACT_MODEL: "anthropic/claude-haiku-5-5",
    };
    for (const argv of [["extract"], ["dream"]]) {
      await expectRefused(argv, { ...PIPELINE, ...REAL, ...ON, PI_JUDGE_MODEL: "openai/gpt-6-luna" }, "bad_env", 1, {
        hint: "set PI_JUDGE_MODEL",
      });
      await expectRefused(
        argv,
        { ...PIPELINE, ...REAL, ...ON, PI_JUDGE_MODEL: "anthropic/claude-unpriced-9" },
        "bad_env",
        1,
        { hint: "set PI_JUDGE_MODEL" },
      );
      await expectRefused(argv, { ...PIPELINE, ...REAL, ...MODEL, PI_JUDGE_MODEL: "Not A Model" }, "bad_env", 1, {
        hint: "set PI_JUDGE_MODEL",
      });
      // The positive controls: the box's bare id, and the full one, go on to the closed port.
      await expectUnavailable(argv, { ...PIPELINE, ...REAL, ...ON, PI_JUDGE_MODEL: "claude-opus-5-5" });
      await expectUnavailable(argv, { ...PIPELINE, ...REAL, ...ON, PI_JUDGE_MODEL: "anthropic/claude-opus-5-5" });
    }
  });

  // The moment lane's own model and effort, checked before any connection.
  it("PI_EXTRACT_MOMENT_MODEL and PI_EXTRACT_MOMENT_EFFORT are checked by extract, check and the moment world check before any connection", async () => {
    const ON = {
      PI_EXTRACT_ANTHROPIC_KEY: "sk-ant-test-not-a-real-key-0000",
      PI_EXTRACT_MODEL: "anthropic/claude-haiku-5-5",
      PI_EXTRACT_EFFORT: "medium",
    };
    const SONNET = { PI_EXTRACT_MOMENT_MODEL: "anthropic/claude-sonnet-5-5", PI_EXTRACT_MOMENT_EFFORT: "medium" };
    for (const argv of [["extract"], ["extract", "check"], ["extract", "check", "--world", "--lane", "moment"]]) {
      await expectRefused(argv, { ...PIPELINE, ...REAL, ...MODEL, ...SONNET }, "bad_env", 1, {
        hint: "set PI_EXTRACT_MOMENT_MODEL",
      });
      await expectRefused(argv, { ...PIPELINE, ...REAL, ...MODEL, PI_EXTRACT_MOMENT_EFFORT: "medium" }, "bad_env", 1, {
        hint: "set PI_EXTRACT_MOMENT_EFFORT",
      });
      await expectRefused(
        argv,
        { ...PIPELINE, ...REAL, ...ON, PI_EXTRACT_MOMENT_MODEL: "openai/gpt-6-luna" },
        "bad_env",
        1,
        { hint: "set PI_EXTRACT_MOMENT_MODEL" },
      );
      await expectRefused(argv, { ...PIPELINE, ...REAL, ...ON, PI_EXTRACT_MOMENT_EFFORT: "xhigh" }, "bad_env", 1, {
        hint: "set PI_EXTRACT_MOMENT_EFFORT",
      });
      // The positive control: the owner's setting goes on to the closed port.
      await expectUnavailable(argv, { ...PIPELINE, ...REAL, ...ON, ...SONNET });
    }
  });

  it("extract check takes --world --lane meeting; PI_EXTRACT_MEETINGS is 1 or unset; a retry never gives the meeting lane", async () => {
    await expectUnavailable(["extract", "check", "--world", "--lane", "meeting"], { ...PIPELINE, ...REAL, ...MODEL });
    await expectRefused(["extract", "check", "--lane", "meeting"], { ...PIPELINE, ...REAL, ...MODEL }, "usage", 2);
    for (const value of ["yes", "0", "true"])
      await expectRefused(["extract"], { ...PIPELINE, ...REAL, ...MODEL, PI_EXTRACT_MEETINGS: value }, "usage", 2);
    await expectUnavailable(["extract"], { ...PIPELINE, ...REAL, ...MODEL, PI_EXTRACT_MEETINGS: "1" });
    await expectRefused(["extract", "retry", "--all", "--lane", "meeting"], { ...ADMIN, ...REAL }, "usage", 2);
    await expectUnavailable(["extract", "retry", "--all", "--lane", "skip"], { ...ADMIN, ...REAL });
  });

  it("PI_EXTRACT_TIME is 1 or unset", async () => {
    for (const value of ["yes", "0", "true"])
      await expectRefused(["extract"], { ...PIPELINE, ...REAL, ...MODEL, PI_EXTRACT_TIME: value }, "usage", 2);
    await expectUnavailable(["extract"], { ...PIPELINE, ...REAL, ...MODEL, PI_EXTRACT_TIME: "1" });
  });

  it("extract check takes --world --lane moment; PI_EXTRACT_MOMENTS is 1 or unset; a retry never gives the moment lane", async () => {
    await expectUnavailable(["extract", "check", "--world", "--lane", "moment"], { ...PIPELINE, ...REAL, ...MODEL });
    await expectRefused(["extract", "check", "--lane", "moment"], { ...PIPELINE, ...REAL, ...MODEL }, "usage", 2);
    await expectRefused(
      ["extract", "check", "--world", "--lane", "moments"],
      { ...PIPELINE, ...REAL, ...MODEL },
      "usage",
      2,
    );
    for (const value of ["yes", "0", "true"])
      await expectRefused(["extract"], { ...PIPELINE, ...REAL, ...MODEL, PI_EXTRACT_MOMENTS: value }, "usage", 2);
    await expectUnavailable(["extract"], { ...PIPELINE, ...REAL, ...MODEL, PI_EXTRACT_MOMENTS: "1" });
    const own = { ...PIPELINE, ...REAL, ...MODEL, PI_EXTRACT_MOMENTS: "1" };
    await expectUnavailable(["extract"], { ...own, PI_EXTRACT_OWN_LINES: "1" });
    await expectUnavailable(["extract"], { ...own, PI_EXTRACT_OWN_LINES: "1", PI_EXTRACT_OWN_LINES_DAY_USD: "0.25" });
    await expectRefused(["extract"], { ...own, PI_EXTRACT_OWN_LINES: "yes" }, "usage", 2);
    await expectRefused(
      ["extract"],
      { ...own, PI_EXTRACT_OWN_LINES: "1", PI_EXTRACT_OWN_LINES_DAY_USD: "lots" },
      "usage",
      2,
    );
    await expectRefused(["extract"], { ...PIPELINE, ...REAL, ...MODEL, PI_EXTRACT_OWN_LINES: "1" }, "usage", 2);
    // Its trial reads no other lane's flags; --show is a terminal's.
    await expectRefused(
      ["extract", "trial", "--own-lines", "--fact-kinds"],
      { ...PIPELINE, ...REAL, ...MODEL },
      "usage",
      2,
    );
    await expectRefused(
      ["extract", "trial", "--own-lines", "--lane", "transaction"],
      { ...PIPELINE, ...REAL, ...MODEL },
      "usage",
      2,
    );
    await expectRefused(
      ["extract", "trial", "--own-lines", "--show", "BAD TYPE"],
      { ...PIPELINE, ...REAL, ...MODEL },
      "usage",
      2,
    );
    await expectRefused(["extract", "retry", "--all", "--lane", "moment"], { ...ADMIN, ...REAL }, "usage", 2);
    await expectRefused(
      ["extract", "retry", "--message", MESSAGE, "--lane", "moment"],
      { ...ADMIN, ...REAL },
      "usage",
      2,
    );
    await expectUnavailable(["extract", "retry", "--all", "--lane", "skip"], { ...ADMIN, ...REAL });
  });

  it("PI_EXTRACT_DOCUMENTS is 1 or unset, and PI_EXTRACT_DOCUMENT_DAYS a whole number of days, or the run is a usage error", async () => {
    for (const extra of [
      { PI_EXTRACT_DOCUMENTS: "yes" },
      { PI_EXTRACT_DOCUMENTS: "0" },
      { PI_EXTRACT_DOCUMENTS: "true" },
      { PI_EXTRACT_DOCUMENT_DAYS: "0" },
      { PI_EXTRACT_DOCUMENT_DAYS: "-7" },
      { PI_EXTRACT_DOCUMENT_DAYS: "1.5" },
      { PI_EXTRACT_DOCUMENT_DAYS: "ninety" },
    ]) {
      await expectRefused(["extract"], { ...PIPELINE, ...REAL, ...MODEL, ...extra }, "usage", 2);
    }
    await expectUnavailable(["extract"], {
      ...PIPELINE,
      ...REAL,
      ...MODEL,
      PI_EXTRACT_DOCUMENTS: "1",
      PI_EXTRACT_DOCUMENT_DAYS: "30",
    });
    await expectUnavailable(["extract"], { ...PIPELINE, ...REAL, ...MODEL, PI_EXTRACT_DOCUMENT_DAYS: "30" });
  });

  // The lanes switched to their fact-kind versions, and the trial.
  it("PI_EXTRACT_FACT_KINDS names known lanes once each, comma-separated, or the run is a usage error", async () => {
    for (const value of [
      "yes",
      "1",
      "correspondence,",
      "correspondence,correspondence",
      "document",
      "Correspondence",
      "meeting moment",
    ]) {
      await expectRefused(["extract"], { ...PIPELINE, ...REAL, ...MODEL, PI_EXTRACT_FACT_KINDS: value }, "usage", 2);
    }
    await expectUnavailable(["extract"], {
      ...PIPELINE,
      ...REAL,
      ...MODEL,
      PI_EXTRACT_FACT_KINDS: "correspondence,transaction,agent,meeting,moment",
    });
    await expectUnavailable(["extract"], { ...PIPELINE, ...REAL, ...MODEL, PI_EXTRACT_FACT_KINDS: "" });
  });

  it("extract trial takes --lane correspondence or transaction and --fact-kinds; --second-degree is correspondence's alone and not with --fact-kinds", async () => {
    for (const argv of [
      ["extract", "trial", "--lane", "meeting"],
      ["extract", "trial", "--lane", "transaction", "--second-degree"],
      ["extract", "trial", "--second-degree", "--fact-kinds"],
      ["extract", "trial", "--lane", "transaction"],
      ["extract", "trial", "--lane", "agent"],
      ["extract", "trial", "--lane", "agent", "--second-degree", "--fact-kinds"],
      ["extract", "trial", "--show", "goal"],
      ["extract", "trial", "--fact-kinds", "--show", "Goal"],
      ["extract", "trial", "--fact-kinds", "--show", "goal,,plan"],
    ]) {
      await expectRefused(argv, { ...PIPELINE, ...REAL, ...MODEL }, "usage", 2);
    }
    // --show prints source words: off a terminal it is refused before anything is read.
    await expectRefused(
      ["extract", "trial", "--fact-kinds", "--show", "goal,plan"],
      { ...PIPELINE, ...REAL, ...MODEL },
      "not_a_terminal",
    );
    for (const argv of [
      ["extract", "trial", "--lane", "transaction", "--fact-kinds", "--sample", "40"],
      ["extract", "trial", "--lane", "correspondence", "--fact-kinds"],
      ["extract", "trial", "--lane", "agent", "--fact-kinds", "--sample", "40"],
      ["extract", "trial", "--lane", "agent", "--fact-kinds", "--replay"],
      ["extract", "trial", "--fact-kinds", "--replay"],
      ["extract", "trial", "--lane", "transaction", "--replay"],
    ]) {
      await expectUnavailable(argv, { ...PIPELINE, ...REAL, ...MODEL });
    }
  });

  it("retry with --override and no --message, or with --lane, is a usage error", async () => {
    for (const argv of [
      ["extract", "retry", "--all", "--override"],
      ["extract", "retry", "--status", "withheld", "--override"],
      ["extract", "retry", "--message", MESSAGE, "--override", "--lane", "correspondence"],
      ["extract", "retry", "--override"],
    ]) {
      await expectRefused(argv, { ...ADMIN, ...REAL }, "usage", 2);
    }
    await expectUnavailable(["extract", "retry", "--message", MESSAGE, "--override"], { ...ADMIN, ...REAL });
  });

  it("a restricted compartment in the compartments setting is refused", async () => {
    // So is a list with a name that is no compartment, or an empty entry.
    for (const value of ["restricted:health", "own,restricted:health", "own,", "Own", "own, employer:example"]) {
      await expectRefused(["extract"], { ...PIPELINE, ...REAL, ...MODEL, PI_EXTRACT_COMPARTMENTS: value }, "usage", 2);
    }
    // The positive control: compartments the key file holds pass, and the run goes on to the
    // closed port.
    await expectUnavailable(["extract"], {
      ...PIPELINE,
      ...REAL,
      ...MODEL,
      PI_EXTRACT_COMPARTMENTS: "own,employer:example",
    });
  });

  it("a budget or a call bound that is not a number is a usage error", async () => {
    for (const extra of [
      { PI_EXTRACT_RUN_USD: "one" },
      { PI_EXTRACT_DAY_USD: "-3" },
      { PI_EXTRACT_MAX_CALLS: "1.5" },
      { PI_EXTRACT_MAX_CALLS: "0x10" },
    ]) {
      await expectRefused(["extract"], { ...PIPELINE, ...REAL, ...MODEL, ...extra }, "usage", 2);
    }
    for (const argv of [
      ["extract", "--max-calls", "0"],
      ["extract", "--max-calls", "ten"],
    ])
      await expectRefused(argv, { ...PIPELINE, ...REAL, ...MODEL }, "usage", 2);
    // One capture item by its cap_ id or its meeting or moment key, and not beside --agent-records.
    const ULID = "01JMMNTSAA0000000000000001";
    for (const capture of ["not-a-capture", `block:${ULID}`, `cap_${ULID.toLowerCase()}`, ""])
      await expectRefused(["extract", "--capture", capture], { ...PIPELINE, ...REAL, ...MODEL }, "usage", 2);
    await expectRefused(
      ["extract", "--capture", `cap_${ULID}`, "--agent-records"],
      { ...PIPELINE, ...REAL, ...MODEL },
      "usage",
      2,
    );
    for (const capture of [`cap_${ULID}`, `meeting:${ULID}`, `moment:${ULID}`])
      await expectUnavailable(["extract", "--capture", capture, "--max-calls", "5"], {
        ...PIPELINE,
        ...REAL,
        ...MODEL,
      });
    await expectUnavailable(["extract"], {
      ...PIPELINE,
      ...REAL,
      ...MODEL,
      PI_EXTRACT_RUN_USD: "0.5",
      PI_EXTRACT_DAY_USD: "0",
      PI_EXTRACT_MAX_CALLS: "50",
    });
  });

  it("a key ceiling that is not dollars with at most six decimals is a usage error for extract and extract check", async () => {
    for (const value of ["twenty", "-20", "1.1234567", "1e3", "20 "]) {
      for (const argv of [["extract"], ["extract", "check"]])
        await expectRefused(argv, { ...PIPELINE, ...REAL, ...MODEL, PI_EXTRACT_KEY_CAP_USD: value }, "usage", 2);
    }
    // The positive control: a ceiling with six decimals goes on to the closed port.
    for (const argv of [["extract"], ["extract", "check"]])
      await expectUnavailable(argv, { ...PIPELINE, ...REAL, ...MODEL, PI_EXTRACT_KEY_CAP_USD: "100.000001" });
  });

  it("a PI_OPENROUTER_KEY_URL that is not loopback makes extract and extract check refuse with bad_env, before any connection", async () => {
    for (const argv of [["extract"], ["extract", "check"]]) {
      for (const value of [
        "https://openrouter.ai/api/v1/key",
        "http://10.0.0.1:80/key",
        "http://127.0.0.1/key",
        "http://localhost:8787/api/v1/key",
      ]) {
        await expectRefused(argv, { ...PIPELINE, ...REAL, ...MODEL, PI_OPENROUTER_KEY_URL: value }, "bad_env", 1, {
          hint: "set PI_OPENROUTER_KEY_URL",
        });
      }
      // The positive controls: a loopback URL, and unset, go on to the closed port.
      await expectUnavailable(argv, {
        ...PIPELINE,
        ...REAL,
        ...MODEL,
        PI_OPENROUTER_KEY_URL: "http://127.0.0.1:8787/api/v1/key",
      });
      await expectUnavailable(argv, { ...PIPELINE, ...REAL, ...MODEL, PI_OPENROUTER_KEY_URL: "" });
    }
  });

  it("models set-key refuses an empty key, and models import-key one that is not set", async () => {
    await expectRefused(["models", "set-key"], { ...ADMIN, ...REAL }, "usage", 2);
    expect(await pi(["models", "set-key"], { ...ADMIN, ...REAL }, { stdin: ["\n"] })).toEqual({
      exit: 2,
      stdout: "",
      stderr: failed("usage"),
    });
    await expectRefused(["models", "import-key"], { ...ADMIN, ...REAL }, "missing_env", 1, {
      hint: "set PI_OPENROUTER_KEY",
    });
    // The positive controls: a key goes on to the closed port, and is on neither stream.
    const result = await pi(["models", "set-key"], { ...ADMIN, ...REAL }, { stdin: ["sentinel-key-7f3a91\n"] });
    expect({ exit: result.exit, stdout: result.stdout }).toEqual({ exit: 1, stdout: "" });
    expect(failureLines(result.stderr).at(-1)).toEqual({ event: "command_failed", code: "unavailable" });
    expect(result.stderr).not.toContain("sentinel-key-7f3a91");
    const imported = await pi(["models", "import-key"], {
      ...ADMIN,
      ...REAL,
      PI_OPENROUTER_KEY: "sentinel-key-7f3a91",
    });
    expect({ exit: imported.exit, stdout: imported.stdout }).toEqual({ exit: 1, stdout: "" });
    expect(imported.stderr).not.toContain("sentinel-key-7f3a91");
  });

  it("models import-key refuses a key that is only whitespace before any connection", async () => {
    for (const blank of [" ", "\t", "  \n "]) {
      await expectRefused(["models", "import-key"], { ...ADMIN, ...REAL, PI_OPENROUTER_KEY: blank }, "missing_env", 1, {
        hint: "set PI_OPENROUTER_KEY",
      });
    }
  });

  it("models import-key gives up on a database that accepts the connection and never answers", async () => {
    // A stalled pi-db: the socket opens and nothing comes back, so only a connect timeout ends it.
    const held: Socket[] = [];
    const server = createServer((socket) => void held.push(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const err: Buffer[] = [];
      const stderr = new Writable({
        write(chunk: Buffer, _encoding, done) {
          err.push(chunk);
          done();
        },
      });
      const started = Date.now();
      const env = {
        PI_DATABASE_URL_ADMIN: `postgres://pi_admin:local-only@127.0.0.1:${port}/pi_test`,
        ...REAL,
        PI_OPENROUTER_KEY: "sentinel-key-7f3a91",
      };
      const exit = await run(
        ["models", "import-key"],
        env,
        {
          stdout: new Writable({ write: (_c, _e, done) => done() }),
          stderr,
          stdin: Readable.from([]),
          stdoutIsTTY: false,
        },
        { importTimeoutMs: 300 },
      );
      expect(exit).toBe(1);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(failureLines(Buffer.concat(err).toString("utf8")).at(-1)).toEqual({
        event: "command_failed",
        code: "unavailable",
      });
      expect(held.length).toBeGreaterThan(0);
    } finally {
      for (const socket of held) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("only models import-key takes the model key from its environment, and no command the reasoner's", async () => {
    // The import is the one command that reads it; every other refuses to start with it set, the
    // commands that open no database or run as the bootstrap role included. The reasoner's key is
    // never pi's to hold.
    const journal = { PI_ERASURE_JOURNAL: "/nonexistent/pi/erasures.jsonl" };
    const commands: [string[], Env][] = [
      [["keys", "init"], {}],
      [["keys", "add-compartment", "employer:example"], {}],
      [["db", "migrate"], { ...BOOTSTRAP, ...ADMIN, ...WRITER, ...READER, ...PIPELINE }],
      [["db", "verifier"], {}],
      [["extract"], { ...PIPELINE, ...REAL, ...MODEL }],
      [["sync"], { ...WRITER, ...REAL }],
      [["mcp"], { ...READER, ...REAL }],
      [["status"], { ...ADMIN, ...REAL }],
      [["models", "set-key"], { ...ADMIN, ...REAL }],
      [["work", "tick"], { ...WORK, ...journal }],
      [["send", "list"], { ...PROXY, ...REAL }],
    ];
    for (const [argv, env] of commands) {
      await expectRefused(argv, { ...env, PI_OPENROUTER_KEY: "sentinel-key-7f3a91" }, "wrong_role_url");
    }
    for (const [argv, env] of [
      ...commands,
      [["models", "import-key"], { ...ADMIN, ...REAL, PI_OPENROUTER_KEY: "sentinel-key-7f3a91" }] as [string[], Env],
    ]) {
      await expectRefused(argv, { ...env, PI_REASONER_MODEL_KEY: "sentinel-reasoner-key-7f3a91" }, "wrong_role_url");
    }
  });
});
