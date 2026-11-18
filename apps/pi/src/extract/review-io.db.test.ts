import { PassThrough, Writable } from "node:stream";
import { ReviewExport, type ReviewImport } from "@intelligence/contracts/personal";
import { EXTRACT_GENERATION } from "@intelligence/personal-extract";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import { createPipeline, loadKeys } from "@intelligence/personal-store";
import { queryAs } from "@intelligence/personal-store/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../commands.ts";
import { addClient, builtOnce, events, pi, quiet, type Synced, statuses } from "../test-support/extract-fixtures.ts";
import { openSample, sealSample } from "./extract-owner.ts";

// `pi extract review-export` and `pi extract review-import`, in process on the synthetic world with
// the fake model: the export samples as the terminal review does and shows what it shows; the
// import stores what the terminal review stores, or refuses with a fixed code and writes nothing.

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const made: Synced[] = [];
afterEach(async () => {
  for (const one of made.splice(0)) await one.drop();
});

// The world synced and extracted once for the file, with a client; each test gets a copy.
const extractedOnce = builtOnce(async (s) => {
  await addClient(s.db, "own-client", ["own"]);
  expect((await pi(["extract"], s.pipeline, { deps: { model: fakeModelClient(s.outputs) } })).exit).toBe(0);
});
async function extracted(): Promise<Synced> {
  const { s } = await extractedOnce();
  made.push(s);
  return s;
}

const exported = async (s: Synced, argv: string[] = []): Promise<ReviewExport> => {
  // Terminal only: the export is drawn as a terminal would draw it.
  const result = await pi(["extract", "review-export", ...argv], s.admin, { tty: true });
  expect(result.exit, result.stderr).toBe(0);
  return ReviewExport.parse(JSON.parse(result.stdout));
};

const imported = (s: Synced, document: unknown) =>
  pi(["extract", "review-import"], s.admin, { stdin: [JSON.stringify(document)] });

const reviews = (s: Synced) =>
  queryAs(
    s.db.urls.admin,
    "select id, evidence_id, claim_id, extractor_generation from vault.extraction_reviews order by id",
  );

// Every claim right, and the first item missed something.
const answers = (sample: ReviewExport): ReviewImport => ({
  sample_id: sample.sample_id,
  verdicts: sample.items.map((item, n) => ({
    item_id: item.item_id,
    claims: item.claims.map((claim) => ({ claim_id: claim.claim_id, verdict: "right" as const })),
    missed: n === 0,
  })),
});

