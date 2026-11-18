import { fakeDecideClient, fakeModelClient } from "@intelligence/personal-models/testing";
import { queryAs } from "@intelligence/personal-store/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtOnce, pi, type Synced } from "../test-support/extract-fixtures.ts";

// `pi ladder review`, `calibrate` and `pi thresholds` on the synthetic world. The decide model's answers are
// fakeDecideClient's, each a distinct canary number, so a probability printed anywhere would be found in the
// bytes.

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const DECIDE_MODEL = "typesafe/jev-1.13";
const made: Synced[] = [];
afterEach(async () => {
  for (const one of made.splice(0)) await one.drop();
});

// A distinct canary probability for each item: 0.1234567, 0.1234568, ... none a number a report
// or a slot could hold by chance.
const canary = (n: number): number => Number((0.1234567 + n / 1e7).toFixed(7));

// The world synced and extracted with the decide model once for the file; each test gets a copy (builtOnce).
const extractedOnce = builtOnce(async (s) => {
  const messages = await queryAs<{ id: string }>(
    s.db.urls.admin,
    "select evidence_id as id from knowledge.messages order by evidence_id",
  );
  const canaries: string[] = [];
  const answers: Record<string, unknown> = {};
  messages.forEach((row, n) => {
    const p = canary(n);
    canaries.push(String(p));
    answers[row.id] = { human_written: 0.9, special_category: 0.01, quarantine: 0.01 };
    answers[`jev_recovery:${row.id}`] = { account_recovery: p };
  });
  // Under the recovery line, so nothing is held and every item keeps its saved call.
  expect(canaries.every((one) => Number(one) < 0.7)).toBe(true);
  const result = await pi(
    ["extract"],
    { ...s.pipeline, PI_DECIDE_MODEL: DECIDE_MODEL },
    { deps: { model: fakeModelClient(s.outputs), decideModel: fakeDecideClient(answers) } },
  );
  expect(result.exit).toBe(0);
  return canaries;
});

async function extractedWithDecideModel(): Promise<{ s: Synced; canaries: string[] }> {
  const { s, made: canaries } = await extractedOnce();
  made.push(s);
  return { s, canaries };
}

const verdicts = (s: Synced) =>
  queryAs<{ n: number }>(s.db.urls.admin, "select count(*)::int as n from ledger.point_verdicts");

describe("pi ladder review", () => {
  it("prints nothing to a pipe", async () => {
    const { s } = await extractedWithDecideModel();
    const result = await pi(["ladder", "review", "--point", "extract_recovery"], s.admin);
    expect(result.exit).toBe(1);
    expect(result.stdout).toBe("");
    expect((await verdicts(s))[0]?.n).toBe(0);
  });

  it("the bytes it writes hold no probability for any item, and the question word for word", async () => {
    const { s, canaries } = await extractedWithDecideModel();
    const result = await pi(["ladder", "review", "--point", "extract_recovery", "--sample", "12"], s.admin, {
      tty: true,
      stdin: Array.from({ length: 12 }, () => "y\n"),
    });
    expect(result.exit).toBe(0);
    for (const p of canaries) expect(result.stdout, p).not.toContain(p.slice(2));
    expect(result.stdout).toContain("question: Does this message carry a way into an account");
    expect(result.stdout).not.toMatch(/held|hold_message|probability/i);
    // Each answer was given at once, so each is stored hurried and none counts.
    const rows = await queryAs<{ deliberate: boolean; hurried: boolean; source: string }>(
      s.db.urls.admin,
      "select deliberate, hurried, source from ledger.point_verdicts",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.source === "review")).toBe(true);
  });

  it("a skip stores nothing", async () => {
    const { s } = await extractedWithDecideModel();
    const result = await pi(["ladder", "review", "--point", "extract_recovery", "--sample", "5"], s.admin, {
      tty: true,
      stdin: Array.from({ length: 5 }, () => "s\n"),
    });
    expect(result.exit).toBe(0);
    expect((await verdicts(s))[0]?.n).toBe(0);
  });

  const callViews = (s: Synced) =>
    queryAs<{ target_kind: string; target_id: string; surface: string; shown_at: Date; compartments: string[] }>(
      s.db.urls.admin,
      "select target_kind, target_id, surface, shown_at, compartments from ledger.owner_views order by id",
    );

  it("each item shown writes one view of kind call, under its call's label", async () => {
    const { s } = await extractedWithDecideModel();
    const result = await pi(["ladder", "review", "--point", "extract_recovery", "--sample", "3"], s.admin, {
      tty: true,
      stdin: Array.from({ length: 3 }, () => "y\n"),
    });
    expect(result.exit).toBe(0);
    // Shown is asked: an item skipped unasked (its input changed) is never shown.
    const asked = result.stdout.split("y, n or s: ").length - 1;
    expect(asked).toBeGreaterThan(0);
    const views = await callViews(s);
    expect(views).toHaveLength(asked);
    for (const view of views) {
      expect(view).toMatchObject({ target_kind: "call", surface: "cli" });
      const [call] = await queryAs<{ compartments: string[] }>(
        s.db.urls.admin,
        "select compartments from vault.model_calls where id = $1",
        [view.target_id],
      );
      expect(view.compartments).toEqual(call?.compartments);
    }
  });

  it("a verdict's review time runs from its call's view", async () => {
    const { s } = await extractedWithDecideModel();
    expect(
      (
        await pi(["ladder", "review", "--point", "extract_recovery", "--sample", "2"], s.admin, {
          tty: true,
          stdin: ["y\n", "n\n"],
        })
      ).exit,
    ).toBe(0);
    const rows = await queryAs<{ shown_at: Date; decided_at: Date }>(
      s.db.urls.admin,
      `select w.shown_at, v.created_at as decided_at from ledger.point_verdicts v join ledger.owner_views w on w.target_kind = 'call' and w.target_id = v.call_id`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.shown_at.getTime()).toBeLessThanOrEqual(row.decided_at.getTime());
  });

  it("a skip writes the view and no verdict", async () => {
    const { s } = await extractedWithDecideModel();
    const result = await pi(["ladder", "review", "--point", "extract_recovery", "--sample", "3"], s.admin, {
      tty: true,
      stdin: Array.from({ length: 3 }, () => "s\n"),
    });
    expect(result.exit).toBe(0);
    const asked = result.stdout.split("y, n or s: ").length - 1;
    expect(asked).toBeGreaterThan(0);
    expect((await verdicts(s))[0]?.n).toBe(0);
    expect((await callViews(s)).map((view) => view.target_kind)).toEqual(Array.from({ length: asked }, () => "call"));
  });
});

