import type { ProjectStatusBy } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { projectStanding, type StatusWord } from "./project-status.ts";

// A project's status: the owner's word first, then a source's, then an agent's, the latest within a
// tier.

const OWNER: ProjectStatusBy = { kind: "owner" };
const MAIL: ProjectStatusBy = { kind: "source", who: null };
const SCOUT: ProjectStatusBy = { kind: "agent", client: "scout" };
const CLERK: ProjectStatusBy = { kind: "agent", client: "clerk" };

const word = (tier: StatusWord["tier"], value: StatusWord["value"], at: string, by: ProjectStatusBy): StatusWord => ({
  tier,
  value,
  at,
  by,
});

const created = { at: "2026-01-01T00:00:00Z", by: SCOUT };

describe("a project's status", () => {
  it("is active from its creation when nobody has said anything", () => {
    expect(projectStanding({ created, words: [] })).toEqual({ value: "active", asOf: created.at, by: SCOUT });
  });

  it("is the latest word within a tier", () => {
    const standing = projectStanding({
      created,
      words: [
        word("agent", "blocked", "2026-01-03T00:00:00Z", SCOUT),
        word("agent", "waiting", "2026-01-05T00:00:00Z", CLERK),
        word("agent", "planned", "2026-01-02T00:00:00Z", SCOUT),
      ],
    });
    expect(standing).toEqual({ value: "waiting", asOf: "2026-01-05T00:00:00Z", by: CLERK });
  });

  it("takes a source's word over an agent's whichever came first, and shows both with their times", () => {
    const agent = word("agent", "blocked", "2026-01-03T00:00:00Z", SCOUT);
    const mail = word("source", "active", "2026-01-04T00:00:00Z", MAIL);
    const shown = {
      value: "active",
      asOf: mail.at,
      by: MAIL,
      disputedBy: [{ value: "blocked", asOf: agent.at, by: SCOUT }],
    };
    expect(projectStanding({ created, words: [agent, mail] })).toEqual(shown);
    // The agent's later word still does not outrank the source's.
    const later = word("agent", "blocked", "2026-01-09T00:00:00Z", SCOUT);
    expect(projectStanding({ created, words: [mail, later] })).toEqual({
      ...shown,
      disputedBy: [{ value: "blocked", asOf: later.at, by: SCOUT }],
    });
  });

  it("takes the owner's word over both", () => {
    const standing = projectStanding({
      created,
      words: [
        word("agent", "blocked", "2026-01-03T00:00:00Z", SCOUT),
        word("source", "active", "2026-01-04T00:00:00Z", MAIL),
        word("owner", "paused", "2026-01-02T00:00:00Z", OWNER),
      ],
    });
    expect(standing).toEqual({
      value: "paused",
      asOf: "2026-01-02T00:00:00Z",
      by: OWNER,
      disputedBy: [
        { value: "active", asOf: "2026-01-04T00:00:00Z", by: MAIL },
        { value: "blocked", asOf: "2026-01-03T00:00:00Z", by: SCOUT },
      ],
    });
  });

  it("shows no dispute when the other tiers agree", () => {
    const standing = projectStanding({
      created,
      words: [
        word("agent", "active", "2026-01-03T00:00:00Z", SCOUT),
        word("source", "active", "2026-01-04T00:00:00Z", MAIL),
      ],
    });
    expect(standing).toEqual({ value: "active", asOf: "2026-01-04T00:00:00Z", by: MAIL });
  });

  it("is closed by the owner's close whatever an agent says, and shows only what was said after it", () => {
    const closed = { at: "2026-02-01T00:00:00Z" };
    const before = word("agent", "active", "2026-01-20T00:00:00Z", SCOUT);
    expect(projectStanding({ created, closed, words: [before] })).toEqual({
      value: "closed",
      asOf: closed.at,
      by: OWNER,
    });
    const after = word("agent", "active", "2026-02-03T00:00:00Z", SCOUT);
    expect(projectStanding({ created, closed, words: [before, after] })).toEqual({
      value: "closed",
      asOf: closed.at,
      by: OWNER,
      disputedBy: [{ value: "active", asOf: after.at, by: SCOUT }],
    });
  });

  it("breaks a tie in time the same way whatever order the words come in", () => {
    const a = word("agent", "blocked", "2026-01-03T00:00:00Z", CLERK);
    const b = word("agent", "waiting", "2026-01-03T00:00:00Z", SCOUT);
    expect(projectStanding({ created, words: [a, b] })).toEqual(projectStanding({ created, words: [b, a] }));
  });

  it("does not count the creation as a word once anyone has spoken", () => {
    const standing = projectStanding({ created, words: [word("agent", "planned", "2026-01-02T00:00:00Z", CLERK)] });
    expect(standing).toEqual({ value: "planned", asOf: "2026-01-02T00:00:00Z", by: CLERK });
  });
});
