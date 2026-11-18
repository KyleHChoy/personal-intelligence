import type { CommitmentList } from "@intelligence/contracts/personal";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { createReader } from "@intelligence/personal-store";
import { queryAs } from "@intelligence/personal-store/testing";
import { afterAll, describe, expect, it, vi } from "vitest";
import { builtOnce, findFacts, pi, quiet, type Synced, withAdmin } from "../test-support/extract-fixtures.ts";

// The owner's corrections and fact vetoes through `pi`: the commands' output, and the rulings reaching
// beliefs through a real `pi extract` on the synthetic world, read back by the read tools' get_commitments.

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const made: Synced[] = [];
afterAll(async () => {
  for (const one of made.splice(0)) await one.drop();
});

// The world synced and extracted once, with a client for each audience: built once for the file,
// and each test gets a copy, the clients' tokens with it.
const extractedOnce = builtOnce(async (s) => {
  const client = (name: string, compartments: string[]) =>
    withAdmin(
      s.db,
      async (admin) =>
        (
          await admin.clients.addClient({
            name,
            runtime: "local",
            vendorRetention: "unknown",
            compartments,
            views: ["self", "people", "work"],
            tools: ["get_self", "find_facts", "get_commitments"],
          })
        ).token,
    );
  const own = await client("own", ["own"]);
  const both = await client("both", ["own", "employer:example"]);
  await extract(s);
  return { own, both };
});
type Extracted = Synced & { own: string; both: string };
async function extracted(): Promise<Extracted> {
  const { s, made: tokens } = await extractedOnce();
  made.push(s);
  return { ...s, ...tokens };
}

async function extract(s: Synced): Promise<void> {
  const result = await pi(["extract"], s.pipeline, { deps: { model: fakeModelClient(s.outputs) } });
  expect(result.exit, result.stderr).toBe(0);
}

async function commitments(
  s: Synced,
  token: string,
  state: "open" | "closed" | "any",
): Promise<CommitmentList["commitments"]> {
  const reader = createReader({ url: s.db.urls.reader, keys: s.db.keys, log: quiet });
  try {
    const outcome = await reader.getCommitments(token, { state, limit: 50 });
    if (!outcome.ok) throw new Error(`get_commitments answered ${outcome.code}`);
    return outcome.value.commitments;
  } finally {
    await reader.close();
  }
}

// get_self as a client reads it: every belief about the owner computed under its clearance, with
// the time of the read left out.
async function selfOf(s: Synced, token: string): Promise<unknown> {
  const reader = createReader({ url: s.db.urls.reader, keys: s.db.keys, log: quiet });
  try {
    const outcome = await reader.getSelf(token);
    if (!outcome.ok) throw new Error(`get_self answered ${outcome.code}`);
    const { work, ...rest } = outcome.value;
    return { ...rest, work: work === undefined ? work : { ...work, asOf: undefined } };
  } finally {
    await reader.close();
  }
}

// A claim of a fact key, by its stored id: the id find_facts gives and the commands take.
const claimOf = async (s: Synced, factKeyFp: string): Promise<string> =>
  (
    await queryAs<{ id: string }>(
      s.db.urls.admin,
      "select id from knowledge.claims where fact_key_fp = $1 order by id limit 1",
      [factKeyFp],
    )
  )[0]?.id ?? "";

// The claims of a fact key's belief computed under a client's clearance, as find_facts serves them
// with `belief`: none when that clearance builds no belief of the key.
async function supportUnder(s: Synced, token: string, factKeyFp: string): Promise<string[]> {
  const reader = createReader({ url: s.db.urls.reader, keys: s.db.keys, log: quiet });
  try {
    const outcome = await reader.findFacts(token, { belief: factKeyFp as never, limit: 50 });
    return outcome.ok ? outcome.value.facts.map((one) => one.id) : [];
  } finally {
    await reader.close();
  }
}

// A commitment's claim in the support of the belief computed for the own client, with its fact key:
// other kinds build beliefs too, and these tests read a commitment. find_facts gives a claim a
// status only when it is in that belief's support.
async function supported(s: Extracted): Promise<{ id: string; factKeyFp: string }> {
  const [id] = (await findFacts(s.db, s.own, { type: "commitment" })).facts
    .filter((one) => one.status !== undefined)
    .map((one) => one.id)
    .sort();
  if (id === undefined) throw new Error("the world has a belief");
  return { id, factKeyFp: await factKeyOf(s, id) };
}