describe("pi thresholds", () => {
  it("set within the bounds is a grant of source set, list says so, and revoke returns the default", async () => {
    const { s } = await extractedWithDecideModel();
    const set = await pi(["thresholds", "set", "extract_recovery", "--name", "hold", "--value", "0.6"], s.admin);
    expect(set.exit).toBe(0);
    const { threshold } = JSON.parse(set.stdout) as { threshold: string };
    const listed = JSON.parse((await pi(["thresholds", "list"], s.admin)).stdout) as {
      thresholds: { point: string; name: string; value: number; source: string }[];
    };
    expect(listed.thresholds.find((row) => row.point === "extract_recovery")).toMatchObject({
      value: 0.6,
      source: "set",
    });
    expect((await pi(["thresholds", "revoke", threshold], s.admin)).exit).toBe(0);
    const after = JSON.parse((await pi(["thresholds", "list"], s.admin)).stdout) as {
      thresholds: { point: string; value: number; source: string }[];
    };
    expect(after.thresholds.find((row) => row.point === "extract_recovery")).toMatchObject({
      value: 0.7,
      source: "default",
    });
  });

  it("a value outside the floor and ceiling is refused out_of_bounds", async () => {
    const { s } = await extractedWithDecideModel();
    const result = await pi(["thresholds", "set", "extract_recovery", "--name", "hold", "--value", "0.2"], s.admin);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("out_of_bounds");
  });

  it("a grant applies to the next run, and each run records its thresholds and their sources", async () => {
    const { s } = await extractedWithDecideModel();
    const set = JSON.parse(
      (await pi(["thresholds", "set", "extract_recovery", "--name", "hold", "--value", "0.6"], s.admin)).stdout,
    ) as { threshold: string };
    expect(
      (
        await pi(
          ["extract"],
          { ...s.pipeline, PI_DECIDE_MODEL: DECIDE_MODEL },
          {
            deps: {
              model: fakeModelClient(s.outputs),
              decideModel: fakeDecideClient({ jev_recovery: { account_recovery: 0.01 } }),
            },
          },
        )
      ).exit,
    ).toBe(0);
    const [run] = await queryAs<{ thresholds: { point: string; name: string; value: number; source: string }[] }>(
      s.db.urls.admin,
      "select thresholds from vault.extraction_runs order by seq desc limit 1",
    );
    expect(run?.thresholds).toContainEqual({
      point: "extract_recovery@1",
      name: "hold",
      value: 0.6,
      source: set.threshold,
    });
    expect(run?.thresholds).toContainEqual({
      point: "extract_injection@2",
      name: "hold",
      value: 0.7,
      source: "default",
    });
  });
});

describe("pi ladder calibrate", () => {
  it("prints counts and shares only, and with too few verdicts says insufficient and proposes nothing", async () => {
    const { s, canaries } = await extractedWithDecideModel();
    await pi(["ladder", "review", "--point", "extract_recovery", "--sample", "6"], s.admin, {
      tty: true,
      stdin: Array.from({ length: 6 }, () => "n\n"),
    });
    const result = await pi(["ladder", "calibrate"], s.admin);
    expect(result.exit).toBe(0);
    for (const p of canaries) expect(result.stdout, p).not.toContain(p.slice(2));
    const [line] = result.stdout
      .trim()
      .split("\n")
      .map((one) => JSON.parse(one) as Record<string, unknown>);
    expect(line).toMatchObject({ point: "extract_recovery", version: 1, insufficient: true });
    expect(line?.proposal).toBe("insufficient");
  });
});