// The terminal review's output, answering right to every claim and nothing to every item.
async function terminal(s: Synced, argv: string[]): Promise<string> {
  const stdin = new PassThrough();
  let stdout = "";
  const out = new Writable({
    write(chunk: Buffer, _encoding, done) {
      const text = chunk.toString("utf8");
      stdout += text;
      if (text.endsWith(": ") && /\((right|missed)/.test(text)) stdin.write(text.includes("missed") ? "\n" : "right\n");
      done();
    },
  });
  const err = new Writable({ write: (_chunk, _encoding, done) => done() });
  expect(
    await run(["extract", "review", ...argv], s.admin, { stdout: out, stderr: err, stdin, stdoutIsTTY: true }),
  ).toBe(0);
  stdin.end();
  return stdout;
}

describe("pi extract review-export", () => {
  it("prints the terminal review's items, as one document, to a terminal, and stores nothing", async () => {
    const s = await extracted();
    // Not to a pipe or a file: refused, with nothing on stdout, though the
    // store holds items to sample.
    const piped = await pi(["extract", "review-export", "--sample", "500"], s.admin);
    expect({ exit: piped.exit, stdout: piped.stdout }).toEqual({ exit: 1, stdout: "" });
    expect(piped.stderr).toContain(JSON.stringify({ event: "command_failed", code: "not_a_terminal" }));
    const sample = await exported(s, ["--sample", "500"]);
    expect(sample.generation).toBe(EXTRACT_GENERATION);
    expect(sample.type).toBeNull();
    expect(sample.items.length).toBeGreaterThan(0);
    expect(await reviews(s)).toEqual([]);
    // The positive control: items with claims and items with none.
    expect(sample.items.some((item) => item.claims.length > 0)).toBe(true);
    expect(sample.items.some((item) => item.claims.length === 0)).toBe(true);
    // The sample id holds the sample's items and their claims.
    const keys = await loadKeys(s.admin.PI_KEY_FILE ?? "");
    expect(openSample(keys, sample.sample_id)).toEqual({
      generation: EXTRACT_GENERATION,
      type: null,
      items: sample.items.map((item) => [item.item_id, item.claims.map((claim) => claim.claim_id)]),
    });

    // The same largest sample through the terminal shows the same items and claims, line for line.
    const shown = await terminal(s, ["--sample", "500"]);
    // An item's first line follows the last question on its line, as a terminal shows it.
    expect((shown.match(/item \d+ of \d+: /g) ?? []).length).toBe(sample.items.length);
    for (const item of sample.items) {
      for (const line of [
        `subject: ${item.subject ?? ""}`,
        `sender: ${item.sender ?? ""}`,
        `lane: ${item.lane}`,
        `text:\n${item.text ?? ""}`,
      ])
        expect(shown).toContain(line);
      expect(shown).toContain(`: ${item.date}\n`);
      for (const claim of item.claims) {
        expect(shown).toContain(`${claim.type} ${JSON.stringify(claim.fields)}\n`);
        expect(shown).toContain(`  passage: ${claim.passage}\n`);
      }
    }
  });

  it("with a type, samples only items that hold a claim of it, as the terminal review does", async () => {
    const s = await extracted();
    const sample = await exported(s, ["--type", "plan", "--sample", "50"]);
    expect(sample.type).toBe("plan");
    const [plans] = await queryAs<{ n: number }>(
      s.db.urls.admin,
      "select count(distinct evidence_id)::int as n from knowledge.claims where type = 'plan'",
    );
    expect(plans?.n).toBeGreaterThan(0);
    expect(sample.items).toHaveLength(plans?.n ?? -1);
    for (const item of sample.items) expect(item.claims.some((claim) => claim.type === "plan")).toBe(true);
  });
});

describe("pi extract review-import", () => {
  it("stores what the terminal review stores, prints its counts, and the items are not sampled again", async () => {
    const s = await extracted();
    const sample = await exported(s, ["--sample", "3"]);
    expect(sample.items).toHaveLength(3);
    const claims = sample.items.reduce((sum, item) => sum + item.claims.length, 0);
    const nothing = sample.items.filter((item, n) => n > 0 && item.claims.length === 0).length;
    const result = await imported(s, answers(sample));
    expect(result, result.stderr).toEqual({
      exit: 0,
      stdout: `${JSON.stringify({ reviewed: 3, stored: claims + 1 + nothing })}\n`,
      stderr: "",
    });
    const [stored] = await queryAs<{ n: number }>(
      s.db.urls.admin,
      "select count(distinct evidence_id)::int as n from vault.extraction_reviews",
    );
    expect(stored?.n).toBe(3);
    const status = JSON.parse((await pi(["extract", "status"], s.admin)).stdout) as {
      reviews: { verdict: string; generation: number; count: number }[];
    };
    const count = (verdict: string) =>
      status.reviews.filter((one) => one.verdict === verdict).reduce((sum, one) => sum + one.count, 0);
    expect({ right: count("right"), missed: count("missed"), nothing: count("nothing") }).toEqual({
      right: claims,
      missed: 1,
      nothing,
    });
    expect(status.reviews.every((one) => one.generation === EXTRACT_GENERATION)).toBe(true);
    const again = await exported(s, ["--sample", "500"]);
    for (const item of sample.items) expect(again.items.map((one) => one.item_id)).not.toContain(item.item_id);
  });

  it("refuses an unknown id, a duplicate, a stale sample or a part-judged item with a fixed code, and writes nothing", async () => {
    const s = await extracted();
    const sample = await exported(s, ["--sample", "500"]);
    const withClaims = sample.items.find((item) => item.claims.length > 0);
    if (withClaims === undefined) throw new Error("no item with a claim");
    const good = answers({ ...sample, items: [withClaims] });
    const [verdict] = good.verdicts;
    if (verdict === undefined) throw new Error("no verdict");
    const keys = await loadKeys(s.admin.PI_KEY_FILE ?? "");
    const opened = openSample(keys, sample.sample_id);
    const outside = "f".repeat(64);
    const cases: [string, unknown][] = [
      ["review_invalid", "not json"],
      [
        "review_invalid",
        {
          ...good,
          verdicts: [{ ...verdict, claims: [{ claim_id: verdict.claims[0]?.claim_id, verdict: "nothing" }] }],
        },
      ],
      ["review_unknown_id", { ...good, sample_id: `${sample.sample_id}x` }],
      ["review_unknown_id", { ...good, verdicts: [{ ...verdict, item_id: outside }] }],
      [
        "review_unknown_id",
        {
          ...good,
          verdicts: [{ ...verdict, claims: [...verdict.claims, { claim_id: "clm_unknown", verdict: "right" }] }],
        },
      ],
      ["review_duplicate", { ...good, verdicts: [verdict, verdict] }],
      ["review_incomplete", { ...good, verdicts: [{ ...verdict, claims: verdict.claims.slice(1) }] }],
      ["review_stale", { ...good, sample_id: sealSample(keys, { ...opened, generation: 0 }) }],
    ];
    for (const [code, document] of cases) {
      const result = await pi(["extract", "review-import"], s.admin, {
        stdin: [typeof document === "string" ? document : JSON.stringify(document)],
      });
      expect({ exit: result.exit, stdout: result.stdout }, code).toEqual({ exit: 1, stdout: "" });
      expect(events(result.stderr).at(-1), code).toEqual({ event: "command_failed", code });
    }
    expect(await reviews(s)).toEqual([]);

    // During an extract run the check and the write wait for no run: the import is refused.
    const pipeline = createPipeline({ url: s.db.urls.pipeline, keys: s.db.keys, log: quiet });
    try {
      const during = await pipeline.withExtractLock(() => imported(s, good));
      expect(during === "already_running" ? null : events(during.stderr).at(-1)).toEqual({
        event: "command_failed",
        code: "extract_running",
      });
    } finally {
      await pipeline.close();
    }
    expect(await reviews(s)).toEqual([]);

    // The positive control: the good document is stored once, and a second import is a duplicate.
    expect((await imported(s, good)).exit).toBe(0);
    const once = await reviews(s);
    expect(once.length).toBeGreaterThan(0);
    const twice = await imported(s, good);
    expect(events(twice.stderr).at(-1)).toEqual({ event: "command_failed", code: "review_duplicate" });
    expect(await reviews(s)).toEqual(once);
  });

  it("an item no longer done since the export is stale, and nothing of the document is stored", async () => {
    const s = await extracted();
    const sample = await exported(s, ["--sample", "500"]);
    const [first, second] = sample.items;
    if (first === undefined || second === undefined) throw new Error("a sample of two");
    // The second item is sent to the skip lane and run again, so it is no longer done.
    const [message] = await queryAs<{ id: string }>(
      s.db.urls.admin,
      "select id from knowledge.messages where evidence_id = $1",
      [second.item_id],
    );
    expect((await pi(["extract", "retry", "--message", message?.id ?? "", "--lane", "skip"], s.admin)).exit).toBe(0);
    expect((await pi(["extract"], s.pipeline, { deps: { model: fakeModelClient(s.outputs) } })).exit).toBe(0);
    expect((await statuses(s.db)).get(second.item_id)?.status).toBe("skipped");
    const result = await imported(s, answers({ ...sample, items: [first, second] }));
    expect(events(result.stderr).at(-1)).toEqual({ event: "command_failed", code: "review_stale" });
    expect(await reviews(s)).toEqual([]);
  });
});
