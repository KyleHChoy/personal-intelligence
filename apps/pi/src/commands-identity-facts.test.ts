import { describe, expect, it } from "vitest";
import {
  ADMIN,
  BOOTSTRAP,
  built,
  ENTITY,
  expectBodyReached,
  expectReached,
  expectRefused,
  expectUnavailable,
  FACT,
  IDENTITY_COMMANDS,
  KEYS,
  MENTION,
  O4_REST_COMMANDS,
  OTHER_ENTITY,
  PIPELINE,
  PROXY,
  READER,
  REAL,
  RULING,
  useRealKeyFile,
  WORK,
  WRITER,
} from "./test-support/commands-fixtures.ts";

useRealKeyFile();

describe("pi", () => {
  // Contacts and identity, "Commands": ids, never an address, so nothing of a person is in a
  // shell's history.
  it("an address given where an id is wanted is a usage error", async () => {
    const address = "sam.orrin@example.com";
    for (const argv of [
      ["identity", "link", address, OTHER_ENTITY],
      ["identity", "link", ENTITY, address],
      ["identity", "differ", address, OTHER_ENTITY],
      ["identity", "share", address],
      ["identity", "lift", address],
      ["identity", "lift", ENTITY],
      ["identity", "link", ENTITY],
      ["contacts", "remove", address],
      // A mention, a person and a binding by their ids, and a limit of 1 to 50.
      ["identity", "bind", address, ENTITY],
      ["identity", "bind", MENTION, address],
      ["identity", "bind", ENTITY, MENTION],
      ["identity", "bind", MENTION],
      ["identity", "unbind", MENTION],
      ["identity", "mentions", "--limit", "0"],
      ["identity", "mentions", "--limit", "51"],
      ["identity", "mentions", "--limit", "ten"],
      ["identity", "refile", MENTION],
      ["org", "name", "alder.example", "Alder Works"],
      ["org", "name", ENTITY],
    ]) {
      await expectRefused(argv, { ...ADMIN, ...REAL }, "usage", 2);
    }
    // The positive control: ids reach the body, which fails at the closed port.
    for (const argv of IDENTITY_COMMANDS) await expectUnavailable(argv, { ...ADMIN, ...REAL });
  });

  it("an identity command refuses a client token", async () => {
    for (const argv of IDENTITY_COMMANDS)
      await expectRefused(argv, { ...ADMIN, ...KEYS, PI_CLIENT_TOKEN: "sentinel-token-7f3a91" }, "wrong_role_url");
  });

  it("sync takes --reset contacts, and google connect --contacts needs no client in the environment", async () => {
    await expectUnavailable(["sync", "--reset", "contacts"], { ...WRITER, ...REAL });
    await expectRefused(["sync", "--reset", "people"], { ...WRITER, ...REAL }, "usage", 2);
    await expectUnavailable(["google", "connect", "--account", "personal", "--contacts"], { ...ADMIN, ...REAL });
    // The mail grant still requires it.
    await expectRefused(["google", "connect", "--account", "personal"], { ...ADMIN, ...REAL }, "missing_env", 1, {
      hint: "set PI_GOOGLE_CLIENT_ID",
    });
  });

  it("each new command of corrections-and-digest is found by its two words and refuses a client token", async () => {
    for (const argv of O4_REST_COMMANDS) {
      for (const extra of [
        { PI_CLIENT_TOKEN: "sentinel-token-7f3a91" },
        BOOTSTRAP,
        WRITER,
        READER,
        PIPELINE,
        PROXY,
        WORK,
      ]) {
        await expectRefused(argv, { ...ADMIN, ...KEYS, ...extra }, "wrong_role_url", 1, { tty: true });
      }
      // The positive control: the admin URL alone reaches the command's body, a stub, or the
      // database for a built command.
      await expectBodyReached(argv, { ...ADMIN, ...REAL }, { tty: true });
      // Two words given as one argument are no command.
      if (argv.length > 1)
        await expectRefused([`${argv[0]} ${argv[1]}`, ...argv.slice(2)], { ...ADMIN, ...REAL }, "usage", 2, {
          tty: true,
        });
    }
    // A command takes its own count of arguments.
    await expectRefused(["correct", "reject"], { ...ADMIN, ...REAL }, "usage", 2, { tty: true });
    await expectRefused(["correct", "list", FACT], { ...ADMIN, ...REAL }, "usage", 2, { tty: true });
    await expectRefused(["digest", "now"], { ...ADMIN, ...REAL }, "usage", 2, { tty: true });
  });

  it("facts show and web link refuse when stdout is not a terminal", async () => {
    await expectRefused(["facts", "show", FACT], { ...ADMIN, ...REAL }, "not_a_terminal");
    // The positive control: a terminal reaches the body.
    await expectBodyReached(["facts", "show", FACT], { ...ADMIN, ...REAL }, { tty: true });
    // `web link` asks the running server, and none runs here.
    await expectRefused(["web", "link"], { ...ADMIN, ...REAL }, "not_a_terminal");
    await expectRefused(["web", "link"], { ...ADMIN, ...REAL }, "web_not_running", 1, { tty: true });
    // The other nine are not terminal-only: pi digest and pi web serve among them.
    for (const argv of O4_REST_COMMANDS.filter((one) => one[0] !== "facts"))
      await expectBodyReached(argv, { ...ADMIN, ...REAL });
    await expectRefused(["web", "stop"], { ...ADMIN, ...REAL }, "web_not_running", 1);
  });

  it("facts show, correct reject, veto and lift refuse an argument of the wrong form before anything is read", async () => {
    for (const argv of [
      ["facts", "show", "not-a-fact"],
      ["correct", "reject", FACT.toUpperCase()],
      ["correct", "veto", "crd_x"],
      ["correct", "lift", FACT],
    ]) {
      await expectRefused(argv, { ...ADMIN, ...REAL }, "usage", 2, { tty: true });
    }
    // The control: the right forms reach the database.
    await expectReached(["correct", "lift", RULING], { ...ADMIN, ...REAL });
  });

  // The owner's review and retire, and several facts in one ruling command.
  it("self review is terminal-only and checks its filters, and reject and retire take one fact or many, each checked before anything is read", async () => {
    await expectRefused(["self", "review"], { ...ADMIN, ...REAL }, "not_a_terminal");
    await expectReached(["self", "review"], { ...ADMIN, ...REAL }, { tty: true });
    await expectReached(
      ["self", "review", "--kind", "goal", "--status", "retired"],
      { ...ADMIN, ...REAL },
      { tty: true },
    );
    for (const argv of [
      ["self", "review", "--kind", "wish"],
      ["self", "review", "--status", "gone"],
      ["self", "review", FACT],
    ]) {
      await expectRefused(argv, { ...ADMIN, ...REAL }, "usage", 2, { tty: true });
    }
    const other = "d".repeat(64);
    for (const verb of [
      ["correct", "reject"],
      ["self", "retire"],
    ]) {
      await expectRefused(verb, { ...ADMIN, ...REAL }, "usage", 2);
      await expectRefused([...verb, FACT, "not-a-fact"], { ...ADMIN, ...REAL }, "usage", 2);
      await expectReached([...verb, FACT], { ...ADMIN, ...REAL });
      await expectReached([...verb, FACT, other], { ...ADMIN, ...REAL });
      await expectRefused([...verb, FACT], { ...ADMIN, ...KEYS, ...READER }, "wrong_role_url");
    }
  });

  it("no command of corrections-and-digest is a stub any more", () => {
    expect(O4_REST_COMMANDS.filter((one) => !built(one))).toEqual([]);
  });
});
