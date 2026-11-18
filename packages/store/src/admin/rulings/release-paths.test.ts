import { describe, expect, it } from "vitest";
import { storeFiles, storeText } from "../../test-support/sources.ts";

// Invariant 4: the release happens only through an owner decision. One statement
// writes a release (release.ts), called from the owner's confirm (card-kinds-claims.ts, a card kind's
// effect, which only the admin's decide runs) and from `pia facts release` and `pi correct lift`
// (admin-release.ts) alone. The store's modules import one another widely, so what keeps the agent
// API from the release is the database: pi_reader, the reader's role, holds no right on
// knowledge.claim_releases, and only pi_admin does. That half is in
// apps/pi/src/agents/inv4-claim-release.db.test.ts.
const sources = storeFiles().filter((name) => !name.includes(".test."));
const text = storeText;
// A module's relative imports that run code: `import type` and `export type` left out.
const importsOf = (name: string): string[] =>
  [...text(name).matchAll(/^(?:import|export) (?!type )[^;]*?from "(?:\.{1,2}\/)+(?:[\w-]+\/)*([^"/]+\.ts)";/gms)].map(
    (match) => match[1] as string,
  );

describe("who may release", () => {
  it("one statement writes a release, in release.ts", () => {
    expect(sources.filter((name) => /insert\s+into\s+knowledge\.claim_releases/.test(text(name)))).toEqual([
      "release.ts",
    ]);
    // release.ts ends a release whose decision is no longer in force before another; admin-erase-replay.ts
    // lifts a release again when it replays its journalled lift; admin-grants.ts lifts every
    // release a standing grant made, at the owner's lift.
    // A grant's own release is written by the database (policy.grant_release), never by a module.
    expect(sources.filter((name) => /update\s+knowledge\.claim_releases/.test(text(name))).sort()).toEqual([
      "admin-erase-replay.ts",
      "admin-grants.ts",
      "admin-release.ts",
      "release.ts",
    ]);
  });

  it("only the owner's confirm and the owner's command call it", () => {
    expect(sources.filter((name) => importsOf(name).includes("release.ts")).sort()).toEqual([
      "admin-release.ts",
      "card-kinds-claims.ts",
    ]);
    // The Admin's releases sub-object (rulings-group.ts) belongs to the owner's command.
    expect(sources.filter((name) => importsOf(name).includes("admin-release.ts")).sort()).toEqual([
      "admin-rulings.ts",
      "rulings-group.ts",
    ]);
  });

  // admin-self.ts reads mail's claims alone, and work-run-planner.ts's VISIBLE_CLAIM serves the reasoner,
  // which reads only a claim whose agent record it reads itself and holds no grant on the releases.
  it("every reader query that serves an agent record's claim takes a released one only while its release is in force", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: counts the literal interpolation as it is written in the source files
    const uses = (name: string): number => text(name).split("${RELEASE_IN_FORCE}").length - 1;
    expect({
      facts: uses("read-fact-rows.ts") + uses("read-facts.ts") + uses("read-compiled.ts"),
      paths: uses("read-paths.ts"),
      mirror: uses("mirror-sections.ts"),
      evidence: uses("read-evidence.ts"),
      // The relation claims read-named.ts serves take RELATION_SEEN, kept in read-fragments.ts; the
      // claims that make a named organization seen take ORGANIZATION_CLAIM_SEEN, whose contact arm
      // states the rule again.
      named: uses("read-fragments.ts"),
    }).toEqual({ facts: 5, paths: 2, mirror: 2, evidence: 2, named: 2 });
  });

  it("a card kind's effect, the confirm's release among them, is run by the admin's decide alone", () => {
    expect(sources.filter((name) => /\.effect\(/.test(text(name)))).toEqual(["admin-queue.ts"]);
    expect(text("admin-queue.ts")).toMatch(/export async function decide\(\s*admin: AdminContext/);
  });
});
