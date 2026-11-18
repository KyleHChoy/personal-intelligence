import { describe, expect, it } from "vitest";
import { refused, pi as runPi } from "../test-support/run-pi.ts";

// The queue's commands that need no database: every refusal here comes before the key file is read
// or a connection is made. The key file path names nothing, so a body that read it would fail with
// another code.

type Env = Record<string, string>;

const ENV: Env = {
  PI_DATABASE_URL_ADMIN: "postgres://pi_admin:local-only@127.0.0.1:1/pi_test",
  PI_KEY_FILE: "/nonexistent/pi-review-test/keys.json",
};
const CARD = `crd_${"0".repeat(26)}`;

const pi = (argv: string[], tty: boolean) => runPi(argv, ENV, { tty });

describe("the queue's commands", () => {
  it("review and show print nothing when stdout is not a terminal", async () => {
    expect(await pi(["review"], false)).toEqual(refused("not_a_terminal"));
    expect(await pi(["show", CARD], false)).toEqual(refused("not_a_terminal"));
    // The positive control: on a terminal they get as far as the key file.
    expect((await pi(["review"], true)).stderr).not.toContain("not_a_terminal");
    expect((await pi(["show", CARD], true)).stderr).not.toContain("not_a_terminal");
  });

  it("veto add refuses neither an entity nor a kind as usage", async () => {
    expect(await pi(["veto", "add"], false)).toEqual(refused("usage", 2));
    expect(await pi(["veto", "add", "--entity", "not-an-id"], false)).toEqual(refused("usage", 2));
    expect(await pi(["veto", "add", "--kind", "Not A Kind"], false)).toEqual(refused("usage", 2));
    // A word of the right form that is no OpportunityKind, and not the send proxy's `proposal`.
    expect(await pi(["veto", "add", "--kind", "made_up_kind"], false)).toEqual(refused("usage", 2));
    // The positive controls: an OpportunityKind, and `proposal`, get as far as the key file.
    expect((await pi(["veto", "add", "--kind", "follow_up"], false)).stderr).not.toContain('"usage"');
    expect((await pi(["veto", "add", "--kind", "proposal"], false)).stderr).not.toContain('"usage"');
  });

  it("decide, show and veto lift refuse an id or a value of the wrong form as usage", async () => {
    expect(await pi(["decide", "crd_short", "--answer", "acknowledge"], false)).toEqual(refused("usage", 2));
    expect(await pi(["decide", CARD], false)).toEqual(refused("usage", 2));
    expect(await pi(["decide", CARD, CARD, "--answer", "acknowledge"], false)).toEqual(refused("usage", 2));
    expect(await pi(["decide", CARD, "--answer", "acknowledge", "--labels", "correct,nonsense"], false)).toEqual(
      refused("usage", 2),
    );
    expect(await pi(["show", "crd_short"], true)).toEqual(refused("usage", 2));
    expect(await pi(["veto", "lift", "rul_short"], false)).toEqual(refused("usage", 2));
    expect(await pi(["review", "--limit", "51"], true)).toEqual(refused("usage", 2));
    // The positive control.
    expect(
      (await pi(["decide", CARD, "--answer", "acknowledge", "--labels", "correct,novel"], false)).stderr,
    ).not.toContain('"usage"');
  });

  it("decide takes the owner's one-line note of at most 300 code points, and refuses any other as usage", async () => {
    for (const note of ["", "  ", "é".repeat(301), "two\nlines"])
      expect(await pi(["decide", CARD, "--answer", "no_go", "--note", note], false), JSON.stringify(note)).toEqual(
        refused("usage", 2),
      );
    // The positive control: a note of 300 code points gets as far as the key file.
    for (const note of ["process, not progress", "é".repeat(300)])
      expect((await pi(["decide", CARD, "--answer", "no_go", "--note", note], false)).stderr).not.toContain('"usage"');
  });

  // The owner's decline reason, from the closed list, on a no only.
  it("decide takes --reason from the list on a no, and refuses another word or another answer as usage", async () => {
    for (const [answer, reason] of [
      ["no_go", "bad_idea"],
      ["no_go", ""],
      ["go", "wrong_timing"],
      ["later", "other"],
      ["confirm", "other"],
    ]) {
      expect(
        await pi(["decide", CARD, "--answer", answer as string, "--reason", reason as string], false),
        `${answer} ${reason}`,
      ).toEqual(refused("usage", 2));
    }
    // The positive control: a reason on a no, with or without a note, gets as far as the key file.
    for (const args of [
      ["--answer", "no_go", "--reason", "wrong_timing"],
      ["--answer", "no", "--reason", "not_worth_it", "--note", "a newsletter is not the point"],
      ["--answer", "reject", "--reason", "wrong_person"],
    ]) {
      expect((await pi(["decide", CARD, ...args], false)).stderr, args.join(" ")).not.toContain('"usage"');
    }
  });

  // A task's cancel takes the same reason.
  it("work cancel takes --reason from the list, and refuses another word as usage", async () => {
    const task = "opp_01J9ZZZZZZZZZZZZZZZZZZZZZA";
    for (const reason of ["bad_idea", ""])
      expect(await pi(["work", "cancel", task, "--reason", reason], false), reason).toEqual(refused("usage", 2));
    expect((await pi(["work", "cancel", task, "--reason", "wrong_timing"], false)).stderr).not.toContain('"usage"');
  });

  // Work an agent holds, freed: one id of a piece of work, and nothing else.
  it("work free takes one opportunity's id, and refuses none, two or another word as usage", async () => {
    const task = "opp_01J9ZZZZZZZZZZZZZZZZZZZZZA";
    for (const args of [[], [task, task], ["the-task"], [task, "--reason", "wrong_timing"]])
      expect(await pi(["work", "free", ...args], false), args.join(" ")).toEqual(refused("usage", 2));
    expect((await pi(["work", "free", task], false)).stderr).not.toContain('"usage"');
  });
});
