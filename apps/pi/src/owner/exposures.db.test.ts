import type { ModelRequest } from "@intelligence/contracts";
import { ErasureReport, ExposureListView, ExposureStatusView, type MessageId } from "@intelligence/contracts/personal";
import type { ExtractDeps } from "@intelligence/personal-extract";
import { fakeDecideClient, fakeModelClient } from "@intelligence/personal-models/testing";
import { createReader } from "@intelligence/personal-store";
import { queryAs } from "@intelligence/personal-store/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  builtOnce,
  events,
  MODEL_ID,
  pi,
  quiet,
  type Synced,
  syncedWorld,
  withAdmin,
} from "../test-support/extract-fixtures.ts";

// The exposure record's commands, and the gate tests X8 and X12: `pi extract` notes each item's exposure before its request
// leaves, the extract model's and the decide model's; an erasure lists every model and retaining client its item was given,
// and nothing else; `pi erase exposures` and `pi exposures status` print ids, days and counts, and a client's name only on a
// terminal. In-process on the synthetic world, with the fake clients. No test calls OpenRouter.

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const DECIDE_MODEL = "typesafe/jev-1.13";
const NEUTRAL = { human_written: 0.9, special_category: 0.01, quarantine: 0.01 };

const made: Synced[] = [];
afterEach(async () => {
  for (const one of made.splice(0)) await one.drop();
});
const world = async (): Promise<Synced> => {
  const s = await syncedWorld();
  made.push(s);
  return s;
};

// The exposure rows of one recipient, route and evidence id, committed and seen from another
// connection as the admin.
const noted = async (s: Synced, recipient: string, route: string, evidenceId: string): Promise<number> =>
  (
    await queryAs<{ n: number }>(
      s.db.urls.admin,
      "select count(*)::int as n from ledger.exposures where recipient = $1 and route = $2 and ref = $3",
      [recipient, route, evidenceId],
    )
  )[0]?.n ?? 0;

type ModelClient = ExtractDeps["model"];

// A client that, before it answers, asks the database whether the request's exposure row is
// committed, and keeps each answer.
function checking(s: Synced, recipient: string, inner: ModelClient, seen: boolean[]): ModelClient {
  return {
    async complete(request: ModelRequest) {
      const evidenceId = request.callKey?.evidenceId;
      // The relation step's keyed replay sends no call key: its pair's two items are noted under
      // its prompt before it asks, so at least one row for the prompt is committed.
      if (evidenceId === undefined)
        seen.push(
          ((
            await queryAs<{ n: number }>(
              s.db.urls.admin,
              "select count(*)::int as n from ledger.exposures where recipient = $1 and prompt_id = $2",
              [recipient, request.promptId],
            )
          )[0]?.n ?? 0) > 0,
        );
      else seen.push((await noted(s, recipient, request.promptId, evidenceId)) === 1);
      return inner.complete(request);
    },
    embed: (request) => inner.embed(request),
  };
}

// Every stored message answers the decide model neutrally: its first screen, and its recovery and record
// screens, which hold nothing under their lines.
const neutralFor = async (s: Synced): Promise<Record<string, unknown>> => ({
  ...Object.fromEntries(
    (await queryAs<{ id: string }>(s.db.urls.admin, "select evidence_id as id from knowledge.messages")).map((row) => [
      row.id,
      NEUTRAL,
    ]),
  ),
  jev_recovery: { account_recovery: 0.01 },
  jev_record: { quarantine: 0.01 },
});

// The world extracted with the decide model answering neutrally: built once for the file, and each test that
// starts from it gets a copy (builtOnce).
const extractedOnce = builtOnce(async (s) => {
  expect(
    (
      await pi(
        ["extract"],
        { ...s.pipeline, PI_DECIDE_MODEL: DECIDE_MODEL },
        { deps: { model: fakeModelClient(s.outputs), decideModel: fakeDecideClient(await neutralFor(s)) } },
      )
    ).exit,
  ).toBe(0);
});
const extracted = async (): Promise<Synced> => {
  const { s } = await extractedOnce();
  made.push(s);
  return s;
};

// A client registered with read_message and a recorded vendor retention, and its token.
const reader = (s: Synced, name: string, vendorRetention: "none" | "retains"): Promise<string> =>
  withAdmin(
    s.db,
    async (admin) =>
      (
        await admin.clients.addClient({
          name,
          runtime: "local",
          vendorRetention,
          compartments: ["own"],
          views: ["self", "people"],
          tools: ["get_self", "read_message"],
        })
      ).token,
  );

async function readMessage(s: Synced, token: string, id: MessageId): Promise<void> {
  const store = createReader({ url: s.db.urls.reader, keys: s.db.keys, log: quiet });
  try {
    expect((await store.readMessage(token, { id })).ok).toBe(true);
  } finally {
    await store.close();
  }
}

// One message the extract model was asked about, by its message id and evidence id.
async function exposedMessage(s: Synced): Promise<{ id: MessageId; evidence: string }> {
  const [row] = await queryAs<{ id: string; evidence_id: string }>(
    s.db.urls.admin,
    `select m.id, m.evidence_id from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id
     where e.compartments = '{own}' and exists (select 1 from ledger.exposures x where x.recipient = $1 and x.ref = m.evidence_id)
       and exists (select 1 from ledger.exposures x where x.recipient = $2 and x.ref = m.evidence_id)
     order by m.id limit 1`,
    [MODEL_ID, DECIDE_MODEL],
  );
  if (row === undefined) throw new Error("no message was sent to both models");
  return { id: row.id as MessageId, evidence: row.evidence_id };
}

