import { describe, expect, it } from "vitest";
import { storeFiles, storeText } from "../test-support/sources.ts";

const admins = storeFiles().filter((name) => /^(admin|owner)-.*\.ts$/.test(name) && !name.includes(".test."));
const text = storeText;

// The names a module imports at run time from each reader module (`read-*.ts`); `import type` and
// `type` names left out, since a type runs no statement.
function readerImports(name: string): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const match of text(name).matchAll(
    /^import (?!type )\{([^}]*)\} from "(?:\.{1,2}\/)+(?:[\w-]+\/)*(read-[^"/]+\.ts)";/gm,
  )) {
    const names = (match[1] as string)
      .split(",")
      .map((one) => one.trim())
      .filter((one) => one !== "" && !one.startsWith("type "));
    if (names.length > 0) found[match[2] as string] = [...(found[match[2] as string] ?? []), ...names].sort();
  }
  return found;
}

// The shared helpers an owner read may take from a reader module: none runs a statement, or (the
// owner's zone) reads a row no viewer's policy narrows.
const PURE: Readonly<Record<string, readonly string[]>> = {
  // SQL text over the definers that serve closes and reopens, each stating its audience as $1, and
  // the newest of their rows.
  "read-beliefs.ts": ["AGENT_CLOSES", "OWNER_CLOSES", "OWNER_REOPENS", "dueAt", "reopenedAtOf"],
  "read-ctx.ts": ["Unavailable", "untrusted"],
  "read-fact-rows.ts": ["VALID_TO_TYPES", "passageOf", "servedField"],
  // SQL text only: whether a claim's release is in force.
  "read-fragments.ts": ["RELEASE_IN_FORCE"],
  // Groups from ruling rows the owner read states itself, and a group's line from its warmth rows.
  "read-groups.ts": ["groupsFromRows"],
  // And the warmth table's column list: text, no statement.
  "read-warmth.ts": ["WARMTH_COLUMNS", "groupLine"],
  "read-search.ts": ["normalized"],
  // A project row's column list and the statement of its events: text, which the owner's read
  // sends under pi_admin, whose policies return every row.
  "read-project-status.ts": ["PROJECT_COLUMNS", "PROJECT_EVENTS"],
  // A meeting row's column list and an all-day event's days: text and arithmetic, no statement.
  "read-who.ts": ["MEETING_COLUMNS", "daysOf"],
};

// Reads that existed before this check and still run a reader statement under pi_admin, each with
// the names it takes. The owner's entity page compiles facts as get_entity does; a rendered fact
// names its people through whoOf, with `within` for a declassification. Each leaves this list when
// it moves to admin-owner.ts's foundation; one joins it only as an owner read merged onto the
// reader's one read, whose statements then state the owner's audience on every table they read.
const KNOWN: Readonly<Record<string, Record<string, string[]>>> = {
  "admin-entity-page.ts": {
    "read-compiled.ts": ["compiledFactsOf"],
    "read-groups.ts": ["loadGroups"],
    "read-who.ts": ["whoOf"],
  },
  "admin-rulings.ts": { "read-who.ts": ["whoOf"] },
  // A role's or affiliation's organization named in its Self line, by the same lookup the opened
  // fact uses (admin-rulings.ts renderFact).
  "admin-self.ts": { "read-who.ts": ["whoOf"] },
  "admin-people-graph.ts": { "read-paths.ts": ["loadPathHops"] },
  "admin-people-network.ts": { "read-observed.ts": ["loadObservedHops"] },
  "admin-open-items.ts": { "read-open-items.ts": ["readOpenItems", "servedOpenItems"] },
  "admin-backtest.ts": { "read-next.ts": ["nextMovesOf"] },
  "admin-agent-records.ts": { "read-agent-record.ts": ["BET_COLUMNS", "RECORD_COLUMNS"] },
  "admin-commitments.ts": { "read-beliefs.ts": ["commitmentItems", "lapsedCommitments", "openCommitments"] },
};

describe("owner reads", () => {
  it("no admin file imports a reader statement, but the listed pure helpers and the known reads", () => {
    const offending: Record<string, Record<string, string[]>> = {};
    for (const name of admins) {
      for (const [module, names] of Object.entries(readerImports(name))) {
        const allowed = new Set([...(PURE[module] ?? []), ...(KNOWN[name]?.[module] ?? [])]);
        const bad = names.filter((one) => !allowed.has(one));
        if (bad.length > 0) offending[name] = { ...offending[name], [module]: bad };
      }
    }
    expect(offending).toEqual({});
  });

  it("the known reads still import what they are listed with, so a fixed one leaves the list", () => {
    for (const [name, modules] of Object.entries(KNOWN)) {
      const imported = readerImports(name);
      for (const [module, names] of Object.entries(modules))
        expect(imported[module] ?? []).toEqual(expect.arrayContaining(names));
    }
  });

  it("the check sees a reader import", () => {
    expect(readerImports("admin-entity-page.ts")["read-who.ts"]).toEqual(["whoOf"]);
  });

  it("the standing check computes beliefs in its own audience alone, and only whether one exists", () => {
    const source = text("admin-canary.ts");
    expect(source).toMatch(/const AUDIENCE = \[\.\.\.CANARY_CLEARANCE\]\.sort\(\);/);
    expect(source).toMatch(/readBeliefInputsUnder\(tx\.query, tx\.keys, AUDIENCE, facts, asOf\)/);
    expect(source).toMatch(/beliefAt\(inputs, AUDIENCE, facts, asOf\)\.some\(/);
  });

  // A shared statement escapes the check above, which sees only modules named read-*.ts, so what an
  // owner read may import from core/statements.ts or core/zone.ts must itself name no reader's filter.
  it("the shared statements name no reader's policy", () => {
    expect(text("statements.ts")).not.toMatch(/policy\.|current_client|released_records|row_security/);
    // zone.ts reads policy.owner_settings, the one table of that schema no viewer's rows narrow.
    expect(text("zone.ts").replaceAll("policy.owner_settings", "")).not.toMatch(
      /policy\.|current_client|released_records|row_security/,
    );
  });
});