const factKeyOf = async (s: Synced, claim: string): Promise<string> =>
  (
    await queryAs<{ fact_key_fp: string }>(s.db.urls.admin, "select fact_key_fp from knowledge.claims where id = $1", [
      claim,
    ])
  )[0]?.fact_key_fp ?? "";

// A refusal: exit 1, nothing on stdout, and the command's code as the last line on stderr.
function expectRefused(result: { exit: number; stdout: string; stderr: string }, code: string): void {
  expect({ exit: result.exit, stdout: result.stdout }).toEqual({ exit: 1, stdout: "" });
  expect(result.stderr.endsWith(`${JSON.stringify({ event: "command_failed", code })}\n`), result.stderr).toBe(true);
}

// How many of the clients' clearances (own; own and the employer) compute a belief whose support
// holds the claim.
const supporting = async (s: Extracted, claim: string): Promise<number> => {
  const factKeyFp = await factKeyOf(s, claim);
  let n = 0;
  for (const token of [s.own, s.both]) if ((await supportUnder(s, token, factKeyFp)).includes(claim)) n += 1;
  return n;
};

describe("pi correct and pi facts show", () => {
  it("reject prints the ruling id and no content", async () => {
    const s = await extracted();
    const { id } = await supported(s);
    const fact = (await findFacts(s.db, s.own, { type: "commitment" })).facts.find((one) => one.id === id);
    const words = fact?.type === "commitment" ? fact.fields.what.untrusted : "";
    expect(words.length).toBeGreaterThan(0);

    const result = await pi(["correct", "reject", id], s.admin);
    expect(result.exit, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/^\{"ruling":"rul_[0-9A-HJKMNP-TV-Z]{26}"\}\n$/);
    expect(result.stdout).not.toContain(words);
    // A second reject of the claim is refused, with its code alone.
    expectRefused(await pi(["correct", "reject", id], s.admin), "already_ruled");
  });

  it("facts show prefixes a source line and leaves a code line bare", async () => {
    const s = await extracted();
    const { id } = await supported(s);
    const shown = await pi(["facts", "show", id], s.admin, { tty: true });
    expect(shown.exit, shown.stderr).toBe(0);
    const lines = shown.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe(`fact: ${id}`);
    expect(lines).toContain("type: commitment");
    expect(lines.some((line) => line.startsWith("beliefs: "))).toBe(true);
    // What the claim holds is the source's, and marked so.
    const what = lines.filter((line) => line.includes("what: "));
    expect(what).toHaveLength(1);
    expect(what[0]).toMatch(/^source: what: "/);
    expect(
      lines.filter(
        (line) => line.startsWith("subject: ") || line.startsWith("what: ") || line.startsWith("counterparty: "),
      ),
    ).toEqual([]);
    // An unknown claim is not_found.
    expectRefused(await pi(["facts", "show", "f".repeat(64)], s.admin, { tty: true }), "not_found");
  });

  it("list prints ids, verdicts and times only, and lift prints nothing", async () => {
    const s = await extracted();
    const { id, factKeyFp } = await supported(s);
    const reject = (JSON.parse((await pi(["correct", "reject", id], s.admin)).stdout) as { ruling: string }).ruling;
    const veto = (JSON.parse((await pi(["correct", "veto", id], s.admin)).stdout) as { ruling: string }).ruling;
    const listed = await pi(["correct", "list"], s.admin);
    expect(listed.exit).toBe(0);
    const rows = JSON.parse(listed.stdout) as Record<string, unknown>[];
    expect(rows.map((row) => Object.keys(row).sort())).toEqual([
      ["at", "claim", "claimGone", "factKey", "id", "liftedAt", "verdict"],
      ["at", "claim", "claimGone", "factKey", "id", "liftedAt", "verdict"],
    ]);
    expect(
      rows.map(({ id: ruling, verdict, claim, factKey, liftedAt, claimGone }) => ({
        ruling,
        verdict,
        claim,
        factKey,
        liftedAt,
        claimGone,
      })),
    ).toEqual([
      { ruling: reject, verdict: "reject", claim: id, factKey: factKeyFp, liftedAt: null, claimGone: false },
      { ruling: veto, verdict: "veto", claim: id, factKey: factKeyFp, liftedAt: null, claimGone: false },
    ]);

    expect(await pi(["correct", "lift", veto], s.admin)).toEqual({ exit: 0, stdout: "", stderr: "" });
    expectRefused(await pi(["correct", "lift", veto], s.admin), "not_found");
    expect(
      (JSON.parse((await pi(["correct", "list"], s.admin)).stdout) as { liftedAt: string | null }[]).map(
        (row) => row.liftedAt === null,
      ),
    ).toEqual([true, false]);
  });
});

describe("rulings in the belief build, through pi extract", () => {
  it("a rejected claim counts in no belief after the next pi extract, and find_facts still returns it", async () => {
    const s = await extracted();
    const { id } = await supported(s);
    expect(await supporting(s, id)).toBeGreaterThan(0);
    expect((await pi(["correct", "reject", id], s.admin)).exit).toBe(0);
    expect(await supporting(s, id)).toBe(0);
    await extract(s);
    expect(await supporting(s, id)).toBe(0);
    const fact = (await findFacts(s.db, s.own, { type: "commitment" })).facts.find((one) => one.id === id);
    expect(fact).toBeDefined();
    expect(fact?.status).toBeUndefined();
  });

  it("get_commitments serves a vetoed commitment as closed, and a lift opens it again", async () => {
    const s = await extracted();
    const open = await commitments(s, s.own, "open");
    const [first] = open;
    if (first === undefined) throw new Error("the world has an open commitment");
    const factKeyFp = first.belief.fact;
    const claim = await claimOf(s, factKeyFp);

    const veto = (JSON.parse((await pi(["correct", "veto", claim], s.admin)).stdout) as { ruling: string }).ruling;
    // The veto closes it at once: every belief is computed when asked, with no run between.
    expect((await commitments(s, s.own, "open")).map((one) => one.belief.fact)).not.toContain(factKeyFp);
    expect((await commitments(s, s.own, "closed")).find((one) => one.belief.fact === factKeyFp)?.belief.status).toBe(
      "closed",
    );
    await extract(s);
    for (const token of [s.own, s.both]) {
      expect((await commitments(s, token, "open")).map((one) => one.belief.fact)).not.toContain(factKeyFp);
      const closed = (await commitments(s, token, "closed")).find((one) => one.belief.fact === factKeyFp);
      expect(closed?.belief.status).toBe("closed");
    }
    // The control: the other open commitments are still open.
    expect((await commitments(s, s.own, "open")).map((one) => one.belief.fact)).toEqual(
      open.map((one) => one.belief.fact).filter((fact) => fact !== factKeyFp),
    );

    expect((await pi(["correct", "lift", veto], s.admin)).exit).toBe(0);
    await extract(s);
    expect((await commitments(s, s.own, "open")).find((one) => one.belief.fact === factKeyFp)?.belief.status).toBe(
      first.belief.status,
    );
  });

  it("a ruling outside an audience's clearance changes nothing that audience reads", async () => {
    const s = await extracted();
    const [work] = await queryAs<{ id: string }>(
      s.db.urls.admin,
      "select id from knowledge.claims where type = 'commitment' and compartments = '{employer:example}' order by id limit 1",
    );
    if (work === undefined) throw new Error("the world has a work commitment");
    const before = {
      self: await selfOf(s, s.own),
      facts: await findFacts(s.db, s.own),
      commitments: await commitments(s, s.own, "any"),
    };
    expect(before.commitments.length).toBeGreaterThan(0);
    // The audience that sees the work claim holds it in a belief before the rulings.
    expect(await supporting(s, work.id)).toBe(1);

    for (const verdict of ["reject", "veto"]) expect((await pi(["correct", verdict, work.id], s.admin)).exit).toBe(0);
    await extract(s);
    expect({
      self: await selfOf(s, s.own),
      facts: await findFacts(s.db, s.own),
      commitments: await commitments(s, s.own, "any"),
    }).toEqual(before);
    // The control: the audience that sees the work claim lost it from every belief.
    expect(await supporting(s, work.id)).toBe(0);
  });
});