describe("the vendor exposure record, end to end", () => {
  it("X12: no model request leaves without its exposure row committed first, Luna's and Jev's", async () => {
    const s = await world();
    const extractModel: boolean[] = [];
    const decideModel: boolean[] = [];
    const result = await pi(
      ["extract"],
      { ...s.pipeline, PI_DECIDE_MODEL: DECIDE_MODEL },
      {
        deps: {
          model: checking(s, MODEL_ID, fakeModelClient(s.outputs), extractModel),
          decideModel: checking(s, DECIDE_MODEL, fakeDecideClient(await neutralFor(s)), decideModel),
        },
      },
    );
    expect(result.exit).toBe(0);
    expect(extractModel.length).toBeGreaterThan(0);
    expect(decideModel.length).toBeGreaterThan(0);
    expect([...extractModel, ...decideModel].every(Boolean)).toBe(true);
    // A second run replays or finds nothing due: it notes nothing new and sends nothing.
    const before = (await queryAs<{ n: number }>(s.db.urls.admin, "select count(*)::int as n from ledger.exposures"))[0]
      ?.n;
    const again = await pi(
      ["extract"],
      { ...s.pipeline, PI_DECIDE_MODEL: DECIDE_MODEL },
      { deps: { model: fakeModelClient(s.outputs), decideModel: fakeDecideClient(await neutralFor(s)) } },
    );
    expect(again.exit).toBe(0);
    expect(
      (await queryAs<{ n: number }>(s.db.urls.admin, "select count(*)::int as n from ledger.exposures"))[0]?.n,
    ).toBe(before);
  });

  it("X8: an erased item's report lists every model and retaining client it was given, and nothing else", async () => {
    const s = await extracted();
    const message = await exposedMessage(s);
    const retaining = await reader(s, "retaining-reader", "retains");
    const forgetful = await reader(s, "forgetful-reader", "none");
    await readMessage(s, retaining, message.id);
    await readMessage(s, forgetful, message.id);
    const clients = await withAdmin(s.db, (admin) => admin.clients.listClients());
    const retainingId = clients.find((one) => one.name === "retaining-reader")?.id;

    const erased = await pi(["erase", "item", message.id], s.admin);
    expect(erased.exit).toBe(0);
    const report = ErasureReport.parse(JSON.parse(erased.stdout));
    expect(report.more.vendor_exposures).toBe(3);

    const listed = await pi(["erase", "exposures", report.erasure ?? ""], s.admin);
    expect(listed).toMatchObject({ exit: 0, stderr: "" });
    const view = ExposureListView.parse(JSON.parse(listed.stdout));
    // One row per recipient and route: the decide model was given the item twice, by its recovery screen
    // and by its first screen.
    expect(view.recipients).toHaveLength(4);
    expect(view.recipients.map((one) => [one.id, one.kind, one.route, one.ids])).toEqual(
      expect.arrayContaining([
        [retainingId ?? "", "client", "read_message", 1],
        [DECIDE_MODEL, "model", "jev_recovery", 1],
        [DECIDE_MODEL, "model", "jev_screen", 1],
        [MODEL_ID, "model", expect.stringMatching(/^personal_/), 1],
      ]),
    );
  });

  it("the listing prints ids, days and counts, and names only on a terminal", async () => {
    const s = await extracted();
    const message = await exposedMessage(s);
    await readMessage(s, await reader(s, "retaining-reader", "retains"), message.id);
    const report = ErasureReport.parse(JSON.parse((await pi(["erase", "item", message.id], s.admin)).stdout));

    const plain = await pi(["erase", "exposures", report.erasure ?? ""], s.admin);
    expect(plain.stdout).not.toContain("retaining-reader");
    expect(ExposureListView.safeParse(JSON.parse(plain.stdout)).success).toBe(true);
    const shown = await pi(["erase", "exposures", report.erasure ?? ""], s.admin, { tty: true });
    expect(shown.exit).toBe(0);
    expect(shown.stdout).toContain("retaining-reader");

    const status = await pi(["exposures", "status"], s.admin);
    expect(status.exit).toBe(0);
    const counted = ExposureStatusView.parse(JSON.parse(status.stdout));
    expect(counted.recipients.map((one) => one.id)).toEqual(expect.arrayContaining([MODEL_ID, DECIDE_MODEL]));
    expect(status.stdout).not.toContain("retaining-reader");
    expect((await pi(["exposures", "status"], s.admin, { tty: true })).stdout).toContain("retaining-reader");
  });

  it("an unknown erasure is not_found", async () => {
    const s = await world();
    const result = await pi(["erase", "exposures", `ers_${"0".repeat(26)}`], s.admin);
    expect(result.exit).toBe(1);
    expect(events(result.stderr).some((event) => event.code === "not_found")).toBe(true);
    expect(result.stdout).toBe("");
  });
});
