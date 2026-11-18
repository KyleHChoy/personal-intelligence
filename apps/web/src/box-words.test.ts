import { describe, expect, it } from "vitest";
import { boxHealthWords } from "./box-words.ts";

// The detectors' cards in words: each names what it is about as the owner would, and none shows a code.
describe("a detector's box health card in words", () => {
  const account = "acc_01HZX0000000000000000000AA";
  const names = { account: (id: string) => (id === account ? "Work mail" : undefined) };

  it("names the account, the job or the lane, never the kind's code or an id", () => {
    const said = [
      boxHealthWords("stores_nothing", `account/${account}`, names),
      boxHealthWords("stores_nothing", `account/${account}`),
      boxHealthWords("budget_stops", "dream"),
      boxHealthWords("extract_backlog", "extract"),
      boxHealthWords("detector_stopped", "canary"),
    ];
    expect(said.map((one) => one.title)).toEqual([
      "Work mail syncs but has stored nothing for three days",
      "A connected account syncs but has stored nothing for three days",
      "The nightly pass over what is known has stopped on its budget three times in a row",
      "Reading new items has failed on fifty or more in two days",
      "The daily end-to-end check has not run for three days",
    ]);
    expect(JSON.stringify(said)).not.toMatch(/stores_nothing|budget_stops|extract_backlog|detector_stopped|acc_/);
  });

  it("tells a stop at the budget with work left from the first one, with where to see what waits", () => {
    expect(boxHealthWords("budget_stops", "extract")).toMatchObject({
      title: "Reading new items stopped on its budget with work left",
      command: "pia extract status",
    });
  });
});

// The database connection's TLS, the owner's to mend by setting the CA.
describe("an unverified database connection, in words", () => {
  it("says what holds and what does not, and where the step is, with no code", () => {
    const said = boxHealthWords("tls_unverified", "database");
    expect(said.title).toBe("The box's connection to the database checks no certificate");
    expect(said.note).toMatch(/Database TLS/);
    expect(JSON.stringify(said)).not.toMatch(/tls_unverified/);
  });
});

// The box's own wait, which lib/migrate-start raises as the box starts ahead of its schema.
describe("the box's wait for its migration, in words", () => {
  it("says what the box waits for, what is stopped meanwhile and the one command that ends it, with no code", () => {
    const said = boxHealthWords("hold", "migrate_wait");
    expect(said.title).toBe("The box is waiting for its database migration");
    expect(said.note).toMatch(/nothing syncs and your agents get no answers/);
    expect(said.command).toBe("pi-migrate");
    expect(JSON.stringify(said)).not.toMatch(/migrate_wait|read_hold|sync_hold/);
  });

  it("leaves every other hold's words as they were", () => {
    expect(boxHealthWords("hold", "sync_hold")).toEqual({
      title: "The sync hold has been on for over an hour",
      note: "Nothing it stops will run until it is lifted. Lift it when the work it was set for is done.",
      command: "pia status",
    });
  });
});

// A client's own token near its expiry.
describe("a lapsing token's card, in words", () => {
  it("says what lapses and how to rotate it, with no code or id", () => {
    const said = boxHealthWords("token_expiring", "client/cli_01HZX0000000000000000000AA");
    expect(said.title).toBe("A client's token expires within a week");
    expect(said.note).toMatch(/pia clients rotate/);
    expect(said.command).toBe("pia clients list");
    expect(JSON.stringify(said)).not.toMatch(/token_expiring|cli_/);
  });
});
